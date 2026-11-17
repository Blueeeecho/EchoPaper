import ResearchTextEditor from './ResearchTextEditor';
import ResearchMap from './ResearchMap';
import {RESEARCH_BASIS_TEMPLATE} from '../../shared/research-basis';
import {useCallback,useEffect,useRef,useState} from 'react';
import {BookOpen,Files,FolderKanban,Plus,Presentation,ArrowUpRight,Archive,Pencil} from 'lucide-react';
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

export default function Topics({initialTopicId,overview,papers,decks,onRefresh,onNavigate,onError,onClearTopic,registerGuard}:{initialTopicId?:string;overview?:WorkspaceOverview;papers:Project[];decks:PresentationSummary[];onRefresh:()=>Promise<void>;onNavigate:(path:string)=>void;onError:(error:string)=>void;onClearTopic?:()=>void;registerGuard:(guard:(()=>Promise<boolean>)|undefined)=>void}) {
 const [selected,setSelected]=useState(initialTopicId||''),[editing,setEditing]=useState<ResearchTopic|null|undefined>(),[busy,setBusy]=useState(false),[archived,setArchived]=useState(false);
 useEffect(()=>{setSelected(initialTopicId||'');},[initialTopicId]);
 const [stage,setStage]=useState<ResearchStage|'未标注'>('ideation');
 const [mapPaper,setMapPaper]=useState('');
 const [researchBasis,setResearchBasis]=useState('');
 const [title,setTitle]=useState(''),[description,setDescription]=useState(''),[paperIds,setPaperIds]=useState<string[]>([]),[presentationIds,setPresentationIds]=useState<string[]>([]);
 const [editError,setEditError]=useState(''),[comparison,setComparison]=useState<ResearchTopic>();
 const topics=(overview?.topics||[]).filter(t=>t.archived===archived),topic=selected?overview?.topics.find(t=>t.id===selected):undefined;
 useEffect(()=>{const target=overview?.topics.find(t=>t.id===initialTopicId);if(target)setArchived(target.archived);},[initialTopicId,overview]);
 const importer=usePdfImport({target:topic?{topicId:topic.id,expectedRevision:topic.revision}:undefined,destination:topic?`${topic.title} / 参考文献`:'课题参考文献',blocked:topic?(topic.archived?'恢复课题后可导入 PDF。':undefined):'进入具体课题后，可将 PDF 拖入本页。',onImported:async()=>{await onRefresh();}});
 const noteGuard=useRef<(()=>Promise<boolean>)|undefined>(undefined),busyRef=useRef(busy);busyRef.current=busy;
 const setNoteGuard=useCallback((guard:(()=>Promise<boolean>)|undefined)=>{noteGuard.current=guard;},[]);
 useEffect(()=>{registerGuard(async()=>!busyRef.current&&await importer.waitForIdle()&&(!noteGuard.current||await noteGuard.current()));return()=>registerGuard(undefined);},[registerGuard,importer.waitForIdle]);
 const choose=(id:string)=>{onNavigate(`/topics?topic=${encodeURIComponent(id)}`);};
 const activity=topic?[
  {key:`topic-${topic.id}`,label:'更新课题信息与关联',name:topic.title,time:topic.updatedAt},
  ...papers.filter(p=>topic.paperIds.includes(p.id)).map(p=>({key:`paper-${p.id}`,label:'论文最近编辑',name:p.title,time:p.lastEditedAt||p.updatedAt})),
  ...decks.filter(p=>topic.presentationIds.includes(p.id)).map(p=>({key:`ppt-${p.id}`,label:'汇报最近编辑',name:p.title,time:p.updatedAt})),
  ...(overview?.resources||[]).filter(r=>topic.resourceIds.includes(r.id)).map(r=>({key:`file-${r.id}`,label:r.missing?'资料最近修改 · 当前失联':'资料最近修改',name:r.title||r.name,time:r.modifiedAt})),
  ...(overview?.operations||[]).filter(o=>o.resourceId&&topic.resourceIds.includes(o.resourceId)).map(o=>({key:`operation-${o.id}`,label:o.status==='undone'?'撤销文件整理':o.status==='failed'?'文件整理失败':'文件整理记录',name:o.source?.path||o.destination?.path||'',time:o.createdAt})),
 ].sort((a,b)=>b.time.localeCompare(a.time)).slice(0,6):[];
 const edit=(value:ResearchTopic|null)=>{setEditing(value?structuredClone(value):null);setStage(value?.stage||(value?'未标注':'ideation'));setTitle(value?.title||'');setDescription(value?.description||'');setResearchBasis(value?.researchBasis||'');setPaperIds(value?.paperIds||[]);setPresentationIds(value?.presentationIds||[]);setEditError('');setComparison(undefined);};
 const draft={title,description,researchBasis,paperIds,presentationIds,...(stage!=='未标注'?{stage}:{})};
 const dirty=editing!==undefined&&JSON.stringify(topicEditorPayload(draft))!==JSON.stringify(topicEditorPayload(editing||{title:'',description:'',paperIds:[],presentationIds:[],stage:'ideation'}));
 function closeEditor(){if(busy||dirty&&!window.confirm('课题编辑尚未保存。放弃本地修改并关闭？'))return;setEditing(undefined);setComparison(undefined);setEditError('');}
 function downloadDraft(){downloadText(`${editing?.id||'new-topic'}-local-draft.json`,JSON.stringify({topicId:editing?.id,baselineRevision:editing?.revision,...draft},null,2));}
 async function readComparison(){if(!editing)return;setBusy(true);try{const result=await api<{topics:ResearchTopic[]}>('/api/workspace/topics');const latest=result.topics.find(t=>t.id===editing.id);setComparison(latest);if(!latest)setEditError('此课题已不存在或不可用。本地输入仍保留，请先下载草稿。');}catch(e:any){setEditError(e.message+' 本地输入仍保留。');}finally{setBusy(false);}}
 function loadComparedVersion(){if(!comparison||!window.confirm('载入服务器版本将替换当前编辑内容。请先下载本地草稿，随后手动合并。继续载入？'))return;edit(comparison);}
 const check=(values:string[],id:string)=>values.includes(id)?values.filter(v=>v!==id):[...values,id];
 async function save(e:React.FormEvent){e.preventDefault();if(!title.trim()||comparison)return;setBusy(true);setEditError('');try{const result=await api<ResearchTopic>(`/api/workspace/topics${editing?`/${editing.id}`:''}`,json(editing?'PATCH':'POST',topicEditorPayload(draft,editing)));busyRef.current=false;setBusy(false);choose(result.id);setEditing(undefined);await onRefresh().catch((e:any)=>onError('课题已保存，但列表刷新失败：'+e.message));}catch(e:any){setEditError(e.message+' 本地输入仍保留。'+(e.status===409?'请重读并比较当前版本；不会自动重试。':''));}finally{setBusy(false);}}
 async function toggleArchive(value:ResearchTopic){try{if(noteGuard.current&&!await noteGuard.current())return;await api(`/api/workspace/topics/${value.id}`,json('PATCH',{archived:!value.archived,expectedRevision:value.revision}));await onRefresh();}catch(e:any){onError(e.message);}}
 const linkedPapers=topic?topic.paperIds.map(id=>({id,paper:papers.find(p=>p.id===id)})):[];
 const linkedDecks=topic?topic.presentationIds.map(id=>({id,deck:decks.find(p=>p.id===id)})):[];
 const switcher=overview&&<label className="topic-switcher"><span className="sr-only">切换课题</span><select aria-label="切换课题" value={topic?.id||''} onChange={e=>{const value=e.target.value;if(value==='__archived'){setArchived(true);if(onClearTopic)onClearTopic();else onNavigate('/topics');return;}if(value==='__active'){setArchived(false);if(onClearTopic)onClearTopic();else onNavigate('/topics');return;}if(value)choose(value);}}><option value="" disabled>{archived?'已归档课题':'选择课题'}</option>{topics.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}<option disabled>──────────</option><option value={archived?'__active':'__archived'}>{archived?'查看进行中的课题':'查看已归档课题'}</option></select></label>;
 return <section className="academic-page topic-workspace-page">
 <PdfImportOverlay importer={importer}/>
 {!topic&&<><div className="academic-page-heading"><div><h1>问题与选题</h1><p>每个课题汇集研究问题、文献、实验、证据与论文。</p></div><div className="topic-heading-actions">{overview&&<div className="academic-tabs topic-archive-tabs"><button className={!archived?'active':''} onClick={()=>setArchived(false)}>进行中</button><button className={archived?'active':''} onClick={()=>setArchived(true)}>已归档</button></div>}<button className="academic-primary" onClick={()=>edit(null)}><Plus size={16}/>新建课题</button></div></div>
 {overview&&selected&&<p role="status" className="academic-inline-error">此课题不存在或已不可用，请从下方选择课题。</p>}
 {!overview?<p role="status">正在加载课题…</p>:topics.length?<div className="topic-card-grid">{topics.map(t=><TopicCard key={t.id} topic={t} onOpen={()=>choose(t.id)}/>)}<button className="topic-card topic-card-new" onClick={()=>edit(null)}><Plus size={20}/><strong>新建课题</strong><p>从一个研究问题开始。</p></button></div>:<div className="academic-empty"><FolderKanban size={28}/><h2>{archived?'暂无归档课题':'从一个研究问题开始'}</h2>{!archived&&<button className="academic-primary" onClick={()=>edit(null)}><Plus size={15}/>建立第一个课题</button>}</div>}</>}
 {topic&&<>
 <header className="topic-hero">
  <div className="topic-hero-main">
   <div className="topic-hero-meta"><span className="topic-card-stage">{topic.stage?RESEARCH_STAGES[topic.stage]:'未标注阶段'}</span>{topic.archived&&<span className="topic-card-stage muted">已归档</span>}</div>
   <h1>{topic.title}</h1>
   <p className="topic-question">{topic.description||'尚未填写研究问题与说明。'}</p>
  </div>
  <div className="topic-hero-actions"><button className="academic-secondary" onClick={()=>edit(topic)}><Pencil size={14}/>编辑</button><button className="academic-secondary" onClick={()=>void toggleArchive(topic)} title={topic.archived?'取消归档':'归档课题'}><Archive size={14}/>{topic.archived?'取消归档':'归档'}</button><button className="academic-primary" onClick={()=>edit(null)}><Plus size={15}/>新建课题</button></div>
 </header>
 <div className="topic-workspace-grid">
  <div className="topic-workspace-main" id="topic-literature"><TopicMain importer={importer} key={topic.id} topic={topic} overview={overview} onRefresh={onRefresh} onError={onError} onGuardChange={setNoteGuard}/></div>
  <aside className="topic-rail" aria-label="课题信息">
   <section className="topic-rail-card"><header><h3>研究依据</h3><button onClick={()=>edit(topic)}>编辑</button></header>{topic.researchBasis?.trim()?<p className="topic-basis">{topic.researchBasis}</p>:<p className="topic-rail-empty">待补充：前置文献与版本、适用边界、本工作的承接与差异、验证方法。</p>}</section>
   <section className="topic-rail-card"><header><h3>论文<small>{linkedPapers.length}</small></h3><button onClick={()=>edit(topic)}>关联</button></header>{linkedPapers.length?linkedPapers.map(({id,paper})=><div key={id} className="topic-rail-paper"><button className="topic-rail-link" onClick={()=>onNavigate(`/papers/${encodeURIComponent(id)}/writing`)} title="进入写作"><BookOpen size={14}/><span>{paper?.title||id}</span><ArrowUpRight size={13}/></button><button className="topic-rail-sub" onClick={()=>setMapPaper(id)}>研究脉络与方案对照</button></div>):<p className="topic-rail-empty">尚未关联论文。</p>}

   </section>
   <section className="topic-rail-card"><header><h3>汇报<small>{linkedDecks.length}</small></h3></header>{linkedDecks.length?linkedDecks.map(({id,deck})=><button key={id} className="topic-rail-link" onClick={()=>onNavigate(`/presentations/${id}`)}><Presentation size={14}/><span>{deck?.title||id}</span><ArrowUpRight size={13}/></button>):<p className="topic-rail-empty">尚未关联汇报。</p>}</section>
   <section className="topic-rail-card"><header><h3>最近活动</h3></header>{activity.length?<ul className="topic-activity">{activity.map(item=><li key={item.key}><span>{item.label}</span><strong>{item.name}</strong><time>{prettyDate(item.time)}</time></li>)}</ul>:<p className="topic-rail-empty">暂无活动。</p>}</section>
  </aside>
 </div></>}
 {topic&&mapPaper&&topic.paperIds.includes(mapPaper)&&<HubDialog wide title={`研究对照 · ${papers.find(p=>p.id===mapPaper)?.title||mapPaper}`} onClose={()=>setMapPaper('')}><div className="topic-map-dialog"><ResearchMap key={`${topic.id}:${mapPaper}`} projectId={mapPaper}/></div></HubDialog>}
 {editing!==undefined&&<HubDialog title={editing?'编辑研究课题':'新建研究课题'} onClose={closeEditor} wide><form className="academic-form" onSubmit={save}><label>课题名称<input autoFocus required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} placeholder="例如：推理过程中的偏好优化"/></label><label>当前研究阶段<select value={stage} onChange={e=>setStage(e.target.value as typeof stage)}><option value="未标注" disabled>尚未标注阶段</option>{Object.entries(RESEARCH_STAGES).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><label>研究问题、现有工作与可行性<ResearchTextEditor aria-label="研究问题、现有工作与可行性" maxLength={10000} rows={3} value={description} onChange={setDescription} placeholder="你正在解决什么问题？"/></label><details open={!!researchBasis}><summary>研究依据</summary><label>具体前置文献、边界、承接与证据<ResearchTextEditor aria-label="研究依据" rows={12} value={researchBasis} onChange={setResearchBasis}/></label><button type="button" onClick={()=>setResearchBasis(v=>v||RESEARCH_BASIS_TEMPLATE)}>填入空白模板</button><small>内容非空不代表已验证；不自动同步到论文。</small></details><div className="academic-form-columns"><fieldset><legend>关联现有论文</legend>{papers.filter(p=>!p.trashed).map(p=><label className="academic-checkbox" key={p.id}><input type="checkbox" checked={paperIds.includes(p.id)} onChange={()=>setPaperIds(check(paperIds,p.id))}/><span>{p.title}</span></label>)}{!papers.length&&<small>暂无论文</small>}</fieldset><fieldset><legend>关联已有汇报</legend>{decks.map(p=><label className="academic-checkbox" key={p.id}><input type="checkbox" checked={presentationIds.includes(p.id)} onChange={()=>setPresentationIds(check(presentationIds,p.id))}/><span>{p.title}</span></label>)}{!decks.length&&<small>暂无汇报</small>}</fieldset></div><p className="academic-help">文件可在资料库中关联到课题。关联只记录关系，原文件保持原位。</p>{editError&&<p className="academic-inline-error" role="alert">{editError}</p>}{editError&&editing&&<button type="button" className="academic-secondary" disabled={busy} onClick={()=>void readComparison()}>重读课题以比较</button>}{editError&&!comparison&&<button type="button" className="academic-secondary" onClick={downloadDraft}>下载本地草稿</button>}{editing&&comparison&&<TopicEditComparison baseline={editing} latest={comparison} draft={draft} paperNames={Object.fromEntries(papers.map(p=>[p.id,p.title]))} deckNames={Object.fromEntries(decks.map(p=>[p.id,p.title]))} onDownload={downloadDraft} onLoad={loadComparedVersion}/>}<footer><button type="button" className="academic-secondary" disabled={busy} onClick={closeEditor}>取消</button><button className="academic-primary" disabled={busy||!title.trim()||!!comparison}>{busy?'保存中…':'保存课题'}</button></footer></form></HubDialog>}
 </section>;
}

