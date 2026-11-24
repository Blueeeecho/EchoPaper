import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {ArrowUpRight,RefreshCw,Sparkles,X} from 'lucide-react';
import {
 KNOWLEDGE_ENTITIES,
 KNOWLEDGE_RELATIONS,
 type KnowledgeGraphData,
 type KnowledgeRelationSource,
} from '../../shared/literature-graph';
import {api,json} from '../api';
import {ENTITY_COLORS} from './graphEngine';
import LiteratureGraph, {type EvidenceSelection} from './LiteratureGraph';
import './literature-analysis.css';

interface AiExtractResponse {
 graph:KnowledgeGraphData;
 stats:{
  extractedPapers:number;
  skippedPapers:number;
  failedPapers:number;
  verifiedRelations:number;
  rejectedRelations:number;
  model:string;
 };
}

const SOURCE_LABELS:Record<KnowledgeRelationSource,string>={
 local:'原文抽取',
 analysis:'文献分析',
 ai:'AI 核验',
};

export default function TopicKnowledgeGraph({topicId,revision}:{topicId:string;revision:number}){
 const [data,setData]=useState<KnowledgeGraphData>();
 const [error,setError]=useState('');
 const [loading,setLoading]=useState(true);
 const [extracting,setExtracting]=useState(false);
 const [extractNotice,setExtractNotice]=useState('');
 const [extractError,setExtractError]=useState('');
 const [refresh,setRefresh]=useState(0);
 const [selection,setSelection]=useState<EvidenceSelection|null>(null);
 const [visibleEvidence,setVisibleEvidence]=useState(14);

 const evidencePanel=useRef<HTMLElement>(null);
 const evidenceTrigger=useRef<HTMLElement|null>(null);

 const clearEvidence=useCallback(()=>setSelection(null),[]);

 useEffect(()=>{
  const controller=new AbortController();
  setLoading(true);
  setError('');
  setSelection(null);
  void api<KnowledgeGraphData>('/api/workspace/topics/'+encodeURIComponent(topicId)+'/knowledge-graph',{signal:controller.signal})
   .then(result=>{if(!controller.signal.aborted)setData(result);})
   .catch((failure:Error)=>{if(!controller.signal.aborted)setError(failure.message);})
   .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[topicId,revision,refresh]);

 useEffect(()=>{
  if(!selection)return;
  const panel=evidencePanel.current;
  if(!panel)return;
  panel.scrollTop=0;
 },[selection]);

 const papers=data?.papers??[];
 const stats=useMemo(()=>{
  const mapped=papers.filter(paper=>paper.relations.length>0).length;
  const available=papers.filter(paper=>paper.textSource).length;
  const damaged=papers.filter(paper=>paper.textError).length;
  const analysisFused=papers.filter(paper=>paper.analysisFused).length;
  const aiExtracted=papers.filter(paper=>paper.aiExtracted).length;
  const totalRelations=papers.reduce((sum,p)=>sum+p.relations.length,0);
  return {mapped,available,damaged,analysisFused,aiExtracted,totalRelations};
 },[papers]);

 const showEvidence=useCallback((next:EvidenceSelection,trigger?:HTMLElement|null)=>{
  evidenceTrigger.current=trigger??null;
  setSelection(next);
  setVisibleEvidence(14);
 },[]);

 function closeEvidence(){
  clearEvidence();
  evidenceTrigger.current?.focus();
 }

 async function runAiExtract(force=false){
  setExtracting(true);
  setExtractError('');
  setExtractNotice('');
  try{
   const result=await api<AiExtractResponse>(
    '/api/workspace/topics/'+encodeURIComponent(topicId)+'/knowledge-graph/extract',
    json('POST',{force}),
   );
   setData(result.graph);
   const s=result.stats;
   if(s.extractedPapers===0){
    setExtractNotice(`所有可用文献均已完成 AI 深度建图（跳过 ${s.skippedPapers} 篇）；如需重跑可稍后再次触发。`);
   }else{
    setExtractNotice(
     `AI 深度建图完成（${s.model}）：深度解析 ${s.extractedPapers} 篇，原文核验入图 ${s.verifiedRelations} 条关系`
      +(s.rejectedRelations>0?`，过滤未命中原文 ${s.rejectedRelations} 条`:'')
      +(s.failedPapers>0?`，${s.failedPapers} 篇解析失败`:''),
    );
   }
  }catch(failure:any){
   setExtractError(failure?.message||'AI 深度建图失败，请检查模型配置后重试。');
  }finally{
   setExtracting(false);
  }
 }

 return <section className="lit-analysis lit-knowledge">
  <header className="lit-heading">
   <div>
    <h3>知识关系图</h3>
    <p>融合本地原文抽取、已核验文献分析与 AI 深度建图，每条方法/问题/模型/基准/指标关系均可溯源至 PDF 页码。</p>
   </div>
   <div className="lit-knowledge-actions">
    <button
     type="button"
     className="academic-primary lit-kg-ai-btn"
     disabled={loading||extracting||stats.available===0}
     title={data?.aiConfigured===false?'尚未配置助手模型，点击查看说明':'调用助手模型从摘要、方法与实验章节深度抽取并核验原文关系'}
     onClick={()=>void runAiExtract(stats.aiExtracted>0&&stats.aiExtracted>=stats.available)}
    >
     <Sparkles size={14}/>
     {extracting?'正在 AI 深度建图…':stats.aiExtracted>0&&stats.aiExtracted>=stats.available?'重新 AI 深度建图':'AI 深度建图'}
    </button>
    <button
     type="button"
     className="academic-secondary"
     disabled={loading||extracting}
     onClick={()=>setRefresh(value=>value+1)}
    >
     <RefreshCw size={14}/>更新图谱
    </button>
   </div>
  </header>

  {loading&&<p className="lit-status" role="status"><span className="lit-pulse" aria-hidden="true"/>正在构建知识图谱…</p>}
  {extracting&&<p className="lit-status" role="status"><span className="lit-pulse" aria-hidden="true"/>正在调用助手模型深度抽取并逐条核验原文引句，请稍候…</p>}
  {error&&<p className="lit-status error" role="alert">更新图谱失败。{error}</p>}
  {extractError&&<p className="lit-status error" role="alert">{extractError}</p>}
  {extractNotice&&<p className="lit-status" role="status">{extractNotice}<button type="button" onClick={()=>setExtractNotice('')}>知道了</button></p>}

  {data&&<>
   <div className="lit-selection-summary lit-kg-summary">
    <strong>已入图 {stats.mapped} / {papers.length} 篇</strong>
    <span>
     全文可用 {stats.available} 篇 · 共 {stats.totalRelations} 条可溯源关系
     {stats.analysisFused>0?` · 已融合文献分析 ${stats.analysisFused} 篇`:''}
     {stats.aiExtracted>0?` · AI 深度建图 ${stats.aiExtracted} 篇`:''}
     {stats.damaged>0?` · 缓存读取失败 ${stats.damaged} 篇`:''}
    </span>
   </div>

   {stats.mapped>0?<div className="lit-knowledge-layout">
    <LiteratureGraph papers={papers} onEvidence={showEvidence} onClearEvidence={clearEvidence}/>
    {selection&&<aside
     ref={evidencePanel}
     className="lit-evidence"
     aria-label="图谱原文证据"
     tabIndex={-1}
     onKeyDown={event=>{
      if(event.key==='Escape'){event.stopPropagation();closeEvidence();}
     }}
    >
     <header>
      <div className="lit-evidence-heading">
       {selection.kind&&<span className="lit-evidence-kind">
        <i style={{background:ENTITY_COLORS[selection.kind]}}/>
        {KNOWLEDGE_ENTITIES[selection.kind]}
       </span>}
       <h4>{selection.title}</h4>
       <small>{selection.subtitle}</small>
      </div>
      <button type="button" aria-label="关闭图谱证据" onClick={closeEvidence}><X size={17}/></button>
     </header>
     {selection.refs.slice(0,visibleEvidence).map(({paper,relation},index)=>{
      const src:KnowledgeRelationSource=relation.source||'local';
      return <article key={`${paper.resourceId}:${relation.predicate}:${relation.page}:${index}`}>
       <div className="lit-evidence-meta">
        <small>{paper.title} · PDF 第 {relation.page} 页</small>
        <span className={`lit-source-badge is-${src}`}>{SOURCE_LABELS[src]}</span>
       </div>
       <h5>{relation.subject?.label||'本文'} · <em>{KNOWLEDGE_RELATIONS[relation.predicate]}</em> · {relation.object.label}</h5>
       <blockquote>{relation.quote}</blockquote>
       {relation.translation&&<details>
        <summary>查看中文说明 / 段落译文</summary>
        <p>{relation.translation}</p>
       </details>}
       <a
        href={'/api/workspace/resources/'+encodeURIComponent(paper.resourceId)+'/raw?sourceHash='+encodeURIComponent(paper.sourceHash)+'#page='+relation.page}
        target="_blank"
        rel="noreferrer"
       >
        打开原文 · PDF 第 {relation.page} 页<ArrowUpRight size={13}/>
       </a>
      </article>;
     })}
     {selection.refs.length>visibleEvidence&&<button
      type="button"
      className="academic-secondary lit-evidence-more"
      onClick={()=>setVisibleEvidence(value=>value+14)}
     >
      再显示 {Math.min(14,selection.refs.length-visibleEvidence)} 条依据（剩余 {selection.refs.length-visibleEvidence} 条）
     </button>}
    </aside>}
   </div>:<div className="lit-no-data">
    {!papers.length
     ?'课题暂无关联 PDF。'
     :stats.available
      ?'现有全文中暂未识别到显式关系，可点击右上角「AI 深度建图」从摘要、方法与实验章节深度构建。'
      :'请在文献阅读器中完成 OCR 或双语处理，再更新图谱。'}
   </div>}

   {papers.length>0&&<details className="lit-knowledge-coverage">
    <summary>查看文献覆盖情况（{stats.mapped} / {papers.length} 篇已入图）</summary>
    <ul>
     {papers.map(paper=><li key={paper.resourceId}>
      <span>{paper.title}</span>
      <small>
       {paper.textError
        ?'缓存读取失败'
        :!paper.textSource&&!paper.analysisFused
         ?'全文待就绪'
         :[
          paper.textSource==='ocr'?'OCR 全文':paper.textSource==='pdf'?'PDF 文本缓存':null,
          paper.analysisFused?'文献分析融合':null,
          paper.aiExtracted?`AI 深度建图${paper.aiModel?` (${paper.aiModel})`:''}`:null,
          paper.relations.length?`${paper.relations.length} 条关系`:'未识别到关系',
         ].filter(Boolean).join(' · ')}
      </small>
     </li>)}
    </ul>
   </details>}
  </>}
 </section>;
}
