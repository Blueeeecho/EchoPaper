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
 const states:any[]=[],refs:Array<{current:any}>=[],effects:Array<(()=>void|(()=>void))|undefined>=[],cleanups:Array<void|(()=>void)>=[];
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
 context.after(()=>{cleanups[1]?.();if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else delete (globalThis as any).document;});
 const canvas={width:0,height:0,getContext:()=>({})};
 const layer={children:[] as unknown[],replaceChildren(){this.children=[];},append(value:unknown){this.children.push(value);},style:{setProperty(){}}};
 return {
  states,layers,canvas,layer,
  nodes(currentCanvas:unknown=canvas,currentLayer:unknown=layer){refs[1].current=currentCanvas;refs[2].current=currentLayer;},
  render(zoom:number){stateIndex=0;refIndex=0;effectIndex=0;renderToStaticMarkup(React.createElement(module.exports.PdfPage,{pdf,number:1,zoom,visible:true,onLayout(){}}));},
  start(){const effect=effects[1];assert.ok(effect);cleanups[1]?.();cleanups[1]=effect();effects[1]=undefined;},
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
 assert.equal(h.canvas.width,0);assert.equal(source.count(),0);assert.equal(h.states[1],'');
});

test('zoom changes wait for cancelled drawing before reusing the same canvas',async context=>{
 const firstText=deferred<{items:{str:string}[]}>(),secondText=deferred<{items:{str:string}[]}>(),first=drawing(),second=drawing();
 const source=page([firstText,secondText],[first,second]),pdf={getPage:async()=>source} as unknown as PDFDocumentProxy;
 const h=harness(context,pdf);h.render(1);h.nodes();h.start();await flush();assert.equal(source.count(),1);
 h.states[1]='old rendering error';h.render(2);h.start();await flush();
 assert.equal(first.cancelled,1);assert.equal(source.count(),1);
 first.reject(Object.assign(new Error('cancelled'),{name:'RenderingCancelledException'}));await flush();
 assert.equal(source.count(),2);assert.equal(h.canvas.width,1200);assert.equal(h.states[1],'');
 firstText.resolve({items:[{str:'old'}]});secondText.resolve({items:[{str:'current'}]});second.resolve();await flush();
 assert.equal(h.layers.length,1);assert.equal(h.layer.children.length,1);assert.equal(h.states[1],'');
});

test('obsolete text layers are cancelled and late failures never replace the new page error state',async context=>{
 const firstText=deferred<{items:{str:string}[]}>(),secondText=deferred<{items:{str:string}[]}>(),oldLayer=deferred<void>(),first=drawing(),second=drawing();
 const source=page([firstText,secondText],[first,second]),pdf={getPage:async()=>source} as unknown as PDFDocumentProxy;
 const h=harness(context,pdf,[oldLayer]);h.render(1);h.nodes();h.start();await flush();firstText.resolve({items:[{str:'old'}]});await flush();
 assert.equal(h.layers.length,1);h.render(.5);h.start();assert.equal(h.layers[0].cancelled,1);
 oldLayer.reject(Object.assign(new Error('old layer stopped'),{name:'AbortException'}));
 first.reject(Object.assign(new Error('cancelled'),{name:'RenderingCancelledException'}));await flush();
 secondText.resolve({items:[{str:'current'}]});second.resolve();await flush();
 assert.equal(h.canvas.width,300);assert.equal(h.layer.children.length,1);assert.equal(h.states[1],'');
});

test('deep links avoid preceding page reads and win over overlap until user scrolling',context=>{
 const effects:Array<()=>void|(()=>void)>=[],refs:Array<{current:unknown}>=[];
 let index=0, observations=0, observerCount=0;
 const react={...React,memo:()=>()=>null,useState:(make:()=>unknown)=>[make(),()=>{}],useRef:(current:unknown)=>refs[index++]??=({current}),useLayoutEffect:(next:()=>void)=>{effects.push(next);}};
 const require=createRequire(import.meta.url),module={exports:{} as {default:typeof ContinuousPdf}};
 new Function('require','module','exports',compiled.outputFiles[0].text)((name:string)=>name==='react'?react:name==='pdfjs-dist'?{}:require(name),module,module.exports);
 const frames=new Map<number,()=>void>();
 let frameId=0;
 const stub=(name:string,value:unknown)=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,name);
  Object.defineProperty(globalThis,name,{configurable:true,value});
  context.after(()=>{if(previous)Object.defineProperty(globalThis,name,previous);else Reflect.deleteProperty(globalThis,name);});
 };
 stub('requestAnimationFrame',(next:()=>void)=>{frames.set(++frameId,next);return frameId;});
 stub('cancelAnimationFrame',(id:number)=>frames.delete(id));
 stub('IntersectionObserver',class{constructor(){observerCount++;}observe(){observations++;}disconnect(){}});
 stub('ResizeObserver',class{observe(){} disconnect(){}});
 const animation=()=>{while(frames.size){const [id,next]=frames.entries().next().value!;frames.delete(id);next();}};
 const listeners=new Map<string,(e?:any)=>void>();
 let reads=0;
 const requested:number[]=[],reported:number[]=[];
 const nodes=Array.from({length:256},(_,index)=>({
  dataset:{pdfPage:String(index+1)},
  getBoundingClientRect(){
   reads++;
   const top=index*100-container.scrollTop;
   return {top,bottom:top+(index===179||index===255?20:100)};
  },
 }));
 const container={
  getBoundingClientRect:()=>({top:0,bottom:120}),querySelectorAll:()=>nodes,scrollTop:0,scrollHeight:25520,clientHeight:120,clientTop:0,
  addEventListener:(type:string,next:()=>void)=>listeners.set(type,next),
  removeEventListener:(type:string)=>listeners.delete(type),
 };
 const pdf={numPages:nodes.length,getPage(number:number){requested.push(number);return Promise.reject(Error('unavailable'));}} as unknown as PDFDocumentProxy;
 const props:React.ComponentProps<typeof ContinuousPdf>={pdf,zoom:1,container:{current:container as unknown as HTMLDivElement},onPage:page=>reported.push(page),initialPage:180};
 function render(navigation?:{page:number}){index=0;effects.length=0;renderToStaticMarkup(React.createElement(module.exports.default,{...props,navigation}));}
 render();
 const stop=effects[0]();effects[1]();
 try{
  listeners.get('scroll')?.();animation();
  assert.deepEqual(requested,[]);assert.deepEqual(reported,[180]);assert.equal(container.scrollTop,17900);
  assert.equal(observerCount,1);assert.equal(observations,256);
  render({page:256});effects[1]();listeners.get('scroll')?.();animation();
  assert.equal(container.scrollTop,25400);assert.deepEqual(reported,[180,256]);
  listeners.get('wheel')?.({ctrlKey:false});reads=0;container.scrollTop=15000;listeners.get('scroll')?.();animation();
  assert.deepEqual(reported,[180,256,151]);assert.ok(reads<20);
  listeners.get('scroll')?.();animation();assert.deepEqual(reported,[180,256,151]);
 }finally{stop?.();}
 assert.equal(listeners.size,0);
});
