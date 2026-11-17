import test from 'node:test';
import assert from 'node:assert/strict';
import {wheelZoomSteps,zoomShortcutStep} from '../src/academic/readingZoom';

test('reader zoom shortcuts accept Control and Command modifiers with reset',()=>{
 const event={key:'=',ctrlKey:true,metaKey:false,altKey:false};
 assert.equal(zoomShortcutStep(event),1);
 assert.equal(zoomShortcutStep({...event,key:'+'}),1);
 assert.equal(zoomShortcutStep({...event,key:'-'}),-1);
 assert.equal(zoomShortcutStep({...event,key:'_'}),-1);
 assert.equal(zoomShortcutStep({...event,key:'0'}),0);
 assert.equal(zoomShortcutStep({...event,key:'-',ctrlKey:false,metaKey:true}),-1);
});

test('reader shortcuts leave unmodified typing and unrelated commands available',()=>{
 const event={key:'+',ctrlKey:false,metaKey:false,altKey:false};
 assert.equal(zoomShortcutStep(event),undefined);
 assert.equal(zoomShortcutStep({...event,ctrlKey:true,altKey:true}),undefined);
 assert.equal(zoomShortcutStep({...event,ctrlKey:true,key:'s'}),undefined);
});

test('wheel zoom accumulates small deltas and clears an interrupted gesture',()=>{
 const state={delta:0,at:0};
 assert.equal(wheelZoomSteps({deltaY:-20,deltaMode:0,timeStamp:10},state),0);
 assert.equal(wheelZoomSteps({deltaY:-20,deltaMode:0,timeStamp:20},state),0);
 assert.equal(wheelZoomSteps({deltaY:-20,deltaMode:0,timeStamp:30},state),1);
 assert.equal(state.delta,0);
 assert.equal(wheelZoomSteps({deltaY:20,deltaMode:0,timeStamp:40},state),0);
 assert.equal(wheelZoomSteps({deltaY:40,deltaMode:0,timeStamp:500},state),0);
 assert.equal(state.delta,40);
});

test('wheel zoom handles pixel line and page units with bounded steps',()=>{
 for(const [deltaY,deltaMode,expected] of [[60,0,-1],[-4,1,1],[1,2,-3],[-10000,0,3]]){
  assert.equal(wheelZoomSteps({deltaY,deltaMode,timeStamp:0},{delta:0,at:0}),expected);
 }
});
