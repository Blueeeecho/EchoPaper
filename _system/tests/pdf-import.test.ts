import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import {registerWorkspaceRoutes} from '../server/workspace/index.ts';
import {layoutStore} from '../server/workspace/document-layout.ts';

const original=Buffer.from('%PDF-1.4\nshared document');
async function fixture(t:test.TestContext){
 const base=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'shared-pdf-import-'));
 const root=path.join(base,'app');await fs.mkdir(path.join(root,'papers'),{recursive:true});
 const app=Fastify();await app.register(multipart);
 app.setErrorHandler((error,_request,reply)=>reply.code((error as any).statusCode||500).send({error:(error as Error).message}));
 const service=await registerWorkspaceRoutes(app,root,{watch:false});
 t.after(async()=>{await service.close();await app.close();await fs.rm(base,{recursive:true,force:true});});
 async function upload(params:Record<string,string>={},name='paper.pdf',bytes=original){
  const query=new URLSearchParams({expectedHash:'null',...params});
  return app.inject({method:'POST',url:`/api/workspace/resources/upload?${query}`,headers:{'content-type':'multipart/form-data; boundary=pdf'},payload:Buffer.concat([Buffer.from(`--pdf\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`),bytes,Buffer.from('\r\n--pdf--\r\n')])});
 }
 async function topic(title='Research'){return (await app.inject({method:'POST',url:'/api/workspace/topics',payload:{title}})).json();}
 async function connect(permission='write'){
  const folder=path.join(base,`source-${permission}`);await fs.mkdir(path.join(folder,'nested'),{recursive:true});
  const response=await app.inject({method:'POST',url:'/api/workspace/roots',payload:{path:folder,permission}});assert.equal(response.statusCode,201,response.body);
  await service.checkpoint();const roots=(await app.inject('/api/workspace/roots')).json().roots;
  return roots.find((item:any)=>item.id===response.json().id);
 }
 return {base,root,app,service,upload,topic,connect};
}

test('global library imports create an indexed reference folder and reuse renamed identical PDFs',async t=>{
 const f=await fixture(t);const response=await f.upload();assert.equal(response.statusCode,201,response.body);
 const imported=response.json();assert.equal(imported.topic,undefined);assert.equal(imported.reused,false);
 assert.equal(imported.root.path,path.join(f.root,'materials','library','参考文献'));assert.equal(imported.root.permission,'write');
 assert.deepEqual(await fs.readFile(path.join(imported.root.path,'paper.pdf')),original);
 const retry=await f.upload({},'renamed.pdf');assert.equal(retry.statusCode,201,retry.body);assert.equal(retry.json().resource.id,imported.resource.id);assert.equal(retry.json().reused,true);
 assert.deepEqual(await fs.readdir(imported.root.path),['paper.pdf']);assert.equal((await f.app.inject('/api/workspace/resources')).json().total,1);
 const changedBytes=Buffer.from('%PDF-1.4\nother contents');
 const changed=await f.upload({},'paper.pdf',changedBytes);assert.equal(changed.statusCode,201,changed.body);
 assert.match(changed.json().resource.name,/^paper-[a-f0-9]{12}\.pdf$/);assert.notEqual(changed.json().resource.id,imported.resource.id);
 assert.deepEqual(await fs.readFile(path.join(imported.root.path,changed.json().resource.name)),changedBytes);
 assert.deepEqual(await fs.readFile(path.join(imported.root.path,'paper.pdf')),original);
 const changedRetry=await f.upload({},'paper.pdf',changedBytes);assert.equal(changedRetry.json().resource.id,changed.json().resource.id);
});

test('library and topic entry points share resource identity, tags and frozen translation caches',async t=>{
 const f=await fixture(t),topic=await f.topic();const imported=(await f.upload()).json();
 const store=layoutStore(f.root);
 await store.writeLayout({version:1,resourceId:imported.resource.id,sourceHash:imported.resource.hash,parsedAt:new Date().toISOString(),pageCount:1,costPages:1,pages:[]});
 await store.mergeTranslations(imported.resource.id,{'translation':'already translated'},imported.resource.hash);
 const cache=await store.readTranslations(imported.resource.id);
 const linked=await f.upload({topicId:topic.id,expectedRevision:String(topic.revision)},'other.pdf');assert.equal(linked.statusCode,201,linked.body);
 assert.equal(linked.json().resource.id,imported.resource.id);assert.equal(linked.json().root.id,imported.root.id);assert.equal(linked.json().reused,true);assert.equal(linked.json().alreadyLinked,false);
 assert.deepEqual(linked.json().topic.resourceIds,[imported.resource.id]);assert.deepEqual(await store.readTranslations(imported.resource.id),cache);
 await assert.rejects(fs.stat(path.join(f.root,'materials',topic.id)),{code:'ENOENT'});
 const again=await f.upload({topicId:topic.id,expectedRevision:String(linked.json().topic.revision)});assert.equal(again.json().alreadyLinked,true);
 assert.equal(again.json().topic.revision,linked.json().topic.revision);
 const stale=await f.upload({topicId:topic.id,expectedRevision:String(topic.revision)});assert.equal(stale.statusCode,409);
});

