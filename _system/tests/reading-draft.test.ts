import test from 'node:test';
import assert from 'node:assert/strict';
import {readReadingDraft,writeReadingDraft,clearReadingDraft} from '../src/academic/readingDraft';
function store(){const values=new Map<string,string>();return {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};}
test('窗口草稿独立，刷新可恢复，保存A不清除B；旧共享草稿保留',()=>{
 const a=store(),b=store(),legacy=store(),key='reading:a';legacy.setItem(key,JSON.stringify({content:'old'}));
 assert.deepEqual(readReadingDraft(a,legacy,key),{content:'old'});
 assert.deepEqual(readReadingDraft(b,legacy,key),{content:'old'});
 writeReadingDraft(a,key,{content:'A'});writeReadingDraft(b,key,{content:'B'});
 assert.deepEqual(readReadingDraft(a,legacy,key),{content:'A'});
 assert.deepEqual(readReadingDraft(b,legacy,key),{content:'B'});
 clearReadingDraft(a,key);assert.equal(readReadingDraft(a,legacy,key),null);
 assert.deepEqual(readReadingDraft(b,legacy,key),{content:'B'});
 assert.deepEqual(JSON.parse(legacy.getItem(key)!),{content:'old'});
});

import {validateReadingDraft} from '../src/academic/readingDraft';
test('损坏、跨资料和重复摘录草稿拒绝恢复，保留原始文字',()=>{
 const note={id:'n',quote:'原文',translation:'',comment:'判断',page:null,locationKind:'unlocated',sourceHash:'h',sourcePath:'a.txt',createdAt:'2026-11-11'};
 const good={hash:null,document:{version:1,resourceId:'r',content:'未保存文字',notes:[note]}};
 assert.doesNotThrow(()=>validateReadingDraft(good,'r'));
 const bad=[{}, {...good,hash:42},{...good,document:{...good.document,resourceId:'other'}},{...good,document:{...good.document,notes:null}},{...good,document:{...good.document,notes:[note,note]}},{...good,document:{...good.document,notes:[{...note,comment:null}]}}];
 for(const value of bad){const tab=store(),legacy=store();writeReadingDraft(tab,'k',value);const original=tab.getItem('k');assert.throws(()=>validateReadingDraft(readReadingDraft(tab,legacy,'k'),'r'));assert.equal(tab.getItem('k'),original);}
});

test('JSON null 草稿不能伪装成不存在；当前窗口和旧共享原始内容均保留',()=>{
 const tab=store(),legacy=store();tab.setItem('k','null');
 assert.throws(()=>readReadingDraft(tab,legacy,'k'));
 assert.equal(tab.getItem('k'),'null');
 const next=store();legacy.setItem('k','null');
 assert.throws(()=>readReadingDraft(next,legacy,'k'));
 assert.equal(legacy.getItem('k'),'null');
 assert.equal(next.getItem('k'),null);
 assert.equal(next.getItem('k:legacy-read'),null);
 assert.equal(readReadingDraft(store(),store(),'absent'),null);
});
