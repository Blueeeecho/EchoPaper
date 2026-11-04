import test from 'node:test';import assert from 'node:assert/strict';
import {pdfTextForMatching} from '../src/pdfTextMatch.ts';
import {contextWordCandidates} from '../src/syncWords.ts';
const item=(str:string,x:number,y:number,width:number)=>({str,transform:[10,0,0,10,x,y],width,height:10});
test('PDF metadata joins font fragments and preserves genuine spaces',()=>{
 const text=pdfTextForMatching([item('pref',10,100,20),item('erences',30,100,35),item('remain',70,100,30),item(' valid',100,100,30)]);
 assert.equal(text,'preferences remain valid');
});
test('PDF metadata rejoins line hyphenation and keeps column boundaries separate',()=>{
 const text=pdfTextForMatching([item('explicit recommenda-',10,100,100),item('tions remain valid evidence today',10,88,160),item('Other column',300,100,60)]);
 assert.equal(text,'explicit recommendations remain valid evidence today\nOther column');
 const hits=contextWordCandidates(text,{word:'recommendations',before:'explicit ',after:' remain valid evidence today'});
 assert.equal(hits.length,1);assert.ok(hits[0].score>=8);
});
