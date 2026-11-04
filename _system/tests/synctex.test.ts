import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { parseSyncTeX, indexSyncTeX, syncForward, syncInverse, registerSyncRoutes } from '../server/synctex.ts';
import type { Build, BuildService } from '../shared/types.ts';
const raw = `SyncTeX Version:1
Input:1:/old/workspace/papers/Alpha/build/b-unit/source/main.tex
Input:2:/old/workspace/papers/Alpha/build/b-unit/source/tex/body.tex
Input:3:/usr/texmf/article.cls
Input:4:/etc/private.tex
Output:pdf
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
(1,10:6578176,13156352:6578176,657818,131564
)
(2,4:6578176,19734528:13156352,657818,131564
)
g2,4:7235994,19734528
(3,100:6578176,26312704:13156352,657818,131564
)
(4,1:6578176,26312704:13156352,657818,131564
)
}1
Postamble:
Count:4
Post scriptum:
`;
test('forward word matching retains the end of a long source line across PDF pages',()=>{
 const nodes=Array.from({length:60},(_,i)=>({path:'manuscript/body.tex',sourceLine:6,page:Math.floor(i/30)+1,x:.1,y:.05+(i%30)*.025,width:.35,height:.01,quality:0}));
 const result=syncForward({nodes,files:['manuscript/body.tex'],unmapped:[]},'manuscript/body.tex',6);
 assert.equal(result.locations.length,60);assert.equal(result.locations.at(-1)?.page,2);
 assert.ok(result.locations.at(-1)!.y>.7);
});
test('inverse retains nearby source candidates when overlapping input records disagree',()=>{
 const nodes=[{path:'manuscript/right.tex',sourceLine:12,page:1,x:.104,y:.3,width:.006,height:.012,quality:2},{path:'manuscript/left.tex',sourceLine:6,page:1,x:.1,y:.3,width:.4,height:.012,quality:0}];
 const result=syncInverse({nodes,files:nodes.map(n=>n.path),unmapped:[]},1,.104,.305);
 assert.ok(result.alternatives?.some(candidate=>candidate.path==='manuscript/left.tex'&&candidate.line===6));
 assert.ok(result.alternatives!.length<=8);
});
const index = () => indexSyncTeX(parseSyncTeX(raw),'b-unit','manuscript',new Set(['main.tex','tex/body.tex','article.cls']),[{width:612,height:792}]);
test('v1 positions apply scaled-point units and keep local source mappings', () => {
  const data=index();assert.deepEqual(data.files,['manuscript/main.tex','manuscript/tex/body.tex']);
  const result=syncForward(data,'manuscript/main.tex',10);assert.equal(result.lineDistance,0);
  assert.ok(Math.abs(result.locations[0].x-100/612)<1e-8);assert.ok(Math.abs(result.locations[0].y-190/792)<1e-6);
  const point=result.locations[0], inverse=syncInverse(data,1,point.x+point.width/2,point.y+point.height/2);
  assert.equal(inverse.path,'manuscript/main.tex');assert.equal(inverse.line,10);assert.equal(syncForward(data,'manuscript/tex/body.tex',3).lineDistance,1);
});
test('unknown formats, post-transforms and unsafe inputs never yield forged paths', () => {
  assert.throws(()=>parseSyncTeX(raw.replace('Version:1','Version:9')),/格式/);assert.throws(()=>parseSyncTeX(raw+'Magnification:2\n'),/变换/);
  assert.throws(()=>parseSyncTeX(raw.replace('Content:','Content:\n<1')),/表单/);assert.throws(()=>syncForward(index(),'../../private.tex',4),/定位记录/);
  const data=indexSyncTeX(parseSyncTeX(raw.replace('/source/main.tex','/source/../main.tex')),'b-unit','manuscript',new Set(['main.tex','tex/body.tex']),[{width:612,height:792}]);assert.ok(!data.files.includes('manuscript/main.tex'));
});
test('generated bibliography regions and distant whitespace do not jump to unrelated source',()=>{
  const withGenerated=raw.replace('Input:4:/etc/private.tex','Input:5:\nInput:4:/etc/private.tex').replace('}1\nPostamble:', '(5,2:6578176,26312704:13156352,657818,131564\n)\n}1\nPostamble:');
  const data=indexSyncTeX(parseSyncTeX(withGenerated),'b-unit','manuscript',new Set(['main.tex','tex/body.tex']),[{width:612,height:792}]);
  assert.throws(()=>syncInverse(data,1,150/612,395/792),/自动生成内容/);
  assert.throws(()=>syncInverse(index(),1,.95,.95),/附近没有可靠/);
  const body=syncInverse(data,1,150/612,295/792);assert.equal(body.path,'manuscript/tex/body.tex');assert.equal(body.line,4);
});
function tinyPdf() {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>','<< /Length 0 >>\nstream\n\nendstream'];
  let output='%PDF-1.4\n';const offsets=[0];objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(output);output+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return output;
}
async function fixture() {
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-synctex-')),root=path.join(workspace,'papers/Alpha'),buildRoot=path.join(root,'build/b-unit');
  await fs.mkdir(path.join(buildRoot,'artifacts'),{recursive:true});await fs.mkdir(path.join(root,'manuscript/tex'),{recursive:true});
  await fs.writeFile(path.join(root,'project.json'),JSON.stringify({id:'Alpha',targets:[{id:'main',main:'manuscript/main.tex',label:'main'}]}));
  await fs.writeFile(path.join(root,'manuscript/main.tex'),'source');await fs.writeFile(path.join(root,'manuscript/tex/body.tex'),'source');
  await fs.writeFile(path.join(buildRoot,'compile-config.json'),JSON.stringify({prefix:'manuscript',main:'main.tex',targetMain:'manuscript/main.tex'}));
  await fs.writeFile(path.join(buildRoot,'source-manifest.json'),JSON.stringify([{path:'main.tex'},{path:'tex/body.tex'}]));
  await fs.writeFile(path.join(buildRoot,'artifacts/main.synctex.gz'),gzipSync(raw));await fs.writeFile(path.join(buildRoot,'artifacts/main.pdf'),tinyPdf());
  const build:Build={id:'b-unit',projectId:'Alpha',targetId:'main',status:'succeeded',createdAt:new Date().toISOString(),log:'',diagnostics:[],pdf:'main.pdf',stale:true};
  const app=Fastify();app.setErrorHandler((e:any,_q,r)=>r.code(e.statusCode||500).send({error:e.message}));
  await registerSyncRoutes(app,workspace,{get:async(id:string)=>{if(id!==build.id)throw Object.assign(new Error('missing'),{statusCode:404});return build;}} as BuildService);
  return {app,workspace,root,buildRoot,cleanup:async()=>{await app.close();await fs.rm(workspace,{recursive:true,force:true});}};
}
test('APIs expose capability, validate queries and warn on stale source',async()=>{
  const {app,cleanup}=await fixture();try {
    const cap=await app.inject('/api/builds/b-unit/sync');assert.equal(cap.statusCode,200,cap.body);assert.equal(cap.json().available,true,cap.body);assert.equal(cap.json().stale,true);
    const f=await app.inject('/api/builds/b-unit/sync/forward?path=manuscript/main.tex&line=10');assert.equal(f.statusCode,200,f.body);assert.match(f.json().warning,/源码已变化/);
    const b=await app.inject('/api/builds/b-unit/sync/inverse?page=1&x=0.25&y=0.25');assert.equal(b.statusCode,200,b.body);assert.equal(b.json().path,'manuscript/main.tex');assert.ok(!b.body.includes('/old/workspace'));
    for(const url of ['/sync/forward?path=../private.tex&line=4','/sync/forward?path=manuscript/main.tex&line=-1','/sync/inverse?page=0&x=0&y=0','/sync/inverse?page=1&x=2&y=0','/sync/inverse?page=1&x=NaN&y=0'])assert.equal((await app.inject('/api/builds/b-unit'+url)).statusCode,400,url);
  }finally{await cleanup();}
});
test('malformed and symlinked metadata cannot open arbitrary files',async()=>{
  const {app,buildRoot,cleanup}=await fixture();try {
    await fs.rm(path.join(buildRoot,'artifacts/main.synctex.gz'));await fs.symlink('/etc/hosts',path.join(buildRoot,'artifacts/main.synctex.gz'));assert.equal((await app.inject('/api/builds/b-unit/sync')).statusCode,403);
    await fs.rm(path.join(buildRoot,'artifacts/main.synctex.gz'));await fs.writeFile(path.join(buildRoot,'artifacts/main.synctex.gz'),gzipSync('bad data'));
    const cap=(await app.inject('/api/builds/b-unit/sync')).json();assert.equal(cap.available,false);assert.match(cap.reason,/格式/);assert.equal((await app.inject('/api/builds/b-unit/sync/forward?path=manuscript/main.tex&line=10')).statusCode,422);
  }finally{await cleanup();}
});
test('decompression limit and invalid target prefix fail closed',async()=>{
  const {app,buildRoot,cleanup}=await fixture();try {
    await fs.writeFile(path.join(buildRoot,'artifacts/main.synctex.gz'),gzipSync('x'.repeat(17*1024*1024)));
    const capped=await app.inject('/api/builds/b-unit/sync/forward?path=manuscript/main.tex&line=10');assert.equal(capped.statusCode,422,capped.body);assert.match(capped.json().error,/16 MB/);
    await fs.writeFile(path.join(buildRoot,'compile-config.json'),JSON.stringify({prefix:'notes',main:'main.tex',targetMain:'notes/main.tex'}));
    const unsafe=await app.inject('/api/builds/b-unit/sync/forward?path=manuscript/main.tex&line=10');assert.equal(unsafe.statusCode,422);assert.match(unsafe.json().error,/配置无效/);
  }finally{await cleanup();}
});

