import TaskWorkTarget from './TaskWorkTarget';
import ResearchTextEditor from './ResearchTextEditor';
import {useCallback,useEffect,useLayoutEffect,useRef,useState,type FormEvent} from 'react';
import {ChevronLeft,ChevronRight,Download} from 'lucide-react';
import type {ResearchProgress,ResearchTopic} from '../../shared/workspace-types';
import {progressNextSteps,researchCalendar,researchDay,researchDayReport,researchMonthDays,shiftResearchDay,validResearchDay,type ResearchDayTask} from '../../shared/research-calendar';
import {api,json,downloadText} from '../api';
import './progress-calendar.css';

type EditStatus={dirty:boolean;busy:boolean};
type StatusChange=(id:string,status?:EditStatus)=>void;
type LocalWrite={from:number;to:number;entryId?:string};
type OnWritten=(topicId:string,write:LocalWrite)=>void;
/** An always-visible field: changing a date never requires opening a dialog. */
function DayField({id,topic,day,kind,entry,taskIndex,disabled,onRefresh,onStatus,localWrite,onWritten,showTopic}:{id:string;topic:ResearchTopic;day:string;kind:'progress'|'task';entry?:ResearchProgress;taskIndex?:number;disabled:boolean;onRefresh:()=>Promise<void>;onStatus:StatusChange;localWrite?:LocalWrite;onWritten:OnWritten;showTopic:boolean}){
 const initial=taskIndex!==undefined&&entry?progressNextSteps(entry.nextStep)[taskIndex]||'':entry?.content||'';
 const [content,setContent]=useState(initial),[baseline,setBaseline]=useState(initial),[revision,setRevision]=useState(topic.revision);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const inputRef=useRef<HTMLTextAreaElement>(null);
 const fit=useCallback(()=>{const node=inputRef.current;if(!node)return;node.style.height='auto';const height=node.scrollHeight+2;node.style.height=`${Math.min(height,224)}px`;node.style.overflowY=height>224?'auto':'hidden';},[]);
 useLayoutEffect(fit,[content,fit]);
 useEffect(()=>{const node=inputRef.current;if(!node)return;let width=node.getBoundingClientRect().width;const observer=new ResizeObserver(entries=>{const next=entries[0].contentRect.width;if(next!==width){width=next;fit();}});observer.observe(node);return()=>observer.disconnect();},[fit]);
 const dirty=content!==baseline;
 useEffect(()=>{if(localWrite&&revision===localWrite.from&&(!localWrite.entryId||localWrite.entryId!==entry?.id))setRevision(localWrite.to);},[localWrite,revision,entry?.id]);
 // A fresh revision is adopted only while the field is clean; a stale draft must conflict safely.
 useEffect(()=>{if(!dirty&&!busy&&!saved){setContent(initial);setBaseline(initial);setRevision(topic.revision);}},[initial,topic.revision,dirty,busy,saved]);
 useEffect(()=>{onStatus(id,{dirty,busy});},[id,dirty,busy,onStatus]);
 useEffect(()=>()=>onStatus(id),[id,onStatus]);
 async function refresh(){setBusy(true);try{await onRefresh();setSaved(false);setError('');}catch{setError('内容已保存，刷新失败。请刷新记录，不要重复提交。');}finally{setBusy(false);}}
 async function save(e:FormEvent){
  e.preventDefault();if(busy||saved||!content.trim()||!dirty)return;
  setBusy(true);setError('');let changed=false;
  try{
   let payload:Record<string,unknown>={expectedRevision:revision,content,nextStep:entry?.nextStep||'',day,kind};
   if(taskIndex!==undefined&&entry){const lines=progressNextSteps(entry.nextStep);lines[taskIndex]=content;payload={expectedRevision:revision,content:entry.content,nextStep:lines.join('\n')};}
   const updated=await api<ResearchTopic>(`/api/workspace/topics/${encodeURIComponent(topic.id)}/progress${entry?`/${encodeURIComponent(entry.id)}`:''}`,json(entry?'PATCH':'POST',payload));
   onWritten(topic.id,{from:revision,to:updated.revision,entryId:entry?.id});
   changed=true;setSaved(true);if(entry)setBaseline(content);else{setContent('');setBaseline('');}
   await onRefresh();setSaved(false);
  }catch(e:any){setError(changed?'内容已保存，列表刷新失败。请刷新记录，不要重复提交。':`${e.message} 输入已保留。${e.status===409?'请先复制草稿，刷新最新记录后再核对保存。':''}`);}
  finally{setBusy(false);}
 }
 return <form className={`day-field ${kind==='task'?'day-task-field':''}`} onSubmit={save} aria-label={`${entry?'修改':'新增'}${kind==='task'?'待办':'进展'} · ${topic.title}`}>
  {entry&&showTopic&&<small className="day-field-topic">{topic.title}</small>}
  <ResearchTextEditor ref={inputRef} aria-label={`${entry?'修改':'新增'}${kind==='task'?'待办':'进展'}内容 · ${topic.title}`} rows={1} maxLength={kind==='task'?2000:10000} value={content} disabled={disabled||busy||saved} onChange={setContent} onKeyDown={e=>{if(e.nativeEvent.isComposing||e.key!=='Enter')return;if((kind==='task'&&!e.shiftKey)||e.metaKey||e.ctrlKey){e.preventDefault();e.currentTarget.form?.requestSubmit();}}} placeholder={entry?'':kind==='task'?'＋ 添加待办，回车保存':'＋ 记录当天进展，⌘↩ 保存'}/>
  {error&&<p role="alert" className="academic-inline-error">{error}</p>}
  {(dirty||saved||busy)&&<footer>{saved?<button type="button" className="academic-secondary" disabled={busy} onClick={()=>void refresh()}>刷新记录</button>:<><button type="button" className="academic-secondary" disabled={busy||disabled} onClick={()=>{setContent(baseline);setError('');}}>撤销修改</button><button className="academic-primary" disabled={busy||disabled||!content.trim()}>{busy?'保存中…':entry?'保存修改':kind==='task'?'保存待办':'保存进展'}</button></>}</footer>}
 </form>;
}

