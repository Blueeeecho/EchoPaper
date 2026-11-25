import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { configuredResourceBundle } from '../server/local-resource-bundle.ts';
import { gitExecutable, pythonExecutable, tectonicExecutable } from '../server/platform.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const report = { root, node: process.version, git: null, python: null, compiler: null, agents:null, projects: [], errors: [] };
try {const {checkAgentRuntime}=await import('./agent-runtime.mjs');checkAgentRuntime();report.agents={runtime:'LangGraph JS',checkpoint:'SQLite',nativeAddon:true};}catch(error){report.errors.push(`AI 任务运行时不可用：${error.message}`);}
try {const bundle=await configuredResourceBundle();if(bundle)report.compilerBundle=bundle;}catch(error){report.errors.push(error.message);}
for (const [field, label, executable] of [
  ['git', 'Git（论文列表和项目需要）', gitExecutable()],
  ['python', 'Python 3', pythonExecutable()],
  ['compiler', 'Tectonic（仅编译需要）', tectonicExecutable()],
]) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (result.status === 0) report[field] = (result.stdout || result.stderr).trim();
  else report.errors.push(`无法运行 ${label}：${executable}`);
}
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
