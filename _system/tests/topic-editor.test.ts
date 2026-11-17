import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ResearchTopic} from '../shared/workspace-types';
import {topicEditorPayload} from '../src/academic/topic-editor';
import TopicEditComparison from '../src/academic/TopicEditComparison';

const original:ResearchTopic={id:'fixture',title:'Original question',description:'Original context',stage:'ideation',paperIds:['p-old'],presentationIds:[],resourceIds:['source-do-not-rewrite'],archived:false,experimentPlan:'Frozen protocol',resultSummary:'Observed result',revision:4,createdAt:'',updatedAt:''};

test('topic editor whitelists editable fields and uses its original revision',()=>{
 const payload=topicEditorPayload({...original,title:' Updated question '},original);
 assert.equal(payload.title,'Updated question');assert.equal(payload.expectedRevision,4);
 for(const field of ['id','revision','resourceIds','archived','experimentPlan','resultSummary','progressEntries','updatedAt'])assert.ok(!(field in payload),field);
 assert.ok(!('expectedRevision' in topicEditorPayload(original)));
});
test('prepared associations are independent of later changes to editor selections',()=>{
 const draft={...original,paperIds:['paper-a'],presentationIds:['deck-a']},payload=topicEditorPayload(draft,original);
 draft.paperIds.push('paper-b');draft.presentationIds.length=0;
 assert.deepEqual(payload.paperIds,['paper-a']);assert.deepEqual(payload.presentationIds,['deck-a']);assert.equal(original.revision,4);
});
test('conflict comparison displays changed fields, object titles and missing object identifiers',()=>{
 const latest={...original,revision:5,title:'Concurrent question',paperIds:['missing-paper'],description:'Server <script>context</script>'};
 const html=renderToStaticMarkup(createElement(TopicEditComparison,{baseline:original,latest,draft:{...original,title:'Local question'},paperNames:{'p-old':'Original paper'},deckNames:{},onDownload:()=>{},onLoad:()=>{}}));
 for(const text of ['Concurrent question','Local question','Original question','Original paper','missing-paper','Server &lt;script&gt;context&lt;/script&gt;'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('Frozen protocol'));assert.equal((html.match(/type="button"/g)||[]).length,2);
});
test('unrelated server updates are distinguished from editable field differences',()=>{
 const latest={...original,revision:5,archived:true,experimentPlan:'Updated outside this form'};
 const html=renderToStaticMarkup(createElement(TopicEditComparison,{baseline:original,latest,draft:original,paperNames:{},deckNames:{},onDownload:()=>{},onLoad:()=>{}}));
 assert.ok(html.includes('这些可编辑字段没有变化'));assert.ok(html.includes('已归档'));assert.ok(!html.includes('Updated outside this form'));
});
