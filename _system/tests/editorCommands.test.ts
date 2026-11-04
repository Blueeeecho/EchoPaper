import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection } from '@codemirror/state';
import { texWrapChange, sourceDoubleClickLine } from '../src/editorCommands.ts';
test('TeX emphasis wraps a selected range and keeps the text selected',()=>{
 const state=EditorState.create({doc:'alpha beta',selection:{anchor:6,head:10}});
 const next=state.update(texWrapChange(state,'textbf')).state;
 assert.equal(next.doc.toString(),'alpha \\textbf{beta}');assert.equal(next.sliceDoc(next.selection.main.from,next.selection.main.to),'beta');
});
test('TeX emphasis inserts an empty argument or wraps multiple cursors independently',()=>{
 const empty=EditorState.create({doc:''});const inserted=empty.update(texWrapChange(empty,'textit')).state;assert.equal(inserted.doc.toString(),'\\textit{}');assert.equal(inserted.selection.main.head,8);
 const state=EditorState.create({doc:'ab cd',selection:EditorSelection.create([EditorSelection.range(0,2),EditorSelection.range(3,5)]),extensions:[EditorState.allowMultipleSelections.of(true)]});
 const next=state.update(texWrapChange(state,'textbf')).state;assert.equal(next.doc.toString(),'\\textbf{ab} \\textbf{cd}');assert.deepEqual(next.selection.ranges.map(r=>next.sliceDoc(r.from,r.to)),['ab','cd']);
});
test('source double-click uses the clicked line even when the old cursor is elsewhere, without editing or selecting',()=>{
 const state=EditorState.create({doc:'first\nsecond\nthird',selection:{anchor:0}});
 const view={state,composing:false,posAtCoords:({x,y}:{x:number;y:number})=>x===25&&y===42?14:null};
 const event={clientX:25,clientY:42,button:0};
 assert.equal(sourceDoubleClickLine(view,event),3);
 assert.equal(sourceDoubleClickLine(view,{...event,clientX:99}),undefined);
 assert.equal(sourceDoubleClickLine(view,{...event,button:2}),undefined);
 assert.equal(sourceDoubleClickLine({...view,composing:true},event),undefined);
 assert.equal(state.selection.main.head,0);assert.equal(state.doc.toString(),'first\nsecond\nthird');
});
