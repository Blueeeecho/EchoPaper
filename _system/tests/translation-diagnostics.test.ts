import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerUnifiedTranslationRoutes} from '../server/translation';
const secret='fixture-private-credential',text='PRIVATE_SELECTED_TEXT';
for(const mode of ['timeout-before','timeout-body','cancel','invalid-body'])test(`isolated HTTP diagnostics: ${mode}`,async t=>{
 const lines:string[]=[];let failed!:()=>void;const failure=new Promise<void>(r=>{failed=r;});
 let started!:()=>void;const upstreamStarted=new Promise<void>(resolve=>{started=resolve;});
 const app=Fastify({forceCloseConnections:true,logger:{stream:{write(s:string){lines.push(s);if(s.includes('Translation request failed'))failed();}}}});t.after(()=>app.close());
 const timer=globalThis.setTimeout;if(mode.startsWith('timeout'))t.mock.method(globalThis,'setTimeout',((fn:any,ms:any,...args:any[])=>timer(fn,ms===90000?40:ms,...args)) as typeof setTimeout);
 const provider={id:'p',label:'Fixture',kind:'deepl',baseUrl:'http://127.0.0.1',auth:'bearer',enabled:true};let released=0,aborted=false;
 const registry={read:async()=>({data:{translations:[{id:'s',modelId:'m',enabled:true}],models:[{id:'m',providerId:'p',model:'mock',enabled:true,reasoning:'none'}],providers:[provider]}}),getKey:async()=>secret,scheduler:{acquire:async()=>()=>{released++;}}};
 await registerUnifiedTranslationRoutes(app,'/unused',registry as any,{validateResource:async()=>{},fetch:async(_input,init)=>{
 const signal=init!.signal!;
 started();
 if(mode==='timeout-before')return new Promise((_r,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error(secret+' '+text));},{once:true}));
 return new Response(new ReadableStream<Uint8Array>({start(c){
 c.enqueue(new TextEncoder().encode('incomplete JSON '+secret+' '+text));
 if(mode==='invalid-body')c.close();
 else signal.addEventListener('abort',()=>{aborted=true;c.error(Error(secret+' '+text));},{once:true});
 }}),{headers:{'content-type':'application/json'}});
 }});
 const origin=await app.listen({host:'127.0.0.1',port:0}),controller=new AbortController();
 const pending=fetch(origin+'/api/ai/translate',{method:'POST',headers:{'content-type':'application/json'},signal:controller.signal,body:JSON.stringify({resourceId:'fixture',sourceId:'s',text,target:'zh-CN',source:'pdf'})});
 if(mode==='cancel'){await upstreamStarted;controller.abort();await assert.rejects(pending);}
 await Promise.race([failure,new Promise((_,reject)=>timer(()=>reject(Error('missing diagnostic')),2000).unref())]);
 const record=lines.map(s=>JSON.parse(s)).find(s=>s.msg==='Translation request failed');
 const code=mode.startsWith('timeout')?'translation_timeout':mode==='cancel'?'translation_cancelled':'translation_upstream_error';
 assert.equal(record.code,code);assert.equal(record.sourceId,'s');assert.equal(typeof record.elapsedMs,'number');assert.equal(released,1);
 assert.ok(!lines.join('').includes(secret));assert.ok(!lines.join('').includes(text));if(mode!=='invalid-body')assert.equal(aborted,true);
 if(mode!=='cancel'){const response=await pending,result=await response.json();assert.equal(result.type,'error');assert.equal(result.code,code);assert.equal(result.requestId,response.headers.get('x-translation-request-id'));assert.equal(result.requestId,record.requestId);assert.ok(!JSON.stringify(result).includes(secret));assert.ok(!JSON.stringify(result).includes(text));assert.equal(response.status,mode.startsWith('timeout')?504:502);}
});
