import test from 'node:test';
import assert from 'node:assert/strict';
import {questionEvidence} from '../server/workspace/literature-question.ts';
import type {ArticleAnalysis} from '../shared/literature-analysis.ts';
test('question evidence preserves dataset coverage and page anchors without sending entire PDFs',()=>{
 const article={facts:[{id:'d',field:'dataset',entity:'HumanEval',value:'代码评测',quote:'We use HumanEval',page:2,verified:true},{id:'m',field:'model',value:'Irrelevant model',quote:'Model X',page:1,verified:false}]} as ArticleAnalysis;
 const pages=[{page:1,text:'unrelated '.repeat(20000)},{page:2,text:'We use HumanEval as a code benchmark. '+'Other details. '.repeat(300)}];
 const evidence=questionEvidence('数据集有哪些，是什么类型？',article,pages,3000);
 assert.match(evidence,/HumanEval/);assert.match(evidence,/PDF p.2/);assert.doesNotMatch(evidence,/Irrelevant model/);assert.doesNotMatch(evidence,/unrelated/);assert.ok(evidence.length<3300);assert.match(evidence,/不代表穷尽全文/);
});
test('unanalysed sources and absent matches are explicitly bounded',()=>{const evidence=questionEvidence('quantum',undefined,[{page:1,text:'unrelated source'}]);assert.match(evidence,/无相关已保存事实/);assert.match(evidence,/未检索到匹配片段/);});
