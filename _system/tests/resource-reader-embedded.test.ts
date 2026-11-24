import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type ResourceReader from '../src/academic/ResourceReader';
import type {readingExcerptMarkdown} from '../src/academic/ResourceReader';
import type {Resource} from '../shared/workspace-types';
import {MODEL_CONFIG_EVENT} from '../src/modelSettings';

const compiled=await build({
 entryPoints:[fileURLToPath(new URL('../src/academic/ResourceReader.tsx',import.meta.url))],
 bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',
 plugins:[{name:'reader-ui-dependencies',setup(builder){
  builder.onResolve({filter:/^(?:pdfjs-dist(?:\/.*)?|.*\.css)$|(?:ContinuousPdf|BilingualReading|ResearchTextEditor|AiMarkdown|ReadingSplit)$/},args=>({path:args.path,namespace:'reader-stub'}));
  builder.onLoad({filter:/.*/,namespace:'reader-stub'},args=>({contents:args.path.endsWith('ReadingSplit')?'export default function Split({children}){return children;}':'export const GlobalWorkerOptions={}; export function getDocument(url){return globalThis.openReaderTestPdf(url);} export default function Stub(){return null;}',loader:'js'}));
 }}],
});
const require=createRequire(import.meta.url);
function load(react:typeof React=React,capture?:(tag:unknown,props:any)=>void){
 const module={exports:{} as {default:typeof ResourceReader;readingExcerptMarkdown:typeof readingExcerptMarkdown}};
 const jsx=require('react/jsx-runtime');
 const observe=(create:typeof jsx.jsx)=>(tag:unknown,props:any,key?:string)=>{capture?.(tag,props);return create(tag,props,key);};
 new Function('require','module','exports',compiled.outputFiles[0].text)((name:string)=>name==='react'?react:name==='react/jsx-runtime'?{...jsx,jsx:observe(jsx.jsx),jsxs:observe(jsx.jsxs)}:require(name),module,module.exports);
 return module.exports;
}
const reader=load();
const resource:Resource={id:'paper-a',title:'Evidence [and] Reasoning',name:'paper.pdf',path:'paper.pdf',rootId:'root',kind:'file',size:100,modifiedAt:'today',tags:[],missing:false,revision:1,hash:'current'};

test('an embedded reader fits its parent and defaults to the source view',()=>{
 const html=renderToStaticMarkup(React.createElement(reader.default,{resource,onClose(){},embedded:true,onAppendToNote(){}}));
 assert.match(html,/reader-shell embedded/);assert.match(html,/role="region"/);
 assert.doesNotMatch(html,/aria-modal="true"/);
 assert.match(html,/<aside[^>]+aria-label="摘录与笔记"[^>]+hidden=""/);
 assert.match(html,/文献列表/);assert.match(html,/原版/);assert.match(html,/对照/);
 const standalone=renderToStaticMarkup(React.createElement(reader.default,{resource,onClose(){}}));
 assert.match(standalone,/role="dialog"/);assert.match(standalone,/aria-modal="true"/);
 assert.match(standalone,/aria-label="摘录与笔记"/);
});

