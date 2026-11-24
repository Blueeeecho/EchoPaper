import fs from 'node:fs/promises';
import path from 'node:path';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {
 canonicalEntityLabel,
 entityName,
 knowledgeName,
 type KnowledgeEntity,
 type KnowledgeGraphData,
 type KnowledgePaper,
 type KnowledgePredicate,
 type KnowledgeRelation,
} from '../../shared/literature-graph';
import type {ArticleAnalysis} from '../../shared/literature-analysis';
import {isTranslationService} from '../../shared/model-providers';
import {compareResourceNames,paperTitle,uniquePaperResources} from '../../shared/resource-order';
import type {Resource} from '../../shared/workspace-types';
import {readCompletion} from '../ai-completion';
import {createProviderRegistry,type ProviderRegistry} from '../model-providers';
import {assertNoSymlinks,HttpError} from '../security';
import {atomicWrite,hash,withLock} from '../storage';
import {cachedLiteratureText,createAnalysisStore} from './analysis';
import type {WorkspaceService} from './index';
import {
 cleanProblemLabel,
 EXTRACTOR_VERSION,
 extractKnowledgeRelations,
 isNoisyEntity,
} from './knowledge-relations';
import type {ReadingTextBlock} from './reading-search';

export interface KnowledgeGraphRouteOptions {
 registry?:ProviderRegistry;
 fetch?:typeof fetch;
}

interface AiPaperEntry {
 sourceHash:string;
 model:string;
 extractedAt:string;
 relations:KnowledgeRelation[];
}

interface AiKnowledgeStoreFile {
 version:1;
 topicId:string;
 updatedAt:string;
 model:string;
 papers:Record<string,AiPaperEntry>;
}

const VALID_TOPIC_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const PREDICATE_ENUM=z.enum([
 'proposes',
 'addresses',
 'builds_on',
 'outperforms',
 'evaluates_on',
 'evaluates_with_model',
 'measures_with',
 'compares_with',
]);
const ENTITY_KIND_ENUM=z.enum(['method','problem','model','dataset','metric']);
const aiEntitySchema=z.object({
 kind:ENTITY_KIND_ENUM,
 label:z.string().trim().min(2).max(120),
}).strip();
const aiRelationSchema=z.object({
 subject:aiEntitySchema.nullable().optional(),
 predicate:PREDICATE_ENUM,
 object:aiEntitySchema,
 page:z.number().int().positive(),
 quote:z.string().trim().min(10).max(1200),
 translation:z.string().trim().max(800).optional(),
}).strip();
const aiOutputSchema=z.object({
 relations:z.array(aiRelationSchema).max(50),
}).strip();

const normalizeMatch=(value:string)=>value.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu,'').toLowerCase();

function blocksFingerprint(textSource:'ocr'|'pdf',title:string,blocks:ReadingTextBlock[]):string{
 const parts=[textSource,title,String(blocks.length)];
 for(const block of blocks){
  parts.push(`${block.page}:${block.text}:${block.translations?.[0]??''}`);
 }
 return hash(parts.join('\u0000')).slice(0,24);
}

function relationKey(relation:KnowledgeRelation):string{
 return JSON.stringify([
  relation.predicate,
  relation.subject?knowledgeName(canonicalEntityLabel(relation.subject.label,relation.subject.kind)):null,
  relation.object.kind,
  knowledgeName(canonicalEntityLabel(relation.object.label,relation.object.kind)),
 ]);
}

