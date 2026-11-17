import test from 'node:test';import assert from 'node:assert/strict';import {beginPaneResize} from '../src/paneResize.ts';
const pointer=(type:string,x=0,id=7)=>{const event=new Event(type);Object.defineProperties(event,{clientX:{value:x},pointerId:{value:id}});return event;};
for(const end of ['pointerup','pointercancel','blur','lostpointercapture','dispose'])test(`pane drag ends on ${end} without leaving global selection locks`,()=>{
 const events=new EventTarget(),handle=Object.assign(new EventTarget(),{captured:false,setPointerCapture(){this.captured=true;},hasPointerCapture(){return this.captured;},releasePointerCapture(){this.captured=false;}}),values:number[]=[];
 const dispose=beginPaneResize(events,handle,7,100,1000,v=>values.push(v));assert.equal(handle.captured,true);
 events.dispatchEvent(pointer('pointermove',600));events.dispatchEvent(pointer('pointermove',100,8));assert.deepEqual(values,[50]);events.dispatchEvent(pointer('pointermove',50));assert.equal(values.at(-1),28);events.dispatchEvent(pointer('pointermove',1200));assert.equal(values.at(-1),72);
 if(end==='dispose')dispose();else if(end==='lostpointercapture')handle.dispatchEvent(pointer(end));else events.dispatchEvent(end==='blur'?new Event(end):pointer(end));
 const count=values.length;events.dispatchEvent(pointer('pointermove',700));assert.equal(values.length,count);assert.equal(handle.captured,false);dispose();
});

test('vertical reading dividers use height limits and finish once after cancellation',()=>{
 const events=new EventTarget(),handle=Object.assign(new EventTarget(),{captured:false,setPointerCapture(){this.captured=true;},hasPointerCapture(){return this.captured;},releasePointerCapture(){this.captured=false;}});
 const values:number[]=[];let committed=0;
 const dispose=beginPaneResize(events,handle,7,50,600,value=>values.push(value),{axis:'y',minimum:20,maximum:85,onFinish(){committed++;}});
 const move=(y:number,id=7)=>{const event=pointer('pointermove',999,id);Object.defineProperty(event,'clientY',{value:y});events.dispatchEvent(event);};
 move(350);move(500,8);move(20);move(800);assert.deepEqual(values,[50,20,85]);
 events.dispatchEvent(pointer('pointercancel'));dispose();handle.dispatchEvent(pointer('lostpointercapture'));
 assert.equal(committed,1);assert.equal(handle.captured,false);
});
