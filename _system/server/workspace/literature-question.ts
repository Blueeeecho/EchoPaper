import type {AnalysisPage,ArticleAnalysis} from '../../shared/literature-analysis.ts';

// Retrieval is local. Only bounded evidence goes to the model, never all PDF pages.
export function questionEvidence(question:string,article:ArticleAnalysis|undefined,pages:AnalysisPage[],budget=6000){
 const datasets=/数据集|基准|dataset|benchmark/i.test(question),models=/模型|model/i.test(question);
 const facts=(article?.facts||[]).filter(f=>datasets||models?(datasets&&f.field==='dataset')||(models&&f.field==='model'):true);
 let remaining=Math.floor(budget*.7),omitted=false;
 const records:string[]=[];
 for(const fact of facts){const record=`[PDF p.${fact.page} · ${fact.verified?'引用已匹配':'引用待核对'}] ${fact.entity||''} ${fact.value}\n原文：${fact.quote}`;if(record.length>remaining){omitted=true;continue;}records.push(record);remaining-=record.length;}
 const terms=[...new Set([...(question.toLowerCase().match(/[a-z0-9_-]{2,}/g)||[]),...(question.match(/[\u4e00-\u9fff]{2}/g)||[]),...(datasets?['dataset','benchmark','evaluation']:[]),...(models?['model','backbone']:[])])];
 const chunks=pages.flatMap(p=>{const result:{page:number;text:string;score:number}[]=[];for(let i=0;i<p.text.length;i+=800){const text=p.text.slice(i,i+1000),lower=text.toLowerCase(),score=terms.reduce((n,t)=>n+(lower.includes(t)?1:0),0);if(score)result.push({page:p.page,text,score});}return result;}).sort((a,b)=>b.score-a.score||a.page-b.page);
 let excerptBudget=budget-records.join('\n').length;const excerpts:string[]=[];
 for(const chunk of chunks){if(excerpts.length>=3)break;const excerpt=`[PDF p.${chunk.page}] ${chunk.text}`;if(excerpt.length>excerptBudget){omitted=true;continue;}excerpts.push(excerpt);excerptBudget-=excerpt.length;}
 return `已有分析：\n${records.join('\n')||'无相关已保存事实。'}\n本地全文检索片段：\n${excerpts.join('\n')||'未检索到匹配片段。'}\n范围说明：${omitted||chunks.length>excerpts.length?'材料经过限量选择，不代表穷尽全文。':'仅基于上述事实和片段，不代表穷尽全文。'}`;
}
