import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {registerWorkspaceRoutes} from '../server/workspace/index.ts';
import {academicRoute,academicPath} from '../src/academic/navigation.ts';

test('research basis and notes and append-only progress persist with revision conflict protection',async()=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'echopaper-research-'));
 await fs.mkdir(path.join(root,'papers'));
 const make=async()=>{const app=Fastify();app.setErrorHandler((e,_req,reply)=>reply.code((e as Error&{statusCode?:number}).statusCode||500).send({error:(e as Error).message}));const service=await registerWorkspaceRoutes(app,root,{watch:false});await app.ready();return{app,async close(){await service.close();await app.close();}};};
 let runtime=await make();
 try{
  const created=await runtime.app.inject({method:'POST',url:'/api/workspace/topics',payload:{title:'Isolated validation fixture',description:'Question retained',stage:'ideation'}});assert.equal(created.statusCode,201);let topic=created.json();const url=`/api/workspace/topics/${topic.id}`;
  assert.equal(topic.researchBasis,undefined);
  const original={...topic};
  const basis=await runtime.app.inject({method:'PATCH',url,payload:{expectedRevision:topic.revision,researchBasis:'拟解决；原文待核对'}});assert.equal(basis.statusCode,200);topic=basis.json();
  for(const key of ['description','paperIds','resourceIds','presentationIds','archived'])assert.deepEqual(topic[key],original[key]);
  const rejected=await runtime.app.inject({method:'PATCH',url,payload:{expectedRevision:original.revision,researchBasis:'do not overwrite'}});assert.equal(rejected.statusCode,409);
  const notes=await runtime.app.inject({method:'PATCH',url,payload:{expectedRevision:topic.revision,stage:'experiments',experimentPlan:'Control and treatment; no results claimed.'}});assert.equal(notes.statusCode,200);topic=notes.json();
  const invalid=await runtime.app.inject({method:'PATCH',url,payload:{expectedRevision:topic.revision,stage:'invented',resultSummary:'must not save'}});assert.equal(invalid.statusCode,400);
  const stale=await runtime.app.inject({method:'PATCH',url,payload:{expectedRevision:1,experimentPlan:'must not overwrite'}});assert.equal(stale.statusCode,409);
  const results=await runtime.app.inject({method:'PATCH',url,payload:{expectedRevision:topic.revision,resultSummary:'Pending evidence; numerical fields left blank.'}});topic=results.json();assert.equal(results.statusCode,200);assert.equal(topic.stage,'experiments');assert.ok(topic.experimentPlan.includes('Control'));
  const revision=topic.revision;
  const concurrent=await Promise.all(['Entry A','Entry B'].map(content=>runtime.app.inject({method:'POST',url:url+'/progress',payload:{expectedRevision:revision,content,nextStep:'Collect evidence'}})));
  assert.deepEqual(concurrent.map(r=>r.statusCode).sort(),[201,409]);topic=concurrent.find(r=>r.statusCode===201)!.json();assert.equal(topic.progressEntries.length,1);assert.ok(topic.progressEntries[0].id);assert.ok(Date.parse(topic.progressEntries[0].createdAt));
  const empty=await runtime.app.inject({method:'POST',url:url+'/progress',payload:{expectedRevision:topic.revision,content:' '}});assert.equal(empty.statusCode,400);
  const rename=await runtime.app.inject({method:'PATCH',url,payload:{expectedRevision:topic.revision,title:'Renamed fixture',progressEntries:[]}});topic=rename.json();assert.equal(topic.progressEntries.length,1);assert.equal(topic.description,'Question retained');
  await runtime.close();runtime=await make();const stored=(await runtime.app.inject({method:'GET',url:'/api/workspace/topics'})).json().topics[0];assert.equal(stored.researchBasis,'拟解决；原文待核对');assert.equal(stored.title,'Renamed fixture');assert.equal(stored.progressEntries.length,1);assert.equal(stored.resultSummary,topic.resultSummary);assert.equal(stored.experimentPlan,topic.experimentPlan);
 }finally{await runtime.close();await fs.rm(root,{recursive:true,force:true});}
});

test('research stage links preserve topic context and reject malformed paths',()=>{
 for(const section of ['topics','experiments','results','progress']){const value=`/${section}?topic=research-01`;assert.equal(academicPath(academicRoute(value)),value);}
 assert.equal(academicRoute('/experiments/../../secret').section,'home');
 assert.equal(academicRoute('/progress?topic=../secret').topicId,undefined);
});

