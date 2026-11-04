import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {AgentRun,ChangeImage,ChangeOperation,ChangeSet} from '../../shared/agent-types';
import type {Project} from '../../shared/types';
import {HttpError,assertNoSymlinks,editablePath} from '../security';
import {atomicWrite,hash,withProjectMutation,preserveRecovery} from '../storage';
import {checkpoint} from '../history';
import {listFiles} from '../files';
import {validateTargets} from '../projects';
import {prepareEditorCommit} from './editor-barrier';
const execute=promisify(execFile);
const protectedExtension=/\.(cls|sty|bst|bbx|cbx|def|cfg|clo|fd|ltx)$/i;
const safeId=(id:string)=>{if(!/^[\w-]{1,100}$/.test(id))throw new HttpError(400,'变更集编号无效。');return id;};
async function readBytes(root:string,file:string):Promise<Buffer|null>{const target=await assertNoSymlinks(root,file,true);try{const stat=await fs.stat(target);if(!stat.isFile()||stat.size>50*1024*1024)throw new HttpError(413,'变更文件无效或超过 50 MB。');return await fs.readFile(target);}catch(e:any){if(e.code==='ENOENT')return null;throw e;}}
const digest=(bytes:Buffer|null)=>bytes===null?null:hash(bytes);
function writable(run:AgentRun,file:string){
 editablePath(file);
 if(!/^(manuscript\/|notes\/|literature\/|reviews\/[^/]+\/response\/)/.test(file)||protectedExtension.test(file)||/^notes\/(?:(?:ai-conversations|pdf-annotations)\.json$|agent-runs(?:\/|$))/i.test(file))throw new HttpError(403,`助手不能修改受保护文件：${file}`);
 if(run.scope.readOnly)throw new HttpError(403,'此任务仅允许检查。');
 if(run.scope.paths?.length&&!run.scope.paths.some(p=>file===p||file.startsWith(p.replace(/\/$/,'')+'/')))throw new HttpError(403,`超出本次任务的文件范围：${file}`);
 if(run.scope.selection&&file!==run.scope.selection.path)throw new HttpError(403,'选区任务不能修改其他文件。');
}
function selectionCheck(run:AgentRun,op:ChangeOperation){
 const s=run.scope.selection;if(!s)return;
 if(op.kind!=='write'||op.path!==s.path||op.expectedHash!==hash(s.documentText)||!op.content.startsWith(s.documentText.slice(0,s.from))||!op.content.endsWith(s.documentText.slice(s.to))||op.content.length<s.documentText.length-(s.to-s.from))throw new HttpError(409,'选区修改基线不一致，或修改超出了指定选区。');
 if(/润色|polish|proofread/i.test(run.input)){
  const next=op.content.slice(s.from,op.content.length-(s.documentText.length-s.to));
  const invariants=(text:string)=>[...(text.matchAll(/\\(?:cite\w*|ref|eqref|autoref|label)\*?(?:\[[^\]]*\])*\{[^}]*\}|\$\$[\s\S]*?\$\$|(?<!\\)\$[^$]*?(?<!\\)\$|\\\[[\s\S]*?\\\]/g))].map(m=>m[0]);
  if(JSON.stringify(invariants(next))!==JSON.stringify(invariants(s.selectedText)))throw new HttpError(400,'润色修改改变了公式或引用标记，尚未应用。');
 }
}
async function journal(root:string,change:ChangeSet){const folder=await assertNoSymlinks(root,'.workbench/agent-changes',true);await fs.mkdir(folder,{recursive:true,mode:0o700});await assertNoSymlinks(root,'.workbench/agent-changes');const file=path.join(folder,safeId(change.id)+'.json');await atomicWrite(file,JSON.stringify(change));await fs.chmod(file,0o600);}
/** Expand only proven literal LaTeX resources. Never do a global filename replacement. */
async function expandMoves(root:string,run:AgentRun,operations:ChangeOperation[],readSet:Record<string,string|null>):Promise<ChangeOperation[]>{
 const moves=operations.filter((o):o is Extract<ChangeOperation,{kind:'move'}>=>o.kind==='move');if(!moves.length)return operations;
 const project=JSON.parse((await readBytes(root,'project.json'))!.toString()) as Project,target=project.targets.find(t=>t.id===run.targetId);if(!target)throw new HttpError(409,'本次任务的编译目标不存在。');
 const base=path.posix.dirname(target.main),planned=new Map(operations.filter((o):o is Extract<ChangeOperation,{kind:'write'}>=>o.kind==='write').map(o=>[o.path,o]));
 for(const entry of await listFiles(root)){
  if(entry.type!=='file'||!entry.path.startsWith(base+'/')||!entry.path.endsWith('.tex'))continue;
  const original=(await readBytes(root,entry.path))!,existing=planned.get(entry.path),originalHash=hash(original);
  if(existing&&existing.expectedHash!==originalHash||Object.hasOwn(readSet,entry.path)&&readSet[entry.path]!==originalHash)throw new HttpError(409,`路径更新所依赖的文件已变化：${entry.path}。旧补丁不会绑定新哈希。`);
  let text=existing?.content??original.toString('utf8');
  if(/\\(?:input|include|includegraphics|bibliography|addbibresource|import|subimport)\*?(?:\[[^\]]*\])?\s*\{[^}]*\\/.test(text))throw new HttpError(409,`存在动态资源路径，不能可靠移动文件：${entry.path}`);
  const graphics=[...text.matchAll(/\\graphicspath\s*\{((?:\{[^{}]*\}\s*)+)\}/g)].flatMap(m=>[...m[1].matchAll(/\{([^{}]*)\}/g)].map(n=>n[1]));
  const update=(arg:string,exts:string[])=>{
   if(/[\\#$%]/.test(arg))return arg;
   for(const move of moves){
    const candidates=[base,...graphics.map(g=>path.posix.join(base,g))].flatMap(b=>[path.posix.normalize(path.posix.join(b,arg)),...exts.map(e=>path.posix.normalize(path.posix.join(b,arg+e)))]);
    if(candidates.includes(move.from)){let relative=path.posix.relative(base,move.to);if(!path.posix.extname(arg)&&exts.includes(path.posix.extname(relative)))relative=relative.slice(0,-path.posix.extname(relative).length);return relative;}
   }return arg;
  };
  text=text.replace(/(\\(input|include|includegraphics|bibliography|addbibresource)\*?(?:\[[^\]]*\])?\s*\{)([^{}]*)(\})/g,(_m,head,cmd,arg,tail)=>head+(cmd==='bibliography'?arg.split(',').map((v:string)=>update(v.trim(),['.bib'])).join(','):update(arg,['input','include'].includes(cmd)?['.tex']:['bibliography','addbibresource'].includes(cmd)?['.bib']:['.png','.pdf','.jpg','.jpeg','.svg','.eps']))+tail);
  text=text.replace(/(\\(?:subimport|import)\s*\{)([^{}]*)(\}\s*\{)([^{}]*)(\})/g,(_m,a,dir,b,file,c)=>{const updated=update(path.posix.join(dir,file),['.tex']);if(updated===path.posix.join(dir,file))return _m;return a+path.posix.dirname(updated)+'/'+b+path.posix.basename(updated)+c;});
  if(text!==original.toString('utf8')){const expected=existing?.expectedHash??originalHash;readSet[entry.path]=expected;planned.set(entry.path,{kind:'write',path:entry.path,content:text,expectedHash:expected});}
 }
 let targets=project.targets.map(t=>({...t}));let changed=false;
 for(const move of moves)for(const target of targets)if(target.main===move.from){if(path.posix.dirname(move.from)!==path.posix.dirname(move.to))throw new HttpError(409,'移动主文件会改变编译源根目录，请保留其目录，仅调整文件名。');target.main=move.to;changed=true;}
 const result:ChangeOperation[]=[...operations.filter(o=>o.kind!=='write'),...planned.values()];
 if(changed&&!result.some(o=>o.kind==='project'))result.push({kind:'project',patch:{targets},expectedUpdatedAt:project.updatedAt});return result;
}
export async function createChangeSet(root:string,run:AgentRun,description:string,operations:ChangeOperation[],baseline:Record<string,string|null>):Promise<ChangeSet>{
 if(!Array.isArray(operations)||!operations.length||operations.length>100||typeof description!=='string'||description.length>2000)throw new HttpError(400,'请提供 1–100 项有效的文件修改。');
 const readSet={...baseline};operations=await expandMoves(root,run,structuredClone(operations),readSet);
 const images=new Map<string,ChangeImage>(),seen=new Set<string>();let total=0,projectBefore:Project|undefined,projectAfter:Project|undefined;
 async function image(file:string,after:Buffer|null,expected:string|null,allowProject=false){
  if(!allowProject)writable(run,file);const identity=file.normalize('NFC').toLowerCase();if(seen.has(identity))throw new HttpError(400,`变更集含重叠或大小写冲突：${file}`);seen.add(identity);
  if(expected!==null&&(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)))throw new HttpError(400,'文件修改必须提供读取时的哈希。');
  const before=await readBytes(root,file);if(digest(before)!==expected)throw new HttpError(409,`文件已经变化，尚未应用：${file}`,{path:file});
  total+=(before?.length||0)+(after?.length||0);if(total>200*1024*1024)throw new HttpError(413,'变更集超过 200 MB。');
  images.set(file,{path:file,beforeHash:digest(before),afterHash:digest(after),...(before!==null?{beforeBase64:before.toString('base64')}:{}),...(after!==null?{afterBase64:after.toString('base64')}:{} )});readSet[file]=expected;
 }
 for(const op of operations){
  if(!op||!['write','move','delete','project'].includes(op.kind))throw new HttpError(400,'未知变更操作。');selectionCheck(run,op);
  if(op.kind==='write'){if(typeof op.content!=='string'||Buffer.byteLength(op.content)>3*1024*1024||op.content.includes('\0'))throw new HttpError(400,'文本修改无效或超过 3 MB。');if(!operations.some(other=>other.kind==='move'&&other.from===op.path))await image(op.path,Buffer.from(op.content),op.expectedHash);}
  else if(op.kind==='move'){writable(run,op.from);writable(run,op.to);const bytes=await readBytes(root,op.from);if(!bytes)throw new HttpError(404,'待移动文件不存在。');const edit=operations.find((other):other is Extract<ChangeOperation,{kind:'write'}>=>other.kind==='write'&&other.path===op.from);if(edit&&edit.expectedHash!==op.expectedHash)throw new HttpError(409,'移动与内容修改的基线不一致。');await image(op.from,null,op.expectedHash);await image(op.to,edit?Buffer.from(edit.content):bytes,null);}
  else if(op.kind==='delete')await image(op.path,null,op.expectedHash);
  else{if(run.scope.readOnly||run.scope.selection||run.scope.paths?.length)throw new HttpError(403,'本次任务不能修改项目目标。');if(!op.patch||Object.keys(op.patch).some(k=>k!=='targets'))throw new HttpError(403,'助手仅可同步文件移动对应的编译目标。');projectBefore=JSON.parse((await readBytes(root,'project.json'))!.toString());if(!projectBefore||op.expectedUpdatedAt!==projectBefore.updatedAt)throw new HttpError(409,'项目目标配置已经变化。');const targets=validateTargets(op.patch.targets);for(const t of targets){const previous=projectBefore.targets.find(p=>p.id===t.id);if(!previous||t.label!==previous.label||!operations.some(o=>o.kind==='move'&&o.from===previous.main&&o.to===t.main)&&t.main!==previous.main)throw new HttpError(403,'目标修改必须对应本批文件移动。');}if(targets.length!==projectBefore.targets.length)throw new HttpError(403,'不能在文件整理时增删编译目标。');projectAfter={...projectBefore,targets,updatedAt:new Date(Math.max(Date.now(),Date.parse(projectBefore.updatedAt)+1)).toISOString()};await image('project.json',Buffer.from(JSON.stringify(projectAfter,null,2)+'\n'),hash((await readBytes(root,'project.json'))!),true);}
 }
 const change:ChangeSet={id:'cs-'+randomUUID(),runId:run.id,description,operations,readSet,status:'proposed',images:[...images.values()],createdAt:new Date().toISOString(),...(projectBefore?{projectBefore,projectAfter}:{} )};await journal(root,change);return change;
}
async function checkReadSet(root:string,readSet:Record<string,string|null>){for(const[file,expected]of Object.entries(readSet)){if(digest(await readBytes(root,file))!==expected)throw new HttpError(409,`读取基线已变化：${file}。请比较当前文件后重新生成修改。`,{path:file});}}
async function setImage(root:string,image:ChangeImage,reverse=false){
 const data=reverse?image.beforeBase64:image.afterBase64,expected=reverse?image.afterHash:image.beforeHash;
 const current=await readBytes(root,image.path);if(digest(current)!==expected)throw new HttpError(409,`提交期间文件变化：${image.path}`);
 const filename=await assertNoSymlinks(root,image.path,true);if(current)await preserveRecovery(root,image.path,current);
 if(data===undefined){if(digest(await readBytes(root,image.path))!==expected)throw new HttpError(409,`删除前文件变化：${image.path}`);await fs.rm(filename,{force:true});}
 else{await fs.mkdir(path.dirname(filename),{recursive:true});await assertNoSymlinks(root,image.path,true);const temporary=path.join(path.dirname(filename),`.${path.basename(filename)}.${randomUUID()}.tmp`);try{await fs.writeFile(temporary,Buffer.from(data,'base64'),{flag:'wx'});if(digest(await readBytes(root,image.path))!==expected)throw new HttpError(409,`准备替换后文件变化：${image.path}`);await assertNoSymlinks(root,image.path,true);if(expected===null){try{await fs.link(temporary,filename);}catch(error:any){if(error.code==='EEXIST')throw new HttpError(409,`目标文件已被创建：${image.path}`);throw error;}}else await fs.rename(temporary,filename);}finally{await fs.rm(temporary,{force:true});}}
}
export async function applyChangeSet(root:string,run:AgentRun,change:ChangeSet,options:{signal?:AbortSignal;decisionConfirmed?:boolean;beforeCommit?:()=>Promise<void>}={}):Promise<ChangeSet>{
 if(change.runId!==run.id)throw new HttpError(403,'变更集不属于此任务。');if(change.status==='applied')return change;if(change.status!=='proposed')throw new HttpError(409,'此变更集不能再次提交。');
 if(change.operations.some(o=>o.kind==='delete')&&!options.decisionConfirmed)throw new HttpError(428,'删除文件需要审阅具体清单后确认。',{requiresConfirmation:true,changesetId:change.id});
 const release=await prepareEditorCommit(root,change.images.map(i=>i.path),options.signal);
 try{return await withProjectMutation(root,async()=>{
  if(options.signal?.aborted)throw new HttpError(409,'任务已停止，未应用变更。');
  await options.beforeCommit?.();await checkReadSet(root,change.readSet);
  change.checkpoint=(await checkpoint(root,`AI 修改前：${change.description}`)).hash;
  await checkReadSet(root,change.readSet);change.status='applying';await journal(root,change);
  try{for(const image of change.images){release.assertActive();await setImage(root,image);}for(const image of change.images)if(digest(await readBytes(root,image.path))!==image.afterHash)throw new HttpError(409,`提交后文件已有外部变化：${image.path}`);change.status='applied';change.appliedAt=new Date().toISOString();await journal(root,change);return change;}
  catch(error){let collision=false;for(const image of [...change.images].reverse()){const current=digest(await readBytes(root,image.path));if(current===image.afterHash&&current!==image.beforeHash){try{await setImage(root,image,true);}catch{collision=true;}}else if(current!==image.beforeHash)collision=true;}change.status=collision?'conflicted':'failed';change.error=String((error as Error).message);await journal(root,change);throw new HttpError(409,change.error+(collision?'；存在外部修改，已保留恢复记录。':''));}
 });}finally{release();}
}
async function mergeInverse(root:string,current:Buffer,after:Buffer,before:Buffer):Promise<Buffer>{
 if([current,after,before].some(b=>b.includes(0)))throw new HttpError(409,'二进制文件已有后续修改，不能自动撤销。');
 const folder=await assertNoSymlinks(root,'.workbench',true);await fs.mkdir(folder,{recursive:true});const dir=await fs.mkdtemp(path.join(folder,'merge-'));
 try{for(const[n,b]of [['current',current],['base',after],['inverse',before]]as const)await fs.writeFile(path.join(dir,n),b);try{const result=await execute('/usr/bin/git',['merge-file','-p',path.join(dir,'current'),path.join(dir,'base'),path.join(dir,'inverse')],{maxBuffer:12*1024*1024});return Buffer.from(result.stdout);}catch{throw new HttpError(409,'撤销与后续编辑重叠，已保留双方内容，请手动比较。');}}finally{await fs.rm(dir,{recursive:true,force:true});}
}
export async function undoChangeSet(root:string,run:AgentRun,change:ChangeSet,options:{signal?:AbortSignal}={}):Promise<ChangeSet>{
 if(change.runId!==run.id||change.status!=='applied')throw new HttpError(409,'此变更集未应用或已经撤销。');
 const release=await prepareEditorCommit(root,change.images.map(i=>i.path),options.signal);
 try{return await withProjectMutation(root,async()=>{
  const inverse:ChangeImage[]=[];for(const image of change.images){const current=await readBytes(root,image.path);let restored:Buffer|null=image.beforeBase64===undefined?null:Buffer.from(image.beforeBase64,'base64');if(digest(current)!==image.afterHash){if(!current||image.afterBase64===undefined||!restored||image.path==='project.json'||change.operations.some(o=>o.kind==='move'&&(o.from===image.path||o.to===image.path)))throw new HttpError(409,`文件已有后续变化，不能直接撤销：${image.path}`);restored=await mergeInverse(root,current,Buffer.from(image.afterBase64,'base64'),restored);}inverse.push({path:image.path,beforeHash:digest(current),afterHash:digest(restored),...(current?{beforeBase64:current.toString('base64')}:{}),...(restored?{afterBase64:restored.toString('base64')}:{})});}
  if(options.signal?.aborted)throw new HttpError(409,'撤销已停止。');await checkpoint(root,`撤销 AI 修改前：${change.description}`);
  const undo:ChangeSet={...change,id:'cs-'+randomUUID(),description:'撤销：'+change.description,undoOf:change.id,operations:[],readSet:Object.fromEntries(inverse.map(i=>[i.path,i.beforeHash])),images:inverse,status:'applying'};await journal(root,undo);
  try{for(const image of inverse){release.assertActive();await setImage(root,image);}undo.status='applied';await journal(root,undo);}catch(e){for(const image of [...inverse].reverse())if(digest(await readBytes(root,image.path))===image.afterHash)await setImage(root,image,true).catch(()=>{});undo.status='conflicted';await journal(root,undo);throw e;}
  change.status='undone';await journal(root,change);return change;
 });}finally{release();}
}
export async function recoverChangeSets(root:string):Promise<ChangeSet[]>{
 const folder=await assertNoSymlinks(root,'.workbench/agent-changes',true),recovered:ChangeSet[]=[];
 for(const name of await fs.readdir(folder).catch(()=>[])){if(!/^cs-[\w-]+\.json$/.test(name))continue;const change=JSON.parse(await fs.readFile(await assertNoSymlinks(root,'.workbench/agent-changes/'+name),'utf8'))as ChangeSet;if(change.status!=='applying'){recovered.push(change);continue;}
  let conflict=false;await withProjectMutation(root,async()=>{for(const image of [...change.images].reverse()){const actual=digest(await readBytes(root,image.path));if(actual===image.afterHash&&actual!==image.beforeHash)await setImage(root,image,true).catch(()=>{conflict=true;});else if(actual!==image.beforeHash)conflict=true;}change.status=conflict?'conflicted':'failed';change.error=conflict?'中断提交遇到外部变化，恢复记录已保留。':'中断的提交已按日志补偿。';await journal(root,change);});recovered.push(change);
 }
 const originals=recovered.filter(change=>!change.undoOf);
 for(const inverse of recovered.filter(change=>change.undoOf&&change.status==='applied')){const original=originals.find(change=>change.id===inverse.undoOf&&change.runId===inverse.runId);if(original&&original.status!=='undone'){original.status='undone';await journal(root,original);}}
 return originals;
}
