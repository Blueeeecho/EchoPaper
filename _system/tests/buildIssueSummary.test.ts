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
