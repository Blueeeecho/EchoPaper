import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const report = { root, node: process.version, compiler: null, agents:null, projects: [], errors: [] };
try {const {SqliteSaver}=await import('@langchain/langgraph-checkpoint-sqlite');const {StateGraph}=await import('@langchain/langgraph');const saver=SqliteSaver.fromConnString(':memory:');saver.db.prepare('SELECT 1').get();saver.db.close();if(typeof StateGraph!=='function')throw Error('LangGraph unavailable');report.agents={runtime:'LangGraph JS',checkpoint:'SQLite',nativeAddon:true};}catch(error){report.errors.push(`AI 任务运行时不可用：${error.message}`);}
function findTectonic() {
  if (process.env.TECTONIC_PATH) return process.env.TECTONIC_PATH;
  const bin = process.platform === 'win32' ? 'tectonic.exe' : 'tectonic';
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  const extra = process.platform === 'win32'
    ? [
        path.join(os.homedir(), '.cargo', 'bin', 'tectonic.exe'),
        ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'tectonic', 'tectonic.exe')] : []),
        path.join(os.homedir(), 'scoop', 'shims', 'tectonic.exe'),
      ]
    : ['/opt/homebrew/bin/tectonic', '/usr/local/bin/tectonic', path.join(os.homedir(), '.cargo/bin/tectonic')];
  for (const candidate of extra) {
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === 'darwin' ? '/opt/homebrew/bin/tectonic' : bin;
}
const compilerBin = findTectonic();
const compiler = spawnSync(compilerBin, ['--version'], { encoding: 'utf8' });
if (compiler.status === 0) report.compiler = compiler.stdout.trim();
else report.errors.push(`未找到 ${compilerBin}`);
for (const item of await fs.readdir(path.join(root, 'papers'), { withFileTypes: true })) {
  if (!item.isDirectory() || item.name.startsWith('.')) continue;
  try {
    const directory = path.join(root, 'papers', item.name);
    const project = JSON.parse(await fs.readFile(path.join(directory, 'project.json'), 'utf8'));
    const checked = [];
    for (const target of project.targets) {
      const main = path.resolve(directory, target.main);
      const inside = process.platform === 'win32'
        ? main.toLowerCase().startsWith((directory + path.sep).toLowerCase())
        : main.startsWith(directory + path.sep);
      if (!inside) throw new Error('编译入口越出项目目录');
      await fs.access(main);
      checked.push({ id: target.id, main: target.main });
    }
    report.projects.push({ id: project.id, targets: checked });
  } catch (error) { report.errors.push(`${item.name}: ${error.message}`); }
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.errors.length ? 1 : 0;
