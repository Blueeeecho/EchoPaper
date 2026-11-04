import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Build, Diagnostic, Submission } from '../shared/types.ts';
import { atomicJSON, contained, fingerprint, runCompiler, sourceFiles, serviceError } from './compile-utils.ts';
import { parseDiagnostics } from './diagnostics.ts';

const execute = promisify(execFile);
export interface SubmissionOptions { projectDirectory: string; buildDirectory: string; build: Build; compiler: string; timeoutMs: number; main: string; prefix: string; signal?: AbortSignal }
async function checksumTree(root: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (relative === 'SHA256SUMS.json') continue;
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) await walk(absolute, relative);
      else if (item.isFile()) values[relative] = createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
      else throw serviceError('投稿快照包含不支持的文件类型', 422);
    }
  }
  await walk(root, '');
  return values;
}
export async function createSubmissionArchive(options: SubmissionOptions): Promise<Submission> {
  const id = `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const submissionsRoot = path.join(options.projectDirectory, 'submissions');
  await fs.mkdir(submissionsRoot, { recursive: true });
  const realSubmissionsRoot = await fs.realpath(submissionsRoot);
  if (!contained(options.projectDirectory, realSubmissionsRoot)) throw serviceError('投稿输出目录越界', 403);
  const directory = path.join(realSubmissionsRoot, id);
  const packageDirectory = path.join(directory, 'package');
  const archive = path.join(directory, 'submission.zip');
  const createdAt = new Date().toISOString();
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.cp(path.join(options.buildDirectory, 'source'), path.join(packageDirectory, 'source'), { recursive: true, dereference: false });
  await fs.copyFile(path.join(options.buildDirectory, 'artifacts', options.build.pdf!), path.join(packageDirectory, 'paper.pdf'));
  let version = 'unknown';
  try { version = (await execute(options.compiler, ['--version'], { timeout: 10000 })).stdout.trim(); } catch { /* The compilation itself is authoritative. */ }
  await atomicJSON(path.join(packageDirectory, 'compile.json'), {
    engine: 'tectonic', version, main: `source/${options.main}`, workingDirectory: 'source',
    command: ['tectonic', '-X', 'compile', '--untrusted', '--synctex', '--keep-logs', '--keep-intermediates', '--print', '--outdir', '../rebuild', options.main],
    sourceHash: options.build.sourceHash, buildId: options.build.id, targetId: options.build.targetId, createdAt,
  });
  await fs.writeFile(path.join(packageDirectory, 'README.txt'), [
    '论文投稿快照 / Paper source snapshot',
    '',
    'source/ 为本次编译使用的冻结源码；paper.pdf 为对应的成功编译结果。',
    'compile.json 记录编译器版本、工作目录和独立编译命令。SHA256SUMS.json 可核对文件内容。',
    'checks.json 记录技术检查；可编译不表示结果完整、格式合规或已完成外部投稿。',
    '该包不包含写作笔记、与所选目标无关的审稿材料、版本库或工作缓存。',
    '',
  ].join('\n'));
  const zip = async () => {
    await fs.rm(archive, { force: true });
    await execute('/usr/bin/zip', ['-q', '-r', archive, '.'], { cwd: packageDirectory, timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  };
  await atomicJSON(path.join(packageDirectory, 'checks.json'), { compilationSucceeded: true, independentCompilationSucceeded: false, diagnostics: options.build.diagnostics, checkedAt: createdAt });
  await atomicJSON(path.join(packageDirectory, 'SHA256SUMS.json'), await checksumTree(packageDirectory));
  await zip();
  const extracted = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-submission-verify-'));
  let verified = false;
  let verificationLog = '';
  let diagnostics: Diagnostic[] = [...options.build.diagnostics];
  try {
    await execute('/usr/bin/unzip', ['-q', archive, '-d', extracted], { timeout: 120000 });
    const expected = JSON.parse(await fs.readFile(path.join(extracted, 'SHA256SUMS.json'), 'utf8')) as Record<string, string>;
    const actual = await checksumTree(extracted);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw serviceError('投稿包解压后校验不一致', 422);
    const extractedFiles = await sourceFiles(path.join(extracted, 'source'), options.main);
    const extractedHash = fingerprint(extractedFiles);
    if (extractedHash !== options.build.sourceHash) throw serviceError('投稿包源码与编译快照不一致', 422);
    const output = path.join(extracted, 'verification-output');
    const result = await runCompiler({ compiler: options.compiler, cwd: path.join(extracted, 'source'), output, main: options.main, timeoutMs: options.timeoutMs, signal: options.signal });
    verificationLog = result.fullLog ?? result.log;
    const expectedPDF = path.join(output, options.main.replace(/\.tex$/i, '.pdf'));
    let pdfExists = false;
    try { pdfExists = (await fs.readFile(expectedPDF)).subarray(0, 5).toString() === '%PDF-'; } catch { /* Recorded below. */ }
    verified = result.code === 0 && !result.timedOut && pdfExists;
    if (!verified) diagnostics.push({ severity: 'error', category: 'compile', message: `投稿包独立编译失败${result.timedOut ? '（超时）' : ''}，请查看 verification.log。` });
    let finalLog: string | undefined;
    try { finalLog = await fs.readFile(path.join(output, options.main.replace(/\.tex$/i, '.log')), 'utf8'); } catch { /* Raw stream remains available. */ }
    diagnostics = [...diagnostics, ...parseDiagnostics(result.log, options.prefix, options.main, { succeeded: verified, files: extractedFiles, finalLog })];
  } catch (error) {
    verificationLog += `\n${(error as Error).message}`;
    diagnostics.push({ severity: 'error', category: 'compile', message: `投稿包独立验证失败：${(error as Error).message}` });
  } finally {
    await fs.rm(extracted, { recursive: true, force: true });
  }
  await fs.writeFile(path.join(directory, 'verification.log'), verificationLog);
  diagnostics = [...new Map(diagnostics.map(item => [JSON.stringify(item), item])).values()];
  await atomicJSON(path.join(packageDirectory, 'checks.json'), { compilationSucceeded: true, independentCompilationSucceeded: verified, diagnostics, checkedAt: new Date().toISOString() });
  await atomicJSON(path.join(packageDirectory, 'SHA256SUMS.json'), await checksumTree(packageDirectory));
  await zip();
  const submission: Submission = { id, projectId: options.build.projectId, targetId: options.build.targetId, createdAt, buildId: options.build.id, sourceHash: options.build.sourceHash!, verified, diagnostics, archive: 'submission.zip' };
  await atomicJSON(path.join(directory, 'submission.json'), submission);
  return submission;
}
