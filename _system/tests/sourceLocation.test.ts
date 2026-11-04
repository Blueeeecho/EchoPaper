import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {sourceLocationEffect,sourceLocationHighlight} from '../src/sourceLocation.ts';
test('source navigation highlights only the requested word and maps the range through edits',()=>{
 let state=EditorState.create({doc:'first second third',extensions:[sourceLocationHighlight]});
 state=state.update({effects:sourceLocationEffect.of({from:6,to:12})}).state;
 const ranges: {from:number;to:number}[]=[];state.field(sourceLocationHighlight).between(0,state.doc.length,(from,to)=>{ranges.push({from,to});});
 assert.deepEqual(ranges,[{from:6,to:12}]);assert.equal(state.sliceDoc(ranges[0].from,ranges[0].to),'second');
 state=state.update({changes:{from:0,insert:'new '}}).state;
 const cursor=state.field(sourceLocationHighlight).iter();assert.equal(state.sliceDoc(cursor.from,cursor.to),'second');
 state=state.update({effects:sourceLocationEffect.of(null)}).state;assert.equal(state.field(sourceLocationHighlight).size,0);
});
test('unmatched or empty word targets never become line or paragraph highlights',()=>{
 const state=EditorState.create({doc:'a long paragraph on one line',extensions:[sourceLocationHighlight]});
 const next=state.update({effects:sourceLocationEffect.of({from:99,to:99})}).state;
 assert.equal(next.field(sourceLocationHighlight).size,0);
});
