import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const system = path.join(root, '_system');
const runtime = path.join(system, 'runtime');
const stateFile = path.join(runtime, 'instance.json');
await fs.mkdir(runtime, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    const data = await response.json();
    return response.ok && data.workspaceRoot === root ? data : null;
  } catch { return null; }
}
async function state() {
  try { return JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch { return null; }
}
async function freePort() {
  // Recover an already running instance even if its runtime state file was lost.
  for (let port = 4173; port < 4204; port++) {
    if (await health(port)) return { port, running: true };
  }
  for (let port = 4173; port < 4204; port++) {
    const free = await new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return { port, running: false };
  }
  throw new Error('4173–4203 端口均被占用，请关闭一个无关服务后重试。');
}
function openBrowser(port) {
  const url = `http://127.0.0.1:${port}`;
  if (!process.argv.includes('--no-open')) {
    const child = spawn('open', [url], { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }
  console.log(`EchoPaper 已启动：${url}`);
}
async function start() {
  const saved = await state();
  const existing = saved && await health(saved.port);
  if (existing) return openBrowser(saved.port);
  try { for(const dependency of ['tsx','@langchain/langgraph','@langchain/langgraph-checkpoint-sqlite'])await fs.access(path.join(system, 'node_modules',dependency)); }
  catch {
    console.log('正在安装网页依赖（首次运行需要联网）…');
    const installed = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: system, stdio: 'inherit' });
    if (installed.status !== 0) throw new Error('依赖安装失败，详见上方输出。');
  }
  const sqliteCheck=spawnSync(process.execPath,['--input-type=module','-e',"import {SqliteSaver} from '@langchain/langgraph-checkpoint-sqlite';const saver=SqliteSaver.fromConnString(':memory:');saver.db.prepare('SELECT 1').get();saver.db.close();"],{cwd:system,encoding:'utf8'});
  if(sqliteCheck.status!==0)throw new Error('AI 任务 SQLite 运行时无法加载，请在 _system 中使用当前 Node 执行 npm ci 后重试。稿件未修改。');
  try { await fs.access(path.join(system, 'dist/index.html')); }
  catch {
    const built = spawnSync('npm', ['run', 'build'], { cwd: system, stdio: 'inherit' });
    if (built.status !== 0) throw new Error('网页构建失败，请查看构建输出。');
  }
  const slot = await freePort();
  if (slot.running) {
    const info = await health(slot.port);
    await fs.writeFile(stateFile, JSON.stringify({ pid: info.pid, port: slot.port, root }, null, 2));
    return openBrowser(slot.port);
  }
  const logfile = await fs.open(path.join(runtime, 'server.log'), 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: system, detached: true, stdio: ['ignore', logfile.fd, logfile.fd],
    env: { ...process.env, WORKBENCH_ROOT: root, WORKBENCH_PORT: String(slot.port) },
  });
  child.unref();
  await logfile.close();
  for (let count = 0; count < 150; count++) {
    const info = await health(slot.port);
    if (info) {
      await fs.writeFile(stateFile, JSON.stringify({ pid: info.pid, port: slot.port, root }, null, 2));
      return openBrowser(slot.port);
    }
    await pause(100);
  }
  throw new Error(`服务未能启动，请查看 ${path.join(runtime, 'server.log')}`);
}
async function stop() {
  const saved = await state();
  if (!saved) { console.log('EchoPaper 当前未运行。'); return; }
  const info = await health(saved.port);
  if (info) {
    try {
      const response = await fetch(`http://127.0.0.1:${saved.port}/api/shutdown`, { method: 'POST' });
      if (!response.ok) process.kill(info.pid, 'SIGTERM');
    } catch { try { process.kill(info.pid, 'SIGTERM'); } catch {} }
    for (let count = 0; count < 50 && await health(saved.port); count++) await pause(100);
  }
  await fs.rm(stateFile, { force: true });
  console.log('EchoPaper 后台已停止，稿件和历史记录保存在本地。');
}
try {
  if (process.argv[2] === 'stop') await stop();
  else if (process.argv[2] === 'restart') { await stop(); await start(); }
  else await start();
} catch (error) { console.error(error.message); process.exitCode = 1; }
