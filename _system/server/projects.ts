import fs from 'node:fs/promises';
import path from 'node:path';
import type { CompileTarget, DeadlineSource, Project, Stage } from '../shared/types.ts';
import { STAGES } from '../shared/types.ts';
import { validateDeadlineConfiguration, validLegacyDeadline } from '../shared/deadline.ts';
import { HttpError, assertNoSymlinks, projectId, relativePath, registeredRoot } from './security.ts';
import { readJson, withLock, writeJson, withProjectMutation } from './storage.ts';
import { checkpoint, history, initializeGit } from './history.ts';

export async function getProject(workspaceRoot: string, id: string): Promise<Project> { return readJson<Project>(path.join(await registeredRoot(workspaceRoot, id), 'project.json')); }
async function latestSourceChange(root:string,baseline:string):Promise<string>{
 let latest=Date.parse(baseline)||0;
 async function walk(directory:string){for(const entry of await fs.readdir(directory,{withFileTypes:true}).catch(()=>[])){if(entry.name.startsWith('.')||['build','submissions','node_modules'].includes(entry.name))continue;const file=path.join(directory,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())latest=Math.max(latest,(await fs.stat(file)).mtimeMs);}}
 for(const directory of ['manuscript','notes','reviews'])await walk(path.join(root,directory));return new Date(latest).toISOString();
}
export async function listProjects(workspaceRoot: string): Promise<Project[]> {
  const papers = path.join(workspaceRoot, 'papers'); await fs.mkdir(papers, { recursive: true });
  const projects: Project[] = [];
  for (const entry of await fs.readdir(papers, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(entry.name)) continue;
    try {
      const root = await registeredRoot(workspaceRoot, entry.name);
      const project = await getProject(workspaceRoot, entry.name);
      if (project.id !== entry.name) continue;
      await initializeGit(root);
      if (!(await history(root)).length) await checkpoint(root, '接入工作台：原始版本');
      project.lastEditedAt=await latestSourceChange(root,project.updatedAt);projects.push(project);
    } catch (error) { if ((error as HttpError).statusCode === 404 || error instanceof SyntaxError) continue; throw error; }
  }
  return projects.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
}
function stringValue(value: unknown, label: string, max = 1000): string {
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${label}无效。`);
  return value;
}
export function validateTargets(value: unknown): CompileTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) throw new HttpError(400, '请保留至少一个编译目标，最多 30 个。');
  const ids = new Set<string>();
  return value.map(target => {
    if (!target || typeof target !== 'object') throw new HttpError(400, '编译目标无效。');
    const id = projectId(target.id); if (ids.has(id)) throw new HttpError(400, '编译目标编号重复。'); ids.add(id);
    const main = relativePath(target.main);
    if (!main.endsWith('.tex') || main.split('/').some(p => p.startsWith('.')) || ['notes','literature','build','submissions'].includes(main.split('/')[0]) || main.split('/').length < 2) throw new HttpError(400, '主文件必须是项目内源码子目录中的 .tex 文件，不能使用笔记、文献、投稿快照或缓存目录。');
    if (main.startsWith('reviews/') && !/^reviews\/[^/]+\/response\/.+\.tex$/.test(main)) throw new HttpError(400, '审稿目标只能选择 reviews/轮次/response/ 内的回复文档，原始意见不能作为投稿源码。');
    return { id, label: stringValue(target.label, '目标名称', 100), main };
  });
}
function validateDeadlineSource(value: unknown): DeadlineSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '会议截止来源无效。');
  const data = value as Record<string, unknown>;
  const allowed = new Set(['sourceUrl','conferenceId','year','roundId','fetchedAt','officialUrl','notes']);
  if (Object.keys(data).some(key => !allowed.has(key))) throw new HttpError(400, '会议截止来源包含不支持的字段。');
  const sourceUrl = stringValue(data.sourceUrl,'来源地址',2000);
  let parsed: URL; try { parsed = new URL(sourceUrl); } catch { throw new HttpError(400, 'CCFDDL 来源地址无效。'); }
  if (parsed.protocol !== 'https:' || !['ccfddl.top','www.ccfddl.top'].includes(parsed.hostname) || parsed.port || parsed.username || parsed.password) throw new HttpError(400, '来源地址须为 https://ccfddl.top/。');
  const conferenceId = stringValue(data.conferenceId,'会议编号',100), roundId = stringValue(data.roundId,'投稿轮次',160), fetchedAt = stringValue(data.fetchedAt,'来源获取时间',80);
  if (!conferenceId.trim() || !roundId.trim() || typeof data.year !== 'number' || !Number.isSafeInteger(data.year) || data.year < 1970 || data.year > 9999 || !Number.isFinite(Date.parse(fetchedAt)) || new Date(fetchedAt).toISOString() !== fetchedAt) throw new HttpError(400, '会议编号、年份、轮次或来源时间无效。');
  const result: DeadlineSource = {sourceUrl:parsed.href,conferenceId,year:data.year,roundId,fetchedAt};
  if (data.officialUrl !== undefined) {
    const officialUrl=stringValue(data.officialUrl,'会议官网',2000);let website:URL;try{website=new URL(officialUrl);}catch{throw new HttpError(400,'会议官网地址无效。');}
    if(!['https:','http:'].includes(website.protocol)||website.username||website.password)throw new HttpError(400,'会议官网地址应为普通网页地址。');result.officialUrl=website.href;
  }
  if(data.notes!==undefined)result.notes=stringValue(data.notes,'截止来源说明',8000);
  return result;
}
export async function patchProject(workspaceRoot: string, id: string, patch: Partial<Project> & { expectedUpdatedAt?: string }): Promise<Project> {
  return withProjectMutation(path.join(workspaceRoot,'papers',id), () => withLock(`project:${id}`, async () => {
    const root = await registeredRoot(workspaceRoot, id); const current = await getProject(workspaceRoot, id);
    if (patch.expectedUpdatedAt !== undefined) {
      if (typeof patch.expectedUpdatedAt !== 'string' || patch.expectedUpdatedAt.length > 80) throw new HttpError(400, '项目设置版本无效。');
      if (patch.expectedUpdatedAt !== current.updatedAt) throw new HttpError(409, '项目设置已被其他窗口修改，当前表单已保留。请比较最新设置后重试。', {current});
    }
    const previousDeadlineAt = current.deadlineAt, previousTimezone = current.deadlineTimezone, previousVenue = current.venue;
    if (patch.title !== undefined) { current.title = stringValue(patch.title, '标题', 1000).trim(); if (!current.title) throw new HttpError(400, '标题不能为空。'); }
    if (patch.venue !== undefined) current.venue = stringValue(patch.venue, '会议或期刊', 200);
    try {
      if (patch.deadlineAt !== undefined || patch.deadlineTimezone !== undefined) {
        const at = patch.deadlineAt !== undefined ? patch.deadlineAt : current.deadlineAt;
        const zone = patch.deadlineTimezone !== undefined ? patch.deadlineTimezone : current.deadlineTimezone;
        const clearAt = patch.deadlineAt !== undefined && (patch.deadlineAt === '' || patch.deadlineAt === null), clearZone = patch.deadlineTimezone !== undefined && (patch.deadlineTimezone === '' || patch.deadlineTimezone === null);
        if (clearAt || clearZone) {
          if ((clearAt && patch.deadlineTimezone !== undefined && !clearZone) || (clearZone && patch.deadlineAt !== undefined && !clearAt)) throw new Error('清除截止时间时，请不要同时填写另一项截止配置。');
          delete current.deadlineAt; delete current.deadlineTimezone; delete current.deadlineSource; current.deadline = '';
        } else Object.assign(current, validateDeadlineConfiguration(at, zone));
      } else if (patch.deadline !== undefined) {
        const value = validLegacyDeadline(patch.deadline);
        if (value !== current.deadline) { delete current.deadlineAt; delete current.deadlineTimezone; delete current.deadlineSource; }
        current.deadline = value;
      }
    } catch (error) { throw new HttpError(400, (error as Error).message); }

    if (patch.deadlineSource !== undefined) {
      if (patch.deadlineSource === null || (patch.deadlineSource as unknown) === '') delete current.deadlineSource;
      else {
        if (!current.deadlineAt || !current.deadlineTimezone || !current.venue.trim()) throw new HttpError(400,'保存会议来源时须同时提供投稿目标与完整正文截止时间。');
        current.deadlineSource = validateDeadlineSource(patch.deadlineSource);
      }
    } else if (previousDeadlineAt !== current.deadlineAt || previousTimezone !== current.deadlineTimezone || previousVenue !== current.venue) delete current.deadlineSource;

    if (patch.stage !== undefined) { if (!STAGES.includes(patch.stage as Stage)) throw new HttpError(400, '文章阶段无效。'); current.stage = patch.stage; }
    for(const key of ['archived','trashed'] as const)if(patch[key]!==undefined){if(typeof patch[key]!=='boolean')throw new HttpError(400,'项目管理状态无效。');current[key]=patch[key];}
    if (patch.autoCompile !== undefined) { if (typeof patch.autoCompile !== 'boolean') throw new HttpError(400, '自动编译设置无效。'); current.autoCompile = patch.autoCompile; }
    if (patch.targets !== undefined) { current.targets = validateTargets(patch.targets); for (const target of current.targets) await assertNoSymlinks(root, target.main, true); }
    current.updatedAt = new Date(Math.max(Date.now(), Number.isFinite(Date.parse(current.updatedAt)) ? Date.parse(current.updatedAt) + 1 : 0)).toISOString(); await writeJson(path.join(root, 'project.json'), current); return current;
  }));
}
export async function appendTarget(workspaceRoot: string, id: string, target: CompileTarget): Promise<void> {
  await withLock(`project:${id}`, async () => {
    const root = await registeredRoot(workspaceRoot,id); const project = await getProject(workspaceRoot,id);
    project.targets = validateTargets([...project.targets,target]);
    await assertNoSymlinks(root,target.main,true);
    project.updatedAt = new Date(Math.max(Date.now(), Number.isFinite(Date.parse(project.updatedAt)) ? Date.parse(project.updatedAt) + 1 : 0)).toISOString(); await writeJson(path.join(root,'project.json'),project);
  });
}
async function safeCopy(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['build','submissions','node_modules'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new HttpError(400, '导入目录含符号链接，请先移除链接或复制实际文件。');
    if (entry.isDirectory()) await safeCopy(path.join(source, entry.name), path.join(destination, entry.name));
    else if (entry.isFile()) await fs.copyFile(path.join(source, entry.name), path.join(destination, entry.name));
  }
}
async function findMain(root: string): Promise<string> {
  try { if ((await fs.stat(path.join(root, 'main.tex'))).isFile()) return 'main.tex'; } catch { /* Search nested source directories. */ }
  const found: string[] = [];
  async function walk(dir: string, prefix = '') { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const rel = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel); else if (entry.name === 'main.tex') found.push(rel); } }
  await walk(root); if (found.length !== 1) throw new HttpError(400, found.length ? '导入目录中有多个 main.tex，请选择更具体的源码目录。' : '导入目录中没有 main.tex。'); return found[0];
}
export async function createProject(workspaceRoot: string, body: { id?: string; title?: string; template?: string; importPath?: string }, imported?:{source:string;main:string;beforePublish?:(root:string)=>Promise<void>}): Promise<Project> {
  const id = projectId(body.id); const title = stringValue(body.title, '标题').trim(); if (!title) throw new HttpError(400, '请输入文章标题。');
  return withLock(`create:${id}`, async () => {
    const papers = path.join(workspaceRoot, 'papers'); await fs.mkdir(papers, { recursive: true }); await assertNoSymlinks(workspaceRoot, 'papers');
    const finalRoot = path.join(papers, id); if (await fs.lstat(finalRoot).then(() => true).catch(() => false)) throw new HttpError(409, '项目编号已存在。');
    let source: string;
    if(imported){source=imported.source;await assertNoSymlinks(source);}else if (body.importPath) {
      source = path.resolve(workspaceRoot, stringValue(body.importPath, '导入目录', 2000));
      const rel = path.relative(workspaceRoot, source).split(path.sep).join('/');
      if (!rel || rel.startsWith('../') || path.isAbsolute(rel) || ['papers','_system','archive','shared'].includes(rel.split('/')[0])) throw new HttpError(400, '请将待导入源码放在工作台根目录下的独立目录中，不能导入系统、归档或已有项目。');
      await assertNoSymlinks(workspaceRoot, rel); if (!(await fs.stat(source)).isDirectory()) throw new HttpError(400, '请选择源码目录。');
    } else {
      const template = body.template ?? 'english'; if (!['english','chinese','empty'].includes(template)) throw new HttpError(400, '模板无效。');
      source = path.join(workspaceRoot, 'shared', 'templates', template);
    }
    let created = false;const root=await fs.mkdtemp(path.join(papers,'.create-'));
    try {
      created = true;
      for (const folder of ['manuscript','notes','literature','reviews','submissions','build']) await fs.mkdir(path.join(root, folder), { recursive: true });
      await safeCopy(source, path.join(root, 'manuscript')); const main = imported?relativePath(imported.main):await findMain(path.join(root, 'manuscript'));await assertNoSymlinks(root,`manuscript/${main}`);
      const now = new Date().toISOString(); const result: Project = { schemaVersion: 1, id, title, stage: 'writing', venue: '', deadline: '', targets: [{ id: 'main', label: '主论文', main: `manuscript/${main}` }], autoCompile: false, createdAt: now, updatedAt: now };
      await writeJson(path.join(root, 'project.json'), result);
      await fs.writeFile(path.join(root, 'notes', 'writing.md'), '# 写作记录\n\n在这里记录目标、待办、证据和本轮修改。\n');
      await imported?.beforePublish?.(root);
      await checkpoint(root, imported?'导入 ZIP 源码（原始包已备份）':body.importPath ? '导入本地源码（原目录保留）' : '从模板创建论文');if(await fs.lstat(finalRoot).then(()=>true).catch(()=>false))throw new HttpError(409,'项目编号已存在。');await fs.rename(root,finalRoot);created=false;return result;
    } catch (error) { if (created) await fs.rm(root, { recursive: true, force: true }); throw error; }
  });
}
