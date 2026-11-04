import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Build, BuildService, Project, WorkspaceEvent } from '../shared/types.ts';
import { createBuildService,currentBuildSource } from '../server/builds.ts';
import { fingerprint, runCompiler, sourceFiles } from '../server/compile-utils.ts';
import { parseDiagnostics } from '../server/diagnostics.ts';

const execute = promisify(execFile);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function settled(service: BuildService, id: string, timeout = 6000): Promise<Build> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const build = await service.get(id);
    if (['succeeded', 'failed', 'cancelled'].includes(build.status)) return build;
    await pause(15);
  }
  throw new Error('Build did not settle');
}
async function running(service: BuildService, id: string): Promise<void> {
  for (let count = 0; count < 200; count++) {
    const build = await service.get(id);
    if (build.status === 'running' && build.log.includes('engine-started')) return;
    await pause(10);
  }
  throw new Error('Compiler did not start');
}
async function fixture(content = '\\documentclass{article}\n\\begin{document}Hello\\end{document}', timeoutMs = 5000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-build-tests-'));
  const directory = path.join(root, 'papers', 'test');
  await fs.mkdir(path.join(directory, 'manuscript'), { recursive: true });
  const now = new Date().toISOString();
  const project: Project = { schemaVersion: 1, id: 'test', title: 'Compiler test', stage: 'writing', venue: '', deadline: '', autoCompile: false, createdAt: now, updatedAt: now, targets: [{ id: 'main', label: 'Main', main: 'manuscript/main.tex' }] };
  await fs.writeFile(path.join(directory, 'project.json'), JSON.stringify(project));
  const main = path.join(directory, 'manuscript', 'main.tex');
  await fs.writeFile(main, content);
  const compiler = path.join(root, 'fake-tectonic');
  await fs.writeFile(compiler, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Fake Tectonic 1.0'); process.exit(0); }
const main = args.at(-1);
const content = fs.readFileSync(main, 'utf8');
const output = args[args.indexOf('--outdir') + 1];
console.log('engine-started');
if (content.includes('WAIT')) { setInterval(() => {}, 1000); }
else if (content.includes('NETWORK')) { console.error('failed to download bundle: HTTP 503 network unavailable'); process.exit(1); }
else if (content.includes('BROKEN')) { console.error('error: main.tex:1: Undefined control sequence'); process.exit(1); }
else { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, main.replace(/\\.tex$/, '.pdf')), '%PDF-1.4\\nmock compilation output'); if (content.includes('REFERENCE')) console.log('warning: main.tex:2: LaTeX Warning: Reference missing undefined'); console.log('compiled-successfully'); }
`, { mode: 0o755 });
  const events: WorkspaceEvent[] = [];
  const create = () => createBuildService({ workspaceRoot: root, compilerPath: compiler, timeoutMs, emit: event => events.push(event) });
  const service = create();
  return { root, directory, main, compiler, events, create, service, async cleanup() { await service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('frozen compilation preserves original source and reports stale last successful PDF', async () => {
  const f = await fixture('Hello REFERENCE\n\\resultplaceholder{real result}\n% \\resultplaceholder{ignored}\n\\newcommand{\\missingresult}{---}');
  try {
    const before = await fs.readFile(f.main, 'utf8');
    await fs.writeFile(path.join(f.directory, 'manuscript', 'unused.tex'), '\\resultplaceholder{inactive}');
    const request = await f.service.request('test', 'main');
    const build = await settled(f.service, request.id);
    assert.equal(build.status, 'succeeded');
    assert.equal(build.stale, false);
    assert.equal(await fs.readFile(f.main, 'utf8'), before);
    assert.equal(build.diagnostics.filter(d => d.category === 'placeholder').length, 1);
    assert.ok(build.diagnostics.some(d => d.category === 'reference' && d.file === 'manuscript/main.tex' && d.line === 2));
    assert.equal(build.sourceHash, fingerprint(await sourceFiles(path.join(f.directory, 'manuscript'), 'main.tex')));
    assert.match(await fs.readFile(await f.service.artifact(build.id, build.pdf!), 'utf8'), /^%PDF-/);
    assert.match(await fs.readFile(await f.service.artifact(build.id, 'compile.log'), 'utf8'), /compiled-successfully/);
    await fs.writeFile(f.main, `${before}\nExternal edit`);
    assert.equal((await f.service.get(build.id)).stale, true);
    assert.equal((await f.service.list('test'))[0].status, 'succeeded');
    await assert.rejects(f.service.artifact(build.id, '../project.json'), /路径不合法/);
    await assert.rejects(f.service.request('../outside', 'main'), /不合法/);
  } finally { await f.cleanup(); }
});

test('global queue coalesces pending saves and cancellation allows newest source build', async () => {
  const f = await fixture('WAIT');
  try {
    const first = await f.service.request('test', 'main');
    await running(f.service, first.id);
    const queued = await f.service.request('test', 'main');
    await fs.writeFile(f.main, 'Latest valid source');
    const merged = await f.service.request('test', 'main');
    assert.equal(merged.id, queued.id);
    assert.equal((await f.service.cancel(first.id)).status, 'cancelled');
    const newest = await settled(f.service, queued.id);
    assert.equal(newest.status, 'succeeded');
    assert.equal(await fs.readFile(path.join(f.directory, 'build', newest.id, 'source', 'main.tex'), 'utf8'), 'Latest valid source');
    assert.equal((await f.service.get(first.id)).pdf, undefined);
  } finally { await f.cleanup(); }
});

test('timeout stops compiler and exposes failure without a fresh PDF', async () => {
  const f = await fixture('WAIT', 150);
  try {
    const build = await settled(f.service, (await f.service.request('test', 'main')).id);
    assert.equal(build.status, 'failed');
    assert.match(build.reason!, /超时/);
    assert.equal(build.pdf, undefined);
  } finally { await f.cleanup(); }
});

test('syntax and dependency download errors are actionable, previous successful build remains', async () => {
  const f = await fixture();
  try {
    const success = await settled(f.service, (await f.service.request('test', 'main')).id);
    await fs.writeFile(f.main, 'BROKEN');
    const syntax = await settled(f.service, (await f.service.request('test', 'main')).id);
    assert.equal(syntax.status, 'failed');
    assert.ok(syntax.diagnostics.some(d => d.severity === 'error' && d.file === 'manuscript/main.tex' && d.line === 1));
    await fs.writeFile(f.main, 'NETWORK');
    const network = await settled(f.service, (await f.service.request('test', 'main')).id);
    assert.equal(network.status, 'failed');
    assert.match(network.reason!, /下载|网络/);
    assert.equal((await f.service.get(success.id)).status, 'succeeded');
    assert.ok(await fs.stat(await f.service.artifact(success.id, 'main.pdf')));
    await fs.rm(f.main);
    const missing = await settled(f.service, (await f.service.request('test', 'main')).id);
    assert.equal(missing.status, 'failed');
  } finally { await f.cleanup(); }
});

test('source symlinks cannot import files outside the source tree', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'private.txt'), 'secret');
    await fs.symlink(path.join(f.root, 'private.txt'), path.join(f.directory, 'manuscript', 'escape.txt'));
    const result = await settled(f.service, (await f.service.request('test', 'main')).id);
    assert.equal(result.status, 'failed');
    assert.match(result.reason!, /链接越界/);
  } finally { await f.cleanup(); }
});

test('submission ZIP is independently extracted and compiled and excludes private project materials', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.directory, 'notes'));
    await fs.writeFile(path.join(f.directory, 'notes', 'private.md'), 'Private notes');
    await fs.mkdir(path.join(f.directory, 'manuscript', '.git'));
    await fs.writeFile(path.join(f.directory, 'manuscript', '.git', 'config'), 'secret');
    const submission = await f.service.createSubmission('test', 'main');
    assert.equal(submission.verified, true);
    const archive = await f.service.submissionArtifact('test', submission.id);
    const listing = (await execute('/usr/bin/unzip', ['-Z1', archive])).stdout;
    assert.match(listing, /source\/main\.tex/);
    assert.match(listing, /paper\.pdf/);
    assert.match(listing, /compile\.json/);
    assert.match(listing, /SHA256SUMS\.json/);
    assert.doesNotMatch(listing, /private|\.git|notes|compile\.log/);
    const checks = JSON.parse((await execute('/usr/bin/unzip', ['-p', archive, 'checks.json'])).stdout);
    assert.equal(checks.independentCompilationSucceeded, true);
    assert.equal((await f.service.listSubmissions('test')).length, 1);
    assert.ok(f.events.some(e => e.type === 'submission.created'));
  } finally { await f.cleanup(); }
});

test('service restart retains completed builds and marks unfinished runs interrupted', async () => {
  const f = await fixture();
  let restored: BuildService | undefined;
  try {
    const success = await settled(f.service, (await f.service.request('test', 'main')).id);
    await f.service.close();
    const unfinished: Build = { id: 'b-interrupted', projectId: 'test', targetId: 'main', status: 'running', createdAt: new Date().toISOString(), log: 'Partial output', diagnostics: [] };
    const interruptedDir = path.join(f.directory, 'build', unfinished.id);
    await fs.mkdir(interruptedDir, { recursive: true });
    await fs.writeFile(path.join(interruptedDir, 'build.json'), JSON.stringify(unfinished));
    restored = f.create();
    assert.equal((await restored.get(success.id)).status, 'succeeded');
    const recovered = await restored.get(unfinished.id);
    assert.equal(recovered.status, 'failed');
    assert.match(recovered.reason!, /上次工作台停止/);
  } finally { await restored?.close(); await f.cleanup(); }
});

test('independent submission verification and build jobs share the engine slot, and close kills verification', async () => {
  const f = await fixture();
  try {
    const marker = path.join(f.root, 'verification-started');
    const script = await fs.readFile(f.compiler, 'utf8');
    await fs.writeFile(f.compiler, script.replace("if (content.includes('WAIT'))", `if (process.cwd().includes('paper-submission-verify-')) { fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000); } else if (content.includes('WAIT'))`));
    const exportTask = f.service.createSubmission('test', 'main');
    for (let i = 0; i < 300; i++) { try { await fs.access(marker); break; } catch { await pause(10); } }
    const pid = Number(await fs.readFile(marker, 'utf8'));
    assert.ok(pid > 0);
    const queued = await f.service.request('test', 'main');
    await pause(80);
    assert.equal((await f.service.get(queued.id)).log, '');
    const stoppedAt = Date.now();
    await f.service.close();
    const submission = await exportTask;
    assert.equal(submission.verified, false);
    assert.ok(Date.now() - stoppedAt < 2500);
    assert.equal((await f.service.get(queued.id)).status, 'cancelled');
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { await f.cleanup(); }
});

test('shared compiler mutex serializes direct compile calls', async () => {
  const f = await fixture();
  try {
    const lock = path.join(f.root, 'engine.lock');
    await fs.writeFile(f.compiler, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const lock = ${JSON.stringify(lock)};
try { fs.writeFileSync(lock, 'busy', { flag: 'wx' }); } catch { console.error('concurrent engine detected'); process.exit(6); }
setTimeout(() => { const args = process.argv.slice(2); const output = args[args.indexOf('--outdir') + 1]; fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'main.pdf'), '%PDF-1.4'); fs.unlinkSync(lock); process.exit(0); }, 80);
`);
    const options = { compiler: f.compiler, cwd: path.dirname(f.main), main: 'main.tex', timeoutMs: 2000 };
    const results = await Promise.all([runCompiler({ ...options, output: path.join(f.root, 'out-a') }), runCompiler({ ...options, output: path.join(f.root, 'out-b') })]);
    assert.deepEqual(results.map(item => item.code), [0, 0]);
  } finally { await f.cleanup(); }
});