import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import TopicEditComparison from '../src/academic/TopicEditComparison';
import {topicEditorPayload} from '../src/academic/topic-editor';
import {RESEARCH_BASIS_TEMPLATE} from '../shared/research-basis.ts';
import {createProject} from '../server/projects.ts';
import {createApp} from '../server/index.ts';
import type {BuildService} from '../shared/types.ts';
test('basis template distinguishes evidence and editor retains all three conflict values',()=>{
 const base={id:'x',title:'t',description:'d',paperIds:[],presentationIds:[],resourceIds:[],archived:false,revision:1,createdAt:'',updatedAt:'',researchBasis:'原值'};
 const draft={...base,researchBasis:'本地'};
 assert.equal(topicEditorPayload(draft,base).researchBasis,'本地');
 const html=renderToStaticMarkup(createElement(TopicEditComparison,{baseline:base,latest:{...base,revision:2,researchBasis:'服务器'},draft,paperNames:{},deckNames:{},onDownload(){},onLoad(){}}));
 for(const text of ['原值','本地','服务器'])assert.ok(html.includes(text));
 for(const text of ['可证伪','负结果','未知','拟解决','已验证','原文'])assert.ok(RESEARCH_BASIS_TEMPLATE.includes(text));
});
test('new and imported papers get basis; explicit file creation is CAS protected and never builds',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'basis-papers-'));let calls=0;
 const builds={async request(){calls++;throw Error('must not build');},async close(){},async list(){return [];}} as unknown as BuildService;
 let app:Awaited<ReturnType<typeof createApp>>|undefined;
 try{
  await fs.mkdir(path.join(root,'shared/templates/empty'),{recursive:true});await fs.writeFile(path.join(root,'shared/templates/empty/main.tex'),'\\documentclass{article}\n\\begin{document}x\\end{document}');
  await fs.mkdir(path.join(root,'incoming'));await fs.writeFile(path.join(root,'incoming/main.tex'),'\\documentclass{article}\n\\begin{document}import\\end{document}');
  await createProject(root,{id:'new-paper',title:'new',template:'empty'});await createProject(root,{id:'import-paper',title:'import',importPath:'incoming'});
  for(const id of ['new-paper','import-paper'])assert.equal(await fs.readFile(path.join(root,'papers',id,'notes/research-basis.md'),'utf8'),RESEARCH_BASIS_TEMPLATE);
  const manuscript=await fs.readFile(path.join(root,'papers/new-paper/manuscript/main.tex'));
  await fs.rm(path.join(root,'papers/new-paper/notes/research-basis.md'));
  app=await createApp({workspaceRoot:root,buildService:builds,watch:false});
  const url='/api/projects/new-paper/file';
  assert.equal((await app.inject(url+'?path=notes/research-basis.md')).statusCode,404);
  const payload={path:'notes/research-basis.md',content:RESEARCH_BASIS_TEMPLATE,expectedHash:null};
  const created=await app.inject({method:'PUT',url,payload});assert.equal(created.statusCode,200,created.body);
  assert.equal((await app.inject({method:'PUT',url,payload:{...payload,content:'overwrite'}})).statusCode,409);
  const read=(await app.inject(url+'?path=notes/research-basis.md')).json();assert.equal(read.content,RESEARCH_BASIS_TEMPLATE);
  assert.equal((await app.inject({method:'PUT',url,payload:{...payload,content:'拟解决',expectedHash:read.hash}})).statusCode,200);
  assert.deepEqual(await fs.readFile(path.join(root,'papers/new-paper/manuscript/main.tex')),manuscript);assert.equal(calls,0);
 }finally{await app?.close();await fs.rm(root,{recursive:true,force:true});}
});
test('shared Markdown matches template; basis navigation never saves or builds',async()=>{
 assert.equal(await fs.readFile(new URL('../shared/research-basis-template.md',import.meta.url),'utf8'),RESEARCH_BASIS_TEMPLATE);
 const source=await fs.readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
 const action=source.split('async function openResearchBasis(){')[1].split('async function compile()')[0];
 assert.ok(!action.includes('await save('));assert.ok(!action.includes('await openFile('));assert.ok(!action.includes('/builds'));assert.ok(!action.includes('setTargetId('));assert.ok(action.includes('expectedHash:null'));assert.ok(action.includes('window.confirm'));
 assert.ok(source.includes('if(path===RESEARCH_BASIS_PATH)return;'));
});
