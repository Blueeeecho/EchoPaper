import {registerResearchEntryRoutes} from './research-entries.ts';
import {registerResearchNoteRoutes} from './research-notes.ts';
import {readTopicNotebook} from './topic-notebook';
import {createReadingSearch} from './reading-search';
import {createPaperMetadataService} from './paper-metadata';
import {layoutStore} from './document-layout';
import {pdfTitle} from './pdf-title';
import {isResourceGroup,resourceGroup} from '../../shared/resource-kind';
import {previousTaskIndex,workTargetPath} from '../../shared/research-targets.ts';
import {resolveWorkTarget,workTargetOptions,resolvedTargetPath} from './research-targets.ts';
import {progressNextSteps,validResearchDay} from '../../shared/research-calendar.ts';
import {compareResourceNames,uniquePaperResources} from '../../shared/resource-order.ts';
import fs from 'node:fs/promises';
import {searchLiterature,downloadLiterature,arxivId} from './literature.ts';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import type {FastifyInstance} from 'fastify';
import type {FileOperationInput,ResearchTopic,Resource,SourceRoot,WorkspaceOverview,ResourcePage,PdfImportTarget,PdfImportResult} from '../../shared/workspace-types.ts';
import {RESEARCH_STAGES,type ResearchStage} from '../../shared/workspace-types.ts';
import type {TopicIdea} from '../../shared/topic-notebook.ts';
import {workspaceMaintenance} from '../agents/maintenance.ts';
import {watchDirectoryTree,type TreeWatcher} from '../fs-watch.ts';
import {HttpError,assertNoSymlinks} from '../security.ts';
import {withLock} from '../storage.ts';
import {openCatalog,type IndexedResource} from './catalog.ts';
import {parseTimelineConferences} from './conference-timeline.ts';
import {createTimelineSourceService} from './timeline-sources.ts';
import {createFileOperations,publicOperation,trashedResourceIds} from './operations.ts';
import {canonicalRoot,fastFileSnapshot,fileError,overlaps,resourcePath,rootFile,snapshot,type Tree} from './paths.ts';

const textExtensions=new Set(['.txt','.md','.markdown','.tex','.bib','.csv','.tsv','.json','.yaml','.yml','.xml','.html','.htm','.css','.js','.ts','.log','.rst']);
const previewTypes:Record<string,string>={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.tex':'text/plain; charset=utf-8','.bib':'text/plain; charset=utf-8','.csv':'text/plain; charset=utf-8','.tsv':'text/plain; charset=utf-8','.json':'text/plain; charset=utf-8'};
const clone=<T>(value:T):T=>structuredClone(value);
export function publicResource(item:IndexedResource):Resource{const{text,...resource}=item;return clone(resource);}
function bodyObject(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'请求正文必须是对象。');return value as Record<string,unknown>;}
function stringValue(value:unknown,label:string,max:number,required=false){if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw new HttpError(400,`${label}无效。`);return value.trim();}
function revision(expected:unknown,current:number){if(!Number.isSafeInteger(expected)||expected!==current)throw new HttpError(409,'此记录已变化，请重新载入并比较后保存。');}
function progressDateFields(input:Record<string,unknown>,original?:{day?:string;kind?:'progress'|'task'}){
 const day=input.day===undefined?original?.day:input.day,kind=input.kind===undefined?original?.kind:input.kind;
 if(day!==undefined&&!validResearchDay(day))throw new HttpError(400,'请选择有效的工作日期。');
 if(kind!==undefined&&kind!=='progress'&&kind!=='task')throw new HttpError(400,'记录类型无效。');
 return {...(day?{day:day as string}:{}),...(kind?{kind:kind as 'progress'|'task'}:{})};
}
async function extractedText(filename:string,preloadedBytes?:Buffer):Promise<string|undefined>{
  const ext=path.extname(filename).toLowerCase();
  const size=preloadedBytes?preloadedBytes.length:(await fs.stat(filename)).size;
  if(textExtensions.has(ext)&&size<=2*1024*1024){
    let bytes=preloadedBytes;
    if(!bytes){const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{bytes=await handle.readFile();}finally{await handle.close();}}
    if(bytes.includes(0))return undefined;
    return bytes.toString('utf8');
  }
  if(ext!=='.pdf'||size>32*1024*1024)return undefined;
  let bytes=preloadedBytes;
  if(!bytes){const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);bytes=await handle.readFile().finally(()=>handle.close());}
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),fonts=path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),'standard_fonts')+path.sep;
  const loading=getDocument({data:new Uint8Array(bytes),disableFontFace:true,useSystemFonts:false,standardFontDataUrl:fonts,verbosity:0});
  try{
    const pdf=await loading.promise;
    let content='';
    for(let p=1;p<=Math.min(pdf.numPages,200)&&content.length<2*1024*1024;p++){
      const page=await pdf.getPage(p);
      try{
        const text=await page.getTextContent();
        content+=text.items.map(item=>'str'in item?item.str:'').join(' ')+'\n';
      }finally{page.cleanup();}
    }
    return content.slice(0,2*1024*1024);
  }finally{await loading.destroy();}
}

