import type {ModelProvider} from '../shared/model-providers';

export type ModelLane='assistant'|'translation';
/** Each purpose has two slots; a shared connection/group has two slots in total.
 * Waiting work alternates between purposes. Separate accounts can opt into the
 * same rateLimitGroup without comparing or exposing credentials. */
export function createModelScheduler(){
 type Waiter={group:string;lane:ModelLane;signal:AbortSignal;resolve:(release:()=>void)=>void;reject:(error:Error)=>void;cancel:()=>void};
 const waiting:Waiter[]=[],groups=new Map<string,number>(),lanes:Record<ModelLane,number>={assistant:0,translation:0};let previous:ModelLane='translation';
 function drain(){
  while(true){
   const eligible=(item:Waiter)=>lanes[item.lane]<2&&(groups.get(item.group)||0)<2;
   let index=waiting.findIndex(item=>item.lane!==previous&&eligible(item));if(index<0)index=waiting.findIndex(eligible);if(index<0)return;
   const item=waiting.splice(index,1)[0];item.signal.removeEventListener('abort',item.cancel);if(item.signal.aborted){item.reject(Error('请求已停止。'));continue;}
   previous=item.lane;lanes[item.lane]++;groups.set(item.group,(groups.get(item.group)||0)+1);let released=false;
   item.resolve(()=>{if(released)return;released=true;lanes[item.lane]--;const count=(groups.get(item.group)||1)-1;if(count)groups.set(item.group,count);else groups.delete(item.group);drain();});
  }
 }
 function acquire(provider:ModelProvider,lane:ModelLane,signal:AbortSignal):Promise<()=>void>{
  if(signal.aborted)return Promise.reject(Error('请求已停止。'));
  return new Promise((resolve,reject)=>{const item:Waiter={group:provider.rateLimitGroup||'connection:'+provider.id,lane,signal,resolve,reject,cancel:()=>{const index=waiting.indexOf(item);if(index>=0)waiting.splice(index,1);reject(Error('请求已停止。'));}};waiting.push(item);signal.addEventListener('abort',item.cancel,{once:true});drain();});
 }
 return{acquire};
}
export type ModelScheduler=ReturnType<typeof createModelScheduler>;
