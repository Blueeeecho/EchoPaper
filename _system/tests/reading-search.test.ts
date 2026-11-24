import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {tracingChannel} from 'node:diagnostics_channel';
import Fastify from 'fastify';
import {PDFDocument} from 'pdf-lib';
import {createReadingSearch} from '../server/workspace/reading-search';
import {layoutStore} from '../server/workspace/document-layout';
import {registerWorkspaceRoutes} from '../server/workspace/index';
import {hash} from '../server/storage';
import {translationCacheKey} from '../shared/bilingual-cache';
import type {DocumentLayout} from '../shared/bilingual';
import {openCatalog,type IndexedResource} from '../server/workspace/catalog';

const original='Decentralized agents coordinate through shared memory.';
const translation='分布式智能体通过共享记忆协作。';
const key=translationCacheKey({id:'zhipu',model:'glm'},'zh-CN',original);
const resource:IndexedResource={id:'paper-1',rootId:'papers',path:'1_Paper.pdf',name:'1_Paper.pdf',kind:'file',size:100,modifiedAt:'',tags:[],missing:false,revision:1,hash:hash('pdf')};
const layout:DocumentLayout={version:1,resourceId:resource.id,sourceHash:resource.hash!,parsedAt:'2026-11-13',pageCount:2,costPages:2,pages:[{page_num:1,layouts:[{layout_id:'title',type:'title',text:'A Study of Coordination'}]},{page_num:2,layouts:[{layout_id:'body',type:'text',text:original}]}]};
async function fixture(){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'reading-search-'));
 const store=layoutStore(root),search=createReadingSearch(root);
 return {root,store,search,async close(){await search.close();await fs.rm(root,{recursive:true,force:true});}};
}

test('OCR is immediately searchable and partial Chinese translations update without reopening the paper',async()=>{
 const f=await fixture();try{
  await f.store.writeLayout(layout);
  let matches=await f.search.find([resource],'DECENTRALIZED memory');
  assert.equal(matches.get(resource.id)?.source,'ocr');assert.equal(matches.get(resource.id)?.page,2);
  assert.equal((await f.search.find([resource],'共享记忆')).size,0);
  await f.store.mergeTranslations(resource.id,{[key]:translation},resource.hash);
  matches=await f.search.find([resource],'共享记忆 智能体');
  assert.equal(matches.get(resource.id)?.source,'translation');assert.equal(matches.get(resource.id)?.page,2);
  assert.ok(matches.get(resource.id)?.snippet.includes('共享记忆'));
  assert.equal((await f.search.find([resource],'不存在 共享记忆')).size,0);
  const alternate=translationCacheKey({id:'other',model:'model'},'zh-CN',original);
  const orphan=translationCacheKey({id:'zhipu',model:'glm'},'zh-CN','An outdated paragraph.');
  await f.store.mergeTranslations(resource.id,{[alternate]:'群体智能的异步通信。',[orphan]:'仅存在于旧段落的词。'},resource.hash);
  assert.equal((await f.search.find([resource],'异步通信')).size,1);
  assert.equal((await f.search.find([resource],'共享记忆')).size,1);
  assert.equal((await f.search.find([resource],'仅存在于旧段落')).size,0);
  await f.store.writeLayout({...layout,pageCount:3,costPages:3,pages:[...layout.pages,{page_num:3,layouts:[{layout_id:'table',type:'table'}],tables:[{layout_id:'table',table_html:'<table><tr><td>Counterfactual &amp; ablation</td></tr></table>'}]}]});
  const tableMatch=(await f.search.find([resource],'ablation')).get(resource.id);
  assert.equal(tableMatch?.page,3);assert.ok(tableMatch?.snippet.includes('Counterfactual & ablation'));
  const compact=await fs.readFile(path.join(f.root,'workspace/reading-search/paper-1.json'),'utf8');
  assert.ok(!compact.includes('data:image'));assert.ok(compact.includes(translation));
 }finally{await f.close();}
});

