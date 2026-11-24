import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {PDFDocument} from 'pdf-lib';
import {extractKnowledgeRelations} from '../server/workspace/knowledge-relations';
import {registerWorkspaceRoutes} from '../server/workspace/index';
import {registerKnowledgeGraphRoutes} from '../server/workspace/knowledge-graph-routes';
import {createProviderRegistry} from '../server/model-providers';
import {createAnalysisStore} from '../server/workspace/analysis';
import {layoutStore} from '../server/workspace/document-layout';
import {knowledgeEdges,type KnowledgeGraphData} from '../shared/literature-graph';
import {translationCacheKey} from '../shared/bilingual-cache';
import type {ResearchTopic,Resource,SourceRoot} from '../shared/workspace-types';

const original='We evaluate AlphaAgent on JudgeBench and Who&When using F1 and accuracy.';
const translation='我们使用 F1 和准确率在 JudgeBench 和 Who&When 上评测 AlphaAgent。';

test('explicit relations carry their own source sentence and distinguish a model from a benchmark',()=>{
 const comparison='We compare AlphaAgent with GPT-4o-mini.';
 const model='We evaluate AlphaAgent on Qwen3-1.7B.';
 const edges=extractKnowledgeRelations([
  {page:4,text:original,translations:[translation]},
  {page:6,text:[comparison,model,'We train AlphaAgent on HIDDENSET.','We do not test AlphaAgent on FalseBench.','We could evaluate AlphaAgent on ProposedBench.'].join(' ')},
 ]);
 const actual=edges.map(edge=>[edge.predicate,edge.object.label,edge.object.kind,edge.subject?.label,edge.page]);
 assert.deepEqual(actual,[
  ['evaluates_on','JudgeBench','dataset','AlphaAgent',4],
  ['evaluates_on','Who&When','dataset','AlphaAgent',4],
  ['measures_with','F1','metric','AlphaAgent',4],
  ['measures_with','Accuracy','metric','AlphaAgent',4],
  ['compares_with','GPT-4o-mini','model','AlphaAgent',6],
  ['evaluates_with_model','Qwen3-1.7B','model','AlphaAgent',6],
 ]);
 assert.equal(edges[0].quote,original);
 assert.equal(edges[0].translation,translation);
 assert.equal(edges[4].quote,comparison);
 assert.equal(edges[5].quote,model);
 const grouped=knowledgeEdges([
  {resourceId:'one',title:'One',sourceHash:'hash-one',relations:edges},
  {resourceId:'two',title:'Two',sourceHash:'hash-two',relations:[{...edges[0],page:2}]},
 ]);
 assert.equal(grouped[0].refs.length,2);
 assert.deepEqual(grouped[0].refs.map(ref=>ref.relation.page),[4,2]);
});

test('evaluation dimensions and running environments do not turn into dataset nodes',()=>{
 const result=extractKnowledgeRelations([
  {page:1,text:'F.1 QUANTITATIVE EVALUATION ON SOLVABILITY, COMPLETENESS, AND NON-REDUNDANCY'},
  {page:5,text:'We evaluate BetaAgent on JudgeBench using gemma-3-it.'},
  {page:6,text:'We evaluate accuracy based on the FULL NETWORK EXECUTION LOG.'},
 ]);
 assert.deepEqual(result.map(relation=>[relation.predicate,relation.object.label,relation.subject?.label]),[
  ['measures_with','Solvability',undefined],
  ['measures_with','Completeness',undefined],
  ['measures_with','Non-redundancy',undefined],
  ['evaluates_on','JudgeBench','BetaAgent'],
  ['evaluates_with_model','gemma-3-it','BetaAgent'],
 ]);
});

async function pdf(author:string){
 const document=await PDFDocument.create();
 document.setAuthor(author);
 document.addPage();
 return document.save();
}

