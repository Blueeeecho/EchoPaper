import ViewBoundary from './ViewBoundary';
import {ProcessingControls,useReadingProcessing} from './ReadingProcessing';
import {usePdfImport,PdfImportButton,PdfImportFeedback,PdfImportOverlay} from './PdfImport';
import ReferenceList,{type ReferenceListProps} from './ReferenceList';
import {useTopicNotebook} from './useTopicNotebook';
import {lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {Check,ChevronRight,Download,File,FilePlus,Folder,FolderOpen,FolderPlus,Link,LoaderCircle,Pencil,Plus,RefreshCw,RotateCcw,Search,Settings2,Tag,Trash2,WandSparkles,X} from 'lucide-react';
import type {FileOperation,ResearchTopic,Resource,ResourcePage,SourceRoot,WorkspaceOverview} from '../../shared/workspace-types';
import {api,json,prettyDate} from '../api';
import HubDialog from './HubDialog';
import {isResourceGroup,resourceGroup,RESOURCE_GROUP_LABELS,type ResourceGroup} from '../../shared/resource-kind';
import './TopicWorkspace.css';

const ResourceReader=lazy(()=>import('./ResourceReader'));
const ReadingNotes=lazy(()=>import('./ReadingNotes'));

const bytes=(n:number)=>n<1024?`${n} B`:n<1024**2?`${(n/1024).toFixed(1)} KB`:n<1024**3?`${(n/1024**2).toFixed(1)} MB`:`${(n/1024**3).toFixed(1)} GB`;
// Papers and text open straight into the reader; other files show their details.
const readable=(r:Resource)=>r.kind==='file'&&!r.missing&&/\.(pdf|txt|md|tex|bib)$/i.test(r.name);
const parentPath=(p:string)=>p.includes('/')?p.slice(0,p.lastIndexOf('/')):'';
export default function Library({overview,initialQuery='',initialResourceId,topicId,onRefresh,onError,registerGuard}:{overview?:WorkspaceOverview;initialQuery?:string;initialResourceId?:string;topicId?:string;onRefresh:()=>Promise<void>;onError:(message:string)=>void;registerGuard:(guard:(()=>Promise<boolean>)|undefined)=>void}) {
 const [roots,setRoots]=useState<SourceRoot[]>(overview?.roots||[]),[rootId,setRootId]=useState(''),[folder,setFolder]=useState(''),[query,setQuery]=useState(initialQuery),[page,setPage]=useState<ResourcePage>(),[offset,setOffset]=useState(0),[loading,setLoading]=useState(true),[selected,setSelected]=useState<Resource>(),[tags,setTags]=useState(''),[displayTitle,setDisplayTitle]=useState(''),[topicLinks,setTopicLinks]=useState<string[]>([]),[text,setText]=useState(''),[error,setError]=useState('');
 const [dialog,setDialog]=useState<'connect'|'root'|'mkdir'|'create-file'|'rename'|'move'|'trash'|'relink'|undefined>(),[label,setLabel]=useState(''),[path,setPath]=useState(''),[newContent,setNewContent]=useState(''),[permission,setPermission]=useState<'read'|'write'>('write'),[destinationRootId,setDestinationRootId]=useState(''),[busy,setBusy]=useState(false),[operations,setOperations]=useState<FileOperation[]>(overview?.operations||[]),[showHistory,setShowHistory]=useState(false);
 const [selectionLoading,setSelectionLoading]=useState(false),[selectionTopics,setSelectionTopics]=useState<ResearchTopic[]>([]),[selectionError,setSelectionError]=useState(''),[linkError,setLinkError]=useState(''),[metadataConflict,setMetadataConflict]=useState<{resource:Resource;topics:ResearchTopic[]}>();
 const [group,setGroup]=useState<ResourceGroup|''>(()=>{
  if(initialQuery.trim())return '';
  try{const value=localStorage.getItem('echopaper:library-section');return isResourceGroup(value)?value:value==='all'?'':'paper';}catch{return 'paper';}
 });
 const [groupCounts,setGroupCounts]=useState<ResourcePage['groupCounts']>();
 const [locationsOpen,setLocationsOpen]=useState(false),[processingOpen,setProcessingOpen]=useState(false);
 const [libraryView,setLibraryView]=useState<'files'|'notes'>(()=>{try{return !initialQuery.trim()&&!initialResourceId&&localStorage.getItem('echopaper:library-section')==='reading'?'notes':'files';}catch{return 'files';}});
 const chooseView=(v:'files'|'notes')=>{setLibraryView(v);try{localStorage.setItem('echopaper:library-section',v==='notes'?'reading':group||'all');}catch{}};
 const chooseGroup=(value:ResourceGroup|'')=>{
  if(value!==group||folder||offset){setPage(undefined);setLoading(true);}
  selectionId.current++;setSelected(undefined);setFolder('');setOffset(0);setGroup(value);
  try{localStorage.setItem('echopaper:library-section',value||'all');}catch{}
 };
 const loadId=useRef(0),selectionId=useRef(0),listRequest=useRef<AbortController|undefined>(undefined);
 const root=roots.find(r=>r.id===rootId),selectedRoot=roots.find(r=>r.id===selected?.rootId);
 const load=useCallback(async()=>{
  listRequest.current?.abort();
  const controller=new AbortController(),seq=++loadId.current;
  listRequest.current=controller;
  try{
   const params=new URLSearchParams({offset:String(offset),limit:'60',deduplicate:'true'});
   if(rootId)params.set('rootId',rootId);
   if(query.trim())params.set('q',query.trim());else if(rootId&&!group)params.set('path',folder);
   if(topicId)params.set('topicId',topicId);
   if(group)params.set('group',group);
   if(group==='paper'&&topicId)params.set('starredFirst','true');
   if(group==='note'||group==='summary')params.set('sort','recent');
   const result=await api<ResourcePage>(`/api/workspace/resources?${params}`,{signal:controller.signal,timeoutMs:30000});
   if(seq!==loadId.current)return;
   setPage(result);setGroupCounts(result.groupCounts);setRoots(result.roots);setError('');
  }catch(error){if(seq===loadId.current&&!controller.signal.aborted)setError((error as Error).message);}
  finally{
   if(listRequest.current===controller)listRequest.current=undefined;
   if(seq===loadId.current)setLoading(false);
  }
 },[rootId,folder,query,offset,topicId,group]);
 const currentLoad=useRef(load);currentLoad.current=load;
 useEffect(()=>{setQuery(initialQuery);if(initialQuery.trim()){chooseView('files');chooseGroup('');}},[initialQuery]);
 useEffect(()=>{
  if(libraryView!=='files')return;
  setLoading(true);
  const timer=setTimeout(()=>void load(),200);
  return()=>{clearTimeout(timer);loadId.current++;listRequest.current?.abort();};
 },[load,libraryView]);
 const scanning=roots.some(r=>r.status==='scanning')||!!page?.indexing;
 useEffect(()=>{
  if(libraryView!=='files')return;
  const reload=()=>{if(!document.hidden&&!listRequest.current)void load();};
  const timer=scanning?setInterval(reload,5000):undefined;
  window.addEventListener('focus',reload);
  document.addEventListener('visibilitychange',reload);
  return()=>{clearInterval(timer);window.removeEventListener('focus',reload);document.removeEventListener('visibilitychange',reload);};
 },[load,libraryView,scanning]);
 useEffect(()=>{if(overview){setRoots(overview.roots);setOperations(overview.operations);}},[overview]);
 useEffect(()=>{setOffset(0);},[rootId,folder,query,topicId,group]);
 useEffect(()=>{selectionId.current++;setSelected(undefined);},[rootId,folder]);
 async function select(resource:Resource,known=false){
  const seq=++selectionId.current;let ready=false;setSelectionLoading(true);setSelectionError('');setMetadataConflict(undefined);setSelected(resource);setTags('');setDisplayTitle('');setText('');setSelectionTopics(overview?.topics||[]);setTopicLinks((overview?.topics||[]).filter(t=>t.resourceIds.includes(resource.id)).map(t=>t.id));
  try{const value=known?resource:await api<Resource>(`/api/workspace/resources/${resource.id}`);if(seq!==selectionId.current)return;setSelected(value);setTags(value.tags.join('，'));setDisplayTitle(value.title||'');ready=true;setSelectionLoading(false);if(value.kind==='file'&&!value.missing&&/\.(txt|md|tex|bib|csv|json|yaml|yml|py|r)$/i.test(value.name)){const doc=await api<{content:string}>(`/api/workspace/resources/${resource.id}/text`);if(seq===selectionId.current)setText(doc.content);}}
  catch(e:any){if(seq===selectionId.current){if(!ready)setSelectionError(e.message);onError(e.message);}}
  finally{if(seq===selectionId.current)setSelectionLoading(false);}
 }
 useEffect(()=>{
  if(!initialResourceId||!overview)return;
  const controller=new AbortController(),sequence=++selectionId.current;
  setSelected(undefined);setLinkError('');
  if(topicId&&!overview.topics.find(t=>t.id===topicId&&!t.archived)?.resourceIds.includes(initialResourceId)){
   setLinkError('指定资料已不属于当前课题。');return;
  }
  void api<Resource>(`/api/workspace/resources/${encodeURIComponent(initialResourceId)}`,{signal:controller.signal,timeoutMs:30000}).then(value=>{
   if(controller.signal.aborted||sequence!==selectionId.current)return;
   chooseView('files');setGroup(value.kind==='file'?resourceGroup(value.name):'');void select(value,true);
  }).catch((error:Error)=>{if(!controller.signal.aborted&&sequence===selectionId.current)setLinkError(error.message);});
  return()=>controller.abort();
 },[initialResourceId,topicId,!!overview]);
 async function refresh(){await currentLoad.current();const result=await api<{operations:FileOperation[]}>('/api/workspace/operations');setOperations(result.operations);await onRefresh();}
 const chooseRoot=(id:string)=>{
  setLocationsOpen(false);
  if(id===rootId&&!folder&&!query)return;
  selectionId.current++;setPage(undefined);setLoading(true);setRootId(id);setFolder('');setSelected(undefined);setQuery('');
 };
 function openDialog(kind:typeof dialog){setPath(kind==='rename'?selected?.name||'':kind==='move'?selected?.path||'':kind==='create-file'?`${folder?folder+'/':''}new-note.md`:kind==='mkdir'?`${folder?folder+'/':''}`:kind==='root'?root?.path||'':'');setDestinationRootId(selected?.rootId||rootId||roots[0]?.id||'');setLabel(kind==='root'?root?.label||'':'');setPermission(kind==='root'?root?.permission||'write':'write');setNewContent('');setDialog(kind);}
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);try{
  if(dialog==='connect'){const value=await api<SourceRoot>('/api/workspace/roots',json('POST',{path:path.trim(),...(label.trim()?{label:label.trim()}:{}),permission}));setRootId(value.id);setFolder('');}
  else if(dialog==='root'&&root)await api(`/api/workspace/roots/${root.id}`,json('PATCH',{label:label.trim(),permission,expectedRevision:root.revision}));
  else if(dialog==='relink'&&selected){await api(`/api/workspace/resources/${selected.id}/relink`,json('POST',{rootId:destinationRootId,path:path.trim(),expectedRevision:selected.revision}));setSelected(undefined);}
  else {
   let current=selected;if(current&&!current.hash)current=await api<Resource>(`/api/workspace/resources/${current.id}`);
   const request=dialog==='create-file'?{kind:'create-file',rootId,path:path.trim(),content:newContent,expectedHash:null}:dialog==='mkdir'?{kind:'mkdir',rootId,path:path.trim()}:dialog==='trash'?{kind:'trash',rootId:current?.rootId,resourceId:current?.id,expectedRevision:current?.revision,expectedHash:current?.hash}:{kind:'move',rootId:current?.rootId,resourceId:current?.id,destinationRootId:dialog==='rename'?current?.rootId:destinationRootId,destinationPath:dialog==='rename'?`${parentPath(current?.path||'')?parentPath(current?.path||'')+'/':''}${path.trim()}`:path.trim(),expectedRevision:current?.revision,expectedHash:current?.hash};
   await api('/api/workspace/operations',json('POST',request));setSelected(undefined);
  }
  setDialog(undefined);await refresh();
 }catch(e:any){onError(e.message);}finally{setBusy(false);}}
 async function undo(operation:FileOperation){setBusy(true);try{await api(`/api/workspace/operations/${operation.id}/undo`,json('POST',{}));setSelected(undefined);await refresh();}catch(e:any){onError(e.message);}finally{setBusy(false);}}
 async function saveMetadata(){
  if(!selected||selectionLoading||selectionError||metadataConflict)return;setBusy(true);let tagsSaved=false;
  const sequence=selectionId.current;
  try{
   const value=await api<Resource>(`/api/workspace/resources/${selected.id}`,json('PATCH',{title:displayTitle.trim()||null,tags:tags.split(/[,，]/).map(s=>s.trim()).filter(Boolean),expectedRevision:selected.revision}));
   if(sequence===selectionId.current)setSelected(value);
   tagsSaved=true;
   const nextTopics=[...selectionTopics];
   for(const topic of selectionTopics){const has=topic.resourceIds.includes(selected.id),next=topicLinks.includes(topic.id);if(has!==next){const updated=await api<ResearchTopic>(`/api/workspace/topics/${topic.id}`,json('PATCH',{resourceIds:next?[...topic.resourceIds,selected.id]:topic.resourceIds.filter(id=>id!==selected.id),expectedRevision:topic.revision}));nextTopics[nextTopics.findIndex(t=>t.id===topic.id)]=updated;if(sequence===selectionId.current)setSelectionTopics([...nextTopics]);}}
   await refresh();
  }catch(e:any){
   onError(`${tagsSaved?'标题与标签已保存，部分课题关联尚未保存。':''}${e.message}`);
   if(e.status===409&&sequence===selectionId.current){try{const [resource,result]=await Promise.all([api<Resource>(`/api/workspace/resources/${selected.id}`),api<{topics:ResearchTopic[]}>('/api/workspace/topics')]);if(sequence===selectionId.current)setMetadataConflict({resource,topics:result.topics});}catch{ /* Keep the editing baseline when disk comparison is unavailable. */ }}
   await onRefresh().catch(()=>{});
  }finally{setBusy(false);}
 }
 function resolveMetadata(useDisk:boolean){if(!metadataConflict)return;const {resource,topics}=metadataConflict;setSelected(resource);setSelectionTopics(topics);if(useDisk){setDisplayTitle(resource.title||'');setTags(resource.tags.join('，'));setTopicLinks(topics.filter(t=>t.resourceIds.includes(resource.id)).map(t=>t.id));}setMetadataConflict(undefined);}
 async function scan(){if(!rootId)return;try{await api(`/api/workspace/roots/${rootId}/scan`,json('POST',{}));await refresh();}catch(e:any){onError(e.message);}}
 const [reading,setReading]=useState<Resource>();
 function openResource(resource:Resource){
  if(resource.kind==='directory'&&!resource.missing){selectionId.current++;setPage(undefined);setLoading(true);setRootId(resource.rootId);setFolder(resource.path);setQuery('');setSelected(undefined);}
  else if(readable(resource))setReading(resource);
  else void select(resource);
 }
 const readerGuard=useRef<(()=>Promise<boolean>)|undefined>(undefined);
 const setReaderGuard=useCallback((guard:(()=>Promise<boolean>)|undefined)=>{readerGuard.current=guard;},[]);
 const processingIds=(page?.resources||[]).filter(resource=>resource.kind==='file'&&/\.pdf$/i.test(resource.name)).map(resource=>resource.id);
 const processing=useReadingProcessing(libraryView==='files'&&group==='paper'?processingIds:[]);
 const changeQuery=(value:string)=>{loadId.current++;setPage(undefined);setLoading(true);setQuery(value);setOffset(0);};
 const priorityChanged=()=>{if(offset)setOffset(0);else void load();};
 const referenceProps:ReferenceListProps={files:page?.resources||[],variant:group==='paper'?'papers':group==='note'||group==='summary'?'notes':'files',processing,onOpen:openResource,onDetails:resource=>void select(resource),selectedId:selected?.id,search:{value:query,onChange:changeQuery,loading,offset,total:page?.total??(group?groupCounts?.[group]:undefined)??0}};
 const importTopic=overview?.topics.find(topic=>topic.id===topicId);
 const importFolder=group?'':folder;
 const topicReferences=!!importTopic&&root?.path.replace(/\\/g,'/').endsWith(`/materials/${importTopic.id}/参考文献`)&&!importFolder;
 const importBlocked=topicId&&!importTopic?'正在读取当前课题…':importTopic?.archived?'恢复课题后可导入 PDF。':rootId&&!root?'正在读取目标目录…':root?.status==='offline'?'目标目录离线，请选择可用目录。':root?.permission==='read'&&!topicReferences?'当前文件位置为只读，请切换到可整理目录或全部位置后导入。':undefined;
 const importer=usePdfImport({
  target:{...(importTopic?{topicId:importTopic.id,expectedRevision:importTopic.revision}:{}),...(root?{rootId:root.id,directory:importFolder}:{})},
  destination:root?`${root.label}${importFolder?` / ${importFolder}`:''}`:importTopic?`${importTopic.title} / 参考文献`:'资料库 / 参考文献',blocked:importBlocked,
  onImported:async results=>{
   if(results.length){
    chooseView('files');if(group&&group!=='paper')chooseGroup('paper');setQuery('');setOffset(0);
    if(rootId&&results.some(result=>result.resource.rootId!==rootId)){setRootId('');setFolder('');}
   }
   await refresh();
  },
 });
 useEffect(()=>{registerGuard(async()=>(await readerGuard.current?.()??true)&&importer.waitForIdle());return()=>registerGuard(undefined);},[registerGuard,importer.waitForIdle]);
 const libraryTools=<div className="academic-file-toolbar"><button type="button" className="academic-secondary library-locations-toggle" aria-expanded={locationsOpen} onClick={()=>setLocationsOpen(value=>!value)}><FolderOpen size={14}/>{root?.label||'文件位置'}</button><span className="library-toolbar-spacer"/>{group==='paper'&&<button type="button" className={`academic-secondary topic-processing-entry ${processing.snapshot?.settings.enabled?'is-enabled':''}`} aria-label="自动整理翻译" aria-expanded={processingOpen} onClick={()=>setProcessingOpen(value=>!value)}><WandSparkles size={13}/><span>自动整理翻译</span><span className="processing-state-dot" aria-hidden="true"/></button>}<button className="academic-icon" aria-label="刷新资料库" title="刷新" onClick={()=>void refresh().catch(e=>onError(e.message))}><RefreshCw size={16}/></button><button className={`academic-icon ${showHistory?'active':''}`} aria-label="文件操作记录" title="整理与撤销记录" onClick={()=>setShowHistory(!showHistory)}><RotateCcw size={16}/></button>{root&&<><button className="academic-icon" aria-label="重新扫描目录" title="重新扫描目录" onClick={()=>void scan()}><Search size={16}/></button><button className="academic-icon" aria-label="连接目录设置" title="目录设置" onClick={()=>openDialog('root')}><Settings2 size={16}/></button><button className="academic-secondary" disabled={root.permission!=='write'||root.status==='offline'} onClick={()=>openDialog('create-file')}><FilePlus size={15}/>新建文件</button><button className="academic-secondary" disabled={root.permission!=='write'||root.status==='offline'} onClick={()=>openDialog('mkdir')}><FolderPlus size={15}/>新建目录</button></>}</div>;
 const raw=selected?`/api/workspace/resources/${selected.id}/raw`:'';
 return <section className="academic-page academic-library-page topic-workspace-page"><PdfImportOverlay importer={importer}/><div className="academic-page-heading"><div><h1>资料库</h1></div><div className="library-heading-actions"><button className="academic-secondary" onClick={()=>openDialog('connect')}><Plus size={16}/>连接文件夹</button><PdfImportButton importer={importer} primary/></div></div>
 <PdfImportFeedback importer={importer}/>
 <div className="library-document-head"><nav className="library-view-tabs" role="tablist" aria-label="资料分类">
  {(['paper','note','summary'] as const).map(value=><button key={value} role="tab" aria-selected={libraryView==='files'&&group===value} onClick={()=>{chooseView('files');chooseGroup(value);}}>{RESOURCE_GROUP_LABELS[value]}{groupCounts&&<small>{groupCounts[value]}</small>}</button>)}
  <button role="tab" aria-selected={libraryView==='notes'} onClick={()=>chooseView('notes')}>阅读笔记与摘录</button>
  <button role="tab" aria-selected={libraryView==='files'&&group==='other'} onClick={()=>{chooseView('files');chooseGroup('other');}}>{RESOURCE_GROUP_LABELS.other}{groupCounts&&<small>{groupCounts.other}</small>}</button>
  <button role="tab" aria-selected={libraryView==='files'&&!group} onClick={()=>{chooseView('files');chooseGroup('');}}>全部文件</button>
 </nav>{libraryView==='files'&&libraryTools}</div>
 {libraryView==='notes'&&<ViewBoundary fallback={<p role="alert">阅读笔记暂时无法打开。其他资料功能仍可使用；请刷新页面后重试。</p>}><Suspense fallback={<p role="status">正在打开阅读笔记…</p>}><ReadingNotes topicResourceIds={topicId?overview?.topics.find(t=>t.id===topicId)?.resourceIds:undefined} onError={onError}/></Suspense></ViewBoundary>}
 {linkError&&<p role="alert" className="academic-inline-error">{linkError}</p>}
 <div className="academic-library-layout" hidden={libraryView!=='files'}><aside className="academic-locations" hidden={!locationsOpen}><h2>文件位置 <small>{roots.length}</small></h2><button className={!rootId?'active':''} onClick={()=>chooseRoot('')}><FilesIcon/>全部位置</button>{roots.map(r=><button key={r.id} className={rootId===r.id?'active':''} onClick={()=>chooseRoot(r.id)} title={r.path}><Folder size={16}/><span>{r.label}<small>{r.status==='scanning'?'正在建立索引…':r.status==='offline'?'目录离线':r.status==='error'?'索引失败':`${r.scannedFiles} 项 · ${r.permission==='write'?'可整理':'只读'}`}</small></span>{r.status==='scanning'&&<LoaderCircle size={13} className="spin"/>}</button>)}{!roots.length&&<p>连接本机目录后，即可检索与整理文件。</p>}<div className="academic-location-note">已有论文继续由论文工作区管理。外部目录原件不包含在工作台完整备份中。</div></aside>
 <div className="academic-file-browser library-reference-browser">
 {group==='paper'&&page&&<ProcessingControls processing={processing} resourceIds={processingIds} pageOnly expanded={processingOpen} onExpandedChange={setProcessingOpen}/>}
 {!group&&rootId&&!query&&<div className="academic-file-breadcrumb"><button onClick={()=>{setFolder('');setQuery('');}}>{root?.label||'全部位置'}</button>{!group&&folder.split('/').filter(Boolean).map((part,i,all)=><span key={i}><ChevronRight size={12}/><button onClick={()=>setFolder(all.slice(0,i+1).join('/'))}>{part}</button></span>)}{loading||page?.indexing?<small><LoaderCircle size={12} className="spin"/>索引更新中</small>:<small>{page?.total||0} 项{group?` · ${RESOURCE_GROUP_LABELS[group]}`:''}</small>}</div>}
 {(error||root?.error)&&<div className="academic-inline-error" role="alert">{error||root?.error}<button onClick={()=>void load()}>重试</button></div>}
 {showHistory&&<div className="academic-operation-history"><h3>最近整理记录</h3>{operations.length?operations.slice(0,12).map(o=><div key={o.id}><span><strong>{o.kind==='create-file'?'新建文件':o.kind==='mkdir'?'新建目录':o.kind==='move'?'移动 / 重命名':'移至回收站'}</strong><small>{o.source?.path||o.destination?.path||o.label} {o.destination&&o.source?`→ ${o.destination.path}`:''}</small><small>{prettyDate(o.createdAt)} · {o.status==='undone'?'已撤销':o.status==='failed'?'失败':o.status==='interrupted'?'待恢复':'已完成'}</small></span>{o.undoable&&o.status==='applied'&&<button disabled={busy} onClick={()=>void undo(o)}><RotateCcw size={13}/>撤销</button>}{o.recovery&&o.status==='undone'&&<a href={`/api/workspace/operations/${o.id}/recovery`} download><Download size={13}/>下载恢复副本</a>}{o.error&&<small>{o.error}</small>}</div>):<p>尚无文件整理操作。</p>}</div>}
 {libraryView==='files'&&(group==='paper'&&topicId?<TopicLibraryReferences key={topicId} {...referenceProps} topicId={topicId} priorityUnavailable={page?.priorityUnavailable} onError={onError} onPriorityChange={priorityChanged}/>:<ReferenceList {...referenceProps}/>)}
 {page&&page.total>60&&<div className="academic-pagination"><button disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-60))}>上一页</button><span>{offset+1}–{Math.min(offset+60,page.total)} / {page.total}</span><button disabled={offset+60>=page.total} onClick={()=>setOffset(offset+60)}>下一页</button></div>}
 </div>
 {selected&&<aside className="academic-resource-detail"><header><h2>文件详情</h2><button aria-label="关闭文件详情" onClick={()=>{selectionId.current++;setSelected(undefined);}}><X size={17}/></button></header><div className="academic-resource-name">{selected.kind==='directory'?<Folder size={28}/>:<File size={28}/>}<h3>{selected.title||selected.name}</h3>{selected.titleZh&&<p>{selected.titleZh}</p>}<p>{[selected.venue,selected.year].filter(Boolean).join(' ')}{selected.venue||selected.year?' · ':''}{selected.path}</p><small>{selectedRoot?.label} · {bytes(selected.size)}</small></div>{selected.missing?<div className="academic-inline-error">原文件已失联，标签与关联仍保留。<button onClick={()=>openDialog('relink')}>重新定位</button></div>:selected.kind==='file'&&<div className="academic-resource-preview">{/\.pdf$/i.test(selected.name)?<iframe src={raw} title={`${selected.name} PDF 预览`}/>:/\.(png|jpe?g|webp|gif)$/i.test(selected.name)?<img src={raw} alt={selected.name}/>:text?<pre>{text}</pre>:<p>此格式可下载后使用对应应用查看。</p>}</div>}
 <div className="academic-resource-actions">{selected.kind==='file'&&<button className="academic-primary" onClick={()=>setReading(selected)}>{selected.missing?'查看与编辑已有笔记':'阅读与笔记'}</button>}{!selected.missing&&<><a className="academic-secondary" href={raw} download={selected.name}><Download size={14}/>下载</a><button className="academic-secondary" onClick={()=>void api(`/api/workspace/resources/${selected.id}/reveal`,json('POST',{})).catch(e=>onError(e.message))}><FolderOpen size={14}/>{typeof navigator!=='undefined'&&/Win/i.test(navigator.userAgent)?'资源管理器':'Finder'}</button></>}{selectedRoot?.permission==='write'&&!selected.missing&&<><button className="academic-secondary" onClick={()=>openDialog('rename')}><Pencil size={14}/>重命名</button><button className="academic-secondary" onClick={()=>openDialog('move')}><Folder size={14}/>移动</button><button className="academic-secondary danger" onClick={()=>openDialog('trash')}><Trash2 size={14}/>移至回收站</button></>}</div>
 {selectionError&&<div className="academic-inline-error" role="alert">详情读取失败：{selectionError}<button onClick={()=>void select(selected)}>重新读取详情</button></div>}
 {metadataConflict&&<div className="academic-metadata-conflict" role="alert"><strong>标题、标签或课题关联已在其他窗口更新</strong><p>当前编辑的标题：{displayTitle||'尚未填写'}</p><p>磁盘标题：{metadataConflict.resource.title||'尚未填写'}</p><p>当前编辑的标签：{tags||'无'}</p><p>磁盘标签：{metadataConflict.resource.tags.join('，')||'无'}</p><p>磁盘关联课题：{metadataConflict.topics.filter(t=>t.resourceIds.includes(selected.id)).map(t=>t.title).join('、')||'无'}</p><div><button className="academic-secondary" onClick={()=>resolveMetadata(true)}>载入磁盘版本</button><button className="academic-secondary" onClick={()=>resolveMetadata(false)}>已比较，继续编辑</button></div></div>}
 <label className="academic-detail-label">显示标题<input maxLength={1000} disabled={selectionLoading||busy||!!selectionError||!!metadataConflict} value={displayTitle} onChange={e=>setDisplayTitle(e.target.value)} placeholder="填写论文原题"/></label>
 <label className="academic-detail-label"><Tag size={14}/>标签<input disabled={selectionLoading||busy||!!selectionError||!!metadataConflict} value={tags} onChange={e=>setTags(e.target.value)} placeholder="用逗号分隔"/></label><fieldset disabled={selectionLoading||busy||!!selectionError||!!metadataConflict} className="academic-topic-links"><legend><Link size={14}/>关联课题</legend>{selectionTopics.filter(t=>!t.archived).map(t=><label className="academic-checkbox" key={t.id}><input type="checkbox" checked={topicLinks.includes(t.id)} onChange={()=>setTopicLinks(values=>values.includes(t.id)?values.filter(id=>id!==t.id):[...values,t.id])}/>{t.title}</label>)}{!selectionTopics.length&&<small>可在“研究课题”中建立课题。</small>}</fieldset><button className="academic-primary" disabled={busy||selectionLoading||!!selectionError||!!metadataConflict} onClick={()=>void saveMetadata()}>{selectionLoading?<LoaderCircle size={14} className="spin"/>:<Check size={14}/>}保存标题、标签与关联</button>
 </aside>}
 </div>
 {reading&&<Suspense fallback={<p role="status">正在打开文献…</p>}><ResourceReader key={reading.id} resource={reading} initialPage={reading.searchMatch?.page} onGuardChange={setReaderGuard} onClose={()=>setReading(undefined)}/></Suspense>}
 {dialog&&<HubDialog title={{connect:'连接学术文件夹',root:'连接目录设置',mkdir:'新建目录','create-file':'新建文本文件',rename:'重命名原文件',move:'移动原文件',trash:'移至可恢复回收站',relink:'重新定位文件'}[dialog]} onClose={()=>{if(!busy)setDialog(undefined);}}><form onSubmit={submit} className="academic-form">{['connect','root'].includes(dialog)?<><label>名称<input value={label} onChange={e=>setLabel(e.target.value)} placeholder="例如：论文阅读资料"/></label><label>本机完整路径<input required value={path} disabled={dialog==='root'} onChange={e=>setPath(e.target.value)} placeholder="/Users/你的用户名/…"/></label><label>访问权限<select value={permission} onChange={e=>setPermission(e.target.value as 'read'|'write')}><option value="write">读取与整理 · 允许移动、重命名、可恢复删除</option><option value="read">只读 · 仅索引与预览</option></select></label><p className="academic-help">只索引你选择的目录。连接不会自动移动或复制原文件，工作台受管理目录由专用工作区处理。</p></>:dialog==='trash'?<><p>将“{selected?.name}”移至该目录的工作台回收站。</p><p className="academic-help">可以从整理记录中恢复。恢复时原位置被占用会保留双方文件。</p></>:<>{(dialog==='move'||dialog==='relink')&&<label>目标位置<select required value={destinationRootId} onChange={e=>setDestinationRootId(e.target.value)}>{roots.filter(r=>r.permission==='write'||dialog==='relink').map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select></label>}<label>{dialog==='rename'?'新名称':'相对于所选目录的路径'}<input required value={path} onChange={e=>setPath(e.target.value)} placeholder={dialog==='mkdir'?'输入新目录名称':'例如：reading/paper.pdf'}/></label>{dialog==='create-file'&&<><label>文件内容<textarea rows={7} value={newContent} onChange={e=>setNewContent(e.target.value)} placeholder="可留空，使用 UTF-8 保存"/></label><p className="academic-help">在所选目录创建原文件。重名不会覆盖，建议使用 .md 或 .txt 扩展名。</p></>}{dialog==='move'&&<p className="academic-help">原位置：{selected?.path}。关联随文件更新，同名文件不会被覆盖。</p>}</>}<footer><button type="button" className="academic-secondary" disabled={busy} onClick={()=>setDialog(undefined)}>取消</button><button className="academic-primary" disabled={busy}>{busy?'操作中…':dialog==='trash'?'移至回收站':'确认'}</button></footer></form></HubDialog>}
 </section>;
}
function FilesIcon(){return <FolderOpen size={16}/>;}