test('explicit writable folders receive the PDF and topic association together',async t=>{
 const f=await fixture(t),root=await f.connect(),topic=await f.topic();
 const response=await f.upload({rootId:root.id,directory:'nested',topicId:topic.id,expectedRevision:String(topic.revision)});assert.equal(response.statusCode,201,response.body);
 const imported=response.json();assert.equal(imported.root.id,root.id);assert.equal(imported.resource.path,'nested/paper.pdf');assert.equal(imported.resource.name,'paper.pdf');assert.deepEqual(imported.topic.resourceIds,[imported.resource.id]);
 assert.deepEqual(await fs.readFile(path.join(root.path,'nested','paper.pdf')),original);
 assert.equal((await f.app.inject(`/api/workspace/resources?topicId=${topic.id}&group=paper`)).json().total,1);
 await assert.rejects(fs.stat(path.join(f.root,'materials')),{code:'ENOENT'});
 const renamed=await f.upload({rootId:root.id},'alias.pdf');assert.equal(renamed.json().resource.id,imported.resource.id);
});

test('folder permissions, revisions, paths and PDF bytes are validated before publication',async t=>{
 const f=await fixture(t),read=await f.connect('read'),write=await f.connect();
 assert.equal((await f.upload({rootId:read.id})).statusCode,403);
 assert.equal((await f.upload({directory:'nested'})).statusCode,400);
 assert.equal((await f.upload({rootId:write.id,directory:'../escape'})).statusCode,400);
 assert.equal((await f.upload({rootId:write.id,directory:'.hidden'})).statusCode,403);
 assert.equal((await f.upload({expectedHash:'old-hash'})).statusCode,400);
 assert.equal((await f.upload({},'fake.pdf',Buffer.from('<html>not a PDF</html>'))).statusCode,400);
 await fs.symlink(path.join(write.path,'nested'),path.join(write.path,'alias'));
 assert.equal((await f.upload({rootId:write.id,directory:'alias'})).statusCode,403);
 assert.deepEqual(await fs.readdir(read.path),['nested']);assert.deepEqual(await fs.readdir(path.join(write.path,'nested')),[]);
});

test('concurrent library and topic imports publish one resource',async t=>{
 const f=await fixture(t),topic=await f.topic();
 const responses=await Promise.all([f.upload(),f.upload({topicId:topic.id,expectedRevision:String(topic.revision)},'other.pdf')]);
 responses.forEach(response=>assert.equal(response.statusCode,201,response.body));assert.equal(responses[0].json().resource.id,responses[1].json().resource.id);
 const page=(await f.app.inject('/api/workspace/resources')).json();assert.equal(page.total,1);assert.deepEqual(responses[1].json().topic.resourceIds,[page.resources[0].id]);
});

test('archived topics and symlinked managed destinations retain their existing data',async t=>{
 const f=await fixture(t),topic=await f.topic();
 const archived=(await f.app.inject({method:'PATCH',url:`/api/workspace/topics/${topic.id}`,payload:{expectedRevision:topic.revision,archived:true}})).json();
 assert.equal((await f.upload({topicId:topic.id,expectedRevision:String(archived.revision)})).statusCode,409);
 const outside=path.join(f.base,'outside');await fs.mkdir(outside);await fs.symlink(outside,path.join(f.root,'materials'));
 assert.equal((await f.upload()).statusCode,403);assert.deepEqual(await fs.readdir(outside),[]);
});

test('default archive folders reuse a connected writable parent without creating overlapping roots',async t=>{
 const f=await fixture(t),materials=path.join(f.root,'materials');await fs.mkdir(materials);
 const connected=await f.app.inject({method:'POST',url:'/api/workspace/roots',payload:{path:materials,permission:'write'}});assert.equal(connected.statusCode,201,connected.body);await f.service.checkpoint();
 const response=await f.upload();assert.equal(response.statusCode,201,response.body);
 assert.equal(response.json().root.id,connected.json().id);assert.equal(response.json().resource.path,'library/参考文献/paper.pdf');
 assert.equal((await f.app.inject('/api/workspace/roots')).json().roots.length,1);
 assert.deepEqual(await fs.readFile(path.join(materials,'library','参考文献','paper.pdf')),original);
});

test('index scans between uploads keep a writable folder available and permission changes take effect',async t=>{
 const f=await fixture(t),root=await f.connect();
 const first=await f.upload({rootId:root.id,directory:'nested'});assert.equal(first.statusCode,201,first.body);
 await f.app.inject({method:'POST',url:`/api/workspace/roots/${root.id}/scan`,payload:{}});await f.service.checkpoint();
 const second=await f.upload({rootId:root.id,directory:'nested'},'second.pdf',Buffer.from('%PDF-1.4\nsecond contents'));assert.equal(second.statusCode,201,second.body);
 const latest=(await f.app.inject('/api/workspace/roots')).json().roots.find((item:any)=>item.id===root.id);
 await f.app.inject({method:'PATCH',url:`/api/workspace/roots/${root.id}`,payload:{expectedRevision:latest.revision,permission:'read'}});
 const denied=await f.upload({rootId:root.id,directory:'nested'},'third.pdf',Buffer.from('%PDF-1.4\nthird contents'));assert.equal(denied.statusCode,403);
 assert.deepEqual((await fs.readdir(path.join(root.path,'nested'))).sort(),['paper.pdf','second.pdf']);
});