test('root-level compilation excludes review and note material from frozen source', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.directory, 'main.tex'), 'Root main source');
    const manifest = JSON.parse(await fs.readFile(path.join(f.directory, 'project.json'), 'utf8')) as Project;
    manifest.targets[0].main = 'main.tex';
    await fs.writeFile(path.join(f.directory, 'project.json'), JSON.stringify(manifest));
    await fs.mkdir(path.join(f.directory, 'reviews'));
    await fs.writeFile(path.join(f.directory, 'reviews', 'secret-review.tex'), 'Private review');
    const build = await settled(f.service, (await f.service.request('test', 'main')).id);
    assert.equal(build.status, 'succeeded');
    await assert.rejects(fs.access(path.join(f.directory, 'build', build.id, 'source', 'reviews')));
  } finally { await f.cleanup(); }
});

test('dotted paper identifiers compile and restore build records after restart', async () => {
  const f = await fixture();
  let first: BuildService | undefined;
  let restored: BuildService | undefined;
  try {
    await f.service.close();
    const directory = path.join(f.root, 'papers', 'Paper.v1');
    await fs.rename(f.directory, directory);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'project.json'), 'utf8')) as Project;
    manifest.id = 'Paper.v1';
    await fs.writeFile(path.join(directory, 'project.json'), JSON.stringify(manifest));
    first = f.create();
    const build = await settled(first, (await first.request('Paper.v1', 'main')).id);
    assert.equal(build.status, 'succeeded');
    await first.close();
    restored = f.create();
    assert.equal((await restored.list('Paper.v1'))[0].id, build.id);
  } finally { await first?.close(); await restored?.close(); await f.cleanup(); }
});