test('old layout caches backfill a persistent text index and damaged derived files rebuild',async()=>{
 const f=await fixture();try{
  const directory=path.join(f.root,'workspace/reading-layout');await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'paper-1.json'),JSON.stringify(layout));
  await fs.writeFile(path.join(directory,'paper-1.translations.json'),JSON.stringify({[key]:translation}));
  assert.equal((await f.search.find([resource],'共享记忆')).size,1);
  const indexFile=path.join(f.root,'workspace/reading-search/paper-1.json');
  await fs.writeFile(indexFile,JSON.stringify({version:1,resourceId:'paper-1'}));
  assert.equal((await f.search.find([resource],'coordinate')).size,1);
  const reopened=createReadingSearch(f.root);
  try{assert.equal((await reopened.find([resource],'共享记忆')).size,1);}finally{await reopened.close();}
  await fs.writeFile(path.join(directory,'paper-1.translations.json'),JSON.stringify({[key]:'协作系统采用新的记忆策略。'}));
  assert.equal((await f.search.find([resource],'新的记忆策略')).size,1);
  assert.equal((await f.search.find([resource],'共享记忆')).size,0);
 }finally{await f.close();}
});

test('source changes and deleted caches exclude outdated OCR and translation results',async()=>{
 const f=await fixture();try{
  await f.store.writeLayout(layout);await f.store.mergeTranslations(resource.id,{[key]:translation},resource.hash);
  assert.equal((await f.search.find([{...resource,hash:hash('new pdf')}],'共享记忆')).size,0);
  assert.equal((await f.search.find([{...resource,missing:true}],'coordinate')).size,0);
  await f.store.removeLayout(resource.id);
  assert.equal((await f.search.find([resource],'coordinate')).size,0);
  assert.equal((await f.search.find([{...resource,tags:['Memory']}],'memory')).get(resource.id)?.source,'metadata');
 }finally{await f.close();}
});

