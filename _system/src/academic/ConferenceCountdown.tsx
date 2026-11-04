import {useEffect,useMemo,useRef,useState} from 'react';
import {CalendarClock,ExternalLink,LoaderCircle,Pin,PinOff,RefreshCw,Search,X} from 'lucide-react';
import type {ConferenceResponse} from '../../shared/conference-types';
import {formatDeadlineLocal} from '../../shared/deadline';
import {api} from '../api';
import {buildConferenceEntries,normaliseWatchPreferences,safeConferenceUrl,WATCH_STORAGE_KEY,type WatchPreferences,type WatchEntry,type WatchRank,type SubmissionPaper} from './conferenceWatch';
import ConferenceTimeline from './ConferenceTimeline';
import './conference-countdown.css';

function readPreferences(){try{return normaliseWatchPreferences(JSON.parse(localStorage.getItem(WATCH_STORAGE_KEY)||'null'));}catch{return normaliseWatchPreferences(null);}}
function beijing(at:string){try{return formatDeadlineLocal(new Date(at).toISOString().replace(/\.\d{3}Z$/,'Z'),'Asia/Shanghai').replace('T',' ').slice(0,16);}catch{return '时间待核对';}}
function remaining(at:string,now:number){const seconds=Math.max(0,Math.ceil((Date.parse(at)-now)/1000)),days=Math.floor(seconds/86400),pad=(v:number)=>String(v).padStart(2,'0');return `${days} 天 ${pad(Math.floor(seconds/3600)%24)}:${pad(Math.floor(seconds/60)%60)}:${pad(seconds%60)}`;}
export default function ConferenceCountdown({papers=[]}:{papers?:SubmissionPaper[]}){
 const [preferences,setPreferences]=useState(readPreferences),[data,setData]=useState<ConferenceResponse>(),[now,setNow]=useState(Date.now()),[query,setQuery]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[preferenceError,setPreferenceError]=useState(''),[expanded,setExpanded]=useState(false);
 const request=useRef<AbortController|undefined>(undefined);
 const [searchData,setSearchData]=useState<ConferenceResponse>(),[searchLoading,setSearchLoading]=useState(false),[searchError,setSearchError]=useState('');
 const searchRequest=useRef<AbortController|undefined>(undefined),searchTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 async function searchSource(value:string){
  searchRequest.current?.abort();if(!value.trim()){setSearchData(undefined);setSearchLoading(false);setSearchError('');return;}
  const controller=new AbortController();searchRequest.current=controller;setSearchLoading(true);setSearchError('');
  try{
   const params=new URLSearchParams({q:value.trim(),rank:'all',sort:'year',limit:'200'}),all:ConferenceResponse['conferences']=[];let result:ConferenceResponse|undefined;
   for(let page=0;page<100;page++){
    params.set('offset',String(all.length));const part=await api<ConferenceResponse>(`/api/conferences?${params}`,{signal:controller.signal});all.push(...part.conferences);result={...part,conferences:all};
    if(!part.pagination?.hasMore)break;
    if(!part.conferences.length||page===99)throw Error('会议检索数据不完整，请重试。');
   }
   if(!controller.signal.aborted&&result)setSearchData(result);
  }
  catch(e:any){if(!controller.signal.aborted)setSearchError(e.message||'会议检索失败，请重试。');}
  finally{if(!controller.signal.aborted)setSearchLoading(false);}
 }
 useEffect(()=>{searchTimer.current=setTimeout(()=>void searchSource(query),250);return()=>{clearTimeout(searchTimer.current);searchRequest.current?.abort();};},[query]);
 async function load(force=false){
  request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');
  try{
   let offset=0,result:ConferenceResponse|undefined;const all:ConferenceResponse['conferences']=[],seen=new Set<string>();
   for(let page=0;page<100;page++){
    const params=new URLSearchParams({upcoming:'1',sort:'deadline',rank:'all',limit:'200',offset:String(offset)});if(force&&page===0)params.set('refresh','1');
    const part=await api<ConferenceResponse>(`/api/conferences?${params}`,{signal:controller.signal});
    for(const edition of part.conferences)if(!seen.has(edition.id)){seen.add(edition.id);all.push(edition);}
    result={...part,conferences:all,stale:!!result?.stale||part.stale,warning:part.warning||result?.warning};
    if(!part.pagination?.hasMore)break;
    if(!part.conferences.length)throw Error('会议分页数据不完整，请刷新来源。');offset+=part.conferences.length;
    if(page===99)throw Error('会议数据超过展示上限，请稍后重试。');
   }
   if(!controller.signal.aborted&&result){setData(result);setNow(Date.now());}
  }catch(e:any){if(!controller.signal.aborted)setError(e.message||'会议来源暂不可用。');}
  finally{if(!controller.signal.aborted)setLoading(false);}
 }
 useEffect(()=>{void load();const timer=setInterval(()=>setNow(Date.now()),1000);const sync=(event:StorageEvent)=>{if(event.key===WATCH_STORAGE_KEY||event.key===null)setPreferences(readPreferences());};window.addEventListener('storage',sync);return()=>{request.current?.abort();clearInterval(timer);window.removeEventListener('storage',sync);};},[]);
 function savePreferences(next:WatchPreferences){setPreferences(next);setPreferenceError('');try{localStorage.setItem(WATCH_STORAGE_KEY,JSON.stringify(next));}catch{setPreferenceError('浏览器未能保存偏好，本次筛选和置顶仍有效。');}}
 function toggleRank(rank:WatchRank){savePreferences({...preferences,ranks:preferences.ranks.includes(rank)?preferences.ranks.filter(r=>r!==rank):[...preferences.ranks,rank]});setExpanded(false);}
 function togglePin(entry:WatchEntry){const {edition,pinned}=entry;savePreferences({...preferences,pinned:pinned?preferences.pinned.filter(p=>p.id!==edition.id):[...preferences.pinned,{id:edition.id,label:`${edition.title} ${edition.year}`}]});}
 const source=query.trim()?searchData:data;
 const {entries,hiddenPinned}=useMemo(()=>buildConferenceEntries(source?.conferences||[],preferences,now,query,papers),[source,preferences,now,query,papers]);
 const searching=!!query.trim()&&(searchLoading||!searchData&&!searchError),visible=expanded?entries:entries.slice(0,6);
 const unavailable=searchData?.conferences.filter(c=>!c.rounds.some(r=>r.deadlineAt&&Date.parse(r.deadlineAt)>now))||[];
 const exactUnavailable=unavailable.filter(c=>c.title.toLowerCase()===query.trim().toLowerCase());
 const recentUnavailable=(exactUnavailable.length?exactUnavailable:unavailable).slice(0,3);
 return <section className="academic-conference-watch" aria-label="近期会议倒计时">
  <div className="academic-section-title conference-watch-header"><h2><CalendarClock size={18}/>近期会议</h2><div className="conference-watch-controls"><div role="group" aria-label="展示的 CCF 等级">{(['A','B','C'] as const).map(rank=><button key={rank} type="button" aria-pressed={preferences.ranks.includes(rank)} onClick={()=>toggleRank(rank)}>CCF {rank}</button>)}</div><form onSubmit={e=>{e.preventDefault();clearTimeout(searchTimer.current);void searchSource(query);}}><label><Search size={13}/><input aria-label="搜索倒计时会议" value={query} maxLength={100} onChange={e=>{setQuery(e.target.value);setSearchData(undefined);setSearchError('');setExpanded(false);}} placeholder="会议或年份"/></label>{query&&<button type="button" aria-label="清空会议搜索" onClick={()=>{setQuery('');setSearchData(undefined);}}><X size={12}/></button>}<button type="submit" aria-label="检索会议">检索</button></form></div><button type="button" disabled={loading} onClick={()=>{void load(true);if(query.trim())void searchSource(query);}} aria-label="刷新会议来源" title="刷新 CCFDDL 来源">{loading?<LoaderCircle size={15} className="spin"/>:<RefreshCw size={15}/>}</button></div>
  <p className="conference-watch-caption">正文截止 · 北京时间 · 近 → 远 · 投稿目标优先{query.trim()&&' · 搜索全部等级'}</p>
  <ConferenceTimeline papers={papers} editions={data?.conferences||[]} now={now}/>
  {loading&&!data&&<p className="conference-watch-message" role="status">正在读取 CCFDDL 会议…</p>}
  {error&&<div role="alert" className="conference-watch-warning">{error}{data&&' 仍显示上次取得的数据。'}<button disabled={loading} onClick={()=>void load(true)}>重试</button></div>}
  {preferenceError&&<p role="status" className="conference-watch-warning">{preferenceError}</p>}
  {searching&&<p role="status" className="conference-watch-message">正在检索会议来源…</p>}
  {searchError&&<p role="alert" className="conference-watch-warning">{searchError}<button onClick={()=>void searchSource(query)}>重试检索</button></p>}
  <div className={`conference-watch-list ${expanded?'expanded':''}`} aria-busy={loading}>
   {visible.map(entry=>{const {edition,round,pinned,prerequisite,submissionPaperIds}=entry,automatic=submissionPaperIds.length>0,url=safeConferenceUrl(edition.officialUrl),name=`${edition.title} ${edition.year}`,level=edition.ccf?.toUpperCase(),urgent=Date.parse(round.deadlineAt!)-now<86400000;return <article key={edition.id} data-conference-id={edition.id} className={`${pinned?'pinned ':''}${automatic?'in-submission ':''}${urgent?'urgent':''}`}>
    <div className="conference-watch-row"><div className="conference-watch-name"><strong>{name}</strong><span>{['A','B','C'].includes(level||'')?`CCF ${level}`:'未分级'}</span>{automatic?<small className="conference-watch-submission" title={`论文 ${submissionPaperIds.join('、')} 的投稿目标`}>投稿目标</small>:pinned&&<small>置顶</small>}</div><button className="conference-watch-pin" type="button" disabled={automatic} aria-label={automatic?`投稿目标自动置顶 ${name}`:`${pinned?'取消置顶':'置顶'} ${name}`} aria-pressed={pinned} onClick={()=>togglePin(entry)} title={automatic?'由论文投稿目标自动置顶':pinned?'取消置顶':'置顶，不受等级筛选影响'}>{pinned&&!automatic?<PinOff size={14}/>:<Pin size={14}/>}</button></div>
    <div className="conference-watch-row"><span className="conference-watch-date"><time dateTime={round.deadlineAt}>{beijing(round.deadlineAt!)}</time><small>{round.label}</small></span><span className="conference-watch-countdown"><small>剩余</small><strong>{remaining(round.deadlineAt!,now)}</strong></span></div>
    <div className="conference-watch-links"><details><summary>{prerequisite==='closed'?'摘要已截止 · 说明':prerequisite==='unknown'?'摘要待核对 · 说明':'截止说明'}</summary><div><p>{edition.description}</p><p>正文原文：{round.rawDeadline} · {round.sourceTimezone}</p>{round.rawAbstractDeadline&&<p>摘要截止：{round.abstractDeadlineAt?`${beijing(round.abstractDeadlineAt)} 北京时间`:round.rawAbstractDeadline}</p>}{prerequisite!=='open'&&<p>请核对官网的摘要登记要求。</p>}{round.comment&&<p>{round.comment}</p>}{round.notes.map((note,i)=><p key={i}>{note}</p>)}</div></details>{url?<a href={url} target="_blank" rel="noreferrer">会议官网<ExternalLink size={11}/></a>:<span>官网待公布</span>}</div>
   </article>;})}
  </div>
  {!entries.length&&!loading&&!searching&&!searchError&&source&&<p className="conference-watch-message">{query?'来源中未找到匹配且正文尚未截止的轮次。':'所选等级暂无正文未截止的轮次。'}{!query&&' 可调整等级或搜索会议。'}</p>}
  {query&&!entries.length&&!searching&&!searchError&&recentUnavailable.length>0&&<div className="conference-search-unavailable" aria-label="来源中的最近记录">{recentUnavailable.map(c=><div key={c.id}><strong>{c.title} {c.year}</strong><span>{c.rounds.some(r=>!r.deadlineAt)?'正文截止待公布':'正文已截止'}</span>{safeConferenceUrl(c.officialUrl)&&<a href={safeConferenceUrl(c.officialUrl)} target="_blank" rel="noreferrer">会议官网<ExternalLink size={10}/></a>}</div>)}<small>未公布的新年份或轮次不推测日期。</small></div>}
  {entries.length>6&&<button className="conference-watch-more" onClick={()=>setExpanded(v=>!v)}>{expanded?'收起列表':`查看其余 ${entries.length-6} 场会议`}</button>}
  {hiddenPinned.length>0&&data&&<details className="conference-watch-hidden"><summary>{hiddenPinned.length} 场置顶会议暂无可用正文截止</summary>{hiddenPinned.map(pin=><div key={pin.id}><span>{pin.label}</span><button aria-label={`取消置顶 ${pin.label}`} onClick={()=>savePreferences({...preferences,pinned:preferences.pinned.filter(p=>p.id!==pin.id)})}>取消置顶</button></div>)}</details>}
  <footer className="conference-watch-source"><div><a href="https://ccfddl.top/" target="_blank" rel="noreferrer">来源 CCFDDL<ExternalLink size={10}/></a>{source&&<span>{source.stale||error?'缓存待刷新':'数据已同步'} · {beijing(source.fetchedAt)}</span>}</div>{source?.warning&&<p role="status" className="conference-watch-warning">{source.warning}</p>}<p>正文未截止即展示；摘要要求见说明。以官网为准。置顶不受等级筛选影响。{!query&&!!data?.pendingCount&&`${data.pendingCount} 个待公布轮次未计时。`}</p></footer>
 </section>;
}
