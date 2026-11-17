import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createElement} from 'react';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type ReferenceList from '../src/academic/ReferenceList';
import type {Resource} from '../shared/workspace-types';
import type {ReadingProcessing} from '../src/academic/ReadingProcessing';

const compiled=await build({
 entryPoints:[fileURLToPath(new URL('../src/academic/ReferenceList.tsx',import.meta.url))],
 bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},jsx:'automatic',
});
const module={exports:{} as {default:typeof ReferenceList}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);

function file(number:number,modifiedAt='2026-11-13T00:00:00Z'):Resource {
 return {id:`paper-${number}`,name:`${number}_Paper ${number}.pdf`,path:`${number}_Paper ${number}.pdf`,rootId:'references',kind:'file',
  size:100,modifiedAt,tags:[],missing:false,revision:1};
}
function render(files:Resource[],starred=new Set<string>(),variant:'papers'|'notes'='papers') {
 const html=renderToStaticMarkup(createElement(module.exports.default,{files,starred,variant,onToggleStar(){}}));
 return [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(match=>match[0]);
}
const filename=(row:string)=>row.match(/title="阅读：([^"]+)"/)?.[1];
const number=(row:string)=>row.match(/<span class="reference-number[^\"]*"[^>]*>(\d+)<\/span>/)?.[1];

test('starred papers keep priority order and receive consecutive list numbers',()=>{
 const files=[file(10),file(2),file(1),file(3)];
 const rows=render(files,new Set(['paper-10','paper-3']));
 assert.deepEqual(rows.map(filename),['3_Paper 3.pdf','10_Paper 10.pdf','1_Paper 1.pdf','2_Paper 2.pdf']);
 assert.deepEqual(rows.map(number),['1','2','3','4']);
 assert.deepEqual(files.map(file=>file.id),['paper-10','paper-2','paper-1','paper-3']);
 assert.match(rows[0],/aria-pressed="true"/);assert.match(rows[1],/aria-pressed="true"/);
 assert.match(rows[2],/aria-pressed="false"/);
 assert.match(rows[0],/aria-label="移出重点文献 Paper 3"/);
});

test('removing a star restores numeric placement with the same compact row structure',()=>{
 const files=[file(3),file(1),file(2)];
 const plain=render(files),starred=render(files,new Set(['paper-3']));
 assert.deepEqual(plain.map(number),['1','2','3']);
 assert.equal(plain.length,starred.length);
 for(const rows of [plain,starred])for(const row of rows){
  assert.equal((row.match(/<button\b/g)||[]).length,2);
  assert.equal((row.match(/class="reference-star"/g)||[]).length,1);
  assert.equal((row.match(/<input\b/g)||[]).length,0);
 }
});

test('notes retain newest-first ordering when a starred set is supplied',()=>{
 const files=[file(1,'2026-11-11T00:00:00Z'),file(2,'2026-11-13T00:00:00Z')];
 const rows=render(files,new Set(['paper-1']),'notes');
 assert.deepEqual(rows.map(filename),['2_Paper 2.pdf','1_Paper 1.pdf']);
});

