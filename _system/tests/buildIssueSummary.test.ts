import test from'node:test';import assert from'node:assert/strict';
import{issueCounts,issueGroups,buildStatusLabel}from'../src/buildIssueSummary.ts';
import type{Build,Diagnostic}from'../shared/types.ts';
test('compiler errors, reference warnings and placeholders are distinct without counting reference summary twice',()=>{
 const diagnostics:Diagnostic[]=[{severity:'warning',category:'reference',message:"Reference 'fig:x' undefined.",file:'manuscript/main.tex',line:4,page:1},{severity:'warning',category:'reference',message:'LaTeX Warning: There were undefined references.'},{severity:'error',category:'compile',message:'Missing image',line:6},{severity:'warning',category:'compile',message:'Overfull box'},{severity:'warning',category:'placeholder',message:'TODO'}];
 assert.deepEqual(issueCounts(diagnostics),{error:1,reference:1,warning:1,placeholder:1,info:1});
 assert.equal(issueGroups(diagnostics).reference[0].page,1);
});
test('a lone unlocated reference summary remains visible as a reference problem',()=>{assert.equal(issueCounts([{severity:'warning',category:'reference',message:'There were undefined references.'}]).reference,1);});
test('a generated PDF with unresolved references never receives the clean success label',()=>{
 const build={status:'succeeded',diagnostics:[{severity:'warning',category:'reference',message:"Reference 'missing' undefined.",line:3}]} as Build;
 assert.match(buildStatusLabel(build),/已生成 PDF.*1 项严重问题/);assert.equal(buildStatusLabel({...build,diagnostics:[]}), '编译成功');assert.equal(buildStatusLabel({...build,status:'failed'}),'编译失败');
});


test('public checks identify historical selection, PDF mismatch and in-flight counts separately', async () => {
  const { buildIssueVersionNotices } = await import('../src/buildIssueNavigation.ts');
  const old = { id: 'old', status: 'succeeded', pdf: 'old.pdf' } as Build;
  const current = { id: 'current', status: 'succeeded', pdf: 'new.pdf' } as Build;
  const failed = { id: 'failed', status: 'failed' } as Build;
  assert.deepEqual(buildIssueVersionNotices(failed, old, failed), ['检查结果与显示 PDF 不同版本']);
  assert.deepEqual(buildIssueVersionNotices(old, current, current), ['历史检查', '检查结果与显示 PDF 不同版本']);
  assert.deepEqual(buildIssueVersionNotices(current, old, current), ['检查结果与显示 PDF 不同版本']);
  assert.deepEqual(buildIssueVersionNotices(old, old, current), ['历史检查']);
  assert.deepEqual(buildIssueVersionNotices(current, current, current), []);
  for (const status of ['queued', 'running'] as const) {
    const pending = { id: status, status } as Build;
    const own = buildIssueVersionNotices(pending, undefined, pending);
    assert.ok(own.includes('当前未显示 PDF'));
    assert.ok(own.some(label => label.includes('数量尚未')));
    const retained = buildIssueVersionNotices(old, old, pending);
    assert.ok(retained.includes('历史检查'));
    assert.ok(retained.some(label => label.includes('当前保留所选检查结果')));
  }
});
