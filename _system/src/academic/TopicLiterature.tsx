import {useEffect,useId,useState} from 'react';
import {Download,Search,Files,WandSparkles} from 'lucide-react';
import type {ResearchTopic,WorkspaceOverview,ResourcePage,LiteratureImportResult} from '../../shared/workspace-types';
import {api,json} from '../api';
import LiteratureAnalysisPanel from './LiteratureAnalysisPanel';
import TopicKnowledgeGraph from './TopicKnowledgeGraph';
import {ProcessingControls,useReadingProcessing} from './ReadingProcessing';
import ReferenceList from './ReferenceList';
import ResourceReader from './ResourceReader';
import {PdfImportButton,PdfImportFeedback,type PdfImporter} from './PdfImport';
import {resourceGroup} from '../../shared/resource-kind';
import type {Resource} from '../../shared/workspace-types';
interface Paper {id:string;title:string;summary:string;authors:string[];published:string;url:string}
export default function TopicLiterature({topic,overview,onRefresh,onError,starred,onToggleStar,starDisabled,priorityUnavailable,onRetryPriority,onFiles,onOpenPaper,onOpenTopicNote,importer,onGuardChange,onReaderGuard}:{topic:ResearchTopic;overview?:WorkspaceOverview;onRefresh:()=>Promise<void>;onError:(s:string)=>void;starred?:Set<string>;onToggleStar?:(file:Resource)=>void;starDisabled?:boolean;priorityUnavailable?:boolean;onRetryPriority?:()=>void;onFiles?:(files:Resource[])=>void;onOpenPaper?:(file:Resource)=>void;onOpenTopicNote?:(file:Resource)=>void;importer:PdfImporter;onGuardChange?:(guard:(()=>Promise<boolean>)|undefined)=>void;onReaderGuard?:(guard:(()=>Promise<boolean>)|undefined)=>void}){
 const [busy,setBusy]=useState(false),[query,setQuery]=useState(''),[results,setResults]=useState<Paper[]>([]),[message,setMessage]=useState(''),[searched,setSearched]=useState(false),[resources,setResources]=useState<ResourcePage>(),[workspaceView,setWorkspaceView]=useState<'collect'|'notes'|'analyze'|'graph'|'search'>('collect'),[reading,setReading]=useState<Resource>();
 const [resourceError,setResourceError]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();
  setResourceError('');
  void api<ResourcePage>(`/api/workspace/resources?topicId=${encodeURIComponent(topic.id)}&limit=1000&deduplicate=true&starredFirst=true`,{signal:controller.signal,timeoutMs:30000})
   .then(value=>{if(!controller.signal.aborted)setResources(value);})
   .catch((error:Error)=>{if(!controller.signal.aborted)setResourceError(error.message);});
  return()=>controller.abort();
 },[topic.id,topic.revision,topic.resourceIds.join(','),retry]);
 useEffect(()=>{if(importer.busy)setWorkspaceView('collect');},[importer.busy]);
 async function search(model:boolean){if(!query.trim())return;setBusy(true);setMessage('');setResults([]);setSearched(false);try{let keywords=query.trim();if(model){setMessage('模型正在整理检索词…');const result=await api<{query:string}>('/api/workspace/literature/query',json('POST',{question:query}));keywords=result.query;}setMessage(`检索词：${keywords}`);const result=await api<{papers:Paper[]}>(`/api/workspace/literature?q=${encodeURIComponent(keywords)}`);setResults(result.papers);setSearched(true);}catch(e:any){onError(e.message);}finally{setBusy(false);}}
 async function download(paper:Paper){
  setBusy(true);
  try{
   const result=await api<LiteratureImportResult>(`/api/workspace/topics/${topic.id}/download`,json('POST',{expectedRevision:topic.revision,arxivId:paper.id}));
   setMessage(result.alreadyLinked?`本课题已收录 ${result.resource.name}`:result.reused?`已关联已有文献 ${result.resource.name}，阅读与翻译共用缓存`:`已保存 ${result.resource.name}`);
   await onRefresh().catch((error:Error)=>onError('文献已收录，列表刷新失败。'+error.message));
  }catch(error:any){onError(error.message);}
  finally{setBusy(false);}
 }
 const linkedIds=new Set(topic.resourceIds);
 const files=(resources?.resources||overview?.resources||[]).filter(r=>linkedIds.has(r.id)),roots=resources?.roots||overview?.roots||[];
 const loadingResources=!resources&&!resourceError&&topic.resourceIds.length>0;
 useEffect(()=>{onFiles?.(files);},[resources,topic.revision,topic.resourceIds.join(',')]);
 function openNote(file:Resource){const source=roots.find(root=>root.id===file.rootId);if(onOpenTopicNote&&source?.path.replace(/\\/g,'/').endsWith(`/workspace/research-notes/${topic.id}/课题笔记`))onOpenTopicNote(file);else setReading(file);}
 const papers=files.filter(f=>f.kind==='file'&&resourceGroup(f.name)==='paper'),notes=files.filter(f=>f.kind!=='file'||resourceGroup(f.name)!=='paper');
 const processing=useReadingProcessing(papers.map(paper=>paper.id));
 const [analysisOpened,setAnalysisOpened]=useState(false);
 const [processingOpen,setProcessingOpen]=useState(false);
 const processingControlsId=useId();
 const processingExpanded=workspaceView==='collect'&&processingOpen;
 return <section className="topic-literature">
 <header className="topic-literature-head">
  <nav className="topic-literature-tabs" aria-label="文献工作区视图">
   <button aria-pressed={workspaceView==='collect'} onClick={()=>setWorkspaceView('collect')}>文献<span>{papers.length}</span></button>
   <button aria-pressed={workspaceView==='notes'} onClick={()=>setWorkspaceView('notes')}>笔记与整理<span>{notes.length}</span></button>
   <button aria-pressed={workspaceView==='graph'} onClick={()=>setWorkspaceView('graph')}>知识关系图</button>
   <button aria-pressed={workspaceView==='analyze'} onClick={()=>{setAnalysisOpened(true);setWorkspaceView('analyze');}}>文献分析</button>
   <button aria-pressed={workspaceView==='search'} onClick={()=>setWorkspaceView('search')}><Search size={13}/>检索新文献</button>
  </nav>
  <div className="topic-literature-actions" hidden={workspaceView!=='collect'}>
   <button className={`academic-secondary topic-processing-entry ${processing.snapshot?.settings.enabled?'is-enabled':''}`} aria-label="自动整理翻译" aria-expanded={processingExpanded} aria-controls={processingControlsId} title={processing.snapshot?`自动处理${processing.snapshot.settings.enabled?'已开启':'已关闭'}，点击${processingExpanded?'收起':'展开'}设置`:'正在读取自动处理设置'} onClick={()=>{setWorkspaceView('collect');setProcessingOpen(!processingExpanded);}}>
    <WandSparkles size={13}/><span>自动整理翻译</span><span className="processing-state-dot" aria-hidden="true"/>
   </button>
   <PdfImportButton importer={importer}/>
  </div>
 </header>
 <PdfImportFeedback importer={importer} showDestination={workspaceView==='collect'&&papers.length===0}/>
 {message&&<p role="status" className="topic-literature-message">{message}</p>}
 {resourceError&&<div role="alert" className="academic-inline-error">文献列表读取失败。{resourceError}<button onClick={()=>setRetry(value=>value+1)}>重试</button></div>}
 {workspaceView==='collect'&&(priorityUnavailable||resources?.priorityUnavailable&&starDisabled)&&<div role="status" className="academic-inline-error">重点文献标记暂不可用。<button onClick={()=>{onRetryPriority?.();setRetry(value=>value+1);}}>重新读取</button></div>}
 <div hidden={workspaceView!=='collect'}>
  <ProcessingControls processing={processing} resourceIds={papers.map(paper=>paper.id)} id={processingControlsId} expanded={processingOpen} onExpandedChange={setProcessingOpen}/>
  {papers.length>0?<ReferenceList topicId={topic.id} processing={processing} files={papers} onOpen={onOpenPaper||setReading} starred={starred} onToggleStar={onToggleStar} starDisabled={starDisabled}/>:loadingResources?<p role="status" className="topic-literature-message">正在读取文献…</p>:!resourceError&&<div className="topic-literature-empty"><Files size={26}/><strong>把论文 PDF 拖到这里</strong><p>或点击“添加 PDF”，也可以在“检索新文献”中从 arXiv 下载。</p></div>}
 </div>
 <div hidden={workspaceView!=='notes'}>
  {notes.length>0?<ReferenceList topicId={topic.id} files={notes} onOpen={openNote} variant="notes"/>:<div className="topic-literature-empty"><Files size={26}/><strong>还没有笔记或整理文档</strong><p>阅读时写的笔记保存在每篇文献的阅读器中；Markdown 笔记、AI 分析报告和 .bib 等关联到本课题后会出现在这里。</p></div>}
 </div>
 <div hidden={workspaceView!=='search'} className="topic-literature-search-pane">
  <form className="topic-literature-search" onSubmit={e=>{e.preventDefault();void search(false);}}><textarea id="literature-query" aria-label="检索问题或关键词" rows={2} maxLength={3000} value={query} onChange={e=>setQuery(e.target.value)} placeholder="输入研究问题，或英文关键词"/><div><button className="academic-secondary" disabled={busy||importer.busy||!query.trim()}><Search size={14}/>关键词检索</button><button type="button" className="academic-primary" disabled={busy||importer.busy||!query.trim()} onClick={()=>void search(true)}>模型辅助检索</button><small>来源 arXiv · 模型只整理检索词，文献信息来自实际检索</small></div></form>
  {searched&&!results.length&&<p className="topic-rail-empty">没有找到匹配文章，请换一组关键词。</p>}
  <div className="topic-literature-results">{results.map(p=><article key={p.id}><a href={p.url} target="_blank" rel="noreferrer"><strong>{p.title}</strong></a><small>{p.authors.slice(0,6).join(', ')}{p.authors.length>6?' 等':''} · {p.published.slice(0,10)} · arXiv:{p.id}</small><p>{p.summary}</p><button className="academic-secondary" disabled={busy||importer.busy} onClick={()=>void download(p)}><Download size={14}/>存入参考文献</button></article>)}</div>
 </div>
 {analysisOpened&&<div hidden={workspaceView!=='analyze'}><LiteratureAnalysisPanel active={workspaceView==='analyze'} key={topic.id} topic={topic} files={papers} onError={onError} onRefresh={onRefresh}/></div>}
 {workspaceView==='graph'&&<TopicKnowledgeGraph key={topic.id} topicId={topic.id} revision={topic.revision}/>}
 {reading&&<ResourceReader key={reading.id} resource={reading} initialPage={reading.searchMatch?.page} onGuardChange={onReaderGuard||onGuardChange} onClose={()=>setReading(undefined)}/>}
 </section>;
}
