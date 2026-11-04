import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { Build, BuildService, BuildRequestOptions, EmitEvent, Submission } from '../shared/types.ts';
import {withLock,withProjectMutation} from './storage';
import { atomicJSON, contained, fingerprint, readProject, runCompiler, safeId, serviceError, snapshotSource, sourceFiles, targetSource, terminate } from './compile-utils.ts';
import { DIAGNOSTICS_VERSION, dedupeDiagnostics, parseDiagnostics, placeholderDiagnostics } from './diagnostics.ts';
import type { SourceFile } from './compile-utils.ts';
import { createSubmissionArchive } from './submissions.ts';

interface BuildRecord { build: Build; directory: string; main: string; prefix: string; child?: ChildProcess; controller?: AbortController; persist: Promise<void>; completion: ((build: Build) => void)[]; cancelled: boolean; diagnosticsVersion?: number; diagnosticsRefresh?: Promise<void> }
export interface BuildServiceOptions { workspaceRoot: string; emit: EmitEvent; compilerPath?: string; timeoutMs?: number }
const terminal = (build: Build) => ['succeeded', 'failed', 'cancelled'].includes(build.status);
const clone = <T>(value: T): T => structuredClone(value);
export async function currentBuildSource(workspaceRoot:string,projectId:string,targetId:string):Promise<{sourceHash:string;targetMain:string}>{const source=await targetSource(workspaceRoot,projectId,targetId);return {sourceHash:fingerprint(await sourceFiles(source.sourceDirectory,source.main)),targetMain:source.target.main};}

