import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { findWorkspaceInstance, portReleased, probeWorkspacePort, requestGracefulStop, sameWorkspacePath, waitForPortRelease, WORKBENCH_PORTS } from './graceful-stop.mjs';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13) || nodeMajor > 26) {
  console.error('EchoPaper 需要 Node.js 22.13 至 26.x，建议使用 22.x 或 24.x；当前版本为 ' + process.version + '。');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const system = path.join(root, '_system');
const runtime = path.join(system, 'runtime');
const stateFile = path.join(runtime, 'instance.json');
await fs.mkdir(runtime, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function health(port) {
  const found = await probeWorkspacePort(port, root);
  return found ? found.health : null;
}
async function state() {
  try {
    const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    return sameWorkspacePath(saved?.root, root) && Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535 ? saved : null;
  } catch { return null; }
}
async function freePort(savedPort) {
  // Recover an already running instance even if its runtime state file was lost.
  const running = await findWorkspaceInstance(root, { preferredPort: savedPort });
  if (running) return { port: running.port, running: true, info: running.health };
  if (savedPort) await waitForPortRelease(savedPort);
  for (const port of WORKBENCH_PORTS) {
    if (await portReleased(port)) return { port, running: false };
  }
  throw new Error('4173–4203 端口均被占用，请关闭一个无关服务后重试。');
}
async function newestMtime(target) {
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.mtimeMs;
  let max = stat.mtimeMs;
  for (const entry of await fs.readdir(target, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.')) continue;
    const child = await newestMtime(path.join(target, entry.name));
    if (child > max) max = child;
  }
  return max;
}
async function distStale() {
  const indexStat = await fs.stat(path.join(system, 'dist/index.html')).catch(() => null);
  if (!indexStat) return true;
  const sourceTimes = await Promise.all([
    newestMtime(path.join(system, 'src')),
    newestMtime(path.join(system, 'shared')),
    newestMtime(path.join(system, 'index.html')),
  ]);
  return Math.max(...sourceTimes) > indexStat.mtimeMs;
}
function openBrowser(port) {
  const url = `http://127.0.0.1:${port}`;
  if (!process.argv.includes('--no-open')) {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }
  console.log(`EchoPaper 已启动：${url}`);
}
function runNpm(args) {
  if (process.platform === 'win32') {
    return spawnSync('npm.cmd', args, { cwd: system, stdio: 'inherit', shell: true });
  }
  return spawnSync('npm', args, { cwd: system, stdio: 'inherit' });
}
async function dependenciesReady() {
  for (const dependency of ['tsx', '@langchain/langgraph', '@langchain/langgraph-checkpoint-sqlite', 'better-sqlite3']) {
    try { await fs.access(path.join(system, 'node_modules', dependency)); }
    catch { return false; }
  }
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', "import { checkAgentRuntime } from './scripts/agent-runtime.mjs'; checkAgentRuntime();"], { cwd: system, stdio: 'ignore' });
  return probe.status === 0;
}
async function start() {
  const saved = await state();
  const existing = saved && await health(saved.port);
  if (existing) return openBrowser(saved.port);
  if (!await dependenciesReady()) {
    console.log('正在安装当前平台依赖（首次运行或跨系统迁移需要联网）…');
    const installed = runNpm(['ci', '--no-audit', '--no-fund']);
    if (installed.status !== 0) throw new Error('依赖安装失败，详见上方输出。');
    if (!await dependenciesReady()) throw new Error('依赖已安装，但 AI 任务的 SQLite 运行时仍不可用。请运行诊断查看详情。');
  }
  if (await distStale()) {
    const built = runNpm(['run', 'build']);
    if (built.status !== 0) throw new Error('网页构建失败，请查看构建输出。');
  }
  const slot = await freePort(saved?.port);
  if (slot.running) {
    const info = slot.info ?? await health(slot.port);
    await fs.writeFile(stateFile, JSON.stringify({ pid: info.pid, port: slot.port, root }, null, 2));
    return openBrowser(slot.port);
  }
  const logPath = path.join(runtime, 'server.log');
  const logStat = await fs.stat(logPath).catch(() => null);
  if (logStat && logStat.size > 5 * 1024 * 1024) {
    await fs.rename(logPath, `${logPath}.old`).catch(() => {});
  }
  const logfile = await fs.open(logPath, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: system, detached: true, windowsHide: true, stdio: ['ignore', logfile.fd, logfile.fd],
    env: { ...process.env, WORKBENCH_ROOT: root, WORKBENCH_PORT: String(slot.port) },
  });
  let earlyExit = null;
  child.once('exit', (code, signal) => { earlyExit = code ?? signal ?? 1; });
  child.unref();
  await logfile.close();
  for (let count = 0; count < 150; count++) {
    if (earlyExit !== null) break;
    const info = await health(slot.port);
    if (info) {
      await fs.writeFile(stateFile, JSON.stringify({ pid: info.pid, port: slot.port, root }, null, 2));
      return openBrowser(slot.port);
    }
    await pause(100);
  }
  throw new Error(`服务未能启动，请查看 ${logPath}`);
}
async function stop() {
  const current = await state();
  const discovered = await findWorkspaceInstance(root, { preferredPort: current?.port });
  const saved = discovered ?? current;
  if (!saved) { console.log('EchoPaper 当前未运行。'); return; }
  if (discovered && await health(saved.port)) {
    await requestGracefulStop(saved.port);
    for (let count = 0; count < 200 && await health(saved.port); count++) await pause(100);
    if (await health(saved.port)) throw new Error('后台尚未完成正常退出；保留运行记录，未强制终止，也未启动新后台。');
  }
  await waitForPortRelease(saved.port);
  await fs.rm(stateFile, { force: true });
  console.log('EchoPaper 后台已停止，稿件和历史记录保存在本地。');
}
try {
  if (process.argv[2] === 'stop') await stop();
  else if (process.argv[2] === 'restart') { await stop(); await start(); }
  else await start();
} catch (error) { console.error(error.message); process.exitCode = 1; }
