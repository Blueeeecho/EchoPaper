import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {parseBibTeX,registerReferenceRoutes}from'../server/references.ts';
async function fixture(){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-references-')),root=path.join(workspace,'papers/Alpha');await fs.mkdir(path.join(root,'manuscript'),{recursive:true});await fs.mkdir(path.join(root,'notes'),{recursive:true});await fs.writeFile(path.join(root,'project.json'),JSON.stringify({id:'Alpha'}));
 await fs.writeFile(path.join(root,'manuscript/refs.bib'),'@article{existing,title={Existing},year={2025}}');await fs.writeFile(path.join(root,'manuscript/main.tex'),'\\label{sec:one}\n% \\label{hidden}\n\\section{Intro}\\label{sec:one}');await fs.writeFile(path.join(root,'notes/private.bib'),'@article{private,title={Do not index}}');
 const app=Fastify({bodyLimit:4*1024*1024});app.setErrorHandler((e:any,_q,r)=>r.code(e.statusCode||500).send({error:e.message}));await registerReferenceRoutes(app,workspace);return{app,root,workspace,cleanup:async()=>{await app.close();await fs.rm(workspace,{recursive:true,force:true});}};
}
test('BibTeX parentheses, protected quotes and comments retain valid entry boundaries',()=>{
 const input=`% @article{skip,title={Hidden}}
@comment{He said " once}
@article(paren,title={A (parenthesis) and a " quote},author="{A} and {B}",year=2026)
@book{concat,title="A " # {Nested {Title}},year={2025}}
`;
 const result=parseBibTeX(input,'refs.bib');assert.deepEqual(result.warnings,[]);assert.deepEqual(result.entries.map(e=>e.key),['paren','concat']);assert.equal(result.entries[0].title,'A (parenthesis) and a " quote');assert.equal(result.entries[1].title,'A Nested Title');assert.equal(result.entries[0].line,3);
 for(const invalid of ['@article{x,title={a} year=2025}','@article{x,title={a},title={b}}','@article{x,title=}','@article{x,title="unclosed}'])assert.ok(parseBibTeX(invalid,'r.bib').warnings.length,invalid);
});
test('reference GET indexes registered source and reports duplicate labels without indexing notes',async()=>{
 const{app,cleanup}=await fixture();try{const response=await app.inject('/api/projects/Alpha/references');assert.equal(response.statusCode,200,response.body);const data=response.json();assert.deepEqual(data.entries.map((e:any)=>e.key),['existing']);assert.equal(data.labels.length,2);assert.ok(data.warnings.some((w:string)=>w.includes('sec:one')&&w.includes('重复')));}finally{await cleanup();}
});
test('BibTeX import validation accepts complex entries, rejects duplicates and never writes source',async()=>{
 const{app,root,cleanup}=await fixture();try{
  const original=await fs.readFile(path.join(root,'manuscript/refs.bib'),'utf8');const call=(content:unknown)=>app.inject({method:'POST',url:'/api/projects/Alpha/references/validate',payload:{content}});
  const valid=await call('@article(new,title={A (nested) title},author="A and B",year=2026)');assert.equal(valid.statusCode,200,valid.body);assert.equal(valid.json().entries[0].key,'new');
  assert.equal((await call('@article{existing,title={Duplicate}}')).statusCode,409);assert.equal((await call('@article{same,title={one}}\n@article{same,title={two}}')).statusCode,409);
  for(const content of [null,{},'@article{x,title={unfinished}','@article{x,title={a} year=2025}','@article{x,title={a},title={b}}','中文'.repeat(400000)])assert.equal((await call(content)).statusCode,400);
  assert.equal(await fs.readFile(path.join(root,'manuscript/refs.bib'),'utf8'),original);
 }finally{await cleanup();}
});
test('reference APIs isolate projects and do not follow symlinked bibliographies',async()=>{
 const{app,root,cleanup}=await fixture();try{
  await fs.symlink('/etc/hosts',path.join(root,'manuscript/outside.bib'));const data=(await app.inject('/api/projects/Alpha/references')).json();assert.equal(data.entries.length,1);
  assert.equal((await app.inject('/api/projects/Missing/references')).statusCode,404);assert.equal((await app.inject('/api/projects/..%2FAlpha/references')).statusCode,400);
 }finally{await cleanup();}
});
