import ResearchTextEditor from './ResearchTextEditor';
import ResearchMap from './ResearchMap';
import {RESEARCH_BASIS_TEMPLATE} from '../../shared/research-basis';
import {useCallback,useEffect,useRef,useState} from 'react';
import {BookOpen,Files,FolderKanban,Plus,Presentation,ArrowUpRight,Archive,ChevronRight,Pencil} from 'lucide-react';
import {RESEARCH_STAGES,type ResearchStage,type ResearchTopic,type WorkspaceOverview} from '../../shared/workspace-types';
import type {PresentationSummary} from '../../shared/presentation-types';
import type {Project} from '../../shared/types';
import {api,json,prettyDate,downloadText} from '../api';
import HubDialog from './HubDialog';
import TopicMain from './TopicMain';
import {usePdfImport,PdfImportOverlay} from './PdfImport';
import {IDEA_KIND_LABELS,type TopicNotebook} from '../../shared/topic-notebook';
import TopicEditComparison from './TopicEditComparison';
import {topicEditorPayload} from './topic-editor';
import './TopicWorkspace.css';

type TopicEditorSection='basis'|'papers'|'presentations';

export default function Topics({initialTopicId,overview,papers,decks,onRefresh,onNavigate,onError,onClearTopic,registerGuard}:{initialTopicId?:string;overview?:WorkspaceOverview;papers:Project[];decks:PresentationSummary[];onRefresh:()=>Promise<void>;onNavigate:(path:string)=>void;onError:(error:string)=>void;onClearTopic?:()=>void;registerGuard:(guard:(()=>Promise<boolean>)|undefined)=>void}) {
 const [selected,setSelected]=useState(initialTopicId||''),[editing,setEditing]=useState<ResearchTopic|null|undefined>(),[busy,setBusy]=useState(false),[archived,setArchived]=useState(false);
 useEffect(()=>{setSelected(initialTopicId||'');},[initialTopicId]);
 const [stage,setStage]=useState<ResearchStage|'未标注'>('ideation');
 const [mapPaper,setMapPaper]=useState('');
 const [researchBasis,setResearchBasis]=useState('');
 const [editorSection,setEditorSection]=useState<TopicEditorSection>();
 const [title,setTitle]=useState(''),[description,setDescription]=useState(''),[paperIds,setPaperIds]=useState<string[]>([]),[presentationIds,setPresentationIds]=useState<string[]>([]);
 const [editError,setEditError]=useState(''),[comparison,setComparison]=useState<ResearchTopic>();
 const topics=(overview?.topics||[]).filter(t=>t.archived===archived),topic=selected?overview?.topics.find(t=>t.id===selected):undefined;
 useEffect(()=>{const target=overview?.topics.find(t=>t.id===initialTopicId);if(target)setArchived(target.archived);},[initialTopicId,overview]);
 const importer=usePdfImport({target:topic?{topicId:topic.id,expectedRevision:topic.revision}:undefined,destination:topic?`${topic.title} / 参考文献`:'课题参考文献',blocked:topic?(topic.archived?'恢复课题后可导入 PDF。':undefined):'进入具体课题后，可将 PDF 拖入本页。',onImported:async()=>{await onRefresh();}});
 const noteGuard=useRef<(()=>Promise<boolean>)|undefined>(undefined),readerGuard=useRef<(()=>Promise<boolean>)|undefined>(undefined),busyRef=useRef(busy);busyRef.current=busy;
 const setNoteGuard=useCallback((guard:(()=>Promise<boolean>)|undefined)=>{noteGuard.current=guard;},[]);
 const setReaderGuard=useCallback((guard:(()=>Promise<boolean>)|undefined)=>{readerGuard.current=guard;},[]);
 useEffect(()=>{registerGuard(async()=>!busyRef.current&&await importer.waitForIdle()&&(!noteGuard.current||await noteGuard.current())&&(!readerGuard.current||await readerGuard.current()));return()=>registerGuard(undefined);},[registerGuard,importer.waitForIdle]);
 const choose=(id:string)=>{onNavigate(`/topics?topic=${encodeURIComponent(id)}`);};
 const activity=topic?[
  {key:`topic-${topic.id}`,label:'更新课题信息与关联',name:topic.title,time:topic.updatedAt},
  ...papers.filter(p=>topic.paperIds.includes(p.id)).map(p=>({key:`paper-${p.id}`,label:'论文最近编辑',name:p.title,time:p.lastEditedAt||p.updatedAt})),
  ...decks.filter(p=>topic.presentationIds.includes(p.id)).map(p=>({key:`ppt-${p.id}`,label:'汇报最近编辑',name:p.title,time:p.updatedAt})),
  ...(overview?.resources||[]).filter(r=>topic.resourceIds.includes(r.id)).map(r=>({key:`file-${r.id}`,label:r.missing?'资料最近修改 · 当前失联':'资料最近修改',name:r.title||r.name,time:r.modifiedAt})),
  ...(overview?.operations||[]).filter(o=>o.resourceId&&topic.resourceIds.includes(o.resourceId)).map(o=>({key:`operation-${o.id}`,label:o.status==='undone'?'撤销文件整理':o.status==='failed'?'文件整理失败':'文件整理记录',name:o.source?.path||o.destination?.path||'',time:o.createdAt})),
 ].sort((a,b)=>b.time.localeCompare(a.time)).slice(0,6):[];
 const edit=(value:ResearchTopic|null,section?:TopicEditorSection)=>{
  setEditing(value?structuredClone(value):null);
  setEditorSection(section);
  setStage(value?.stage||(value?'未标注':'ideation'));
  setTitle(value?.title||'');
  setDescription(value?.description||'');
  setResearchBasis(value?.researchBasis||'');
  setPaperIds(value?.paperIds||[]);
  setPresentationIds(value?.presentationIds||[]);
  setEditError('');
  setComparison(undefined);
 };
 const draft={title,description,researchBasis,paperIds,presentationIds,...(stage!=='未标注'?{stage}:{})};
 const dirty=editing!==undefined&&JSON.stringify(topicEditorPayload(draft))!==JSON.stringify(topicEditorPayload(editing||{title:'',description:'',paperIds:[],presentationIds:[],stage:'ideation'}));
 function closeEditor(){if(busy||dirty&&!window.confirm('课题编辑尚未保存。放弃本地修改并关闭？'))return;setEditing(undefined);setComparison(undefined);setEditError('');}
 function downloadDraft(){downloadText(`${editing?.id||'new-topic'}-local-draft.json`,JSON.stringify({topicId:editing?.id,baselineRevision:editing?.revision,...draft},null,2));}
 async function readComparison(){if(!editing)return;setBusy(true);try{const result=await api<{topics:ResearchTopic[]}>('/api/workspace/topics');const latest=result.topics.find(t=>t.id===editing.id);setComparison(latest);if(!latest)setEditError('此课题已不存在或不可用。本地输入仍保留，请先下载草稿。');}catch(e:any){setEditError(e.message+' 本地输入仍保留。');}finally{setBusy(false);}}
 function loadComparedVersion(){if(!comparison||!window.confirm('载入服务器版本将替换当前编辑内容。请先下载本地草稿，随后手动合并。继续载入？'))return;edit(comparison);}
 const check=(values:string[],id:string)=>values.includes(id)?values.filter(v=>v!==id):[...values,id];
 async function save(e:React.FormEvent){e.preventDefault();if(!title.trim()||comparison)return;setBusy(true);setEditError('');try{const result=await api<ResearchTopic>(`/api/workspace/topics${editing?`/${editing.id}`:''}`,json(editing?'PATCH':'POST',topicEditorPayload(draft,editing)));busyRef.current=false;setBusy(false);choose(result.id);setEditing(undefined);await onRefresh().catch((e:any)=>onError('课题已保存，但列表刷新失败：'+e.message));}catch(e:any){setEditError(e.message+' 本地输入仍保留。'+(e.status===409?'请重读并比较当前版本；不会自动重试。':''));}finally{setBusy(false);}}
 async function toggleArchive(value:ResearchTopic){try{if(noteGuard.current&&!await noteGuard.current())return;if(readerGuard.current&&!await readerGuard.current())return;await api(`/api/workspace/topics/${value.id}`,json('PATCH',{archived:!value.archived,expectedRevision:value.revision}));await onRefresh();}catch(e:any){onError(e.message);}}
 const linkedPapers=topic?topic.paperIds.map(id=>({id,paper:papers.find(p=>p.id===id)})):[];
 const linkedDecks=topic?topic.presentationIds.map(id=>({id,deck:decks.find(p=>p.id===id)})):[];
 return <section className="academic-page topic-workspace-page">
 <PdfImportOverlay importer={importer}/>
 {!topic&&<><div className="academic-page-heading"><div><h1>问题与选题</h1></div><div className="topic-heading-actions">{overview&&<div className="academic-tabs topic-archive-tabs"><button className={!archived?'active':''} onClick={()=>setArchived(false)}>进行中</button><button className={archived?'active':''} onClick={()=>setArchived(true)}>已归档</button></div>}{(!overview||topics.length>0||archived)&&<button className="academic-primary" onClick={()=>edit(null)}><Plus size={16}/>新建课题</button>}</div></div>
 {overview&&selected&&<p role="status" className="academic-inline-error">此课题不存在或已不可用，请从下方选择课题。</p>}
 {!overview?<p role="status">正在加载课题…</p>:topics.length?<ul className="topic-directory" aria-label={archived?'已归档课题':'进行中的课题'}>{topics.map(t=><li key={t.id}><TopicRow topic={t} onOpen={()=>choose(t.id)}/></li>)}</ul>:<div className="academic-empty"><FolderKanban size={28}/><h2>{archived?'暂无归档课题':'还没有研究课题'}</h2>{!archived&&<button className="academic-primary" onClick={()=>edit(null)}><Plus size={15}/>建立第一个课题</button>}</div>}</>}
 {topic&&<>
 <header className="topic-hero">
  <div className="topic-hero-main">
   <div className="topic-hero-meta">
    <h1>{topic.title}</h1>
    {topic.stage&&<span className="topic-stage">{RESEARCH_STAGES[topic.stage]}</span>}
    {topic.archived&&<span className="topic-stage">已归档</span>}
   </div>
   {topic.description&&<p className="topic-question">{topic.description}</p>}
  </div>
  <div className="topic-hero-actions">
   <button className="topic-archive-action" onClick={()=>void toggleArchive(topic)} title={topic.archived?'取消归档':'归档课题'}><Archive size={14}/>{topic.archived?'取消归档':'归档'}</button>
   <button className="academic-secondary" onClick={()=>edit(topic)}><Pencil size={14}/>编辑课题</button>
  </div>
 </header>
 <div className="topic-workspace-grid">
  <div className="topic-workspace-main" id="topic-literature"><TopicMain importer={importer} key={topic.id} topic={topic} overview={overview} onRefresh={onRefresh} onError={onError} onGuardChange={setNoteGuard} onReaderGuard={setReaderGuard}/></div>
  <aside className="topic-rail" aria-label="课题信息">
   <section className="topic-rail-section">
    <header>
     <h2>研究依据</h2>
     <button className="topic-rail-action" onClick={()=>edit(topic,'basis')}>{topic.researchBasis?.trim()?'编辑':'补充'}</button>
    </header>
    {topic.researchBasis?.trim()?<p className="topic-basis">{topic.researchBasis}</p>:<p className="topic-rail-empty">待填写前置文献、研究边界与验证依据。</p>}
   </section>
   <section className="topic-rail-section">
    <header>
     <h2>关联论文 {linkedPapers.length>0&&<small>{linkedPapers.length}</small>}</h2>
     <button className="topic-rail-action" aria-label="管理关联论文" onClick={()=>edit(topic,'papers')}>{linkedPapers.length?'管理':'关联'}</button>
    </header>
    {linkedPapers.length?<ul className="topic-rail-list">{linkedPapers.map(({id,paper})=><li key={id}>
     <button className="topic-rail-link" onClick={()=>onNavigate(`/papers/${encodeURIComponent(id)}/writing`)} title={paper?.title||id}>
      <BookOpen size={15}/><span>{paper?.title||id}</span><ArrowUpRight size={13}/>
     </button>
     <button className="topic-rail-sub" onClick={()=>setMapPaper(id)}>研究脉络与方案对照</button>
    </li>)}</ul>:<p className="topic-rail-empty">暂无关联论文。</p>}
   </section>
   {linkedDecks.length>0?<section className="topic-rail-section">
    <header><h2>关联汇报</h2><button className="topic-rail-action" aria-label="管理关联汇报" onClick={()=>edit(topic,'presentations')}>管理</button></header>
    <ul className="topic-rail-list">{linkedDecks.map(({id,deck})=><li key={id}><button className="topic-rail-link" onClick={()=>onNavigate(`/presentations/${encodeURIComponent(id)}`)} title={deck?.title||id}><Presentation size={15}/><span>{deck?.title||id}</span><ArrowUpRight size={13}/></button></li>)}</ul>
   </section>:<div className="topic-rail-section">
    <button className="topic-rail-link" onClick={()=>decks.length?edit(topic,'presentations'):onNavigate('/presentations')}>
     <Presentation size={15}/><span>{decks.length?'关联汇报':'新建汇报'}</span><Plus size={13}/>
    </button>
   </div>}
   {activity.length>0&&<details className="topic-rail-section topic-rail-activity">
    <summary>最近活动 <small>{activity.length}</small></summary>
    <ul className="topic-activity">{activity.map(item=><li key={item.key}><span>{item.label}</span><strong title={item.name}>{item.name}</strong><time dateTime={item.time}>{prettyDate(item.time)}</time></li>)}</ul>
   </details>}
  </aside>
 </div></>}
 {topic&&mapPaper&&topic.paperIds.includes(mapPaper)&&<HubDialog wide title={`研究对照 · ${papers.find(p=>p.id===mapPaper)?.title||mapPaper}`} onClose={()=>setMapPaper('')}><div className="topic-map-dialog"><ResearchMap key={`${topic.id}:${mapPaper}`} projectId={mapPaper}/></div></HubDialog>}
 {editing!==undefined&&<HubDialog title={editing?'编辑研究课题':'新建研究课题'} onClose={closeEditor} wide initialFocus={editorSection?
  editorSection==='basis'?'[data-topic-editor="basis"] > summary':`[data-topic-editor="${editorSection}"]`:undefined}>
 <form className="academic-form" onSubmit={save}><label>课题名称<input required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} placeholder="例如：推理过程中的偏好优化"/></label><label>当前研究阶段<select value={stage} onChange={e=>setStage(e.target.value as typeof stage)}><option value="未标注" disabled>尚未标注阶段</option>{Object.entries(RESEARCH_STAGES).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><label>研究问题、现有工作与可行性<ResearchTextEditor aria-label="研究问题、现有工作与可行性" maxLength={10000} rows={3} value={description} onChange={setDescription} placeholder="你正在解决什么问题？"/></label><details data-topic-editor="basis" open={editorSection==='basis'||!!researchBasis}><summary>研究依据</summary><label>具体前置文献、边界、承接与证据<ResearchTextEditor aria-label="研究依据" rows={12} value={researchBasis} onChange={setResearchBasis}/></label><button type="button" onClick={()=>setResearchBasis(v=>v||RESEARCH_BASIS_TEMPLATE)}>填入空白模板</button><small>内容非空不代表已验证；不自动同步到论文。</small></details><div className="academic-form-columns"><fieldset data-topic-editor="papers" tabIndex={-1}><legend>关联现有论文</legend>{papers.filter(p=>!p.trashed).map(p=><label className="academic-checkbox" key={p.id}><input type="checkbox" checked={paperIds.includes(p.id)} onChange={()=>setPaperIds(check(paperIds,p.id))}/><span>{p.title}</span></label>)}{!papers.length&&<small>暂无论文</small>}</fieldset><fieldset data-topic-editor="presentations" tabIndex={-1}><legend>关联已有汇报</legend>{decks.map(p=><label className="academic-checkbox" key={p.id}><input type="checkbox" checked={presentationIds.includes(p.id)} onChange={()=>setPresentationIds(check(presentationIds,p.id))}/><span>{p.title}</span></label>)}{!decks.length&&<small>暂无汇报</small>}</fieldset></div><p className="academic-help">文件可在资料库中关联到课题。关联只记录关系，原文件保持原位。</p>{editError&&<p className="academic-inline-error" role="alert">{editError}</p>}{editError&&editing&&<button type="button" className="academic-secondary" disabled={busy} onClick={()=>void readComparison()}>重读课题以比较</button>}{editError&&!comparison&&<button type="button" className="academic-secondary" onClick={downloadDraft}>下载本地草稿</button>}{editing&&comparison&&<TopicEditComparison baseline={editing} latest={comparison} draft={draft} paperNames={Object.fromEntries(papers.map(p=>[p.id,p.title]))} deckNames={Object.fromEntries(decks.map(p=>[p.id,p.title]))} onDownload={downloadDraft} onLoad={loadComparedVersion}/>}<footer><button type="button" className="academic-secondary" disabled={busy} onClick={closeEditor}>取消</button><button className="academic-primary" disabled={busy||!title.trim()||!!comparison}>{busy?'保存中…':'保存课题'}</button></footer></form></HubDialog>}
 </section>;
}

