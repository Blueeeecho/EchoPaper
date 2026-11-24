import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import type ContinuousPdf from '../src/academic/ContinuousPdf';
import type {PdfPage} from '../src/academic/ContinuousPdf';

const compiled=await build({entryPoints:[fileURLToPath(new URL('../src/academic/ContinuousPdf.tsx',import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic'});
function deferred<T>(){
 let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
 const promise=new Promise<T>((accept,refuse)=>{resolve=accept;reject=refuse;});
 return {promise,resolve,reject};
}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function drawing(){return {...deferred<void>(),cancelled:0,cancel(){this.cancelled++;}};}

function harness(context:test.TestContext,pdf:PDFDocumentProxy,textLayers:ReturnType<typeof deferred<void>>[]=[]){
 const states:any[]=[true],refs:Array<{current:any}>=[],effects:Array<(()=>void|(()=>void))|undefined>=[],cleanups:Array<void|(()=>void)>=[];
 const dependencies:Array<readonly unknown[]|undefined>=[];
 let stateIndex=0,refIndex=0,effectIndex=0;
 const hooks={...React,
  useState(initial:any){const index=stateIndex++;if(!(index in states))states[index]=initial;return [states[index],(value:any)=>{states[index]=typeof value==='function'?value(states[index]):value;}];},
  useRef(initial:any){const index=refIndex++;return refs[index]??=( {current:initial} );},
  useEffect(effect:()=>void|(()=>void),next:readonly unknown[]){const index=effectIndex++,previous=dependencies[index];if(!previous||next.some((value,position)=>!Object.is(value,previous[position]))){dependencies[index]=next;effects[index]=effect;}},
 };
 const layers:Array<{cancelled:number}>=[];
 class MockTextLayer{
  cancelled=0;
  constructor(){layers.push(this);}
  render(){return textLayers[layers.indexOf(this)]?.promise??Promise.resolve();}
  cancel(){this.cancelled++;}
 }
 const require=createRequire(import.meta.url),module={exports:{} as {PdfPage:typeof PdfPage}};
 new Function('require','module','exports',compiled.outputFiles[0].text)((name:string)=>name==='react'?hooks:name==='pdfjs-dist'?{TextLayer:MockTextLayer}:require(name),module,module.exports);
 const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement(){return {className:''};}}});
 context.after(()=>{cleanups[2]?.();if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else delete (globalThis as any).document;});
 const canvas={width:0,height:0,getContext:()=>({})};
 const layer={children:[] as unknown[],replaceChildren(){this.children=[];},append(value:unknown){this.children.push(value);},style:{setProperty(){}}};
 return {
  states,layers,canvas,layer,
  nodes(currentCanvas:unknown=canvas,currentLayer:unknown=layer){refs[1].current=currentCanvas;refs[2].current=currentLayer;},
  render(zoom:number){stateIndex=0;refIndex=0;effectIndex=0;renderToStaticMarkup(React.createElement(module.exports.PdfPage,{pdf,number:1,zoom,container:{current:null}}));},
  start(){const effect=effects[2];assert.ok(effect);cleanups[2]?.();cleanups[2]=effect();effects[2]=undefined;},
 };
}

function page(texts:ReturnType<typeof deferred<{items:{str:string}[]}>>[],drawings:ReturnType<typeof drawing>[]){
 let rendered=0,read=0;
 return {getViewport:({scale}:{scale:number})=>({width:600*scale,height:800*scale}),render(){return drawings[rendered++];},getTextContent(){return texts[read++].promise;},count:()=>rendered};
}

test('a page resolving after its canvas unmounts cannot write through stale refs',async context=>{
 const pending=deferred<any>(),text=deferred<{items:{str:string}[]}>(),task=drawing(),source=page([text],[task]);
 const pdf={getPage:()=>pending.promise} as unknown as PDFDocumentProxy;
 const h=harness(context,pdf);h.render(1);h.nodes();h.start();h.nodes(null,null);
 pending.resolve(source);await flush();
 assert.equal(h.canvas.width,0);assert.equal(source.count(),0);assert.equal(h.states[2],'');
});

test('zoom changes wait for cancelled drawing before reusing the same canvas',async context=>{
 const firstText=deferred<{items:{str:string}[]}>(),secondText=deferred<{items:{str:string}[]}>(),first=drawing(),second=drawing();
 const source=page([firstText,secondText],[first,second]),pdf={getPage:async()=>source} as unknown as PDFDocumentProxy;
 const h=harness(context,pdf);h.render(1);h.nodes();h.start();await flush();assert.equal(source.count(),1);
 h.states[2]='old rendering error';h.render(2);h.start();await flush();
 assert.equal(first.cancelled,1);assert.equal(source.count(),1);
 first.reject(Object.assign(new Error('cancelled'),{name:'RenderingCancelledException'}));await flush();
 assert.equal(source.count(),2);assert.equal(h.canvas.width,1200);assert.equal(h.states[2],'');
 firstText.resolve({items:[{str:'old'}]});secondText.resolve({items:[{str:'current'}]});second.resolve();await flush();
 assert.equal(h.layers.length,1);assert.equal(h.layer.children.length,1);assert.equal(h.states[2],'');
});

test('obsolete text layers are cancelled and late failures never replace the new page error state',async context=>{
 const firstText=deferred<{items:{str:string}[]}>(),secondText=deferred<{items:{str:string}[]}>(),oldLayer=deferred<void>(),first=drawing(),second=drawing();
 const source=page([firstText,secondText],[first,second]),pdf={getPage:async()=>source} as unknown as PDFDocumentProxy;
 const h=harness(context,pdf,[oldLayer]);h.render(1);h.nodes();h.start();await flush();firstText.resolve({items:[{str:'old'}]});await flush();
 assert.equal(h.layers.length,1);h.render(.5);h.start();assert.equal(h.layers[0].cancelled,1);
 oldLayer.reject(Object.assign(new Error('old layer stopped'),{name:'AbortException'}));
 first.reject(Object.assign(new Error('cancelled'),{name:'RenderingCancelledException'}));await flush();
 secondText.resolve({items:[{str:'current'}]});second.resolve();await flush();
 assert.equal(h.canvas.width,300);assert.equal(h.layer.children.length,1);assert.equal(h.states[2],'');
});

test('one unavailable page cannot block position restore, and scrolling only reads the visible region',async context=>{
 let effect:(()=>()=>void)|undefined;
 const react={...React,useRef:(current:unknown)=>({current}),useEffect:(next:()=>()=>void)=>{effect=next;}};
 const require=createRequire(import.meta.url),module={exports:{} as {default:typeof ContinuousPdf}};
 new Function('require','module','exports',compiled.outputFiles[0].text)((name:string)=>name==='react'?react:name==='pdfjs-dist'?{}:require(name),module,module.exports);
 const frames=new Map<number,()=>void>();
 const previous=Object.getOwnPropertyDescriptors(globalThis);
 let frameId=0;
 Object.defineProperty(globalThis,'requestAnimationFrame',{configurable:true,value:(next:()=>void)=>{frames.set(++frameId,next);return frameId;}});
 Object.defineProperty(globalThis,'cancelAnimationFrame',{configurable:true,value:(index:number)=>frames.delete(index)});
 context.after(()=>{for(const name of ['requestAnimationFrame','cancelAnimationFrame']){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else Reflect.deleteProperty(globalThis,name);}});
 const animation=()=>{while(frames.size){const [id,next]=frames.entries().next().value!;frames.delete(id);next();}};
 let offset=0,reads=0,scroll:(()=>void)|undefined;
 const nodes=Array.from({length:256},(_,index)=>({
  dataset:{pdfPage:String(index+1)},
  getBoundingClientRect(){reads++;return{top:index*100-offset,bottom:(index+1)*100-offset};},
  scrollIntoView(){offset=index*100;},
 }));
 const container={getBoundingClientRect:()=>({top:0,bottom:120}),querySelectorAll:()=>nodes,addEventListener:(_type:string,next:()=>void)=>{scroll=next;},removeEventListener:()=>{scroll=undefined;}};
 const reported:number[]=[],requested:number[]=[];
 const pdf={numPages:nodes.length,getPage(number:number){requested.push(number);return number===2?Promise.reject(Error('unavailable')):Promise.resolve({});}} as unknown as PDFDocumentProxy;
 module.exports.default({pdf,zoom:1,container:{current:container as unknown as HTMLDivElement},onPage:page=>reported.push(page),initialPage:3});
 const stop=effect?.();assert.ok(stop);
 try{
  await flush();animation();
  assert.deepEqual(requested,[1,2,3]);assert.deepEqual(reported,[3]);
  reads=0;offset=15000;scroll?.();animation();
  assert.deepEqual(reported,[3,151]);assert.ok(reads<20);
  offset++;scroll?.();animation();assert.deepEqual(reported,[3,151]);
 }finally{stop();}
});
