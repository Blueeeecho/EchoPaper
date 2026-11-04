export interface PointerCaptureHandle extends EventTarget { setPointerCapture(id:number):void;releasePointerCapture(id:number):void;hasPointerCapture(id:number):boolean }
/** Capture the drag without disabling text selection on the document. */
export function beginPaneResize(events:EventTarget,handle:PointerCaptureHandle,pointerId:number,left:number,width:number,onChange:(percent:number)=>void) {
 let active=true;
 const move=(event:Event)=>{const pointer=event as PointerEvent;if(active&&pointer.pointerId===pointerId&&width>0)onChange(Math.min(72,Math.max(28,(pointer.clientX-left)/width*100)));};
 const finish=(event?:Event)=>{if(event?.type!=='blur'&&event&&'pointerId'in event&&(event as PointerEvent).pointerId!==pointerId)return;if(!active)return;active=false;events.removeEventListener('pointermove',move);events.removeEventListener('pointerup',finish);events.removeEventListener('pointercancel',finish);events.removeEventListener('blur',finish);handle.removeEventListener('lostpointercapture',finish);try{if(handle.hasPointerCapture(pointerId))handle.releasePointerCapture(pointerId);}catch{}};
 events.addEventListener('pointermove',move);events.addEventListener('pointerup',finish);events.addEventListener('pointercancel',finish);events.addEventListener('blur',finish);handle.addEventListener('lostpointercapture',finish);
 try{handle.setPointerCapture(pointerId);}catch{/* Window listeners still clean up if capture is unavailable. */}
 return ()=>finish();
}