// Render the component with controlled hooks so async fetches can be settled out of order.
function searchHarness(props:Parameters<typeof ReferenceList>[0]) {
 const slots:any[]=[],cleanups:(void|(()=>void))[]=[],dependencies:(unknown[]|undefined)[]=[],setters:((value:any)=>void)[]=[];
 let cursor=0,effects:(()=>void)[]=[];
 const hooks={
  ...React,
  useState(initial:any){
   const index=cursor++;
   if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;
   const setValue=(value:any)=>{slots[index]=typeof value==='function'?value(slots[index]):value;};
   setters[index]=setValue;return [slots[index],setValue];
  },
  useRef(initial:any){const index=cursor++;return slots[index]??=( {current:initial} );},
  useMemo(compute:()=>unknown){cursor++;return compute();},
  useEffect(effect:()=>void|(()=>void),next:unknown[]){
   const index=cursor++,previous=dependencies[index];
   if(!previous||next.some((value,position)=>!Object.is(value,previous[position]))){
    dependencies[index]=next;
    effects.push(()=>{cleanups[index]?.();cleanups[index]=effect();});
   }
  },
 };
 const local={exports:{} as {default:typeof ReferenceList}},require=createRequire(import.meta.url);
 new Function('require','module','exports',compiled.outputFiles[0].text)((name:string)=>name==='react'?hooks:require(name),local,local.exports);
 return {
  setQuery(value:string){setters[0](value);},
  render(){cursor=0;const html=renderToStaticMarkup(createElement(local.exports.default,props));const pending=effects;effects=[];pending.forEach(effect=>effect());return html;},
  dispose(){cleanups.forEach(cleanup=>cleanup?.());},
 };
}
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('topic search debounces, intersects files, and numbers the filtered list',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const requests:{url:string;resolve:(value:Response)=>void}[]=[];
 context.mock.method(globalThis,'fetch',(url:string)=>new Promise<Response>(resolve=>requests.push({url,resolve})));
 const harness=searchHarness({files:[file(1),file(3)],topicId:'topic-1',starred:new Set(['paper-3'])});
 context.after(()=>harness.dispose());
 harness.render();harness.setQuery('  智能体   Agent  ');
 const waiting=harness.render();
 assert.match(waiting,/正在搜索本地原文与译文/);assert.doesNotMatch(waiting,/没有匹配的文献/);
 context.mock.timers.tick(179);assert.equal(requests.length,0);
 context.mock.timers.tick(1);assert.equal(requests.length,1);
 const params=new URL(requests[0].url,'http://localhost').searchParams;
 assert.equal(params.get('q'),'智能体 Agent');assert.equal(params.get('topicId'),'topic-1');assert.equal(params.get('group'),'paper');
 const match={source:'translation' as const,snippet:'智能体 Agent 协作',terms:['智能体','Agent'],page:2};
 requests[0].resolve(new Response(JSON.stringify({resources:[{...file(1),searchMatch:match},{...file(3),searchMatch:match},file(99)]})));
 await settle();const html=harness.render(),rows=[...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(match=>match[0]);
 assert.deepEqual(rows.map(number),['1','2']);assert.doesNotMatch(html,/Paper 99/);
 assert.match(html,/中文译文 · 第 2 页/);assert.match(html,/<mark>智能体<\/mark>/);
 harness.setQuery('');const cleared=harness.render();
 assert.doesNotMatch(cleared,/resource-search-excerpt/);assert.equal(requests.length,1);
});

test('changing keywords hides old matches immediately and rejects late responses',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const requests:{signal:AbortSignal;resolve:(value:Response)=>void}[]=[];
 context.mock.method(globalThis,'fetch',(_url:string,options:RequestInit)=>new Promise<Response>(resolve=>requests.push({signal:options.signal!,resolve})));
 const harness=searchHarness({files:[file(1),file(2)],topicId:'topic-1'});
 context.after(()=>harness.dispose());harness.render();
 harness.setQuery('first');harness.render();context.mock.timers.tick(180);
 requests[0].resolve(new Response(JSON.stringify({resources:[file(1)]})));await settle();
 assert.match(harness.render(),/阅读：1_Paper 1.pdf/);
 harness.setQuery('second');const changed=harness.render();
 assert.doesNotMatch(changed,/阅读：1_Paper 1.pdf|没有匹配的文献/);context.mock.timers.tick(180);
 harness.setQuery('third');harness.render();assert.equal(requests[1].signal.aborted,true);context.mock.timers.tick(180);
 requests[2].resolve(new Response(JSON.stringify({resources:[file(2)]})));await settle();
 requests[1].resolve(new Response(JSON.stringify({resources:[file(1)]})));await settle();
 const final=harness.render();assert.match(final,/阅读：2_Paper 2.pdf/);assert.doesNotMatch(final,/阅读：1_Paper 1.pdf/);
});

test('note searches omit the paper-only group and show request failures with retry',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const urls:string[]=[];
 context.mock.method(globalThis,'fetch',async(url:string)=>{urls.push(url);return new Response(JSON.stringify({error:'索引读取失败'}),{status:500});});
 const harness=searchHarness({files:[file(1)],topicId:'topic-1',variant:'notes'});
 context.after(()=>harness.dispose());harness.render();harness.setQuery('笔记');harness.render();context.mock.timers.tick(180);await settle();
 assert.equal(new URL(urls[0],'http://localhost').searchParams.has('group'),false);
 const html=harness.render();assert.match(html,/搜索失败，索引读取失败/);assert.match(html,/重试/);assert.doesNotMatch(html,/没有匹配的笔记/);
});

