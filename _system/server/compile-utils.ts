import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { CompileTarget, Project } from '../shared/types.ts';
import { localResourceBundle, missingCachedResource } from './local-resource-bundle.ts';

export function serviceError(message: string, statusCode = 400): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
export function safeId(value: string, kind = '标识'): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) throw serviceError(`${kind}不合法`);
  return value;
}
export function safeRelative(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || path.isAbsolute(value) || value.split('/').some(v => v === '..' || v === '.git')) throw serviceError('文件路径不合法');
  return value;
}
export function contained(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
function assertCompileLocation(relative: string): void {
  const parts = relative.split('/').filter(Boolean);
  if (parts.some(part => part.startsWith('.'))) throw serviceError('隐藏目录不能作为编译源目录', 403);
  if (['notes', 'literature', 'build', 'submissions', '.git', '.workbench', '.cache'].includes(parts[0])) throw serviceError('此目录包含工作记录或产物，不能作为编译源目录', 403);
  if (parts[0] === 'reviews' && (parts.length < 4 || parts[2] !== 'response')) throw serviceError('审稿轮次仅可编译 response 目录中的回复文档', 403);
}
export async function readProject(workspaceRoot: string, projectId: string): Promise<{ project: Project; directory: string }> {
  safeId(projectId, '论文编号');
  const papers = path.join(workspaceRoot, 'papers');
  const directory = path.join(papers, projectId);
  try {
    const realPapers = await fs.realpath(papers);
    const realDirectory = await fs.realpath(directory);
    if (!contained(realPapers, realDirectory) || realDirectory === realPapers) throw serviceError('论文路径越界', 403);
    const manifestPath = await fs.realpath(path.join(directory, 'project.json'));
    if (!contained(realDirectory, manifestPath)) throw serviceError('论文配置路径越界', 403);
    const project = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Project;
    if (project.id !== projectId || !Array.isArray(project.targets)) throw serviceError('论文配置损坏', 422);
    return { project, directory: realDirectory };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw serviceError('论文不存在', 404);
    throw error;
  }
}
export async function targetSource(workspaceRoot: string, projectId: string, targetId: string): Promise<{ project: Project; directory: string; target: CompileTarget; sourceDirectory: string; main: string; prefix: string }> {
  const { project, directory } = await readProject(workspaceRoot, projectId);
  const target = project.targets.find(item => item.id === targetId);
  if (!target) throw serviceError('编译目标不存在', 404);
  safeRelative(target.main);
  assertCompileLocation(target.main);
  if (path.extname(target.main).toLowerCase() !== '.tex') throw serviceError('编译主文件必须是 .tex 文件');
  const absolute = path.resolve(directory, target.main);
  if (!contained(directory, absolute)) throw serviceError('编译路径越界', 403);
  const sourceDirectory = await fs.realpath(path.dirname(absolute));
  if (!contained(directory, sourceDirectory)) throw serviceError('编译路径越界', 403);
  const mainReal = await fs.realpath(absolute);
  if (!contained(sourceDirectory, mainReal)) throw serviceError('编译主文件不能链接到源目录之外', 403);
  assertCompileLocation(path.relative(directory, mainReal).split(path.sep).join('/'));
  const prefix = path.relative(directory, sourceDirectory).split(path.sep).join('/');
  return { project, directory, target, sourceDirectory, main: path.basename(absolute), prefix };
}

const OMIT_DIRECTORIES = new Set(['.git', 'build', 'node_modules', 'submissions', 'reviews', 'notes', 'literature', '.cache', '.workbench', '__pycache__']);
const OMIT_FILE = /(?:\.aux|\.log|\.out|\.toc|\.fls|\.fdb_latexmk|\.synctex(?:\.gz)?|\.blg|\.xdv|\.dvi|\.bcf|\.run\.xml)$/i;
export interface SourceFile { path: string; bytes: Buffer; hash: string }
export async function sourceFiles(root: string, main?: string): Promise<SourceFile[]> {
  const realRoot = await fs.realpath(root);
  const files: SourceFile[] = [];
  async function walk(directory: string, prefix: string, ancestry: Set<string>): Promise<void> {
    const realDirectory = await fs.realpath(directory);
    if (!contained(realRoot, realDirectory)) throw serviceError('源文件符号链接越界', 403);
    if (ancestry.has(realDirectory)) throw serviceError('源目录包含循环符号链接', 422);
    const next = new Set(ancestry).add(realDirectory);
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (item.name.startsWith('.') || OMIT_DIRECTORIES.has(item.name)) continue;
      if (item.name === 'project.json' && prefix === '') continue;
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      const absolute = path.join(directory, item.name);
      const real = await fs.realpath(absolute);
      if (!contained(realRoot, real)) throw serviceError(`源文件符号链接越界：${relative}`, 403);
      const stat = await fs.stat(real);
      if (stat.isDirectory()) await walk(absolute, relative, next);
      else if (stat.isFile() && !OMIT_FILE.test(item.name) && !(main && relative === main.replace(/\.tex$/i, '.pdf'))) {
        const bytes = await fs.readFile(real);
        files.push({ path: relative, bytes, hash: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await walk(realRoot, '', new Set());
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function fingerprint(files: Pick<SourceFile, 'path' | 'hash'>[]): string {
  return createHash('sha256').update(JSON.stringify(files.map(file => [file.path, file.hash]))).digest('hex');
}
export async function snapshotSource(root: string, destination: string, main: string): Promise<{ files: SourceFile[]; hash: string }> {
  const files = await sourceFiles(root, main);
  if (!files.some(file => file.path === main)) throw serviceError('编译主文件不存在', 422);
  await fs.mkdir(destination, { recursive: true });
  for (const file of files) {
    const output = path.join(destination, file.path);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, file.bytes);
  }
  return { files, hash: fingerprint(files) };
}
export async function atomicJSON(filename: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filename);
}
export function terminate(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      try { child.kill(signal); } catch { /* Already gone. */ }
    }
  }
}
export interface ProcessResult { code: number | null; log: string; fullLog?: string; timedOut: boolean; error?: string }
interface CompilerOptions { compiler: string; cwd: string; output: string; main: string; timeoutMs: number; signal?: AbortSignal; onOutput?: (chunk: string) => void; onSpawn?: (child: ChildProcess) => void; resourceMirrorRoot?: string }
// Build jobs and independent submission verification share one engine slot.
let compilerSlot: Promise<void> = Promise.resolve();
export async function runCompiler(options: CompilerOptions): Promise<ProcessResult> {
  const previous = compilerSlot;
  let release!: () => void;
  compilerSlot = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const deadline=Date.now()+options.timeoutMs;
    let bundle: Awaited<ReturnType<typeof localResourceBundle>>;
    try{bundle=await localResourceBundle({compiler:options.compiler,mirrorRoot:options.resourceMirrorRoot,signal:options.signal,deadline});}catch{/* Cache adaptation is optional; normal Tectonic remains the fallback. */}
    const remaining=()=>Math.max(0,deadline-Date.now());
    if(options.signal?.aborted)return {code:null,log:'编译已取消。',timedOut:false,error:'编译已取消。'};
    if(!remaining())return {code:null,log:'编译准备超时。',timedOut:true};
    if(bundle)options.onOutput?.(`note: Using local cached resource bundle ${bundle.digest} ...\n`);
    const first=await runCompilerNow({...options,timeoutMs:remaining()},bundle?.directory);
    if(!bundle||first.code===0||first.timedOut||first.error||options.signal?.aborted||!missingCachedResource(first.log))return first;
    const notice='\nnote: Local resource cache miss; retrying with the standard network bundle ...\n';
    options.onOutput?.(notice);
    if(!remaining())return {...first,timedOut:true};
    // Discard partial artifacts before the retry; a failed attempt cannot leave
    // an old PDF that could be mistaken for the final attempt's output.
    await fs.rm(options.output,{recursive:true,force:true});
    const final=await runCompilerNow({...options,timeoutMs:remaining()});
    return {...final,fullLog:first.log+notice+final.log};
  } finally { release(); }
}
async function runCompilerNow(options: CompilerOptions, bundle?:string): Promise<ProcessResult> {
  await fs.mkdir(options.output, { recursive: true });
  if (options.signal?.aborted) return { code: null, log: '编译已取消。', timedOut: false, error: '编译已取消。' };
  return new Promise(resolve => {
    let log = '';
    let timedOut = false;
    let spawnError: string | undefined;
    const child = spawn(options.compiler, ['-X', 'compile', '--untrusted', ...(bundle?['--bundle',bundle]:[]), '--synctex', '--keep-logs', '--keep-intermediates', '--print', '--outdir', options.output, options.main], {
      cwd: options.cwd, env: { ...process.env, TECTONIC_UNTRUSTED_MODE: '1' }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    options.onSpawn?.(child);
    const output = (chunk: Buffer) => { const value = chunk.toString('utf8'); log = (log + value).slice(-262144); options.onOutput?.(value); };
    child.stdout?.on('data', output);
    child.stderr?.on('data', output);
    child.on('error', error => { spawnError = error.message; output(Buffer.from(`\n无法启动编译器：${error.message}\n`)); });
    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      output(Buffer.from('\n编译已取消。\n'));
      terminate(child);
      killTimer = setTimeout(() => terminate(child, 'SIGKILL'), 1000);
      killTimer.unref();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      output(Buffer.from(`\n编译超过 ${Math.round(options.timeoutMs / 1000)} 秒，已停止。\n`));
      terminate(child);
      killTimer = setTimeout(() => terminate(child, 'SIGKILL'), 1000);
      killTimer.unref();
    }, options.timeoutMs);
    timer.unref();
    child.on('close', code => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); options.signal?.removeEventListener('abort', abort); resolve({ code, log, timedOut, error: spawnError }); });
  });
}