test('library search returns cached Chinese and English matches within topic and category scope',async()=>{
 const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'reading-search-api-'));
 const root=path.join(directory,'app'),source=path.join(directory,'source');await fs.mkdir(path.join(root,'papers'),{recursive:true});await fs.mkdir(source);
 const pdf=await PDFDocument.create();pdf.addPage();await fs.writeFile(path.join(source,'paper.pdf'),await pdf.save());
 await fs.writeFile(path.join(source,'note.md'),'原生笔记包含共享记忆。');
 const app=Fastify(),workspace=await registerWorkspaceRoutes(app,root,{watch:false});
 async function call(method:'GET'|'POST',url:string,payload?:unknown,status=200){const response=await app.inject({method,url,payload:payload as any});assert.equal(response.statusCode,status,response.body);return response.json();}
 try{
  const sourceRoot=await call('POST','/api/workspace/roots',{path:source},201);
  for(let count=0;count<100;count++){const roots=(await call('GET','/api/workspace/roots')).roots;if(roots.find((item:any)=>item.id===sourceRoot.id).status!=='scanning')break;await new Promise(resolve=>setTimeout(resolve,10));}
  const files=(await call('GET','/api/workspace/resources')).resources,paper=files.find((item:any)=>item.name==='paper.pdf');
  const store=layoutStore(root);await store.writeLayout({...layout,resourceId:paper.id,sourceHash:paper.hash});await store.mergeTranslations(paper.id,{[key]:translation},paper.hash);
  const topic=await call('POST','/api/workspace/topics',{title:'Topic',resourceIds:[paper.id]},201);
  const chinese=await call('GET',`/api/workspace/resources?q=${encodeURIComponent('共享记忆')}&topicId=${topic.id}&group=paper`);
  assert.equal(chinese.total,1);assert.equal(chinese.resources[0].id,paper.id);assert.equal(chinese.resources[0].searchMatch.source,'translation');assert.equal(chinese.resources[0].searchMatch.page,2);
  const english=await call('GET',`/api/workspace/resources?q=DECENTRALIZED%20memory&topicId=${topic.id}`);assert.equal(english.total,1);
  const all=await call('GET',`/api/workspace/resources?q=${encodeURIComponent('共享记忆')}`);assert.equal(all.total,2);
  const emptyTopic=await call('POST','/api/workspace/topics',{title:'Other topic'},201);
  assert.equal((await call('GET',`/api/workspace/resources?q=coordinate&topicId=${emptyTopic.id}`)).total,0);
  assert.ok(!(await call('GET','/api/workspace/resources')).resources.some((item:any)=>item.searchMatch));
 }finally{await workspace.close();await app.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('disconnected searches stop after the active batch and warm scans preserve the complete page',async t=>{
 const f=await fixture(),app=Fastify();
 const abortedUrl='/api/workspace/resources?q=superseded&limit=3';
 const completedUrl='/api/workspace/resources?q=coordinate&limit=3';
 let markRead!:()=>void,markDisconnected!:()=>void,markEnded!:()=>void;
 const firstRead=new Promise<void>(resolve=>{markRead=resolve;});
 const disconnected=new Promise<void>(resolve=>{markDisconnected=resolve;});
 const ended=new Promise<void>(resolve=>{markEnded=resolve;});
 const channel=tracingChannel('fastify.request.handler').asyncEnd;
 const observeEnd=(event:unknown)=>{
  if((event as {request?:{url:string}}).request?.url===abortedUrl)markEnded();
 };
 const waitFor=(promise:Promise<void>,label:string)=>Promise.race([
  promise,delay(5000,undefined,{ref:false}).then(()=>{throw Error('Timed out: '+label);}),
 ]);
 let reads=0,hold=false,request:http.ClientRequest|undefined;
 try{
  const catalog=await openCatalog(f.root);
  try{
   for(let i=0;i<42;i++){
    const id=`cached-paper-${i}`,name=`Paper ${String(i).padStart(2,'0')}.pdf`;
    const row={...resource,id,name,path:name,hash:hash(id)};
    catalog.state.resources.push(row);
    await f.store.writeLayout({...layout,resourceId:id,sourceHash:row.hash});
   }
   await catalog.save();
  }finally{catalog.close();}
  const read=fs.readFile;
  t.mock.method(fs,'readFile',(async(...args:Parameters<typeof fs.readFile>)=>{
   if(typeof args[0]==='string'&&args[0].includes(`${path.sep}reading-search${path.sep}`)){
    reads++;
    if(hold){markRead();await disconnected;}
   }
   return read(...args);
  }) as typeof fs.readFile);
  app.addHook('onRequest',async request=>{
   if(request.url===abortedUrl)request.raw.once('close',markDisconnected);
  });
  await registerWorkspaceRoutes(app,f.root,{watch:false});
  channel.subscribe(observeEnd);
  const url=await app.listen({host:'127.0.0.1',port:0});
  hold=true;reads=0;
  request=http.get(url+abortedUrl);
  request.on('error',()=>{});
  await waitFor(firstRead,'first index read');
  request.destroy();
  await waitFor(ended,'aborted request handler');
  assert.ok(reads>0&&reads<=4,`disconnected search read ${reads} index documents`);
  hold=false;

  const getPage=async()=>{
   const response=await fetch(url+completedUrl);
   assert.equal(response.status,200);
   return response.json();
  };
  const firstPage=await getPage();
  reads=0;
  const secondPage=await getPage();
  assert.deepEqual(secondPage,firstPage);
  assert.equal(secondPage.total,42);
  assert.equal(secondPage.groupCounts.paper,42);
  assert.deepEqual(secondPage.resources.map((item:{name:string})=>item.name),['Paper 00.pdf','Paper 01.pdf','Paper 02.pdf']);
  assert.equal(secondPage.resources[0].searchMatch.source,'ocr');
  assert.equal(secondPage.resources[0].searchMatch.page,2);
  assert.equal(reads,2,'only index documents outside the 40-entry cache should be reread');
 }finally{
  request?.destroy();
  markDisconnected();
  channel.unsubscribe(observeEnd);
  await app.close();await f.close();
 }
});
