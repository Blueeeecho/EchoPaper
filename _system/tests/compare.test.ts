import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import {registerCompareRoutes} from '../server/compare.ts';
import type{Build,BuildService}from'../shared/types.ts';
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-compare-')),root=path.join(workspace,'papers/Alpha');await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'project.json'),JSON.stringify({id:'Alpha'}));
 const states:Record<string,Record<string,string|Buffer>>={left:{'main.tex':'before','gone.txt':'removed','common.txt':'same','pic.png':Buffer.from([1,2]),'binary.tex':Buffer.from([1,0,2])},right:{'main.tex':'after','added.tex':'new','common.txt':'same','pic.png':Buffer.from([1,3]),'binary.tex':Buffer.from([1,0,3])}};
 for(const[id,files]of Object.entries(states)){const folder=path.join(root,'build',id);await fs.mkdir(path.join(folder,'source'),{recursive:true});await fs.writeFile(path.join(folder,'source-manifest.json'),JSON.stringify(Object.entries(files).map(([name,bytes])=>({path:name,sha256:hash(bytes)}))));for(const[name,bytes]of Object.entries(files))await fs.writeFile(path.join(folder,'source',name),bytes);}
 const build=(id:string,extra:Partial<Build>={}):Build=>({id,projectId:'Alpha',targetId:'main',status:'succeeded',pdf:'main.pdf',createdAt:new Date().toISOString(),log:'',diagnostics:[],...extra});
 const builds:Record<string,Build>={left:build('left'),right:build('right'),foreign:build('foreign',{projectId:'Beta'}),supp:build('supp',{targetId:'supplement'}),failed:build('failed',{status:'failed'})};
 const app=Fastify();app.setErrorHandler((e:any,_q,r)=>r.code(e.statusCode||500).send({error:e.message}));await registerCompareRoutes(app,workspace,{get:async(id:string)=>{if(!builds[id])throw Object.assign(new Error('missing build'),{statusCode:404});return builds[id];}} as BuildService);
 const endpoint='/api/projects/Alpha/compare?left=left&right=right';
 return{app,root,workspace,endpoint,cleanup:async()=>{await app.close();await fs.rm(workspace,{recursive:true,force:true});}};
}
test('comparison lists added, removed, modified and unchanged source files and reads frozen versions',async()=>{
 const{app,endpoint,cleanup}=await fixture();try{
  const response=await app.inject(endpoint);assert.equal(response.statusCode,200,response.body);const data=response.json();assert.equal(data.unchanged,1);assert.deepEqual(data.files.map((f:any)=>[f.path,f.change]),[['added.tex','added'],['binary.tex','modified'],['gone.txt','removed'],['main.tex','modified'],['pic.png','modified']]);
  const modified=(await app.inject(endpoint+'&file=main.tex')).json();assert.equal(modified.before,'before');assert.equal(modified.after,'after');
  const added=(await app.inject(endpoint+'&file=added.tex')).json();assert.equal(added.before,'');assert.equal(added.after,'new');
  const removed=(await app.inject(endpoint+'&file=gone.txt')).json();assert.equal(removed.before,'removed');assert.equal(removed.after,'');
  assert.equal((await app.inject(endpoint+'&file=pic.png')).json().binary,true);assert.equal((await app.inject(endpoint+'&file=binary.tex')).json().binary,true);
 }finally{await cleanup();}
});
test('comparison rejects cross-project/target/failed builds and query traversal',async()=>{
 const{app,endpoint,cleanup}=await fixture();try{
  for(const other of ['foreign','supp','failed'])assert.equal((await app.inject('/api/projects/Alpha/compare?left=left&right='+other)).statusCode,400);
  assert.equal((await app.inject(endpoint+'&file=..%2Fprivate.tex')).statusCode,400);assert.equal((await app.inject(endpoint+'&file=unknown.tex')).statusCode,404);assert.equal((await app.inject('/api/projects/Alpha/compare?left=..%2Fleft&right=right')).statusCode,400);
 }finally{await cleanup();}
});
test('frozen text hash mismatch and symlink reads fail without returning contents',async()=>{
 const{app,root,endpoint,cleanup}=await fixture();try{
  const source=path.join(root,'build/left/source/main.tex');await fs.writeFile(source,'tampered snapshot');const mismatch=await app.inject(endpoint+'&file=main.tex');assert.equal(mismatch.statusCode,409);assert.ok(!mismatch.body.includes('tampered snapshot'));
  await fs.rm(source);await fs.symlink('/etc/hosts',source);assert.equal((await app.inject(endpoint+'&file=main.tex')).statusCode,403);
 }finally{await cleanup();}
});
test('malformed, duplicate, oversized and excessive manifests report controlled errors',async()=>{
 const{app,root,endpoint,cleanup}=await fixture();try{
  const file=path.join(root,'build/left/source-manifest.json');const valid={path:'main.tex',sha256:hash('before')};
  for(const content of ['{broken',JSON.stringify([valid,valid]),JSON.stringify([null]),JSON.stringify([{...valid,path:'../private.tex'}]),JSON.stringify(Array.from({length:20001},()=>valid))]){await fs.writeFile(file,content);const response=await app.inject(endpoint);assert.equal(response.statusCode,409,response.body);}
  await fs.writeFile(file,' '.repeat(8*1024*1024+1));assert.equal((await app.inject(endpoint)).statusCode,413);
 }finally{await cleanup();}
});