const abstractProse = 'Local pipelines compare repeated analysis with robust evidence across tasks.';
const wordQuery = (extra:Record<string,string>={}) => new URLSearchParams({word:'analysis',before:'Local pipelines compare repeated ',after:' with robust evidence across tasks.',...extra});
async function wordFixture() {
  const setup=await fixture();
  await fs.mkdir(path.join(setup.buildRoot,'source/tex'),{recursive:true});
  await fs.writeFile(path.join(setup.buildRoot,'source/main.tex'),'\\input{tex/abstract}\n');
  await fs.writeFile(path.join(setup.buildRoot,'source/tex/body.tex'),'Unrelated body content.\n');
  await fs.writeFile(path.join(setup.buildRoot,'source/tex/abstract.tex'),`\\begin{abstract}\n${abstractProse}\n\\end{abstract}\n`);
  await fs.writeFile(path.join(setup.buildRoot,'source-manifest.json'),JSON.stringify(['main.tex','tex/body.tex','tex/abstract.tex','tex/uncompiled.tex'].map(p=>({path:p}))));
  await fs.writeFile(path.join(setup.buildRoot,'artifacts/main.synctex.gz'),gzipSync(raw.replace('Output:pdf','Input:5:/old/workspace/papers/Alpha/build/b-unit/source/tex/abstract.tex\nOutput:pdf')));
  return setup;
}
test('captured abstract inputs remain eligible without fabricated geometry records',()=>{
  const parsed=parseSyncTeX(raw.replace('Output:pdf','Input:5:/old/workspace/papers/Alpha/build/b-unit/source/tex/abstract.tex\nInput:6:/etc/private.tex\nOutput:pdf'));
  const data=indexSyncTeX(parsed,'b-unit','manuscript',new Set(['main.tex','tex/body.tex','tex/abstract.tex','private.tex']),[{width:612,height:792}]);
  assert.ok(data.compiledInputs?.includes('manuscript/tex/abstract.tex'));
  assert.ok(!data.files.includes('manuscript/tex/abstract.tex'));
  assert.ok(!data.compiledInputs?.includes('manuscript/private.tex'));
  assert.throws(()=>syncForward(data,'manuscript/tex/abstract.tex',2),/没有排版定位记录/);
});
test('word API locates captured abstract from frozen source rather than live manuscript',async()=>{
  const {app,root,cleanup}=await wordFixture();try {
    await fs.writeFile(path.join(root,'manuscript/tex/abstract.tex'),'Different current source.');
    const response=await app.inject(`/api/builds/b-unit/sync/word?${wordQuery()}`);
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.json().path,'manuscript/tex/abstract.tex');assert.equal(response.json().line,2);
    assert.equal(response.json().column,abstractProse.indexOf('analysis')+1);assert.equal(response.json().stale,true);
    assert.match(response.json().warning,/源码已变化/);assert.ok(!response.body.includes('/old/workspace'));
  }finally{await cleanup();}
});
test('word API rejects weak, ambiguous and uncompiled context matches',async()=>{
  const {app,buildRoot,root,cleanup}=await wordFixture();try {
    const query=()=>app.inject(`/api/builds/b-unit/sync/word?${wordQuery()}`);
    assert.equal((await app.inject('/api/builds/b-unit/sync/word?word=analysis')).statusCode,404);
    await fs.writeFile(path.join(buildRoot,'source/tex/body.tex'),abstractProse);
    assert.equal((await query()).statusCode,404,'equal matching contexts in different inputs must not guess');
    await fs.writeFile(path.join(buildRoot,'source/tex/body.tex'),'Other body.');
    await fs.writeFile(path.join(buildRoot,'source/tex/abstract.tex'),`${abstractProse}\n${abstractProse}`);
    assert.equal((await query()).statusCode,404,'repeated matching contexts in one input must not guess');
    await fs.writeFile(path.join(buildRoot,'source/tex/abstract.tex'),'Other abstract.');
    await fs.writeFile(path.join(buildRoot,'source/tex/uncompiled.tex'),abstractProse);
    await fs.writeFile(path.join(root,'manuscript/main.tex'),abstractProse);
    assert.equal((await query()).statusCode,404,'live and manifest-only files must not participate');
  }finally{await cleanup();}
});
test('word API bounds queries and refuses symlinked frozen source',async()=>{
  const {app,buildRoot,cleanup}=await wordFixture();try {
    for(const query of [wordQuery({word:'x'.repeat(121)}),wordQuery({before:'x'.repeat(241)}),wordQuery({after:'x'.repeat(241)}),wordQuery({word:''}),wordQuery({before:'\0'}),new URLSearchParams([['word','analysis'],['word','other']])]) {
      const response=await app.inject(`/api/builds/b-unit/sync/word?${query}`);assert.equal(response.statusCode,400,response.body);
    }
    await fs.rm(path.join(buildRoot,'source/tex/abstract.tex'));
    await fs.symlink('/etc/hosts',path.join(buildRoot,'source/tex/abstract.tex'));
    assert.equal((await app.inject(`/api/builds/b-unit/sync/word?${wordQuery()}`)).statusCode,403);
    await fs.rm(path.join(buildRoot,'source/tex/abstract.tex'));
    await fs.writeFile(path.join(buildRoot,'source/tex/abstract.tex'),'x'.repeat(2*1024*1024+1));
    assert.equal((await app.inject(`/api/builds/b-unit/sync/word?${wordQuery()}`)).statusCode,413);
  }finally{await cleanup();}
});
