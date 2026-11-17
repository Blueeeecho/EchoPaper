import type { PresentationDocument } from './presentation-types';
/** A reading view of the same current slides used by the editor and exporter. */
export function readablePresentationOutline(doc: PresentationDocument): string {
 const slides=doc.slides;
 if(!slides.length)return '尚无逐页内容，请先生成或编辑大纲。';
 const names=(ids:string[])=>ids.map(id=>{const source=doc.sources.find(s=>s.id===id);return source?`${source.name}${source.path?`（${source.path}）`:''}`:id;}).join('；')||'未关联来源，需核对';
 const lines=[`# ${doc.title}`, '', '## 整体故事', '', `本次汇报：${slides[0].notes.speech||slides[0].keyMessage}`, '', `整体逻辑：${slides.filter(s=>s.layout!=='cover'&&s.layout!=='contents'&&s.layout!=='thanks').map(s=>s.keyMessage||s.title).join(' → ')}`, '', `章节衔接：${slides.find(s=>s.layout==='contents')?.notes.speech||slides.map(s=>s.section).filter((v,i,a)=>i===0||a[i-1]!==v).join(' → ')}`, '', '## 逐页具体内容', ''];
 for(const [i,s]of slides.entries()){
  lines.push(`### 第 ${i+1} 页｜${s.title}`, '', `本页核心：${s.keyMessage}`, '', '页面正文：', '');
  if(s.layout==='cover')lines.push(s.title,doc.presenter?`汇报人：${doc.presenter}`:'',doc.advisor?`导师：${doc.advisor}`:'','');
  if(s.layout==='contents')lines.push('研究背景 → 研究内容 → 研究结果 → 未来计划','');
  for(const b of s.blocks){
   if(b.title)lines.push(b.title,'');
   if(b.text)lines.push(b.text,'');
   if(b.textEn)lines.push(b.textEn,'');
   if(b.steps)lines.push(...b.steps.map(x=>`${x.title}：${x.text||''}`),'');
   if(b.rows){if(b.headers)lines.push(b.headers.join(' / '));lines.push(...b.rows.map(r=>r.join(' / ')),'');}
   if(b.labels&&b.series)lines.push(...b.series.map(series=>`${series.name}：${series.values.map((v,j)=>`${b.labels![j]}=${v}`).join('，')}`),'');
   if(b.assetId)lines.push(`图像：${b.assetId}`,'');
   if(b.caption)lines.push(`图表说明：${b.caption}`,'');
   if(b.sourceIds?.length)lines.push(`内容块来源：${names(b.sourceIds)}`,'');
  }
  lines.push(`本页来源：${names(s.sourceIds)}`, '', `口述要点：${s.notes.speech}`, '', `衔接：${s.notes.transition}`, '', `可能追问：${s.notes.questions}`, '');
 }
 return lines.join('\n');
}
