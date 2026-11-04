import test from 'node:test';
import assert from 'node:assert/strict';
import {submissionSeverity} from '../shared/diagnostic-policy';
import {buildStatusLabel,issueCounts} from '../src/buildIssueSummary';
import type {Build,Diagnostic} from '../shared/types';
test('submission blockers are serious even when TeX emitted a PDF, without mutating engine severity',()=>{
 const items:Diagnostic[]=[{severity:'warning',category:'reference',message:"Reference 'fig:x' undefined."},{severity:'warning',category:'compile',message:"Image file 'absent' was not found in the frozen source snapshot."},{severity:'info',category:'placeholder',message:'TODO: supply result'},{severity:'warning',category:'reference',message:'Label multiply defined.'}];
 const original=structuredClone(items);
 assert.ok(items.every(item=>submissionSeverity(item)==='error'));
 assert.deepEqual(items,original);
 const build={status:'succeeded',diagnostics:items} as Build;
 assert.equal(buildStatusLabel(build),'已生成 PDF · 4 项严重问题');
 assert.deepEqual(issueCounts(items),{error:1,reference:2,warning:0,placeholder:1,info:0});
 assert.equal(buildStatusLabel({...build,status:'failed'}),'编译失败');
});
test('ordinary layout warnings and informational engine messages keep their level',()=>{
 assert.equal(submissionSeverity({severity:'warning',category:'compile',message:'Overfull box'}),'warning');
 assert.equal(submissionSeverity({severity:'info',category:'compile',message:'Engine terminated after the recorded error'}),'info');
});