export interface WorkspaceService {
  close():Promise<void>;
  busy():boolean;
  checkpoint():Promise<void>;
  resourceFile(id:string):Promise<{filename:string;resource:Resource;hash:string}>;
  overview():Promise<WorkspaceOverview>;
  resources():Resource[];
  resourcesRef():readonly Resource[];
  onResourcesChanged(listener:()=>void):()=>void;
  onEvent?:(event:any)=>void;
  readingText:ReturnType<typeof createReadingSearch>['readText'];
}
export async function registerWorkspaceRoutes(app:FastifyInstance,workspaceRoot:string,options:{watch?:boolean;onEvent?:(event:any)=>void}={}):Promise<WorkspaceService>{
  const catalog=await openCatalog(workspaceRoot),state=catalog.state,maintenance=workspaceMaintenance(workspaceRoot),lock=`workspace-catalog:${path.resolve(workspaceRoot)}`;
  const paperMeta=createPaperMetadataService(workspaceRoot);
  const readingSearch=createReadingSearch(workspaceRoot,{getText:catalog.getText,getMeta:item=>paperMeta.computeMeta(item)});
  const readingCache=layoutStore(workspaceRoot);
  const timelineSources=createTimelineSourceService(workspaceRoot);
  let active=0,closing=false,closed:Promise<void>|undefined;
  const scans=new Map<string,Promise<void>>(),rescan=new Set<string>(),scanProgress=new Map<string,number>(),watchers=new Map<string,TreeWatcher>();
  const resourceListeners=new Set<()=>void>();
  const notifyResources=()=>{for(const listener of resourceListeners)try{listener();}catch{}};
  const notebookSummaryCache=new Map<string,{stamp:string;summary:{latestIdea:TopicIdea|null;openCount:number;openIdeaCount:number;keyRefCount:number}}>();
  async function topicNotebookSummary(topicId:string){
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(topicId))return undefined;
    try{
      const filename=await assertNoSymlinks(workspaceRoot,`workspace/topic-notebooks/${topicId}.json`,true);
      const stat=await fs.stat(filename).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
      const stamp=stat?`${stat.mtimeMs}:${stat.size}`:'missing';
      const cached=notebookSummaryCache.get(topicId);
      if(cached&&cached.stamp===stamp)return cached.summary;
      const {notebook}=await readTopicNotebook(workspaceRoot,topicId);
      const openCount=notebook.ideas.filter(idea=>(idea.kind==='question'||idea.kind==='hypothesis'||idea.kind==='todo')&&!idea.done).length;
      const summary={
        latestIdea:notebook.ideas[0]??null,
        openCount,
        openIdeaCount:openCount,
        keyRefCount:notebook.keyRefs.length,
      };
      notebookSummaryCache.set(topicId,{stamp,summary});
      if(notebookSummaryCache.size>500)notebookSummaryCache.delete(notebookSummaryCache.keys().next().value!);
      return summary;
    }catch{return undefined;}
  }
  async function mutate<T>(work:()=>Promise<T>,acceptedScan=false):Promise<T>{active++;try{return await withLock(lock,async()=>{maintenance.assertAvailable();if(closing&&!acceptedScan)throw new HttpError(503,'工作区目录服务正在停止。');return work();});}finally{active--;}}
  const operations=createFileOperations(workspaceRoot,state,()=>catalog.save());await operations.recover();
  const root=(id:string)=>{const item=state.roots.find(r=>r.id===id);if(!item)throw new HttpError(404,'来源目录不存在。');return item;};
  const resource=(id:string)=>{const item=state.resources.find(r=>r.id===id);if(!item)throw new HttpError(404,'资源不存在。');return item;};
  const publicRoot=(item:SourceRoot)=>({...item,scannedFiles:item.status==='scanning'?scanProgress.get(item.id)??item.scannedFiles:item.scannedFiles});
  async function scanRoot(item:SourceRoot){
    for(let pass=0;pass<6;pass++){
      const {baseline,titles}=await mutate(async()=>{
        rescan.delete(item.id);
        scanProgress.set(item.id,0);
        const baseline=new Map<string,IndexedResource>(),titles=new Map<string,string>();
        for(const entry of state.resources){
          if(entry.rootId===item.id)baseline.set(entry.id,{...entry});
          if(entry.hash&&entry.title&&!titles.has(entry.hash))titles.set(entry.hash,entry.title);
        }
        return {baseline,titles};
      },true);
      let count=0;
      const found=new Map<string,IndexedResource>(),existing=new Map<string,IndexedResource>();
      for(const entry of baseline.values()){
        const previous=existing.get(entry.path);
        if(!previous||previous.missing&&!entry.missing)existing.set(entry.path,entry);
      }
      async function walk(relative:string):Promise<Tree>{
        maintenance.assertAvailable();if(count>=100000)throw new HttpError(413,'来源超过 10 万个文件和目录，请连接更小的目录。');
        const filename=await rootFile(workspaceRoot,item,relative),stat=await fs.lstat(filename);let tree:Tree;
        const old=relative?existing.get(relative):undefined;
        if(stat.isDirectory()){
          const children=new Map<string,Tree>();for(const entry of (await fs.readdir(filename,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name.startsWith('.')||entry.isSymbolicLink()||(!entry.isDirectory()&&!entry.isFile()))continue;try{children.set(entry.name,await walk(relative?relative+'/'+entry.name:entry.name));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||(error as HttpError).statusCode===404)continue;throw error;}}
          const digest=createHash('sha256');let size=0;for(const[name,child]of [...children].sort(([a],[b])=>a<b?-1:a>b?1:0)){digest.update(JSON.stringify([name,child.kind,child.hash]));size+=child.size;}tree={kind:'directory',children,hash:digest.digest('hex'),size,modifiedAt:stat.mtime.toISOString(),mode:stat.mode&0o777};
        }else tree=await fastFileSnapshot(filename,old&&old.kind==='file'?old:undefined);
        if(relative){count++;const record:IndexedResource={id:old?.id||randomUUID(),rootId:item.id,path:relative,name:path.posix.basename(relative),kind:tree.kind,size:tree.size,modifiedAt:tree.modifiedAt,tags:old?.tags||[],...(old?.title&&old.hash===tree.hash?{title:old.title}:{}),...(old?.snippet&&old.hash===tree.hash?{snippet:old.snippet}:{}),missing:false,revision:old?.revision||1,hash:tree.hash};if(old&&(old.hash!==record.hash||old.missing||old.kind!==record.kind||old.modifiedAt!==record.modifiedAt))record.revision++;
          if(tree.kind==='file'){
            const contentChanged=!old||old.hash!==record.hash;
            const needsPdfTitle=!record.title&&/\.pdf$/i.test(record.name)&&!titles.has(tree.hash);
            let preloaded:Buffer|undefined;
            if(contentChanged||needsPdfTitle){
              if(/\.pdf$/i.test(record.name)&&tree.size<=32*1024*1024){
                const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
                try{preloaded=await handle.readFile();}finally{await handle.close();}
              }
            }
            if(contentChanged){
              const text=await extractedText(filename,preloaded).catch(()=>undefined);
              if(text!==undefined){record.text=text;record.snippet=text.replace(/\s+/g,' ').slice(0,240);}
              else{record.text=undefined;delete record.snippet;}
            }
            if(!record.title&&/\.pdf$/i.test(record.name)){
              record.title=titles.get(tree.hash);
              if(!record.title){
                if(preloaded)record.title=await pdfTitle(preloaded);
                else{const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{record.title=await pdfTitle(await handle.readFile());}finally{await handle.close();}}
              }
            }
          }
          if(old&&record.title!==old.title&&record.revision===old.revision)record.revision++;found.set(record.id,record);
          if(count%100===0)scanProgress.set(item.id,count);}
        return tree;
      }
      let failure:Error|undefined;
      try{await walk('');}catch(error){failure=error as Error;}
      const published=await mutate(async()=>{
        const current=state.resources.filter(entry=>entry.rootId===item.id);
        // A concurrent edit or watcher event invalidates this snapshot before publication.
        if(rescan.has(item.id)||current.length!==baseline.size||current.some(entry=>{
          const old=baseline.get(entry.id);
          return !old||old.revision!==entry.revision;
        }))return false;
        const previous=state.resources;
        if(failure){
          const code=(failure as NodeJS.ErrnoException).code;
          item.status=(failure as HttpError).statusCode===503||code==='ENOENT'||code==='ENOTDIR'?'offline':'error';
          item.error=failure.message;
        }else{
          state.resources=previous.map(entry=>{
            if(entry.rootId!==item.id)return entry;
            const scanned=found.get(entry.id);
            if(scanned){found.delete(entry.id);return scanned;}
            return entry.missing?entry:{...entry,missing:true,revision:entry.revision+1};
          });
          for(const entry of found.values())state.resources.push(entry);
          item.status='ready';
          item.indexedAt=new Date().toISOString();
          delete item.error;
        }
        item.scannedFiles=count;
        item.revision++;
        try{await catalog.save();}catch(error){state.resources=previous;throw error;}
        return true;
      },true);
      if(published){notifyResources();return;}
    }
    rescan.add(item.id);
  }
  async function requestScan(id:string,changedWhileScanning=false){return mutate(async()=>{
    const item=root(id);
    if(scans.has(id)){if(changedWhileScanning)rescan.add(id);return publicRoot(item);}
    item.status='scanning';item.scannedFiles=0;item.revision++;delete item.error;
    await catalog.save();
    const job=withLock(`${lock}:scan`,()=>scanRoot(item)).catch(error=>{
      if(!closing){item.status='error';item.error=(error as Error).message;}
    }).finally(()=>{
      scans.delete(id);
      scanProgress.delete(id);
      if(rescan.delete(id)&&!closing)void requestScan(id,true).catch(()=>{});
    });
    scans.set(id,job);
    return clone(item);
  });}
  function watch(item:SourceRoot){
    if(options.watch===false||watchers.has(item.id)||closing)return;
    const watcher=watchDirectoryTree(item.path,{
      debounceMs:250,
      ignore:relative=>relative.split('/').some(part=>part.startsWith('.')),
      onChange:()=>{if(!closing)void requestScan(item.id,true).catch(()=>{});},
      onError:()=>{if(!closing)void requestScan(item.id,true).catch(()=>{});},
    });
    watchers.set(item.id,watcher);
  }
  async function associationIds(value:unknown,kind:'paperIds'|'presentationIds'|'resourceIds'){
    if(!Array.isArray(value)||value.length>5000||value.some(v=>typeof v!=='string'||!v||v.length>200))throw new HttpError(400,'主题关联列表无效。');const ids=[...new Set(value as string[])];
    for(const id of ids){if(kind==='resourceIds'){if(!state.resources.some(r=>r.id===id))throw new HttpError(400,`资源关联不存在：${id}`);}
      else{if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id))throw new HttpError(400,'关联编号无效。');const relative=kind==='paperIds'?`papers/${id}/project.json`:`workspace/presentations/${id}/presentation.json`;try{await assertNoSymlinks(workspaceRoot,relative);}catch{throw new HttpError(400,`关联项目不存在：${id}`);}}}return ids;
  }
  async function topicFields(input:Record<string,unknown>,old?:ResearchTopic){
    const title=input.title===undefined&&old?old.title:stringValue(input.title,'主题标题',200,true),description=input.description===undefined?old?.description||'':stringValue(input.description,'主题说明',10000);
    const associations={} as Pick<ResearchTopic,'paperIds'|'presentationIds'|'resourceIds'>;for(const key of ['paperIds','presentationIds','resourceIds']as const)associations[key]=input[key]===undefined?old?.[key]||[]:await associationIds(input[key],key);
    const research:Pick<ResearchTopic,'stage'|'experimentPlan'|'resultSummary'|'researchBasis'>={};
    if(input.stage!==undefined){if(typeof input.stage!=='string'||!Object.hasOwn(RESEARCH_STAGES,input.stage))throw new HttpError(400,'研究阶段无效。');research.stage=input.stage as ResearchStage;}
    for(const key of ['experimentPlan','resultSummary','researchBasis'] as const)if(input[key]!==undefined)research[key]=stringValue(input[key],key==='experimentPlan'?'实验记录':key==='researchBasis'?'研究依据':'结果整理',100000);
    if(input.archived!==undefined&&typeof input.archived!=='boolean')throw new HttpError(400,'归档状态无效。');return{title,description,...associations,...research,archived:input.archived===undefined?old?.archived||false:input.archived as boolean};
  }
  async function resourceFile(id:string){
    maintenance.assertAvailable();
    const initial=resource(id);
    if(initial.missing)throw new HttpError(404,'资源原位置已不存在，索引和关联仍保留。');
    const source=root(initial.rootId);
    const filename=await rootFile(workspaceRoot,source,initial.path);
    const actual=initial.kind==='file'?await fastFileSnapshot(filename,initial):await snapshot(filename);
    if(initial.hash===actual.hash&&initial.modifiedAt===actual.modifiedAt&&initial.size===actual.size){
      return {filename,resource:publicResource(initial),hash:actual.hash};
    }
    return mutate(async()=>{
      const item=resource(id);
      if(item.missing)throw new HttpError(404,'资源原位置已不存在，索引和关联仍保留。');
      const checkedFilename=await rootFile(workspaceRoot,root(item.rootId),item.path);
      const checked=item.kind==='file'?await fastFileSnapshot(checkedFilename,item):await snapshot(checkedFilename);
      if(item.hash!==checked.hash||item.modifiedAt!==checked.modifiedAt||item.size!==checked.size){
        const contentChanged=item.hash!==checked.hash;
        Object.assign(item,{hash:checked.hash,size:checked.size,modifiedAt:checked.modifiedAt,revision:item.revision+1});
        if(item.kind==='file'){
          let preloaded:Buffer|undefined;
          if(contentChanged&&/\.pdf$/i.test(item.name)&&checked.size<=32*1024*1024){
            const handle=await fs.open(checkedFilename,constants.O_RDONLY|constants.O_NOFOLLOW);
            try{preloaded=await handle.readFile();}finally{await handle.close();}
            item.title=await pdfTitle(preloaded);
          }else if(contentChanged&&/\.pdf$/i.test(item.name)){
            const handle=await fs.open(checkedFilename,constants.O_RDONLY|constants.O_NOFOLLOW);
            try{item.title=await pdfTitle(await handle.readFile());}finally{await handle.close();}
          }
          if(contentChanged){
            const text=await extractedText(checkedFilename,preloaded).catch(()=>undefined);
            item.text=text;
            item.snippet=text?.replace(/\s+/g,' ').slice(0,240);
          }
        }
        await catalog.save();
        notifyResources();
      }
      return {filename:checkedFilename,resource:publicResource(item),hash:checked.hash};
    });
  }
  async function overview():Promise<WorkspaceOverview>{
    const trashed=trashedResourceIds(state);
    const topics=await Promise.all(state.topics.map(async topic=>{
      const cloned=clone(topic);
      const summary=await topicNotebookSummary(topic.id);
      return summary?Object.assign(cloned,summary):cloned;
    }));
    const recent=state.resources.filter(item=>!item.missing||!trashed.has(item.id)).sort((a,b)=>Number(b.kind==='file'&&!b.missing)-Number(a.kind==='file'&&!a.missing)||b.modifiedAt.localeCompare(a.modifiedAt)).slice(0,200).map(publicResource);
    const enriched=await paperMeta.enrich(recent,state.resources);
    return{topics,roots:state.roots.map(publicRoot),resources:enriched,operations:state.operations.slice(-50).reverse().map(publicOperation),externalOriginalsIncludedInBackup:false};
  }
  const service:WorkspaceService={overview,resourceFile,readingText:readingSearch.readText,resources:()=>state.resources.map(publicResource),resourcesRef:()=>state.resources,onResourcesChanged:listener=>{resourceListeners.add(listener);return()=>resourceListeners.delete(listener);},onEvent:options.onEvent,busy:()=>active>0||scans.size>0,async checkpoint(){await Promise.all([...scans.values()]);await withLock(lock,async()=>{await catalog.save();catalog.checkpoint();});},async close(){
    if(closed)return closed;
    closing=true;
    closed=(async()=>{
      paperMeta.close();
      await Promise.all([...watchers.values()].map(w=>w.close()));
      watchers.clear();
      // Let a request already persisting a scan publish its job before draining.
      await withLock(lock,async()=>{});
      await Promise.allSettled([...scans.values()]);
      await withLock(lock,async()=>{await catalog.save();catalog.close();});
    })();
    return closed;
  }};
  registerResearchEntryRoutes(app,{root:workspaceRoot,state,mutate,save:()=>catalog.save()});
  registerResearchNoteRoutes(app,{root:workspaceRoot,state,mutate,save:()=>catalog.save(),watch,operations});
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
  async function importPdf(target:PdfImportTarget,filename:string,bytes:Buffer,keepBoth=false):Promise<PdfImportResult>{return mutate(async()=>{
    const topic=target.topicId?state.topics.find(t=>t.id===target.topicId):undefined;
    if(target.topicId&&!topic)throw new HttpError(404,'课题不存在。');
    if(topic){revision(target.expectedRevision,topic.revision);if(topic.archived)throw new HttpError(409,'该课题已归档，请恢复课题后导入。');}
    const selectedRoot=target.rootId?root(target.rootId):undefined;
    const directory=topic?path.join(workspaceRoot,'materials',topic.id,'参考文献'):path.join(workspaceRoot,'materials','library','参考文献');
    let folder='';
    if(selectedRoot){
      folder=target.directory?resourcePath(target.directory):'';
      const topicReferences=!!topic&&selectedRoot.path===directory&&!folder;
      if(selectedRoot.permission!=='write'&&!topicReferences)throw new HttpError(403,'所选目录为只读，请选择可整理的目录。');
      const destination=await rootFile(workspaceRoot,selectedRoot,folder);
      if(!(await fs.stat(destination)).isDirectory())throw new HttpError(400,'PDF 归档位置必须是目录。');
    }else if(target.directory)throw new HttpError(400,'子目录需要指定来源目录。');
    if(!bytes.length||bytes.length>50*1024*1024||!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new HttpError(400,'请上传不超过 50 MB 的 PDF。');
    const hash=createHash('sha256').update(bytes).digest('hex');
    const candidates=state.resources.filter(item=>item.kind==='file'&&!item.missing&&item.hash===hash&&/\.pdf$/i.test(item.name));
    const ranked=await Promise.all(candidates.map(async item=>{
      let cached=0;
      try{
        const layout=await readingCache.readLayout(item.id);
        if(layout?.sourceHash===hash){
          const translations=await readingCache.readTranslations(item.id);
          cached=1+Object.values(translations).filter(value=>typeof value==='string'&&value.trim()).length;
        }
      }catch{/* Cache availability only affects the preferred existing resource. */}
      return {item,cached};
    }));
    ranked.sort((first,second)=>Number(!!topic?.resourceIds.includes(second.item.id))-Number(!!topic?.resourceIds.includes(first.item.id))||second.cached-first.cached);
    for(const {item} of ranked){
      try{
        const filename=await rootFile(workspaceRoot,root(item.rootId),item.path);
        if((await snapshot(filename)).hash!==hash)continue;
      }catch(error){
        if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code||'')||error instanceof HttpError&&[403,404,409,503].includes(error.statusCode))continue;
        throw error;
      }
      const alreadyLinked=!!topic?.resourceIds.includes(item.id);
      if(topic&&!alreadyLinked){
        const previous={resourceIds:topic.resourceIds,revision:topic.revision,updatedAt:topic.updatedAt};
        Object.assign(topic,{resourceIds:[...topic.resourceIds,item.id],revision:topic.revision+1,updatedAt:new Date().toISOString()});
        try{await catalog.save();}catch(error){Object.assign(topic,previous);throw error;}
      }
      return {topic:topic?clone(topic):undefined,resource:publicResource(item),root:clone(root(item.rootId)),reused:true,alreadyLinked};
    }
    const existingSource=selectedRoot||state.roots.find(item=>directory===item.path||directory.startsWith(item.path+path.sep));
    if(!selectedRoot){
      if(existingSource){
        const topicReferences=!!topic&&existingSource.path===directory;
        if(existingSource.permission!=='write'&&!topicReferences)throw new HttpError(403,'归档目录为只读，请选择可整理的目录。');
        folder=path.relative(existingSource.path,directory).split(path.sep).join('/');
      }else if(state.roots.some(item=>overlaps(item.path,directory)))throw new HttpError(409,'归档目录包含已连接的位置，请选择现有文件位置后导入。');
      await assertNoSymlinks(workspaceRoot,path.relative(workspaceRoot,directory),true);await fs.mkdir(directory,{recursive:true});await canonicalRoot(workspaceRoot,directory);
    }
    const source:SourceRoot=existingSource??{id:randomUUID(),label:topic?`${topic.title} · 参考文献`:'资料库 · 参考文献',path:directory,permission:topic?'read':'write',status:'ready',scannedFiles:0,revision:1,createdAt:new Date().toISOString()};
    const name=path.basename(filename).replace(/[^\p{L}\p{N} ._-]/gu,'_').slice(0,160)||'paper.pdf';
    let leaf=name.toLowerCase().endsWith('.pdf')?name:name+'.pdf';
    let relative=folder?`${folder}/${leaf}`:leaf;
    let destination=await rootFile(workspaceRoot,source,relative,{missing:true});
    if(keepBoth){
      const existing=await snapshot(destination).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
      if(existing&&existing.hash!==hash){leaf=`${leaf.slice(0,-4)}-${hash.slice(0,12)}.pdf`;relative=folder?`${folder}/${leaf}`:leaf;destination=await rootFile(workspaceRoot,source,relative,{missing:true});}
    }
    try{await fs.writeFile(destination,bytes,{flag:'wx'});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const tree=await snapshot(destination);
    if(tree.kind!=='file'||tree.hash!==hash)throw new HttpError(409,'参考文献中已有同名的不同内容，请比较后改名导入。');
    if(state.resources.some(item=>item.rootId===source.id&&item.path===relative))throw new HttpError(409,'此路径的资料索引已变化，请重新读取后比较。');
    const title=await pdfTitle(bytes);
    const item:IndexedResource={...(title?{title}:{}),id:randomUUID(),rootId:source.id,path:relative,name:leaf,kind:'file',size:tree.size,hash:tree.hash,modifiedAt:tree.modifiedAt,tags:[],missing:false,revision:1};
    const previous=topic?{resourceIds:topic.resourceIds,revision:topic.revision,updatedAt:topic.updatedAt}:undefined;
    if(!existingSource)state.roots.push(source);
    state.resources.push(item);
    if(topic){topic.resourceIds=[...topic.resourceIds,item.id];topic.revision++;topic.updatedAt=new Date().toISOString();}
    source.scannedFiles++;
    try{await catalog.save();}
    catch(error){
      state.resources.splice(state.resources.indexOf(item),1);source.scannedFiles--;if(topic&&previous)Object.assign(topic,previous);
      if(!existingSource)state.roots.splice(state.roots.indexOf(source),1);
      // The exclusively created original can be adopted by an identical retry.
      throw error;
    }
    watch(source);
    notifyResources();
    return {topic:topic?clone(topic):undefined,resource:publicResource(item),root:clone(source),reused:false,alreadyLinked:false};
  });}
  app.post<{Params:{id:string};Querystring:{expectedRevision:string}}>('/api/workspace/topics/:id/upload',async(request,reply)=>{
    const file=await request.file();if(!file)throw new HttpError(400,'请选择 PDF 文件。');const bytes=await file.toBuffer();if(file.file.truncated)throw new HttpError(413,'文件超过 50 MB。');return reply.code(201).send(await importPdf({topicId:request.params.id,expectedRevision:Number(request.query.expectedRevision)},file.filename,bytes));
  });
  app.post<{Querystring:{topicId?:string;expectedRevision?:string;rootId?:string;directory?:string;expectedHash?:string}}>('/api/workspace/resources/upload',async(request,reply)=>{
    if(request.query.expectedHash!=='null')throw new HttpError(400,'新建 PDF 需要 expectedHash=null。');
    const file=await request.file();if(!file)throw new HttpError(400,'请选择 PDF 文件。');
    const bytes=await file.toBuffer();if(file.file.truncated)throw new HttpError(413,'文件超过 50 MB。');
    const {topicId,expectedRevision,rootId,directory}=request.query;
    return reply.code(201).send(await importPdf({topicId,expectedRevision:Number(expectedRevision),rootId,directory},file.filename,bytes,true));
  });
  app.get<{Querystring:{q:string}}>('/api/workspace/literature',async request=>{const q=stringValue(request.query.q,'检索词',500,true);return{papers:await searchLiterature(q)};});
  app.post<{Params:{id:string}}>('/api/workspace/topics/:id/download',async(request,reply)=>{const input=bodyObject(request.body),id=arxivId(input.arxivId);const bytes=await downloadLiterature(id);return reply.code(201).send(await importPdf({topicId:request.params.id,expectedRevision:Number(input.expectedRevision)},`arxiv-${id}.pdf`,bytes));});
  app.post('/api/workspace/topics',async(request,reply)=>mutate(async()=>{const input=bodyObject(request.body),now=new Date().toISOString(),topic:ResearchTopic={id:randomUUID(),...await topicFields(input),revision:1,createdAt:now,updatedAt:now};state.topics.push(topic);await catalog.save();return reply.code(201).send(clone(topic));}));
  app.patch<{Params:{id:string}}>('/api/workspace/topics/:id',async request=>mutate(async()=>{const input=bodyObject(request.body),topic=state.topics.find(t=>t.id===request.params.id);if(!topic)throw new HttpError(404,'研究主题不存在。');revision(input.expectedRevision,topic.revision);Object.assign(topic,await topicFields(input,topic),{revision:topic.revision+1,updatedAt:new Date().toISOString()});await catalog.save();return clone(topic);}));
  app.post<{Params:{id:string}}>('/api/workspace/topics/:id/progress',async(request,reply)=>mutate(async()=>{
    const input=bodyObject(request.body),topic=state.topics.find(t=>t.id===request.params.id);if(!topic)throw new HttpError(404,'研究课题不存在。');revision(input.expectedRevision,topic.revision);
    const content=stringValue(input.content,'进度内容',10000,true),nextStep=input.nextStep===undefined?'':stringValue(input.nextStep,'下一步',2000);
    const dateFields=progressDateFields(input);
    if(dateFields.kind==='task'&&nextStep)throw new HttpError(400,'待办请直接填写任务内容。');
    if((topic.progressEntries?.length||0)>=5000)throw new HttpError(413,'该课题已达到 5000 条进度记录上限。');
    const before=clone(topic),now=new Date().toISOString();topic.progressEntries=[...(topic.progressEntries||[]),{id:randomUUID(),content,nextStep,createdAt:now,...dateFields}];topic.revision++;topic.updatedAt=now;
    try{await catalog.save();}catch(error){Object.assign(topic,before);throw error;}
    return reply.code(201).send(clone(topic));
  }));
  app.patch<{Params:{id:string;entryId:string}}>('/api/workspace/topics/:id/progress/:entryId',async(request,reply)=>mutate(async()=>{
    const input=bodyObject(request.body),topic=state.topics.find(t=>t.id===request.params.id);
    if(!topic)throw new HttpError(404,'研究课题不存在。');
    revision(input.expectedRevision,topic.revision);
    const original=topic.progressEntries?.find(entry=>entry.id===request.params.entryId);
    if(!original)throw new HttpError(404,'进度记录不存在。');
    if(original.supersededBy||topic.progressEntries?.some(entry=>entry.amendsId===original.id))throw new HttpError(409,'该记录已有更正，请读取并比较最新版本后更正。');
    const content=stringValue(input.content,'进度内容',10000,true),nextStep=input.nextStep===undefined?'':stringValue(input.nextStep,'下一步',2000);
    const dateFields=progressDateFields(input,original);
    if(dateFields.kind==='task'&&nextStep)throw new HttpError(400,'待办请直接填写任务内容。');
    if((topic.progressEntries?.length||0)>=5000)throw new HttpError(413,'该课题已达到 5000 条进度记录上限。');
    const before=clone(topic),now=new Date().toISOString(),id=randomUUID();
    topic.progressEntries=[...(topic.progressEntries||[]).map(entry=>entry.id===original.id?{...entry,supersededBy:id}:entry),{id,content,nextStep,createdAt:now,amendsId:original.id,...dateFields}];
    if(original.kind==='task'&&dateFields.kind==='task'&&topic.dailyTaskStates?.[`${original.id}:0`])topic.dailyTaskStates={...topic.dailyTaskStates,[`${id}:0`]:topic.dailyTaskStates[`${original.id}:0`]};
    if(original.kind!=='task'&&dateFields.kind!=='task'){
      const previous=progressNextSteps(original.nextStep),updated=progressNextSteps(nextStep);
      updated.forEach((text,index)=>{const prior=previousTaskIndex(previous,updated,index),state=topic.dailyTaskStates?.[`${original.id}:${prior}`];if(state)topic.dailyTaskStates={...topic.dailyTaskStates,[`${id}:${index}`]:state};});
    }
    topic.revision++;topic.updatedAt=now;
    try{await catalog.save();}catch(error){Object.assign(topic,before);throw error;}
    return reply.code(200).send(clone(topic));
  }));
  app.patch<{Params:{id:string;entryId:string;index:string}}>('/api/workspace/topics/:id/daily-tasks/:entryId/:index',async request=>mutate(async()=>{
    const input=bodyObject(request.body),topic=state.topics.find(t=>t.id===request.params.id);
    if(!topic)throw new HttpError(404,'研究课题不存在。');
    revision(input.expectedRevision,topic.revision);
    if(topic.archived)throw new HttpError(409,'该课题已归档，请先恢复课题。');
    if(input.done===undefined&&!Object.hasOwn(input,'target'))throw new HttpError(400,'请选择待办状态或关联对象。');
    if(input.done!==undefined&&typeof input.done!=='boolean')throw new HttpError(400,'待办完成状态无效。');
    const entry=topic.progressEntries?.find(e=>e.id===request.params.entryId);
    if(!entry)throw new HttpError(404,'待办来源记录不存在。');
    if(entry.supersededBy||topic.progressEntries?.some(e=>e.amendsId===entry.id))throw new HttpError(409,'来源记录已更正，请刷新后查看最新待办。');
    if(!/^(0|[1-9]\d{0,3})$/.test(request.params.index))throw new HttpError(400,'待办编号无效。');
    const index=Number(request.params.index);
    if(index>=(entry.kind==='task'?1:progressNextSteps(entry.nextStep).length))throw new HttpError(404,'待办不存在。');
    const before=clone(topic),now=new Date().toISOString(),key=`${entry.id}:${index}`;
    if(!Object.hasOwn(topic.dailyTaskStates||{},key)&&Object.keys(topic.dailyTaskStates||{}).length>=10000)throw new HttpError(413,'待办状态已达到上限。');
    const current=topic.dailyTaskStates?.[key];
    const target=Object.hasOwn(input,'target')?(input.target===null?undefined:(await resolveWorkTarget({root:workspaceRoot,topic,resources:state.resources,roots:state.roots},input.target)).target):current?.target;
    topic.dailyTaskStates={...topic.dailyTaskStates,[key]:{done:input.done===undefined?current?.done===true:input.done as boolean,updatedAt:now,...(target?{target}:{})}};topic.revision++;topic.updatedAt=now;
    try{await catalog.save();}catch(error){Object.assign(topic,before);if(before.dailyTaskStates===undefined)delete topic.dailyTaskStates;throw error;}
    return clone(topic);
  }));
  function currentTask(id:string,entryId:string,indexValue:string){
    const topic=state.topics.find(t=>t.id===id);if(!topic)throw new HttpError(404,'研究课题不存在。');
    if(topic.archived)throw new HttpError(409,'该课题已归档，请先恢复。');
    const entry=topic.progressEntries?.find(e=>e.id===entryId);
    if(!entry)throw new HttpError(404,'待办来源记录不存在。');
    if(entry.supersededBy||topic.progressEntries?.some(e=>e.amendsId===entry.id))throw new HttpError(409,'待办来源记录已更正，请刷新后重新打开。');
    if(!/^(0|[1-9]\d{0,3})$/.test(indexValue))throw new HttpError(400,'待办编号无效。');
    const index=Number(indexValue),texts=entry.kind==='task'?[entry.content]:progressNextSteps(entry.nextStep);
    if(index>=texts.length)throw new HttpError(404,'待办不存在。');
    return{topic,entry,index,text:texts[index],target:topic.dailyTaskStates?.[`${entry.id}:${index}`]?.target};
  }
  app.get<{Params:{id:string;entryId:string;index:string}}>('/api/workspace/topics/:id/daily-tasks/:entryId/:index/target-options',async request=>mutate(async()=>{
    const task=currentTask(request.params.id,request.params.entryId,request.params.index);
    const options=await workTargetOptions({root:workspaceRoot,topic:task.topic,resources:state.resources,roots:state.roots});
    return{revision:task.topic.revision,target:task.target,taskText:task.text,options};
  }));
  app.get<{Params:{id:string;entryId:string;index:string}}>('/api/workspace/topics/:id/daily-tasks/:entryId/:index/target',async request=>mutate(async()=>{
    const task=currentTask(request.params.id,request.params.entryId,request.params.index);if(!task.target)throw new HttpError(404,'待办尚未关联工作对象。');
    const resolved=await resolveWorkTarget({root:workspaceRoot,topic:task.topic,resources:state.resources,roots:state.roots},task.target);
    return{...resolved,path:resolvedTargetPath({root:workspaceRoot,topic:task.topic,resources:state.resources,roots:state.roots},resolved.target),revision:task.topic.revision};
  }));
  app.get('/api/workspace/roots',async()=>({roots:state.roots.map(publicRoot)}));
  app.post('/api/workspace/roots',async(request,reply)=>{
    const item=await mutate(async()=>{const input=bodyObject(request.body),filename=await canonicalRoot(workspaceRoot,input.path);if(state.roots.some(r=>overlaps(r.path,filename)))throw new HttpError(409,'此目录已连接或与已有来源重叠。');if(input.permission!==undefined&&!['read','write'].includes(input.permission as string))throw new HttpError(400,'来源权限无效。');const item:SourceRoot={id:randomUUID(),label:input.label===undefined?path.basename(filename):stringValue(input.label,'来源名称',200,true),path:filename,permission:input.permission==='write'?'write':'read',status:'scanning',scannedFiles:0,revision:1,createdAt:new Date().toISOString()};state.roots.push(item);await catalog.save();return item;});
    watch(item);const pending=await requestScan(item.id);return reply.code(201).send(pending);
  });
  app.patch<{Params:{id:string}}>('/api/workspace/roots/:id',async request=>mutate(async()=>{const input=bodyObject(request.body),item=root(request.params.id);revision(input.expectedRevision,item.revision);if(input.label!==undefined)item.label=stringValue(input.label,'来源名称',200,true);if(input.permission!==undefined){if(!['read','write'].includes(input.permission as string))throw new HttpError(400,'来源权限无效。');item.permission=input.permission as 'read'|'write';}item.revision++;await catalog.save();return clone(item);}));
  app.post<{Params:{id:string}}>('/api/workspace/roots/:id/scan',async(request,reply)=>reply.code(202).send(await requestScan(request.params.id)));
  app.get<{Querystring:{rootId?:string;q?:string;path?:string;topicId?:string;offset?:string;limit?:string;group?:string;starredFirst?:string;sort?:string;deduplicate?:string}}>('/api/workspace/resources',async request=>{
    const group=request.query.group;if(group!==undefined&&!isResourceGroup(group))throw new HttpError(400,'资料类型无效。');
    const query=request.query;if(query.rootId)root(query.rootId);const parent=query.path===undefined?undefined:query.path===''?'':resourcePath(query.path),q=(query.q||'').trim().toLocaleLowerCase();if(q.length>1000)throw new HttpError(400,'检索词过长。');
    if(query.starredFirst!==undefined&&!['true','false'].includes(query.starredFirst)||query.sort!==undefined&&!['name','recent'].includes(query.sort))throw new HttpError(400,'资料排序参数无效。');
    const topic=query.topicId?state.topics.find(t=>t.id===query.topicId):undefined;if(query.topicId&&!topic)throw new HttpError(404,'研究主题不存在。');const offset=query.offset===undefined?0:Number(query.offset),limit=query.limit===undefined?200:Number(query.limit);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new HttpError(400,'分页参数无效。');
    const trashed=trashedResourceIds(state);
    const topicResources=topic&&new Set(topic.resourceIds);
    const candidates=state.resources.filter(item=>(!item.missing||!trashed.has(item.id))&&(!query.rootId||item.rootId===query.rootId)&&(parent===undefined||(path.posix.dirname(item.path)==='.'?'':path.posix.dirname(item.path))===parent)&&(!topicResources||topicResources.has(item.id)));
    const matches=q?await readingSearch.find(candidates,q):undefined;
    if(query.deduplicate!==undefined&&!['true','false'].includes(query.deduplicate))throw new HttpError(400,'去重参数无效。');
    const priority=new Set<string>();
    let priorityUnavailable=false;
    if(topic&&query.starredFirst==='true'){
      try{
        const {notebook}=await readTopicNotebook(workspaceRoot,topic.id);
        for(const reference of notebook.keyRefs)priority.add(reference.resourceId);
      }catch{priorityUnavailable=true;}
    }
    const found=matches?candidates.filter(item=>matches.has(item.id)):candidates;
    const matching=query.deduplicate==='true'?uniquePaperResources(found,priority):found;
    const groupCounts={paper:0,note:0,summary:0,other:0};
    for(const item of matching)if(item.kind==='file')groupCounts[resourceGroup(item.name)]++;
    const items=matching.filter(item=>!group||(item.kind==='file'&&resourceGroup(item.name)===group)).sort((first,second)=>Number(priority.has(second.id))-Number(priority.has(first.id))||(query.sort==='recent'?second.modifiedAt.localeCompare(first.modifiedAt):0)||compareResourceNames(first,second));
    const pageItems=items.slice(offset,offset+limit).map(item=>({...publicResource(item),...(matches?.has(item.id)?{searchMatch:matches.get(item.id)}:{})}));
    const enriched=await paperMeta.enrich(pageItems,state.resources);
    return{resources:enriched,total:items.length,groupCounts,roots:state.roots.map(publicRoot),indexing:state.roots.some(r=>r.status==='scanning'),...(priorityUnavailable?{priorityUnavailable}: {})}satisfies ResourcePage;
  });
  app.get<{Params:{id:string}}>('/api/workspace/resources/:id',async request=>{const item=resource(request.params.id);const base=item.missing?publicResource(item):(await resourceFile(item.id)).resource;return paperMeta.enrichOne(base,state.resources);});
  app.patch<{Params:{id:string}}>('/api/workspace/resources/:id',async request=>mutate(async()=>{
    const input=bodyObject(request.body),item=resource(request.params.id);revision(input.expectedRevision,item.revision);
    if(input.tags===undefined&&!Object.hasOwn(input,'title'))throw new HttpError(400,'请提供资源标题或标签。');
    if(input.tags!==undefined&&(!Array.isArray(input.tags)||input.tags.length>100||input.tags.some(v=>typeof v!=='string'||!v.trim()||v.length>100)))throw new HttpError(400,'资源标签无效。');
    const title=Object.hasOwn(input,'title')?(input.title===null?'':stringValue(input.title,'资源标题',1000)):item.title;
    const previous=clone(item);
    if(input.tags!==undefined)item.tags=[...new Set((input.tags as string[]).map(value=>value.trim()))];
    if(title)item.title=title;else delete item.title;
    item.revision++;
    try{await catalog.save();}catch(error){Object.assign(item,previous);if(previous.title===undefined)delete item.title;throw error;}
    return publicResource(item);
  }));
  app.post<{Params:{id:string}}>('/api/workspace/resources/:id/relink',async request=>mutate(async()=>{
    const input=bodyObject(request.body),item=resource(request.params.id);revision(input.expectedRevision,item.revision);if(!item.missing)throw new HttpError(409,'只有原位置缺失的资源才能重新关联。');
    const targetRoot=root(typeof input.rootId==='string'?input.rootId:''),targetPath=resourcePath(input.path),filename=await rootFile(workspaceRoot,targetRoot,targetPath),actual=await snapshot(filename);if(actual.kind!==item.kind)throw new HttpError(409,'新位置的资源类型与原资源不同。');
    const originalRoot=root(item.rootId);try{const original=await rootFile(workspaceRoot,originalRoot,item.path,{missing:true});if(await fs.lstat(original).then(()=>true).catch(()=>false))throw new HttpError(409,'原位置已恢复内容，请重新扫描后比较。');}catch(error){if((error as HttpError).statusCode!==503)throw error;}
    const base=item.path,affected=state.resources.filter(r=>r.rootId===item.rootId&&(r.path===base||r.path.startsWith(base+'/'))),remove=new Set<string>();
    async function referenced(id:string){
      // Reading notes retain their resource identity, including when the source is missing.
      try{const noteFile=await assertNoSymlinks(workspaceRoot,`workspace/reading/${id}.json`);await fs.stat(noteFile);return true;}catch(error){if((error as any).code!=='ENOENT'&&(error as HttpError).statusCode!==404)throw error;}
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
  app.get<{Params:{id:string};Querystring:{sourceHash?:string}}>('/api/workspace/resources/:id/raw',async(request,reply)=>{
    const detail=await resourceFile(request.params.id);
    if(request.query.sourceHash!==undefined&&request.query.sourceHash!==detail.hash)throw new HttpError(409,'原文已变更，请更新知识关系图后重新打开。');
    if(detail.resource.kind!=='file')throw new HttpError(415,'目录不支持原始文件预览。');
    const filename=await rootFile(workspaceRoot,root(detail.resource.rootId),detail.resource.path),ext=path.extname(filename).toLowerCase(),type=previewTypes[ext],handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await handle.stat();
      const total=stat.size;
      reply.header('Accept-Ranges','bytes').header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; sandbox").header('Content-Disposition',`${type?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(detail.resource.name)}`).type(type||'application/octet-stream');
      const rangeHeader=request.headers.range;
      if(rangeHeader&&total>0){
        const match=/^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
        if(!match||(!match[1]&&!match[2])){await handle.close();return reply.code(416).header('Content-Range',`bytes */${total}`).send();}
        let start=match[1]?Number(match[1]):Math.max(0,total-Number(match[2]));
        let end=match[2]&&match[1]?Math.min(total-1,Number(match[2])):total-1;
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=total||end<start){
          await handle.close();
          return reply.code(416).header('Content-Range',`bytes */${total}`).send();
        }
        reply.code(206).header('Content-Range',`bytes ${start}-${end}/${total}`).header('Content-Length',String(end-start+1));
        return reply.send(handle.createReadStream({start,end}));
      }
      reply.header('Content-Length',String(total));
      return reply.send(handle.createReadStream());
    }catch(error){
      await handle.close().catch(()=>{});
      throw error;
    }
  });
  app.get('/api/workspace/operations',async()=>({operations:state.operations.slice().reverse().map(publicOperation)}));
  app.get<{Params:{id:string}}>('/api/workspace/operations/:id/recovery',async(request,reply)=>mutate(async()=>{try{const result=await operations.recoveryDownload(request.params.id);return reply.header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; sandbox").header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`).type('application/octet-stream').send(result.content);}catch(error){return fileError(error);}}));
  app.post<{Body:FileOperationInput}>('/api/workspace/operations',async(request,reply)=>mutate(async()=>{try{return reply.code(201).send(await operations.apply(request.body));}catch(error){return fileError(error);}}));
  app.post<{Params:{id:string}}>('/api/workspace/operations/:id/undo',async request=>mutate(async()=>{try{return await operations.undo(request.params.id);}catch(error){return fileError(error);}}));
  app.addHook('onClose',async()=>{await readingSearch.close();await service.close();});
  for(const item of state.roots){
    watch(item);
    if(item.status==='scanning')await requestScan(item.id).catch(()=>{});
  }
  return service;
}
