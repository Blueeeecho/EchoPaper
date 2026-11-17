import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowUpRight,Link2} from 'lucide-react';
import type {ResearchTopic} from '../../shared/workspace-types';
import type {ResearchDayTask} from '../../shared/research-calendar';
import type {ResearchWorkTarget,TaskTargetOptions} from '../../shared/research-targets';
import {api,json} from '../api';
import HubDialog from './HubDialog';
const key=(target?:ResearchWorkTarget)=>target?JSON.stringify(target):'';
function label(target:ResearchWorkTarget,topic:ResearchTopic){return target.kind==='research-entry'?`${target.entryKind==='experiment'?'实验':'证据'}条目 · ${topic.workEntries?.find(e=>e.id===target.entryId)?.title||'已保存条目'}`:target.kind==='paper-file'?target.path:target.kind==='review'?`审稿 · ${target.reviewId}`:target.kind==='resource'?'关联资料':target.field==='experimentPlan'?'方案与实验记录':'结果与证据记录';}
export default function TaskWorkTarget({task,topic,disabled,onNavigate,onRefresh,onStatus,onWritten}:{task:ResearchDayTask;topic:ResearchTopic;disabled:boolean;onNavigate:(path:string)=>void;onRefresh:()=>Promise<void>;onStatus:(id:string,status?:{dirty:boolean;busy:boolean})=>void;onWritten:(topicId:string,write:{from:number;to:number;entryId?:string})=>void}){
 const [open,setOpen]=useState(false),[data,setData]=useState<TaskTargetOptions>(),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[committed,setCommitted]=useState(false),[opening,setOpening]=useState(false),[query,setQuery]=useState('');
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const id=`target:${task.topicId}:${task.id}`,dirty=open&&!!data&&!committed&&selected!==key(data.target);
 useEffect(()=>{onStatus(id,{dirty,busy});},[id,dirty,busy,onStatus]);useEffect(()=>()=>onStatus(id),[id,onStatus]);
 const options=data?.options.filter(o=>o.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))||[];
 const endpoint=`/api/workspace/topics/${encodeURIComponent(topic.id)}/daily-tasks/${encodeURIComponent(task.entryId)}/${task.index}`;
 function close(){if(busy||dirty&&!window.confirm('关联对象尚未保存。放弃本次选择？'))return;setOpen(false);setData(undefined);setError('');setCommitted(false);}
 async function choose(){setQuery('');setOpen(true);setBusy(true);setError('');setData(undefined);setCommitted(false);try{const result=await api<TaskTargetOptions>(endpoint+'/target-options');if(alive.current){setData(result);setSelected(key(result.target));}}catch(e:any){if(alive.current)setError(e.message);}finally{if(alive.current)setBusy(false);}}
 async function refresh(){setBusy(true);try{await onRefresh();if(alive.current){setOpen(false);setCommitted(false);setError('');}}catch{if(alive.current)setError('关联已保存，页面刷新失败。请刷新记录，不要重复提交。');}finally{if(alive.current)setBusy(false);}}
 async function save(e:FormEvent){e.preventDefault();if(!data||busy||committed||!dirty)return;setBusy(true);setError('');let written=false;
  try{const target=selected?data.options.find(o=>key(o.target)===selected)?.target:null;if(selected&&!target)throw Error('请选择当前可用的工作对象。');
   const result=await api<ResearchTopic>(endpoint,json('PATCH',{expectedRevision:data.revision,target}));written=true;if(alive.current){setCommitted(true);onWritten(topic.id,{from:data.revision,to:result.revision,entryId:task.entryId});}await onRefresh();if(alive.current){setOpen(false);setData(undefined);setCommitted(false);}
  }catch(e:any){if(alive.current)setError(written?'关联已保存，页面刷新失败。请刷新记录，不要重复提交。':`${e.message} 当前选择已保留。${e.status===409?'请先取消并刷新记录，再核对最新关联；不会覆盖。':''}`);}finally{if(alive.current)setBusy(false);}
 }
 async function openTarget(){setOpening(true);setError('');try{const result=await api<{path:string}>(endpoint+'/target');if(alive.current)onNavigate(result.path);}catch(e:any){if(alive.current)setError(`${e.message} 可更换或解除关联。`);}finally{if(alive.current)setOpening(false);}}
 return <div className="task-work-target">
  {task.target&&<button type="button" className="task-target-open" disabled={disabled||busy||opening} title={label(task.target,topic)} onClick={()=>void openTarget()}><ArrowUpRight size={13}/><span>{label(task.target,topic)}</span></button>}
  <button type="button" className="task-target-choose" aria-label={`关联工作对象：${task.text}`} disabled={disabled||busy||opening} onClick={()=>void choose()}><Link2 size={13}/>{task.target?'更改关联':'关联工作对象'}</button>
  {!open&&error&&<p role="alert" className="academic-inline-error">{error}</p>}
  {open&&<HubDialog title="关联待办工作对象" onClose={close}><form className="academic-form task-target-form" onSubmit={save}>
   <p>{data?.taskText||task.text}</p><small>仅显示当前课题已关联且可用的对象。</small>
   {data&&data.options.length>12&&<label>查找对象<input aria-label="查找待办工作对象" value={query} onChange={e=>setQuery(e.target.value)} placeholder="按文件名或标题查找…" disabled={busy||committed}/></label>}
   {busy&&!data?<p role="status">正在读取工作对象…</p>:data&&<label>工作对象<select aria-label="待办关联工作对象" disabled={busy||committed} value={selected} onChange={e=>setSelected(e.target.value)}><option value="">不关联工作对象</option>{selected&&!options.some(o=>key(o.target)===selected)&&<option value={selected} disabled>{data.options.find(o=>key(o.target)===selected)?.label||'原关联已不可用（可更换或解除）'}</option>}{[...new Set(options.map(o=>o.group))].map(group=><optgroup key={group} label={group}>{options.filter(o=>o.group===group).map(o=><option key={key(o.target)} value={key(o.target)}>{o.label}</option>)}</optgroup>)}</select></label>}
   {data&&!!data.options.length&&!options.length&&<p role="status">没有匹配的工作对象。</p>}
   {data&&!data.options.length&&<p>当前没有可关联对象。请先在课题中关联论文、资料或记录实验方案。</p>}
   {error&&<p className="academic-inline-error" role="alert">{error}</p>}
   <footer><button type="button" className="academic-secondary" disabled={busy} onClick={close}>取消</button>{committed?<button type="button" className="academic-primary" disabled={busy} onClick={()=>void refresh()}>刷新记录</button>:<button className="academic-primary" disabled={!dirty||busy}>{busy?'保存中…':'保存关联'}</button>}</footer>
  </form></HubDialog>}
 </div>;
}
