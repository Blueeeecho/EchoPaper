import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import chokidar,{type FSWatcher} from 'chokidar';
import type {FastifyInstance} from 'fastify';
import type {FileOperationInput,ResearchTopic,Resource,SourceRoot,WorkspaceOverview,ResourcePage} from '../../shared/workspace-types.ts';
import {workspaceMaintenance} from '../agents/maintenance.ts';
import {HttpError,assertNoSymlinks} from '../security.ts';
import {withLock} from '../storage.ts';
import {openCatalog,type IndexedResource} from './catalog.ts';
import {parseTimelineConferences} from './conference-timeline.ts';
import {createTimelineSourceService} from './timeline-sources.ts';
import {createFileOperations,publicOperation} from './operations.ts';
import {canonicalRoot,fileError,overlaps,resourcePath,rootFile,snapshot,type Tree} from './paths.ts';

const textExtensions=new Set(['.txt','.md','.markdown','.tex','.bib','.csv','.tsv','.json','.yaml','.yml','.xml','.html','.htm','.css','.js','.ts','.log','.rst']);
const previewTypes:Record<string,string>={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.tex':'text/plain; charset=utf-8','.bib':'text/plain; charset=utf-8','.csv':'text/plain; charset=utf-8','.tsv':'text/plain; charset=utf-8','.json':'text/plain; charset=utf-8'};
const clone=<T>(value:T):T=>structuredClone(value);
export function publicResource(item:IndexedResource):Resource{const{text,...resource}=item;return clone(resource);}
function bodyObject(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'请求正文必须是对象。');return value as Record<string,unknown>;}
function stringValue(value:unknown,label:string,max:number,required=false){if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw new HttpError(400,`${label}无效。`);return value.trim();}
function revision(expected:unknown,current:number){if(!Number.isSafeInteger(expected)||expected!==current)throw new HttpError(409,'此记录已变化，请重新载入并比较后保存。');}
async function extractedText(filename:string):Promise<string|undefined>{
  const ext=path.extname(filename).toLowerCase(),stat=await fs.stat(filename);
  if(textExtensions.has(ext)&&stat.size<=2*1024*1024){const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{const bytes=await handle.readFile();if(bytes.includes(0))return undefined;return bytes.toString('utf8');}finally{await handle.close();}}
  if(ext!=='.pdf'||stat.size>32*1024*1024)return undefined;
  const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);const bytes=await handle.readFile().finally(()=>handle.close());
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),fonts=path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),'standard_fonts')+path.sep;
  const loading=getDocument({data:new Uint8Array(bytes),disableFontFace:true,useSystemFonts:false,standardFontDataUrl:fonts});try{const pdf=await loading.promise;let content='';for(let p=1;p<=Math.min(pdf.numPages,200)&&content.length<2*1024*1024;p++){const page=await pdf.getPage(p),text=await page.getTextContent();content+=text.items.map(item=>'str'in item?item.str:'').join(' ')+'\n';}return content.slice(0,2*1024*1024);}finally{await loading.destroy();}
}

