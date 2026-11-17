import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerUnifiedTranslationRoutes} from '../server/translation';
const secret='fixture-private-credential',text='PRIVATE_SELECTED_TEXT';
for(const mode of ['timeout-before','timeout-stream','cancel','stream-error'])test(`isolated HTTP diagnostics: ${mode}`,async t=>{
 const lines:string[]=[];let failed!:()=>void;const failure=new Promise<void>(r=>{failed=r;});
 const app=Fastify({forceCloseConnections:true,logger:{stream:{write(s:string){lines.push(s);if(s.includes('Translation request failed'))failed();}}}});t.after(()=>app.close());
 const timer=globalThis.setTimeout;if(mode.startsWith('timeout'))t.mock.method(globalThis,'setTimeout',((fn:any,ms:any,...args:any[])=>timer(fn,ms===90000?40:ms,...args)) as typeof setTimeout);
 const provider={id:'p',label:'Fixture',kind:'openai-compatible',baseUrl:'http://127.0.0.1',auth:'bearer',enabled:true};let released=0,aborted=false;
 const registry={read:async()=>({data:{translations:[{id:'s',modelId:'m',enabled:true}],models:[{id:'m',providerId:'p',model:'mock',enabled:true,reasoning:'none'}],providers:[provider]}}),getKey:async()=>secret,scheduler:{acquire:async()=>()=>{released++;}}};
 await registerUnifiedTranslationRoutes(app,'/unused',registry as any,{validateResource:async()=>{},fetch:async(_input,init)=>{
 const signal=init!.signal!;
 if(mode==='timeout-before')return new Promise((_r,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error(secret+' '+text));},{once:true}));
 return new Response(new ReadableStream<Uint8Array>({start(c){
 c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'部分译文'}}]})+'\n\n'));
 if(mode==='stream-error')c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({error:{message:secret+' '+text}})+'\n\n'));
 else signal.addEventListener('abort',()=>{aborted=true;c.error(Error(secret+' '+text));},{once:true});
 }}),{headers:{'content-type':'text/event-stream'}});
 }});
 const origin=await app.listen({host:'127.0.0.1',port:0}),controller=new AbortController();
 const response=await fetch(origin+'/api/ai/translate',{method:'POST',headers:{'content-type':'application/json'},signal:controller.signal,body:JSON.stringify({resourceId:'fixture',sourceId:'s',text,target:'zh-CN',source:'pdf'})});let events:any[]=[];
 if(mode==='cancel'){const reader=response.body!.getReader();await reader.read();controller.abort();await reader.cancel().catch(()=>{});}else events=(await response.text()).trim().split('\n').map(s=>JSON.parse(s));
 await Promise.race([failure,new Promise((_,reject)=>timer(()=>reject(Error('missing diagnostic')),2000).unref())]);
 const record=lines.map(s=>JSON.parse(s)).find(s=>s.msg==='Translation request failed');
 const code=mode.startsWith('timeout')?'translation_timeout':mode==='cancel'?'translation_cancelled':'translation_upstream_error';
 assert.equal(record.code,code);assert.equal(record.streamStarted,mode!=='timeout-before');assert.equal(record.sourceId,'s');assert.equal(typeof record.elapsedMs,'number');assert.equal(released,1);
 assert.ok(!lines.join('').includes(secret));assert.ok(!lines.join('').includes(text));if(mode!=='stream-error')assert.equal(aborted,true);
 if(mode!=='cancel'){const last=events.at(-1);assert.equal(last.type,'error');assert.equal(last.code,code);assert.equal(last.requestId,response.headers.get('x-translation-request-id'));assert.equal(last.requestId,record.requestId);assert.ok(!JSON.stringify(events).includes(secret));assert.ok(!JSON.stringify(events).includes(text));assert.equal(response.status,mode==='timeout-before'?504:200);assert.ok(!events.some(e=>e.type==='done'));}
});