test('private roots and aliased private roots cannot be selected for compilation', async () => {
  const f = await fixture();
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(f.directory, 'project.json'), 'utf8')) as Project;
    for (const source of ['notes/main.tex', 'literature/main.tex', 'reviews/round-01/original/main.tex', 'submissions/old/main.tex', '.private/main.tex']) {
      await fs.mkdir(path.dirname(path.join(f.directory, source)), { recursive: true });
      await fs.writeFile(path.join(f.directory, source), 'Private source');
      manifest.targets[0].main = source;
      await fs.writeFile(path.join(f.directory, 'project.json'), JSON.stringify(manifest));
      const build = await settled(f.service, (await f.service.request('test', 'main')).id);
      assert.equal(build.status, 'failed', source);
      assert.match(build.reason!, /目录|审稿/);
    }
    await fs.symlink(path.join(f.directory, 'notes'), path.join(f.directory, 'private-alias'));
    manifest.targets[0].main = 'private-alias/main.tex';
    await fs.writeFile(path.join(f.directory, 'project.json'), JSON.stringify(manifest));
    const aliased = await settled(f.service, (await f.service.request('test', 'main')).id);
    assert.equal(aliased.status, 'failed');
    assert.match(aliased.reason!, /目录/);
    await fs.mkdir(path.join(f.directory, 'reviews', 'round-01', 'response'), { recursive: true });
    await fs.writeFile(path.join(f.directory, 'reviews', 'round-01', 'response', 'main.tex'), 'Response source');
    manifest.targets[0].main = 'reviews/round-01/response/main.tex';
    await fs.writeFile(path.join(f.directory, 'project.json'), JSON.stringify(manifest));
    assert.equal((await settled(f.service, (await f.service.request('test', 'main')).id)).status, 'succeeded');
  } finally { await f.cleanup(); }
});

