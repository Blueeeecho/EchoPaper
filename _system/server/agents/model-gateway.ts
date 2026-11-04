import type { ModelProvider, ProviderModel } from '../../shared/model-providers';
import { modelEfforts } from '../../shared/model-providers';
import { estimateTokens } from '../../shared/ai-context';
import type { ProviderRegistry } from '../model-providers';
import type { AiOptions } from '../ai';
import type {AgentAttachment} from '../../shared/attachment-types';

export interface NativeToolCall { id:string; type:'function'; function:{name:string;arguments:string} }
export interface ModelMessage { role:'system'|'user'|'assistant'|'tool'; content:string|null; images?:AgentAttachment[]; reasoning_content?:string; tool_calls?:NativeToolCall[]; tool_call_id?:string }
export interface ModelTool { type:'function'; function:{name:string;description:string;parameters:Record<string,unknown>} }
// Durable messages hold image references, never base64. Pixel token cost is estimated separately.
export function estimateModelTokens(messages:ModelMessage[],tools:ModelTool[]=[]){return estimateTokens(JSON.stringify(messages)+JSON.stringify(tools))+messages.reduce((sum,message)=>sum+(message.images?.length||0)*4096,0);}
export interface ModelAnswer { text:string; reasoning:string; toolCalls:NativeToolCall[]; finishReason:'stop'|'tool_calls'; model:string; usage?:{prompt_tokens:number;completion_tokens:number;total_tokens:number} }
export class AgentBudgetError extends Error {}
export class AgentContextWindowError extends Error { readonly code='context_length_exceeded'; }
export function isContextWindowError(error:unknown):boolean {
 const value=error as {code?:unknown;message?:unknown};
 return error instanceof AgentContextWindowError||/^(?:context_length_exceeded|context_window_exceeded|max_context_length_exceeded|prompt_too_long)$/i.test(String(value?.code||''))||/maximum.{0,30}context.{0,20}length|context.{0,20}(?:length|window).{0,30}(?:exceed|limit)|exceed.{0,30}context|input.{0,20}too long|上下文.{0,20}(?:超|过长)|输入.{0,12}(?:过长|超长)/i.test(String(value?.message||error));
}
function providerError(value:any,prefix=''):Error {
 const message=String(value?.error?.message??value?.base_resp?.status_msg??'模型服务返回错误。');
 const detail={code:value?.error?.code,message};
 return isContextWindowError(detail)?new AgentContextWindowError(prefix+message):new Error(prefix+message);
}
export const abortError = () => new DOMException('任务已停止。','AbortError');
export function checkAbort(signal:AbortSignal) { if(signal.aborted) throw signal.reason instanceof Error?signal.reason:abortError(); }
export const redact = (text:string,key='') => (key?text.replaceAll(key,'[REDACTED]'):text).replace(/sk-[A-Za-z0-9_-]{15,}/g,'[REDACTED]').replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g,'[图片附件]');

