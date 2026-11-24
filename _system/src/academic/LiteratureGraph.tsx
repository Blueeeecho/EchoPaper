import {useEffect,useMemo,useRef,useState} from 'react';
import {Columns3,Crosshair,Maximize,Minus,Network,Plus,Search,Tag,X} from 'lucide-react';
import {
 KNOWLEDGE_ENTITIES,
 KNOWLEDGE_RELATIONS,
 knowledgeEdges,
 knowledgeName,
 type KnowledgeEdge,
 type KnowledgeEntityKind,
 type KnowledgePaper,
 type KnowledgePredicate,
 type KnowledgeReference,
} from '../../shared/literature-graph';
import {
 ENTITY_COLORS,
 GraphEngine,
 type GraphEngineNode,
 type LayoutMode,
} from './graphEngine';

export interface EvidenceSelection {
 title:string;
 subtitle:string;
 kind?:KnowledgeEntityKind;
 refs:KnowledgeReference[];
}

const ALL_KINDS=Object.keys(KNOWLEDGE_ENTITIES) as KnowledgeEntityKind[];
const ALL_PREDICATES=Object.keys(KNOWLEDGE_RELATIONS) as KnowledgePredicate[];
const SOFT_EDGE_CAP=400;

export default function LiteratureGraph({
 papers,
 onEvidence,
 onClearEvidence,
}:{
 papers:KnowledgePaper[];
 onEvidence:(selection:EvidenceSelection,trigger?:HTMLElement|null)=>void;
 onClearEvidence:()=>void;
}){
 const [layoutMode,setLayoutMode]=useState<LayoutMode>('layered');
 const [predicate,setPredicate]=useState<KnowledgePredicate|'all'>('all');
 const [hiddenKinds,setHiddenKinds]=useState<Set<KnowledgeEntityKind>>(()=>new Set());
 const [scope,setScope]=useState<'all'|'focus'>('all');
 const [focus,setFocus]=useState('');
 const [query,setQuery]=useState('');
 const [showLabels,setShowLabels]=useState(true);
 const [showAllEdges,setShowAllEdges]=useState(false);
 const [zoomPct,setZoomPct]=useState(100);
 const [selectedSummary,setSelectedSummary]=useState<{id:string;type:'node'|'edge';label:string;refs:KnowledgeReference[]} | null>(null);

 const canvasRef=useRef<HTMLCanvasElement>(null);
 const engineRef=useRef<GraphEngine|null>(null);
 const relationListRef=useRef<HTMLDetailsElement>(null);

 const allEdges=useMemo(()=>knowledgeEdges(papers),[papers]);
 const focalPapers=useMemo(()=>papers.filter(paper=>paper.relations.length>0),[papers]);
 const focalId=(focalPapers.find(paper=>paper.resourceId===focus)
  ??focalPapers.find(paper=>paper.relations.some(relation=>relation.subject))
  ??focalPapers[0])?.resourceId;

 // Edges scoped by paper focus (used to compute predicate & kind counts cleanly)
 const scopedEdges=useMemo(()=>{
  if(scope==='all')return allEdges;
  return allEdges.flatMap(edge=>{
   const refs=edge.refs.filter(ref=>ref.paper.resourceId===focalId);
   return refs.length?[{...edge,refs}]:[];
  });
 },[allEdges,scope,focalId]);

 const predicateCounts=useMemo(()=>{
  const counts:Partial<Record<KnowledgePredicate,number>>={};
  for(const edge of scopedEdges){
   counts[edge.predicate]=(counts[edge.predicate]||0)+1;
  }
  return counts;
 },[scopedEdges]);

 // Filtered edges by predicate, hidden entity kinds, and search query
 const matchingEdges=useMemo(()=>{
  const term=knowledgeName(query);
  return scopedEdges.flatMap(edge=>{
   if(predicate!=='all'&&edge.predicate!==predicate)return [];
   if(hiddenKinds.has(edge.source.kind)||hiddenKinds.has(edge.target.kind))return [];
   if(!term)return [edge];
   const labelsMatch=knowledgeName([edge.source.label,edge.target.label,KNOWLEDGE_RELATIONS[edge.predicate]].join(' ')).includes(term);
   if(labelsMatch)return [edge];
   const refs=edge.refs.filter(({paper,relation})=>
    knowledgeName([paper.title,relation.quote,relation.translation||''].join(' ')).includes(term),
   );
   return refs.length?[{...edge,refs}]:[];
  });
 },[scopedEdges,predicate,hiddenKinds,query]);

 const displayedEdges=useMemo(()=>{
  if(showAllEdges||matchingEdges.length<=SOFT_EDGE_CAP)return matchingEdges;
  return matchingEdges.slice(0,SOFT_EDGE_CAP);
 },[matchingEdges,showAllEdges]);

 const network=useMemo(()=>{
  const nodeMap=new Map<string,GraphEngineNode>();
  const degreeMap=new Map<string,number>();
  for(const edge of displayedEdges){
   degreeMap.set(edge.source.id,(degreeMap.get(edge.source.id)||0)+1);
   degreeMap.set(edge.target.id,(degreeMap.get(edge.target.id)||0)+1);
   for(const endpoint of [edge.source,edge.target]){
    const existing=nodeMap.get(endpoint.id)??{...endpoint,refs:[],degree:0};
    for(const ref of edge.refs){
     if(!existing.refs.includes(ref))existing.refs.push(ref);
    }
    nodeMap.set(endpoint.id,existing);
   }
  }
  const nodes=[...nodeMap.values()].map(node=>({...node,degree:degreeMap.get(node.id)||1}));
  const edgeMap=new Map(displayedEdges.map(edge=>[edge.id,edge]));
  return {nodes,edges:displayedEdges,nodeMap,edgeMap};
 },[displayedEdges]);

 // Entity kind counts across current scoped edges (so toggled-off kinds still show their counts!)
 const kindCounts=useMemo(()=>{
  const seen=new Map<KnowledgeEntityKind,Set<string>>();
  for(const kind of ALL_KINDS)seen.set(kind,new Set());
  for(const edge of scopedEdges){
   if(predicate!=='all'&&edge.predicate!==predicate)continue;
   seen.get(edge.source.kind)?.add(edge.source.id);
   seen.get(edge.target.kind)?.add(edge.target.id);
  }
  const result:Record<KnowledgeEntityKind,number>={paper:0,method:0,problem:0,model:0,dataset:0,metric:0};
  for(const kind of ALL_KINDS)result[kind]=seen.get(kind)?.size||0;
  return result;
 },[scopedEdges,predicate]);

 // Quick fly-to search matches among visible nodes
 const flyMatches=useMemo(()=>{
  const term=knowledgeName(query);
  if(!term)return [];
  return network.nodes
   .filter(node=>knowledgeName(node.label).includes(term))
   .sort((a,b)=>b.degree-a.degree||a.label.localeCompare(b.label))
   .slice(0,6);
 },[network.nodes,query]);

 // Refs to latest handlers for GraphEngine callbacks (prevents engine teardown on state updates)
 const networkRef=useRef(network);
 networkRef.current=network;
 const onEvidenceRef=useRef(onEvidence);
 onEvidenceRef.current=onEvidence;
 const onClearRef=useRef(onClearEvidence);
 onClearRef.current=onClearEvidence;

 const relationText=(edge:KnowledgeEdge)=>
  `${edge.source.label} · ${KNOWLEDGE_RELATIONS[edge.predicate]} · ${edge.target.label}`;

 function emitNodeSelection(nodeId:string|null){
  if(!nodeId){
   setSelectedSummary(null);
   onClearRef.current();
   return;
  }
  const node=networkRef.current.nodeMap.get(nodeId);
  if(!node)return;
  const paperCount=new Set(node.refs.map(r=>r.paper.resourceId)).size;
  setSelectedSummary({id:node.id,type:'node',label:node.label,refs:node.refs});
  onEvidenceRef.current({
   title:node.label,
   subtitle:`${KNOWLEDGE_ENTITIES[node.kind]} · 关联 ${paperCount} 篇文献 · ${node.refs.length} 条依据`,
   kind:node.kind,
   refs:node.refs,
  },canvasRef.current);
 }

 function emitEdgeSelection(edgeId:string|null){
  if(!edgeId){
   setSelectedSummary(null);
   onClearRef.current();
   return;
  }
  const edge=networkRef.current.edgeMap.get(edgeId);
  if(!edge)return;
  const paperCount=new Set(edge.refs.map(r=>r.paper.resourceId)).size;
  const label=relationText(edge);
  setSelectedSummary({id:edge.id,type:'edge',label,refs:edge.refs});
  onEvidenceRef.current({
   title:label,
   subtitle:`${KNOWLEDGE_RELATIONS[edge.predicate]} · ${paperCount} 篇文献 · ${edge.refs.length} 条原文依据`,
   kind:edge.target.kind,
   refs:edge.refs,
  },canvasRef.current);
 }

 // Initialize GraphEngine once
 useEffect(()=>{
  const canvas=canvasRef.current;
  if(!canvas)return;
  const engine=new GraphEngine(canvas,{
   onSelectNode:emitNodeSelection,
   onSelectEdge:emitEdgeSelection,
   onZoomChange:setZoomPct,
  });
  engineRef.current=engine;
  return()=>{
   engine.destroy();
   engineRef.current=null;
  };
 },[]);

 // Push graph updates into GraphEngine
 useEffect(()=>{
  const engine=engineRef.current;
  if(!engine)return;
  engine.setGraph(network.nodes,network.edges,false);
  setSelectedSummary(null);
  onClearRef.current();
 },[network]);

 useEffect(()=>{
  engineRef.current?.setLayoutMode(layoutMode);
 },[layoutMode]);

 useEffect(()=>{
  engineRef.current?.setShowLabels(showLabels);
 },[showLabels]);

 function toggleEntityKind(kind:KnowledgeEntityKind){
  setHiddenKinds(prev=>{
   const next=new Set(prev);
   if(next.has(kind))next.delete(kind);
   else next.add(kind);
   // Never leave every kind hidden
   if(next.size>=ALL_KINDS.length)return new Set();
   return next;
  });
 }

 function flyToNode(node:GraphEngineNode){
  engineRef.current?.focusNode(node.id);
  emitNodeSelection(node.id);
 }

 function selectEdgeFromList(edge:KnowledgeEdge,trigger:HTMLElement){
  engineRef.current?.setSelection(null,edge.id);
  const paperCount=new Set(edge.refs.map(r=>r.paper.resourceId)).size;
  const label=relationText(edge);
  setSelectedSummary({id:edge.id,type:'edge',label,refs:edge.refs});
  onEvidence({
   title:label,
   subtitle:`${KNOWLEDGE_RELATIONS[edge.predicate]} · ${paperCount} 篇文献 · ${edge.refs.length} 条原文依据`,
   kind:edge.target.kind,
   refs:edge.refs,
  },trigger);
 }

 return <div className="lit-network">
  <div className="lit-network-toolbar">
   <div className="lit-segments" role="group" aria-label="布局模式">
    <button type="button" aria-pressed={layoutMode==='layered'} onClick={()=>setLayoutMode('layered')}>
     <Columns3 size={13}/>分层结构图
    </button>
    <button type="button" aria-pressed={layoutMode==='force'} onClick={()=>setLayoutMode('force')}>
     <Network size={13}/>聚类力导图
    </button>
   </div>
   <div className="lit-segments" role="group" aria-label="视图范围">
    <button type="button" aria-pressed={scope==='all'} onClick={()=>setScope('all')}>课题全景</button>
    <button type="button" aria-pressed={scope==='focus'} onClick={()=>setScope('focus')}>单篇聚焦</button>
   </div>
   {scope==='focus'&&focalPapers.length>0&&<label className="lit-network-focus-select">
    <span>焦点论文</span>
    <select aria-label="焦点论文" value={focalId||''} onChange={event=>setFocus(event.target.value)}>
     {focalPapers.map(paper=><option key={paper.resourceId} value={paper.resourceId}>{paper.title}</option>)}
    </select>
   </label>}
   <div className="lit-network-search-wrap">
    <label className="lit-network-search">
     <Search size={13}/>
     <input
      aria-label="搜索节点、关系或原文"
      placeholder="搜索节点或原文，回车定位…"
      value={query}
      onChange={event=>setQuery(event.target.value)}
      onKeyDown={event=>{
       if(event.key==='Enter'&&flyMatches.length){
        event.preventDefault();
        flyToNode(flyMatches[0]);
       }
      }}
     />
     {query&&<button type="button" className="lit-network-search-clear" aria-label="清空搜索" onClick={()=>setQuery('')}><X size={12}/></button>}
    </label>
    {query.trim()&&flyMatches.length>0&&<div className="lit-network-fly-bar" role="listbox" aria-label="快速定位节点">
     {flyMatches.map(node=><button key={node.id} type="button" onClick={()=>flyToNode(node)}>
      <i style={{background:ENTITY_COLORS[node.kind]}}/>
      <span>{node.label}</span>
      <Crosshair size={11}/>
     </button>)}
    </div>}
   </div>
  </div>

  <div className="lit-network-predicates" role="group" aria-label="关系类型筛选">
   <button type="button" className="lit-predicate-chip" aria-pressed={predicate==='all'} onClick={()=>setPredicate('all')}>
    全部关系 <span>{scopedEdges.length}</span>
   </button>
   {ALL_PREDICATES.map(pred=>{
    const count=predicateCounts[pred]||0;
    return <button
     key={pred}
     type="button"
     className={`lit-predicate-chip${count===0?' is-empty':''}`}
     aria-pressed={predicate===pred}
     disabled={count===0&&predicate!==pred}
     onClick={()=>setPredicate(predicate===pred?'all':pred)}
    >
     {KNOWLEDGE_RELATIONS[pred]} <span>{count}</span>
    </button>;
   })}
  </div>

  <div className="lit-network-meta" role="status">
   <span>{network.nodes.length} 个实体 · {network.edges.length} 条关系{matchingEdges.length>displayedEdges.length?`（共 ${matchingEdges.length} 条）`:''}</span>
   {matchingEdges.length>displayedEdges.length&&<button type="button" className="lit-network-link-btn" onClick={()=>setShowAllEdges(true)}>显示全部 {matchingEdges.length} 条</button>}
   <button
    type="button"
    className="lit-network-link-btn"
    onClick={()=>{
     const details=relationListRef.current;
     if(details){
      details.open=true;
      details.scrollIntoView({block:'nearest'});
      details.querySelector('summary')?.focus();
     }
    }}
   >文字关系列表</button>
  </div>

  <div className="lit-network-stage">
   <canvas
    ref={canvasRef}
    tabIndex={0}
    aria-label="文献知识关系网络画布"
    role="application"
   />
   {!network.edges.length&&<div className="lit-network-empty">
    <div>{scope==='focus'?'当前聚焦论文没有匹配的关系。':'当前筛选条件下没有匹配的关系。'}</div>
    <div className="lit-network-empty-actions">
     {scope==='focus'&&<button type="button" className="academic-secondary" onClick={()=>setScope('all')}>查看课题全景</button>}
     {(predicate!=='all'||hiddenKinds.size>0||query)&&<button type="button" className="academic-secondary" onClick={()=>{setPredicate('all');setHiddenKinds(new Set());setQuery('');}}>重置筛选</button>}
    </div>
   </div>}
   {network.edges.length>0&&<>
    <div className="lit-network-controls" role="toolbar" aria-label="画布视图控制">
     <button type="button" aria-label="放大知识网络" title="放大 (+)" onClick={()=>engineRef.current?.zoomBy(1.25)}><Plus size={15}/></button>
     <span>{zoomPct}%</span>
     <button type="button" aria-label="缩小知识网络" title="缩小 (-)" onClick={()=>engineRef.current?.zoomBy(0.8)}><Minus size={15}/></button>
     <button type="button" aria-label="适应当前图谱" title="适应视图 (0)" onClick={()=>engineRef.current?.fitToView(true)}><Maximize size={15}/></button>
     <button
      type="button"
      aria-label={showLabels?'隐藏常驻标签':'显示常驻标签'}
      aria-pressed={showLabels}
      title={showLabels?'隐藏常驻标签':'显示常驻标签'}
      onClick={()=>setShowLabels(v=>!v)}
     ><Tag size={15}/></button>
    </div>
    <div className="lit-network-hint">滚轮缩放 · 拖拽平移或固定节点 · 双击适应视图</div>
   </>}
  </div>

  {selectedSummary&&<div className="lit-network-selected-bar">
   <span>已选中：{selectedSummary.label}</span>
   <button type="button" onClick={()=>{engineRef.current?.setSelection(null,null);setSelectedSummary(null);onClearEvidence();}}>取消选中</button>
  </div>}

  <footer className="lit-network-footer" aria-label="实体类型图例筛选">
   <div className="lit-network-legend-chips">
    {ALL_KINDS.map(kind=>{
     const active=!hiddenKinds.has(kind);
     const count=kindCounts[kind];
     return <button
      key={kind}
      type="button"
      className={`lit-legend-chip${active?' is-active':' is-muted'}`}
      aria-pressed={active}
      onClick={()=>toggleEntityKind(kind)}
      title={active?`隐藏「${KNOWLEDGE_ENTITIES[kind]}」`:`显示「${KNOWLEDGE_ENTITIES[kind]}」`}
     >
      <i style={{background:ENTITY_COLORS[kind]}}/>
      <span>{KNOWLEDGE_ENTITIES[kind]}</span>
      <small>{count}</small>
     </button>;
    })}
   </div>
   {hiddenKinds.size>0&&<button type="button" className="lit-network-link-btn" onClick={()=>setHiddenKinds(new Set())}>显示全部类型</button>}
  </footer>

  <details ref={relationListRef} className="lit-network-relations">
   <summary>文字关系列表（共 {network.edges.length} 条）</summary>
   <ul>
    {network.edges.map(edge=><li key={edge.id}>
     <button type="button" onClick={event=>selectEdgeFromList(edge,event.currentTarget)}>
      <span className="lit-rel-text">{relationText(edge)}</span>
      <small>{edge.refs.length} 条依据</small>
     </button>
    </li>)}
   </ul>
  </details>
 </div>;
}
