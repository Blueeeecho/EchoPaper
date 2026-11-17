import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseResearchMap,researchSourceHref,researchBasisStale,researchMapSelection} from '../shared/research-map.ts';
import {ResearchMapView,readResearchFile} from '../src/academic/ResearchMap';
import {createApp} from '../server/index.ts';
import type {BuildService} from '../shared/types.ts';
const fixture={schemaVersion:1,projectId:'fixture-paper',title:'对照 <script>alert(1)</script>',asOf:'2026-11-06',sourceNoteSha256:'a'.repeat(64),scope:'局部核对',ours:{id:'ours',short:'本研究',question:'问题',approach:'方案',status:'未验证',proposedDifference:'待证',falsifier:'基线同效则否定'},papers:[{id:'prior',short:'前人',title:'English words',url:'javascript:alert(1)',anchor:'§3',accomplishment:'成果',boundary:'未知',proposedDifference:'待证',comparisonStatus:'未核对'}],edges:[{source:'prior',target:'ours',kind:'机制重合',assertion:'研究者判断',evidence:'https://example.org/paper#s3',anchor:'§3',assessment:'并非引用'}],evidence:[{id:'negative',title:'负结果',status:'unknown',detail:'未完成',scope:'限定控制',source:'notes/result.json'}]};
test('paper identifiers follow the registry contract including dotted identifiers',async()=>{
 const projectId='paper.2027';
 assert.equal(parseResearchMap(JSON.stringify({...fixture,projectId}),projectId).projectId,projectId);
 assert.equal(researchSourceHref('notes/result.json',projectId),'/api/projects/paper.2027/raw?path=notes%2Fresult.json');
 for(const invalid of ['../other','.hidden','bad/name','x'.repeat(81),'bad name'])assert.throws(()=>parseResearchMap(JSON.stringify({...fixture,projectId:invalid}),invalid));
 const previous=globalThis.fetch;try{globalThis.fetch=async(url)=>{assert.ok(String(url).startsWith('/api/projects/paper.2027/file?'));return new Response(JSON.stringify({content:'{}',hash:'a'.repeat(64)}));};await readResearchFile(projectId,'notes/research-map.json');}finally{globalThis.fetch=previous;}
});
test('search selects matching relationships as well as matching papers',()=>{
 const data=parseResearchMap(JSON.stringify({...fixture,papers:[fixture.papers[0],{...fixture.papers[0],id:'second',title:'Different work'}],edges:[fixture.edges[0],{...fixture.edges[0],source:'second'}]}),'fixture-paper');
 for(const selected of ['', 'prior']){const selection=researchMapSelection(data,'ENGLISH',selected);assert.deepEqual(selection.papers.map(p=>p.id),['prior']);assert.deepEqual(selection.edges.map(e=>e.source),['prior']);}
 assert.equal(researchMapSelection(data,'no match','').total,0);
 assert.equal(researchMapSelection(data,'','').total,2);
});
test('schema rejects missing, broken, oversized, cross-project and dangling data; absent statuses remain unknown',()=>{
 const parse=(v:unknown)=>parseResearchMap(JSON.stringify(v),'fixture-paper');const d=parse(fixture);assert.equal(d.edges[0].checkedAt,'');assert.ok(researchBasisStale(d,undefined));assert.ok(researchBasisStale(d,'b'.repeat(64)));assert.equal(researchBasisStale(d,'a'.repeat(64)),false);
 for(const v of [{},{...fixture,schemaVersion:2},{...fixture,projectId:'other'},{...fixture,edges:[{...fixture.edges[0],source:'missing'}]},{...fixture,papers:[fixture.papers[0],fixture.papers[0]]}])assert.throws(()=>parse(v));assert.throws(()=>parseResearchMap('{bad','fixture-paper'));assert.throws(()=>parseResearchMap(' '.repeat(524289),'fixture-paper'));
});
test('links restrict protocols and project scope, retain anchors',()=>{
 for(const v of ['javascript:alert(1)','data:text/html,x','file:///etc/passwd','../other.md','//evil.test','notes/../secret','notes/a%2fb','https://user:pass@evil.test'])assert.equal(researchSourceHref(v,'fixture-paper'),undefined,v);
 assert.equal(researchSourceHref('https://example.org/p#s3','fixture-paper'),'https://example.org/p#s3');assert.equal(researchSourceHref('notes/result.json','fixture-paper'),'/api/projects/fixture-paper/raw?path=notes%2Fresult.json');assert.equal(researchSourceHref('notes/result.json','../other'),undefined);
});
test('React escapes text and labels stale, unknown and context-preserving links',()=>{
 const data=parseResearchMap(JSON.stringify(fixture),'fixture-paper');const html=renderToStaticMarkup(createElement(ResearchMapView,{data,projectId:'fixture-paper',currentHash:'b'.repeat(64)}));
 for(const text of ['&lt;script&gt;','需重核','未单独核验','未记录','noopener noreferrer',data.edges[0].assertion])assert.ok(html.includes(text));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));
 const cross=renderToStaticMarkup(createElement(ResearchMapView,{data,projectId:'other'}));assert.ok(cross.includes('不属于'));assert.ok(!cross.includes('alert(1)'));
});
test('bounded read-only reader handles missing and huge documents',async()=>{
 const old=globalThis.fetch;try{
 globalThis.fetch=async()=>new Response('{}',{status:404});await assert.rejects(readResearchFile('fixture-paper','notes/research-map.json'),/尚未录入/);
 globalThis.fetch=async()=>new Response('x'.repeat(2097153));await assert.rejects(readResearchFile('fixture-paper','notes/research-map.json'),/过大/);
 globalThis.fetch=async(input,init)=>{assert.ok(String(input).startsWith('/api/projects/fixture-paper/file?'));assert.equal(init?.method,undefined);return new Response(JSON.stringify({content:JSON.stringify(fixture),hash:'a'.repeat(64)}));};const doc=await readResearchFile('fixture-paper','notes/research-map.json');assert.equal(parseResearchMap(doc.content,'fixture-paper').papers.length,1);
 }finally{globalThis.fetch=old;}
});
test('isolated API reads optional map and local evidence without writing manuscript or compiling',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'research-map-'));let calls=0;
 await fs.mkdir(path.join(root,'papers/fixture-paper/notes'),{recursive:true});await fs.mkdir(path.join(root,'papers/fixture-paper/manuscript'));
 await fs.writeFile(path.join(root,'papers/fixture-paper/project.json'),JSON.stringify({schemaVersion:1,id:'fixture-paper',title:'fixture',stage:'writing',venue:'',deadline:'',targets:[{id:'main',label:'主稿',main:'manuscript/main.tex'}],autoCompile:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));await fs.writeFile(path.join(root,'papers/fixture-paper/manuscript/main.tex'),'unchanged');
 const fake={async request(){calls++;throw Error('must not build');},async close(){},async list(){return [];}} as unknown as BuildService;const app=await createApp({workspaceRoot:root,watch:false,buildService:fake});
 try{const url='/api/projects/fixture-paper/file?path=notes%2Fresearch-map.json';assert.equal((await app.inject(url)).statusCode,404);await fs.writeFile(path.join(root,'papers/fixture-paper/notes/research-map.json'),JSON.stringify(fixture));const doc=(await app.inject(url)).json();assert.equal(parseResearchMap(doc.content,'fixture-paper').projectId,'fixture-paper');await fs.writeFile(path.join(root,'papers/fixture-paper/notes/result.json'),'{}');assert.equal((await app.inject(researchSourceHref('notes/result.json','fixture-paper')!)).body,'{}');assert.equal(await fs.readFile(path.join(root,'papers/fixture-paper/manuscript/main.tex'),'utf8'),'unchanged');assert.equal(calls,0);}finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});

test('all views share parsed data and preserve negative evidence without completion claims',()=>{
 const data=parseResearchMap(JSON.stringify(fixture),'fixture-paper');
 for(const initialTab of ['脉络关系','方案对照','证据'] as const){const html=renderToStaticMarkup(createElement(ResearchMapView,{data,projectId:'fixture-paper',currentHash:'a'.repeat(64),initialTab}));assert.ok(!html.includes('需重核'));assert.ok(html.includes(initialTab));if(initialTab==='方案对照'){assert.ok(html.includes(data.papers[0].proposedDifference));assert.ok(html.includes(data.papers[0].accomplishment));}if(initialTab==='证据'){assert.ok(html.includes(data.evidence[0].status));assert.ok(html.includes('负结果'));}}
 assert.equal(researchSourceHref('notes/script.html','fixture-paper'),undefined);assert.equal(researchSourceHref('notes/script.svg','fixture-paper'),undefined);
});
