import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type ResearchNotes from '../src/academic/ResearchNotes';

const compiled=await build({
 entryPoints:[fileURLToPath(new URL('../src/academic/ResearchNotes.tsx',import.meta.url))],
 bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',
 plugins:[{name:'note-editor-stubs',setup(builder){
  builder.onResolve({filter:/\.css$|(?:ResearchTextEditor|AiMarkdown)$/},args=>({path:args.path,namespace:'note-stub'}));
  builder.onLoad({filter:/.*/,namespace:'note-stub'},()=>({contents:'export default function Stub(){return null;}',loader:'js'}));
 }}],
});

function mount(cached:Map<string,string>){
 const effects:Array<()=>void|(()=>void)>=[];
 const hooks={...React,useEffect(effect:()=>void|(()=>void)){effects.push(effect);}} as typeof React;
 const require=createRequire(import.meta.url),module={exports:{} as {default:typeof ResearchNotes}};
 new Function('require','module','exports',compiled.outputFiles[0].text)((name:string)=>name==='react'?hooks:require(name),module,module.exports);
 let guard:(()=>Promise<boolean>)|undefined,busy:boolean|undefined;
 const previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(key:string)=>cached.get(key)??null}});
 try{
  renderToStaticMarkup(React.createElement(module.exports.default,{topicId:'topic-a',section:'ideation',onGuardChange(value){guard=value;},onRefresh:async()=>{},onBusyChange(value){busy=value;}}));
  const registration=effects.find(effect=>effect.toString().includes('onGuardChange'));
  const busyEffect=effects.find(effect=>effect.toString().includes('onBusyChange'));
  assert.ok(registration);assert.ok(busyEffect);registration();busyEffect();assert.ok(guard);
  return {guard,busy};
 }finally{if(previous)Object.defineProperty(globalThis,'sessionStorage',previous);else delete (globalThis as any).sessionStorage;}
}

const key='echopaper:research-notes:topic-a:ideation:pending-delete';
const pending=JSON.stringify({noteId:'note-a',expectedHash:'a'.repeat(64),requestId:'confirmed-delete'});

test('a persisted deletion blocks note actions and navigation before list recovery starts',async()=>{
 const state=mount(new Map([[key,pending]]));
 assert.equal(state.busy,true);assert.equal(await state.guard(),false);
});

test('pending deletion hydration is scoped to its topic and note section',async()=>{
 for(const unrelated of [key.replace('topic-a','topic-b'),key.replace('ideation','results')]){
  const state=mount(new Map([[unrelated,pending]]));
  assert.equal(state.busy,false);assert.equal(await state.guard(),true);
 }
});

test('malformed pending metadata remains available for recovery without breaking rendering',async()=>{
 const cached=new Map([[key,'{broken']]);
 const state=mount(cached);
 assert.equal(cached.get(key),'{broken');assert.equal(await state.guard(),true);
});