function analysisFactsToRelations(article:ArticleAnalysis):KnowledgeRelation[]{
 const out:KnowledgeRelation[]=[];
 for(const fact of article.facts){
  if(!fact.verified||!fact.quote?.trim())continue;
  let predicate:KnowledgePredicate|undefined;
  let kind:KnowledgeEntity['kind']|undefined;
  let rawLabel=entityName(fact);
  if(fact.field==='method'){
   predicate='proposes';
   kind='method';
  }else if(fact.field==='innovation'){
   if(rawLabel.length>76)continue;
   predicate='proposes';
   kind='method';
  }else if(fact.field==='problem'){
   predicate='addresses';
   kind='problem';
   rawLabel=cleanProblemLabel(rawLabel);
  }else if(fact.field==='model'){
   predicate='evaluates_with_model';
   kind='model';
  }else if(fact.field==='dataset'){
   predicate='evaluates_on';
   kind='dataset';
  }else{
   continue;
  }
  const label=kind==='problem'?rawLabel:canonicalEntityLabel(rawLabel,kind);
  if(!label||isNoisyEntity(label,kind))continue;
  const translation=fact.value.trim()&&fact.value.trim()!==label?fact.value.trim():undefined;
  out.push({
   predicate,
   object:{kind,label},
   page:fact.page,
   quote:fact.quote.trim(),
   translation,
   source:'analysis',
  });
 }
 return out;
}

function mergeRelations(
 local:KnowledgeRelation[],
 analysis:KnowledgeRelation[],
 ai:KnowledgeRelation[],
):KnowledgeRelation[]{
 // Keep natural local ordering when only local exists; prioritize verified AI > analysis > local on collisions
 const byKey=new Map<string,KnowledgeRelation>();
 const order:string[]=[];
 function upsert(item:KnowledgeRelation,preferOverwrite:boolean){
  const key=relationKey(item);
  const existing=byKey.get(key);
  if(!existing){
   byKey.set(key,item);
   order.push(key);
   return;
  }
  if(preferOverwrite){
   byKey.set(key,{
    ...item,
    translation:item.translation||existing.translation,
   });
  }else if(!existing.translation&&item.translation){
   byKey.set(key,{...existing,translation:item.translation});
  }
 }
 for(const rel of local)upsert(rel,false);
 for(const rel of analysis)upsert(rel,true);
 for(const rel of ai)upsert(rel,true);
 return order.map(key=>byKey.get(key)!);
}

function aggregatePages(blocks:ReadingTextBlock[]):{page:number;text:string}[]{
 const byPage=new Map<number,string[]>();
 for(const block of blocks){
  const list=byPage.get(block.page)??[];
  if(block.text.trim())list.push(block.text.trim());
  byPage.set(block.page,list);
 }
 return [...byPage.entries()]
  .sort((a,b)=>a[0]-b[0])
  .map(([page,parts])=>({page,text:parts.join('\n')}));
}

function selectAcademicExcerpt(pages:{page:number;text:string}[],maxChars=26000):string{
 const signal=/\b(?:abstract|introduction|method|methodology|approach|framework|propose|introduce|experiment|evaluation|benchmark|dataset|baseline|outperform|comparison|ablation|result|metric|accuracy|f1)\b|摘要|方法|实验|评测|数据集|对比|优于/gi;
 const refPage=/^\s*(?:references|bibliography|acknowledg(?:e)?ments?)\b/i;
 const scored=pages.map(page=>{
  const isEarly=page.page<=3;
  const isRef=refPage.test(page.text.slice(0,200));
  const hits=(page.text.match(signal)||[]).length;
  const score=(isEarly?1000-page.page*50:0)+(isRef?-200:hits*5);
  return {page,score};
 });
 const chosen:typeof pages=[];
 let used=0;
 for(const item of scored.sort((a,b)=>b.score-a.score)){
  if(used>=maxChars)break;
  const remaining=maxChars-used;
  const snippet=item.page.text.length>remaining?item.page.text.slice(0,remaining):item.page.text;
  chosen.push({page:item.page.page,text:snippet});
  used+=snippet.length+24;
 }
 chosen.sort((a,b)=>a.page-b.page);
 return chosen.map(p=>`[PDF PAGE ${p.page}]\n${p.text}`).join('\n\n');
}

