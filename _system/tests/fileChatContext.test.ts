import test from 'node:test';
import assert from 'node:assert/strict';
import {fileChatContext} from '../src/fileChatContext';

test('a selected source keeps its path and unsaved buffer without saving or fetching the open editor',async()=>{
 const before=globalThis.fetch;globalThis.fetch=async()=>{throw Error('unexpected network request');};
 try{const value=await fileChatContext('P','manuscript/figure.tex','latest unsaved text');assert.equal(value.reference.path,'manuscript/figure.tex');assert.match(value.reference.content,/latest unsaved text/);assert.match(value.reference.content,/未保存/);assert.equal(value.attachment,undefined);}finally{globalThis.fetch=before;}
});
test('a different source is read by its exact path, with explicit truncation for large previews',async()=>{
 const before=globalThis.fetch,calls:string[]=[];globalThis.fetch=async(url)=>{calls.push(String(url));return Response.json({content:'x'.repeat(51000)});};
 try{const value=await fileChatContext('P','manuscript/a b.tex');assert.equal(calls.length,1);assert.match(calls[0],/a%20b\.tex/);assert.match(value.reference.content,/预览仅包含前 50000 字符/);assert.ok(value.reference.content.length<50500);}finally{globalThis.fetch=before;}
});
test('a project image becomes a real attachment with its original name and source path',async()=>{
 const before=globalThis.fetch,calls:{url:string;options?:RequestInit}[]=[];
 globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});if(String(url).includes('/raw?'))return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});const form=options?.body as FormData;assert.equal((form.get('file') as File).name,'figure.png');return Response.json({id:'attachment',name:'figure.png',kind:'image'});};
 try{const value=await fileChatContext('P','manuscript/figure.png');assert.equal(calls.length,2);assert.equal(value.attachment?.kind,'image');assert.equal(value.reference.path,'manuscript/figure.png');assert.match(value.reference.content,/定位引用该文件的源码/);assert.ok(calls[1].url.endsWith('/agent-attachments'));}finally{globalThis.fetch=before;}
});
test('a failed or oversized image read never creates an attachment',async()=>{
 const before=globalThis.fetch,calls:string[]=[];
 try{globalThis.fetch=async(url)=>{calls.push(String(url));return new Response('',{status:404});};await assert.rejects(fileChatContext('P','missing.jpg'),/404/);
 globalThis.fetch=async(url)=>{calls.push(String(url));return new Response('x',{headers:{'content-length':String(11*1024*1024)}});};await assert.rejects(fileChatContext('P','large.jpg'),/文件过大/);assert.ok(calls.every(url=>url.includes('/raw?')));}finally{globalThis.fetch=before;}
});
