import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateBrowserChats } from '../src/migrateChats.ts';
import type { PersistedChat } from '../shared/chat-merge.ts';
const data=(input:string):PersistedChat=>({version:1,selectedId:'c',conversations:[{id:'c',title:'Test',createdAt:'2026-10-22T00:00:00Z',updatedAt:'2026-10-22T00:00:00Z',messages:[],input,model:'MiniMax-M3.1-Flash',effort:'medium'}]});
for(const during of ['GET','PUT'])test(`chat migration preserves a newer browser draft arriving during ${during}`,async()=>{
 const oldFetch=globalThis.fetch,oldStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 let raw=JSON.stringify(data('initial draft')),server:PersistedChat|null=null,hash:string|null=null,changed=false;
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>raw,setItem:(_key:string,value:string)=>{raw=value;}}});
 globalThis.fetch=async(_url,options)=>{
  const method=options?.method??'GET';
  if(method===during&&!changed){changed=true;raw=JSON.stringify(data('new browser draft'));}
  if(method==='PUT'){const body=JSON.parse(String(options?.body));assert.equal(body.expectedHash,hash);server=body.data;hash=`h${Number(hash?.slice(1)??0)+1}`;}
  return new Response(JSON.stringify({data:server,hash}),{status:200});
 };
 try{await migrateBrowserChats(['Test']);assert.ok(changed);const browser=JSON.parse(raw)as PersistedChat;for(const stored of [browser,server]){assert.ok(stored?.conversations.some(c=>c.input==='new browser draft'));assert.ok(stored?.conversations.some(c=>c.input==='initial draft'));}}
 finally{globalThis.fetch=oldFetch;if(oldStorage)Object.defineProperty(globalThis,'localStorage',oldStorage);else delete(globalThis as any).localStorage;}
});
