import type {FastifyInstance} from 'fastify';
import type {ProviderRegistry,ProviderOptions} from './model-providers';
import type {WorkspaceService} from './workspace/index';
import {HttpError} from './security';
import {workspaceMaintenance} from './agents/maintenance';

type Body={model:string;messages:{role:'system'|'user'|'assistant';content:string}[];maxCompletionTokens:number;effort:'low';runId?:string};
function validate(b:Body){
 const bad=()=>{throw new HttpError(400,'受限推理参数无效。');};
 if(!b||typeof b!=='object'||Object.keys(b).some(k=>!['model','messages','maxCompletionTokens','effort','runId'].includes(k)))bad();
 if(typeof b.model!=='string'||b.effort!=='low'||!Number.isInteger(b.maxCompletionTokens)||b.maxCompletionTokens<64||b.maxCompletionTokens>8192)bad();
 if(b.runId!==undefined&&(typeof b.runId!=='string'||!b.runId.trim()||b.runId.length>200))bad();
 if(!Array.isArray(b.messages)||!b.messages.length||b.messages.length>24)bad();
 let bytes=0;for(const m of b.messages){if(!m||Object.keys(m).some(k=>!['role','content'].includes(k))||!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'||!m.content.trim())bad();bytes+=Buffer.byteLength(m.content,'utf8');}if(bytes>24000)bad();
}
/** Dedicated evidence-preserving SSE parser; never used by the agent tool executor. */
export async function readResearchCompletion(response:Response,state:{text:string;reasoning:string;finishReason:string|null;usage:unknown;responseModel:string|null},signal:AbortSignal,maxBytes=8*1024*1024){
 if(!response.body)throw Error('missing_stream');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',bytes=0,done=false;
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 function packet(line:string){
  if(!line.startsWith('data:'))return;const raw=line.slice(5).trim();if(!raw)return;if(raw==='[DONE]'){done=true;return;}
  const v=JSON.parse(raw);if(v.error||v.base_resp?.status_code)throw Error('upstream_error');
  if(typeof v.model==='string')state.responseModel=v.model;
  if(v.usage!==undefined&&v.usage!==null)state.usage=v.usage;
  const c=v.choices?.[0];if(!c)return;const d=c.delta||{};
  if(d.tool_calls!==undefined||d.function_call!==undefined)throw Error('unexpected_tool_call');
  if(typeof d.content==='string')state.text+=d.content;
  if(typeof d.reasoning_content==='string')state.reasoning+=d.reasoning_content;
  if(c.finish_reason){if(state.finishReason&&state.finishReason!==c.finish_reason)throw Error('conflicting_finish');state.finishReason=c.finish_reason;}
 }
 try{while(!done){if(signal.aborted)throw Error('aborted');const chunk=await reader.read();if(signal.aborted)throw Error('aborted');if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>maxBytes)throw Error('stream_limit');buffer+=decoder.decode(chunk.value,{stream:true});let n;while((n=buffer.indexOf('\n'))>=0){packet(buffer.slice(0,n).replace(/\r$/,''));buffer=buffer.slice(n+1);if(done)break;}}
 buffer+=decoder.decode();if(!done&&buffer.trim())packet(buffer.trim());
 if(!done)throw Error('stream_interrupted');
 if(!['stop','length'].includes(state.finishReason||''))throw Error('invalid_finish');
 if(!state.usage||typeof state.usage!=='object'||!['prompt_tokens','completion_tokens','total_tokens'].every(k=>Number.isSafeInteger((state.usage as any)[k])&&(state.usage as any)[k]>=0))throw Error('usage_unknown');
 }finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function registerResearchInferenceRoutes(app:FastifyInstance,root:string,registry:ProviderRegistry,workspace:Pick<WorkspaceService,'overview'>,options:ProviderOptions&{timeoutMs?:number}={}){
 app.post<{Params:{id:string};Body:Body}>('/api/workspace/topics/:id/inference',{bodyLimit:64*1024},async(request,reply)=>{
  const b=request.body;validate(b);const maintenance=workspaceMaintenance(root);maintenance.assertAvailable();
  const topic=(await workspace.overview()).topics.find(t=>t.id===request.params.id&&!t.archived);if(!topic)throw new HttpError(404,'课题不存在或已归档。');
  const snapshot=await registry.read(),model=snapshot.data.models.find(m=>m.id===b.model&&m.enabled),provider=snapshot.data.providers.find(p=>p.id===model?.providerId&&p.enabled);
  if(!model||!provider||!snapshot.data.assistant.modelIds.includes(model.id)||provider.kind!=='minimax'||!['MiniMax-M3.1-Flash'].includes(model.model))throw new HttpError(400,'此模型不支持受限科研推理。');
  const key=await registry.getKey(provider);if(provider.auth==='bearer'&&!key)throw new HttpError(503,'模型凭据未配置。');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeoutMs??180000);
  const disconnect=()=>{if(!reply.raw.writableEnded)controller.abort();};reply.raw.on('close',disconnect);
  const startedAt=new Date().toISOString(),start=Date.now();let release:(()=>void)|undefined,sent=false;
  const state={text:'',reasoning:'',finishReason:null as string|null,usage:null as unknown,responseModel:null as string|null};
  const parameters={max_completion_tokens:b.maxCompletionTokens,stream:true,stream_options:{include_usage:true},reasoning_effort:'low',reasoning_split:true};
  const result=()=>({...state,requestModel:model.model,requestModelId:model.id,configRevision:snapshot.revision,topicId:topic.id,runId:b.runId??null,startedAt,endedAt:new Date().toISOString(),elapsedMs:Date.now()-start,parameters,upstreamSent:sent,usageStatus:state.usage===null?'unknown':'reported'});
  try{
   release=await registry.scheduler.acquire(provider,'assistant',controller.signal);maintenance.assertAvailable();
   if(controller.signal.aborted)throw Error('aborted');
   if(!(await workspace.overview()).topics.some(t=>t.id===topic.id&&!t.archived))throw Error('topic_changed');
   sent=true;const response=await(options.fetch??fetch)(provider.baseUrl+'/chat/completions',{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{})},body:JSON.stringify({model:model.model,messages:b.messages,...parameters})});
   if(!response.ok){await response.body?.cancel();throw Error('upstream_http_'+response.status);}
   await readResearchCompletion(response,state,controller.signal);
   const complete=state.finishReason==='stop';return{...result(),complete,visibleAnswer:!!state.text.trim(),status:complete?(state.text.trim()?'completed':'no_visible_answer'):'truncated',error:null};
  }catch(error){const code=controller.signal.aborted?'cancelled_or_timeout':error instanceof Error&&/^(missing_stream|upstream_error|unexpected_tool_call|conflicting_finish|stream_limit|stream_interrupted|invalid_finish|usage_unknown|topic_changed|upstream_http_\d+)$/.test(error.message)?error.message:'upstream_failure';return reply.code(502).send({...result(),complete:false,visibleAnswer:!!state.text.trim(),status:'failed',error:code,usageStatus:code==='usage_unknown'?'unknown':state.usage===null?'unknown':'reported',billingStatus:sent?'possibly_charged':'not_sent'});
  }finally{clearTimeout(timer);controller.abort();release?.();reply.raw.off('close',disconnect);}
 });
}