test('topic graph loads OCR, its current translations and cached PDF text without reading analysis results',async()=>{
 const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'knowledge-graph-'));
 const root=path.join(directory,'app'),source=path.join(directory,'pdfs');
 await fs.mkdir(path.join(root,'papers'),{recursive:true});
 await fs.mkdir(source);
 const docNames=['OCR paper.pdf','Native paper.pdf','Unprocessed paper.pdf','Outside topic.pdf'];
 for(const name of docNames)await fs.writeFile(path.join(source,name),await pdf(name));
 const app=Fastify();
 app.setErrorHandler((error,_request,reply)=>reply.code((error as {statusCode?:number}).statusCode||500).send({error: error instanceof Error?error.message:String(error)}));
 const workspace=await registerWorkspaceRoutes(app,root,{watch:false});
 registerKnowledgeGraphRoutes(app,root,workspace);
 async function get<T>(url:string,expected=200){
  const response=await app.inject(url);
  assert.equal(response.statusCode,expected,response.body);
  return response.json<T>();
 }
 async function post<T>(url:string,payload:object){
  const response=await app.inject({method:'POST',url,payload});
  assert.equal(response.statusCode,201,response.body);
  return response.json<T>();
 }
 try{
  const connected=await post<SourceRoot>('/api/workspace/roots',{path:source});
  for(let count=0;count<100;count++){
   const {roots}=await get<{roots:SourceRoot[]}>('/api/workspace/roots');
   if(roots.find(item=>item.id===connected.id)?.status!=='scanning')break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  const {resources}=await get<{resources:Resource[]}>('/api/workspace/resources');
  const [ocr,native,pending,outside]=docNames.map(name=>resources.find(item=>item.name===name)!);
  const topic=await post<ResearchTopic>('/api/workspace/topics',{title:'Graph test',resourceIds:[ocr.id,native.id,pending.id]});
  const legacyFolder=path.join(root,'materials',topic.id,'文献分析');
  await fs.mkdir(legacyFolder,{recursive:true});
  await fs.writeFile(path.join(legacyFolder,'analysis.json'),'malformed analysis');
  const store=layoutStore(root);
  for(const resource of [ocr,outside]){
   await store.writeLayout({version:1,resourceId:resource.id,sourceHash:resource.hash!,parsedAt:'2026-11-20',pageCount:1,costPages:1,
    pages:[{page_num:1,layouts:[{layout_id:'body',type:'text',text:original}]}]});
  }
  const translationKey=translationCacheKey({id:'test',model:'translator'},'zh-CN',original);
  await store.mergeTranslations(ocr.id,{[translationKey]:translation},ocr.hash);
  const textFolder=path.join(root,'workspace','literature-text');
  await fs.mkdir(textFolder,{recursive:true});
  await fs.writeFile(path.join(textFolder,native.hash+'.json'),JSON.stringify({
   version:1,sourceHash:native.hash,pages:[{page:1,text:'We compare BetaAgent against AlphaAgent.'}],
  }));
  const endpoint='/api/workspace/topics/'+topic.id+'/knowledge-graph';
  const graph=await get<KnowledgeGraphData>(endpoint);
  assert.equal(graph.papers.length,3);
  assert.ok(!graph.papers.some(paper=>paper.resourceId===outside.id));
  const fromOCR=graph.papers.find(paper=>paper.resourceId===ocr.id)!;
  assert.equal(fromOCR.textSource,'ocr');
  assert.equal(fromOCR.relations[0].translation,translation);
  assert.equal(fromOCR.relations[0].page,1);
  const fromPDF=graph.papers.find(paper=>paper.resourceId===native.id)!;
  assert.equal(fromPDF.textSource,'pdf');
  assert.equal(fromPDF.relations[0].predicate,'compares_with');
  assert.deepEqual(graph.papers.find(paper=>paper.resourceId===pending.id)?.relations,[]);

  const evidence='/api/workspace/resources/'+ocr.id+'/raw?sourceHash='+ocr.hash;
  assert.equal((await app.inject(evidence)).statusCode,200);
  await fs.writeFile(path.join(source,ocr.name),await pdf('new version'));
  await get(evidence,409);
  const updated=await get<KnowledgeGraphData>(endpoint);
  assert.deepEqual(updated.papers.find(paper=>paper.resourceId===ocr.id)?.relations,[]);
 }finally{
  await app.close();
  await fs.rm(directory,{recursive:true,force:true});
 }
});

