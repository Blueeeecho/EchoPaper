/** Recognize bounded asset operations; this is a hint, never a write permission. */
export type WritingObjective = {kind:'replace_figure'; number:number} | {kind:'rename_assets'};
export function writingObjective(input:string):WritingObjective|undefined {
 const positive=input.replace(/(?:不要|不用|无需|别|不必|不需要)[^，。；;!?\n]*/gu,'');
 const figures=[...positive.matchAll(/(?:图|\bfigure|\bfig\.?)\s*(\d+)\b/giu)];
 const numbers=[...new Set(figures.map(match=>Number(match[1])))];
 if(numbers.length===1 && numbers[0]>0 && /替换|换成|换为|换掉|\breplace\b/iu.test(positive))return{kind:'replace_figure',number:numbers[0]};
 if(numbers.length===1 && numbers[0]>0 && /(?:用|使用|采用).{0,20}(?:刚才|上传|附件)|(?:刚才|上传|附件).{0,20}(?:图片|图像)|\buse\b.{0,30}\b(?:image|upload)/iu.test(positive))return{kind:'replace_figure',number:numbers[0]};
 if(/重命名|命名修改|修改.{0,8}命名|\brename\b/iu.test(positive)&&/图|表|素材|资源|\b(?:figure|table|asset|image)/iu.test(positive))return{kind:'rename_assets'};
}
