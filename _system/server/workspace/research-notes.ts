import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {ResearchTopic,SourceRoot} from '../../shared/workspace-types';
import type {ResearchNoteDocument,ResearchNoteSection,ResearchNoteSummary,ResearchNoteTrashEntry} from '../../shared/research-notes';
import {researchDay,validResearchDay} from '../../shared/research-calendar';
import {assertNoSymlinks,HttpError} from '../security';
import {atomicWrite,hash,preserveRecovery,withLock} from '../storage';
import type {CatalogState,IndexedResource,JournalOperation} from './catalog';
import {canonicalRoot,rootFile,trashName} from './paths';
import type {createFileOperations} from './operations';

const SECTIONS={ideation:{directory:'课题笔记',field:null},experiments:{directory:'方案与实验',field:'experimentPlan'},results:{directory:'结果与证据',field:'resultSummary'}} as const;
const MAX_BYTES=2*1024*1024;
interface Creation {id:string;filename:string;day:string;complete:boolean}
interface Journal {version:1;requests:Record<string,Creation>}
interface NoteBytes {content:string;hash:string;size:number;updatedAt:string}
interface Context {root:string;state:CatalogState;mutate:<T>(work:()=>Promise<T>)=>Promise<T>;save:()=>Promise<void>;watch?:(source:SourceRoot)=>void;operations:ReturnType<typeof createFileOperations>}

