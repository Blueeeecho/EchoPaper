import {useEffect,useState} from 'react';
import {ApiError} from '../api';
import ResearchRelationOverview from './ResearchRelationOverview';
import {parseResearchMap,researchSourceHref,researchBasisStale,researchProjectId,researchMapSelection,RESEARCH_MAP_PATH,type ResearchMap as MapData} from '../../shared/research-map';
export async function readResearchFile(projectId:string,path:string,signal?:AbortSignal):Promise<{content:string;hash:string}>{
 if(!researchProjectId.test(projectId))throw Error('论文编号无效');
 const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`,{signal});
 if(!response.ok)throw new ApiError(response.status===404?'尚未录入研究对照；文字研究依据仍可使用。':'读取研究对照失败',response.status,{});
 const reader=response.body?.getReader();if(!reader)throw Error('读取失败');let size=0;const chunks:Uint8Array[]=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024){await reader.cancel();throw Error('研究对照或依据过大，请缩小数据；文字依据仍可用。');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const doc=JSON.parse(new TextDecoder().decode(bytes));if(typeof doc.content!=='string'||typeof doc.hash!=='string')throw Error('文件响应无效');return doc;
}
export function ResearchMapView({data,currentHash,projectId,initialTab='脉络关系'}:{data:MapData;currentHash?:string;projectId:string;initialTab?:'脉络关系'|'方案对照'|'证据'}){
 const [tab,setTab]=useState(initialTab),[query,setQuery]=useState(''),[selected,setSelected]=useState('');
 if(data.projectId!==projectId)return <p role="alert">研究对照不属于当前论文。</p>;
 const {papers}=researchMapSelection(data,query,'');
 const detail=papers.find(p=>p.id===selected)||papers[0];
 const activeId=detail?.id||'';
 const {edges,total}=researchMapSelection(data,query,activeId);
 const names=Object.fromEntries([[data.ours.id,data.ours.short],...data.papers.map(p=>[p.id,p.short])]);
 const source=(value:string,label='查看原文')=>{const href=researchSourceHref(value,projectId);return href?<a href={href} title={value} target="_blank" rel="noopener noreferrer">{label} ↗<span className="research-map-link-note">（新页）</span></a>:<span>{value||'来源未录入'}（未提供可用链接）</span>;};
 return <section className="research-map" aria-label="研究对照">
  <header className="research-map-heading"><div><h3>{data.title}</h3><p>研究者标注的关系 · {data.asOf} · {data.papers.length}项前置研究</p></div><span className="research-map-project">{projectId}</span></header>
  {researchBasisStale(data,currentHash)&&<p className="research-map-warning" role="alert">依据版本不一致或无法读取，需重核对照结论；未自动刷新判断。</p>}
  <nav aria-label="研究对照视图">{(['脉络关系','方案对照','证据'] as const).map(t=><button type="button" key={t} aria-pressed={tab===t} onClick={()=>setTab(t)}>{t}{t==='证据'&&<span>{data.evidence.length}</span>}</button>)}</nav>
  {tab!=='证据'&&<div className="research-map-tools"><label>检索前置研究<input placeholder="论文、方法或待证差异" value={query} onChange={e=>{setQuery(e.target.value);setSelected('');}}/></label>{query&&<button type="button" onClick={()=>{setQuery('');setSelected('');}}>清除搜索</button>}<span role="status">{papers.length} / {data.papers.length}项</span></div>}
  {tab==='脉络关系'?<>
   <ResearchRelationOverview data={data} paperIds={new Set(papers.map(p=>p.id))} selected={activeId} onSelect={setSelected}/>
   {detail&&<article className="research-map-detail" aria-label={`${detail.short}的研究对照`}><header><div><span className="research-relation-caption">当前查看 · {detail.relation||'前置研究'}</span><h4>{detail.short} <span>{detail.title}</span></h4></div>{source(detail.url)}</header><dl><div><dt>已有成果</dt><dd>{detail.accomplishment}</dd></div><div><dt>条件与边界</dt><dd>{detail.boundary}</dd></div><div><dt>本研究承接与待证差异</dt><dd>{detail.proposedDifference}</dd></div></dl><footer><span>{detail.comparisonStatus}</span><span>{detail.anchor}</span></footer>{detail.input&&<details><summary>输入与适用条件</summary><p>{detail.input}</p></details>}</article>}
   <details className="research-map-records"><summary>关系依据与核对记录（{total}）</summary><p>连线是研究者判断，并非真实引用或因果边。</p>{edges.map((e,i)=><article key={i}><h4>{names[e.source]} · {e.kind} · {names[e.target]}</h4><p>{e.assertion}</p><p>{e.assessment}</p><small>状态：{e.status||'未单独核验'} · 核对日期：{e.checkedAt||'未记录'}（数据日期 {data.asOf}）</small><p>{source(e.evidence,'打开依据')} · {e.anchor}</p></article>)}</details>
  </>:tab==='方案对照'?<div className="research-map-table" tabIndex={0} aria-label="完整方案对照，可横向滚动"><table><thead><tr>{['前置研究','已有成果','条件 / 边界','本研究承接与待证差异','证据状态 / 原文'].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>{papers.map(p=><tr key={p.id}><th><button type="button" onClick={()=>{setSelected(p.id);setTab('脉络关系');}}>{p.short}</button><small>{p.title}</small></th><td>{p.accomplishment}</td><td>{p.boundary}</td><td>{p.proposedDifference}</td><td>{p.comparisonStatus}<p>{source(p.url)} · {p.anchor}</p></td></tr>)}</tbody></table>{!papers.length&&<p className="research-map-empty">没有匹配的前置研究。</p>}</div>:<div className="research-map-evidence">{data.evidence.map(e=><article key={e.id}><header><h4>{e.title}</h4><span>{e.status}</span></header><p>{e.detail}</p><p className="research-map-evidence-scope">适用范围：{e.scope}</p>{source(e.source,'打开原始证据')}</article>)}{!data.evidence.length&&<p>尚未录入证据；不能据此认定已验证。</p>}</div>}
  <details className="research-map-about"><summary>范围、来源与本研究方案</summary><p>{data.scope}</p><p>不计算创新分，不以资料齐全认定创新或验证完成。</p><p>方案：{data.ours.approach}</p><p>待证差异：{data.ours.proposedDifference}</p><p>可证伪对照：{data.ours.falsifier}</p><small>绑定依据：notes/research-basis.md · {data.sourceNoteSha256}</small></details>
 </section>;
}
export default function ResearchMap({projectId}:{projectId:string}){
 const [state,setState]=useState<{id:string;data?:MapData;hash?:string;error?:string}>({id:projectId});
 useEffect(()=>{const controller=new AbortController();setState({id:projectId});void(async()=>{try{const doc=await readResearchFile(projectId,RESEARCH_MAP_PATH,controller.signal),data=parseResearchMap(doc.content,projectId);let hash:string|undefined;try{hash=(await readResearchFile(projectId,'notes/research-basis.md',controller.signal)).hash;}catch{/* warning stays visible */}if(!controller.signal.aborted)setState({id:projectId,data,hash});}catch(e){if(!controller.signal.aborted)setState({id:projectId,error:e instanceof Error?e.message:'读取失败'});}})();return()=>controller.abort();},[projectId]);
 return state.id!==projectId||!state.data&&!state.error?<p role="status">正在读取当前论文研究对照…</p>:state.error?<p role="alert">{state.error} 查看不会创建文件，请继续使用文字研究依据。</p>:<ResearchMapView key={projectId} data={state.data!} currentHash={state.hash} projectId={projectId}/>;
}
