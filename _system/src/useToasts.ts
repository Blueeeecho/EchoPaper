import {useCallback,useEffect,useRef,useState} from 'react';

export interface Toast {id:number;message:string;error:boolean}

/** Keep toast expiry independent of renders and merge repeated messages. */
export function createToastQueue(onChange:(toasts:Toast[])=>void) {
 let toasts:Toast[]=[],nextId=0,disposed=false;
 const timers=new Map<number,ReturnType<typeof setTimeout>>();
 const publish=()=>onChange([...toasts]);
 const clearTimer=(id:number)=>{
  clearTimeout(timers.get(id));
  timers.delete(id);
 };
 function dismiss(id:number) {
  if(disposed)return;
  clearTimer(id);
  toasts=toasts.filter(toast=>toast.id!==id);
  publish();
 }
 function notify(message:string,error=false) {
  if(disposed)return;
  const previous=toasts.find(toast=>toast.message===message&&toast.error===error);
  const toast=previous??{id:++nextId,message,error};
  clearTimer(toast.id);
  const next=[...toasts.filter(item=>item.id!==toast.id),toast];
  const evicted=next.slice(0,-4);
  for(const item of evicted)clearTimer(item.id);
  toasts=next.slice(-4);
  const timer=setTimeout(()=>{if(timers.get(toast.id)===timer)dismiss(toast.id);},error?9000:4500);
  timers.set(toast.id,timer);
  publish();
 }
 function dispose() {
  disposed=true;
  for(const timer of timers.values())clearTimeout(timer);
  timers.clear();toasts=[];
 }
 return {notify,dismiss,dispose};
}

export function useToasts() {
 const [toasts,setToasts]=useState<Toast[]>([]);
 const queue=useRef<ReturnType<typeof createToastQueue>|null>(null);
 if(!queue.current)queue.current=createToastQueue(setToasts);
 useEffect(()=>{
  // Strict Mode reconnects effects after cleanup without another render.
  if(!queue.current){queue.current=createToastQueue(setToasts);setToasts([]);}
  const current=queue.current;
  return()=>{current.dispose();if(queue.current===current)queue.current=null;};
 },[]);
 const notify=useCallback((message:string,error=false)=>queue.current?.notify(message,error),[]);
 const dismiss=useCallback((id:number)=>queue.current?.dismiss(id),[]);
 return {toasts,notify,dismiss};
}
