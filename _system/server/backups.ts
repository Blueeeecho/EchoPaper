import fs from 'node:fs/promises';
import{registryPath,normalizeRegistry}from'./model-providers';
import {workspaceMaintenance} from './agents/maintenance';
import { createReadStream } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { BuildService, EmitEvent } from '../shared/types.ts';
import type { BackupFile, BackupManifest, BackupSummary, RestorePreview, RestoreResult } from '../shared/backup-types.ts';
import { HttpError, assertNoSymlinks, relativePath } from './security.ts';
import { atomicWrite, hash, readJson, withLock, writeJson } from './storage.ts';

const run = promisify(execFile);
const archiveHelper = fileURLToPath(new URL('../scripts/backup-archive.py', import.meta.url));
const legacyRoots = ['papers','shared','archive'];
const roots = [...legacyRoots,'workspace'];
const settingsPath = '_system/runtime/ai-settings.json';
const maximumBytes = 4 * 1024 ** 3, maximumFiles = 100000;
const comparePath = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const scope = ['papers/（含 Git、正文、批注、对话、投稿与编译记录）','shared/（含版本化 PPT 风格包）','archive/','workspace/（课题、目录连接、标签、关联、整理日志与 PPT 工程）','非密钥 AI 模型设置','外部连接目录原件与该目录回收站不包含在此备份中'];
interface Scan { files: BackupFile[]; directories: string[]; fingerprint: string; settings?: string; providerSettings?:string }
interface RestoreJournal { phase: 'moving' | 'committed'; previous: string; stage: string; targets: {path: string; oldExisted: boolean}[] }
const journalPath = '_system/runtime/restore-transaction.json';
// SHM is SQLite's rebuildable WAL index, and checkpoint mutates it even when no
// task data changes. A zero-length WAL also contains no durable records. Keep
// nonempty WALs: ignoring those could hide an uncheckpointed external writer.
const transientAgentSqliteFile = (file:Pick<BackupFile,'path'|'size'>) => /^papers\/[^/]+\/\.workbench\/agent-state\.sqlite-shm$/.test(file.path)
  || file.size===0 && /^papers\/[^/]+\/\.workbench\/agent-state\.sqlite-wal$/.test(file.path);
