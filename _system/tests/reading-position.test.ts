import test from 'node:test';
import assert from 'node:assert/strict';
import {readingPosition,readingPageInput} from '../src/academic/readingPosition';
test('阅读位置保留有效值，源版本变化使用默认值',()=>{
 const raw=JSON.stringify({hash:'h',page:7,zoom:1.5,top:125});
 assert.deepEqual(readingPosition(raw,'h'),{page:7,zoom:1.5,top:125});
 for(const zoom of [.5,.8,1.7,2.5,3])assert.equal(readingPosition(JSON.stringify({hash:'h',zoom}),'h').zoom,zoom);
 assert.deepEqual(readingPosition(raw,'new'),{page:1,zoom:1,top:0});
});
test('损坏存储及非法字段不能进入PDF渲染参数',()=>{
 for(const raw of [null,'null','{','[]','42'])assert.deepEqual(readingPosition(raw,'h'),{page:1,zoom:1,top:0});
 for(const value of [-1,0,1.5,'2',null,{},1e100]){
  assert.equal(readingPosition(JSON.stringify({hash:'h',page:value}),'h').page,1);
 }
 for(const value of [-1,0,'1',null,1e100])assert.equal(readingPosition(JSON.stringify({hash:'h',zoom:value}),'h').zoom,1);
 for(const value of [-1,'20',null,{}])assert.equal(readingPosition(JSON.stringify({hash:'h',top:value}),'h').top,0);
 assert.equal(readingPosition('{"hash":"h","top":1e400}','h').top,0);
});

test('页码输入与跳页始终输出有效物理整数页',()=>{
 for(const [input,total,expected] of [[1.5,10,1],[2.9,10,2],[-2,10,1],[0,10,1],[99,10,10],[NaN,10,1],[Infinity,10,1],[2,0,1],[2,NaN,1],[2,2,2]]){
  assert.equal(readingPageInput(input,total),expected);
 }
});