/** Markdown records share the catalog mutation lock and keep byte-level CAS semantics. */
export function registerResearchNoteRoutes(app:FastifyInstance,{root,state,mutate,save,watch,operations}:Context){
 function topic(id:string){const value=state.topics.find(topic=>topic.id===id);if(!value)throw new HttpError(404,'研究课题不存在。');return value;}
 function section(value:string):ResearchNoteSection {if(value!=='ideation'&&value!=='experiments'&&value!=='results')throw new HttpError(400,'研究记录分区无效。');return value;}
 const folder=(topic:ResearchTopic,section:ResearchNoteSection)=>`workspace/research-notes/${topic.id}/${SECTIONS[section].directory}`;
 const journalPath=(topic:ResearchTopic,section:ResearchNoteSection)=>`workspace/research-notes/${topic.id}/${section}.requests.json`;
 const editable=(topic:ResearchTopic)=>{if(topic.archived)throw new HttpError(409,'课题已归档，请先恢复后编辑。');};
 function body(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'研究记录请求格式无效。');return value as Record<string,unknown>;}

 async function readBytes(relative:string):Promise<NoteBytes>{
  const filename=await assertNoSymlinks(root,relative);
  const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const before=await handle.stat();
   if(!before.isFile())throw new HttpError(415,'研究记录必须是普通 Markdown 文件。');
   if(before.size>MAX_BYTES)throw new HttpError(413,'研究记录超过 2 MB，请分成多篇记录。');
   const bytes=await handle.readFile(),after=await handle.stat();
   if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new HttpError(409,'读取期间文件发生变化，请重新读取。');
   await assertNoSymlinks(root,relative);
   const current=await fs.lstat(filename);
   if(current.dev!==after.dev||current.ino!==after.ino||current.size!==after.size||current.mtimeMs!==after.mtimeMs||current.ctimeMs!==after.ctimeMs)throw new HttpError(409,'读取期间文件已被其他程序替换，请重新读取。');
   if(bytes.includes(0))throw new HttpError(415,'研究记录需要 UTF-8 纯文本。');
   try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new HttpError(415,'研究记录需要 UTF-8 编码。');}
   return {content:bytes.toString('utf8'),hash:hash(bytes),size:after.size,updatedAt:after.mtime.toISOString()};
  }finally{await handle.close();}
 }

 async function sourceFor(t:ResearchTopic,s:ResearchNoteSection,create:boolean){
  const relative=folder(t,s),directory=await assertNoSymlinks(root,relative,true);
  if(create){await fs.mkdir(directory,{recursive:true});await assertNoSymlinks(root,relative);}
  else{
   const exists=await fs.lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
   if(!exists)return null;
  }
  await canonicalRoot(root,directory);
  let source=state.roots.find(source=>source.path===directory);
  if(!source){source={id:randomUUID(),path:directory,label:`${t.title} · ${SECTIONS[s].directory}`,permission:'write',status:'ready',scannedFiles:0,revision:1,createdAt:new Date().toISOString()};state.roots.push(source);}
  return source;
 }

 function index(t:ResearchTopic,source:SourceRoot,filename:string,bytes:NoteBytes,s:ResearchNoteSection,id?:string){
  let item=state.resources.find(item=>item.rootId===source.id&&item.path===filename);
  if(!item){
   item={id:id??randomUUID(),rootId:source.id,path:filename,name:filename,kind:'file',size:bytes.size,hash:bytes.hash,modifiedAt:bytes.updatedAt,tags:[],missing:false,revision:1};
   state.resources.push(item);source.scannedFiles++;source.revision++;
  }else if(item.hash!==bytes.hash||item.modifiedAt!==bytes.updatedAt||item.missing){
   Object.assign(item,{size:bytes.size,hash:bytes.hash,modifiedAt:bytes.updatedAt,missing:false,revision:item.revision+1});
  }
  if(s==='ideation'){
   const title=bytes.content.match(/^ {0,3}# +(.+)$/m)?.[1].replace(/\s+#+\s*$/,'').trim().slice(0,300);
   if(item.title!==title){if(title)item.title=title;else delete item.title;item.revision++;}
  }
  item.text=bytes.content;item.snippet=bytes.content.replace(/\s+/g,' ').slice(0,240);
  if(!t.resourceIds.includes(item.id)){t.resourceIds.push(item.id);t.revision++;t.updatedAt=new Date().toISOString();}
  return item;
 }

 function summary(item:IndexedResource,t:ResearchTopic,s:ResearchNoteSection):ResearchNoteSummary {
  return {id:item.id,name:s==='ideation'?(item.title||item.name):item.name,filename:item.name,path:`${folder(t,s)}/${item.name}`,updatedAt:item.modifiedAt,legacy:false};
 }
 function legacy(t:ResearchTopic,s:ResearchNoteSection):ResearchNoteDocument|null {
  const field=SECTIONS[s].field;if(field===null)return null;
  const content=t[field]??'';
  return {id:'overview',name:'原有记录',filename:null,path:null,updatedAt:t.updatedAt,legacy:true,content,hash:hash(content)};
 }

 async function read(t:ResearchTopic,s:ResearchNoteSection,id:string):Promise<ResearchNoteDocument>{
  if(id==='overview'){const previous=legacy(t,s);if(!previous)throw new HttpError(404,'该分区没有原有记录。');return previous;}
  const item=state.resources.find(item=>item.id===id&&t.resourceIds.includes(id));
  const source=item&&state.roots.find(source=>source.id===item.rootId);
  if(!item||!source||source.path!==path.join(root,folder(t,s))||item.kind!=='file'||item.name.startsWith('.')||!/\.md$/i.test(item.name)||item.path!==item.name)throw new HttpError(404,'指定研究记录不存在。');
  await rootFile(root,source,item.path);
  const bytes=await readBytes(`${folder(t,s)}/${item.name}`);
  index(t,source,item.name,bytes,s);await save();
  return {...summary(item,t,s),content:bytes.content,hash:bytes.hash};
 }

 async function journal(t:ResearchTopic,s:ResearchNoteSection):Promise<Journal>{
  try{
   const parsed=JSON.parse((await readBytes(journalPath(t,s))).content) as Journal;
   const validEntry=([requestId,entry]:[string,Creation])=>/^[A-Za-z0-9_-]{1,100}$/.test(requestId)&&entry&&typeof entry==='object'&&typeof entry.id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(entry.id)&&typeof entry.filename==='string'&&/^\d{2}_\d{2}_\d{2}(?:_\d{2,})?\.md$/.test(entry.filename)&&validResearchDay(entry.day)&&typeof entry.complete==='boolean';
   if(parsed?.version!==1||!parsed.requests||typeof parsed.requests!=='object'||Array.isArray(parsed.requests)||!Object.entries(parsed.requests).every(validEntry))throw new HttpError(409,'研究记录创建日志格式无效，请保留日志后检查。');
   return parsed;
  }catch(error){if((error as HttpError).statusCode===404||(error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,requests:{}};if(error instanceof SyntaxError)throw new HttpError(409,'研究记录创建日志格式无效，请保留日志后检查。');throw error;}
 }
 const saveJournal=async(t:ResearchTopic,s:ResearchNoteSection,value:Journal)=>atomicWrite(await assertNoSymlinks(root,journalPath(t,s),true),JSON.stringify(value));

 async function chooseName(directory:string,day:string,requests:Record<string,Creation>){
  const prefix=day.slice(2).replaceAll('-','_');
  for(let number=1;;number++){
   const filename=`${prefix}${number===1?'':`_${String(number).padStart(2,'0')}`}.md`;
   if(Object.values(requests).some(request=>request.filename===filename))continue;
   const exists=await fs.lstat(path.join(directory,filename)).then(()=>true).catch(error=>{if(error.code==='ENOENT')return false;throw error;});
   if(!exists)return filename;
  }
 }

 type Params={id:string;section:string;noteId:string};
 app.get<{Params:Params}>('/api/workspace/topics/:id/notes/:section',async request=>mutate(async()=>{
  const t=topic(request.params.id),s=section(request.params.section),notes:ResearchNoteSummary[]=[];
  const previous=legacy(t,s);if(previous?.content.trim()){const {content:_,hash:__,...note}=previous;notes.push(note);}
  const source=await sourceFor(t,s,false);
  if(source){
   const present=new Set<string>();
   for(const entry of await fs.readdir(source.path,{withFileTypes:true})){
    if(!entry.isFile()||entry.name.startsWith('.')||!/\.md$/i.test(entry.name))continue;
    const bytes=await readBytes(`${folder(t,s)}/${entry.name}`);
    present.add(entry.name);
    notes.push(summary(index(t,source,entry.name,bytes,s),t,s));
   }
   for(const item of state.resources.filter(item=>item.rootId===source.id&&item.kind==='file'&&item.path===item.name&&/\.md$/i.test(item.name))){
    if(!present.has(item.name)&&!item.missing){item.missing=true;item.revision++;}
   }
   await save();watch?.(source);
  }
  notes.sort((a,b)=>s==='ideation'?b.updatedAt.localeCompare(a.updatedAt)||(b.filename||'').localeCompare(a.filename||'',undefined,{numeric:true}):Number(b.legacy)-Number(a.legacy)||b.name.replace(/\.md$/i,'').localeCompare(a.name.replace(/\.md$/i,''),undefined,{numeric:true}));
  return {notes};
 }));
 function deletion(t:ResearchTopic,s:ResearchNoteSection,id:string){
  const operation=state.operations.find(item=>item.id===id&&item.kind==='trash');
  if(!operation)return undefined;
  if(operation.researchNote)return operation.researchNote.topicId===t.id&&operation.researchNote.section===s?operation:undefined;
  const source=state.roots.find(item=>item.id===operation.source?.rootId);
  const record=operation.records?.find(item=>item.id===operation.resourceId);
  return source?.path===path.join(root,folder(t,s))&&record?.kind==='file'&&record.path===record.name&&/\.md$/i.test(record.name)?operation:undefined;
 }
 function trashEntry(operation:JournalOperation):ResearchNoteTrashEntry {
  const metadata=operation.researchNote,record=operation.records?.find(item=>item.id===operation.resourceId);
  return {id:operation.id,noteId:metadata?.noteId||operation.resourceId!,name:metadata?.name||record?.title||record?.name||'研究记录',hash:operation.beforeHash!,deletedAt:operation.createdAt,legacy:!!metadata?.legacyField,status:operation.status,undoable:operation.undoable,...(operation.error?{error:operation.error}:{})};
 }
 app.get<{Params:Params}>('/api/workspace/topics/:id/notes/:section/trash',async request=>mutate(async()=>{
  const t=topic(request.params.id),s=section(request.params.section);
  const entries=state.operations.filter(operation=>deletion(t,s,operation.id));
  for(const operation of entries)if(operation.status==='interrupted')await operations.recover(operation.id);
  return {entries:entries.slice().reverse().map(trashEntry)};
 }));
 app.get<{Params:Params&{operationId:string}}>('/api/workspace/topics/:id/notes/:section/trash/:operationId',async request=>mutate(async()=>{
  const t=topic(request.params.id),s=section(request.params.section),operation=deletion(t,s,request.params.operationId);
  if(!operation||!['applied','interrupted'].includes(operation.status))throw new HttpError(404,'该回收记录当前不可读取。');
  const entry=trashEntry(operation);
  if(operation.researchNote?.legacyField){const content=operation.researchNote.legacyContent!;if(hash(content)!==entry.hash)throw new HttpError(409,'回收内容校验失败。');return {content,hash:entry.hash,filename:'原有记录.md'};}
  const source=state.roots.find(item=>item.id===operation.destination?.rootId);
  if(!source||source.path!==path.join(root,folder(t,s))||operation.destination?.path!==`${trashName}/${operation.id}/content`)throw new HttpError(409,'回收路径与原笔记不匹配。');
  const bytes=await readBytes(`${folder(t,s)}/${operation.destination.path}`);
  if(bytes.hash!==entry.hash)throw new HttpError(409,'回收副本已在其他位置修改，请保留当前内容。');
  return {content:bytes.content,hash:bytes.hash,filename:operation.records?.find(item=>item.id===entry.noteId)?.name||'recovered-note.md'};
 }));
 app.delete<{Params:Params}>('/api/workspace/topics/:id/notes/:section/:noteId',{bodyLimit:16*1024},async request=>mutate(async()=>{
  const t=topic(request.params.id),s=section(request.params.section),input=body(request.body);
  if(typeof input.expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedHash)||typeof input.requestId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId))throw new HttpError(400,'删除记录需要读取时的 hash 和请求编号。');
  const previous=state.operations.find(item=>item.id===input.requestId);
  if(previous){
   const existing=deletion(t,s,previous.id);
   if(!existing||trashEntry(existing).noteId!==request.params.noteId||existing.beforeHash!==input.expectedHash)throw new HttpError(409,'该删除请求编号已用于其他内容。');
   if(existing.status==='interrupted')await operations.recover(existing.id);
   if(existing.status==='applied')return {deletion:trashEntry(existing)};
   throw new HttpError(409,existing.status==='undone'?'该删除已撤销，请刷新后继续。':'上次删除未完成，请核对内容后重试。',{deletion:trashEntry(existing)});
  }
  editable(t);
  const current=await read(t,s,request.params.noteId);
  if(current.hash!==input.expectedHash)throw new HttpError(409,'记录内容已变化，删除已停止，请先比较最新内容。',{current});
  const metadata={topicId:t.id,section:s,noteId:current.id,name:current.name};
  if(current.legacy){
   const field=SECTIONS[s].field;if(!field||!current.content.trim())throw new HttpError(404,'该原有记录当前为空。');
   const before=structuredClone(t),operation:JournalOperation={id:input.requestId,kind:'trash',status:'applied',phase:'applied',createdAt:new Date().toISOString(),undoable:true,beforeHash:current.hash,afterHash:hash(''),researchNote:{...metadata,legacyField:field,legacyContent:current.content}};
   t[field]='';t.revision++;t.updatedAt=operation.createdAt;state.operations.push(operation);
   try{await save();}catch(error){Object.assign(t,before);state.operations.splice(state.operations.indexOf(operation),1);throw error;}
   return {deletion:trashEntry(operation)};
  }
  const resource=state.resources.find(item=>item.id===current.id)!;
  await operations.apply({kind:'trash',rootId:resource.rootId,resourceId:resource.id,expectedRevision:resource.revision,expectedHash:current.hash},{id:input.requestId,researchNote:metadata});
  return {deletion:trashEntry(state.operations.find(item=>item.id===input.requestId)!)};
 }));
 app.post<{Params:Params&{operationId:string}}>('/api/workspace/topics/:id/notes/:section/trash/:operationId/restore',{bodyLimit:16*1024},async request=>mutate(async()=>{
  const t=topic(request.params.id),s=section(request.params.section),input=body(request.body),operation=deletion(t,s,request.params.operationId);editable(t);
  if(!operation)throw new HttpError(404,'回收记录不存在。');
  if(typeof input.expectedHash!=='string'||input.expectedHash!==operation.beforeHash)throw new HttpError(409,'回收记录版本已变化，请重新读取后比较。');
  if(operation.status==='interrupted')await operations.recover(operation.id);
  if(operation.status!=='undone')await operations.undo(operation.id);
  return read(t,s,trashEntry(operation).noteId);
 }));

 app.get<{Params:Params}>('/api/workspace/topics/:id/notes/:section/:noteId',async request=>mutate(()=>read(topic(request.params.id),section(request.params.section),request.params.noteId)));

 app.post<{Params:Params}>('/api/workspace/topics/:id/notes/:section',{bodyLimit:16*1024},async(request,reply)=>mutate(async()=>{
  const t=topic(request.params.id),s=section(request.params.section),input=body(request.body);editable(t);
  if(input.expectedHash!==null)throw new HttpError(400,'新记录必须使用 expectedHash:null。');
  if(typeof input.requestId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId))throw new HttpError(400,'请提供有效的创建请求编号。');
  if(input.day!==undefined&&!validResearchDay(input.day))throw new HttpError(400,'请选择有效的记录日期。');
  const source=await sourceFor(t,s,true),log=await journal(t,s);let creation=Object.hasOwn(log.requests,input.requestId)?log.requests[input.requestId]:undefined;
  const day=input.day===undefined?(creation?.day??researchDay(new Date())):input.day as string;
  if(creation&&creation.day!==day)throw new HttpError(409,'同一创建请求的日期已变化，请使用新的请求编号。');
  if(creation?.complete)return reply.code(201).send(await read(t,s,creation.id));
  if(!creation){creation={id:randomUUID(),filename:await chooseName(source!.path,day,log.requests),day,complete:false};Object.defineProperty(log.requests,input.requestId,{value:creation,enumerable:true,writable:true,configurable:true});await saveJournal(t,s,log);}
  const staged=await assertNoSymlinks(root,`${folder(t,s)}/.create-${input.requestId}.md`,true);
  try{await fs.writeFile(staged,'',{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  await assertNoSymlinks(root,`${folder(t,s)}/.create-${input.requestId}.md`);
  while(true){
   const destination=path.join(source!.path,creation.filename);
   try{await fs.link(staged,destination);break;}
   catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const [existing,stage]=await Promise.all([fs.lstat(destination),fs.lstat(staged)]);
    if(existing.dev===stage.dev&&existing.ino===stage.ino)break;
    const already=state.resources.find(item=>item.id===creation.id&&item.rootId===source!.id&&item.path===creation.filename);
    if(already&&!existing.isSymbolicLink())break;
    creation.filename=await chooseName(source!.path,day,log.requests);await saveJournal(t,s,log);
   }
  }
  const bytes=await readBytes(`${folder(t,s)}/${creation.filename}`);
  const item=index(t,source!,creation.filename,bytes,s,creation.id);creation.id=item.id;
  await save();creation.complete=true;await saveJournal(t,s,log);await fs.rm(staged,{force:true}).catch(()=>{});watch?.(source!);
  return reply.code(201).send({...summary(item,t,s),content:bytes.content,hash:bytes.hash});
 }));

 app.put<{Params:Params}>('/api/workspace/topics/:id/notes/:section/:noteId',{bodyLimit:8*1024*1024},async request=>mutate(async()=>{
  const t=topic(request.params.id),s=section(request.params.section),input=body(request.body);editable(t);
  if(typeof input.content!=='string'||Buffer.byteLength(input.content)>MAX_BYTES||input.content.includes('\0'))throw new HttpError(400,'记录内容无效或超过 2 MB。');
  if(typeof input.expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedHash))throw new HttpError(400,'保存记录时请提供读取时的 hash。');
  const content=input.content;
  return withLock(`research-note:${root}:${t.id}:${s}:${request.params.noteId}`,async()=>{
   const current=await read(t,s,request.params.noteId);
   if(current.hash!==input.expectedHash)throw new HttpError(409,'记录已在其他位置修改，请重新读取并比较后保存。',{current});
   if(current.legacy){
    if(content.length>100000)throw new HttpError(400,'原有记录最多保存 100000 个字符，请新建独立记录继续书写。');
    const before=structuredClone(t),field=SECTIONS[s].field;if(field===null)throw new HttpError(404,'该分区没有原有记录。');t[field]=content;t.revision++;t.updatedAt=new Date().toISOString();
    try{await save();}catch(error){Object.assign(t,before);if(!Object.hasOwn(before,field))delete t[field];throw error;}
    return legacy(t,s)!;
   }
   const filename=await assertNoSymlinks(root,current.path!),directory=path.dirname(filename),temporary=path.join(directory,`.save-${randomUUID()}.tmp`);
   try{
    await fs.writeFile(temporary,content,{flag:'wx',mode:0o600});await preserveRecovery(directory,current.filename!,current.content);
    const latest=await read(t,s,request.params.noteId);
    if(latest.hash!==input.expectedHash)throw new HttpError(409,'保存期间文件已变化，请重新读取并比较。',{current:latest});
    await assertNoSymlinks(root,current.path!);await fs.rename(temporary,filename);
   }finally{await fs.rm(temporary,{force:true});}
   return read(t,s,request.params.noteId);
  });
 }));
}