test('symlinked submission output directory cannot write outside project', async () => {
  const f = await fixture();
  try {
    const outside = path.join(f.root, 'outside-output');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(f.directory, 'submissions'));
    await assert.rejects(f.service.createSubmission('test', 'main'), /投稿输出目录越界/);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await f.cleanup(); }
});

test('hidden environment files are excluded from source snapshots and submission ZIPs', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.directory, 'manuscript', '.env'), 'SECRET=private');
    await fs.mkdir(path.join(f.directory, 'manuscript', '.private'));
    await fs.writeFile(path.join(f.directory, 'manuscript', '.private', 'draft.tex'), 'Private draft');
    const submission = await f.service.createSubmission('test', 'main');
    assert.equal(submission.verified, true);
    const archive = await f.service.submissionArtifact('test', submission.id);
    const listing = (await execute('/usr/bin/unzip', ['-Z1', archive])).stdout;
    assert.doesNotMatch(listing, /\.env|\.private/);
  } finally { await f.cleanup(); }
});

test('synthetic successful multi-pass logs discard resolved citation warnings', () => {
  const files = [{path:'main.tex',hash:'synthetic',bytes:Buffer.from('\\cite{sample}\\n\\bibliography{refs}\\n')},
    {path:'refs.bib',hash:'synthetic',bytes:Buffer.from('@article{sample,title={Synthetic reference}}')}];
  const raw = "note: Running TeX ...\nwarning: main.tex:1: Citation `sample' undefined.\nnote: Rerunning TeX ...\n";
  const finalLog = '(main.tex\nLaTeX Warning: There were multiply-defined labels.\n)';
  const diagnostics = parseDiagnostics(raw, 'manuscript', 'main.tex', {succeeded:true,files,finalLog});
  assert.equal(diagnostics.filter(item=>item.severity==='error').length,0);
  assert.ok(!diagnostics.some(item=>/Citation.*sample/.test(item.message)));
});

