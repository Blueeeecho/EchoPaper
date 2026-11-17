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

test('wording edits in one sentence form a readable group and other sentences can be rejected', () => {
  const before = 'The system has bad outputs and need a check. The evidence remains unchanged. Another result is bad.';
  const after = 'The workflow produces unreliable outputs and needs verification. The evidence remains unchanged. Another finding is strong.';
  const groups = reviewChanges(before, after);
  assert.equal(groups.length, 2);
  assert.match(before.slice(groups[0].fromA, groups[0].toA), /^The system/);
  assert.match(after.slice(groups[0].fromB, groups[0].toB), /^The workflow/);
  assert.equal(applyAcceptedChanges(before, after, groups, new Set([0])), 'The workflow produces unreliable outputs and needs verification. The evidence remains unchanged. Another result is bad.');
  assert.equal(applyAcceptedChanges(before, after, groups, new Set([0, 1])), after);
});

test('Chinese sentences and TeX citation lines stay readable while preserving exact application', () => {
  const before = '这是一个不好且不准确的解释。证据必须保留。\n\\cite{key}\n结果需要检验。';
  const after = '这是一种欠妥且不够准确的说明。证据必须保留。\n\\cite{key}\n结论需要验证。';
  const groups = reviewChanges(before, after);
  assert.equal(groups.length, 2);
  assert.ok(before.slice(groups[0].fromA, groups[0].toA).includes('解释。'));
  assert.equal(applyAcceptedChanges(before, after, groups, new Set()), before);
  assert.equal(applyAcceptedChanges(before, after, groups, new Set([0, 1])), after);
});

test('insertions, deletions, punctuation, Unicode and whitespace groups apply byte-exactly', () => {
  const variants = ['', 'A sentence.', 'A new sentence. Another one.', 'α🙂中文。下一句。', '\\begin{equation}\nx = 1\n\\end{equation}', '  A\tB\r\nC.\n'];
  for (const before of variants) for (const after of variants) {
    const groups = reviewChanges(before, after);
    assert.equal(applyAcceptedChanges(before, after, groups, new Set()), before);
    assert.equal(applyAcceptedChanges(before, after, groups, new Set(groups.map((_, index) => index))), after);
  }
});