type TopicWithSummary = ResearchTopic & {
 latestIdea?: TopicNotebook['ideas'][0];
 openIdeaCount?: number;
 keyRefCount?: number;
};

/** Directory row for opening the topic and seeing its recent work. */
function TopicRow({topic,onOpen}:{topic:ResearchTopic;onOpen:()=>void}){
 const t = topic as TopicWithSummary;
 const hasSummary = t.latestIdea !== undefined || t.openIdeaCount !== undefined || t.keyRefCount !== undefined;
 const [notebook,setNotebook]=useState<TopicNotebook>();
 const [visible,setVisible]=useState(false);
 const buttonRef=useRef<HTMLButtonElement>(null);
 useEffect(()=>{
  if(hasSummary)return;
  const element=buttonRef.current;
  if(!element)return;
  const observer=new IntersectionObserver(([entry])=>{
   if(entry.isIntersecting){
    setVisible(true);
    observer.disconnect();
   }
  });
  observer.observe(element);
  return()=>observer.disconnect();
 },[hasSummary]);
 useEffect(()=>{
  if(hasSummary||!visible)return;
  let active=true;
  void api<{notebook:TopicNotebook}>(`/api/workspace/topics/${encodeURIComponent(topic.id)}/notebook`).then(({notebook})=>{if(active)setNotebook(notebook);}).catch(()=>{});
  return()=>{active=false;};
 },[topic.id,topic.revision,hasSummary,visible]);
 const latest=t.latestIdea??notebook?.ideas[0];
 const open=t.openIdeaCount??(notebook?.ideas.filter(idea=>(idea.kind==='question'||idea.kind==='hypothesis'||idea.kind==='todo')&&!idea.done).length||0);
 const keyRefs=t.keyRefCount??(notebook?.keyRefs.length||0);
 return <button ref={buttonRef} className="topic-directory-row" onClick={onOpen}>
  <span className="topic-directory-main">
   <strong>{topic.title}</strong>
   {topic.description&&<span className="topic-directory-description">{topic.description}</span>}
   {latest&&<span className="topic-directory-idea"><b>{IDEA_KIND_LABELS[latest.kind]}</b> {latest.text.replace(/[#*_`>]/g,'').slice(0,120)}</span>}
  </span>
  <span className="topic-directory-meta">
   <span className="topic-stage">{topic.stage?RESEARCH_STAGES[topic.stage]:'未标注阶段'}</span>
   <span>{topic.resourceIds.length} 份资料{keyRefs>0&&` · ${keyRefs} 篇重点文献`}{open>0&&` · ${open} 个待解决问题`}</span>
   <time dateTime={topic.updatedAt}>{prettyDate(topic.updatedAt)}</time>
  </span>
  <ChevronRight size={15}/>
 </button>;
}
