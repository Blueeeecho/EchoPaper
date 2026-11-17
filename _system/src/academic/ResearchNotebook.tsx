import ResearchTextEditor from './ResearchTextEditor';
import ResearchEntries from './ResearchEntries';
import ResearchNotes from './ResearchNotes';
import {useEffect,useState,useRef,useCallback} from 'react';
import {ArrowUpRight,BookOpen,FileText,ListChecks} from 'lucide-react';
import {RESEARCH_STAGES,type ResearchProgress,type ResearchTopic,type WorkspaceOverview,type ResearchStage} from '../../shared/workspace-types';
import {api,json,prettyDate} from '../api';
import HubDialog from './HubDialog';
import ProgressCalendar from './ProgressCalendar';
import './literature-workflow.css';

export type NotebookSection='experiments'|'results'|'progress';
const pages={
 experiments:{title:'方案与实验',description:'明确假设、比较方法和验收标准，记录每次验证的条件与观察。',field:'experimentPlan',action:'编辑方案与实验记录',empty:'还没有验证记录',hint:'记录研究假设、对照方案、数据与指标、运行条件、实验编号和原始输出位置。已完成与计划中的工作分别标明。'},
 results:{title:'结果与证据',description:'将原始输出整理为可核查的证据，再判断能够支持什么结论。',field:'resultSummary',action:'编辑结果与证据',empty:'还没有证据整理记录',hint:'记录结果表或图的位置、对应实验、已验证结论、异常与反例，以及仍需补充的证据。'},
 progress:{title:'工作日历',description:'按天汇总研究进展，查看日报与次日待办。',field:'',action:'记录进展',empty:'还没有进展记录',hint:'记录实际完成的工作与当前阻碍；下一步可以是补实验、查文献、整理结果或修改论文。'},
} as const;