test('inline stderr markers cannot turn stdout traces into error filenames', () => {
  const diagnostics = parseDiagnostics([
    '(ifxetex.sty) (textcomp.sty)warning: libertine.sty:308: ',
    'Requested font "[LinLibertine_R.otf]/OT" at 8.99997pt',
    'Excluding comment.warning: tex/1_Instruction:17: Overfull \\hbox (5pt too wide)',
    'main.bbl:195: Underfull \\hbox (badness 10000)',
  ].join('\n'), 'manuscript', 'main.tex', { succeeded: true });
  assert.equal(diagnostics.filter(item => item.severity === 'error').length, 0);
  assert.ok(diagnostics.some(item => item.file === 'manuscript/tex/1_Instruction.tex' && item.line === 17));
  assert.ok(diagnostics.every(item => !item.file || !/[()]/.test(item.file)));
  assert.ok(diagnostics.some(item => /main.bbl:195/.test(item.message) && !item.file));
});

test('failed builds retain earlier fatal errors across TeX pass markers', () => {
  const log = 'note: Running TeX ...\nerror: main.tex:1: Fatal original error\nnote: Rerunning TeX because input changed ...\nwarning: main.tex:2: Later warning';
  const failed = parseDiagnostics(log, 'manuscript', 'main.tex', { succeeded: false });
  assert.ok(failed.some(item => item.severity === 'error' && /Fatal original/.test(item.message)));
  const succeeded = parseDiagnostics(log, 'manuscript', 'main.tex', { succeeded: true });
  assert.ok(!succeeded.some(item => item.severity === 'error'));
});


test('legacy diagnostics are lazily recovered from validated frozen source without recompiling or changing the outcome', async () => {
  const f = await fixture('\\ref{fig:missing}');
  let restored: BuildService | undefined;
  try {
    const completed = await settled(f.service, (await f.service.request('test', 'main')).id);
    await f.service.close();
    const metadata = path.join(f.directory, 'build', completed.id, 'build.json');
    const old = JSON.parse(await fs.readFile(metadata, 'utf8')) as Build;
    old.diagnostics = [];
    await fs.writeFile(metadata, JSON.stringify(old));
    // The current editor is deliberately different; recovery must use only the
    // old snapshot, and removing the engine proves no compilation was requested.
    await fs.writeFile(f.main, '\\label{fig:missing}');
    await fs.rm(f.compiler);
    restored = f.create();
    const recovered = await restored.get(completed.id);
    assert.equal(recovered.status, 'succeeded');
    assert.equal(recovered.stale, true);
    assert.ok(recovered.diagnostics.some(d => /fig:missing/.test(d.message) && d.file === 'manuscript/main.tex' && d.line === 1 && d.severity === 'warning'));
    assert.equal((JSON.parse(await fs.readFile(metadata, 'utf8')) as Build).diagnostics.length, 0, 'lazy recovery does not rewrite historical metadata');
    assert.deepEqual((await restored.list('test'))[0].diagnostics, recovered.diagnostics);
  } finally { await restored?.close(); await f.cleanup(); }
});