// Shared by all task runs. A model slot is independent of the subscribing HTTP connection.
let inflight=0;
const providers=new Set<string>();
const waiters=new Set<()=>void>();
export async function withAgentModelSlot<T>(projectId:string,providerId:string,signal:AbortSignal,work:()=>Promise<T>):Promise<T> {
 const key=projectId+':'+providerId;
 for(;;){checkAbort(signal);if(inflight<2&&!providers.has(key)){inflight++;providers.add(key);break;}
  await new Promise<void>((resolve,reject)=>{const wake=()=>{cleanup();resolve();},abort=()=>{cleanup();reject(abortError());},cleanup=()=>{waiters.delete(wake);signal.removeEventListener('abort',abort);};waiters.add(wake);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 }
 try{return await work();}finally{inflight--;providers.delete(key);for(const wake of [...waiters])wake();}
}

/** Parse native tool calls only after an explicit normal terminal packet. No textual JSON fallback. */
export async function readAgentCompletion(response:Response,model:string,touch:()=>void,onText?:(text:string)=>void):Promise<ModelAnswer> {
 if(!response.body)throw Error('模型服务没有返回数据流。');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',text='',reasoning='',finish='',terminal=false,bytes=0;
 let usage:ModelAnswer['usage'];const calls=new Map<number,{id:string;name:string;args:string;type:string}>();
 const packet=(line:string)=>{if(!line.startsWith('data:'))return;const raw=line.slice(5).trim();if(!raw)return;if(raw==='[DONE]'){terminal=true;return;}
  const value=JSON.parse(raw);if(value.error||value.base_resp?.status_code)throw providerError(value);
  if(typeof value.model==='string')model=value.model;
  if(value.usage&&['prompt_tokens','completion_tokens','total_tokens'].every(k=>Number.isSafeInteger(value.usage[k])&&value.usage[k]>=0))usage=value.usage;
  const choice=value.choices?.[0];if(!choice)return;const delta=choice.delta||{};
  if(choice.finish_reason){if(finish&&finish!==choice.finish_reason)throw Error('模型返回相互矛盾的结束状态。');finish=choice.finish_reason;}
  if(typeof delta.content==='string'){text+=delta.content;onText?.(delta.content);}
  if(typeof delta.reasoning_content==='string')reasoning+=delta.reasoning_content;
  if(delta.tool_calls!==undefined){if(!Array.isArray(delta.tool_calls))throw Error('工具调用格式无效。');for(const part of delta.tool_calls){if(!Number.isSafeInteger(part.index)||part.index<0)throw Error('工具调用序号无效。');const call=calls.get(part.index)||{id:'',name:'',args:'',type:''};
    if(part.id!==undefined){if(typeof part.id!=='string'||call.id&&call.id!==part.id)throw Error('工具调用编号冲突。');call.id=part.id;}
    if(part.type!==undefined){if(part.type!=='function')throw Error('仅支持 function 工具。');call.type=part.type;}
    if(part.function?.name!==undefined){if(typeof part.function.name!=='string')throw Error('工具名称无效。');call.name+=part.function.name;}
    if(part.function?.arguments!==undefined){if(typeof part.function.arguments!=='string')throw Error('工具参数无效。');call.args+=part.function.arguments;if(call.args.length>4*1024*1024)throw Error('工具参数超过大小限制。');}
    calls.set(part.index,call);
  }}
 };
 try{while(!terminal){const chunk=await reader.read();if(chunk.done)break;touch();bytes+=chunk.value.length;if(bytes>32*1024*1024)throw Error('模型输出超过 32 MB。');buffer+=decoder.decode(chunk.value,{stream:true});let n;while((n=buffer.indexOf('\n'))>=0){packet(buffer.slice(0,n).replace(/\r$/,''));buffer=buffer.slice(n+1);if(terminal)break;}}buffer+=decoder.decode();if(!terminal&&buffer.trim())packet(buffer.replace(/\r$/,''));
  if(!finish)throw Error('模型连接提前结束，未完成的工具参数不会执行。');
  if(finish!=='stop'&&finish!=='tool_calls')throw Error(finish==='length'?'模型输出被截断，未执行工具。':`模型未正常结束（${finish}），未执行工具。`);
  if(finish==='tool_calls'&&!calls.size)throw Error('模型声明了工具调用，却没有完整工具参数。');
  if(finish==='stop'&&calls.size)throw Error('工具调用缺少明确的 tool_calls 结束状态。');
  const ids=new Set<string>();const toolCalls:NativeToolCall[]=[...calls.entries()].sort((a,b)=>a[0]-b[0]).map(([,call])=>{if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(call.id)||ids.has(call.id)||!/^[_a-z][_a-z0-9]{0,80}$/i.test(call.name))throw Error('工具调用编号或名称无效。');ids.add(call.id);let args:unknown;try{args=JSON.parse(call.args);}catch{throw Error('工具参数不完整或不是有效 JSON，未执行工具。');}if(!args||typeof args!=='object'||Array.isArray(args))throw Error('工具参数必须是对象。');return{id:call.id,type:'function',function:{name:call.name,arguments:call.args}};});
  if(!text.trim()&&!toolCalls.length)throw Error('模型没有返回可见结果或工具调用。');
  return{text,reasoning,toolCalls,finishReason:finish,model,...(usage?{usage}:{})};
 }finally{await reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}

export function createAgentModelGateway(registry:ProviderRegistry,options:AiOptions={},imageData?:(projectId:string,id:string)=>Promise<{mimeType:string;base64:string}>) {
 return async(input:{projectId:string;provider:ModelProvider;model:ProviderModel;messages:ModelMessage[];tools:ModelTool[];effort?:string;signal:AbortSignal;onText?:(text:string)=>void;onReserve:(estimatedInput:number)=>void;onSettled:(tokens:number,estimated:boolean)=>void}):Promise<ModelAnswer>=>{
  const activeMessages=input.messages.map(message=>({...message,...(!input.provider.passReasoning?{reasoning_content:undefined}:{})}));
  const estimatedInput=estimateModelTokens(activeMessages,input.tools);
  // A per-request context boundary, independent of cumulative usage. Leave 20%
  // for generation/reasoning and tokenizer variance, including on summary calls.
  if(estimatedInput>=input.model.contextWindow*.8)throw new AgentContextWindowError('当前请求超过所选模型的上下文窗口安全范围，未发送请求；原始记录已保留。');
  const wireMessages=await Promise.all(activeMessages.map(async({images,...message})=>{if(!images?.length)return message;if(!imageData)throw Error('当前服务无法加载图片附件，请重新上传后重试。');const parts=await Promise.all(images.map(async image=>{const data=await imageData(input.projectId,image.id);return{type:'image_url',image_url:{url:`data:${data.mimeType};base64,${data.base64}`,detail:'auto'}};}));return{...message,content:[{type:'text',text:message.content||''},...parts]};}));
  const release=await registry.scheduler.acquire(input.provider,'assistant',input.signal);
  try{return await(async()=>{
  checkAbort(input.signal);let key='',timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();const abort=()=>controller.abort(input.signal.reason??abortError());input.signal.addEventListener('abort',abort,{once:true});
  const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(new Error('模型连续无数据超时。')),options.timeoutMs??180000);timer.unref();};
  let settled=false,reserved=false,partial='';
  try{input.onReserve(estimatedInput);reserved=true;touch();key=await registry.getKey(input.provider);checkAbort(input.signal);checkAbort(controller.signal);if(input.provider.auth==='bearer'&&!key)throw Error('所选模型服务尚未配置此地址的凭据。');
   const response=await(options.fetch??fetch)(input.provider.baseUrl+'/chat/completions',{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{})},body:JSON.stringify({model:input.model.model,messages:wireMessages,...(input.tools.length?{tools:input.tools,tool_choice:'auto'}:{}),stream:true,...(input.provider.includeUsage?{stream_options:{include_usage:true}}:{}),...(input.provider.kind==='minimax'?{reasoning_split:true}:{}),...(modelEfforts(input.model).length?{reasoning_effort:modelEfforts(input.model).includes(input.effort||'medium')?input.effort||'medium':'medium'}:{})})});
   if(!response.ok||response.headers.get('content-type')?.includes('application/json')){const value=await response.json().catch(()=>({})),error=providerError(value,`模型服务请求失败 (${response.status})：`);if(activeMessages.some(message=>message.images?.length)&&[400,415,422].includes(response.status)&&!isContextWindowError(error))throw Error('当前模型或服务未接受图片，请切换支持视觉的模型重试。'+error.message);throw error;}
   const answer=await readAgentCompletion(response,input.model.model,touch,chunk=>{partial+=chunk;input.onText?.(chunk);});
   input.onSettled(answer.usage?.total_tokens??estimatedInput+estimateTokens(answer.text+answer.reasoning+JSON.stringify(answer.toolCalls)),!answer.usage);settled=true;checkAbort(input.signal);
   const offered=new Set(input.tools.map(tool=>tool.function.name));if(answer.toolCalls.some(call=>!offered.has(call.function.name)))throw Error('模型请求了本轮未提供的工具；未执行任何调用。');return answer;
  }catch(error){if(error instanceof AgentBudgetError)throw error;if(input.signal.aborted)throw abortError();if(isContextWindowError(error))throw new AgentContextWindowError(redact(String((error as Error).message),key));throw Error(redact(controller.signal.aborted?String(controller.signal.reason?.message??'模型请求超时。'):String((error as Error).message),key));}
  finally{if(reserved&&!settled)input.onSettled(estimatedInput+estimateTokens(partial),true);clearTimeout(timer);controller.abort();input.signal.removeEventListener('abort',abort);}
  })();}finally{release();}
 };
}
