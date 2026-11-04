import {useEffect,useMemo,useRef,useState} from 'react';
import {CalendarRange,Check,ExternalLink,LoaderCircle,Plus,RefreshCw,Search,Settings2,Trash2} from 'lucide-react';
import type {ConferenceEdition,ConferenceResponse} from '../../shared/conference-types';
import type {ConferenceTimeline as Timeline,TrackedConference,ResolvedConferenceTimeline} from '../../shared/conference-timeline';
import {api,json} from '../api';
import HubDialog from './HubDialog';
import {safeConferenceUrl,type SubmissionPaper} from './conferenceWatch';
import {milestoneInput,milestoneLabel,nextTimelineColor,timelineAxis} from './conferenceTimelineData';
import './conference-timeline.css';

const endpoint='/api/workspace/conference-timeline';
const conferenceName=(c:TrackedConference)=>`${c.title} ${c.year}${c.roundLabel?` · ${c.roundLabel}`:''}`;
const clone=<T,>(value:T):T=>structuredClone(value);
const shortDate=(at:number)=>milestoneInput(new Date(at).toISOString()).slice(5,10).replace('-','/');
const statusLabel=(conference:TrackedConference)=>conference.sourceStatus==='ready'?'官网时间已同步':conference.sourceStatus==='partial'?'部分节点待公布':'官网时间待公布';

