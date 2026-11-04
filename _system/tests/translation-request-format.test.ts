import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {registerAiRoutes} from '../server/ai';
import {normalizeRegistry} from '../server/model-providers';
import {configuredTranslationAdapters} from '../src/translationAdapters';
import type {ModelProvider,ProviderModel,PublicRegistry} from '../shared/model-providers';

// Both HTTP hops use the native transport and ephemeral loopback servers. No
// Keychain, user workspace, real model, or externally reachable endpoint is used.
const nativeFetch=globalThis.fetch.bind(globalThis);
const fakeKey='translation-format-test-key';
const assistantSentinel='ASSISTANT_PRIVATE_CONTEXT_MUST_NOT_ENTER_TRANSLATION';
const selection={projectId:'Paper',text:'Evidence',target:'zh-CN' as const,source:'pdf' as const,sourceLanguage:'en' as const};
interface ObservedRequest{url:string;contentType:string;body:any}

async function fixture(t:TestContext){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-translation-format-'));
 const upstreamCalls:ObservedRequest[]=[],requests:ObservedRequest[]=[];
 const upstream=Fastify({forceCloseConnections:true}),app=Fastify({forceCloseConnections:true});
 t.after(async()=>{await app.close();await upstream.close();await fs.rm(workspace,{recursive:true,force:true});});
 upstream.post('/v1/chat/completions',async(request,reply)=>{
  upstreamCalls.push({url:request.url,contentType:String(request.headers['content-type']||''),body:request.body});
  return reply.type('text/event-stream').send([
   {model:'fixture-translator',choices:[{delta:{content:'证'},finish_reason:null}]},
   {model:'fixture-translator',choices:[{delta:{content:'据'},finish_reason:'stop'}]},
  ].map(packet=>'data: '+JSON.stringify(packet)+'\n\n').join('')+'data: [DONE]\n\n');
 });
 upstream.post('/v2/translate',async(request)=>{
  upstreamCalls.push({url:request.url,contentType:String(request.headers['content-type']||''),body:request.body});
  assert.equal(request.headers.authorization,'DeepL-Auth-Key '+fakeKey);
  return{translations:[{text:'证据'}]};
 });
 const upstreamOrigin=await upstream.listen({host:'127.0.0.1',port:0});
 const providers:ModelProvider[]=[
  {id:'llm',label:'Local mock LLM',kind:'openai-compatible',baseUrl:upstreamOrigin+'/v1',plan:'test',auth:'none',enabled:true,includeUsage:false,passReasoning:false},
  {id:'deepl',label:'Local mock DeepL',kind:'deepl',baseUrl:upstreamOrigin+'/v2',plan:'test',auth:'bearer',enabled:true,includeUsage:false,passReasoning:false},
 ];
 const models:ProviderModel[]=[
  {id:'llm-model',providerId:'llm',label:'Translator',model:'fixture-translator',contextWindow:32000,reasoning:'none',enabled:true},
  {id:'deepl-model',providerId:'deepl',label:'Dedicated translator',model:'text-translation',contextWindow:0,reasoning:'none',enabled:true},
 ];
 const data=normalizeRegistry({version:1,providers,models,translations:models.map(model=>({id:'source-'+model.providerId,label:model.label,modelId:model.id,enabled:true,color:'#556677'})),translationLayout:'stack'},'llm-model');
 data.assistant.roles=data.assistant.roles.map(role=>({...role,instructions:assistantSentinel}));
 await fs.mkdir(path.join(workspace,'_system/runtime'),{recursive:true});
 await fs.writeFile(path.join(workspace,'_system/runtime/model-providers.json'),JSON.stringify(data));
 await fs.mkdir(path.join(workspace,'papers/Paper/notes'),{recursive:true});
 await fs.mkdir(path.join(workspace,'papers/Paper/manuscript'),{recursive:true});
 await fs.writeFile(path.join(workspace,'papers/Paper/project.json'),'{}');
 await fs.writeFile(path.join(workspace,'papers/Paper/manuscript/main.tex'),assistantSentinel);
 await fs.writeFile(path.join(workspace,'papers/Paper/notes/ai-conversations.json'),JSON.stringify({chats:[{id:'old-chat',messages:[{role:'user',content:assistantSentinel}]}]}));
 app.setErrorHandler((error:any,_request,reply)=>reply.code(error.statusCode||500).send({error:error.message,...error.extra}));
 app.addHook('preValidation',async request=>{
  if(request.url==='/api/ai/translate')requests.push({url:request.url,contentType:String(request.headers['content-type']||''),body:request.body});
 });
 await registerAiRoutes(app,workspace,{
  getKey:async()=>fakeKey,
  credentials:{read:async()=>fakeKey,write:async()=>{throw Error('The test must never write credentials.');}},
  fetch:async(input,init)=>{
   assert.equal(new URL(String(input)).origin,upstreamOrigin,'an upstream request must stay on the local mock server');
   return nativeFetch(input,init);
  },
 });
 const origin=await app.listen({host:'127.0.0.1',port:0});
 const configResponse=await nativeFetch(origin+'/api/ai/providers');
 assert.equal(configResponse.status,200);
 const config=await configResponse.json() as PublicRegistry;
 const post=(patch:Record<string,unknown>={},headers:HeadersInit={'Content-Type':'application/json'})=>nativeFetch(origin+'/api/ai/translate',{method:'POST',headers,body:JSON.stringify({...selection,sourceId:'source-llm',...patch})});
 return{origin,config,requests,upstreamCalls,post};
}

