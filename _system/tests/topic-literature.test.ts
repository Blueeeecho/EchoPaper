import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {registerWorkspaceRoutes} from '../server/workspace/index.ts';
import {arxivId,searchLiterature,downloadLiterature} from '../server/workspace/literature.ts';
import {layoutStore} from '../server/workspace/document-layout.ts';
import type {ResearchTopic} from '../shared/workspace-types.ts';

const bytes=Buffer.from('%PDF-1.4\nfixture');
async function fixture(t:test.TestContext){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'topic-pdf-'));
 await fs.mkdir(path.join(root,'papers'));
 const app=Fastify();await app.register(multipart);
 app.setErrorHandler((error,_request,reply)=>reply.code((error as any).statusCode||500).send({error:(error as Error).message}));
 const service=await registerWorkspaceRoutes(app,root,{watch:false});
 t.after(async()=>{await service.close();await app.close();await fs.rm(root,{recursive:true,force:true});});
 const create=async(title='Question'):Promise<ResearchTopic>=>(await app.inject({method:'POST',url:'/api/workspace/topics',payload:{title}})).json();
 const upload=(topic:ResearchTopic,name='paper.pdf',content=bytes)=>app.inject({
  method:'POST',url:`/api/workspace/topics/${topic.id}/upload?expectedRevision=${topic.revision}`,
  headers:{'content-type':'multipart/form-data; boundary=fixture'},
  payload:Buffer.concat([Buffer.from(`--fixture\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`),content,Buffer.from('\r\n--fixture--\r\n')]),
 });
 return {root,app,service,create,upload};
}

test('PDF import reuses identical content and protects revisions and different same-name originals',async t=>{
 const f=await fixture(t),topic=await f.create();
 const response=await f.upload(topic);assert.equal(response.statusCode,201,response.body);
 const data=response.json();assert.equal(data.reused,false);
 const filename=path.join(f.root,'materials',topic.id,'参考文献','paper.pdf');
 assert.deepEqual(await fs.readFile(filename),bytes);
 assert.equal(data.topic.resourceIds[0],data.resource.id);
 assert.equal((await f.upload(topic,'new.pdf')).statusCode,409);
 for(const name of ['paper.pdf','renamed.pdf']){
  const retry=await f.upload(data.topic,name);assert.equal(retry.statusCode,201,retry.body);
  assert.equal(retry.json().resource.id,data.resource.id);
  assert.equal(retry.json().reused,true);assert.equal(retry.json().alreadyLinked,true);
  assert.equal(retry.json().topic.revision,data.topic.revision);
 }
 assert.equal((await f.upload(data.topic,'paper.pdf',Buffer.from('%PDF-1.4\ndifferent'))).statusCode,409);
 assert.equal((await f.upload(data.topic,'bad.pdf',Buffer.from('html'))).statusCode,400);
 assert.deepEqual(await fs.readdir(path.dirname(filename)),['paper.pdf']);
 const raw=await f.app.inject(`/api/workspace/resources/${data.resource.id}/raw`);
 assert.equal(raw.statusCode,200);assert.deepEqual(raw.rawPayload,bytes);
});

test('cross-topic import links one resource and preserves tags and reading caches',async t=>{
 const f=await fixture(t),first=await f.create('Multi-agent'),second=await f.create('RSI');
 const imported=(await f.upload(first)).json();
 const tagged=await f.app.inject({method:'PATCH',url:`/api/workspace/resources/${imported.resource.id}`,payload:{expectedRevision:imported.resource.revision,tags:['重点']}});
 assert.equal(tagged.statusCode,200);
 const store=layoutStore(f.root);
 await store.writeLayout({version:1,resourceId:imported.resource.id,sourceHash:imported.resource.hash,parsedAt:new Date().toISOString(),pageCount:1,costPages:1,pages:[]});
 await store.mergeTranslations(imported.resource.id,{'saved|translation':'已有译文'},imported.resource.hash);
 const cached=await fs.readFile(path.join(f.root,'workspace/reading-layout',`${imported.resource.id}.translations.json`),'utf8');
 const linked=await f.upload(second,'other-name.pdf');assert.equal(linked.statusCode,201,linked.body);
 assert.equal(linked.json().reused,true);assert.equal(linked.json().alreadyLinked,false);
 assert.equal(linked.json().resource.id,imported.resource.id);
 assert.deepEqual(linked.json().resource.tags,['重点']);
 assert.deepEqual(linked.json().topic.resourceIds,[imported.resource.id]);
 assert.equal((await f.app.inject('/api/workspace/resources')).json().total,1);
 assert.equal(await fs.readFile(path.join(f.root,'workspace/reading-layout',`${imported.resource.id}.translations.json`),'utf8'),cached);
 await assert.rejects(fs.stat(path.join(f.root,'materials',second.id)),{code:'ENOENT'});
});

