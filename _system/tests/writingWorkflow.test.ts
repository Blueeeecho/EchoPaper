import test from 'node:test';
import assert from 'node:assert/strict';
import { streamAiReply } from '../src/aiStream';
import { completeSuggestion } from '../src/writingDraft';
import { menuPosition, quoteReference } from '../src/selectionContext';
import { resolveIssueBuild, visibleIssueKinds, issueFilterCount } from '../src/buildIssueNavigation';
import type { Build } from '../shared/types';

test('single mocked transport returns a reviewable suggestion without tools',async()=>{
  const original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async (_url,init)=>{
    calls++;
    assert.equal(JSON.parse(String(init?.body)).tools,undefined);
    return new Response('{"type":"delta","text":"replacement"}\n{"type":"done","model":"mock","finishReason":"stop"}\n');
  };
  try {
    const output=await streamAiReply({messages:[{role:'user',content:'format selected text'}]},new AbortController().signal,()=>{});
    assert.equal(completeSuggestion(output).text,'replacement');assert.equal(calls,1);
  } finally {globalThis.fetch=original;}
});
test('early stream termination, truncated and empty results cannot enter review application',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async ()=>new Response('{"type":"delta","text":"partial"}\n');
  try {await assert.rejects(streamAiReply({},new AbortController().signal,()=>{}),/提前结束/);}
  finally {globalThis.fetch=original;}
  for(const output of [{text:'partial',model:'mock',finishReason:'length'},{text:'partial',model:'mock'},{text:' ',model:'mock',finishReason:'stop'}]) assert.throws(()=>completeSuggestion(output));
});
test('quote cards retain frozen text and PDF provenance without assigning source offsets',()=>{
  const source={projectId:'P',path:'main.tex',documentText:'a old z',from:2,to:5,text:'old'};
  assert.deepEqual(quoteReference({id:1,projectId:'P',source:'source',selection:source}),{path:'main.tex',content:'old'});
  const pdf=quoteReference({id:2,projectId:'P',source:'pdf',text:'selected pdf',buildId:'B1',page:3});
  assert.match(pdf.path,/只读参考.*B1.*3/);assert.equal(pdf.content,'selected pdf');
  assert.deepEqual(menuPosition(1000,700,1024,720),{left:756,top:616});
  assert.deepEqual(menuPosition(-5,-5,390,300),{left:8,top:8});
});
function build(id:string,projectId:string,targetId:string,createdAt:string):Build {
  return {id,projectId,targetId,createdAt,status:'succeeded',log:'',diagnostics:[{severity:'warning',category:'reference',message:id,line:3}]};
}
test('diagnostic navigation binds history and counts to the same project and target',()=>{
  const builds=[build('old','P','T','1'),build('current','P','T','2'),build('foreign','Q','T','3'),build('other-target','P','U','4')];
  assert.equal(resolveIssueBuild(builds,'P','T','old')?.id,'old');
  assert.equal(resolveIssueBuild(builds,'P','T','foreign')?.id,'current');
  assert.equal(resolveIssueBuild(builds,'P','missing','old'),undefined);
  assert.deepEqual(visibleIssueKinds('reference'),['reference']);
  assert.equal(issueFilterCount(resolveIssueBuild(builds,'P','T','old'),'reference'),1);
  assert.equal(issueFilterCount(resolveIssueBuild(builds,'P','T','old'),'error'),0);
  assert.equal(issueFilterCount(undefined,'all'),0);
});