test('configured translation adapters serialize JSON over real HTTP and consume terminal NDJSON for LLM and dedicated engines',async t=>{
 const f=await fixture(t),originalFetch=globalThis.fetch;
 const responses:{contentType:string;body:Promise<string>}[]=[];
 // Node has no document base URL. Resolve only the browser-relative URL, then
 // forward the original init untouched; the real server parses actual bytes.
 // Returning a synthetic Response here would hide the missing JSON header bug.
 globalThis.fetch=async(input,init)=>{
  assert.equal(input,'/api/ai/translate');
  const response=await nativeFetch(new URL(String(input),f.origin),init);
  responses.push({contentType:response.headers.get('content-type')||'',body:response.clone().text()});
  return response;
 };
 t.after(()=>{globalThis.fetch=originalFetch;});
 const adapters=configuredTranslationAdapters(f.config);
 assert.deepEqual(adapters.map(adapter=>adapter.id),['source-llm','source-deepl']);
 for(const adapter of adapters){
  const partial:string[]=[];
  const translated=await adapter.translate(selection,AbortSignal.timeout(3000),text=>partial.push(text));
  assert.equal(translated,'证据');assert.equal(partial.at(-1),'证据');
 }
 assert.equal(f.requests.length,2);
 for(const request of f.requests){
  assert.match(request.contentType,/^application\/json(?:;|$)/i);
  assert.equal(typeof request.body,'object');
  assert.deepEqual(Object.keys(request.body).sort(),['projectId','source','sourceId','sourceLanguage','target','text']);
  assert.equal(request.body.text,'Evidence');
 }
 for(const response of responses){
  assert.match(response.contentType,/^application\/x-ndjson/i);
  const events=(await response.body).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(events.at(-1)?.type,'done');assert.equal(events.at(-1)?.finishReason,'stop');
  assert.equal(events.filter(event=>event.type==='delta').map(event=>event.text).join(''),'证据');
  assert.ok(events.every(event=>event.type==='delta'||event.type==='done'));
 }
 assert.equal(f.upstreamCalls.length,2);
 const llm=f.upstreamCalls.find(call=>call.url==='/v1/chat/completions')!.body;
 assert.equal(llm.messages.length,2);assert.match(llm.messages[0].content,/学术译者/);
 assert.deepEqual(llm.messages.map((message:any)=>message.role),['system','user']);
 assert.equal(llm.model,'fixture-translator');assert.equal(llm.stream,true);
 assert.deepEqual(f.upstreamCalls.find(call=>call.url==='/v2/translate')!.body,{text:['Evidence'],target_lang:'ZH',source_lang:'EN',preserve_formatting:true});
 for(const request of f.upstreamCalls){
  assert.match(request.contentType,/^application\/json(?:;|$)/i);
  assert.ok(!JSON.stringify(request.body).includes(assistantSentinel));
  for(const field of['history','context','checkpoint','tools','conversationId','projectId'])assert.equal(request.body[field],undefined);
 }
});

