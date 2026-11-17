import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import {registerWorkspaceRoutes} from '../server/workspace/index';
import {fingerprintFile} from '../server/workspace/source-fingerprint';
import {checkSourceChain} from '../server/workspace/source-chain';
import {usageKey} from '../shared/research-entries';

test('fingerprinting reads exact bytes and rejects simultaneous in-place writes',async()=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'fingerprint-')),file=path.join(root,'data.bin');
 try{await fs.writeFile(file,'fixture bytes');assert.equal(await fingerprintFile(file),createHash('sha256').update('fixture bytes').digest('hex'));
  await fs.writeFile(file,Buffer.alloc(16*1024*1024,65));const writer=await fs.open(file,'r+');let count=0;const pending:Promise<unknown>[]=[];
  const interval=setInterval(()=>{pending.push(writer.write(Buffer.from(String(++count)),0,1,0));},1);
  try{await assert.rejects(fingerprintFile(file),(e:any)=>e.statusCode===409);assert.ok(count>0);}finally{clearInterval(interval);await Promise.all(pending);await writer.close();}
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('paper links and original source chains survive edits, history and scope changes',async()=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'research-links-'));
 for(const id of ['p','other']){await fs.mkdir(path.join(root,'papers',id,'manuscript'),{recursive:true});await fs.mkdir(path.join(root,'papers',id,'notes'));
  await fs.writeFile(path.join(root,'papers',id,'project.json'),JSON.stringify({schemaVersion:1,id,title:id,stage:'writing',venue:'',deadline:'',targets:[],createdAt:'2026-01-01',updatedAt:'2026-01-01',autoCompile:false}));await fs.writeFile(path.join(root,'papers',id,'manuscript/main.tex'),'fixture manuscript');}
 await fs.writeFile(path.join(root,'papers/p/notes/research-basis.md'),'verified fixture basis');await fs.writeFile(path.join(root,'papers/p/manuscript/raw.csv'),'x,y\n1,2\n');
 const app=Fastify();app.setErrorHandler((e,_r,r)=>r.code((e as any).statusCode||((e as any).code==='ENOENT'?404:500)).send({error:(e as Error).message}));const service=await registerWorkspaceRoutes(app,root,{watch:false});
 try{let t=(await app.inject({method:'POST',url:'/api/workspace/topics',payload:{title:'Fixture topic',paperIds:['p']}})).json();const base=`/api/workspace/topics/${t.id}/entries`;
  const add=async(body:object)=>{const r=await app.inject({method:'POST',url:base,payload:{expectedRevision:t.revision,...body}});assert.equal(r.statusCode,201);t=r.json().topic;return r.json().entry;};
  const patch=async(e:any,body:object)=>{const r=await app.inject({method:'PATCH',url:base+'/'+e.id,payload:{expectedRevision:t.revision,expectedEntryRevision:e.revision,...body}});assert.equal(r.statusCode,200);t=r.json().topic;return r.json().entry;};
  let exp=await add({kind:'experiment',title:'Experiment fixture',sources:[{kind:'paper-file',paperId:'p',path:'manuscript/raw.csv'}]});
  let evidence=await add({kind:'evidence',title:'Evidence fixture',sources:[{kind:'research-entry',entryId:exp.id,entryKind:'experiment'}]});
  assert.equal((await app.inject(base+'/'+evidence.id+'/source-status')).json().statuses[0].state,'current');
  await fs.writeFile(path.join(root,'papers/p/manuscript/raw.csv'),'x,y\n1,3\n');
  let status=(await app.inject(base+'/'+evidence.id+'/source-status')).json().statuses[0];assert.equal(status.state,'changed');assert.match(status.message,/上游/);assert.equal(status.children[0].status.state,'changed');
  // A newer experiment version refreshing its input must not hide changes in the originally cited version.
  exp=await patch(exp,{refreshSources:true});status=(await app.inject(base+'/'+evidence.id+'/source-status')).json().statuses[0];assert.equal(status.state,'changed');assert.equal(status.children[0].source.fingerprint,evidence.sources.length?exp.history[0].sources[0].fingerprint:'');
  const usage={paperId:'p',path:'manuscript/main.tex',purpose:'figure',location:'Fig. 2'};
  evidence=await patch(evidence,{usages:[usage]});assert.equal(evidence.usages.length,1);const firstHash=evidence.usages[0].fingerprint,revision=evidence.revision;
  assert.equal(evidence.history.at(-1).usages.length,0);
  const url='/api/projects/p/research-evidence?path=manuscript%2Fmain.tex';let data=(await app.inject(url)).json();assert.equal(data.contexts[0].entries[0].links.length,1);assert.equal(data.contexts[0].entries[0].sourceState,'changed');assert.match(data.basisPath,/research-basis/);assert.equal(data.contexts[0].entries[0].links[0].state,'current');
  assert.match((await app.inject(`${base}/${evidence.id}/usages/0/open`)).json().path,/papers\/p\/writing\?file=/);
  for(const body of [{usages:[usage,usage]},{usages:[{...usage,paperId:'other'}]},{usages:[{...usage,path:'../private'}]},{usages:[{...usage,purpose:'unrecognized'}]}])assert.ok((await app.inject({method:'PATCH',url:base+'/'+evidence.id,payload:{expectedRevision:t.revision,expectedEntryRevision:evidence.revision,...body}})).statusCode>=400);
  assert.equal((await app.inject({method:'PATCH',url:base+'/'+evidence.id,payload:{expectedRevision:t.revision,expectedEntryRevision:revision-1,usages:[]}})).statusCode,409);
  await fs.writeFile(path.join(root,'papers/p/manuscript/main.tex'),'updated fixture manuscript');data=(await app.inject(url)).json();assert.equal(data.contexts[0].entries[0].links[0].state,'changed');
  evidence=await patch(evidence,{limitations:'Metadata changed'});assert.equal(evidence.usages[0].fingerprint,firstHash);
  evidence=await patch(evidence,{refreshUsageKeys:[usageKey(usage as any)]});assert.notEqual(evidence.usages[0].fingerprint,firstHash);
  evidence=await patch(evidence,{usages:[]});assert.equal((await app.inject(url)).json().contexts[0].entries[0].links.length,0);assert.ok(evidence.history.some((h:any)=>h.usages?.length===1));
  const broken=await app.inject('/api/projects/p/research-evidence?path=..%2Fprivate');assert.equal(broken.statusCode,400);
  t=(await app.inject({method:'PATCH',url:`/api/workspace/topics/${t.id}`,payload:{expectedRevision:t.revision,paperIds:[]}})).json();assert.equal((await app.inject(url)).json().contexts.length,0);assert.ok((await app.inject(`${base}/${evidence.id}/usages/0/open?revision=${revision}`)).statusCode>=400);
 }finally{await service.close();await app.close();await fs.rm(root,{recursive:true,force:true});}
});

test('versioned source traversal detects cycles and unavailable ancestors',async()=>{
 const source=(entryId:string)=>({target:{kind:'research-entry' as const,entryId,entryKind:'experiment' as const},label:entryId,fingerprint:'old',capturedAt:'',version:1});
 const entry=(id:string,sources:any[])=>({id,kind:'experiment',revision:1,createdAt:'',updatedAt:'',history:[],title:id,state:'planned',question:'',protocol:'',observation:'',conclusion:'',limitations:'',archived:false,sources});
 const a=entry('a',[source('b')]),b=entry('b',[source('a')]);const context={root:'',topic:{id:'t',archived:false,workEntries:[a,b]},resources:[],roots:[]} as any;
 const status=await checkSourceChain(context,a as any,'a');assert.equal(status[0].state,'unavailable');assert.match(JSON.stringify(status),/循环/);
 b.archived=true;assert.equal((await checkSourceChain(context,a as any,'a'))[0].state,'unavailable');
 b.archived=false;const older={...a,sources:[]};(a as any).history=[older];a.revision=2;const versioned=await checkSourceChain(context,a as any,'a');assert.notEqual(versioned[0].state,'unavailable');assert.doesNotMatch(JSON.stringify(versioned),/循环/);
});
