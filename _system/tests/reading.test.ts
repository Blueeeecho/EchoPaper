import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {registerReadingRoutes} from '../server/workspace/reading';
test('独立只读资料笔记：持久化、CAS并发、隔离、失败保留原版、路径保护',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reading-'));const app=Fastify();app.setErrorHandler((e:any,req,reply)=>reply.code(e.statusCode||500).send({error:e.message}));registerReadingRoutes(app,root,{resourceFile:async id=>{if(!['a','b'].includes(id))throw Object.assign(new Error('missing'),{statusCode:404});return {} as any;}});
 const url='/api/workspace/resources/a/reading';const d={version:1,resourceId:'a',content:'个人判断',notes:[{id:'q',quote:'原文',translation:'译文',comment:'判断',page:2,sourceHash:'v1',sourcePath:'original.pdf',createdAt:'today'}]};
 try{const initial=(await app.inject(url)).json();assert.equal(initial.hash,null);const write=()=>app.inject({method:'PUT',url,payload:{document:d,expectedHash:null}});const replies=await Promise.all([write(),write()]);assert.deepEqual(replies.map(r=>r.statusCode).sort(),[200,409]);const saved=(await app.inject(url)).json();assert.deepEqual(saved.document,d);assert.equal((await app.inject('/api/workspace/resources/b/reading')).json().document.content,'');const invalid=await app.inject({method:'PUT',url,payload:{document:{...d,resourceId:'b'},expectedHash:saved.hash}});assert.equal(invalid.statusCode,400);assert.deepEqual((await app.inject(url)).json(),saved);assert.equal((await app.inject('/api/workspace/resources/no/reading')).statusCode,404);await app.close();const other=Fastify();registerReadingRoutes(other,root,{resourceFile:async()=>({} as any)});assert.deepEqual((await other.inject(url)).json(),saved);await other.close();}finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});

test('R2 文本未定位与PDF物理页跨服务重载保真，兼容旧记录且不推断页码',async()=>{
 const {readingPage}=await import('../shared/reading');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reading-location-'));
 const make=()=>{const app=Fastify();app.setErrorHandler((e:any,req,reply)=>reply.code(e.statusCode||500).send({error:e.message}));registerReadingRoutes(app,root,{resourceFile:async()=>({} as any)});return app;};
 let app=make();const url='/api/workspace/resources/a/reading';
 const base={id:'text',quote:'text selection',translation:'',comment:'',sourceHash:'v1',sourcePath:'note.txt',createdAt:'today'};
 const text={...base,page:null,locationKind:'unlocated' as const},pdf={...base,id:'pdf',page:2,locationKind:'pdf-page' as const},legacy={...base,id:'old',page:1};
 try{
 const document={version:1,resourceId:'a',content:'',notes:[text,pdf,legacy]};
 assert.equal((await app.inject({method:'PUT',url,payload:{document,expectedHash:null}})).statusCode,200);
 await app.close();app=make();const saved=(await app.inject(url)).json();assert.deepEqual(saved.document,document);
 assert.equal(readingPage(saved.document.notes[0]),null);assert.equal(readingPage(saved.document.notes[1]),2);assert.equal(readingPage(saved.document.notes[2]),null);
 for(const invalid of [{...text,page:1},{...pdf,page:0},{...pdf,page:null},{...pdf,locationKind:'text'}])assert.equal((await app.inject({method:'PUT',url,payload:{document:{...document,notes:[invalid]},expectedHash:saved.hash}})).statusCode,400);
 assert.deepEqual((await app.inject(url)).json(),saved);
 }finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});

test('原文件失联后已有笔记仍能读取和CAS保存，不能给未知资料创建笔记',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reading-missing-'));let missing=false;
 const app=Fastify();app.setErrorHandler((e:any,req,reply)=>reply.code(e.statusCode||500).send({error:e.message}));
 registerReadingRoutes(app,root,{resourceFile:async()=>{if(missing)throw Object.assign(new Error('原文件失联'),{statusCode:404});return {} as any;}});
 const url='/api/workspace/resources/a/reading',document={version:1,resourceId:'a',content:'保留判断',notes:[]};
 try{
 const first=await app.inject({method:'PUT',url,payload:{document,expectedHash:null}});assert.equal(first.statusCode,200);missing=true;
 assert.deepEqual((await app.inject(url)).json(),first.json());
 const next=await app.inject({method:'PUT',url,payload:{document:{...document,content:'继续记录'},expectedHash:first.json().hash}});assert.equal(next.statusCode,200);
 assert.equal((await app.inject({method:'PUT',url,payload:{document,expectedHash:first.json().hash}})).statusCode,409);
 assert.equal((await app.inject('/api/workspace/resources/unknown/reading')).statusCode,404);
 assert.equal((await app.inject({method:'PUT',url:'/api/workspace/resources/unknown/reading',payload:{document:{...document,resourceId:'unknown'},expectedHash:null}})).statusCode,404);
 }finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});