test('native fetch JSON string without a JSON header reports request format, not a selection length error',async t=>{
 const f=await fixture(t);
 // A string body causes native fetch to use text/plain; this reproduces the
 // browser request that previously mislabeled a short selection as >6000.
 const response=await nativeFetch(f.origin+'/api/ai/translate',{method:'POST',body:JSON.stringify({...selection,sourceId:'source-llm'})});
 assert.equal(response.status,400);
 const body=await response.json();assert.match(body.error,/JSON|请求格式/i);assert.doesNotMatch(body.error,/6000/);
 assert.match(f.requests[0].contentType,/^text\/plain/i);assert.equal(typeof f.requests[0].body,'string');
 assert.equal(f.upstreamCalls.length,0);
});

test('a real 6001-character selection is rejected before any upstream request; 6000 remains accepted',async t=>{
 const f=await fixture(t),response=await f.post({text:'x'.repeat(6001)});
 assert.equal(response.status,400);const error=await response.json();assert.match(error.error,/6000/);
 assert.equal(error.field,'text');assert.equal(error.actualCharacters,6001);assert.equal(error.maxCharacters,6000);
 assert.equal(f.upstreamCalls.length,0);
 const boundary=await f.post({text:'x'.repeat(6000)});assert.equal(boundary.status,200);
 const events=(await boundary.text()).trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(events.at(-1)?.type,'done');assert.equal(events.at(-1)?.finishReason,'stop');
 assert.equal(f.upstreamCalls.length,1);
});

test('the 6000-character boundary counts Unicode code points rather than UTF-16 units',async t=>{
 const f=await fixture(t),astral='🖋';
 assert.equal(astral.length,2,'the fixture must contain a supplementary Unicode character');
 const tooLong=await f.post({text:astral.repeat(6001)});
 assert.equal(tooLong.status,400);
 const error=await tooLong.json();assert.match(error.error,/6001/);assert.match(error.error,/6000/);
 assert.equal(error.field,'text');assert.equal(error.actualCharacters,6001);assert.equal(error.maxCharacters,6000);
 assert.equal(f.upstreamCalls.length,0);
 const allowed=await f.post({text:astral.repeat(6000)});assert.equal(allowed.status,200);
 const events=(await allowed.text()).trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(events.at(-1)?.type,'done');assert.equal(events.at(-1)?.finishReason,'stop');
 assert.equal(f.upstreamCalls.length,1);
 const user=f.upstreamCalls[0].body.messages.at(-1).content as string;
 assert.ok(user.includes(astral.repeat(6000)),'the accepted selection must reach the translator without truncation');
});

test('invalid language and selection source fields report their own errors without invoking a model',async t=>{
 const f=await fixture(t);
 for(const[patch,field]of[
  [{target:'fr'},/目标.*(?:语种|语言)/],
  [{sourceLanguage:'fr'},/(?:原文|源).*(?:语种|语言)/],
  [{source:'document'},/来源/],
 ] as const){
  const response=await f.post(patch);assert.equal(response.status,400);
  const body=await response.json();assert.match(body.error,field);assert.doesNotMatch(body.error,/6000/);
 }
 assert.equal(f.upstreamCalls.length,0);
});
