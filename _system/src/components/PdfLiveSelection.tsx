import {useEffect,useRef,useState} from 'react';
import {mergeSelectionRects,normalizeRects,type PdfSelectionRect} from '../pdfSelection';

/** Paint selection colour only. PDF glyphs remain solely on the original canvas. */
export default function PdfLiveSelection({layer,ready,layoutKey}:{layer:HTMLElement|null;ready:boolean;layoutKey:unknown}){
 const [rects,setRects]=useState<PdfSelectionRect[]>([]);
 const last=useRef('');
 useEffect(()=>{
  let frame=0;
  const update=()=>{
   frame=0;let next:PdfSelectionRect[]=[];
   const selection=layer?.ownerDocument.getSelection();
   if(ready&&layer&&selection&&!selection.isCollapsed&&selection.rangeCount===1){
    const range=selection.getRangeAt(0);
    const container=(node:Node)=>(node.nodeType===1?node as Element:node.parentElement)?.closest('.textLayer');
    const first=container(range.startContainer),end=container(range.endContainer),scroll=layer.closest('.pdf-scroll');
    if(first&&end&&scroll?.contains(first)&&scroll.contains(end)&&range.intersectsNode(layer)){
     const bounds=layer.getBoundingClientRect();
     const boxes=Array.from(range.getClientRects());
     if(boxes.length<=5000)next=mergeSelectionRects(normalizeRects(boxes,bounds));
    }
   }
   const key=JSON.stringify(next);if(last.current!==key){last.current=key;setRects(next);}
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(update);};
  const doc=layer?.ownerDocument;
  doc?.addEventListener('selectionchange',schedule);schedule();
  return()=>{if(frame)cancelAnimationFrame(frame);doc?.removeEventListener('selectionchange',schedule);};
 },[layer,ready,layoutKey]);
 return ready&&rects.length>0?<div className="pdf-live-selection" aria-hidden="true">{rects.map((rect,i)=><span key={i} style={{left:`${rect.x*100}%`,top:`${rect.y*100}%`,width:`${rect.width*100}%`,height:`${rect.height*100}%`}}/>)}</div>:null;
}