export default function ProgressCalendar({topics,selectedDay,onSelectDay,onNavigate,onRefresh,onEditingChange,onSavingChange}:{topics:ResearchTopic[];selectedDay?:string;onSelectDay?:(day:string)=>void;onNavigate?:(path:string)=>void;onRefresh:()=>Promise<void>;onEditingChange?:(value:boolean)=>void;onSavingChange?:(value:boolean)=>void}) {
 const today=researchDay(new Date());
 const [localDay,setLocalDay]=useState(today);
 const selected=validResearchDay(selectedDay)?selectedDay:localDay;
 const [month,setMonth]=useState(selected.slice(0,7)),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [newTopicId,setNewTopicId]=useState(topics[0]?.id||''),[edits,setEdits]=useState<Record<string,EditStatus>>({});
 useEffect(()=>{setMonth(selected.slice(0,7));setError('');setNotice('');},[selected]);
 const [localWrites,setLocalWrites]=useState<Record<string,LocalWrite>>({});
 const onWritten=useCallback<OnWritten>((topicId,write)=>{setLocalWrites(previous=>({...previous,[topicId]:write}));setNotice(`已保存 · ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'})}`);},[]);
 const dirty=Object.values(edits).some(e=>e.dirty),saving=!!busy||Object.values(edits).some(e=>e.busy);
 const onStatus=useCallback<StatusChange>((id,status)=>setEdits(previous=>{if(status&&previous[id]?.dirty===status.dirty&&previous[id]?.busy===status.busy)return previous;if(!status&&!(id in previous))return previous;const next={...previous};if(status)next[id]=status;else delete next[id];return next;}),[]);
 useEffect(()=>{onSavingChange?.(saving);return()=>onSavingChange?.(false);},[saving,onSavingChange]);
 useEffect(()=>{onEditingChange?.(dirty||saving);return()=>onEditingChange?.(false);},[dirty,saving,onEditingChange]);
 useEffect(()=>{if(!dirty&&!saving)return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[dirty,saving]);
 const {records,tasks}=researchCalendar(topics),days=researchMonthDays(month),next=shiftResearchDay(selected,1);
 const work=records.filter(r=>r.day===selected),todayTasks=tasks.filter(t=>t.day===selected),nextTasks=tasks.filter(t=>t.day===next);
 const newTopic=topics.find(t=>t.id===newTopicId)||topics[0];
 const counts=new Map<string,{records:number;tasks:number}>();
 for(const r of records){const c=counts.get(r.day)||{records:0,tasks:0};c.records++;counts.set(r.day,c);}
 for(const t of tasks)if(!t.done){const c=counts.get(t.day)||{records:0,tasks:0};c.tasks++;counts.set(t.day,c);}
 function moveMonth(amount:number){const d=new Date(`${month}-01T12:00:00Z`);d.setUTCMonth(d.getUTCMonth()+amount);setMonth(d.toISOString().slice(0,7));}
 function chooseDay(day:string){if(day===selected||!validResearchDay(day)||saving)return;if(onSelectDay){onSelectDay(day);return;}if(dirty&&!window.confirm('当前日期有未保存内容。放弃修改并切换日期？'))return;setLocalDay(day);}
 async function toggle(task:ResearchDayTask){
  const topic=topics.find(t=>t.id===task.topicId);if(!topic||saving||dirty)return;
  setBusy(`${task.topicId}:${task.id}`);setError('');
  try{await api(`/api/workspace/topics/${encodeURIComponent(topic.id)}/daily-tasks/${encodeURIComponent(task.entryId)}/${task.index}`,json('PATCH',{expectedRevision:topic.revision,done:!task.done}));setNotice(task.done?'已恢复待办':'已完成待办');await onRefresh();}
  catch(e:any){setError(`${e.message} 请刷新后核对完成状态。`);}
  finally{setBusy('');}
 }
 function taskList(list:ResearchDayTask[]){return <ul className="daily-task-list day-inline-tasks">{list.map(task=>{const topic=topics.find(t=>t.id===task.topicId)!;const entry=topic.progressEntries?.find(e=>e.id===task.entryId)!;return <li key={`${task.topicId}:${task.id}`} className={task.done?'task-complete':''}><input type="checkbox" aria-label={`完成待办：${task.text}`} checked={task.done} disabled={saving||dirty} onChange={()=>void toggle(task)}/><div className="daily-task-body"><DayField id={`${task.topicId}:${task.id}`} topic={topic} day={task.day} kind="task" entry={entry} taskIndex={entry.kind==='task'?undefined:task.index} disabled={saving} onRefresh={onRefresh} onStatus={onStatus} localWrite={localWrites[topic.id]} onWritten={onWritten} showTopic={topics.length>1}/>{onNavigate&&<TaskWorkTarget task={task} topic={topic} disabled={saving||dirty} onNavigate={onNavigate} onRefresh={onRefresh} onStatus={onStatus} onWritten={onWritten}/>}</div></li>;})}</ul>;}
 return <div className="progress-calendar">
  <section className="work-calendar" aria-label="工作日历">
   <header><div><h2>{Number(month.slice(0,4))}年{Number(month.slice(5))}月</h2><small><b className="mark-progress"/>进展　<b className="mark-task"/>未完成待办</small></div><div><button type="button" aria-label="上个月" onClick={()=>moveMonth(-1)}><ChevronLeft size={17}/></button><button type="button" onClick={()=>chooseDay(today)}>今天</button><button type="button" aria-label="下个月" onClick={()=>moveMonth(1)}><ChevronRight size={17}/></button></div></header>
   <div className="work-calendar-week" aria-hidden="true">{['一','二','三','四','五','六','日'].map(d=><span key={d}>{d}</span>)}</div>
   <div className="work-calendar-days">{days.map(day=>{const count=counts.get(day);return <button type="button" key={day} aria-pressed={selected===day} aria-current={day===today?'date':undefined} aria-label={`${day}${count?`，${count.records}条进展，${count.tasks}项待办`:''}`} className={`${day.slice(0,7)!==month?'outside':''} ${day===today?'today':''}`} onClick={()=>chooseDay(day)}><span>{Number(day.slice(-2))}</span>{(!!count?.records||!!count?.tasks)&&<i className="calendar-marks">{!!count?.records&&<b className="mark-progress" title={`${count.records}条进展`}>{count.records>1?count.records:''}</b>}{!!count?.tasks&&<b className="mark-task" title={`${count.tasks}项待办`}>{count.tasks>1?count.tasks:''}</b>}</i>}</button>;})}</div>
  </section>
  <section className="daily-report" aria-label={`${selected}日报`}>
   <header><div className="daily-title"><button type="button" aria-label="前一天" disabled={saving} onClick={()=>chooseDay(shiftResearchDay(selected,-1))}><ChevronLeft size={16}/></button><h2>{Number(selected.slice(5,7))}月{Number(selected.slice(8))}日<small>周{'日一二三四五六'[new Date(`${selected}T12:00:00Z`).getUTCDay()]}{selected===today?' · 今天':''}</small></h2><button type="button" aria-label="后一天" disabled={saving} onClick={()=>chooseDay(shiftResearchDay(selected,1))}><ChevronRight size={16}/></button></div><span className="daily-save-state" role="status" aria-live="polite">{saving?'保存中…':dirty?'有未保存修改':notice}</span><button type="button" className="daily-export" aria-label="导出日报" onClick={()=>downloadText(`${selected}-研究日报.md`,researchDayReport(selected,topics))}><Download size={15}/></button></header>
   {!topics.length&&<p className="daily-empty">先建立一个研究课题，即可在此记录。</p>}
   {error&&<p role="alert" className="academic-inline-error">{error}<button type="button" onClick={()=>void onRefresh().then(()=>setError('')).catch(()=>{})}>刷新记录</button></p>}
   <div key={selected}>
    {topics.length>1&&<label className="daily-topic-choice">新增内容所属课题<select aria-label="新增内容所属课题" value={newTopic?.id} disabled={dirty||saving} onChange={e=>setNewTopicId(e.target.value)}>{topics.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label>}
    <div className="daily-report-section"><h3>待办<span>{todayTasks.filter(t=>!t.done).length} 项未完成</span></h3>{taskList(todayTasks)}{newTopic&&<DayField key={`new-task:${newTopic.id}`} id={`new-task:${newTopic.id}`} topic={newTopic} day={selected} kind="task" disabled={saving} onRefresh={onRefresh} onStatus={onStatus} localWrite={localWrites[newTopic.id]} onWritten={onWritten} showTopic={topics.length>1}/>}</div>
    <div className="daily-report-section"><h3>进展记录<span>{work.length} 条</span></h3><div className="day-progress-fields">{work.map(r=>{const topic=topics.find(t=>t.id===r.topicId)!;const entry=topic.progressEntries!.find(e=>e.id===r.entryId)!;return <DayField key={`${r.topicId}:${r.entryId}`} id={`${r.topicId}:${r.entryId}`} topic={topic} day={selected} kind="progress" entry={entry} disabled={saving} onRefresh={onRefresh} onStatus={onStatus} localWrite={localWrites[topic.id]} onWritten={onWritten} showTopic={topics.length>1}/>;})}{newTopic&&<DayField key={`new-progress:${newTopic.id}`} id={`new-progress:${newTopic.id}`} topic={newTopic} day={selected} kind="progress" disabled={saving} onRefresh={onRefresh} onStatus={onStatus} localWrite={localWrites[newTopic.id]} onWritten={onWritten} showTopic={topics.length>1}/>}</div></div>
    {!!nextTasks.length&&<details className="daily-next-tasks"><summary>次日待办 · {nextTasks.filter(t=>!t.done).length}项未完成</summary>{taskList(nextTasks)}</details>}
   </div>
  </section>
 </div>;
}
