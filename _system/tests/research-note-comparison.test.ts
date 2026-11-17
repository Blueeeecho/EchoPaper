import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ResearchTopic} from '../shared/workspace-types';
import ResearchNoteComparison from '../src/academic/ResearchNoteComparison';

const baseline:ResearchTopic={id:'fixture',title:'Fixture',description:'',paperIds:[],presentationIds:[],resourceIds:[],archived:false,revision:3,createdAt:'',updatedAt:'',stage:'experiments',experimentPlan:'Original protocol',resultSummary:'Original results',progressEntries:[{id:'log',createdAt:'',content:'Unrelated log',nextStep:''}]};
const latest:ResearchTopic={...baseline,revision:4,stage:'results',experimentPlan:'Concurrent protocol',resultSummary:'Concurrent results'};
const render=(field:'experimentPlan'|'resultSummary',topic=latest)=>renderToStaticMarkup(createElement(ResearchNoteComparison,{baseline,latest:topic,field,draft:'Local <script>draft</script>',stage:'writing',onDownload:()=>{},onLoad:()=>{}}));

test('protocol conflict displays original, local and current protocol rather than progress logs',()=>{
 const html=render('experimentPlan');
 for(const text of ['Original protocol','Concurrent protocol','Local &lt;script&gt;draft&lt;/script&gt;','方案与实验','结果与证据','论文写作'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('Unrelated log'));assert.ok(!html.includes('Concurrent results'));assert.ok(!html.includes('<script>'));
});
test('result conflict displays both result versions and leaves reload as an explicit non-submit action',()=>{
 const html=render('resultSummary');
 assert.ok(html.includes('Original results'));assert.ok(html.includes('Concurrent results'));assert.ok(!html.includes('Concurrent protocol'));
 assert.equal((html.match(/type="button"/g)||[]).length,2);assert.ok(!html.includes('type="submit"'));assert.equal((html.match(/readOnly=""/g)||[]).length,3);
});
test('archived remote topic remains readable while server reload is disabled',()=>{
 const html=render('resultSummary',{...latest,archived:true});
 assert.ok(html.includes('Concurrent results'));assert.ok(html.includes('disabled=""'));assert.ok(html.includes('下载本地草稿'));
});