const comparableFiles = (files:BackupFile[]) => files.filter(file=>!transientAgentSqliteFile(file));
const presentationStylesPath='shared/presentation-styles';
const atOrBelow=(relative:string,base:string)=>relative===base||relative.startsWith(base+'/');
const legacyArchive=(manifest:BackupManifest)=>!manifest.directories.includes('workspace');
// Legacy restore retains these current subtrees as a whole, including their
// absence. Preview and installation must use this same ownership rule.
const retainedLegacyPath=(relative:string)=>atOrBelow(relative,'workspace')||atOrBelow(relative,presentationStylesPath);
function effectiveRestoreFiles(manifest:BackupManifest,current:Scan):BackupFile[]{
  const files=comparableFiles(manifest.files);
  return legacyArchive(manifest)?[...files.filter(file=>!retainedLegacyPath(file.path)),...current.files.filter(file=>retainedLegacyPath(file.path))]:files;
}
/** Recover an interrupted directory switch before the build service reads project state. */
export async function recoverPendingRestore(workspaceRoot: string): Promise<void> {
  const filename = await assertNoSymlinks(workspaceRoot, journalPath, true);
  let journal: RestoreJournal;
  try { if ((await fs.stat(filename)).size > 32768) throw new Error('journal too large'); journal = await readJson<RestoreJournal>(filename); }
  catch(error) { if((error as NodeJS.ErrnoException).code === 'ENOENT')return; throw new HttpError(409,'恢复事务记录损坏，请保留工作区并检查恢复记录。'); }
  const validTargets=[...([legacyRoots,roots].flatMap(base=>[[...base,settingsPath],[...base,settingsPath,registryPath]]))];
  const names=journal?.targets?.map(t=>t?.path);
  if(!journal || !['moving','committed'].includes(journal.phase) || typeof journal.previous !== 'string' || !/^backups\/before-restore-[0-9]+-[a-f0-9-]{36}$/.test(journal.previous) || typeof journal.stage !== 'string' || !/^backups\/\.restore-[A-Za-z0-9]+$/.test(journal.stage) || !Array.isArray(journal.targets) || !validTargets.some(candidate=>JSON.stringify(candidate)===JSON.stringify(names)) || journal.targets.some(t=>!t||typeof t.oldExisted!=='boolean'))throw new HttpError(409,'恢复事务记录路径无效；未改动当前内容。');
  const previous=await assertNoSymlinks(workspaceRoot,journal.previous),stage=await assertNoSymlinks(workspaceRoot,journal.stage,true);
  if(journal.phase==='moving')for(const entry of [...journal.targets].reverse()) {
    const target=await assertNoSymlinks(workspaceRoot,entry.path,true),old=await assertNoSymlinks(previous,entry.path,true);
    const oldPresent=await fs.lstat(old).then(()=>true).catch(e=>{if(e.code==='ENOENT')return false;throw e;});
    if(oldPresent||!entry.oldExisted) {
      if(await fs.lstat(target).then(()=>true).catch(e=>{if(e.code==='ENOENT')return false;throw e;})) {
        const recovered=path.join(previous,'recovered-partial',entry.path);await fs.mkdir(path.dirname(recovered),{recursive:true,mode:0o700});await fs.rename(target,recovered);
      }
      if(oldPresent){await fs.mkdir(path.dirname(target),{recursive:true});await fs.rename(old,target);}
    }
  }
  await fs.rm(filename,{force:true});await fs.rm(stage,{recursive:true,force:true}).catch(()=>{});
}
const fingerprint = (files: BackupFile[], directories: string[]) => hash(JSON.stringify({ files, directories }));
const backupId = (value: unknown) => { if (typeof value !== 'string' || !/^backup-[0-9]+-[a-f0-9-]{36}$/.test(value)) throw new HttpError(400,'备份编号无效。'); return value; };
async function fileHash(filename: string) { const digest=createHash('sha256'); for await (const bytes of createReadStream(filename)) digest.update(bytes); return digest.digest('hex'); }
function allowed(value:string, directory=false) {
  const p=relativePath(value);
  if(p.split('/').some(part=>part.includes(':')||/[\x00-\x1f]/.test(part)))throw new HttpError(400,'备份文件名无效。');
  if (!roots.includes(p.split('/')[0]) && p!==settingsPath && p!==registryPath && !(directory&&['_system','_system/runtime'].includes(p))) throw new HttpError(400,'备份包含范围外文件。');
  return p;
}
async function scan(root:string,selectedRoots:readonly string[]=roots):Promise<Scan> {
  const files:BackupFile[]=[], directories:string[]=[];let total=0;
  async function walk(relative:string) {
    const folder=await assertNoSymlinks(root,relative,true);
    const stat=await fs.lstat(folder).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!stat)return;
    if(!stat.isDirectory())throw new HttpError(409,'备份范围内的目录结构无效。');
    if(directories.length>=maximumFiles)throw new HttpError(413,'备份目录数超过 10 万上限。');
    directories.push(relative);
    for(const entry of (await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>comparePath(a.name,b.name))) {
      if(entry.name==='.DS_Store'||/^\..*\.tmp$/.test(entry.name))continue;
      const rel=allowed(`${relative}/${entry.name}`), filename=await assertNoSymlinks(root,rel);
      const item=await fs.lstat(filename);
      if(item.isDirectory())await walk(rel);
      else if(item.isFile()) {
        if(transientAgentSqliteFile({path:rel,size:item.size}))continue;
        total+=item.size;if(files.length>=maximumFiles||item.size>2*1024**3||total>maximumBytes)throw new HttpError(413,'工作区超过备份上限（10 万文件、单文件 2 GB、合计 4 GB）。');
        files.push({path:rel,size:item.size,mode:item.mode&0o777,sha256:await fileHash(filename)});
      } else throw new HttpError(403,'备份不支持符号链接或特殊设备文件。');
    }
  }
  for(const relative of selectedRoots)await walk(relative);
  let settings:string|undefined;
  try {
    const filename=await assertNoSymlinks(root,settingsPath);const raw=await readJson<{defaultModel?:unknown}>(filename);
    if(raw&&typeof raw.defaultModel==='string'&&raw.defaultModel.length<=100) {
      settings=JSON.stringify({defaultModel:raw.defaultModel})+'\n';
      files.push({path:settingsPath,size:Buffer.byteLength(settings),mode:0o600,sha256:hash(settings)});directories.push('_system','_system/runtime');
    }
  } catch(error) { if((error as HttpError).statusCode!==404)throw error; }
  let providerSettings:string|undefined;
  try{const filename=await assertNoSymlinks(root,registryPath);if((await fs.stat(filename)).size>2*1024*1024)throw new HttpError(413,'模型配置超过备份上限。');providerSettings=JSON.stringify(normalizeRegistry(await readJson(filename),settings?JSON.parse(settings).defaultModel:undefined,{allowMissingCoordinator:true}))+'\n';files.push({path:registryPath,size:Buffer.byteLength(providerSettings),mode:0o600,sha256:hash(providerSettings)});if(!directories.includes('_system'))directories.push('_system','_system/runtime');}catch(error){if((error as HttpError).statusCode!==404)throw error;}
  files.sort((a,b)=>comparePath(a.path,b.path));directories.sort((a,b)=>comparePath(a,b));
  return {files,directories,fingerprint:fingerprint(files,directories),settings,providerSettings};
}
function summary(manifest:BackupManifest,size:number):BackupSummary { return {id:manifest.id,createdAt:manifest.createdAt,label:manifest.label,size,fileCount:manifest.files.length,totalBytes:manifest.files.reduce((n,f)=>n+f.size,0),sourceFingerprint:manifest.sourceFingerprint}; }
function checkManifest(m:BackupManifest,id:string) {
  if(!m||m.schemaVersion!==1||m.id!==id||typeof m.createdAt!=='string'||!Number.isFinite(Date.parse(m.createdAt))||typeof m.label!=='string'||m.label.length>200||!Array.isArray(m.files)||!Array.isArray(m.directories)||m.files.length>maximumFiles||m.directories.length>maximumFiles)throw new HttpError(400,'备份清单无效。');
  for(const f of m.files)if(!f||allowed(f.path)!==f.path||!Number.isSafeInteger(f.mode)||f.mode<0||f.mode>0o777||!Number.isSafeInteger(f.size)||f.size<0||typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256))throw new HttpError(400,'备份清单中的文件无效。');
  for(const d of m.directories)allowed(d,true);
  const files=[...m.files].sort((a,b)=>comparePath(a.path,b.path)),dirs=[...m.directories].sort((a,b)=>comparePath(a,b));
  if(fingerprint(files,dirs)!==m.sourceFingerprint)throw new HttpError(400,'备份清单指纹不匹配。');
}
export async function registerBackupRoutes(app:FastifyInstance,workspaceRoot:string,builds:BuildService,emit:EmitEvent,agentOptions:{agentsBusy?:()=>boolean;prepareAgentBackup?:()=>Promise<void>;afterWorkspaceRestore?:()=>Promise<void>}={}) {
  const directory=await assertNoSymlinks(workspaceRoot,'backups',true);await fs.mkdir(directory,{recursive:true,mode:0o700});await assertNoSymlinks(workspaceRoot,'backups');
  let restoring=false, maintenance=false, activeMutations=0, restartScheduled=false;
  const taskMaintenance=workspaceMaintenance(workspaceRoot);
  const counted=new WeakSet<object>();
  app.addHook('onRequest',async(request,reply)=>{
    if(!request.url.startsWith('/api/'))return;
    const restart=request.url.split('?')[0]==='/api/workspace/restart',shutdown=request.url.split('?')[0]==='/api/shutdown';
    if((restoring||maintenance||taskMaintenance.isLocked())&&!['/api/health','/api/shutdown'].includes(request.url.split('?')[0])&&!restart&&!request.url.startsWith('/api/backups'))return reply.code(503).send({error:'工作区正在恢复或等待重启，已暂时停止读写。',maintenance:true});
    if(!['GET','HEAD','OPTIONS'].includes(request.method)&&!request.url.startsWith('/api/backups')&&!restart&&!shutdown){if(restoring||maintenance)return reply.code(503).send({error:'工作区正在恢复，已暂时停止写入。'});activeMutations++;counted.add(request);}
  });
  app.addHook('onResponse',async request=>{if(counted.has(request)){activeMutations--;counted.delete(request);}});
  async function busyBuild() {
    if(agentOptions.agentsBusy?.())throw new HttpError(409,'存在正在执行的 AI 任务，请等待结束或停止后再备份或恢复。');
    await agentOptions.prepareAgentBackup?.();
    const papers=await assertNoSymlinks(workspaceRoot,'papers',true);const entries=await fs.readdir(papers,{withFileTypes:true}).catch(()=>[]);
    for(const entry of entries)if(entry.isDirectory()&&!entry.isSymbolicLink()&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(entry.name)) {
      const list=await builds.list(entry.name).catch(()=>[]);if(list.some(b=>b.status==='running'||b.status==='queued'))throw new HttpError(409,'存在正在编译或排队的任务，请等待完成后再备份或恢复。');
    }
  }
  async function createBackup(label:string):Promise<BackupSummary> {
    if(activeMutations)throw new HttpError(409,'存在尚未完成的保存或任务创建请求，请稍后重试。');
    await busyBuild();
    const before=await scan(workspaceRoot), id=`backup-${Date.now()}-${randomUUID()}`;
    const stage=await fs.mkdtemp(path.join(directory,'.create-')), zip=path.join(directory,`${id}.zip`);
    try {
      for(const d of before.directories)await fs.mkdir(path.join(stage,d),{recursive:true,mode:0o700});
      for(const f of before.files) {
        const destination=path.join(stage,f.path);await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
        if(f.path===settingsPath)await fs.writeFile(destination,before.settings!,{mode:0o600});
        else if(f.path===registryPath)await fs.writeFile(destination,before.providerSettings!,{mode:0o600});
        else {const source=await assertNoSymlinks(workspaceRoot,f.path);await fs.copyFile(source,destination);await fs.chmod(destination,f.mode);}
        if(await fileHash(destination)!==f.sha256)throw new HttpError(409,'文件在备份过程中发生变化，请稍后重试。');
      }
      if((await scan(workspaceRoot)).fingerprint!==before.fingerprint)throw new HttpError(409,'工作区在备份过程中发生变化，请保存后重试。');
      const manifest:BackupManifest={schemaVersion:1,id,createdAt:new Date().toISOString(),label,files:before.files,directories:before.directories,sourceFingerprint:before.fingerprint,scope};
      await writeJson(path.join(stage,'manifest.json'),manifest);
      await run('/usr/bin/python3',[archiveHelper,'create',stage,zip],{timeout:300000,maxBuffer:16*1024*1024});await fs.chmod(zip,0o600);
      const result=summary(manifest,(await fs.stat(zip)).size);await writeJson(path.join(directory,`${id}.json`),result);return result;
    } catch(error) {await fs.rm(zip,{force:true}).catch(()=>{});throw error;}
    finally {await fs.rm(stage,{recursive:true,force:true}).catch(()=>{});}
  }
  async function verified(idValue:string):Promise<{manifest:BackupManifest;zip:string;backup:BackupSummary}> {
    const id=backupId(idValue),zip=await assertNoSymlinks(workspaceRoot,`backups/${id}.zip`);const stat=await fs.stat(zip);if(!stat.isFile()||stat.size>maximumBytes)throw new HttpError(413,'备份文件无效或过大。');
    let m:BackupManifest;
    try {const result=await run('/usr/bin/python3',[archiveHelper,'verify',zip],{timeout:300000,maxBuffer:32*1024*1024});m=JSON.parse(result.stdout);}catch{throw new HttpError(400,'备份包校验失败：路径、文件类型、清单或 SHA256 不匹配。原文件未修改。');}
    checkManifest(m,id);return {manifest:m,zip,backup:summary(m,stat.size)};
  }
  app.get('/api/backups',async()=>{
    const list:BackupSummary[]=[];
    for(const name of await fs.readdir(directory))if(/^backup-[0-9]+-[a-f0-9-]{36}\.json$/.test(name))try{const id=backupId(name.slice(0,-5));const metadata=await readJson<BackupSummary>(await assertNoSymlinks(workspaceRoot,`backups/${name}`));const zip=await assertNoSymlinks(workspaceRoot,`backups/${id}.zip`);if(metadata.id===id&&typeof metadata.label==='string'&&typeof metadata.createdAt==='string'&&Number.isFinite(Date.parse(metadata.createdAt))&&Number.isSafeInteger(metadata.fileCount)&&Number.isFinite(metadata.totalBytes)&&typeof metadata.sourceFingerprint==='string')list.push({...metadata,size:(await fs.stat(zip)).size});}catch{}
    return {backups:list.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),maintenance,scope,limits:{maxBytes:maximumBytes,maxFiles:maximumFiles}};
  });
  app.post<{Body:{label?:unknown}}>('/api/backups',async(request,reply)=>withLock(`backup:${workspaceRoot}`,async()=>{
    if(restoring||maintenance)throw new HttpError(409,'恢复期间不能创建普通备份。');const label=request.body?.label??'手动完整备份';if(typeof label!=='string'||label.length>200)throw new HttpError(400,'备份说明无效。');return taskMaintenance.withMaintenance(async()=>reply.code(201).send(await createBackup(label)));
  }));
  app.post('/api/backups/import',{bodyLimit:maximumBytes},async(request,reply)=>withLock(`backup:${workspaceRoot}`,async()=>{
    if(restoring||maintenance)throw new HttpError(409,'恢复期间不能导入备份。');
    const part=await request.file({limits:{fileSize:maximumBytes,files:1}});if(!part)throw new HttpError(400,'请选择完整备份 ZIP。');
    const temporary=path.join(directory,`.import-${randomUUID()}.zip`);
    try {
      await pipeline(part.file,createWriteStream(temporary,{flags:'wx',mode:0o600}));if(part.file.truncated)throw new HttpError(413,'备份 ZIP 超过 4 GB。');
      let manifest:BackupManifest;try{const result=await run('/usr/bin/python3',[archiveHelper,'verify',temporary],{timeout:300000,maxBuffer:32*1024*1024});manifest=JSON.parse(result.stdout);}catch{throw new HttpError(400,'导入失败：ZIP 路径、清单或文件校验值无效。');}
      const id=backupId(manifest.id);checkManifest(manifest,id);const destination=await assertNoSymlinks(workspaceRoot,`backups/${id}.zip`,true);
      if(await fs.stat(destination).then(()=>true).catch(e=>{if(e.code==='ENOENT')return false;throw e;})) {
        const current=await verified(id);if(current.manifest.sourceFingerprint!==manifest.sourceFingerprint)throw new HttpError(409,'已有同编号但内容不同的备份，已保留现有备份。');return current.backup;
      }
      await fs.copyFile(temporary,destination,2 /* COPYFILE_EXCL */);await fs.chmod(destination,0o600);const result=summary(manifest,(await fs.stat(destination)).size);await writeJson(path.join(directory,`${id}.json`),result);return reply.code(201).send(result);
    } finally {await fs.rm(temporary,{force:true}).catch(()=>{});}
  }));
  app.get<{Params:{id:string}}>('/api/backups/:id/download',async(request,reply)=>{const file=await assertNoSymlinks(workspaceRoot,`backups/${backupId(request.params.id)}.zip`);return reply.type('application/zip').header('Content-Disposition',`attachment; filename="${path.basename(file)}"`).send(createReadStream(file));});
  app.post<{Params:{id:string}}>('/api/backups/:id/preview',async request=>withLock(`backup:${workspaceRoot}`,()=>taskMaintenance.withMaintenance(async()=>{
    if(restoring||maintenance)throw new HttpError(409,'恢复或重启期间不能重新预检查。');
    if(activeMutations)throw new HttpError(409,'存在尚未完成的保存或任务创建请求，请稍后再预检查。');
    // Match restore's preflight exactly: checkpoint SQLite before fingerprinting.
    // The fingerprint reviewed by the author must describe the same stable DB
    // state that restore compares, rather than a pre-checkpoint WAL layout.
    await busyBuild();
    const {manifest,backup}=await verified(request.params.id),current=await scan(workspaceRoot),files=effectiveRestoreFiles(manifest,current),old=new Map(current.files.map(f=>[f.path,f.sha256])),next=new Map(files.map(f=>[f.path,f.sha256]));
    const added=files.filter(f=>!old.has(f.path)).map(f=>f.path),changed=files.filter(f=>old.has(f.path)&&old.get(f.path)!==f.sha256).map(f=>f.path),removed=current.files.filter(f=>!next.has(f.path)).map(f=>f.path);
    const result:RestorePreview={backup,expectedFingerprint:current.fingerprint,added:added.slice(0,300),changed:changed.slice(0,300),removed:removed.slice(0,300),unchanged:files.length-added.length-changed.length,truncation:[added,changed,removed].some(a=>a.length>300),counts:{added:added.length,changed:changed.length,removed:removed.length},warning:`恢复会替换备份范围内的论文、共享材料和模型设置。${manifest.directories.includes('workspace')?'同时恢复学术工作台数据。':'这是旧版备份，现有学术工作台数据和 PPT 风格包将保留。'}会先完整备份当前状态并保留原目录。外部目录原件与 API 密钥不受影响。完成后需要重启后台。`};return result;
  })));
  app.post<{Params:{id:string};Body:{expectedFingerprint?:unknown;confirmed?:unknown}}>('/api/backups/:id/restore',async request=>withLock(`backup:${workspaceRoot}`,()=>taskMaintenance.withMaintenance(async()=>{
    if(restoring||maintenance)throw new HttpError(409,'工作区已在恢复或等待重启。');
    if(request.body?.confirmed!==true||typeof request.body.expectedFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(request.body.expectedFingerprint))throw new HttpError(400,'请先预检查差异并确认恢复。');
    restoring=true;let stage:string|undefined,previous:string|undefined,committed=false;
    try {
      if(activeMutations)throw new HttpError(409,'存在尚未完成的保存请求，请稍后重试。');await busyBuild();
      const {manifest,zip}=await verified(request.params.id),initial=await scan(workspaceRoot);
      if(initial.fingerprint!==request.body.expectedFingerprint)throw new HttpError(409,'预检查后工作区已变化，请重新检查差异。');
      stage=await fs.mkdtemp(path.join(directory,'.restore-'));await run('/usr/bin/python3',[archiveHelper,'extract',zip,stage],{timeout:300000,maxBuffer:32*1024*1024});
      // Older archives may contain the WAL index/empty WAL. Their complete ZIP
      // hashes are already verified; compare only durable state and let SQLite
      // rebuild transient indexes after installation.
      if((await scan(stage)).fingerprint!==fingerprint(comparableFiles(manifest.files).sort((a,b)=>comparePath(a.path,b.path)),[...manifest.directories].sort(comparePath)))throw new HttpError(400,'解压后的备份目录结构与清单不一致，当前内容未修改。');
      for(const file of manifest.files.filter(transientAgentSqliteFile))await fs.rm(await assertNoSymlinks(stage,file.path),{force:true});
      const safety=await createBackup(`恢复 ${manifest.id} 前自动保护`);
      if((await scan(workspaceRoot)).fingerprint!==initial.fingerprint)throw new HttpError(409,'恢复准备期间检测到外部修改，已取消恢复；当前内容未覆盖。');
      const restoreRoots=legacyArchive(manifest)?legacyRoots:roots;
      if(legacyArchive(manifest)) {
        // Replace only the staged style subtree. A merge would mix archived and
        // current versions, while exclusive cp fails on older archives that
        // already contain styles. Other archived shared files remain intact.
        const stagedStyles=await assertNoSymlinks(stage,presentationStylesPath,true),styles=await assertNoSymlinks(workspaceRoot,presentationStylesPath,true);
        await fs.rm(stagedStyles,{recursive:true,force:true});
        const currentStyles=await fs.lstat(styles).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        if(currentStyles){if(!currentStyles.isDirectory())throw new HttpError(409,'当前 PPT 风格包目录结构无效，未恢复备份。');await fs.mkdir(path.dirname(stagedStyles),{recursive:true});await fs.cp(styles,stagedStyles,{recursive:true,errorOnExist:true,force:false});}
        const copied=await scan(stage,[presentationStylesPath]),styleFiles=(items:BackupFile[])=>items.filter(file=>atOrBelow(file.path,presentationStylesPath)),styleDirectories=(items:string[])=>items.filter(relative=>atOrBelow(relative,presentationStylesPath));
        if(fingerprint(styleFiles(copied.files),styleDirectories(copied.directories))!==fingerprint(styleFiles(initial.files),styleDirectories(initial.directories)))throw new HttpError(400,'保留的 PPT 风格包副本校验失败，当前内容未修改。');
        // Copying preserved styles is additional preparation after the safety
        // backup; do not switch roots if an external edit happened meanwhile.
        if((await scan(workspaceRoot)).fingerprint!==initial.fingerprint)throw new HttpError(409,'恢复准备期间检测到外部修改，已取消恢复；当前内容未覆盖。');
      }
      previous=path.join(directory,`before-restore-${Date.now()}-${randomUUID()}`);await fs.mkdir(previous,{mode:0o700});
      const journal:RestoreJournal={phase:'moving',previous:path.relative(workspaceRoot,previous).split(path.sep).join('/'),stage:path.relative(workspaceRoot,stage).split(path.sep).join('/'),targets:await Promise.all([...restoreRoots,settingsPath,registryPath].map(async relative=>({path:relative,oldExisted:await fs.lstat(path.join(workspaceRoot,relative)).then(()=>true).catch(e=>{if(e.code==='ENOENT')return false;throw e;})})))};
      await writeJson(path.join(workspaceRoot,journalPath),journal);
      for(const relative of [...restoreRoots,settingsPath,registryPath]) {
        const target=await assertNoSymlinks(workspaceRoot,relative,true),source=path.join(stage,relative),old=path.join(previous,relative);
        if(await fs.lstat(target).then(()=>true).catch(e=>{if(e.code==='ENOENT')return false;throw e;})){await fs.mkdir(path.dirname(old),{recursive:true,mode:0o700});await fs.rename(target,old);}
        if(await fs.lstat(source).then(()=>true).catch(e=>{if(e.code==='ENOENT')return false;throw e;})){await fs.mkdir(path.dirname(target),{recursive:true});await fs.rename(source,target);}
      }
      journal.phase='committed';await writeJson(path.join(workspaceRoot,journalPath),journal);committed=true;await fs.rm(path.join(workspaceRoot,journalPath),{force:true});
      maintenance=true;
      await agentOptions.afterWorkspaceRestore?.();
      for(const entry of await fs.readdir(path.join(workspaceRoot,'papers'),{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory())emit({type:'project.changed',projectId:entry.name});
      const result:RestoreResult={restored:manifest.id,safetyBackupId:safety.id,previousDirectory:path.relative(workspaceRoot,previous).split(path.sep).join('/'),restartRequired:true};return result;
    } catch(error) {
      if(previous) {
        maintenance=true;
        await recoverPendingRestore(workspaceRoot);
        maintenance=committed;
      }
      throw error;
    } finally {restoring=false;if(stage)await fs.rm(stage,{recursive:true,force:true}).catch(()=>{});}
  })));
  app.post('/api/workspace/restart',async(_request,reply)=>{
    if(!maintenance)throw new HttpError(409,'仅恢复后的维护状态允许从此入口重启。');if(restartScheduled)return reply.code(202).send({restarting:true,pid:process.pid});restartScheduled=true;
    const controller=path.join(workspaceRoot,'_system/scripts/control.mjs');await assertNoSymlinks(workspaceRoot,'_system/scripts/control.mjs');
    // The detached controller stops this process, then starts a fresh service.
    const child=spawn(process.execPath,[controller,'restart','--no-open'],{cwd:process.env.HOME||'/',detached:true,stdio:'ignore'});child.unref();child.on('error',()=>{restartScheduled=false;});
    return reply.code(202).send({restarting:true,pid:process.pid});
  });
  return { isLocked: () => restoring || maintenance };
}