export default function ResearchNotebook({section,overview,topicId,day,entryId,entryRevision,onNavigate,onRefresh,onError,registerGuard}:{section:NotebookSection;overview?:WorkspaceOverview;topicId?:string;day?:string;entryId?:string;entryRevision?:number;onNavigate:(path:string)=>void;onRefresh:()=>Promise<void>;onError:(message:string)=>void;registerGuard:(guard:(()=>Promise<boolean>)|undefined)=>void}){
 const topics=(overview?.topics||[]).filter(t=>!t.archived),topic=topicId?topics.find(t=>t.id===topicId):undefined,page=pages[section];
 const entryState=useRef({dirty:false,busy:false});const setEntryState=useCallback((value:{dirty:boolean;busy:boolean})=>{entryState.current=value;},[]);
 const [view,setView]=useState<'doc'|'entries'>(entryId?'entries':'doc');
 useEffect(()=>{if(entryId)setView('entries');},[entryId]);
 const noteGuard=useRef<(()=>Promise<boolean>)|undefined>(undefined);
 const setNoteGuard=useCallback((guard:(()=>Promise<boolean>)|undefined)=>{noteGuard.current=guard;},[]);
 const [calendarDirty,setCalendarDirty]=useState(false),[calendarBusy,setCalendarBusy]=useState(false);
 const [stageBusy,setStageBusy]=useState(false);
 const [amending,setAmending]=useState<ResearchProgress>(),[comparison,setComparison]=useState<ResearchTopic>(),[editing,setEditing]=useState<ResearchTopic>(),[draft,setDraft]=useState(''),[nextStep,setNextStep]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const original=amending?.content||'';
 const dirty=calendarDirty||!!editing&&(draft!==original||nextStep!==(amending?.nextStep||''));
 useEffect(()=>{registerGuard(async()=>!busy&&!stageBusy&&!calendarBusy&&!entryState.current.busy&&(!noteGuard.current||await noteGuard.current())&&(!(dirty||entryState.current.dirty)||window.confirm('记录尚未保存。离开并放弃本次编辑？')));return()=>registerGuard(undefined);},[dirty,busy,stageBusy,calendarBusy,registerGuard]);
 useEffect(()=>{if(!editing)return;const before=(e:BeforeUnloadEvent)=>{if(dirty||busy){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before);},[dirty,busy,editing]);
 function edit(){if(!topic)return;setAmending(undefined);setComparison(undefined);setEditing(structuredClone(topic));setDraft('');setNextStep('');setError('');}
 function amend(entry:ResearchProgress){if(!topic)return;setAmending(entry);setComparison(undefined);setEditing(structuredClone(topic));setDraft(entry.content);setNextStep(entry.nextStep);setError('');}
 function close(){if(!busy&&(!dirty||window.confirm('记录尚未保存。放弃本次编辑？')))setEditing(undefined);}
 async function readComparison(){if(!editing)return;setBusy(true);try{const result=await api<{topics:ResearchTopic[]}>('/api/workspace/topics');const current=result.topics.find(t=>t.id===editing.id);if(!current){setComparison(undefined);setError('课题已不存在或不可用。本地输入仍保留，请先复制或下载后再关闭。');return;}setComparison(current);}catch(e:any){setError(e.message+' 本地输入仍保留。');}finally{setBusy(false);}}
 async function save(e:React.FormEvent){e.preventDefault();if(!editing)return;setBusy(true);setError('');let committed=false;try{
  await api(`/api/workspace/topics/${editing.id}/progress${amending?`/${amending.id}`:''}`,json(amending?'PATCH':'POST',{expectedRevision:editing.revision,content:draft,nextStep}));
  committed=true;await onRefresh();setEditing(undefined);onError('记录已保存');
 }catch(e:any){if(committed){setEditing(undefined);onError('记录已保存，页面刷新失败。请刷新工作台，不要重复提交。');}else setError(`${amending&&[404,405].includes(e.status)?'更正接口或记录不可用，请核对记录是否存在及后端是否已更新。':e.message} 本次输入仍保留，未自动覆盖其他修改。${e.status===409?'请重读当前记录并比较；不会自动重试。':''}`);}finally{setBusy(false);}}
 async function changeStage(value:ResearchStage){if(!topic||stageBusy||noteGuard.current&&!await noteGuard.current())return;setStageBusy(true);try{const current=(await api<{topics:ResearchTopic[]}>('/api/workspace/topics')).topics.find(item=>item.id===topic.id);if(!current)throw Error('课题已不存在，请重新读取。');await api(`/api/workspace/topics/${topic.id}`,json('PATCH',{expectedRevision:current.revision,stage:value}));await onRefresh();}catch(e:any){onError(e.message);}finally{setStageBusy(false);}}
 return <section className={`academic-page research-notebook research-notebook-${section}`}><div className="academic-page-heading"><div><div className="research-page-title"><h1>{page.title}</h1>{topic&&section!=='progress'&&<select className="research-notes-stage" aria-label="课题当前阶段" value={topic.stage||''} disabled={stageBusy} onChange={event=>void changeStage(event.target.value as ResearchStage)}><option value="" disabled>尚未标注阶段</option>{Object.entries(RESEARCH_STAGES).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>}</div>{section!=='progress'&&<p>{page.description}</p>}</div></div>
 {section==='progress'&&overview&&!topicId&&!topic&&<ProgressCalendar onNavigate={onNavigate} selectedDay={day} onSelectDay={value=>onNavigate(`/progress?${new URLSearchParams({... (topicId?{topic:topicId}:{}),day:value})}`)} onSavingChange={setCalendarBusy} topics={topics} onRefresh={onRefresh} onEditingChange={setCalendarDirty}/>}
 {!overview?<p role="status">正在读取课题…</p>:!topic?section==='progress'&&!topicId?null:<div className="academic-empty"><BookOpen size={30}/><h2>{topicId?'未找到指定课题':topics.length?'先选择要继续的课题':'先明确一个研究问题'}</h2><p>{topics.length?'在上方选择当前课题；系统不会自动切到另一课题。':'建立课题后，方案、证据和进度会保存在同一课题中，并可关联已有论文与资料。'}</p><button className="academic-primary" onClick={()=>onNavigate('/topics')}>进入问题与选题<ArrowUpRight size={14}/></button></div>:<>
 {section==='progress'&&<ProgressCalendar onNavigate={onNavigate} selectedDay={day} onSelectDay={value=>onNavigate(`/progress?${new URLSearchParams({... (topicId?{topic:topicId}:{}),day:value})}`)} onSavingChange={setCalendarBusy} topics={[topic]} onRefresh={onRefresh} onEditingChange={setCalendarDirty}/>}
 {section==='progress'?<details className="research-history-records"><summary>逐条记录与历史更正</summary><div className="research-log">{topic.progressEntries?.length?[...topic.progressEntries].reverse().map(entry=><article key={entry.id} id={`progress-${entry.id}`}><time dateTime={entry.createdAt}>{prettyDate(entry.createdAt)}</time>{entry.amendsId&&<p>更正记录（不计为新增实验） · <a href={`#progress-${entry.amendsId}`} onClick={e=>{e.preventDefault();const node=document.getElementById(`progress-${entry.amendsId}`);node?.querySelector('details')?.setAttribute('open','');node?.scrollIntoView({block:'center'});}}>查看原记录</a></p>}{entry.supersededBy?<><p>已更正 · <a href={`#progress-${entry.supersededBy}`} onClick={e=>{e.preventDefault();document.getElementById(`progress-${entry.supersededBy}`)?.scrollIntoView({block:'center'});}}>查看后续版本</a></p><details><summary>查看保留的原文</summary><p>{entry.content}</p>{entry.nextStep&&<p>下一步：{entry.nextStep}</p>}</details></>:<><p>{entry.content}</p>{entry.nextStep&&<div><strong>下一步</strong><p>{entry.nextStep}</p></div>}<button className="academic-secondary" onClick={()=>amend(entry)}>更正记录</button></>}</article>):<div className="research-record-empty"><h2>{page.empty}</h2><p>{page.hint}</p><button className="academic-secondary" onClick={edit}>记录第一次进展</button></div>}</div></details>:<div className="notebook-layout">
  <nav className="notebook-tabs" role="tablist"><button role="tab" aria-selected={view==='doc'} onClick={()=>setView('doc')}><FileText size={14}/>{section==='experiments'?'方案与实验记录':'证据与结论整理'}</button><button role="tab" aria-selected={view==='entries'} onClick={()=>setView('entries')}><ListChecks size={14}/>{section==='experiments'?'实验条目':'证据条目'}</button></nav>
  <div hidden={view!=='doc'}><ResearchNotes key={`${topic.id}:${section}`} topicId={topic.id} section={section} onGuardChange={setNoteGuard} onRefresh={onRefresh}/></div>
  <div hidden={view!=='entries'}><ResearchEntries key={`${topic.id}:${section}`} kind={section==='experiments'?'experiment':'evidence'} topic={topic} entryId={entryId} entryRevision={entryRevision} onNavigate={onNavigate} onRefresh={onRefresh} onStatus={setEntryState}/></div>
 </div>}
 </>}
 {editing&&<HubDialog title={`${amending?'更正记录':page.action} · ${editing.title}`} onClose={close} wide>
  <form className="academic-form research-record-form" onSubmit={save}>
   {amending&&<p>更正会追加新记录，保留原文、原创建时间及版本关系。请写入完整的更正内容。</p>}
   <label>本次进展与问题<ResearchTextEditor aria-label="本次进展与问题" required rows={12} maxLength={10000} value={draft} onChange={setDraft} placeholder={page.hint}/></label>
   <label>下一步<ResearchTextEditor aria-label="下一步" rows={3} maxLength={2000} value={nextStep} onChange={setNextStep} placeholder="下一步要完成的具体工作，可留空"/></label>
   {error&&<><p className="academic-inline-error" role="alert">{error}</p><button type="button" className="academic-secondary" disabled={busy} onClick={()=>void readComparison()}>重读当前记录以比较</button></>}
   {comparison&&<details open><summary>服务器当前记录（版本 {comparison.revision}）</summary>{comparison.progressEntries?.map(entry=><p key={entry.id}>{entry.createdAt} · {entry.content} · 下一步：{entry.nextStep}{entry.supersededBy?'（已更正）':''}</p>)}</details>}
   <footer><button type="button" className="academic-secondary" disabled={busy} onClick={close}>取消</button><button className="academic-primary" disabled={busy||!draft.trim()}>{busy?'保存中…':'保存记录'}</button></footer>
  </form>
 </HubDialog>}

 </section>;
}
