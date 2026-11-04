import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAcceptedChanges, replaceSelectedText, reviewChanges } from '../src/editReview.ts';
test('partial AI changes preserve rejected content and unchanged TeX',()=>{
  const before='We has a result.\\cite{key}\nOld ending.', after='We have a result.\\cite{key}\nNew ending.';
  const changes=reviewChanges(before,after);
  assert.ok(changes.length>=2);
  assert.equal(applyAcceptedChanges(before,after,changes,new Set()),before);
  assert.equal(applyAcceptedChanges(before,after,changes,new Set(changes.map((_,i)=>i))),after);
  const one=applyAcceptedChanges(before,after,changes,new Set([0]));assert.match(one,/We have/);assert.match(one,/Old ending/);assert.match(one,/\\cite\{key\}/);
});
test('AI replacements reject stale source and preserve surrounding text',()=>{
 const selection={projectId:'DEMO',path:'manuscript/main.tex',from:2,to:5,text:'old',documentText:'a old z'};
 assert.equal(replaceSelectedText('a old z',selection,'new'),'a new z');
 assert.throws(()=>replaceSelectedText('a old changed',selection,'new'),/变化/);
});
