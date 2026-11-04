import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPhase,buildElapsed} from '../src/buildProgress.ts';
test('compilation phases follow the latest observed engine message instead of a fabricated percentage',()=>{
 assert.equal(buildPhase({status:'queued',log:''}),'等待编译');
 assert.equal(buildPhase({status:'running',log:''}),'准备源码');
 assert.equal(buildPhase({status:'running',sourceHash:'hash',log:'note: "version 2" Tectonic command-line interface activated'}),'启动引擎');
 assert.equal(buildPhase({status:'running',sourceHash:'hash',log:'Running TeX ...\ndownloading cmr10.tfm\n'}),'下载依赖');
 assert.equal(buildPhase({status:'running',log:'downloading bundle\nRunning TeX ...\nRunning BibTeX ...'}),'处理文献');
 assert.equal(buildPhase({status:'running',log:'Running BibTeX ...\nRerunning TeX ...\nRunning xdvipdfmx ...'}),'生成 PDF');
});
test('elapsed time starts from actual engine start or queue time, never before zero',()=>{
 const createdAt='2026-10-22T12:00:00Z',startedAt='2026-10-22T12:00:05Z';
 assert.equal(buildElapsed({createdAt,startedAt},Date.parse('2026-10-22T12:01:10Z')),'01:05');
 assert.equal(buildElapsed({createdAt},Date.parse('2026-10-22T12:01:10Z')),'01:10');
 assert.equal(buildElapsed({createdAt},Date.parse('2026-10-22T11:59:00Z')),'00:00');
});