export default function ConferenceTimeline({papers=[],editions=[],now=Date.now()}:{papers?:SubmissionPaper[];editions?:ConferenceEdition[];now?:number}){
 const [timeline,setTimeline]=useState<Timeline>(),[loadError,setLoadError]=useState(''),[loading,setLoading]=useState(false),[open,setOpen]=useState(false),[draft,setDraft]=useState<Timeline>(),[selected,setSelected]=useState(''),[saving,setSaving]=useState(false),[saveError,setSaveError]=useState(''),[conflict,setConflict]=useState(false);
 const [query,setQuery]=useState(''),[found,setFound]=useState<ConferenceEdition[]>([]),[searching,setSearching]=useState(false),[searchError,setSearchError]=useState(''),[sourceChoice,setSourceChoice]=useState(''),[roundChoice,setRoundChoice]=useState(''),[resolving,setResolving]=useState('');
 const axisRef=useRef<HTMLDivElement>(null),[axisWidth,setAxisWidth]=useState(640);
 async function load(signal?:AbortSignal){setLoading(true);setLoadError('');try{const result=await api<Timeline>(endpoint,{signal});if(!signal?.aborted)setTimeline(result);return result;}catch(error:any){if(!signal?.aborted)setLoadError(error.message||'时间线读取失败。');}finally{if(!signal?.aborted)setLoading(false);}}
 useEffect(()=>{const controller=new AbortController();void load(controller.signal);return()=>controller.abort();},[]);
 useEffect(()=>{const node=axisRef.current;if(!node)return;const resize=new ResizeObserver(entries=>setAxisWidth(entries[0].contentRect.width));resize.observe(node);return()=>resize.disconnect();},[timeline]);
 useEffect(()=>{
  if(!open||!query.trim()){setFound([]);setSearchError('');setSearching(false);return;}
  const controller=new AbortController(),timer=setTimeout(async()=>{setSearching(true);setSearchError('');try{const params=new URLSearchParams({q:query.trim(),rank:'all',sort:'year',limit:'100'});const result=await api<ConferenceResponse>(`/api/conferences?${params}`,{signal:controller.signal});if(!controller.signal.aborted)setFound(result.conferences);}catch(error:any){if(!controller.signal.aborted)setSearchError(error.message||'检索失败。');}finally{if(!controller.signal.aborted)setSearching(false);}},250);
  return()=>{controller.abort();clearTimeout(timer);};
 },[query,open]);
 const axis=useMemo(()=>timelineAxis(timeline||{revision:0,conferences:[]},now,axisWidth),[timeline,now,axisWidth]);
 const enabled=timeline?.conferences.filter(c=>c.enabled)||[];
 const options=useMemo(()=>{
  const all=new Map<string,ConferenceEdition>();for(const edition of [...editions,...found])all.set(edition.id,edition);
  const tokens=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return [...all.values()].filter(c=>!tokens.length||tokens.every(token=>`${c.title} ${c.year} ${c.description}`.toLowerCase().includes(token))).sort((a,b)=>Number(papers.some(p=>p.deadlineSource?.conferenceId===b.id))-Number(papers.some(p=>p.deadlineSource?.conferenceId===a.id))||b.year-a.year||a.title.localeCompare(b.title));
 },[editions,found,query,papers]);
 const source=options.find(c=>c.id===sourceChoice);
 function manage(conferenceId?:string){const current=draft||timeline;if(!current)return;if(!draft)setDraft(clone(current));setSelected(current.conferences.some(c=>c.id===conferenceId)?conferenceId!:current.conferences[0]?.id||'');setOpen(true);if(!conflict)setSaveError('');}
 function updateConference(id:string,patch:Partial<TrackedConference>){setDraft(current=>current?{...current,conferences:current.conferences.map(c=>c.id===id?{...c,...patch}:c)}:current);}
 async function resolveConference(conferenceId:string,roundId?:string,refresh=false){return api<ResolvedConferenceTimeline>(endpoint+'/resolve',json('POST',{conferenceId,...(roundId?{roundId}:{}),...(refresh?{refresh:true}:{})}));}
 async function addSelected(){
  if(!source||!draft||resolving)return;const round=source.rounds.find(r=>r.id===roundChoice);
  if(source.rounds.length>1&&!round){setSaveError('请选择明确的投稿轮次。');return;}
  if(draft.conferences.some(c=>c.conferenceId===source.id&&(c.roundId||c.roundLabel||'')===(round?.id||round?.label||''))){setSaveError('此会议和轮次已在时间线中。');return;}
  setResolving('add');setSaveError('');try{const resolved=await resolveConference(source.id,round?.id),conference:TrackedConference={...resolved,id:crypto.randomUUID(),roundId:round?.id||resolved.roundId,color:nextTimelineColor(draft.conferences),enabled:true,paperIds:papers.filter(p=>p.deadlineSource?.conferenceId===source.id).map(p=>p.id)};setDraft(current=>current?{...current,conferences:[...current.conferences,conference]}:current);setSelected(conference.id);setSourceChoice('');setRoundChoice('');}catch(error:any){setSaveError(error.message||'官网时间读取失败，请稍后重试。');}finally{setResolving('');}
 }
 async function refreshConference(conference:TrackedConference){if(!conference.conferenceId||resolving)return;setResolving(conference.id);setSaveError('');try{const resolved=await resolveConference(conference.conferenceId,conference.roundId,true);if(resolved.sourceStatus==='unavailable'&&conference.milestones.length){setSaveError(`${conference.title} ${conference.year} 官网暂时无法读取，已保留原有时间节点，请稍后刷新。`);return;}updateConference(conference.id,resolved);}catch(error:any){setSaveError(error.message||'官网刷新失败，原节点已保留。');}finally{setResolving('');}}
 async function save(){if(!draft||resolving)return;setSaving(true);setSaveError('');try{const result=await api<Timeline>(endpoint,json('PUT',{expectedRevision:draft.revision,conferences:draft.conferences}));setTimeline(result);setDraft(undefined);setConflict(false);setOpen(false);}catch(error:any){setSaveError(error.message||'时间线保存失败，选择仍保留。');if(error.status===409)setConflict(true);}finally{setSaving(false);}}
 async function reloadDraft(){const result=await load();if(result){setDraft(clone(result));setSelected(result.conferences[0]?.id||'');setConflict(false);setSaveError('');}}
 return <>
  <section className={`conference-timeline ${enabled.length?'has-tracked':''}`} aria-label="已投稿会议时间线">
   <div className="conference-timeline-heading"><h3><CalendarRange size={13}/>投稿时间线</h3><div className="conference-timeline-legend">{enabled.map(c=><span key={c.id} style={{color:c.color}} title={conferenceName(c)}><i style={{background:c.color}}/>{c.title} {c.year}</span>)}</div><button type="button" onClick={()=>manage()} disabled={loading||!timeline}><Settings2 size={12}/>选择会议</button></div>
   {loadError?<p className="conference-timeline-error" role="alert">{loadError}<button onClick={()=>void load()}>重试</button></p>:loading&&!timeline?<p className="conference-timeline-empty">正在同步会议时间…</p>:enabled.length?<>
    <div className="conference-timeline-axis" ref={axisRef} role="group" aria-label={`从今天到${axis.provisional?'已公布的最后节点':axis.lastResult?.conference.title+' '+axis.lastResult?.milestone.label}，节点按实际日期比例排列`}>
     <div className="conference-timeline-axis-line"/><span className="conference-timeline-today"><i/>今天<small>{shortDate(axis.start)}</small></span><span className="conference-timeline-end"><i/>{axis.provisional?'待公布':'结果通知'}<small>{axis.provisional?'':shortDate(axis.end)}</small></span>
     {[.25,.5,.75].map(position=><span className="conference-timeline-tick" key={position} style={{left:`${position*100}%`}}><i/><small>{shortDate(axis.start+(axis.end-axis.start)*position)}</small></span>)}
     <svg className="conference-timeline-leaders" viewBox="0 0 100 96" preserveAspectRatio="none" aria-hidden="true">{axis.labels.map(group=><path key={group.column} d={`M ${group.anchor*100} 44 L ${group.position*100} ${group.lane?62:28}`} fill="none" stroke="#cdd6e4" strokeWidth=".13"/>)}</svg>
     {axis.events.map(({conference,milestone,position})=><button key={conference.id+milestone.id} className="conference-timeline-dot" style={{left:`${position*100}%`,background:conference.color}} onClick={()=>manage(conference.id)} aria-label={`${conferenceName(conference)} ${milestone.label} ${milestoneLabel(milestone)}`} title={`${conferenceName(conference)} · ${milestone.label}\n${milestoneLabel(milestone)}${milestone.at?' 北京时间':''}${milestone.note?'\n'+milestone.note:''}`}/>)}
     {axis.labels.map(group=><button key={group.column} className={`conference-timeline-label lane-${group.lane}`} style={{left:`${group.position*100}%`,width:`${group.width}px`,maxWidth:`${group.width}px`}} onClick={()=>manage(group.events[0].conference.id)} title={group.events.map(e=>`${conferenceName(e.conference)} · ${e.milestone.label} · ${milestoneLabel(e.milestone)}`).join('\n')}>{group.events.slice(0,2).map(({conference,milestone})=><span style={{color:conference.color}} key={conference.id+milestone.id}><strong>{conference.title}</strong> {milestone.label}<small>{milestoneLabel(milestone).slice(5,10).replace('-','/')}</small></span>)}{group.events.length>2&&<small className="conference-timeline-more-nodes">另 {group.events.length-2} 个节点</small>}</button>)}
     {!axis.events.length&&<span className="conference-timeline-axis-waiting">官网尚未公布后续时间节点</span>}
    </div>
    {!!axis.pending.length&&<p className="conference-timeline-pending">{axis.pending.map(c=>`${c.title} ${c.year}`).join('、')}：结果日期待公布</p>}
   </>:<p className="conference-timeline-empty">从今天到结果通知，自动呈现已投稿会议的重要节点。<button onClick={()=>manage()} disabled={!timeline}>＋ 选择会议</button></p>}
  </section>
  {open&&<HubDialog title="选择已投稿会议" onClose={()=>{if(!saving)setOpen(false);}} wide><div className="academic-form conference-timeline-form">
   <p className="academic-help">选择会议后自动读取官网时间节点并分配颜色。时间轴从今天延伸到最后一场会议的结果通知；未公布的日期保持待公布。</p>
   <div className="conference-timeline-add"><label className="conference-timeline-search"><Search size={14}/><input aria-label="搜索时间线会议" placeholder="搜索会议或年份，包含已截止的投稿会议" value={query} maxLength={100} onChange={e=>{setQuery(e.target.value);setSourceChoice('');setRoundChoice('');}}/>{searching&&<LoaderCircle size={13} className="spin"/>}</label><div className="conference-timeline-pick"><select aria-label="选择已投稿会议" value={sourceChoice} onChange={e=>{setSourceChoice(e.target.value);const edition=options.find(c=>c.id===e.target.value);setRoundChoice(edition?.rounds.length===1?edition.rounds[0].id:'');}}><option value="">选择会议与年份</option>{options.map(c=><option key={c.id} value={c.id}>{c.title} {c.year}{papers.some(p=>p.deadlineSource?.conferenceId===c.id)?' · 已关联论文':''}</option>)}</select><select aria-label="选择投稿轮次" value={roundChoice} onChange={e=>setRoundChoice(e.target.value)} disabled={!source||!source.rounds.length}><option value="">{source?.rounds.length?'选择轮次':'暂无轮次'}</option>{source?.rounds.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select><button type="button" className="academic-secondary" disabled={!source||!draft||!!resolving} onClick={()=>void addSelected()}>{resolving==='add'?<LoaderCircle size={13} className="spin"/>:<Plus size={13}/>}加入时间线</button></div>{searchError&&<p role="alert" className="conference-timeline-error">{searchError}</p>}</div>
   <div className="conference-timeline-selections" aria-label="已选择的投稿会议">{draft?.conferences.map(c=><section key={c.id} className={`conference-timeline-selection ${selected===c.id?'selected':''}`} style={{borderLeftColor:c.color}}>
    <header><label><input type="checkbox" aria-label={`显示 ${conferenceName(c)}`} checked={c.enabled} onChange={e=>updateConference(c.id,{enabled:e.target.checked})}/><strong style={{color:c.color}}>{conferenceName(c)}</strong></label><span className={`conference-timeline-source-status ${c.sourceStatus||'unavailable'}`}>{c.sourceStatus==='ready'&&<Check size={11}/>} {statusLabel(c)}</span><button type="button" disabled={!!resolving||!c.conferenceId} title="从官网重新读取时间" aria-label={`刷新 ${conferenceName(c)} 时间`} onClick={()=>void refreshConference(c)}>{resolving===c.id?<LoaderCircle size={13} className="spin"/>:<RefreshCw size={13}/>}</button><button type="button" aria-label={`移除 ${conferenceName(c)}`} title="从时间线移除，保存后生效" onClick={()=>setDraft(current=>current?{...current,conferences:current.conferences.filter(item=>item.id!==c.id)}:current)}><Trash2 size={13}/></button></header>
    <div className="conference-timeline-imported-nodes">{c.milestones.filter(m=>m.at||m.date).map(m=><span key={m.id}><strong>{m.label}</strong><time dateTime={m.at||m.date}>{milestoneLabel(m)}{m.at?' 北京时间':''}</time></span>)}{!c.milestones.some(m=>m.at||m.date)&&<span className="conference-timeline-official-pending">官网尚未公布可用日期</span>}</div>
    {c.warning&&<p className="conference-timeline-source-warning">{c.warning}</p>}<footer>{[...new Set([c.officialUrl,...c.sourceUrls||[]].filter(Boolean))].map((url,index)=>safeConferenceUrl(url)&&<a key={url} href={safeConferenceUrl(url)} target="_blank" rel="noreferrer">{index?'时间来源':'会议官网'}<ExternalLink size={10}/></a>)}{c.fetchedAt&&<small>同步于 {milestoneInput(c.fetchedAt).replace('T',' ')} 北京时间</small>}</footer>
   </section>)}{!draft?.conferences.length&&<div className="conference-timeline-no-selections"><CalendarRange size={22}/><p>选择已经投稿的会议，后续节点会自动呈现。</p></div>}</div>
   {saveError&&<div className="academic-metadata-conflict" role="alert">{saveError}{conflict&&<><p>本次选择已保留。重新载入会采用最新保存记录，请先保留需要的本地选择。</p><button className="academic-secondary" type="button" onClick={()=>void reloadDraft()}>重新载入最新版本</button></>}</div>}
   <footer><span className="conference-timeline-save-hint">颜色与时间自动处理，无需逐项填写。</span><button type="button" className="academic-secondary" disabled={saving} onClick={()=>setOpen(false)}>稍后继续</button><button type="button" className="academic-primary" disabled={saving||!draft||conflict||!!resolving} onClick={()=>void save()}>{saving?<LoaderCircle size={14} className="spin"/>:null}保存选择</button></footer>
  </div></HubDialog>}
 </>;
}
