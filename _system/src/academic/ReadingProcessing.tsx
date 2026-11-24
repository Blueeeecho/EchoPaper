import {useCallback,useEffect,useRef,useState} from 'react';
import {AlertCircle,Check,LoaderCircle,RefreshCw,Settings2} from 'lucide-react';
import type {ReadingProcessingSnapshot,ReadingSettings,ReadingStatus} from '../../shared/reading-processing';
import {api,json} from '../api';
import {subscribeWorkspaceEvents} from '../workspaceEvents';
import './reading-processing.css';

export function readingStatusText(status:ReadingStatus,enabled=true):string {
 if(status.stage==='complete')return status.appendix?'正文及附录已缓存':'正文已缓存';
 if(status.stage==='ocr')return status.pageCount?`OCR 已识别 ${status.pageCount} 页`:'OCR 处理中';
 if(status.stage==='translating')return `翻译 ${status.done}/${status.total} 段`;
 if(status.stage==='queued')return status.error?'等待重试':enabled?'排队中':'已暂停';
 if(status.stage==='failed')return '处理失败，可重试';
 if(status.stage==='stale')return '原文已更新，待缓存';
 return status.total?`已缓存 ${status.done}/${status.total} 段`:'尚未缓存';
}

/** Runs `run` now, on focus/visibility, and every `ms` (if set) while the page is visible. Never overlaps; aborts on cleanup. */
export function useVisiblePoll(run:(signal:AbortSignal)=>Promise<unknown>,ms:number|null,deps:unknown[]) {
 const latest=useRef(run);latest.current=run;
 useEffect(()=>{
  const controller=new AbortController();let timer:number|undefined,running=false;
  const tick=async()=>{
   if(running||document.hidden||controller.signal.aborted)return;
   running=true;
   try{await latest.current(controller.signal);}catch{/* the callback reports its own errors */}finally{running=false;}
  };
  const stop=()=>{window.clearInterval(timer);timer=undefined;};
  const start=()=>{stop();if(ms&&!document.hidden)timer=window.setInterval(()=>void tick(),ms);};
  const wake=()=>{if(document.hidden)stop();else{void tick();start();}};
  void tick();start();
  document.addEventListener('visibilitychange',wake);window.addEventListener('focus',wake);
  return()=>{controller.abort();stop();document.removeEventListener('visibilitychange',wake);window.removeEventListener('focus',wake);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[ms,...deps]);
}

export function useReadingProcessing(resourceIds:string[]) {
 const ids=resourceIds.join(',');
 const [snapshot,setSnapshot]=useState<ReadingProcessingSnapshot>();
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const [tick,setTick]=useState(0);
 const fetchSnapshot=useCallback(async(signal?:AbortSignal)=>{
  if(!ids)return;
  try {
   const next=await api<ReadingProcessingSnapshot>(`/api/workspace/bilingual/processing?ids=${encodeURIComponent(ids)}`,{signal});
   if(signal?.aborted)return;
   setSnapshot(next);setError('');
  }catch(error:any){if(!signal?.aborted)setError(error.message);}
 },[ids]);
 const refresh=useCallback(()=>fetchSnapshot(),[fetchSnapshot]);
 const live=!!ids&&!!snapshot?.settings.enabled&&Object.values(snapshot.statuses).some(status=>status.stage==='queued'||status.stage==='ocr'||status.stage==='translating');
 useVisiblePoll(fetchSnapshot,live?3000:null,[fetchSnapshot,tick]);
 useEffect(()=>ids?subscribeWorkspaceEvents({message:event=>{if(event.type==='reading.processing')setTick(value=>value+1);},reconnect:()=>setTick(value=>value+1)}):undefined,[ids]);
 async function settings(change:Partial<ReadingSettings>) {
  if(!snapshot)return;
  setBusy(true);
  try {
   await api('/api/workspace/bilingual/processing',json('PUT',{expectedRevision:snapshot.revision,...change}));
   await refresh();
  }catch(error:any){setError(error.message);if(error.status===409)await refresh();}
  finally{setBusy(false);}
 }
 async function enqueue(ids:string[]) {
  setBusy(true);
  try {await api('/api/workspace/bilingual/processing',json('POST',{resourceIds:ids}));await refresh();}
  catch(error:any){setError(error.message);}
  finally{setBusy(false);}
 }
 return {snapshot,error,busy,settings,enqueue};
}
export type ReadingProcessing=ReturnType<typeof useReadingProcessing>;

export function ProcessingControls({processing,resourceIds,id,expanded:controlledExpanded,onExpandedChange,pageOnly=false}:{processing:ReadingProcessing;resourceIds:string[];id?:string;expanded?:boolean;onExpandedChange?:(expanded:boolean)=>void;pageOnly?:boolean}) {
 const [localExpanded,setLocalExpanded]=useState(false);
 const expanded=controlledExpanded??localExpanded;
 const setExpanded=(value:boolean)=>{setLocalExpanded(value);onExpandedChange?.(value);};
 const {snapshot,error,busy,settings,enqueue}=processing;
 const statuses=Object.values(snapshot?.statuses??{});
 const cached=statuses.filter(status=>status.stage==='complete').length;
 const active=statuses.find(status=>status.stage==='ocr'||status.stage==='translating');
 const activeCount=statuses.filter(status=>status.stage==='ocr'||status.stage==='translating').length;
 const pending=statuses.filter(status=>status.stage==='queued').length;
 const remaining=resourceIds.filter(id=>snapshot?.statuses[id]?.stage!=='complete');
 const engines=snapshot?.choices?.engines??[];
 const translations=snapshot?.choices?.translations??[];
 const engineId=snapshot?.settings.engineId??'';
 const translationId=snapshot?.settings.translationSourceId??translations[0]?.id??'';
 return <div className="reading-processing" id={id}>
  <div className="reading-processing-bar">
   <label><input type="checkbox" checked={snapshot?.settings.enabled??false} disabled={!snapshot||busy} onChange={event=>void settings({enabled:event.target.checked})}/>自动 OCR 与翻译</label>
   <span className="reading-processing-summary" role="status">
    {active?<><LoaderCircle size={12} className="spin"/>{activeCount>1?`同时处理 ${activeCount} 篇`:readingStatusText(active)}</>:<><Check size={12}/>{pageOnly&&'本页 '}{cached}/{resourceIds.length} 篇已缓存</>}
    {pending>0&&<span> · {pending} 篇排队</span>}
   </span>
   <button className="processing-settings" title="自动缓存设置" aria-label="自动缓存设置" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><Settings2 size={14}/></button>
  </div>
  {expanded&&<div className="reading-processing-options">
   <div className="processing-source-selectors">
    <label className="processing-source-field">OCR 引擎
     <select aria-label="自动 OCR 引擎" value={engineId} disabled={!snapshot||busy} onChange={event=>void settings({engineId:event.target.value})}>
      {!engines.some(engine=>engine.id===engineId)&&<option value={engineId} disabled>请选择 OCR 引擎</option>}
      {engines.map(engine=><option key={engine.id} value={engine.id}>{engine.label}{engine.configured?'':' · 未配置'}</option>)}
     </select>
    </label>
    <label className="processing-source-field">翻译模型
     <select aria-label="自动翻译模型" value={translationId} disabled={!snapshot||busy||!translations.length} onChange={event=>void settings({translationSourceId:event.target.value})}>
      {!translations.some(source=>source.id===translationId)&&<option value={translationId} disabled>{translationId?'所选来源已停用，请重新选择':'请先在设置中启用翻译来源'}</option>}
      {translations.map(source=><option key={source.id} value={source.id}>{source.label} · {source.model}{source.configured?'':' · 未配置'}</option>)}
     </select>
    </label>
   </div>
   <label><input type="checkbox" checked={snapshot?.settings.translateAppendix??false} disabled={!snapshot||busy} onChange={event=>void settings({translateAppendix:event.target.checked})}/>自动翻译包含附录</label>
   {snapshot?.parallelism&&<small>OCR {snapshot.parallelism.ocr} 路 · 翻译 {snapshot.parallelism.translation} 路并发{snapshot.parallelism.throttled?' · 繁忙冷却中，稳定后逐步提速':' · 稳定时自动提速'}{snapshot.parallelism.ocrMax&&snapshot.parallelism.translationMax?` · 上限 ${snapshot.parallelism.ocrMax}/${snapshot.parallelism.translationMax}`:''}</small>}
   <small>所选配置用于新文献与待完成任务。蓝色序号表示本地缓存完成。</small>
   <button disabled={busy||!snapshot?.settings.enabled||!remaining.length} onClick={()=>void enqueue(remaining)}><RefreshCw size={12}/>{pageOnly?'缓存本页文献':'缓存已有文献'}{remaining.length?`（${remaining.length}）`:''}</button>
  </div>}
  {error&&<p role="alert" className="processing-error">{error}</p>}
 </div>;
}

export function ProcessingBadge({status,enabled,onRetry}:{status?:ReadingStatus;enabled?:boolean;onRetry?:()=>void}) {
 if(!status||(status.stage==='uncached'&&!status.total))return null;
 const label=readingStatusText(status,enabled);
 return <span className={`processing-badge is-${status.stage}`} title={status.error??label}>
  {status.stage==='complete'?<Check size={11}/>:status.stage==='ocr'||status.stage==='translating'?<LoaderCircle size={11} className="spin"/>:status.stage==='failed'?<AlertCircle size={11}/>:null}
  {label}
  {status.stage==='failed'&&onRetry&&<button aria-label="重试缓存" onClick={onRetry}><RefreshCw size={11}/></button>}
 </span>;
}