test('deduplication verifies current original bytes before reusing an indexed hash',async t=>{
 const f=await fixture(t),first=await f.create(),second=await f.create('RSI');
 const imported=(await f.upload(first)).json();
 const filename=path.join(f.root,'materials',first.id,'参考文献','paper.pdf');
 const changed=Buffer.from('%PDF-1.4\nexternally changed');await fs.writeFile(filename,changed);
 const response=await f.upload(second);assert.equal(response.statusCode,201,response.body);
 assert.equal(response.json().reused,false);assert.notEqual(response.json().resource.id,imported.resource.id);
 assert.deepEqual(await fs.readFile(filename),changed);
});

test('legacy duplicate copies prefer a valid cached resource for a new topic',async t=>{
 const f=await fixture(t),first=await f.create(),second=await f.create('RSI');
 const initial=(await f.upload(first)).json();
 const backup=path.join(f.root,'legacy-backup');await fs.mkdir(backup);await fs.writeFile(path.join(backup,'copy.pdf'),bytes);
 const connected=await f.app.inject({method:'POST',url:'/api/workspace/roots',payload:{path:backup}});
 assert.equal(connected.statusCode,201,connected.body);await f.service.checkpoint();
 const resources=(await f.app.inject('/api/workspace/resources')).json().resources;
 const cached=resources.find((resource:any)=>resource.id!==initial.resource.id);assert.ok(cached);
 const store=layoutStore(f.root);
 await store.writeLayout({version:1,resourceId:cached.id,sourceHash:cached.hash,parsedAt:new Date().toISOString(),pageCount:1,costPages:1,pages:[]});
 await store.mergeTranslations(cached.id,{'saved|translation':'已有译文'},cached.hash);
 const result=await f.upload(second);assert.equal(result.statusCode,201,result.body);
 assert.equal(result.json().resource.id,cached.id);assert.equal(result.json().reused,true);
 // Reimporting into the first topic retains its existing identity and annotations.
 const original=await f.upload(initial.topic);assert.equal(original.json().resource.id,initial.resource.id);
});

test('concurrent imports into different topics share one resource',async t=>{
 const f=await fixture(t),first=await f.create(),second=await f.create('RSI');
 const responses=await Promise.all([f.upload(first),f.upload(second,'renamed.pdf')]);
 for(const response of responses)assert.equal(response.statusCode,201,response.body);
 assert.equal(responses[0].json().resource.id,responses[1].json().resource.id);
 assert.deepEqual(responses.map(response=>response.json().reused).sort(),[false,true]);
 assert.equal((await f.app.inject('/api/workspace/resources')).json().total,1);
});

test('an identical retry can adopt an original saved before catalog publication',async t=>{
 const f=await fixture(t),topic=await f.create();
 const directory=path.join(f.root,'materials',topic.id,'参考文献');await fs.mkdir(directory,{recursive:true});
 const filename=path.join(directory,'paper.pdf');await fs.writeFile(filename,bytes);
 const inode=(await fs.stat(filename)).ino;
 const result=await f.upload(topic);assert.equal(result.statusCode,201,result.body);
 assert.equal((await fs.stat(filename)).ino,inode);
 assert.equal(result.json().resource.hash.length,64);
 assert.equal((await f.upload(result.json().topic)).json().resource.id,result.json().resource.id);
});

test('source metadata and PDF validation',async()=>{
 assert.throws(()=>arxivId('../local'));
 const papers=await searchLiterature('test',(async()=>new Response('<feed><entry><id>https://arxiv.org/abs/2401.12345</id><title>Source</title><author><name>Author</name></author></entry></feed>')) as typeof fetch);
 assert.equal(papers[0].authors[0],'Author');
 await assert.rejects(downloadLiterature('2401.12345',(async()=>new Response('HTML')) as typeof fetch),/PDF/);
});