/** Uses the topic notebook as the shared priority source for both workspaces. */
function TopicLibraryReferences({topicId,priorityUnavailable,onError,onPriorityChange,...props}:ReferenceListProps&{topicId:string;priorityUnavailable?:boolean;onError:(message:string)=>void;onPriorityChange:()=>void}){
 const {notebook,loaded,saving,loadFailed,update,refresh}=useTopicNotebook(topicId,onError);
 useEffect(()=>{
  if(saving)return;
  const reload=()=>{if(!document.hidden)void refresh().catch(()=>{});};
  window.addEventListener('focus',reload);document.addEventListener('visibilitychange',reload);
  return()=>{window.removeEventListener('focus',reload);document.removeEventListener('visibilitychange',reload);};
 },[refresh,saving]);
 const starred=new Set(notebook.keyRefs.map(reference=>reference.resourceId));
 const toggle=(file:Resource)=>{
  if(!loaded||saving)return;
  void update(current=>({...current,keyRefs:current.keyRefs.some(reference=>reference.resourceId===file.id)?current.keyRefs.filter(reference=>reference.resourceId!==file.id):[...current.keyRefs,{resourceId:file.id,note:'',addedAt:new Date().toISOString()}]})).then(saved=>{if(saved)onPriorityChange();});
 };
 return <>{(priorityUnavailable||loadFailed)&&<div className="academic-inline-error" role="status">重点文献标记暂不可用。<button onClick={()=>void refresh().then(onPriorityChange).catch((error:Error)=>onError(error.message))}>重新读取</button></div>}<ReferenceList {...props} starred={starred} onToggleStar={toggle} starDisabled={!loaded||saving||loadFailed}/></>;
}
