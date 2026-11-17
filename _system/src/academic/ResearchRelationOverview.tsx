import type {ResearchMap} from '../../shared/research-map';

const kinds=['问题承接','评估继承','机制重合','待证差异','反例','邻接支撑'] as const;

/** Group only explicitly recorded relations incident on the current study. */
export default function ResearchRelationOverview({data,paperIds,selected,onSelect}:{
 data:ResearchMap;paperIds:Set<string>;selected:string;onSelect:(id:string)=>void;
}) {
 const all=data.edges.filter(e=>(e.source===data.ours.id||e.target===data.ours.id)&&paperIds.has(e.source===data.ours.id?e.target:e.source));
 const visible=all.slice(0,24);
 const groups=kinds.map(kind=>({kind,edges:visible.filter(e=>e.kind===kind)})).filter(g=>g.edges.length);
 if(!groups.length)return <p className="research-map-empty">没有匹配的关系。试试其他关键词，或清除搜索。</p>;
 return <div className="research-relation-overview" aria-label="前置研究与本研究的关系概览">
  <div className="research-relation-groups">
   {groups.map(g=><div className="research-relation-group" key={g.kind}>
    <span className="research-relation-kind">{g.kind}</span>
    <div className="research-relation-papers">{[...new Set(g.edges.map(e=>e.source===data.ours.id?e.target:e.source))].map(id=>{
     const paper=data.papers.find(p=>p.id===id)!;
     return <button type="button" key={id} aria-pressed={selected===id} aria-label={`${paper.short} · ${g.kind}，查看研究对照`} title={paper.title} onClick={()=>onSelect(id)}>{paper.short}</button>;
    })}</div>
    <span className="research-relation-connector" aria-hidden="true">—</span>
   </div>)}
  </div>
  <div className="research-relation-join" aria-hidden="true"><span>→</span></div>
  <div className="research-relation-ours">
   <span className="research-relation-caption">本研究</span>
   <strong>{data.ours.short}</strong>
   <p>{data.ours.question}</p>
   <small>{data.ours.status}</small>
  </div>
  {all.length>visible.length&&<p className="research-relation-limit">概览显示前24条，共{all.length}条。可搜索缩小范围，或在方案对照中查看全部文献。</p>}
 </div>;
}