test('appended quotations carry a paper title, physical page and source link',()=>{
 const markdown=reader.readingExcerptMarkdown(resource,{quote:'First line\nSecond line',translation:'译文',comment:'我的判断',page:3,sourceHash:'current'});
 assert.match(markdown,/> First line\n> Second line/);assert.match(markdown,/译文\n\n我的判断/);
 assert.ok(markdown.includes('[Evidence \\[and\\] Reasoning](/api/workspace/resources/paper-a/raw#page=3) · p.3'));
 const stale=reader.readingExcerptMarkdown(resource,{quote:'Old source',page:3,sourceHash:'old'});
 assert.doesNotMatch(stale,/#page=3/);assert.match(stale,/原件版本已变化，页码待核对/);
 const unlocated=reader.readingExcerptMarkdown(resource,{quote:'Text note',page:null});assert.doesNotMatch(unlocated,/#page=|p\.null/);
});

test('embedded keyboard handling ignores the right-hand note editor',context=>{
 const effects:Array<()=>void|(()=>void)>=[],refs:Array<React.MutableRefObject<any>>=[];
 const hooks={...React,useEffect(effect:()=>void|(()=>void)){effects.push(effect);},useRef(value:any){const ref=React.useRef(value);refs.push(ref);return ref;}} as typeof React;
 const isolated=load(hooks);let closed=0,prevented=0,handler:((event:any)=>void)|undefined;
 renderToStaticMarkup(React.createElement(isolated.default,{resource,onClose(){closed++;},embedded:true}));
 const NodeType=class NodeStub{};const inside=new NodeType(),outside=new NodeType();
 const originalNode=Object.getOwnPropertyDescriptor(globalThis,'Node');
 Object.defineProperty(globalThis,'Node',{configurable:true,value:NodeType});
 context.after(()=>{if(originalNode)Object.defineProperty(globalThis,'Node',originalNode);else delete (globalThis as any).Node;});
 const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:{addEventListener(type:string,next:any){if(type==='keydown')handler=next;},removeEventListener(){}}});
 context.after(()=>{if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else delete (globalThis as any).document;});
 refs.find(ref=>ref.current===null)!.current={contains:(node:unknown)=>node===inside};
 const keyboard=effects.find(effect=>effect.toString().includes('keydown'));assert.ok(keyboard);keyboard();assert.ok(handler);
 const event=(target:unknown,key:string)=>({target,key,metaKey:key==='s',ctrlKey:false,preventDefault(){prevented++;}});
 handler(event(outside,'s'));handler(event(outside,'Escape'));assert.equal(prevented,0);assert.equal(closed,0);
 handler(event(inside,'s'));handler(event(inside,'Escape'));assert.equal(prevented,1);assert.equal(closed,1);
});


test('parent switching guard drains an in-flight save and refuses conflicted dirty notes',async()=>{
 const effects:Array<()=>void|(()=>void)>=[],refs:Array<React.MutableRefObject<any>>=[];
 const hooks={...React,useEffect(effect:()=>void|(()=>void)){effects.push(effect);},useRef(value:any){const ref=React.useRef(value);refs.push(ref);return ref;}} as typeof React;
 const isolated=load(hooks);let guard:(()=>Promise<boolean>)|undefined;
 renderToStaticMarkup(React.createElement(isolated.default,{resource,onClose(){},embedded:true,onGuardChange(next){guard=next;}}));
 const registration=effects.find(effect=>effect.toString().includes('onGuardChange'));assert.ok(registration);registration();assert.ok(guard);
 const dirtyRef=refs[refs.findIndex(ref=>ref.current===0)-1],inFlight=refs.at(-1)!,conflict=refs.at(-3)!;
 assert.equal(dirtyRef.current,false);assert.equal(inFlight.current,undefined);assert.equal(conflict.current,undefined);
 let finish!:(value:boolean)=>void,finished=false;
 dirtyRef.current=true;inFlight.current=new Promise<boolean>(resolve=>{finish=resolve;});
 const waiting=guard().then(result=>{finished=true;return result;});await Promise.resolve();assert.equal(finished,false);
 dirtyRef.current=false;finish(true);assert.equal(await waiting,true);
 inFlight.current=undefined;dirtyRef.current=true;conflict.current={hash:'new',document:{content:'changed'}};
 assert.equal(await guard(),false);assert.equal(dirtyRef.current,true);
});