function buildAiExtractionPrompt(title:string,excerpt:string):string{
 return `You are an academic knowledge-graph extractor. Extract high-signal, grounded structured academic relations from the paper text below.
Paper title: ${title}

Rules:
1. Output STRICT JSON ONLY (no markdown prose). Schema:
{"relations":[{"subject":{"kind":"method|problem|model|dataset|metric","label":"Canonical Name"}|null,"predicate":"proposes|addresses|builds_on|outperforms|evaluates_on|evaluates_with_model|measures_with|compares_with","object":{"kind":"method|problem|model|dataset|metric","label":"Canonical Name"},"page":1,"quote":"exact verbatim sentence or clause copied from [PDF PAGE N]","translation":"简短中文说明（可选）"}]}
2. Predicates:
   - proposes: paper proposes a named method/framework/system/benchmark (subject should be null so paper -> method)
   - addresses: paper or method addresses a concise core research problem (object kind="problem", 3-10 words)
   - builds_on: paper or method builds on / extends / adapts a prior method or model
   - outperforms: paper or method outperforms / surpasses a named baseline method or model
   - evaluates_on: paper or method is evaluated on a named dataset or benchmark (object kind="dataset")
   - evaluates_with_model: paper or method is evaluated with a named LLM/backbone model (object kind="model")
   - measures_with: paper or method reports a named evaluation metric (object kind="metric")
   - compares_with: paper or method compares against a named baseline method or model
3. Use canonical short entity names (e.g. GPT-4o, Llama-3-8B, Qwen2.5, GSM8K, MMLU-Pro, F1, Accuracy). NEVER output generic words (e.g. "our method", "Table 1", "Section 3", "LLMs", "baseline", "dataset").
4. Every relation MUST include a VERBATIM "quote" copied word-for-word from [PDF PAGE N] and the exact integer "page" N. Do NOT fabricate, paraphrase, or translate the quote.
5. Extract at most 24 highest-signal, non-redundant relations focusing on Abstract, Method, and Experiments.

Paper text:
${excerpt}`;
}

export function verifyAiRelations(
 rawText:string,
 pages:{page:number;text:string}[],
):{verified:KnowledgeRelation[];rejected:number}{
 const cleaned=rawText.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
 let parsed:unknown;
 try{
  parsed=JSON.parse(cleaned);
 }catch{
  const start=cleaned.indexOf('{'),end=cleaned.lastIndexOf('}');
  if(start>=0&&end>start){
   try{parsed=JSON.parse(cleaned.slice(start,end+1));}catch{return {verified:[],rejected:1};}
  }else{
   return {verified:[],rejected:1};
  }
 }
 const validated=aiOutputSchema.safeParse(parsed);
 if(!validated.success)return {verified:[],rejected:1};

 const normalizedPages=pages.map(p=>({page:p.page,norm:normalizeMatch(p.text)}));
 const byPageNum=new Map(normalizedPages.map(p=>[p.page,p.norm]));
 const seen=new Set<string>();
 const verified:KnowledgeRelation[]=[];
 let rejected=0;

 for(const item of validated.data.relations){
  const quoteNorm=normalizeMatch(item.quote);
  if(quoteNorm.length<10){rejected++;continue;}

  let matchedPage:number|undefined;
  const exactNorm=byPageNum.get(item.page);
  if(exactNorm&&exactNorm.includes(quoteNorm)){
   matchedPage=item.page;
  }else{
   const fallback=normalizedPages.find(p=>p.norm.includes(quoteNorm));
   if(fallback)matchedPage=fallback.page;
  }
  if(!matchedPage){rejected++;continue;}

  const objLabel=item.object.kind==='problem'
   ?cleanProblemLabel(item.object.label)
   :canonicalEntityLabel(item.object.label,item.object.kind);
  if(!objLabel||isNoisyEntity(objLabel,item.object.kind)){rejected++;continue;}

  let subj:KnowledgeEntity|undefined;
  if(item.subject){
   const subjLabel=item.subject.kind==='problem'
    ?cleanProblemLabel(item.subject.label)
    :canonicalEntityLabel(item.subject.label,item.subject.kind);
   if(subjLabel&&!isNoisyEntity(subjLabel,item.subject.kind)){
    subj={kind:item.subject.kind,label:subjLabel};
   }
  }
  if(subj&&subj.kind===item.object.kind&&knowledgeName(subj.label)===knowledgeName(objLabel)){
   rejected++;
   continue;
  }

  const relation:KnowledgeRelation={
   predicate:item.predicate,
   ...(subj?{subject:subj}:{}),
   object:{kind:item.object.kind,label:objLabel},
   page:matchedPage,
   quote:item.quote.trim(),
   ...(item.translation?.trim()?{translation:item.translation.trim()}:{}),
   source:'ai',
  };
  const key=relationKey(relation);
  if(seen.has(key))continue;
  seen.add(key);
  verified.push(relation);
 }
 return {verified,rejected};
}

