import test from 'node:test';
import assert from 'node:assert/strict';
import {literatureSelection} from '../src/academic/literatureSelection';
import type {Resource} from '../shared/workspace-types';
import type {ArticleAnalysis} from '../shared/literature-analysis';
const file=(id:string,extra:Partial<Resource>={})=>({id,name:id+'.pdf',kind:'file',missing:false,hash:'v1',...extra}) as Resource;
const article=(resourceId:string,sourceHash='v1')=>({resourceId,sourceHash}) as ArticleAnalysis;

test('model requests exclude unavailable files and stale IDs from a different research scope',()=>{
 const result=literatureSelection([file('current'),file('missing',{missing:true}),file('text',{name:'notes.md'})],[],['other-topic','current','current','missing','text']);
 assert.deepEqual(result,{selectedIds:['current'],pendingIds:['current']});
});
test('incremental reading distinguishes unchanged, changed, unknown-version and unread PDFs',()=>{
 const files=[file('same'),file('changed',{hash:'v2'}),file('unknown',{hash:undefined}),file('unread')];
 assert.deepEqual(literatureSelection(files,[article('same'),article('changed'),article('unknown')],files.map(f=>f.id)),{selectedIds:['same','changed','unknown','unread'],pendingIds:['changed','unknown','unread']});
 assert.deepEqual(literatureSelection(files,[],[]),{selectedIds:[],pendingIds:[]});
});
