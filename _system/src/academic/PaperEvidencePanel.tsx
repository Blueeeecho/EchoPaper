import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowUpRight,RefreshCw} from 'lucide-react';
import type {PaperEvidenceData,PaperEvidenceContext,PaperEvidenceEntry} from '../../shared/paper-evidence';
import {USAGE_PURPOSES,EVIDENCE_STATES,entryPath,usageKey,type ResearchUsageInput} from '../../shared/research-entries';
import {api,json} from '../api';
import HubDialog from './HubDialog';
export default function PaperEvidencePanel({projectId,path,onClose,onNavigate,onGuard,beforeAssociate}:{projectId:string;path:string;onClose:()=>void;onNavigate:(path:string)=>void;onGuard:(fn:(()=>boolean)|undefined)=>void;beforeAssociate:()=>Promise<boolean>}){
 const [data,setData]=useState<PaperEvidenceData>(),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[committed,setCommitted]=useState(false),[notice,setNotice]=useState('');
 const [topicId,setTopicId]=useState(''),[entryId,setEntryId]=useState(''),[purpose,setPurpose]=useState<ResearchUsageInput['purpose']>('claim'),[location,setLocation]=useState(''),[query,setQuery]=useState('');
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;onGuard(undefined);};},[onGuard]);
 const dirty=!!entryId||!!location.trim()||purpose!=='claim';
 const guard=()=>!busy&&(!dirty||window.confirm('论文证据关联尚未保存。放弃本次选择？'));
 useEffect(()=>{onGuard(guard);return()=>onGuard(undefined);},[busy,dirty,onGuard]);
 useEffect(()=>{if(!dirty&&!busy)return;const fn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',fn);return()=>window.removeEventListener('beforeunload',fn);},[dirty,busy]);
 const endpoint=`/api/projects/${encodeURIComponent(projectId)}/research-evidence?${new URLSearchParams({path})}`;
 async function load(strict=false){setLoading(true);try{const r=await api<PaperEvidenceData>(endpoint);if(alive.current){setData(r);setError('');}return r;}catch(e:any){if(alive.current)setError(e.message);if(strict)throw e;}finally{if(alive.current)setLoading(false);}}
 useEffect(()=>{void load();},[projectId,path]);
 const context=data?.contexts.find(t=>t.topicId===topicId)||data?.contexts[0],entry=context?.entries.find(e=>e.id===entryId);
 function close(){if(!guard())return;onGuard(undefined);onClose();}
 function navigate(target:string){if(!guard())return;onGuard(undefined);onClose();onNavigate(target);}
 async function update(ctx:PaperEvidenceContext,e:PaperEvidenceEntry,body:object){
  if(busy||committed)return;setBusy(true);setError('');setNotice('');let written=false;
  try{if(!await beforeAssociate())throw Error('当前论文文件尚未安全保存，请先处理草稿或保存冲突。');await api(`/api/workspace/topics/${ctx.topicId}/entries/${e.id}`,json('PATCH',{expectedRevision:ctx.revision,expectedEntryRevision:e.revision,...body}));written=true;if(alive.current){setCommitted(true);setEntryId('');setLocation('');setPurpose('claim');}await load(true);if(alive.current){setCommitted(false);setNotice('论文证据关联已保存');}}
  catch(err:any){if(alive.current)setError(written?'关联已保存，列表刷新失败。请刷新关联，不要重复提交。':`${err.message} 当前选择已保留，请刷新列表并核对后再保存。`);}finally{if(alive.current)setBusy(false);}
 }
 async function refreshSaved(){setBusy(true);try{await load(true);if(alive.current)setCommitted(false);}catch{if(alive.current)setError('关联已保存，列表刷新仍未完成。请重试刷新。');}finally{if(alive.current)setBusy(false);}}
 function submit(e:FormEvent){e.preventDefault();if(!context||!entry)return;const usage={paperId:projectId,path,purpose,location:location.trim()};if(entry.usages.some(u=>usageKey(u)===usageKey(usage))){setError('该使用位置已经关联，无需重复保存。');return;}void update(context,entry,{usages:[...entry.usages,usage]});}
 const links=data?.contexts.flatMap(ctx=>ctx.entries.flatMap(e=>e.links.map(link=>({ctx,e,...link}))))||[];
 return <HubDialog title="当前文件证据" onClose={close} wide><div className="paper-evidence-panel">
  <header><div><strong>{path}</strong><small>关联课题证据，查看来源链并往返到实验。</small></div><button type="button" className="academic-secondary" disabled={busy||loading} onClick={()=>void load()}><RefreshCw size={14}/>刷新列表</button></header>
  {loading&&!data&&<p role="status">正在读取关联与来源链…</p>}
  {error&&<p role="alert" className="academic-inline-error">{error}</p>}{notice&&<p role="status" className="paper-evidence-notice">{notice}</p>}
  <section className="paper-evidence-linked" aria-label="当前文件已关联证据"><h3>已关联证据 · {links.length}</h3>{!links.length?<p className="entry-unspecified">当前文件尚未关联证据。</p>:links.map(({ctx,e,usage,state})=><article key={`${ctx.topicId}:${e.id}:${usageKey(usage)}`}><header><div><strong>{e.title}</strong><small>{ctx.title} · {(EVIDENCE_STATES as Record<string,string>)[e.state]} · v{e.revision}</small></div><button type="button" disabled={busy} onClick={()=>navigate(entryPath(ctx.topicId,{id:e.id,kind:'evidence'}))}>查看证据<ArrowUpRight size={13}/></button></header><p>{USAGE_PURPOSES[usage.purpose]}{usage.location?` · ${usage.location}`:''}</p><span className={`entry-source-status ${e.sourceState}`}>{e.sourceMessage}</span><details><summary>使用位置版本{state==='changed'?' · 文件已更新':''}</summary><small>{new Date(usage.capturedAt).toLocaleString('zh-CN')} · SHA256 {usage.fingerprint.slice(0,12)}</small><p>{state==='changed'?'论文文件自关联后已变化，请核对使用位置。':'文件内容与关联时一致。'}</p>{state==='changed'&&<button type="button" disabled={busy||committed} onClick={()=>void update(ctx,e,{refreshUsageKeys:[usageKey(usage)]})}>记录当前文件版本</button>}</details><button type="button" className="paper-evidence-remove" disabled={busy||committed} onClick={()=>void update(ctx,e,{usages:e.usages.filter(u=>usageKey(u)!==usageKey(usage))})}>解除此关联</button></article>)}</section>
  {data&&<><form className="paper-evidence-form" onSubmit={submit}><h3>关联已有证据</h3>{!data.contexts.length?<p>先将这篇论文关联到研究课题，即可选择该课题的证据。</p>:<>
   {data.contexts.length===1&&context&&<p>研究课题：{context.title}</p>}
   {data.contexts.length>1&&<label>研究课题<select aria-label="选择证据所属课题" disabled={busy||committed} value={context?.topicId||''} onChange={e=>{setTopicId(e.target.value);setEntryId('');setQuery('');}}>{data.contexts.map(t=><option key={t.topicId} value={t.topicId}>{t.title}</option>)}</select></label>}
   {(context?.entries.length||0)>10&&<label>查找证据<input aria-label="查找文件可关联证据" value={query} onChange={e=>setQuery(e.target.value)} disabled={busy||committed}/></label>}
   <label>证据条目<select aria-label="选择当前文件的证据" disabled={busy||committed} value={entryId} onChange={e=>setEntryId(e.target.value)}><option value="">选择已有证据条目…</option>{context?.entries.filter(e=>!query.trim()||e.id===entryId||e.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(e=><option key={e.id} value={e.id}>{e.title} · {(EVIDENCE_STATES as Record<string,string>)[e.state]}</option>)}</select></label>
   {!context?.entries.length&&<p>该课题尚无证据条目，可先在“结果与证据”中建立。</p>}
   <div className="paper-evidence-form-grid"><label>用于<select aria-label="证据使用类型" disabled={busy||committed} value={purpose} onChange={e=>setPurpose(e.target.value as ResearchUsageInput['purpose'])}>{Object.entries(USAGE_PURPOSES).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>位置说明<input aria-label="证据使用位置说明" maxLength={500} placeholder="例如：第3节 / Fig.2 / Table 1" disabled={busy||committed} value={location} onChange={e=>setLocation(e.target.value)}/></label></div>
   <footer>{committed?<button type="button" className="academic-primary" disabled={busy} onClick={()=>void refreshSaved()}>刷新关联</button>:<button className="academic-primary" disabled={busy||!entry}>{busy?'保存中…':'保存文件关联'}</button>}</footer>
  </>}</form>
  <nav className="paper-evidence-navigation" aria-label="科研关联入口"><button type="button" onClick={()=>navigate(context?`/results?topic=${context.topicId}`:'/topics')}>{context?'管理课题证据':'关联研究课题'}<ArrowUpRight size={13}/></button>{data.basisPath?<button type="button" onClick={()=>navigate(data.basisPath!)}>研究依据<ArrowUpRight size={13}/></button>:<small>尚无研究依据笔记</small>}<button type="button" onClick={()=>navigate(data.reviewPath)}>审稿与回复<ArrowUpRight size={13}/></button><button type="button" onClick={()=>navigate(data.presentationPath)}>制作汇报<ArrowUpRight size={13}/></button></nav></>}
 </div></HubDialog>;
}