export function registerKnowledgeGraphRoutes(
 app:FastifyInstance,
 root:string,
 workspace:WorkspaceService,
 options:KnowledgeGraphRouteOptions={},
){
 const upstream=options.fetch??fetch;
 const getRegistry=()=>options.registry??createProviderRegistry(root,{fetch:upstream});
 const analysisStore=createAnalysisStore(root);

 // Fast memory cache + disk cache keyed by sourceHash + blocksFingerprint + extractor version
 const blockWeakCache=new WeakMap<ReadingTextBlock[],{fingerprint:string;relations:KnowledgeRelation[]}>();
 const memoryCache=new Map<string,KnowledgeRelation[]>();

 async function readDiskCache(sourceHash:string,fingerprint:string):Promise<KnowledgeRelation[]|undefined>{
  if(!/^[a-f0-9]{64}$/.test(sourceHash))return;
  try{
   const filename=await assertNoSymlinks(root,`workspace/knowledge-graph-cache/${sourceHash}-v${EXTRACTOR_VERSION}.json`);
   const parsed=JSON.parse(await fs.readFile(filename,'utf8'));
   if(parsed?.version===EXTRACTOR_VERSION&&parsed.sourceHash===sourceHash&&parsed.fingerprint===fingerprint&&Array.isArray(parsed.relations)){
    return parsed.relations as KnowledgeRelation[];
   }
  }catch{
   // Miss or unreadable cache; recompute cleanly.
  }
 }

 async function writeDiskCache(sourceHash:string,fingerprint:string,relations:KnowledgeRelation[]):Promise<void>{
  if(!/^[a-f0-9]{64}$/.test(sourceHash))return;
  try{
   const filename=await assertNoSymlinks(root,`workspace/knowledge-graph-cache/${sourceHash}-v${EXTRACTOR_VERSION}.json`,true);
   await atomicWrite(filename,JSON.stringify({version:EXTRACTOR_VERSION,sourceHash,fingerprint,relations}));
  }catch{
   // Best-effort cache write; never fail graph rendering.
  }
 }

 async function extractCachedLocal(
  sourceHash:string,
  textSource:'ocr'|'pdf',
  title:string,
  blocks:ReadingTextBlock[],
 ):Promise<KnowledgeRelation[]>{
  const fingerprint=blocksFingerprint(textSource,title,blocks);
  const weakHit=blockWeakCache.get(blocks);
  if(weakHit&&weakHit.fingerprint===fingerprint)return weakHit.relations;

  const memKey=`${sourceHash}:${fingerprint}:v${EXTRACTOR_VERSION}`;
  const memHit=memoryCache.get(memKey);
  if(memHit){
   blockWeakCache.set(blocks,{fingerprint,relations:memHit});
   return memHit;
  }

  const diskHit=await readDiskCache(sourceHash,fingerprint);
  if(diskHit){
   if(memoryCache.size>400)memoryCache.clear();
   memoryCache.set(memKey,diskHit);
   blockWeakCache.set(blocks,{fingerprint,relations:diskHit});
   return diskHit;
  }

  const relations=extractKnowledgeRelations(blocks,{title});
  if(memoryCache.size>400)memoryCache.clear();
  memoryCache.set(memKey,relations);
  blockWeakCache.set(blocks,{fingerprint,relations});
  void writeDiskCache(sourceHash,fingerprint,relations);
  return relations;
 }

 function aiStoreRelative(topicId:string){
  if(!VALID_TOPIC_ID.test(topicId))throw new HttpError(400,'课题编号无效。');
  return `materials/${topicId}/文献分析/knowledge-graph-ai.json`;
 }

 async function readAiStore(topicId:string):Promise<AiKnowledgeStoreFile|undefined>{
  try{
   const filename=await assertNoSymlinks(root,aiStoreRelative(topicId));
   const parsed=JSON.parse(await fs.readFile(filename,'utf8')) as AiKnowledgeStoreFile;
   if(parsed?.version===1&&parsed.topicId===topicId&&parsed.papers&&typeof parsed.papers==='object'){
    return parsed;
   }
  }catch{
   // Missing or malformed AI store -> ignore gracefully.
  }
 }

 async function writeAiStore(topicId:string,doc:AiKnowledgeStoreFile):Promise<void>{
  await withLock(`knowledge-graph-ai:${root}:${topicId}`,async()=>{
   const filename=await assertNoSymlinks(root,aiStoreRelative(topicId),true);
   await atomicWrite(filename,JSON.stringify(doc,null,2)+'\n');
  });
 }

 async function resolveAssistantModel(requestedModelId?:string){
  try{
   const registry=getRegistry();
   const {data}=await registry.read();
   const candidates=requestedModelId
    ?[requestedModelId]
    :[...(data.assistant.defaultModelId?[data.assistant.defaultModelId]:[]),...data.assistant.modelIds];
   for(const modelId of candidates){
    const model=data.models.find(m=>m.id===modelId&&m.enabled&&data.assistant.modelIds.includes(m.id));
    if(!model)continue;
    const provider=data.providers.find(p=>p.id===model.providerId&&p.enabled&&!isTranslationService(p));
    if(!provider)continue;
    const key=await registry.getKey(provider);
    if(provider.auth==='bearer'&&!key)continue;
    return {registry,provider,model,key};
   }
  }catch{
   // Registry unreadable or unconfigured
  }
  return undefined;
 }

 async function loadPaperText(resource:Resource,peers:Resource[]):Promise<{textSource?:'ocr'|'pdf';blocks?:ReadingTextBlock[];textError?:boolean}>{
  if(resource.missing||!resource.hash)return {};
  let textError=false;
  for(const candidate of [resource,...peers.filter(peer=>peer.id!==resource.id)]){
   try{
    const blocks=await workspace.readingText(candidate);
    if(blocks)return {textSource:'ocr',blocks};
   }catch{
    textError=true;
   }
  }
  try{
   const pages=await cachedLiteratureText(root,resource.hash);
   if(pages?.some(page=>page.text.trim()))return {textSource:'pdf',blocks:pages};
  }catch{
   textError=true;
  }
  return textError?{textError:true}:{};
 }

 async function buildTopicGraph(topicId:string,aborted?:()=>boolean):Promise<KnowledgeGraphData>{
  const overview=await workspace.overview();
  const topic=overview.topics.find(value=>value.id===topicId);
  if(!topic)throw new HttpError(404,'课题不存在。');

  const selected=new Set(topic.resourceIds);
  const resources=workspace.resources().filter(resource=>resource.kind==='file'&&/\.pdf$/i.test(resource.name));
  const alternatives=new Map<string,Resource[]>();
  for(const resource of resources){
   if(resource.missing||!resource.hash)continue;
   const matches=alternatives.get(resource.hash)??[];
   matches.push(resource);
   alternatives.set(resource.hash,matches);
  }
  const pdfs=uniquePaperResources(resources.filter(resource=>selected.has(resource.id))).sort(compareResourceNames);

  // Best-effort read of analysis.json & persisted AI extraction
  const [analysisArticles,aiStore,assistantModel]=await Promise.all([
   analysisStore.read(topicId).then(file=>file.document.articles).catch(()=>[] as ArticleAnalysis[]),
   readAiStore(topicId),
   resolveAssistantModel(),
  ]);
  const analysisByResource=new Map(analysisArticles.map(article=>[article.resourceId,article]));

  async function buildPaper(resource:Resource):Promise<KnowledgePaper>{
   const title=paperTitle(resource);
   const sourceHash=resource.hash||'';
   const base:KnowledgePaper={resourceId:resource.id,title,sourceHash,relations:[]};
   if(resource.missing||!sourceHash)return base;

   const loaded=await loadPaperText(resource,alternatives.get(sourceHash)??[]);
   let localRelations:KnowledgeRelation[]=[];
   if(loaded.textSource&&loaded.blocks){
    localRelations=await extractCachedLocal(sourceHash,loaded.textSource,title,loaded.blocks);
   }

   const analysisArticle=analysisByResource.get(resource.id);
   const matchedAnalysis=analysisArticle&&analysisArticle.sourceHash===sourceHash?analysisArticle:undefined;
   const analysisRelations=matchedAnalysis?analysisFactsToRelations(matchedAnalysis):[];

   const aiEntry=aiStore?.papers[resource.id];
   const matchedAi=aiEntry&&aiEntry.sourceHash===sourceHash?aiEntry:undefined;
   const aiRelations=matchedAi?matchedAi.relations:[];

   const relations=mergeRelations(localRelations,analysisRelations,aiRelations);
   return {
    ...base,
    ...(loaded.textSource?{textSource:loaded.textSource}:{}),
    ...(loaded.textError&&!loaded.textSource?{textError:true}:{}),
    ...(analysisRelations.length?{analysisFused:true}:{}),
    ...(matchedAi?{aiExtracted:true,aiModel:matchedAi.model}:{}),
    relations,
   };
  }

  const papers:KnowledgePaper[]=[];
  for(let index=0;index<pdfs.length&&!aborted?.();index+=4){
   const batch=await Promise.all(pdfs.slice(index,index+4).map(buildPaper));
   papers.push(...batch);
  }
  return {
   papers,
   aiConfigured:!!assistantModel,
   ...(aiStore?.updatedAt?{aiUpdatedAt:aiStore.updatedAt}:{}),
  };
 }

 app.get<{Params:{id:string}}>('/api/workspace/topics/:id/knowledge-graph',async(request,reply):Promise<KnowledgeGraphData>=>{
  return buildTopicGraph(request.params.id,()=>reply.raw.destroyed);
 });

 app.post<{
  Params:{id:string};
  Body?:{resourceIds?:string[];force?:boolean;model?:string};
 }>('/api/workspace/topics/:id/knowledge-graph/extract',async(request,reply)=>{
  const topicId=request.params.id;
  if(!VALID_TOPIC_ID.test(topicId))throw new HttpError(400,'课题编号无效。');
  const overview=await workspace.overview();
  const topic=overview.topics.find(value=>value.id===topicId);
  if(!topic)throw new HttpError(404,'课题不存在。');

  const body=request.body??{};
  const resolved=await resolveAssistantModel(body.model);
  if(!resolved){
   throw new HttpError(400,'尚未配置可用的助手模型，请先在「模型设置」中启用助手模型并填写 API 密钥后再使用 AI 深度建图。');
  }
  const {registry,provider,model,key}=resolved;

  const selected=new Set(topic.resourceIds);
  const filterSet=Array.isArray(body.resourceIds)&&body.resourceIds.length?new Set(body.resourceIds):undefined;
  const resources=workspace.resources().filter(resource=>resource.kind==='file'&&/\.pdf$/i.test(resource.name));
  const alternatives=new Map<string,Resource[]>();
  for(const resource of resources){
   if(resource.missing||!resource.hash)continue;
   const matches=alternatives.get(resource.hash)??[];
   matches.push(resource);
   alternatives.set(resource.hash,matches);
  }
  const pdfs=uniquePaperResources(resources.filter(resource=>selected.has(resource.id)&&(!filterSet||filterSet.has(resource.id)))).sort(compareResourceNames);

  const existingStore=await readAiStore(topicId);
  const storeDoc:AiKnowledgeStoreFile={
   version:1,
   topicId,
   updatedAt:new Date().toISOString(),
   model:model.label,
   papers:{...(existingStore?.papers??{})},
  };

  let extractedPapers=0,skippedPapers=0,failedPapers=0,verifiedRelations=0,rejectedRelations=0;

  for(const resource of pdfs){
   if(reply.raw.destroyed)break;
   if(resource.missing||!resource.hash){skippedPapers++;continue;}
   const existing=storeDoc.papers[resource.id];
   if(!body.force&&existing&&existing.sourceHash===resource.hash){
    skippedPapers++;
    continue;
   }
   const loaded=await loadPaperText(resource,alternatives.get(resource.hash)??[]);
   if(!loaded.blocks?.length){skippedPapers++;continue;}

   const pages=aggregatePages(loaded.blocks);
   if(!pages.length){skippedPapers++;continue;}
   const excerpt=selectAcademicExcerpt(pages);
   const title=paperTitle(resource);

   const controller=new AbortController();
   const timeout=setTimeout(()=>controller.abort(),90000);
   try{
    const release=await registry.scheduler.acquire(provider,'assistant',controller.signal);
    let rawText='';
    try{
     const response=await upstream(provider.baseUrl+'/chat/completions',{
      method:'POST',
      redirect:'error',
      signal:controller.signal,
      headers:{'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{})},
      body:JSON.stringify({
       model:model.model,
       stream:true,
       messages:[
        {role:'system',content:'You extract grounded academic knowledge-graph triples from papers and respond with strict JSON only.'},
        {role:'user',content:buildAiExtractionPrompt(title,excerpt)},
       ],
       ...(provider.kind==='minimax'?{reasoning_split:true}:{}),
       ...(model.reasoning!=='none'?{reasoning_effort:'low'}:{}),
      }),
     });
     if(!response.ok){
      failedPapers++;
      continue;
     }
     const contentType=response.headers.get('content-type')||'';
     if(contentType.includes('application/json')&&!contentType.includes('text/event-stream')){
      const json=await response.json() as {choices?:{message?:{content?:string}}[]};
      rawText=json.choices?.[0]?.message?.content||'';
     }else{
      const result=await readCompletion(response,model.model,()=>{});
      rawText=result.text;
     }
    }finally{
     release();
    }
    const checked=verifyAiRelations(rawText,pages);
    verifiedRelations+=checked.verified.length;
    rejectedRelations+=checked.rejected;
    storeDoc.papers[resource.id]={
     sourceHash:resource.hash,
     model:model.label,
     extractedAt:new Date().toISOString(),
     relations:checked.verified,
    };
    extractedPapers++;
   }catch{
    failedPapers++;
   }finally{
    clearTimeout(timeout);
   }
  }

  storeDoc.updatedAt=new Date().toISOString();
  if(extractedPapers>0){
   await writeAiStore(topicId,storeDoc);
  }
  const graph=await buildTopicGraph(topicId,()=>reply.raw.destroyed);
  return {
   graph,
   stats:{
    extractedPapers,
    skippedPapers,
    failedPapers,
    verifiedRelations,
    rejectedRelations,
    model:model.label,
   },
  };
 });
}
