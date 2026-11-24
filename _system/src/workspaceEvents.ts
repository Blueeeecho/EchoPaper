import type {WorkspaceEvent} from '../shared/types';

/** Browsers allow ~6 HTTP/1.1 sockets per origin; every component shares this one stream instead of opening its own. */
export type BusEvent=Omit<WorkspaceEvent,'type'|'projectId'>&{type:string;projectId?:string};
interface Listener{message?:(event:BusEvent)=>void;reconnect?:()=>void;status?:(connected:boolean)=>void}
const listeners=new Set<Listener>();
let source:EventSource|undefined,opened=false,connected=false;
function open(){
 source=new EventSource('/api/events');
 source.onopen=()=>{
  const again=opened;opened=true;connected=true;
  for(const item of [...listeners]){item.status?.(true);if(again)item.reconnect?.();}
 };
 source.onerror=()=>{connected=false;for(const item of [...listeners])item.status?.(false);};
 source.onmessage=message=>{
  let event:BusEvent;
  try{event=JSON.parse(message.data);}catch{return;}
  for(const item of [...listeners])try{item.message?.(event);}catch{/* one bad subscriber must not stop the others */}
 };
}
/** `reconnect` fires only after a dropped stream comes back, never for the first connection (callers load their own initial state). */
export function subscribeWorkspaceEvents(listener:Listener):()=>void{
 listeners.add(listener);
 if(!source)open();
 else if(connected)listener.status?.(true);
 return()=>{
  listeners.delete(listener);
  if(!listeners.size){source?.close();source=undefined;opened=false;connected=false;}
 };
}
