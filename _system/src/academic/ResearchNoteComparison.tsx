import {RESEARCH_STAGES,type ResearchStage,type ResearchTopic} from '../../shared/workspace-types';

export default function ResearchNoteComparison({baseline,latest,field,draft,stage,onDownload,onLoad}:{baseline:ResearchTopic;latest:ResearchTopic;field:'experimentPlan'|'resultSummary';draft:string;stage:ResearchStage|'未标注';onDownload:()=>void;onLoad:()=>void}){
 const stageName=(value?:ResearchStage|'未标注')=>value&&value!=='未标注'?RESEARCH_STAGES[value]:'尚未标注阶段';
 return <section aria-label="比较本地与服务器记录">
  <p>本地输入仍保留。读取和比较不会保存，也不会自动重试。先下载本地草稿，再载入服务器版本并手动合并。</p>
  <div className="academic-form-columns">
   <label>本地编辑（基于版本 {baseline.revision}）<p>阶段：{stageName(stage)}</p><textarea aria-label="本地编辑内容" readOnly rows={8} style={{width:'100%'}} value={draft}/></label>
   <label>服务器当前记录（版本 {latest.revision}）<p>阶段：{stageName(latest.stage)}{latest.archived?' · 已归档':''}</p><textarea aria-label="服务器当前内容" readOnly rows={8} style={{width:'100%'}} value={latest[field]||''}/></label>
  </div>
  <details><summary>查看开始编辑时的原文（版本 {baseline.revision}）</summary><p>阶段：{stageName(baseline.stage)}</p><textarea aria-label="开始编辑时的原文" readOnly rows={6} style={{width:'100%'}} value={baseline[field]||''}/></details>
  <div><button type="button" className="academic-secondary" onClick={onDownload}>下载本地草稿</button><button type="button" className="academic-secondary" disabled={latest.archived} onClick={onLoad}>载入服务器版本重新编辑</button></div>
  {latest.archived&&<p>此课题已归档。本地草稿可下载保留，请返回课题页核对状态。</p>}
 </section>;
}