test('legacy enrichment refuses modified frozen sources rather than deriving issues from untrusted or current source', async () => {
  const f = await fixture('\\ref{fig:missing}');
  let restored: BuildService | undefined;
  try {
    const completed = await settled(f.service, (await f.service.request('test', 'main')).id);
    await f.service.close();
    const directory = path.join(f.directory, 'build', completed.id);
    const metadata = path.join(directory, 'build.json');
    const old = JSON.parse(await fs.readFile(metadata, 'utf8')) as Build;
    old.diagnostics = [{ severity: 'warning', category: 'compile', message: 'original diagnostic retained' }];
    await fs.writeFile(metadata, JSON.stringify(old));
    await fs.writeFile(path.join(directory, 'source', 'main.tex'), '\\ref{tampered}');
    restored = f.create();
    assert.deepEqual((await restored.get(completed.id)).diagnostics, old.diagnostics);
  } finally { await restored?.close(); await f.cleanup(); }
});

test('task-owned builds are idempotent and cannot coalesce with manual or another task',async()=>{
 const f=await fixture('WAIT');try{
  const first=await f.service.request('test','main');await running(f.service,first.id);
  const source=await currentBuildSource(f.root,'test','main');
  const owned=await f.service.request('test','main',{runId:'run-a',idempotencyKey:'step-1',expectedSourceHash:source.sourceHash,expectedTargetMain:source.targetMain});
  const duplicate=await f.service.request('test','main',{runId:'run-a',idempotencyKey:'step-1',expectedSourceHash:source.sourceHash,expectedTargetMain:source.targetMain});assert.equal(owned.id,duplicate.id);
  const other=await f.service.request('test','main',{runId:'run-b',idempotencyKey:'step-1',expectedSourceHash:source.sourceHash,expectedTargetMain:source.targetMain});
  const manual=await f.service.request('test','main');assert.notEqual(other.id,owned.id);assert.notEqual(manual.id,owned.id);assert.notEqual(manual.id,other.id);
  await assert.rejects(f.service.request('test','main',{runId:'run-a',idempotencyKey:'step-1',expectedSourceHash:'0'.repeat(64),expectedTargetMain:source.targetMain}),/幂等/);
  await f.service.cancel(owned.id);assert.equal((await f.service.get(other.id)).status,'queued');
  await f.service.cancel(other.id);await f.service.cancel(manual.id);await f.service.cancel(first.id);
 }finally{await f.cleanup();}
});
test('queued task build rejects a changed source fingerprint before invoking the compiler',async()=>{
 const f=await fixture('WAIT');try{
  const blocker=await f.service.request('test','main');await running(f.service,blocker.id);const source=await currentBuildSource(f.root,'test','main');
  const owned=await f.service.request('test','main',{runId:'run-a',idempotencyKey:'source-check',expectedSourceHash:source.sourceHash,expectedTargetMain:source.targetMain});
  await fs.writeFile(f.main,'New human content');await f.service.cancel(blocker.id);const result=await settled(f.service,owned.id);
  assert.equal(result.status,'failed');assert.match(result.reason!,/排队期间源码已变化/);assert.ok(!result.log.includes('engine-started'));assert.equal(result.pdf,undefined);
 }finally{await f.cleanup();}
});
