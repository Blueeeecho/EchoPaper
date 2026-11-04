import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const report = { root, node: process.version, compiler: null, agents:null, projects: [], errors: [] };
try {const {SqliteSaver}=await import('@langchain/langgraph-checkpoint-sqlite');const {StateGraph}=await import('@langchain/langgraph');const saver=SqliteSaver.fromConnString(':memory:');saver.db.prepare('SELECT 1').get();saver.db.close();if(typeof StateGraph!=='function')throw Error('LangGraph unavailable');report.agents={runtime:'LangGraph JS',checkpoint:'SQLite',nativeAddon:true};}catch(error){report.errors.push(`AI 任务运行时不可用：${error.message}`);}
const compilerPath = process.env.TECTONIC_PATH || '/opt/homebrew/bin/tectonic';
const compiler = spawnSync(compilerPath, ['--version'], { encoding: 'utf8' });
if (compiler.status === 0) report.compiler = compiler.stdout.trim();
else report.errors.push('未找到 Tectonic：' + compilerPath);
for (const item of await fs.readdir(path.join(root, 'papers'), { withFileTypes: true })) {
  if (!item.isDirectory() || item.name.startsWith('.')) continue;
  try {
    const directory = path.join(root, 'papers', item.name);
    const project = JSON.parse(await fs.readFile(path.join(directory, 'project.json'), 'utf8'));
    const checked = [];
    for (const target of project.targets) {
      const main = path.resolve(directory, target.main);
      if (!main.startsWith(directory + path.sep)) throw new Error('编译入口越出项目目录');
      await fs.access(main);
      checked.push({ id: target.id, main: target.main });
    }
    report.projects.push({ id: project.id, targets: checked });
  } catch (error) { report.errors.push(`${item.name}: ${error.message}`); }
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.errors.length ? 1 : 0;