test('extracts rich EN+ZH predicates, canonicalizes aliases, and rejects noisy non-entities',()=>{
 const enBlocks=[
  {page:1,text:'We propose a novel framework called GraphVerify to address multi-step reasoning hallucinations.'},
  {page:2,text:'GraphVerify builds on Chain-of-Thought and outperforms GPT4o and Llama 3.'},
  {page:4,text:'We evaluate GraphVerify on GSM-8K and MMLU Pro using Qwen-2.5.'},
  {page:5,text:'We evaluate Table 1 and Section 3 on Phase 2 and Case A using A100 GPUs.'},
 ];
 const enEdges=extractKnowledgeRelations(enBlocks,{title:'RVProbe: Probing Reasoning Verification'});
 const enSummary=enEdges.map(e=>[e.predicate,e.object.kind,e.object.label,e.subject?.label]);
 assert.ok(enSummary.some(([p,k,l])=>p==='proposes'&&k==='method'&&l==='RVProbe'));
 assert.ok(enSummary.some(([p,k,l])=>p==='proposes'&&k==='method'&&l==='GraphVerify'));
 assert.ok(enSummary.some(([p,k,l])=>p==='addresses'&&k==='problem'&&/multi-step reasoning hallucinations/i.test(String(l))));
 assert.ok(enSummary.some(([p,k,l,s])=>p==='builds_on'&&k==='method'&&l==='Chain-of-Thought'&&s==='GraphVerify'));
 assert.ok(enSummary.some(([p,k,l,s])=>p==='outperforms'&&k==='model'&&l==='GPT-4o'&&s==='GraphVerify'));
 assert.ok(enSummary.some(([p,k,l,s])=>p==='outperforms'&&k==='model'&&l==='Llama-3'&&s==='GraphVerify'));
 assert.ok(enSummary.some(([p,k,l,s])=>p==='evaluates_on'&&k==='dataset'&&l==='GSM8K'&&s==='GraphVerify'));
 assert.ok(enSummary.some(([p,k,l,s])=>p==='evaluates_on'&&k==='dataset'&&l==='MMLU-Pro'&&s==='GraphVerify'));
 assert.ok(enSummary.some(([p,k,l,s])=>p==='evaluates_with_model'&&k==='model'&&l==='Qwen2.5'&&s==='GraphVerify'));
 // No noisy structural references or GPU names
 for(const edge of enEdges){
  assert.ok(!/^(?:Table 1|Section 3|Phase 2|Case A|A100|GPUs?)$/i.test(edge.object.label),`unexpected noisy node: ${edge.object.label}`);
 }

 const zhEdges=extractKnowledgeRelations([
  {page:1,text:'本文提出了 MedReason框架，针对长程医学推理幻觉问题，基于 DeepSeek-R1 改进，并在 MedQA 上评测，显著优于 GPT4o。'},
 ]);
 const zhSummary=zhEdges.map(e=>[e.predicate,e.object.kind,e.object.label]);
 assert.ok(zhSummary.some(([p,k])=>p==='proposes'&&k==='method'));
 assert.ok(zhSummary.some(([p,k,l])=>p==='addresses'&&k==='problem'&&String(l).includes('长程医学推理幻觉')));
 assert.ok(zhSummary.some(([p,k,l])=>p==='builds_on'&&k==='model'&&l==='DeepSeek-R1'));
 assert.ok(zhSummary.some(([p,k,l])=>p==='evaluates_on'&&k==='dataset'&&l==='MedQA'));
 assert.ok(zhSummary.some(([p,k,l])=>p==='outperforms'&&k==='model'&&l==='GPT-4o'));
});

