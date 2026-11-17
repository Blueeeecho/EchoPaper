/** Bounded work with cancellable waiters, shared across background documents. */
export function createTaskPool(initialLimit:number,options:{maxLimit?:number;growthIntervalMs?:number;successesToGrow?:number;now?:()=>number}={}){
 const maximum=options.maxLimit??initialLimit,now=options.now??Date.now;
 let limit=initialLimit,active=0,limitedAt:number|undefined,adjustedAt=now(),successes=0;
 if(!Number.isSafeInteger(initialLimit)||initialLimit<1||!Number.isSafeInteger(maximum)||maximum<initialLimit)throw Error('并发范围无效。');
 const waiting:Array<{signal:AbortSignal;cancel:()=>void;start:()=>void}>=[];

 function drain(){
  while(active<limit&&waiting.length){
   const task=waiting.shift()!;
   task.signal.removeEventListener('abort',task.cancel);
   if(task.signal.aborted){task.cancel();continue;}
   task.start();
  }
 }

 function run<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
  if(signal.aborted)return Promise.reject(signal.reason??Error('任务已停止。'));
  return new Promise<T>((resolve,reject)=>{
   const task={signal,cancel:()=>{
    const index=waiting.indexOf(task);
    if(index>=0)waiting.splice(index,1);
    reject(signal.reason??Error('任务已停止。'));
   },start:()=>{
    active++;
    void Promise.resolve().then(()=>{signal.throwIfAborted();return work();}).then(resolve,reject).finally(()=>{active--;drain();});
   }};
   waiting.push(task);signal.addEventListener('abort',task.cancel,{once:true});drain();
  });
 }

 return {run,active:()=>active,limit:()=>limit,maximum:()=>maximum,
  throttled:()=>limitedAt!==undefined&&now()-limitedAt<120000,
  reduce(){limit=Math.max(1,Math.floor(limit/2));limitedAt=now();adjustedAt=now();successes=0;drain();},
  recover(cooldownMs=120000){
   successes++;
   if(limit===maximum||limitedAt!==undefined&&now()-limitedAt<cooldownMs)return;
   if(options.maxLimit!==undefined&&(now()-adjustedAt<(options.growthIntervalMs??30000)||successes<(options.successesToGrow??4)))return;
   limit++;adjustedAt=now();successes=0;drain();
  },
 };
}
