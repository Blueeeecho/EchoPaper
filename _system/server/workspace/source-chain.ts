import type {ResearchEntrySource,ResearchEntryVersion,ResearchSourceStatus} from '../../shared/research-entries';
import {captureWorkTarget,type TargetContext} from './research-targets';
/** Check recorded versions, so a newer version cannot conceal changes in originally cited inputs. */
export async function checkSourceChain(context:TargetContext,entry:ResearchEntryVersion,entryId:string){
 let visited=0;const captures=new Map<string,Promise<ResearchEntrySource>>();
 async function inspect(source:ResearchEntrySource,stack:Set<string>,depth:number):Promise<ResearchSourceStatus>{
  if(++visited>1000||depth>24)return{state:'unavailable',message:'来源链超过核对范围，请分段复核。'};
  try{
   const key=JSON.stringify(source.target);let capture=captures.get(key);if(!capture){capture=captureWorkTarget(context,source.target);captures.set(key,capture);}
   const current=await capture,changed=current.fingerprint!==source.fingerprint,children:{source:ResearchEntrySource;status:ResearchSourceStatus}[]=[];
   if(source.target.kind==='research-entry'){
    const target=source.target,e=context.topic.workEntries!.find(e=>e.id===target.entryId)!,revision=source.version??e.revision,node=`${e.id}:${revision}`;
    if(stack.has(node))return{state:'unavailable',message:'来源关系存在循环，请复核关联。',current};
    const recorded=revision===e.revision?e:e.history.find(h=>h.revision===revision);
    if(!recorded)return{state:'unavailable',message:'所引条目的历史版本不可用。',current};
    const next=new Set(stack);next.add(node);
    for(const input of recorded.sources)children.push({source:input,status:await inspect(input,next,depth+1)});
   }
   const unavailable=children.find(c=>c.status.state==='unavailable'),upstream=children.find(c=>c.status.state==='changed');
   const state=unavailable?'unavailable':changed||upstream?'changed':'current';
   const message=unavailable?`上游来源不可用：${unavailable.source.label}`:changed?'来源已更新，需要复核':upstream?`条目内容未变，但上游来源已变化：${upstream.source.label}`:'所列来源链内容与记录一致';
   return{state,message,current,...(children.length?{children}:{})};
  }catch(e){return{state:'unavailable',message:(e as Error).message};}
 }
 const statuses:ResearchSourceStatus[]=[];
 for(const source of entry.sources)statuses.push(await inspect(source,new Set([`${entryId}:${entry.revision}`]),0));
 return statuses;
}
export function chainSummary(statuses:ResearchSourceStatus[]){
 if(!statuses.length)return{state:'unlinked',message:'尚未关联来源'};
 if(statuses.some(s=>s.state==='unavailable'))return{state:'unavailable',message:'来源链有不可用节点'};
 if(statuses.some(s=>s.state==='changed'))return{state:'changed',message:'来源链已变化，需要复核'};
 return{state:'current',message:'所列来源链内容一致'};
}