test('fuses verified analysis.json facts, caches local extraction, and supports verified AI deep extraction',async()=>{
 const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'kg-fusion-ai-'));
 const root=path.join(directory,'app'),source=path.join(directory,'pdfs');
 await fs.mkdir(path.join(root,'papers'),{recursive:true});
 await fs.mkdir(source);
 await fs.writeFile(path.join(source,'Study.pdf'),await pdf('Study'));

 const app=Fastify();
 app.setErrorHandler((error,_request,reply)=>reply.code((error as {statusCode?:number}).statusCode||500).send({error:error instanceof Error?error.message:String(error)}));
 const workspace=await registerWorkspaceRoutes(app,root,{watch:false});

 const mockQuote='GraphRAG mitigates multi-hop retrieval drift on HotpotQA and outperforms NaiveRAG.';
 const mockFetch=(async()=>new Response(JSON.stringify({
  choices:[{
   message:{
    content:JSON.stringify({
     relations:[
      {
       subject:{kind:'method',label:'GraphRAG'},
       predicate:'outperforms',
       object:{kind:'method',label:'NaiveRAG'},
       page:1,
       quote:mockQuote,
       translation:'GraphRAG 在多跳检索任务上优于 NaiveRAG。',
      },
      {
       subject:{kind:'method',label:'GraphRAG'},
       predicate:'evaluates_on',
       object:{kind:'dataset',label:'HallucinatedBench'},
       page:1,
       quote:'This fabricated quote does not exist anywhere in the paper text.',
      },
     ],
    }),
   },
  }],
 }),{status:200,headers:{'content-type':'application/json'}})) as typeof fetch;

 let hasKey=false;
 const registry=createProviderRegistry(root,{
  fetch:mockFetch,
  credentials:{
   read:async()=>hasKey?'sk-test-token':'',
   write:async()=>{hasKey=true;},
  },
 });
 registerKnowledgeGraphRoutes(app,root,workspace,{registry,fetch:mockFetch});

 try{
  const rootRes=await app.inject({method:'POST',url:'/api/workspace/roots',payload:{path:source}});
  assert.equal(rootRes.statusCode,201);
  const connected=rootRes.json<SourceRoot>();
  for(let i=0;i<100;i++){
   const r=(await app.inject('/api/workspace/roots')).json<{roots:SourceRoot[]}>();
   if(r.roots.find(x=>x.id===connected.id)?.status!=='scanning')break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  const {resources}=(await app.inject('/api/workspace/resources')).json<{resources:Resource[]}>();
  const study=resources.find(r=>r.name==='Study.pdf')!;
  const topic=(await app.inject({method:'POST',url:'/api/workspace/topics',payload:{title:'Fusion topic',resourceIds:[study.id]}})).json<ResearchTopic>();

  const textDir=path.join(root,'workspace','literature-text');
  await fs.mkdir(textDir,{recursive:true});
  await fs.writeFile(path.join(textDir,study.hash+'.json'),JSON.stringify({
   version:1,sourceHash:study.hash,pages:[{page:1,text:mockQuote}],
  }));

  // Write verified + unverified facts into analysis.json
  const analysisStore=createAnalysisStore(root);
  await analysisStore.save(topic.id,[{
   resourceId:study.id,
   filename:study.name,
   sourceHash:study.hash!,
   pageCount:1,
   title:'Study',
   model:'test-model',
   analyzedAt:'2026-11-22T00:00:00Z',
   facts:[
    {id:'f1',field:'problem',entity:'multi-hop retrieval drift',value:'多跳检索偏移问题',page:1,quote:mockQuote,verified:true},
    {id:'f2',field:'dataset',entity:'Hotpot-QA',value:'HotpotQA 数据集',page:1,quote:mockQuote,verified:true},
    {id:'f3',field:'model',entity:'UnverifiedModel',value:'未验证模型',page:1,quote:'fake',verified:false},
   ],
   directions:[],
  }],null);

  // 1. GET fuses verified analysis facts + local extraction and writes local cache
  const initialRes=await app.inject(`/api/workspace/topics/${topic.id}/knowledge-graph`);
  assert.equal(initialRes.statusCode,200);
  const initial=initialRes.json<KnowledgeGraphData>();
  const paper=initial.papers[0];
  assert.equal(paper.analysisFused,true);
  assert.ok(paper.relations.some(r=>r.predicate==='addresses'&&r.object.kind==='problem'&&r.source==='analysis'));
  assert.ok(paper.relations.some(r=>r.predicate==='evaluates_on'&&r.object.label==='HotpotQA'&&r.source==='analysis'));
  assert.ok(!paper.relations.some(r=>r.object.label==='UnverifiedModel'));

  // 2. POST /extract gracefully returns 400 when no AI model is configured
  const unconfigured=await app.inject({method:'POST',url:`/api/workspace/topics/${topic.id}/knowledge-graph/extract`,payload:{}});
  assert.equal(unconfigured.statusCode,400);

  // 3. Configure an assistant model & run POST /extract
  hasKey=true;
  const initialConfig=await registry.publicConfig();
  await registry.save(initialConfig.revision,data=>({
   ...data,
   providers:[{id:'mock',label:'MockAI',kind:'openai-compatible',baseUrl:'https://api.example.test/v1',plan:'',auth:'bearer',enabled:true,includeUsage:false,passReasoning:false}],
   models:[{id:'mock-chat',providerId:'mock',model:'mock-chat-v1',label:'MockChat',contextWindow:128000,reasoning:'none',enabled:true,toolCalling:'unknown'}],
   assistant:{...data.assistant,modelIds:['mock-chat'],defaultModelId:'mock-chat'},
  }));

  const extractRes=await app.inject({method:'POST',url:`/api/workspace/topics/${topic.id}/knowledge-graph/extract`,payload:{}});
  assert.equal(extractRes.statusCode,200,extractRes.body);
  const extracted=extractRes.json<{graph:KnowledgeGraphData;stats:{extractedPapers:number;verifiedRelations:number;rejectedRelations:number}}>();
  assert.equal(extracted.stats.extractedPapers,1);
  assert.equal(extracted.stats.verifiedRelations,1);
  assert.equal(extracted.stats.rejectedRelations,1);
  assert.ok(extracted.graph.papers[0].aiExtracted);
  assert.ok(extracted.graph.papers[0].relations.some(r=>r.predicate==='outperforms'&&r.object.label==='NaiveRAG'&&r.source==='ai'));
  assert.ok(!extracted.graph.papers[0].relations.some(r=>r.object.label==='HallucinatedBench'));

  // 4. Persisted knowledge-graph-ai.json auto-fuses on subsequent GET
  const afterRes=await app.inject(`/api/workspace/topics/${topic.id}/knowledge-graph`);
  assert.equal(afterRes.statusCode,200);
  const after=afterRes.json<KnowledgeGraphData>();
  assert.equal(after.papers[0].aiExtracted,true);
  assert.ok(after.papers[0].relations.some(r=>r.object.label==='NaiveRAG'&&r.source==='ai'));
 }finally{
  await app.close();
  await fs.rm(directory,{recursive:true,force:true});
 }
});
