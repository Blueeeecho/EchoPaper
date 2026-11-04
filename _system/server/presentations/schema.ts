import { z } from 'zod';
import type { PresentationDocument, PresentationSlide } from '../../shared/presentation-types';
import { HttpError } from '../security';
import { hash } from '../storage';

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const text=z.string().max(100_000);
export const sectionSchema=z.enum(['封面','目录','研究背景','研究内容','研究结果','未来计划','致谢']);
export const layoutSchema=z.enum(['cover','contents','explanation','comparison','table','figure','pipeline','case','thanks']);
export const notesSchema=z.object({purpose:text,speech:text,transition:text,questions:text}).strict();
export const blockSchema=z.object({id,type:z.enum(['text','table','image','steps','case','chart']),text:text.optional(),textEn:text.optional(),title:text.optional(),titleEn:text.optional(),rows:z.array(z.array(text).max(30)).max(300).optional(),headers:z.array(text).max(30).optional(),steps:z.array(z.object({title:text,text:text.optional()}).strict()).max(50).optional(),assetId:id.optional(),caption:text.optional(),sourceIds:z.array(id).max(200).optional(),verbatim:z.boolean().optional(),labels:z.array(text).max(300).optional(),series:z.array(z.object({name:text,values:z.array(z.number().finite()).max(300)}).strict()).max(20).optional()}).strict();
export const slideSchema=z.object({id,section:sectionSchema,layout:layoutSchema,title:text,titleEn:text,keyMessage:text,blocks:z.array(blockSchema).max(60),notes:notesSchema,sourceIds:z.array(id).max(200)}).strict();
const sourceSchema=z.object({id,name:z.string().min(1).max(500),kind:z.enum(['text','paper','resource','image','pdf']),text:z.string().max(2_000_000),hash:z.string().regex(/^[a-f0-9]{64}$/),resourceId:id.optional(),paperId:id.optional(),path:z.string().max(1000).optional(),assetId:id.optional(),page:z.number().int().positive().optional()}).strict();
export const documentSchema=z.object({schemaVersion:z.literal(1),id,title:z.string().min(1).max(1000),language:z.enum(['zh','en','zh-en']),notesLanguage:z.enum(['zh','en','zh-en']),preserveExamples:z.boolean(),styleId:id,styleVersion:z.string().regex(/^\d+\.\d+\.\d+$/),topicId:id.optional(),paperId:id.optional(),presenter:z.string().max(200),advisor:z.string().max(200),durationMinutes:z.number().min(0).max(1440),targetSlides:z.number().int().min(1).max(100),sources:z.array(sourceSchema).max(200),slides:z.array(slideSchema).max(100),createdAt:z.string().datetime(),updatedAt:z.string().datetime(),approvedOutlineHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export function parseDocument(value:unknown):PresentationDocument {
 const parsed=documentSchema.safeParse(value);if(!parsed.success)throw new HttpError(400,'PPT 文档字段无效：'+parsed.error.issues.slice(0,3).map(i=>`${i.path.join('.')} ${i.message}`).join('；'));
 const document=parsed.data as PresentationDocument,sourceIds=new Set(document.sources.map(s=>s.id)),slideIds=new Set<string>();
 if(sourceIds.size!==document.sources.length)throw new HttpError(400,'材料编号重复。');
 for(const s of document.sources)if(!s.assetId&&s.hash!==hash(s.text))throw new HttpError(400,'材料正文与冻结哈希不一致。');
 for(const slide of document.slides){if(slideIds.has(slide.id))throw new HttpError(400,'幻灯片编号重复。');slideIds.add(slide.id);const blockIds=new Set<string>();for(const b of slide.blocks){if(blockIds.has(b.id))throw new HttpError(400,'本页内容块编号重复。');blockIds.add(b.id);if(b.type==='table'&&(!(b.headers?.length||b.rows?.[0]?.length)||b.headers?.length===0||b.rows?.some(r=>!r.length||r.length!==(b.headers?.length??b.rows?.[0]?.length))))throw new HttpError(400,'表格各行列数须一致。');if(b.type==='chart'&&(!b.labels?.length||!b.series?.length||b.series.some(s=>s.values.length!==b.labels!.length)))throw new HttpError(400,'图表标签与数值长度须一致。');if(b.assetId&&!document.sources.some(s=>s.assetId===b.assetId))throw new HttpError(400,'图片必须来自已选择并冻结的材料。');}
  if([...slide.sourceIds,...slide.blocks.flatMap(b=>b.sourceIds??[])].some(s=>!sourceIds.has(s)))throw new HttpError(400,'幻灯片引用了未选择的材料。');
 }
 return document;
}
export const outlineHash=(document:PresentationDocument)=>hash(JSON.stringify(document.slides));
export function expectedHash(value:unknown):string {if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new HttpError(400,'请携带读取时的 expectedHash。');return value;}
export function parseModelSlides(value:unknown,document:PresentationDocument):PresentationSlide[]{
 // The wire schema deliberately uses source_ids so evidence links cannot be silently omitted.
 const raw=z.object({slides:z.array(z.object({...slideSchema.shape,sourceIds:z.never().optional(),source_ids:z.array(id).max(200),blocks:z.array(z.object({...blockSchema.shape,sourceIds:z.never().optional(),source_ids:z.array(id).max(200)}).strict()).max(60)}).strict()).min(1).max(100)}).strict().safeParse(value);
 if(!raw.success)throw Error('模型大纲未通过结构校验：'+raw.error.issues.slice(0,3).map(i=>i.path.join('.')+' '+i.message).join('；'));
 const slides=raw.data.slides.map(({source_ids,sourceIds:_,blocks,...s})=>({...s,sourceIds:source_ids,blocks:blocks.map(({source_ids,sourceIds:_,...b})=>({...b,sourceIds:source_ids}))})) as PresentationSlide[];
 parseDocument({...document,slides});
 for(const s of slides){if(!['封面','目录','致谢'].includes(s.section)&&document.sources.length&&!s.sourceIds.length)throw Error('模型没有为正文页标注已选择的材料 source_ids。');for(const b of s.blocks)if((b.type==='chart'||b.type==='table'||b.type==='case')&&!b.sourceIds?.length)throw Error('模型生成的图表或案例缺少 source_ids，需作者补充材料。');}
 if(document.preserveExamples){for(const b of slides.flatMap(s=>s.blocks).filter(b=>b.type==='case'||b.verbatim)){if(b.text&&!document.sources.some(s=>s.text.includes(b.text!)))throw Error('要求保留原文的案例未与任何冻结材料逐字匹配。');}}
 return slides;
}