test('a failed PDF can be reopened and selected text can be saved with translation off',async context=>{
 const states:any[]=[],refs:Array<{current:any}>=[],effects:Array<()=>void|(()=>void)>=[],nodes:Array<{tag:unknown;props:any}>=[];
 let stateIndex=0,refIndex=0;
 const hooks={...React,
  useState(initial:any){const index=stateIndex++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return[states[index],(next:any)=>{states[index]=typeof next==='function'?next(states[index]):next;}];},
  useRef(initial:any){return refs[refIndex++]??=( {current:initial} );},
  useEffect(effect:()=>void|(()=>void)){effects.push(effect);},
 } as typeof React;
 const isolated=load(hooks,(tag,props)=>nodes.push({tag,props}));
 const render=()=>{stateIndex=0;refIndex=0;effects.length=0;nodes.length=0;return renderToStaticMarkup(React.createElement(isolated.default,{resource,onClose(){}}));};
 const stub=(key:string,value:unknown)=>{const original=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,value});context.after(()=>{if(original)Object.defineProperty(globalThis,key,original);else Reflect.deleteProperty(globalThis,key);});};
 const settings=new EventTarget(),saved=new Map<string,string>();
 const storage={getItem:(key:string)=>key==='echopaper-reader:prefs'?'{"auto":false}':saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);}};
 const sourcePage={getAttribute:()=> '3',querySelector:()=>null};
 const token={parentElement:{closest:(selector:string)=>selector==='[data-pdf-page]'?sourcePage:null}};
 const range={startContainer:token,startOffset:0,getBoundingClientRect:()=>({left:80,top:100,bottom:120,width:140,height:20})};
 let selection=true;
 stub('Element',class{});
 stub('window',Object.assign(settings,{innerWidth:1250,innerHeight:850,getSelection:()=>({rangeCount:Number(selection),anchorNode:token,focusNode:token,toString:()=> 'Synthetic excerpt',getRangeAt:()=>range,removeAllRanges:()=>{selection=false;}})}));
 stub('localStorage',storage);stub('sessionStorage',storage);
 stub('requestAnimationFrame',(run:()=>void)=>{run();return 1;});
 const registry={providers:[{id:'deepl',kind:'deepl'}],models:[{id:'model',providerId:'deepl',label:'DeepL',configured:true}],translations:[{id:'source',enabled:true,label:'DeepL',modelId:'model'}]};
 let configReads=0;
 context.mock.method(globalThis,'fetch',async(url:string)=>url.endsWith('/providers')
  ?Response.json(configReads++?registry:{providers:[],models:[],translations:[]})
  :Response.json({document:{version:1,resourceId:resource.id,notes:[],content:''},hash:null}));
 let opens=0;
 stub('openReaderTestPdf',(source:string|{url:string})=>{
  const url=typeof source==='string'?source:source.url;
  assert.match(url,/raw\?sourceHash=current$/);
  const promise=opens++?Promise.resolve({numPages:4}):Promise.reject(new Error('PDF temporarily unavailable'));
  return {promise,destroy:async()=>{}};
 });
 const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
 const runEffect=(pattern:RegExp)=>{const effect=effects.find(item=>pattern.test(item.toString()));assert.ok(effect);return effect();};

 assert.match(render(),/正在加载 PDF/);
 const unload=runEffect(/loadReading/);
 const stopFirst=runEffect(/loadSource/);
 const stopSettings=runEffect(/MODEL_CONFIG_EVENT/);
 await settle();
 let html=render();assert.match(html,/PDF 无法打开/);assert.match(html,/PDF temporarily unavailable/);assert.doesNotMatch(html,/正在加载 PDF/);
 assert.match(html,/未启用翻译来源/);
 settings.dispatchEvent(new Event(MODEL_CONFIG_EVENT));await settle();
 html=render();assert.equal(configReads,2);assert.doesNotMatch(html,/未启用翻译来源/);

 nodes.find(({props})=>props.className==='reader-retry')?.props.onClick();
 stopFirst?.();
 render();
 const stopSecond=runEffect(/loadSource/);
 await settle();render();
 const area=nodes.find(({props})=>props.className==='reader-source');
 assert.ok(area);area.props.ref.current={contains:(node:unknown)=>node===token,textContent:'Synthetic excerpt'};
 area.props.onMouseUp();
 html=render();assert.match(html,/选区摘录/);assert.match(html,/存为摘录/);assert.doesNotMatch(html,/正在翻译/);
 const save=nodes.find(({tag,props})=>tag==='button'&&Array.isArray(props.children)&&props.children.includes('存为摘录'));
 assert.ok(save);save.props.onClick();
 const draft=JSON.parse(saved.get(`echopaper-reading:${resource.id}`)!);
 assert.equal(draft.document.notes[0].quote,'Synthetic excerpt');assert.equal(draft.document.notes[0].page,3);
 assert.equal(draft.document.notes[0].locationKind,'pdf-page');assert.equal(draft.document.notes[0].sourceHash,'current');
 assert.match(render(),/p\.3/);
 stopSecond?.();stopSettings?.();unload?.();
});