/** Overview card: the question, the latest thinking and how many key papers the topic rests on. */
function TopicCard({topic:t,onOpen}:{topic:ResearchTopic;onOpen:()=>void}){
 const [nb,setNb]=useState<TopicNotebook>();
 useEffect(()=>{let alive=true;void api<{notebook:TopicNotebook}>(`/api/workspace/topics/${encodeURIComponent(t.id)}/notebook`).then(v=>{if(alive)setNb(v.notebook);}).catch(()=>{});return()=>{alive=false;};},[t.id,t.revision]);
 const latest=nb?.ideas[0],open=nb?.ideas.filter(i=>(i.kind==='question'||i.kind==='hypothesis'||i.kind==='todo')&&!i.done).length||0;
 return <button className="topic-card" onClick={onOpen}>
  <span className="topic-card-stage">{t.stage?RESEARCH_STAGES[t.stage]:'未标注阶段'}</span>
  <strong>{t.title}</strong>
  <p>{t.description||'尚未填写研究问题。'}</p>
  {latest&&<blockquote className="topic-card-idea"><b>{IDEA_KIND_LABELS[latest.kind]}</b>{latest.text.replace(/[#*_`>]/g,'').slice(0,120)}</blockquote>}
  <small><span>⭐ {nb?.keyRefs.length??'–'} 篇重点文献</span><span>{open} 个待解决问题</span><span>{t.resourceIds.length} 份资料</span><time>{prettyDate(t.updatedAt)}</time></small>
 </button>;
}