test('display titles survive scanning and tag edits while preserving filenames and translation caches',async t=>{
 const f=await fixture(t),topic=await f.create();
 const uploaded=(await f.upload(topic,'01_official.pdf')).json(),id=uploaded.resource.id;
 const store=layoutStore(f.root);
 await store.writeLayout({version:1,resourceId:id,sourceHash:uploaded.resource.hash,parsedAt:new Date().toISOString(),pageCount:1,costPages:1,pages:[]});
 await store.mergeTranslations(id,{'saved|translation':'已有译文'},uploaded.resource.hash);
 const cacheFile=path.join(f.root,'workspace/reading-layout',`${id}.translations.json`),before=await fs.readFile(cacheFile,'utf8');
 const tagged=(await f.app.inject({method:'PATCH',url:`/api/workspace/resources/${id}`,payload:{expectedRevision:uploaded.resource.revision,tags:['已读']}})).json();
 const title='Debate or Vote: Which Yields Better Decisions?';
 const renamed=await f.app.inject({method:'PATCH',url:`/api/workspace/resources/${id}`,payload:{expectedRevision:tagged.revision,title}});
 assert.equal(renamed.statusCode,200,renamed.body);
 const resource=renamed.json();assert.equal(resource.title,title);assert.equal(resource.name,'01_official.pdf');
 assert.equal(resource.hash,uploaded.resource.hash);assert.deepEqual(resource.tags,['已读']);
 const results=(await f.app.inject('/api/workspace/resources?q=Debate%20Vote')).json();
 assert.equal(results.total,1);assert.equal(results.resources[0].searchMatch.source,'metadata');
 assert.equal((await f.app.inject({method:'PATCH',url:`/api/workspace/resources/${id}`,payload:{expectedRevision:tagged.revision,title:'stale'}})).statusCode,409);
 const invalid=await f.app.inject({method:'PATCH',url:`/api/workspace/resources/${id}`,payload:{expectedRevision:resource.revision,title:[],tags:['invalid']}});
 assert.equal(invalid.statusCode,400);
 await f.app.inject({method:'POST',url:`/api/workspace/roots/${resource.rootId}/scan`,payload:{}});await f.service.checkpoint();
 const scanned=(await f.app.inject(`/api/workspace/resources/${id}`)).json();assert.equal(scanned.title,title);assert.deepEqual(scanned.tags,['已读']);
 const updated=(await f.app.inject({method:'PATCH',url:`/api/workspace/resources/${id}`,payload:{expectedRevision:scanned.revision,tags:['重点']}})).json();
 assert.equal(updated.title,title);
 assert.equal(await fs.readFile(cacheFile,'utf8'),before);
 const cleared=(await f.app.inject({method:'PATCH',url:`/api/workspace/resources/${id}`,payload:{expectedRevision:updated.revision,title:null}})).json();
 assert.equal(cleared.title,undefined);assert.deepEqual(cleared.tags,['重点']);
});


test('literature views collapse identical legacy PDFs before counting and pagination',async t=>{
 const f=await fixture(t),topic=await f.create();
 const original=(await f.upload(topic,'A meaningful paper title.pdf')).json();
 const backup=path.join(f.root,'archive-copy');await fs.mkdir(backup);await fs.writeFile(path.join(backup,'01_official.pdf'),bytes);
 await f.app.inject({method:'POST',url:'/api/workspace/roots',payload:{path:backup}});await f.service.checkpoint();
 const all=(await f.app.inject('/api/workspace/resources?group=paper')).json();assert.equal(all.total,2);
 const unique=(await f.app.inject('/api/workspace/resources?group=paper&deduplicate=true&limit=1')).json();
 assert.equal(unique.total,1);assert.equal(unique.groupCounts.paper,1);
 assert.equal(unique.resources[0].id,original.resource.id);
});


test('normal PDF upload and directory scan extract the paper title from generic filenames',async t=>{
 const f=await fixture(t),topic=await f.create();
 const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]);
 const title='Reliable Collaboration with Shared Evidence';pdf.setTitle(title);
 const font=await pdf.embedFont(StandardFonts.HelveticaBold);page.drawText(title,{x:40,y:700,size:18,font});
 const content=Buffer.from(await pdf.save());
 const response=await f.upload(topic,'official.pdf',content);assert.equal(response.statusCode,201,response.body);
 assert.equal(response.json().resource.title,title);
 const folder=path.join(f.root,'external-papers');await fs.mkdir(folder);await fs.writeFile(path.join(folder,'CV-001.pdf'),content);
 const connected=await f.app.inject({method:'POST',url:'/api/workspace/roots',payload:{path:folder}});assert.equal(connected.statusCode,201);
 await f.service.checkpoint();
 const result=(await f.app.inject('/api/workspace/resources?q=CV-001')).json();
 assert.equal(result.resources[0].title,title);
});


test('paper titles determine global order before pagination regardless of filename prefixes',async t=>{
 const f=await fixture(t),topic=await f.create();
 const first=(await f.upload(topic,'02_First.pdf')).json();
 const second=(await f.upload(first.topic,'2_Second.pdf',Buffer.from('%PDF-1.4\nsecond'))).json();
 for(const [resource,title] of [[first.resource,'Zebra Reasoning'],[second.resource,'Alpha Reasoning']] as const){
  const response=await f.app.inject({method:'PATCH',url:`/api/workspace/resources/${resource.id}`,payload:{title,expectedRevision:resource.revision}});
  assert.equal(response.statusCode,200,response.body);
 }
 const all=(await f.app.inject('/api/workspace/resources?group=paper&deduplicate=true')).json();
 assert.deepEqual(all.resources.map((resource:any)=>resource.title),['Alpha Reasoning','Zebra Reasoning']);
 const paged=(await f.app.inject('/api/workspace/resources?group=paper&deduplicate=true&offset=1&limit=1')).json();
 assert.equal(paged.resources[0].title,'Zebra Reasoning');
});
