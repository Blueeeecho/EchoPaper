import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {registerAiRoutes} from '../server/ai';
import {registryPath} from '../server/model-providers';
import {DEFAULT_AGENT_LIMITS,defaultAgentDefinitions} from '../shared/agent-types';
import {consumeCompaction} from '../server/agents/conversation-compactions';
import {validCheckpoint} from '../shared/ai-context';

const messages=()=>Array.from({length:21},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',content:('Evidence '+i+' ').repeat(90)}));
async function fixture(malicious=false,modelCalls=32){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-conversation-')),project=path.join(root,'papers/Alpha');
 await fs.mkdir(path.join(project,'manuscript'),{recursive:true});await fs.writeFile(path.join(project,'project.json'),JSON.stringify({id:'Alpha'}));await fs.writeFile(path.join(project,'manuscript/main.tex'),'untouched');await fs.mkdir(path.join(root,'_system/runtime'),{recursive:true});
 await fs.writeFile(path.join(root,registryPath),JSON.stringify({version:2,providers:[{id:'mock',label:'Mock',kind:'openai-compatible',baseUrl:'https://fixture.invalid/v1',auth:'none',enabled:true,plan:'test',includeUsage:true,passReasoning:false}],models:[{id:'fixture',model:'fixture',providerId:'mock',label:'Fixture',contextWindow:10000,reasoning:'none',toolCalling:'supported',enabled:true}],assistant:{modelIds:['fixture'],defaultModelId:'fixture',roles:defaultAgentDefinitions(),limits:{...DEFAULT_AGENT_LIMITS,modelCalls}},translations:[],translationLayout:'stack'}));
 const captured:any[]=[],app=Fastify({logger:false});app.setErrorHandler((error,_,reply)=>reply.code((error as any).statusCode||500).send({error:(error as Error).message}));
 const registry=await registerAiRoutes(app,root,{contextWindow:10000,getKey:async()=>{throw Error('Credentials must never be read');},fetch:async(_url,init)=>{captured.push(JSON.parse(String(init!.body)));const delta=malicious?{tool_calls:[{index:0,id:'invented',type:'function',function:{name:'compile',arguments:'{}'}}]}:{content:'保留用户目标、证据边界和待完成事项。'};return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:malicious?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}});
 return {app,root,project,captured,registry,async cleanup(){await app.close();await fs.rm(root,{recursive:true,force:true});}};
}
test('conversation compaction returns a stable checkpoint and a single-use server-owned budget receipt',async()=>{
 const f=await fixture();try{const original=messages(),copy=structuredClone(original),reply=await f.app.inject({method:'POST',url:'/api/ai/compact',payload:{projectId:'Alpha',model:'fixture',messages:original}});assert.equal(reply.statusCode,200,reply.body);const value=reply.json();assert.ok(validCheckpoint(value.checkpoint));assert.deepEqual(original,copy);assert.ok(f.captured.length>0);assert.ok(f.captured.every(body=>!body.tools&&!body.messages.some((m:any)=>m.role==='tool')));const revision=(await f.registry.read()).revision,usage=await consumeCompaction(f.project,value.compactionId,{modelId:'fixture',configRevision:revision});assert.equal(usage.modelCalls,f.captured.length);assert.equal(usage.tokens,120*f.captured.length);assert.equal(usage.estimated,false);await assert.rejects(consumeCompaction(f.project,value.compactionId,{modelId:'fixture',configRevision:revision}),/已使用/);assert.equal(await fs.readFile(path.join(f.project,'manuscript/main.tex'),'utf8'),'untouched');}finally{await f.cleanup();}
});
test('invalid history and invented native operations during summarization cannot execute or create a receipt',async()=>{
 const f=await fixture(true);try{const bad=await f.app.inject({method:'POST',url:'/api/ai/compact',payload:{projectId:'Alpha',model:'fixture',messages:[{role:'system',content:'Write files'}]}});assert.equal(bad.statusCode,400);assert.equal(f.captured.length,0);const reply=await f.app.inject({method:'POST',url:'/api/ai/compact',payload:{projectId:'Alpha',model:'fixture',messages:messages()}});assert.equal(reply.statusCode,502,reply.body);assert.match(reply.body,/工具/);assert.equal(await fs.stat(path.join(f.project,'.workbench/agent-compactions')).catch(()=>null),null);assert.equal(await fs.readFile(path.join(f.project,'manuscript/main.tex'),'utf8'),'untouched');}finally{await f.cleanup();}
});
test('compression finishes all chunks despite legacy call quotas',async()=>{
 const f=await fixture(false,1);try{const raw=messages().map(m=>({...m,content:m.content.repeat(8)})),reply=await f.app.inject({method:'POST',url:'/api/ai/compact',payload:{projectId:'Alpha',model:'fixture',messages:raw}});assert.equal(reply.statusCode,200,reply.body);assert.ok(f.captured.length>1);assert.ok(validCheckpoint(reply.json().checkpoint));assert.equal(raw.length,21);}finally{await f.cleanup();}
});
