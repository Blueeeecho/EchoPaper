import {api,json} from './api';
import type{TranslationLanguage} from './selectionTranslation';
import type{PublicRegistry}from'../shared/model-providers';
export interface TranslationContext{projectId:string;text:string;target:TranslationLanguage;source:'tex'|'pdf';sourceLanguage?:'auto'|TranslationLanguage}
export interface TranslationAdapter{
 id:string;label:string;model:string;color?:string;cacheVersion?:string;
 /** Adapters sharing a backend concurrency limit use the same queue key. */
 queueKey:string;
 translate:(context:TranslationContext,signal:AbortSignal,onText:(text:string)=>void)=>Promise<string>;
}
export interface TranslationCard{id:string;label:string;model:string;color?:string;text:string;status:'loading'|'done'|'error'|'stopped';error?:string}
const cache=new Map<string,string>();
export async function streamTranslation(body:TranslationContext&{sourceId:string},signal:AbortSignal,onText:(text:string)=>void):Promise<string>{
 const response=await fetch('/api/ai/translate',{...json('POST',body),headers:{'Content-Type':'application/json'},signal});if(!response.ok){const error=await response.json().catch(()=>({}));throw Error(error.error||`翻译请求失败 (${response.status})`);}if(!response.body)throw Error('无法读取译文。');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',text='',done=false;
 const line=(value:string)=>{if(!value.trim())return;const event=JSON.parse(value);if(event.type==='error')throw Error(event.error||'翻译失败。');if(event.type==='delta'){if(typeof event.text!=='string')throw Error('译文格式无效。');text+=event.text;onText(text);}if(event.type==='done'){if(event.finishReason!=='stop'||!text.trim())throw Error('译文未完整返回，请重试。');done=true;}};
 try{while(!done){const chunk=await reader.read();buffer+=decoder.decode(chunk.value,{stream:!chunk.done});let index:number;while((index=buffer.indexOf('\n'))>=0){line(buffer.slice(0,index));buffer=buffer.slice(index+1);if(done)break;}if(chunk.done){if(buffer.trim()&&!done)line(buffer);break;}}if(!done)throw Error('译文连接提前结束，请重试。');return text;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function configuredTranslationAdapters(config:PublicRegistry):TranslationAdapter[]{return config.translations.filter(source=>source.enabled).map(source=>{const model=config.models.find(m=>m.id===source.modelId),provider=config.providers.find(p=>p.id===model?.providerId);return{id:source.id,label:source.label,model:model?.label||'模型未配置',color:source.color,cacheVersion:model?.cacheVersion,queueKey:provider?.rateLimitGroup||provider?.id||source.id,translate:async(context,signal,onText)=>{if(!model||!provider||!model.configured)throw Error('此来源尚未启用或未配置密钥，请打开划词翻译设置。');return streamTranslation({...context,sourceId:source.id},signal,onText);}};});}
export async function loadTranslationAdapters(signal:AbortSignal):Promise<TranslationAdapter[]>{
 return configuredTranslationAdapters(await api<PublicRegistry>('/api/ai/providers',{signal}));
}
/** One result card per configured adapter. A failed provider does not hide other results. */
export async function runTranslationAdapters(adapters:readonly TranslationAdapter[],context:TranslationContext,signal:AbortSignal,onCard:(card:TranslationCard)=>void,bypassCache=false){
 const queues=new Map<string,Promise<void>>();
 let occupied=0;const waiters:(()=>void)[]=[];
 async function slot(work:()=>Promise<void>){if(occupied>=2)await new Promise<void>(resolve=>waiters.push(resolve));else occupied++;try{await work();}finally{const next=waiters.shift();if(next)next();else occupied--;}}
 await Promise.all(adapters.map(adapter=>{
  const task=(queues.get(adapter.queueKey)||Promise.resolve()).then(()=>slot(async()=>{
   if(signal.aborted)return;
   const base={id:adapter.id,label:adapter.label,model:adapter.model,color:adapter.color},key=JSON.stringify([adapter.id,adapter.model,adapter.cacheVersion||'',context]);let text='';
   const cached=bypassCache?undefined:cache.get(key);
   if(cached!==undefined){onCard({...base,text:cached,status:'done'});return;}
   onCard({...base,text,status:'loading'});
   try{
    text=await adapter.translate(context,signal,value=>{text=value;if(!signal.aborted)onCard({...base,text,status:'loading'});});
    if(signal.aborted)return;
    if(!text.trim())throw Error('译文为空，请重试。');
    cache.set(key,text);if(cache.size>60)cache.delete(cache.keys().next().value!);
    onCard({...base,text,status:'done'});
   }catch(error){if(!signal.aborted)onCard({...base,text,status:'error',error:error instanceof Error?error.message:'翻译失败，请重试。'});}
  }));
  queues.set(adapter.queueKey,task);return task;
 }));
}
