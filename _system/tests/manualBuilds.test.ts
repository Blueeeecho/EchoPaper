import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.ts';
import {createProject,patchProject} from '../server/projects.ts';
import type {BuildService} from '../shared/types.ts';

test('legacy autoCompile never compiles filesystem edits or save/rename/upload/review/settings actions',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-explicit-build-'));
 const calls:{projectId:string;targetId:string}[]=[];
 const builds:BuildService={
  async request(projectId,targetId){calls.push({projectId,targetId});return{id:'explicit-build',projectId,targetId,status:'queued',createdAt:new Date().toISOString(),log:'',diagnostics:[]};},
  async list(){return[];},async get(){throw new Error('unused');},async cancel(){throw new Error('unused');},async artifact(){throw new Error('unused');},async createSubmission(){throw new Error('unused');},async listSubmissions(){return[];},async submissionArtifact(){throw new Error('unused');},async close(){},
 };
 let app:Awaited<ReturnType<typeof createApp>>|undefined;
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const controller=new AbortController();
 try{
  await fs.mkdir(path.join(root,'shared/templates/english'),{recursive:true});
  await fs.writeFile(path.join(root,'shared/templates/english/main.tex'),'\\documentclass{article}\n\\begin{document}Original\\end{document}\n');
  await fs.mkdir(path.join(root,'papers'));
  await createProject(root,{id:'Manual',title:'Explicit compilation',template:'english'});
  await patchProject(root,'Manual',{autoCompile:true});
  app=await createApp({workspaceRoot:root,buildService:builds,watch:true});
  const address=await app.listen({host:'127.0.0.1',port:0});
  const stream=await fetch(address+'/api/events',{signal:controller.signal});reader=stream.body!.getReader();await reader.read();
  await fs.writeFile(path.join(root,'papers/Manual/manuscript/main.tex'),'Changed by Codex');
  const event=await Promise.race([(async()=>{let received='';for(;;){const part=await reader!.read();if(part.done)throw new Error('SSE ended early');received+=new TextDecoder().decode(part.value);if(received.includes('manuscript/main.tex'))return received;}})(),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('External file SSE timeout')),7000).unref())]);
  assert.ok(event.includes('file.changed'),'External changes still synchronize over SSE');
  const file=(await app.inject('/api/projects/Manual/file?path=manuscript/main.tex')).json();
  const save=await app.inject({method:'PUT',url:'/api/projects/Manual/file',payload:{path:file.path,content:'Browser autosave',expectedHash:file.hash}});assert.equal(save.statusCode,200,save.body);
  const rename=await app.inject({method:'POST',url:'/api/projects/Manual/files/rename',payload:{from:file.path,to:'manuscript/renamed.tex',expectedHash:save.json().hash}});assert.equal(rename.statusCode,200,rename.body);
  const settings=await app.inject({method:'PATCH',url:'/api/projects/Manual',payload:{autoCompile:true,targets:[{id:'main',label:'Main',main:'manuscript/renamed.tex'}]}});assert.equal(settings.statusCode,200,settings.body);
  const upload=await app.inject({method:'POST',url:'/api/projects/Manual/upload?directory=manuscript',headers:{'content-type':'multipart/form-data; boundary=manual-boundary'},payload:Buffer.from('--manual-boundary\r\nContent-Disposition: form-data; name="file"; filename="included.tex"\r\nContent-Type: text/plain\r\n\r\nIncluded text\r\n--manual-boundary--\r\n')});assert.equal(upload.statusCode,200,upload.body);
  const notes=await app.inject({method:'PUT',url:'/api/projects/Manual/file',payload:{path:'notes/edit.md',content:'A note',expectedHash:null}});assert.equal(notes.statusCode,200,notes.body);
  const round=await app.inject({method:'POST',url:'/api/projects/Manual/reviews',payload:{label:'Revision'}});assert.equal(round.statusCode,200,round.body);
  const response=await app.inject({method:'PUT',url:`/api/projects/Manual/reviews/${round.json().id}`,payload:{items:[{id:'R1',comment:'Please explain.',response:'Explanation.',status:'addressed'}]}});assert.equal(response.statusCode,200,response.body);
  // Longer than the removed 900ms debounce plus watcher stability delay.
  await new Promise(resolve=>setTimeout(resolve,1700));
  assert.deepEqual(calls,[],'No mutation, external file event, or legacy setting may start compilation');
  assert.equal((await app.inject('/api/projects/Manual')).json().autoCompile,true,'Legacy configuration remains readable');
  const compile=await app.inject({method:'POST',url:'/api/projects/Manual/builds',payload:{targetId:'main'}});assert.equal(compile.statusCode,200,compile.body);
  assert.deepEqual(calls,[{projectId:'Manual',targetId:'main'}],'Only the explicit build endpoint requests compilation');
 }finally{controller.abort();await reader?.cancel().catch(()=>undefined);await app?.close();await fs.rm(root,{recursive:true,force:true});}
});