export function createBuildService(options: BuildServiceOptions): BuildService {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const compiler = options.compilerPath || process.env.TECTONIC_PATH || '/opt/homebrew/bin/tectonic';
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const records = new Map<string, BuildRecord>();
  const queue: string[] = [];
  const exportsInFlight = new Map<string, Promise<Submission>>();
  const exportControllers = new Map<string, AbortController>();
  let closed = false;
  let pumpPromise: Promise<void> | undefined;
  const broadcast = (record: BuildRecord) => options.emit({ type: 'build.updated', projectId: record.build.projectId, build: clone(record.build) });
  const persist = (record: BuildRecord) => {
    record.persist = record.persist.catch(() => undefined).then(() => atomicJSON(path.join(record.directory, 'build.json'), record.build));
    return record.persist;
  };
  const finish = async (record: BuildRecord) => {
    record.build.finishedAt ??= new Date().toISOString();
    try { await persist(record); } catch (error) {
      if (record.build.status !== 'cancelled') record.build.status = 'failed';
      record.build.reason = `编译状态无法保存：${(error as Error).message}`;
      record.build.diagnostics.push({ severity: 'error', category: 'compile', message: record.build.reason });
    }
    broadcast(record);
    record.completion.splice(0).forEach(resolve => resolve(clone(record.build)));
  };
  const ready = (async () => {
    await fs.mkdir(path.join(workspaceRoot, 'papers'), { recursive: true });
    for (const projectName of await fs.readdir(path.join(workspaceRoot, 'papers'))) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(projectName)) continue;
      let projectDirectory: string;
      try { projectDirectory = (await readProject(workspaceRoot, projectName)).directory; } catch { continue; }
      const root = path.join(projectDirectory, 'build');
      let entries: string[];
      try { entries = await fs.readdir(root); } catch { continue; }
      for (const entry of entries) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(entry)) continue;
        try {
          const directory = await fs.realpath(path.join(root, entry));
          if (!contained(projectDirectory, directory)) continue;
          const build = JSON.parse(await fs.readFile(path.join(directory, 'build.json'), 'utf8')) as Build;
          if (build.id !== entry || build.projectId !== projectName) continue;
          let configuration = { main: 'main.tex', prefix: 'manuscript' };
          try { configuration = JSON.parse(await fs.readFile(path.join(directory, 'compile-config.json'), 'utf8')); } catch { /* Legacy interrupted run. */ }
          const record: BuildRecord = { build, directory, main: configuration.main, prefix: configuration.prefix, persist: Promise.resolve(), completion: [], cancelled: false };
          records.set(build.id, record);
          if (!terminal(build)) {
            build.status = 'failed';
            build.reason = '上次工作台停止时编译尚未完成，请重新编译。';
            build.diagnostics = [...(build.diagnostics || []), { severity: 'error', category: 'compile', message: build.reason }];
            await finish(record);
          }
        } catch { /* A partial metadata file must not prevent startup. */ }
      }
    }
  })();

  async function refreshDiagnostics(record: BuildRecord): Promise<void> {
    if (!terminal(record.build) || record.diagnosticsVersion === DIAGNOSTICS_VERSION) return;
    if (record.diagnosticsRefresh) return record.diagnosticsRefresh;
    record.diagnosticsRefresh = (async () => {
      // Old runs are enriched only from their immutable snapshot, never from
      // today's editor files. An incomplete or modified snapshot is left alone.
      try {
        const config = JSON.parse(await fs.readFile(path.join(record.directory, 'compile-config.json'), 'utf8')) as { main: string; prefix: string; sourceHash?: string };
        if (!config.main || !record.build.sourceHash || config.sourceHash !== record.build.sourceHash) return;
        const manifest = JSON.parse(await fs.readFile(path.join(record.directory, 'source-manifest.json'), 'utf8')) as { path: string; sha256: string }[];
        if (!Array.isArray(manifest) || !manifest.length) return;
        const root = await fs.realpath(path.join(record.directory, 'source'));
        if (!contained(record.directory, root)) return;
        const frozen: SourceFile[] = [];
        for (const entry of manifest) {
          if (typeof entry.path !== 'string' || path.posix.isAbsolute(entry.path) || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..')) return;
          const filename = await fs.realpath(path.join(root, entry.path));
          if (!contained(root, filename)) return;
          const bytes = await fs.readFile(filename); const hash = createHash('sha256').update(bytes).digest('hex');
          if (hash !== entry.sha256) return;
          frozen.push({ path: entry.path, bytes, hash });
        }
        if (!frozen.some(file => file.path === config.main) || fingerprint(frozen) !== record.build.sourceHash) return;
        let stream = record.build.log;
        try { stream = await fs.readFile(path.join(record.directory, 'compile.log'), 'utf8'); } catch { /* Legacy stream retained in build metadata. */ }
        let finalLog: string | undefined;
        try { finalLog = await fs.readFile(path.join(record.directory, 'artifacts', config.main.replace(/\.tex$/i, '.log')), 'utf8'); } catch { /* Stream fallback. */ }
        const derived = dedupeDiagnostics([
          ...placeholderDiagnostics(frozen, config.main, config.prefix),
          ...parseDiagnostics(stream, config.prefix, config.main, { succeeded: record.build.status === 'succeeded', files: frozen, finalLog }),
        ]);
        // Preserve operational failures that have no TeX representation (timeout,
        // cancellation, interrupted service, etc.). The build outcome is fixed.
        const operational = record.build.diagnostics.filter(item => (record.build.reason && item.message === record.build.reason) || /完整日志写入失败|编译状态无法保存/.test(item.message));
        record.build.diagnostics = dedupeDiagnostics([...derived, ...operational]);
        record.diagnosticsVersion = DIAGNOSTICS_VERSION;
      } catch { /* Incomplete legacy builds keep their original diagnostics. */ }
    })().finally(() => { record.diagnosticsRefresh = undefined; });
    return record.diagnosticsRefresh;
  }
  async function refreshStaleness(record: BuildRecord): Promise<Build> {
    await refreshDiagnostics(record);
    const result = clone(record.build);
    if (!result.sourceHash) return result;
    try {
      const source = await targetSource(workspaceRoot, result.projectId, result.targetId);
      result.stale = fingerprint(await sourceFiles(source.sourceDirectory, source.main)) !== result.sourceHash;
    } catch { result.stale = true; }
    return result;
  }
  async function execute(record: BuildRecord): Promise<void> {
    if (record.cancelled) return;
    record.build.status = 'running';
    record.build.startedAt = new Date().toISOString();
    await persist(record);
    broadcast(record);
    let logWrites = Promise.resolve();
    let logWriteError: Error | undefined;
    let emitTimer: NodeJS.Timeout | undefined;
    const logPath = path.join(record.directory, 'compile.log');
    try {
      await fs.writeFile(logPath, '');
      const source = await targetSource(workspaceRoot, record.build.projectId, record.build.targetId);
      if(record.build.expectedTargetMain&&record.build.expectedTargetMain!==source.target.main)throw serviceError('任务绑定的编译目标已变化，未运行编译。',409);
      record.main = source.main;
      record.prefix = source.prefix;
      const frozen = await withProjectMutation(source.directory,()=>snapshotSource(source.sourceDirectory, path.join(record.directory, 'source'), source.main));
      if(record.build.expectedSourceHash&&record.build.expectedSourceHash!==frozen.hash)throw serviceError('排队期间源码已变化，本构建未验证任务提交的版本。',409);
      record.build.sourceHash = frozen.hash;
      record.build.diagnostics = placeholderDiagnostics(frozen.files, source.main, source.prefix);
      await atomicJSON(path.join(record.directory, 'source-manifest.json'), frozen.files.map(file => ({ path: file.path, sha256: file.hash })));
      await atomicJSON(path.join(record.directory, 'compile-config.json'), { compiler, main: source.main, prefix: source.prefix, targetMain: source.target.main, sourceHash: frozen.hash });
      await persist(record);
      if (record.cancelled) return;
      record.controller = new AbortController();
      const result = await runCompiler({
        compiler, cwd: path.join(record.directory, 'source'), output: path.join(record.directory, 'artifacts'), main: source.main, timeoutMs, signal: record.controller.signal,
        onSpawn: child => { record.child = child; if (record.cancelled) terminate(child); },
        onOutput: chunk => {
          record.build.log = (record.build.log + chunk).slice(-262144);
          logWrites = logWrites.then(() => fs.appendFile(logPath, chunk)).catch(error => { logWriteError = error as Error; });
          if (!emitTimer) emitTimer = setTimeout(() => { emitTimer = undefined; broadcast(record); void persist(record).catch(error => { logWriteError = error as Error; }); }, 250);
        },
      });
      await logWrites;
      record.child = undefined;
      record.build.exitCode = result.code;
      if (record.cancelled) return;
      const pdf = source.main.replace(/\.tex$/i, '.pdf');
      let validPDF = false;
      try { validPDF = (await fs.readFile(path.join(record.directory, 'artifacts', pdf))).subarray(0, 5).toString() === '%PDF-'; } catch { /* No PDF generated. */ }
      let finalLog: string | undefined;
      try { finalLog = await fs.readFile(path.join(record.directory, 'artifacts', source.main.replace(/\.tex$/i, '.log')), 'utf8'); } catch { /* Raw stream remains available. */ }
      record.build.diagnostics = dedupeDiagnostics([...record.build.diagnostics, ...parseDiagnostics(result.log, source.prefix, source.main, { succeeded: result.code === 0 && !result.timedOut && validPDF, files: frozen.files, finalLog })]);
      record.diagnosticsVersion = DIAGNOSTICS_VERSION;
      if (result.code === 0 && !result.timedOut && validPDF) {
        record.build.status = 'succeeded';
        record.build.pdf = pdf;
      } else {
        record.build.status = 'failed';
        record.build.reason = result.timedOut ? '编译超时。首次运行可能仍在下载依赖，可查看完整日志后重试。'
          : result.error ? `无法启动 Tectonic：${result.error}`
          : /download|network|HTTP|TLS|certificate|failed to get bundle|failed to open bundle/i.test(result.log) && !record.build.diagnostics.some(item => item.severity === 'error') ? '依赖下载或网络访问失败，请查看完整日志后重试。'
          : result.code === 0 ? '编译器未生成有效 PDF。' : 'LaTeX 编译失败，请查看错误和完整日志。';
        if (!record.build.diagnostics.some(item => item.severity === 'error')) record.build.diagnostics.push({ severity: 'error', category: 'compile', message: record.build.reason });
      }
      record.build.stale = (await refreshStaleness(record)).stale;
    } catch (error) {
      if (!record.cancelled) {
        record.build.status = 'failed';
        record.build.reason = (error as Error).message;
        record.build.log += `\n${record.build.reason}\n`;
        record.build.diagnostics.push({ severity: 'error', category: 'compile', message: record.build.reason });
        await fs.appendFile(logPath, `\n${record.build.reason}\n`).catch(logError => { logWriteError = logError as Error; });
      }
    } finally {
      if (emitTimer) clearTimeout(emitTimer);
      await logWrites;
      record.child = undefined;
      record.controller = undefined;
      if (logWriteError) record.build.diagnostics.push({ severity: 'warning', category: 'compile', message: `完整日志写入失败：${logWriteError.message}` });
      if (record.cancelled) record.build.status = 'cancelled';
      await finish(record);
    }
  }
  function kick(): void {
    if (pumpPromise || closed) return;
    pumpPromise = (async () => {
      while (queue.length && !closed) {
        const record = records.get(queue.shift()!);
        if (record && !record.cancelled) {
          try { await execute(record); } catch (error) {
            record.build.status = record.cancelled ? 'cancelled' : 'failed';
            record.build.reason = `编译任务异常：${(error as Error).message}`;
            record.build.diagnostics.push({ severity: 'error', category: 'compile', message: record.build.reason });
            await finish(record);
          }
        }
      }
    })().finally(() => { pumpPromise = undefined; if (queue.length && !closed) kick(); });
  }
  async function waitFor(record: BuildRecord): Promise<Build> {
    if (terminal(record.build)) return clone(record.build);
    return new Promise(resolve => record.completion.push(resolve));
  }
  async function request(projectId: string, targetId: string, requestOptions:BuildRequestOptions={}): Promise<Build> {
    return withLock(`build-request:${workspaceRoot}:${projectId}:${targetId}`,async()=>{
    await ready;
    if (closed) throw serviceError('编译服务已停止', 503);
    const { project, directory } = await readProject(workspaceRoot, projectId);
    if (!project.targets.some(target => target.id === targetId)) throw serviceError('编译目标不存在', 404);
    if(requestOptions.runId!==undefined)safeId(requestOptions.runId,'任务编号');
    if(requestOptions.expectedSourceHash!==undefined&&!/^[a-f0-9]{64}$/.test(requestOptions.expectedSourceHash))throw serviceError('构建源码指纹无效。');
    if(requestOptions.idempotencyKey!==undefined&&(typeof requestOptions.idempotencyKey!=='string'||!requestOptions.idempotencyKey||requestOptions.idempotencyKey.length>240))throw serviceError('构建幂等键无效。');
    if(requestOptions.runId&&!requestOptions.idempotencyKey)throw serviceError('任务编译需要幂等键。');
    if(requestOptions.idempotencyKey){const existing=[...records.values()].find(r=>r.build.projectId===projectId&&r.build.runId===requestOptions.runId&&r.build.idempotencyKey===requestOptions.idempotencyKey);if(existing){if(existing.build.targetId!==targetId||existing.build.expectedSourceHash!==requestOptions.expectedSourceHash||existing.build.expectedTargetMain!==requestOptions.expectedTargetMain)throw serviceError('同一幂等键不能用于不同源码或目标。',409);return clone(existing.build);}}
    const pending = queue.map(id => records.get(id)!).find(record => !record.cancelled && record.build.projectId === projectId && record.build.targetId === targetId && !requestOptions.runId && !record.build.runId);
    if (pending) return clone(pending.build);
    const id = `b-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const build: Build = { id, projectId, targetId, status: 'queued', createdAt: new Date().toISOString(), log: '', diagnostics: [], ...requestOptions };
    const buildRoot = path.join(directory, 'build');
    await fs.mkdir(buildRoot, { recursive: true });
    const realBuildRoot = await fs.realpath(buildRoot);
    if (!contained(directory, realBuildRoot)) throw serviceError('编译输出目录越界', 403);
    const record: BuildRecord = { build, directory: path.join(realBuildRoot, id), main: '', prefix: '', persist: Promise.resolve(), completion: [], cancelled: false };
    records.set(id, record);
    try { await persist(record); } catch (error) { records.delete(id); throw serviceError(`无法创建编译任务：${(error as Error).message}`, 500); }
    queue.push(id);
    broadcast(record);
    setImmediate(kick);
    return clone(build);
    });
  }
  async function cancel(id: string): Promise<Build> {
    await ready;
    const record = records.get(id);
    if (!record) throw serviceError('编译任务不存在', 404);
    if (!terminal(record.build)) {
      record.cancelled = true;
      record.build.status = 'cancelled';
      record.build.reason = '编译已取消';
      record.controller?.abort();
      if (record.child) {
        const child = record.child;
        terminate(child);
        const timer = setTimeout(() => { if (record.child === child) terminate(child, 'SIGKILL'); }, 1000);
        timer.unref();
      }
      await finish(record);
    }
    return clone(record.build);
  }
  async function get(id: string): Promise<Build> {
    await ready;
    const record = records.get(id);
    if (!record) throw serviceError('编译任务不存在', 404);
    return refreshStaleness(record);
  }
  async function artifact(id: string, name: string): Promise<string> {
    await ready;
    const record = records.get(id);
    if (!record) throw serviceError('编译任务不存在', 404);
    if (!name || name !== path.basename(name) || name.includes('\\') || name.includes('\0')) throw serviceError('产物路径不合法');
    const root = name === 'compile.log' ? record.directory : path.join(record.directory, 'artifacts');
    try {
      const resolved = await fs.realpath(path.join(root, name));
      if (!contained(root, resolved) || !(await fs.stat(resolved)).isFile()) throw serviceError('产物路径越界', 403);
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw serviceError('编译产物不存在', 404);
      throw error;
    }
  }
  async function list(projectId: string): Promise<Build[]> {
    await ready;
    await readProject(workspaceRoot, projectId);
    return Promise.all([...records.values()].filter(record => record.build.projectId === projectId).sort((a, b) => b.build.createdAt.localeCompare(a.build.createdAt)).map(refreshStaleness));
  }
  async function createSubmission(projectId: string, targetId: string): Promise<Submission> {
    await ready;
    const key = `${projectId}/${targetId}`;
    if (exportsInFlight.has(key)) return exportsInFlight.get(key)!;
    const controller = new AbortController();
    exportControllers.set(key, controller);
    const task = (async () => {
      const buildRequest = await request(projectId, targetId);
      const record = records.get(buildRequest.id)!;
      const build = await waitFor(record);
      if (build.status !== 'succeeded' || !build.pdf) throw serviceError('当前稿件编译未成功，未创建投稿包。', 422);
      if ((await refreshStaleness(record)).stale) throw serviceError('稿件在编译期间发生变化，请保存后重新生成投稿包。', 409);
      const { directory } = await readProject(workspaceRoot, projectId);
      const submission = await createSubmissionArchive({ projectDirectory: directory, buildDirectory: record.directory, build, compiler, timeoutMs, main: record.main, prefix: record.prefix, signal: controller.signal });
      options.emit({ type: 'submission.created', projectId });
      return submission;
    })().finally(() => { exportsInFlight.delete(key); exportControllers.delete(key); });
    exportsInFlight.set(key, task);
    return task;
  }
  async function listSubmissions(projectId: string): Promise<Submission[]> {
    const { directory } = await readProject(workspaceRoot, projectId);
    let names: string[];
    try { names = await fs.readdir(path.join(directory, 'submissions')); } catch { return []; }
    const result: Submission[] = [];
    for (const name of names) {
      try {
        safeId(name);
        const root = await fs.realpath(path.join(directory, 'submissions', name));
        if (!contained(directory, root)) continue;
        const submission = JSON.parse(await fs.readFile(path.join(root, 'submission.json'), 'utf8')) as Submission;
        if (submission.id === name && submission.projectId === projectId) result.push(submission);
      } catch { /* Ignore incomplete staging directories. */ }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function submissionArtifact(projectId: string, submissionId: string): Promise<string> {
    safeId(submissionId);
    const { directory } = await readProject(workspaceRoot, projectId);
    const item = (await listSubmissions(projectId)).find(submission => submission.id === submissionId);
    if (!item) throw serviceError('投稿快照不存在', 404);
    const root = path.join(directory, 'submissions', submissionId);
    const filename = await fs.realpath(path.join(root, 'submission.zip'));
    if (!contained(root, filename)) throw serviceError('投稿文件路径越界', 403);
    return filename;
  }
  async function close(): Promise<void> {
    await ready;
    closed = true;
    for (const controller of exportControllers.values()) controller.abort();
    await Promise.all([...records.values()].filter(record => !terminal(record.build)).map(record => cancel(record.build.id)));
    await pumpPromise;
    await Promise.allSettled([...exportsInFlight.values()]);
    await Promise.all([...records.values()].map(record => record.persist));
  }
  return { request, cancel, get, list, artifact, createSubmission, listSubmissions, submissionArtifact, close };
}