export interface WorkspaceService {close():Promise<void>;busy():boolean;checkpoint():Promise<void>;resourceFile(id:string):Promise<{filename:string;resource:Resource;hash:string}>;overview():Promise<WorkspaceOverview>}
export async function registerWorkspaceRoutes(app:FastifyInstance,workspaceRoot:string,options:{watch?:boolean}={}):Promise<WorkspaceService>{
  const catalog=await openCatalog(workspaceRoot),state=catalog.state,maintenance=workspaceMaintenance(workspaceRoot),lock=`workspace-catalog:${path.resolve(workspaceRoot)}`;
  const timelineSources=createTimelineSourceService(workspaceRoot);
  let active=0,closing=false,closed:Promise<void>|undefined;const scans=new Map<string,Promise<void>>(),watchers=new Map<string,FSWatcher>(),timers=new Map<string,ReturnType<typeof setTimeout>>();
  async function mutate<T>(work:()=>Promise<T>):Promise<T>{active++;try{return await withLock(lock,async()=>{maintenance.assertAvailable();if(closing)throw new HttpError(503,'工作区目录服务正在停止。');return work();});}finally{active--;}}
  const operations=createFileOperations(workspaceRoot,state,()=>catalog.save());await operations.recover();
  const root=(id:string)=>{const item=state.roots.find(r=>r.id===id);if(!item)throw new HttpError(404,'来源目录不存在。');return item;};
  const resource=(id:string)=>{const item=state.resources.find(r=>r.id===id);if(!item)throw new HttpError(404,'资源不存在。');return item;};
  async function scanRoot(item:SourceRoot){
    let count=0;const found:IndexedResource[]=[],existing=new Map<string,IndexedResource>();for(const entry of state.resources.filter(r=>r.rootId===item.id).sort((a,b)=>Number(a.missing)-Number(b.missing)))if(!existing.has(entry.path))existing.set(entry.path,entry);
    try{
      const source=await rootFile(workspaceRoot,item,'');
      async function walk(relative:string):Promise<Tree>{
        maintenance.assertAvailable();if(count>=100000)throw new HttpError(413,'来源超过 10 万个文件和目录，请连接更小的目录。');
        const filename=await rootFile(workspaceRoot,item,relative),stat=await fs.lstat(filename);let tree:Tree;
        if(stat.isDirectory()){
          const children=new Map<string,Tree>();for(const entry of (await fs.readdir(filename,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name.startsWith('.')||entry.isSymbolicLink()||(!entry.isDirectory()&&!entry.isFile()))continue;try{children.set(entry.name,await walk(relative?relative+'/'+entry.name:entry.name));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||(error as HttpError).statusCode===404)continue;throw error;}}
          const digest=createHash('sha256');let size=0;for(const[name,child]of [...children].sort(([a],[b])=>a<b?-1:a>b?1:0)){digest.update(JSON.stringify([name,child.kind,child.hash]));size+=child.size;}tree={kind:'directory',children,hash:digest.digest('hex'),size,modifiedAt:stat.mtime.toISOString(),mode:stat.mode&0o777};
        }else tree=await snapshot(filename);
        if(relative){count++;const old=existing.get(relative),record:IndexedResource={id:old?.id||randomUUID(),rootId:item.id,path:relative,name:path.posix.basename(relative),kind:tree.kind,size:tree.size,modifiedAt:tree.modifiedAt,tags:old?.tags||[],missing:false,revision:old?.revision||1,hash:tree.hash};if(old&&(old.hash!==record.hash||old.missing||old.kind!==record.kind||old.modifiedAt!==record.modifiedAt))record.revision++;
          if(tree.kind==='file'){if(old&&old.hash===record.hash)record.text=old.text;else record.text=await extractedText(filename).catch(()=>undefined);if(record.text)record.snippet=record.text.replace(/\s+/g,' ').slice(0,240);}found.push(record);
          if(count%100===0){item.scannedFiles=count;await catalog.save();}}
        return tree;
      }
      await walk('');void source;
      const ids=new Set(found.map(r=>r.id));for(const entry of state.resources)if(entry.rootId===item.id&&!ids.has(entry.id)&&!entry.missing){entry.missing=true;entry.revision++;}
      for(const entry of found){const index=state.resources.findIndex(r=>r.id===entry.id);if(index<0)state.resources.push(entry);else state.resources[index]=entry;}
      item.status='ready';item.scannedFiles=count;item.indexedAt=new Date().toISOString();item.revision++;delete item.error;await catalog.save();
    }catch(error){const code=(error as NodeJS.ErrnoException).code;item.status=(error as HttpError).statusCode===503||code==='ENOENT'||code==='ENOTDIR'?'offline':'error';item.error=(error as Error).message;item.scannedFiles=count;item.revision++;await catalog.save();}
  }
  async function requestScan(id:string){return mutate(async()=>{const item=root(id);if(scans.has(id))return clone(item);item.status='scanning';item.scannedFiles=0;item.revision++;delete item.error;await catalog.save();const job=Promise.resolve().then(()=>mutate(()=>scanRoot(item))).catch(async error=>{if(!closing){item.status='error';item.error=(error as Error).message;}}).finally(()=>scans.delete(id));scans.set(id,job);return clone(item);});}
  function watch(item:SourceRoot){if(options.watch===false||watchers.has(item.id)||closing)return;const watcher=chokidar.watch(item.path,{ignoreInitial:true,followSymlinks:false,awaitWriteFinish:{stabilityThreshold:250,pollInterval:100},ignored:(filename)=>path.relative(item.path,filename).split(path.sep).some(part=>part.startsWith('.'))});watchers.set(item.id,watcher);watcher.on('all',()=>{const timer=timers.get(item.id);if(timer)clearTimeout(timer);timers.set(item.id,setTimeout(()=>{timers.delete(item.id);void requestScan(item.id).catch(()=>{});},300));});watcher.on('error',()=>{void requestScan(item.id).catch(()=>{});});}
  async function associationIds(value:unknown,kind:'paperIds'|'presentationIds'|'resourceIds'){
    if(!Array.isArray(value)||value.length>5000||value.some(v=>typeof v!=='string'||!v||v.length>200))throw new HttpError(400,'主题关联列表无效。');const ids=[...new Set(value as string[])];
    for(const id of ids){if(kind==='resourceIds'){if(!state.resources.some(r=>r.id===id))throw new HttpError(400,`资源关联不存在：${id}`);}
      else{if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id))throw new HttpError(400,'关联编号无效。');const relative=kind==='paperIds'?`papers/${id}/project.json`:`workspace/presentations/${id}/presentation.json`;try{await assertNoSymlinks(workspaceRoot,relative);}catch{throw new HttpError(400,`关联项目不存在：${id}`);}}}return ids;
  }
  async function topicFields(input:Record<string,unknown>,old?:ResearchTopic){
    const title=input.title===undefined&&old?old.title:stringValue(input.title,'主题标题',200,true),description=input.description===undefined?old?.description||'':stringValue(input.description,'主题说明',10000);
    const associations={} as Pick<ResearchTopic,'paperIds'|'presentationIds'|'resourceIds'>;for(const key of ['paperIds','presentationIds','resourceIds']as const)associations[key]=input[key]===undefined?old?.[key]||[]:await associationIds(input[key],key);
    if(input.archived!==undefined&&typeof input.archived!=='boolean')throw new HttpError(400,'归档状态无效。');return{title,description,...associations,archived:input.archived===undefined?old?.archived||false:input.archived as boolean};
  }
  async function resourceFile(id:string){return mutate(async()=>{const item=resource(id);if(item.missing)throw new HttpError(404,'资源原位置已不存在，索引和关联仍保留。');const filename=await rootFile(workspaceRoot,root(item.rootId),item.path);const actual=await snapshot(filename);if(item.hash!==actual.hash||item.modifiedAt!==actual.modifiedAt||item.size!==actual.size){Object.assign(item,{hash:actual.hash,size:actual.size,modifiedAt:actual.modifiedAt,revision:item.revision+1});if(item.kind==='file'){item.text=await extractedText(filename).catch(()=>undefined);item.snippet=item.text?.replace(/\s+/g,' ').slice(0,240);}await catalog.save();}return{filename,resource:publicResource(item),hash:actual.hash};});}
  async function overview():Promise<WorkspaceOverview>{return{topics:clone(state.topics),roots:clone(state.roots),resources:state.resources.slice().sort((a,b)=>Number(b.kind==='file'&&!b.missing)-Number(a.kind==='file'&&!a.missing)||b.modifiedAt.localeCompare(a.modifiedAt)).slice(0,200).map(publicResource),operations:state.operations.slice(-50).reverse().map(publicOperation),externalOriginalsIncludedInBackup:false};}
  const service:WorkspaceService={overview,resourceFile,busy:()=>active>0||scans.size>0,async checkpoint(){await Promise.all([...scans.values()]);await withLock(lock,async()=>{await catalog.save();catalog.checkpoint();});},async close(){if(closed)return closed;closing=true;closed=(async()=>{for(const timer of timers.values())clearTimeout(timer);timers.clear();await Promise.all([...watchers.values()].map(w=>w.close()));await Promise.allSettled([...scans.values()]);await withLock(lock,async()=>{await catalog.save();catalog.close();});})();return closed;}};
  app.get('/api/workspace/overview',()=>overview());
  app.get('/api/workspace/conference-timeline',()=>clone(state.conferenceTimeline));
  app.post('/api/workspace/conference-timeline/resolve',async request=>{
    const input=bodyObject(request.body),conferenceId=stringValue(input.conferenceId,'会议编号',200,true),roundId=input.roundId===undefined?undefined:stringValue(input.roundId,'会议轮次',250,true);
    if(input.refresh!==undefined&&typeof input.refresh!=='boolean')throw new HttpError(400,'刷新选项无效。');
    return timelineSources.resolve({conferenceId,roundId,refresh:input.refresh as boolean|undefined});
  });
  app.put('/api/workspace/conference-timeline',async request=>mutate(async()=>{
    const input=bodyObject(request.body);revision(input.expectedRevision,state.conferenceTimeline.revision);
    const next={revision:state.conferenceTimeline.revision+1,conferences:parseTimelineConferences(input.conferences)},previous=state.conferenceTimeline;
    state.conferenceTimeline=next;try{await catalog.save();}catch(error){state.conferenceTimeline=previous;throw error;}
    return clone(next);
  }));
  app.get('/api/workspace/topics',async()=>({topics:clone(state.topics)}));
  app.post('/api/workspace/topics',async(request,reply)=>mutate(async()=>{const input=bodyObject(request.body),now=new Date().toISOString(),topic:ResearchTopic={id:randomUUID(),...await topicFields(input),revision:1,createdAt:now,updatedAt:now};state.topics.push(topic);await catalog.save();return reply.code(201).send(clone(topic));}));
  app.patch<{Params:{id:string}}>('/api/workspace/topics/:id',async request=>mutate(async()=>{const input=bodyObject(request.body),topic=state.topics.find(t=>t.id===request.params.id);if(!topic)throw new HttpError(404,'研究主题不存在。');revision(input.expectedRevision,topic.revision);Object.assign(topic,await topicFields(input,topic),{revision:topic.revision+1,updatedAt:new Date().toISOString()});await catalog.save();return clone(topic);}));
  app.get('/api/workspace/roots',async()=>({roots:clone(state.roots)}));
  app.post('/api/workspace/roots',async(request,reply)=>{
    const item=await mutate(async()=>{const input=bodyObject(request.body),filename=await canonicalRoot(workspaceRoot,input.path);if(state.roots.some(r=>overlaps(r.path,filename)))throw new HttpError(409,'此目录已连接或与已有来源重叠。');if(input.permission!==undefined&&!['read','write'].includes(input.permission as string))throw new HttpError(400,'来源权限无效。');const item:SourceRoot={id:randomUUID(),label:input.label===undefined?path.basename(filename):stringValue(input.label,'来源名称',200,true),path:filename,permission:input.permission==='write'?'write':'read',status:'scanning',scannedFiles:0,revision:1,createdAt:new Date().toISOString()};state.roots.push(item);await catalog.save();return item;});
    const pending=await requestScan(item.id);watch(item);return reply.code(201).send(pending);
  });
  app.patch<{Params:{id:string}}>('/api/workspace/roots/:id',async request=>mutate(async()=>{const input=bodyObject(request.body),item=root(request.params.id);revision(input.expectedRevision,item.revision);if(input.label!==undefined)item.label=stringValue(input.label,'来源名称',200,true);if(input.permission!==undefined){if(!['read','write'].includes(input.permission as string))throw new HttpError(400,'来源权限无效。');item.permission=input.permission as 'read'|'write';}item.revision++;await catalog.save();return clone(item);}));
  app.post<{Params:{id:string}}>('/api/workspace/roots/:id/scan',async(request,reply)=>reply.code(202).send(await requestScan(request.params.id)));
  app.get<{Querystring:{rootId?:string;q?:string;path?:string;topicId?:string;offset?:string;limit?:string}}>('/api/workspace/resources',async request=>{
    const query=request.query;if(query.rootId)root(query.rootId);const parent=query.path===undefined?undefined:query.path===''?'':resourcePath(query.path),q=(query.q||'').trim().toLocaleLowerCase();if(q.length>1000)throw new HttpError(400,'检索词过长。');
    const topic=query.topicId?state.topics.find(t=>t.id===query.topicId):undefined;if(query.topicId&&!topic)throw new HttpError(404,'研究主题不存在。');const offset=query.offset===undefined?0:Number(query.offset),limit=query.limit===undefined?200:Number(query.limit);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new HttpError(400,'分页参数无效。');
    const items=state.resources.filter(item=>(!query.rootId||item.rootId===query.rootId)&&(parent===undefined||(path.posix.dirname(item.path)==='.'?'':path.posix.dirname(item.path))===parent)&&(!topic||topic.resourceIds.includes(item.id))&&(!q||[item.name,item.path,...item.tags,item.text||''].some(v=>v.toLocaleLowerCase().includes(q)))).sort((a,b)=>Number(a.kind!=='directory')-Number(b.kind!=='directory')||a.path.localeCompare(b.path));
    return{resources:items.slice(offset,offset+limit).map(publicResource),total:items.length,roots:clone(state.roots),indexing:state.roots.some(r=>r.status==='scanning')}satisfies ResourcePage;
  });
  app.get<{Params:{id:string}}>('/api/workspace/resources/:id',async request=>{const item=resource(request.params.id);return item.missing?publicResource(item):(await resourceFile(item.id)).resource;});
  app.patch<{Params:{id:string}}>('/api/workspace/resources/:id',async request=>mutate(async()=>{const input=bodyObject(request.body),item=resource(request.params.id);revision(input.expectedRevision,item.revision);if(!Array.isArray(input.tags)||input.tags.length>100||input.tags.some(v=>typeof v!=='string'||!v.trim()||v.length>100))throw new HttpError(400,'资源标签无效。');item.tags=[...new Set((input.tags as string[]).map(v=>v.trim()))];item.revision++;await catalog.save();return publicResource(item);}));
  app.post<{Params:{id:string}}>('/api/workspace/resources/:id/relink',async request=>mutate(async()=>{
    const input=bodyObject(request.body),item=resource(request.params.id);revision(input.expectedRevision,item.revision);if(!item.missing)throw new HttpError(409,'只有原位置缺失的资源才能重新关联。');
    const targetRoot=root(typeof input.rootId==='string'?input.rootId:''),targetPath=resourcePath(input.path),filename=await rootFile(workspaceRoot,targetRoot,targetPath),actual=await snapshot(filename);if(actual.kind!==item.kind)throw new HttpError(409,'新位置的资源类型与原资源不同。');
    const originalRoot=root(item.rootId);try{const original=await rootFile(workspaceRoot,originalRoot,item.path,{missing:true});if(await fs.lstat(original).then(()=>true).catch(()=>false))throw new HttpError(409,'原位置已恢复内容，请重新扫描后比较。');}catch(error){if((error as HttpError).statusCode!==503)throw error;}
    const base=item.path,affected=state.resources.filter(r=>r.rootId===item.rootId&&(r.path===base||r.path.startsWith(base+'/'))),remove=new Set<string>();
    async function referenced(id:string){
      if(state.topics.some(t=>t.resourceIds.includes(id))||state.operations.some(o=>o.resourceId===id||o.records?.some(r=>r.id===id)))return true;
      let directory:string;try{directory=await assertNoSymlinks(workspaceRoot,'workspace/presentations');}catch(error){if((error as HttpError).statusCode===404)return false;throw error;}
      for(const entry of await fs.readdir(directory,{withFileTypes:true})){if(!entry.isDirectory()||entry.name.startsWith('.'))continue;try{const file=await assertNoSymlinks(workspaceRoot,`workspace/presentations/${entry.name}/presentation.json`);if((await fs.stat(file)).size>10*1024*1024)return true;const data=JSON.parse(await fs.readFile(file,'utf8')) as {sources?:{resourceId?:string}[]};if(data.sources?.some(source=>source.resourceId===id))return true;}catch{return true;}}return false;
    }
    const planned:{record:IndexedResource;nextPath:string;tree?:Tree;duplicate?:IndexedResource}[]=[];
    for(const record of affected){let tree:Tree|undefined=actual;const suffix=record.path.slice(base.length);for(const part of suffix.split('/').filter(Boolean))tree=tree?.children?.get(part);const nextPath=targetPath+suffix,duplicate=state.resources.find(r=>r.rootId===targetRoot.id&&r.path===nextPath&&!affected.some(a=>a.id===r.id));
      if(duplicate){if(!tree||tree.hash!==record.hash||tree.hash!==duplicate.hash||duplicate.tags.length||await referenced(duplicate.id))throw new HttpError(409,'新位置已有另一个有独立内容或关联的资源，未合并资源身份。');remove.add(duplicate.id);}planned.push({record,nextPath,tree,duplicate});
    }
    for(const{record,nextPath,tree,duplicate}of planned){record.rootId=targetRoot.id;record.path=nextPath;record.name=path.posix.basename(nextPath);record.missing=!tree;record.revision++;if(tree){record.hash=tree.hash;record.size=tree.size;record.modifiedAt=tree.modifiedAt;record.text=duplicate?.text||record.text;}}
    state.resources=state.resources.filter(r=>!remove.has(r.id));if(item.kind==='file'){item.text=await extractedText(filename).catch(()=>undefined);item.snippet=item.text?.replace(/\s+/g,' ').slice(0,240);}await catalog.save();return publicResource(item);
  }));
  app.get<{Params:{id:string}}>('/api/workspace/resources/:id/text',async request=>{const detail=await resourceFile(request.params.id);if(detail.resource.kind!=='file')throw new HttpError(415,'目录不能读取为文本。');const content=await extractedText(detail.filename);if(content===undefined)throw new HttpError(415,'此文件暂不支持文本读取，或超过文本预览大小限制。');return{content,hash:detail.hash};});
  app.get<{Params:{id:string}}>('/api/workspace/resources/:id/raw',async(request,reply)=>{const detail=await resourceFile(request.params.id);if(detail.resource.kind!=='file')throw new HttpError(415,'目录不支持原始文件预览。');const filename=await rootFile(workspaceRoot,root(detail.resource.rootId),detail.resource.path),ext=path.extname(filename).toLowerCase(),type=previewTypes[ext],handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);reply.header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; sandbox").header('Content-Disposition',`${type?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(detail.resource.name)}`).type(type||'application/octet-stream');return reply.send(handle.createReadStream());});
  app.get('/api/workspace/operations',async()=>({operations:state.operations.slice().reverse().map(publicOperation)}));
  app.get<{Params:{id:string}}>('/api/workspace/operations/:id/recovery',async(request,reply)=>mutate(async()=>{try{const result=await operations.recoveryDownload(request.params.id);return reply.header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; sandbox").header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`).type('application/octet-stream').send(result.content);}catch(error){return fileError(error);}}));
  app.post<{Body:FileOperationInput}>('/api/workspace/operations',async(request,reply)=>mutate(async()=>{try{return reply.code(201).send(await operations.apply(request.body));}catch(error){return fileError(error);}}));
  app.post<{Params:{id:string}}>('/api/workspace/operations/:id/undo',async request=>mutate(async()=>{try{return await operations.undo(request.params.id);}catch(error){return fileError(error);}}));
  app.addHook('onClose',()=>service.close());for(const item of state.roots)watch(item);return service;
}
