import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewPacket,coverageGaps,readReceipts,type ReadReceipt} from '../server/agents/review-coverage';
import type {AgentRun,ToolCall} from '../shared/agent-types';
import type {ProjectSnapshot} from '../server/agents/project-snapshot';
const snapshot:ProjectSnapshot={files:Object.fromEntries(['manuscript/a.tex','manuscript/b.tex','notes/irrelevant.md'].map(path=>[path,{path,hash:path,size:30,text:'a\nb\nc\nd',binary:false}])),entries:[],capturedAt:''};
const run={scope:{},changesets:[],requiredRoles:['reviewer']} as unknown as AgentRun;
const receipt=(path:string,startLine=1,endLine=4):ReadReceipt=>({path,hash:path,startLine,endLine,totalLines:4,truncated:startLine>1||endLine<4,binary:false});
test('unrelated, first-line, missing-file, binary metadata and search are not review coverage',()=>{
 const packet=reviewPacket(run,snapshot,'manuscript/a.tex');assert.equal(packet.dependencies.length,2);
 for(const receipts of [[receipt('notes/irrelevant.md')],[receipt('manuscript/a.tex',1,1)],[receipt('manuscript/a.tex')],[{...receipt('manuscript/a.tex'),binary:true},receipt('manuscript/b.tex')]])assert.ok(coverageGaps(packet,receipts).length);
 const tools=[{agentId:'coordinator',name:'search_files',status:'completed',result:{path:'manuscript/a.tex',hash:'manuscript/a.tex',content:'a\nb\nc\nd',startLine:1,endLine:4,totalLines:4}}] as ToolCall[];assert.deepEqual(readReceipts(tools,'coordinator'),[]);
 assert.equal(coverageGaps(packet,[receipt('manuscript/a.tex',1,2),receipt('manuscript/a.tex',3,4),receipt('manuscript/b.tex')]).length,0);
});
test('explicit local selection can pass local coverage, candidate changes require every affected file',()=>{
 const local={...run,scope:{selection:{path:'manuscript/a.tex',documentText:'a\nb\nc\nd',selectedText:'b',from:2,to:3}},writingTask:{kind:'focused'}} as AgentRun;
 const p=reviewPacket(local,snapshot,'manuscript/a.tex');assert.equal(p.dependencies.length,1);assert.deepEqual([p.dependencies[0].from,p.dependencies[0].to],[2,2]);assert.deepEqual(coverageGaps(p,[receipt('manuscript/a.tex',2,2)]),[]);
 const modified={...local,changesets:[{status:'applied',images:[{path:'manuscript/a.tex',beforeHash:'old',afterHash:'manuscript/a.tex',beforeBase64:Buffer.from('old').toString('base64'),afterBase64:Buffer.from('a\nb\nc\nd').toString('base64')},{path:'manuscript/b.tex',beforeHash:'old',afterHash:'manuscript/b.tex',beforeBase64:Buffer.from('old').toString('base64'),afterBase64:Buffer.from('a\nb\nc\nd').toString('base64')}]}]} as AgentRun;
 const packet=reviewPacket(modified,snapshot);assert.ok(coverageGaps(packet,[receipt('manuscript/a.tex')]).some(x=>x.includes('b.tex')));assert.ok(packet.diff.includes('- old'));assert.ok(!packet.diff.includes('b2xk'));assert.deepEqual(coverageGaps(packet,[receipt('manuscript/a.tex'),receipt('manuscript/b.tex')]),[]);
});
test('large diff truncation and binary dependencies cannot silently pass',()=>{
 const binary={...snapshot,files:{...snapshot.files,'manuscript/fig.png':{path:'manuscript/fig.png',hash:'png',size:10,binary:true}}};
 const b=reviewPacket({...run,scope:{paths:['manuscript/fig.png']}} as AgentRun,binary);assert.ok(coverageGaps(b,[]).length);
 const huge={...run,changesets:[{status:'applied',images:[{path:'manuscript/a.tex',beforeBase64:Buffer.from('x'.repeat(50000)).toString('base64'),afterBase64:Buffer.from('y'.repeat(50000)).toString('base64')}]}]} as AgentRun;
 const packet=reviewPacket(huge,snapshot);assert.equal(packet.diffTruncated,true);assert.ok(packet.diff.length<=40000);assert.ok(coverageGaps(packet,[receipt('manuscript/a.tex')]).length);
});