test('active searches refresh as OCR and translated cache progresses',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 let requests=0;
 context.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(JSON.stringify({resources:[]}));});
 const status={resourceId:'paper-1',stage:'ocr' as const,done:0,total:10,pageCount:0,appendix:false};
 const processing:ReadingProcessing={
  snapshot:{revision:1,settings:{enabled:true,translateAppendix:false,engineId:'ocr',translationSourceId:null},sources:{engine:'ocr',translation:'translation'},choices:{engines:[],translations:[]},statuses:{'paper-1':status},queue:{pending:0,active:1,failed:0}},
  error:'',busy:false,settings:async()=>{},enqueue:async()=>{},
 };
 const harness=searchHarness({files:[file(1)],topicId:'topic-1',processing});
 context.after(()=>harness.dispose());harness.render();harness.setQuery('agent');harness.render();context.mock.timers.tick(180);await settle();harness.render();
 assert.equal(requests,1);
 const current=processing.snapshot!.statuses['paper-1'];
 current.stage='translating';current.pageCount=5;harness.render();context.mock.timers.tick(180);await settle();harness.render();assert.equal(requests,2);
 current.done=3;harness.render();context.mock.timers.tick(180);await settle();harness.render();assert.equal(requests,3);
 current.updatedAt='2026-11-13T01:00:00Z';harness.render();context.mock.timers.tick(200);assert.equal(requests,3);
});

test('library-controlled search keeps OCR-only matches and reuses compact numbered rows with details',async context=>{
 let requests=0;
 context.mock.method(globalThis,'fetch',async()=>{requests++;throw Error('controlled search must use the library result');});
 const match={source:'translation' as const,snippet:'检索词只存在于中文译文',terms:['检索词'],page:5};
 const props:Parameters<typeof ReferenceList>[0]={files:[{...file(12),searchMatch:match}],starred:new Set(['paper-12']),onToggleStar(){},onDetails(){},search:{value:'检索词',onChange(){},loading:false,total:1}};
 const harness=searchHarness(props);context.after(()=>harness.dispose());
 const html=harness.render();await settle();
 assert.match(html,/Paper 12/);assert.match(html,/中文译文 · 第 5 页/);
 assert.match(html,/reference-details/);assert.match(html,/aria-label="查看 12_Paper 12.pdf"/);
 assert.match(html,/>1<\/span>/);assert.equal(requests,0);
});

test('all library files share compact rows and keep directory navigation available',()=>{
 const directory={...file(1),id:'directory',kind:'directory' as const,name:'资料目录',path:'资料目录'};
 const html=renderToStaticMarkup(createElement(module.exports.default,{files:[file(2),directory],variant:'files',onOpen(){},onDetails(){},search:{value:'',onChange(){},loading:false,total:2}}));
 assert.ok(html.indexOf('打开：资料目录')<html.indexOf('打开：2_Paper 2.pdf'));
 assert.match(html,/reference-rows/);assert.doesNotMatch(html,/role="table"/);
 assert.match(html,/aria-label="查看 资料目录"/);
});


test('mixed import prefixes cannot leak into list numbers and title order wins',()=>{
 const files=[{...file(2),id:'z',name:'2_Old.pdf',title:'Zebra Reasoning'},
  {...file(20),id:'a',name:'02_Imported.pdf',title:'Alpha Reasoning'}];
 const rows=render(files);assert.deepEqual(rows.map(number),['1','2']);
 assert.deepEqual(rows.map(filename),['Alpha Reasoning','Zebra Reasoning']);
 assert.ok(!rows.some(row=>/>02<\/span>/.test(row)));
 const props:Parameters<typeof ReferenceList>[0]={files,search:{value:'',onChange(){},loading:false,total:62,offset:60}};
 const html=renderToStaticMarkup(createElement(module.exports.default,props));
 const paged=[...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(match=>match[0]);
 assert.deepEqual(paged.map(number),['61','62']);
});

test('a duplicate supplied through a stale list is collapsed and its priority marker survives',()=>{
 const first={...file(2),id:'main',title:'Shared Paper Title',hash:'same-hash'};
 const alias={...file(20),id:'alias',name:'02_official.pdf',title:first.title,hash:first.hash};
 const rows=render([first,alias],new Set(['alias']));
 assert.equal(rows.length,1);assert.deepEqual(rows.map(number),['1']);
 assert.match(rows[0],/aria-pressed="true"/);
});
