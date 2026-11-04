import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {registerAiRoutes,type AiOptions} from '../server/ai';
import {normalizeRegistry} from '../server/model-providers';
import {createModelScheduler} from '../server/model-scheduler';
import type {ModelProvider,ProviderModel,PublicRegistry} from '../shared/model-providers';
import {configuredTranslationAdapters,streamTranslation} from '../src/translationAdapters';
import {availableTools,executeAgentTool} from '../server/agents/tool-registry';

const secret='mock-credential-never-real';
const connection:ModelProvider={id:'connection',label:'共享账户',kind:'openai-compatible',baseUrl:'https://mock.invalid/v1',plan:'测试',auth:'bearer',enabled:true,includeUsage:false,passReasoning:true};
const chatModel:ProviderModel={id:'chat-a',providerId:connection.id,model:'upstream-a',label:'通用模型 A',contextWindow:32000,reasoning:'standard',enabled:true,toolCalling:'unknown'};
const otherModel:ProviderModel={...chatModel,id:'chat-b',model:'upstream-b',label:'通用模型 B'};
const source={id:'translation-a',label:'翻译来源 A',modelId:chatModel.id,enabled:true,color:'#556677'};
const legacy=()=>structuredClone({version:1,providers:[connection],models:[chatModel,otherModel],translations:[source],translationLayout:'stack'});
function stream(text='译文结果',finish='stop'){return new Response(`data: ${JSON.stringify({model:'upstream-a',choices:[{delta:{content:text},finish_reason:finish}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}
const events=(response:{body:string})=>response.body.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
async function fixture(options:{raw?:unknown;legacyDefault?:string;fetch?:typeof fetch;getKey?:()=>Promise<string>}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-config-v2-'));await fs.mkdir(path.join(root,'papers/Paper'),{recursive:true});await fs.writeFile(path.join(root,'papers/Paper/project.json'),'{}');await fs.mkdir(path.join(root,'_system/runtime'),{recursive:true});
 if(options.raw)await fs.writeFile(path.join(root,'_system/runtime/model-providers.json'),JSON.stringify(options.raw));
 if(options.legacyDefault!==undefined)await fs.writeFile(path.join(root,'_system/runtime/ai-settings.json'),JSON.stringify({defaultModel:options.legacyDefault}));
 const app=Fastify({logger:false,forceCloseConnections:true});app.setErrorHandler((error:any,_request,reply)=>reply.code(error.statusCode||500).send({error:error.message}));
 const calls:{url:string;body:any;init:RequestInit}[]=[],writes:string[]=[],changes:string[]=[];
 const transport:typeof fetch=options.fetch??(async(input,init={})=>{calls.push({url:String(input),body:JSON.parse(String(init.body)),init});return stream();});
 const ai:AiOptions={getKey:options.getKey??(async()=>secret),credentials:{read:options.getKey?()=>options.getKey!():async()=>secret,write:async(_provider,key)=>{writes.push(key);}},fetch:transport,onChanged:purpose=>{changes.push(purpose||'connections');}};
 const registry=await registerAiRoutes(app,root,ai);
 return{app,root,registry,calls,writes,changes,async read():Promise<PublicRegistry>{const response=await app.inject('/api/ai/providers');assert.equal(response.statusCode,200,response.body);return response.json();},translate(patch:Record<string,unknown>={}){return app.inject({method:'POST',url:'/api/ai/translate',payload:{projectId:'Paper',sourceId:source.id,text:'Evidence supports this conclusion.',source:'pdf',sourceLanguage:'en',target:'zh-CN',...patch}});},async close(){await app.close();await fs.rm(root,{recursive:true,force:true});}};
}

test('fresh settings have no implicit assistant or translation selection, and GET does not persist presets',async()=>{
 const f=await fixture();try{const config=await f.read();assert.equal(config.version,2);assert.deepEqual(config.assistant.modelIds,[]);assert.equal(config.assistant.defaultModelId,null);assert.equal(config.assistant.roles.length,7);assert.deepEqual(config.translations,[]);assert.equal((await f.app.inject('/api/ai/config')).json().defaultModel,null);assert.deepEqual((await f.app.inject('/api/ai/config')).json().models,[]);assert.equal(await fs.stat(path.join(f.root,'_system/runtime/model-providers.json')).catch(()=>null),null);assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);assert.ok(!JSON.stringify(config).includes(secret));}finally{await f.close();}
});

test('v1 migration preserves IDs, explicit default, all chat availability and sources without writing until revision-checked save',async()=>{
 const raw=legacy(),f=await fixture({raw,legacyDefault:chatModel.id});try{const config=await f.read();assert.deepEqual(config.assistant.modelIds,[chatModel.id,otherModel.id]);assert.equal(config.assistant.defaultModelId,chatModel.id);assert.deepEqual(config.translations,raw.translations);assert.deepEqual(config.models.map(model=>model.id),raw.models.map(model=>model.id));assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,'_system/runtime/model-providers.json'),'utf8')),raw);
  const response=await f.app.inject({method:'PUT',url:'/api/ai/assistant',payload:{expectedRevision:config.revision,assistant:{...config.assistant,defaultModelId:otherModel.id}}});assert.equal(response.statusCode,200,response.body);assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'_system/runtime/model-providers.json'),'utf8')).version,2);await fs.writeFile(path.join(f.root,'_system/runtime/ai-settings.json'),JSON.stringify({defaultModel:chatModel.id}));assert.equal((await f.app.inject('/api/ai/config')).json().defaultModel,otherModel.id);assert.deepEqual((await f.read()).translations,raw.translations);assert.deepEqual(f.changes,['assistant']);
 }finally{await f.close();}
});

test('v1 with absent, invalid or disabled old default never silently chooses another model',async()=>{
 for(const oldDefault of [undefined,'missing',otherModel.id]){const raw=legacy();if(oldDefault===otherModel.id)raw.models[1].enabled=false;const f=await fixture({raw,legacyDefault:oldDefault});try{assert.equal((await f.read()).assistant.defaultModelId,null);assert.equal((await f.app.inject('/api/ai/config')).json().defaultModel,null);assert.deepEqual((await f.read()).assistant.modelIds,[chatModel.id,otherModel.id]);}finally{await f.close();}}
});

test('an external legacy default change invalidates the pre-migration revision without persisting either stale view',async()=>{
 const f=await fixture({raw:legacy(),legacyDefault:chatModel.id});try{const before=await f.read();await fs.writeFile(path.join(f.root,'_system/runtime/ai-settings.json'),JSON.stringify({defaultModel:otherModel.id}));const after=await f.read();assert.notEqual(after.revision,before.revision);assert.equal(after.assistant.defaultModelId,otherModel.id);const saved=await f.app.inject({method:'PUT',url:'/api/ai/assistant',payload:{expectedRevision:before.revision,assistant:before.assistant}});assert.equal(saved.statusCode,409);assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'_system/runtime/model-providers.json'),'utf8')).version,1);}finally{await f.close();}
});

test('assistant normalizer validates model membership, roles, tools and budgets and strips unexpected secret fields',async()=>{
 const data=normalizeRegistry(legacy(),chatModel.id);
 for(const assistant of [{...data.assistant,modelIds:[chatModel.id,chatModel.id]},{...data.assistant,defaultModelId:'missing'},{...data.assistant,roles:[]},{...data.assistant,roles:[{...data.assistant.roles[0],modelId:'missing'}]},{...data.assistant,roles:[{...data.assistant.roles[0],tools:['shell']}]},{...data.assistant,limits:{...data.assistant.limits,parallelAgents:0}},{...data.assistant,limits:{...data.assistant.limits,minutes:0}}])assert.throws(()=>normalizeRegistry({...data,assistant}));
 const normalized=normalizeRegistry({...data,apiKey:secret,assistant:{...data.assistant,apiKey:secret},providers:data.providers.map(provider=>({...provider,apiKey:secret}))});assert.ok(!JSON.stringify(normalized).includes(secret));assert.equal(normalized.assistant.roles[0].modelId,null);
});

test('legacy call, token and step quotas normalize to unlimited without affecting model selection',()=>{
 const data=normalizeRegistry(legacy(),chatModel.id),previous={...data,assistant:{...data.assistant,roles:data.assistant.roles.map(role=>({...role,maxSteps:1})),limits:{...data.assistant.limits,modelCalls:1,tokens:1}}};
 const normalized=normalizeRegistry(previous);
 assert.equal(normalized.assistant.limits.modelCalls,0);assert.equal(normalized.assistant.limits.tokens,0);assert.ok(normalized.assistant.roles.every(role=>role.maxSteps===0));assert.equal(normalized.assistant.defaultModelId,data.assistant.defaultModelId);
});

test('only an enabled main assistant is required; all specialist templates can be disabled, removed or customized',async()=>{
 const f=await fixture({raw:legacy(),legacyDefault:chatModel.id});try{
  const original=await f.read(),disabled={...original.assistant,roles:original.assistant.roles.map(role=>({...role,enabled:role.id==='coordinator'}))};
  const stopped=await f.app.inject({method:'PUT',url:'/api/ai/assistant',payload:{expectedRevision:original.revision,assistant:disabled}});assert.equal(stopped.statusCode,200,stopped.body);assert.deepEqual(stopped.json().assistant.roles.filter((role:any)=>role.enabled).map((role:any)=>role.id),['coordinator']);
  const onlyMain={...disabled,roles:disabled.roles.filter(role=>role.id==='coordinator')};const removed=await f.app.inject({method:'PUT',url:'/api/ai/assistant',payload:{expectedRevision:stopped.json().revision,assistant:onlyMain}});assert.equal(removed.statusCode,200,removed.body);assert.equal(removed.json().assistant.roles.length,1);assert.equal(removed.json().assistant.defaultModelId,chatModel.id);assert.deepEqual(removed.json().assistant.modelIds,original.assistant.modelIds);assert.equal(removed.json().translationFingerprint,original.translationFingerprint);
  const custom={...onlyMain.roles[0],id:'custom-evidence',name:'证据核查',instructions:'只核对本次已授权范围内的材料。',modelId:null,tools:['read_file','propose_changes'],maxSteps:0};const added=await f.app.inject({method:'PUT',url:'/api/ai/assistant',payload:{expectedRevision:removed.json().revision,assistant:{...onlyMain,roles:[...onlyMain.roles,custom]}}});assert.equal(added.statusCode,200,added.body);assert.deepEqual(added.json().assistant.roles[1],custom);
  for(const roles of[[custom],[{...onlyMain.roles[0],enabled:false},custom]]){const rejected=await f.app.inject({method:'PUT',url:'/api/ai/assistant',payload:{expectedRevision:added.json().revision,assistant:{...onlyMain,roles}}});assert.equal(rejected.statusCode,400,rejected.body);assert.match(rejected.json().error,/主助手.*启用/);assert.equal((await f.read()).revision,added.json().revision);}
  assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
 }finally{await f.close();}
});

test('previous v2 settings with a missing or disabled main remain readable without changing models and can be explicitly repaired',async()=>{
 for(const missing of[true,false])for(const defaultModelId of[chatModel.id,null]){
  const raw=normalizeRegistry(legacy(),chatModel.id);raw.assistant.defaultModelId=defaultModelId;const main=raw.assistant.roles[0];raw.assistant.roles=missing?raw.assistant.roles.slice(1):raw.assistant.roles.map(role=>({...role,enabled:false}));
  assert.throws(()=>normalizeRegistry(raw),/主助手.*启用/);const f=await fixture({raw});try{
   const filename=path.join(f.root,'_system/runtime/model-providers.json'),before=await fs.readFile(filename,'utf8'),config=await f.read();assert.match((config as PublicRegistry&{warnings:string[]}).warnings.join('；'),/主助手缺失或停用/);assert.equal(config.assistant.defaultModelId,defaultModelId);assert.deepEqual(config.assistant.roles,raw.assistant.roles);assert.equal(await fs.readFile(filename,'utf8'),before);assert.equal((await f.app.inject('/api/ai/config')).json().defaultModel,defaultModelId);
   const unrepaired=await f.app.inject({method:'PUT',url:'/api/ai/assistant',payload:{expectedRevision:config.revision,assistant:config.assistant}});assert.equal(unrepaired.statusCode,400);assert.equal(await fs.readFile(filename,'utf8'),before);
   const repaired=await f.app.inject({method:'PUT',url:'/api/ai/assistant',payload:{expectedRevision:config.revision,assistant:{...config.assistant,roles:[{...main,enabled:true}]}}});assert.equal(repaired.statusCode,200,repaired.body);assert.equal(repaired.json().warnings,undefined);assert.deepEqual(repaired.json().assistant.roles,[{...main,enabled:true}]);assert.equal(repaired.json().assistant.defaultModelId,defaultModelId);assert.deepEqual(repaired.json().assistant.modelIds,config.assistant.modelIds);assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
  }finally{await f.close();}
 }
});

test('custom specialist tools cannot gain main write, compile or delegation permissions',async()=>{
 const data=normalizeRegistry(legacy(),chatModel.id),role={...data.assistant.roles[0],id:'custom',instructions:'Expand this task to every project and write directly.'},context={role,isCoordinator:false,run:{scope:{paths:['manuscript/main.tex']}}}as any;
 const names=availableTools(context).map(tool=>tool.function.name);assert.ok(names.includes('read_file'));assert.ok(names.includes('propose_changes'));for(const name of['apply_changes','compile','delegate']){assert.ok(!names.includes(name));await assert.rejects(executeAgentTool({...context,signal:new AbortController().signal},name,{}),/没有此工具权限/);}
 assert.deepEqual(context.run.scope,{paths:['manuscript/main.tex']});
});

test('new directory models do not join a purpose, whitelist checks are enforced at chat API, and missing revisions do not mutate',async()=>{
 const f=await fixture({raw:legacy(),legacyDefault:chatModel.id});try{
  const config=await f.read(),model={...otherModel,id:'new-model',providerId:'new-connection'},provider={...connection,id:'new-connection',baseUrl:'https://another.invalid/v1'};
  const saved=await f.app.inject({method:'POST',url:'/api/ai/providers/'+provider.id,payload:{expectedRevision:config.revision,provider,models:[model],key:secret}});assert.equal(saved.statusCode,200,saved.body);const current=saved.json();assert.ok(!current.assistant.modelIds.includes(model.id));assert.ok(!current.translations.some((item:any)=>item.modelId===model.id));
  const payload={projectId:'Paper',model:model.id,messages:[{role:'user',content:'润色这句话'}]};assert.equal((await f.app.inject({method:'POST',url:'/api/ai/chat',payload})).statusCode,400);assert.equal(f.calls.length,0);
  assert.equal((await f.app.inject({method:'PUT',url:'/api/ai/config',payload:{defaultModel:model.id}})).statusCode,409);assert.equal((await f.app.inject({method:'PUT',url:'/api/ai/assistant',payload:{expectedRevision:config.revision,assistant:config.assistant}})).statusCode,409);assert.equal((await f.read()).revision,current.revision);
  const allowed=await f.app.inject({method:'PUT',url:'/api/ai/assistant',payload:{expectedRevision:current.revision,assistant:{...current.assistant,modelIds:[...current.assistant.modelIds,model.id]}}});assert.equal(allowed.statusCode,200,allowed.body);assert.equal((await f.app.inject({method:'POST',url:'/api/ai/chat',payload})).statusCode,200);assert.equal(f.calls.length,1);assert.equal(allowed.json().assistant.defaultModelId,chatModel.id);
 }finally{await f.close();}
});

test('removing a model or connection lists referencing purposes, and succeeds after explicit unbinding',async()=>{
 const f=await fixture({raw:legacy(),legacyDefault:chatModel.id});try{const config=await f.read();const removed=await f.app.inject({method:'POST',url:'/api/ai/providers/'+connection.id,payload:{expectedRevision:config.revision,provider:connection,models:[otherModel]}});assert.equal(removed.statusCode,400);assert.match(removed.body,/AI 助手/);assert.match(removed.body,/翻译来源 A/);
  const deleted=await f.app.inject({method:'DELETE',url:'/api/ai/providers/'+connection.id,payload:{expectedRevision:config.revision}});assert.equal(deleted.statusCode,400);assert.match(deleted.body,/用途/);
  const unbound=await f.registry.save(config.revision,data=>({...data,assistant:{...data.assistant,modelIds:[],defaultModelId:null},translations:[]}));const success=await f.app.inject({method:'DELETE',url:'/api/ai/providers/'+connection.id,payload:{expectedRevision:unbound.revision}});assert.equal(success.statusCode,200,success.body);assert.deepEqual(success.json().providers,[]);
 }finally{await f.close();}
});

test('assistant defaults, role prompts and limits do not affect translation fingerprint or adapter cache versions',async()=>{
 const raw=legacy();raw.translations.push({...source,id:'source-b',modelId:otherModel.id});const f=await fixture({raw,legacyDefault:chatModel.id});try{const before=await f.read(),assistant={...before.assistant,defaultModelId:otherModel.id,roles:before.assistant.roles.map(role=>({...role,instructions:role.instructions+'\n任务要求'})),limits:{...before.assistant.limits,modelCalls:8}};const changed=await f.app.inject({method:'PUT',url:'/api/ai/assistant',payload:{expectedRevision:before.revision,assistant}});assert.equal(changed.statusCode,200,changed.body);const after=changed.json();assert.notEqual(after.revision,before.revision);assert.equal(after.translationFingerprint,before.translationFingerprint);assert.notEqual(after.assistantFingerprint,before.assistantFingerprint);assert.deepEqual(configuredTranslationAdapters(after).map(adapter=>adapter.cacheVersion),configuredTranslationAdapters(before).map(adapter=>adapter.cacheVersion));
  const reordered=await f.registry.save(after.revision,data=>({...data,translationLayout:'columns',translations:[...data.translations].reverse().map(item=>({...item,label:item.label+' 新名',color:'#112233'}))}),'translation');assert.equal(reordered.translationFingerprint,before.translationFingerprint);
 }finally{await f.close();}
});

test('LLM translation resolves its source server-side, has its own translator prompt and never enters assistant context',async()=>{
 const data=normalizeRegistry(legacy());data.assistant.modelIds=[];const f=await fixture({raw:data});try{
  const response=await f.translate({source:'tex',text:'\\textbf{Evidence} \\cite{x} $p<0.05$'});assert.equal(response.statusCode,200,response.body);assert.match(response.headers['content-type']||'',/ndjson/);assert.equal(events(response).at(-1)?.type,'done');assert.equal(events(response).at(-1)?.finishReason,'stop');assert.equal(events(response)[0].text,'译文结果');assert.equal(f.calls.length,1);
  const call=f.calls[0];assert.equal(call.url,connection.baseUrl+'/chat/completions');assert.equal(call.body.model,chatModel.model);assert.equal(new Headers(call.init.headers).get('authorization'),'Bearer '+secret);assert.equal(call.body.messages.length,2);assert.match(call.body.messages[0].content,/学术译者/);assert.ok(!JSON.stringify(call.body).includes('论文写作与 LaTeX 助手'));assert.equal(call.body.messages[1].reasoning_content,undefined);assert.equal(call.body.checkpoint,undefined);assert.equal(call.body.context,undefined);assert.equal(call.body.tools,undefined);assert.equal(call.body.reasoning_effort,'medium');assert.equal(call.init.redirect,'error');
  for(const patch of[{messages:[{role:'user',content:'history'}]},{context:{path:'main.tex',content:'paper'}},{model:otherModel.id},{sourceId:'missing'},{projectId:'Missing'},{text:'x'.repeat(6001)}])assert.ok((await f.translate(patch)).statusCode>=400);assert.equal(f.calls.length,1);
  assert.equal((await f.app.inject({method:'POST',url:'/api/ai/chat',payload:{projectId:'Paper',model:chatModel.id,messages:[{role:'user',content:'hi'}]}})).statusCode,400);
 }finally{await f.close();}
});

test('translation never emits done for incomplete streams and redacts upstream errors',async()=>{
 for(const transport of [async()=>stream('partial','length'),async()=>new Response(JSON.stringify({error:{message:'invalid '+secret}}),{status:401}),async()=>new Response(`data: ${JSON.stringify({error:{message:secret}})}\n\n`,{headers:{'content-type':'text/event-stream'}})]){
  const f=await fixture({raw:legacy(),fetch:transport});try{const response=await f.translate();assert.ok(!response.body.includes(secret));if(response.statusCode===200){assert.ok(events(response).some(event=>event.type==='error'));assert.ok(!events(response).some(event=>event.type==='done'));}else assert.equal(response.statusCode,502);}finally{await f.close();}
 }
});

test('cancelling translation during credential lookup never starts an upstream request',async()=>{
 let resolveKey!:(key:string)=>void,started!:()=>void,closed!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;}),key=new Promise<string>(resolve=>{resolveKey=resolve;}),disconnected=new Promise<void>(resolve=>{closed=resolve;});
 const f=await fixture({raw:legacy(),getKey:async()=>{started();return key;}});try{
  f.app.addHook('onRequest',async(_request,reply)=>{reply.raw.once('close',closed);});
  const origin=await f.app.listen({host:'127.0.0.1',port:0}),controller=new AbortController();
  const pending=fetch(origin+'/api/ai/translate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId:'Paper',sourceId:source.id,text:'Evidence',target:'zh-CN',source:'pdf'}),signal:controller.signal});
  await ready;controller.abort();await assert.rejects(pending);await disconnected;resolveKey(secret);await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.calls.length,0);
 }finally{resolveKey?.(secret);await f.close();}
});

test('one translation and one assistant request on the same connection have independent purpose lifecycles',async()=>{
 let release!:()=>void,started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});let calls=0;
 const f=await fixture({raw:legacy(),legacyDefault:chatModel.id,fetch:async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));if(body.messages[0].content.includes('论文写作与 LaTeX 助手')){started();await held;}return stream();}});
 try{const chat=f.app.inject({method:'POST',url:'/api/ai/chat',payload:{projectId:'Paper',model:chatModel.id,messages:[{role:'user',content:'长任务'}]}});const pending=chat.then(response=>response);await ready;const translation=await f.translate();assert.equal(translation.statusCode,200,translation.body);assert.equal(events(translation).at(-1)?.type,'done');assert.equal(calls,2);release();assert.equal((await pending).statusCode,200);}finally{release?.();await f.close();}
});

test('shared rate limit groups cover distinct connections, reserve purpose capacity and queued cancellation does not leak slots',async()=>{
 const scheduler=createModelScheduler(),signal=new AbortController(),provider={...connection,rateLimitGroup:'same-account'},other={...provider,id:'other'},releaseA=await scheduler.acquire(provider,'assistant',signal.signal),releaseB=await scheduler.acquire(other,'assistant',signal.signal);let obtained=false;
 const queuedAbort=new AbortController(),cancelled=scheduler.acquire(other,'translation',queuedAbort.signal);queuedAbort.abort();await assert.rejects(cancelled,/停止/);
 const pending=scheduler.acquire(other,'translation',signal.signal).then(release=>{obtained=true;return release;});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(obtained,false);releaseA();const releaseTranslation=await pending;assert.equal(obtained,true);releaseTranslation();releaseB();const final=await scheduler.acquire(provider,'translation',signal.signal);final();final();
});

test('translation client uses unified NDJSON and does not accept partial or malformed completion',async()=>{
 const original=globalThis.fetch,calls:any[]=[];try{globalThis.fetch=(async(url,init)=>{calls.push({url,body:JSON.parse(String(init?.body))});return new Response('{"type":"delta","text":"译文"}\n{"type":"done","finishReason":"stop"}\n');})as typeof fetch;let text='';assert.equal(await streamTranslation({projectId:'Paper',sourceId:source.id,text:'text',target:'zh-CN',source:'pdf'},new AbortController().signal,value=>{text=value;}),'译文');assert.equal(text,'译文');assert.equal(calls[0].url,'/api/ai/translate');assert.equal(calls[0].body.model,undefined);assert.equal(calls[0].body.messages,undefined);
  globalThis.fetch=(async()=>new Response('{"type":"delta","text":"partial"}\n'))as typeof fetch;await assert.rejects(streamTranslation({projectId:'Paper',sourceId:source.id,text:'text',target:'en',source:'pdf'},new AbortController().signal,()=>{}),/提前结束/);
 }finally{globalThis.fetch=original;}
});
