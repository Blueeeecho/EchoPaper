import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConferenceResponse, ConferenceRound, ConferenceSelection } from '../../shared/conference-types';
import { deadlineCountdown, formatDeadlineLocal } from '../../shared/deadline';
import './ConferencePicker.css';
export interface ConferencePickerProps { onSelect: (selection: ConferenceSelection) => void; onClose?: () => void; initialQuery?: string; selectedRoundId?: string }
type Rank = 'all' | 'A' | 'B' | 'C';
function beijing(value?: string) { try { return value ? formatDeadlineLocal(value,'Asia/Shanghai').replace('T',' ') : ''; } catch { return ''; } }
function remaining(value: string, now: number) {
  const parts=deadlineCountdown(value,now); if(parts.expired)return '已截止'; if(!parts.totalMinutes)return '剩余不足1分';
  return `剩余 ${parts.days?`${parts.days}天 `:''}${parts.days||parts.hours?`${parts.hours}时 `:''}${parts.minutes}分`;
}
export default function ConferencePicker({ onSelect, onClose, initialQuery = '', selectedRoundId }: ConferencePickerProps) {
  const [query,setQuery]=useState(initialQuery), [rank,setRank]=useState<Rank>('all'), [data,setData]=useState<ConferenceResponse>(), [error,setError]=useState(''), [loading,setLoading]=useState(false), [chosenRoundId,setChosenRoundId]=useState<string>(), [now,setNow]=useState(Date.now());
  const request=useRef<AbortController|null>(null);
  async function load(force=false, selectedRank=rank) {
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');
    try {
      const params=new URLSearchParams({q:query,rank:selectedRank,upcoming:'1',sort:'deadline',limit:'200'});if(force)params.set('refresh','1');
      const response=await fetch(`/api/conferences?${params}`,{signal:controller.signal});const result=await response.json();
      if(!response.ok)throw Error(result.error||'会议检索失败。');if(!controller.signal.aborted){setData(result);setNow(Date.now());}
    }catch(failure){if(!controller.signal.aborted){setError((failure as Error).message);setData(undefined);}}
    finally{if(!controller.signal.aborted)setLoading(false);}
  }
  useEffect(()=>{void load();const timer=setInterval(()=>setNow(Date.now()),1000);return()=>{request.current?.abort();clearInterval(timer);};},[]);
  // Defend against a stale cache/response: expired rounds never remain selectable.
  const choices=useMemo(()=>data?.conferences.flatMap(edition=>{
    if(rank!=='all'&&edition.ccf?.toUpperCase()!==rank)return [];
    return edition.rounds.filter(round=>round.selection&&round.deadlineAt&&Date.parse(round.deadlineAt)>now).map(round=>({edition,round}));
  }).sort((a,b)=>Date.parse(a.round.deadlineAt!)-Date.parse(b.round.deadlineAt!)||a.edition.title.localeCompare(b.edition.title))||[],[data,rank,now]);
  const pendingCount=data?.pendingCount||0;
  function selectRound(round:ConferenceRound){
    if(loading||!round.selection)return;
    if(Date.parse(round.deadlineAt||'')<=Date.now()){setNow(Date.now());setError('所选轮次已截止，请选择新的轮次。');return;}
    setChosenRoundId(round.id);setError('');onSelect(round.selection);
  }
  return <section className="conference-picker" aria-label="从 CCFDDL 选择会议截止时间">
    <header><div><strong>从 CCFDDL 选择会议</strong><p>仅显示未来可投稿轮次，按北京时间全文截止从近到远排列。</p></div>{onClose&&<button type="button" onClick={onClose} aria-label="关闭会议选择">关闭</button>}</header>
    <form onSubmit={event=>{event.preventDefault();void load();}}><label className="conference-rank"><span>CCF 等级</span><select aria-label="CCF 会议等级" value={rank} onChange={event=>{const next=event.target.value as Rank;setRank(next);void load(false,next);}}><option value="all">全部等级</option><option value="A">CCF A</option><option value="B">CCF B</option><option value="C">CCF C</option></select></label><input aria-label="搜索会议" value={query} maxLength={100} onChange={event=>setQuery(event.target.value)} placeholder="可选：会议名称或年份"/><button disabled={loading}>搜索</button><button type="button" disabled={loading} onClick={()=>void load(true)}>刷新来源</button></form>
    <p className="conference-provenance"><a href="https://ccfddl.top/" target="_blank" rel="noreferrer">CCFDDL</a> 聚合数据，全文截止统一显示北京时间。缺时刻取来源约定 23:59:59，缺时区取 AoE；请以会议官网为准。</p>
    {loading&&<p role="status">正在读取未来投稿轮次…</p>}{error&&<p role="alert" className="conference-warning">{error}</p>}
    {data&&<><div className="conference-cache">获取于 {new Date(data.fetchedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间） · {data.stale?'缓存需核对':'已缓存公开数据'} <a href={data.datasetUrl} target="_blank" rel="noreferrer">原始数据</a></div>{data.warning&&<p className="conference-warning" role="status">{data.warning}</p>}
      <div className="conference-result-summary"><span>北京时间全文截止：近 → 远</span><span>{choices.length} 个未来轮次</span></div>
      <div className="conference-results" aria-busy={loading}>{choices.map(({edition,round})=>{const selected=(chosenRoundId??selectedRoundId)===round.id,level=edition.ccf&&['A','B','C'].includes(edition.ccf.toUpperCase())?`CCF ${edition.ccf.toUpperCase()}`:'未分级';return <article key={round.id} className="conference-edition">
        <div className="conference-edition-heading"><h4>{edition.title} {edition.year}<small>{level}</small></h4>{edition.officialUrl&&<a href={edition.officialUrl} target="_blank" rel="noreferrer">会议官网 ↗</a>}</div>
        <div className={`conference-round ${selected?'selected':''}`}><label className="conference-round-choice"><input type="radio" name="conference-round" checked={selected} disabled={loading} onChange={()=>selectRound(round)}/><span><strong><span className="conference-paper-deadline">{beijing(round.deadlineAt)} <small>北京时间</small></span><em className={Date.parse(round.deadlineAt!)-now<=86400000?'urgent':''}>{remaining(round.deadlineAt!,now)}</em></strong><span className="conference-round-caption">全文截止 · {round.label}</span></span></label>
          <details className="conference-round-details"><summary>原始时区、摘要及轮次说明</summary><p>{edition.description}</p>{(edition.date||edition.place)&&<p>会议举办：{edition.date} {edition.place}</p>}<p>全文截止原文：{round.rawDeadline} · {round.sourceTimezone}</p>{round.rawAbstractDeadline&&<p>摘要截止：{round.abstractDeadlineAt?`${beijing(round.abstractDeadlineAt)} 北京时间`:round.rawAbstractDeadline}（摘要截止与全文截止不同）</p>}{round.comment&&<p>轮次备注原文：{round.comment}</p>}{round.notes.map((note,i)=><p key={i}>{note}</p>)}</details>
        </div></article>;})}
        {!choices.length&&!loading&&<p className="conference-empty">当前条件下没有尚未截止的可用轮次。可切换等级、清空搜索或刷新来源；不会推测尚未公布的年份。</p>}
        {pendingCount>0&&<p className="conference-pending">另有 {pendingCount} 个轮次尚未公布可用全文截止（TBD 或时间不完整），不列为可选项。</p>}
        {data.total>new Set(choices.map(item=>item.edition.id)).size&&data.conferences.length<data.total&&<p className="conference-pending">当前返回 {data.conferences.length} / {data.total} 个会议记录，可输入关键词缩小范围。</p>}
      </div></>}
  </section>;
}
