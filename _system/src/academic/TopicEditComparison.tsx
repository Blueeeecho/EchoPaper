import {RESEARCH_STAGES,type ResearchTopic} from '../../shared/workspace-types';
import type {TopicEditorDraft} from './topic-editor';

export default function TopicEditComparison({baseline,latest,draft,paperNames,deckNames,onDownload,onLoad}:{baseline:ResearchTopic;latest:ResearchTopic;draft:TopicEditorDraft;paperNames:Record<string,string>;deckNames:Record<string,string>;onDownload:()=>void;onLoad:()=>void}){
 const values=(t:TopicEditorDraft)=>({title:t.title,description:t.description,researchBasis:t.researchBasis||'',stage:t.stage?RESEARCH_STAGES[t.stage]:'尚未标注阶段',paperIds:[...t.paperIds].sort().map(id=>`${paperNames[id]||id} [${id}]`).join('\n'),presentationIds:[...t.presentationIds].sort().map(id=>`${deckNames[id]||id} [${id}]`).join('\n')});
 const original=values(baseline),local=values(draft),server=values(latest),labels={title:'课题名称',description:'研究问题与说明',researchBasis:'研究依据',stage:'当前研究阶段',paperIds:'关联论文',presentationIds:'关联汇报'};
 const fields=(Object.keys(labels) as (keyof typeof labels)[]).filter(key=>local[key]!==original[key]||server[key]!==original[key]);
 return <section aria-label="比较课题信息与关联">
  <p>本地编辑基于版本 {baseline.revision}，服务器当前为版本 {latest.revision}（{latest.archived?'已归档':'进行中'}）。本地输入仍保留；不会自动覆盖或重试。</p>
  {fields.length?fields.map(key=><details key={key} open><summary>{labels[key]}</summary><div className="academic-form-columns"><label>本地编辑<textarea aria-label={`${labels[key]} · 本地`} readOnly rows={3} style={{width:'100%'}} value={local[key]}/></label><label>服务器当前<textarea aria-label={`${labels[key]} · 服务器`} readOnly rows={3} style={{width:'100%'}} value={server[key]}/></label></div><details><summary>开始编辑时的原值</summary><textarea aria-label={`${labels[key]} · 原值`} readOnly rows={3} style={{width:'100%'}} value={original[key]}/></details></details>):<p>这些可编辑字段没有变化，服务器更新涉及其他记录。</p>}
  <p>先下载本地草稿，再载入服务器版本，手动合并需要保留的修改。资料关联、归档和实验记录不会由此表单改写。</p>
  <button type="button" className="academic-secondary" onClick={onDownload}>下载本地草稿</button><button type="button" className="academic-secondary" onClick={onLoad}>载入服务器版本重新编辑</button>
 </section>;
}
