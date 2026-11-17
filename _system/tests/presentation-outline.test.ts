import test from 'node:test';
import assert from 'node:assert/strict';
import {readablePresentationOutline} from '../shared/presentation-outline';
import type {PresentationDocument} from '../shared/presentation-types';
test('readable outline follows current slide order, edits, source names and notes',()=>{
 const doc={title:'汇报',presenter:'',advisor:'',sources:[{id:'s',name:'论文',path:'method.tex'}],slides:[{id:'a',layout:'cover',title:'问题',keyMessage:'主题',blocks:[],sourceIds:['s'],notes:{speech:'整场故事',transition:'接方法',questions:'边界'}},{id:'b',layout:'explanation',section:'研究内容',title:'方法',keyMessage:'结论',blocks:[{id:'b',type:'text',text:'具体内容',sourceIds:['s']}],sourceIds:['s'],notes:{speech:'自然口述',transition:'接证据',questions:'可验证吗'}}]} as unknown as PresentationDocument;
 const first=readablePresentationOutline(doc);assert(first.indexOf('整体故事')<first.indexOf('逐页具体内容'));for(const text of ['整场故事','第 2 页｜方法','具体内容','自然口述','接证据','论文（method.tex）'])assert(first.includes(text));const p2=(o:string)=>o.slice(o.indexOf('### 第 2 页｜方法'));assert(p2(first).includes('页面正文：\n\n具体内容\n'));
 doc.slides[1].blocks[0].text='修改后的正文';const next=readablePresentationOutline(doc);assert(next.includes('修改后的正文'));assert(!p2(next).includes('页面正文：\n\n具体内容\n'));
});
