import {clipPdfMarker, type PdfMarkerRect} from './pdfDestinationMarker';
import {normalizeSyncText, scoreWordContext, sourceWordAt, syncWordRanges, type SyncWordHint} from './syncWords';

export interface PdfWordTarget {rect:PdfMarkerRect;rects?:PdfMarkerRect[];hint:SyncWordHint}
interface TextPart {node:Text;from:number;to:number}
interface LayerText {text:string;parts:TextPart[];layer:HTMLElement;bounds:DOMRect}
interface TextRun {text:string;left:number;right:number;top:number;bottom:number}

/** PDF.js item boundaries are not word boundaries: font changes may split one word. */
export function pdfRunBoundary(previous:TextRun,next:TextRun):{separator:string;dehyphenate:boolean} {
  const height=Math.min(previous.bottom-previous.top,next.bottom-next.top);
  const sameRow=Math.abs((previous.top+previous.bottom-next.top-next.bottom)/2)<=height*.55;
  const newRow=!sameRow&&next.top>=previous.bottom-height*.1;
  if(newRow&&/[-\u00ad]$/.test(previous.text)&&/^\p{L}/u.test(next.text))return{separator:'',dehyphenate:true};
  if(/\s$/.test(previous.text)||/^\s/.test(next.text))return{separator:'',dehyphenate:false};
  const touching=sameRow&&next.left>=previous.left&&next.left-previous.right<=Math.max(.8,height*.08);
  return{separator:touching?'':sameRow?' ':'\n',dehyphenate:false};
}

function readLayer(layer:HTMLElement):LayerText|undefined {
  const bounds=layer.getBoundingClientRect();if(!bounds.width||!bounds.height)return;
  const walker=layer.ownerDocument.createTreeWalker(layer,4),parts:TextPart[]=[];
  let text='',previous:TextRun|undefined,previousSpan:HTMLElement|undefined,node:Node|null;
  while((node=walker.nextNode())){
    const value=node.nodeValue||'';if(!value)continue;
    const span=node.parentElement?.closest('span');if(!span||!layer.contains(span))continue;
    const box=span.getBoundingClientRect(),run={text:value,left:box.left,right:box.right,top:box.top,bottom:box.bottom};
    if(previous&&previousSpan!==span){
      const boundary=pdfRunBoundary(previous,run);
      if(boundary.dehyphenate&&parts.length){text=text.slice(0,-1);parts[parts.length-1].to--;}
      text+=boundary.separator;
    }
    const from=text.length;text+=value;parts.push({node:node as Text,from,to:text.length});previous=run;previousSpan=span;
  }
  return{text,parts,layer,bounds};
}
function endpoint(index:LayerText,position:number,end:boolean):{node:Text;offset:number}|undefined {
  const parts=end?[...index.parts].reverse():index.parts;
  for(const part of parts){if(position>=part.from&&position<=part.to)return{node:part.node,offset:Math.min(part.node.length,position-part.from)};}
}
function wordRectangles(index:LayerText,from:number,to:number):DOMRect[] {
  const start=endpoint(index,from,false),end=endpoint(index,to,true);if(!start||!end||from>=to)return[];
  const range=index.layer.ownerDocument.createRange();range.setStart(start.node,start.offset);range.setEnd(end.node,end.offset);
  // getBoundingClientRect would surround both lines of a hyphenated word. Keep
  // separate visual fragments and choose the fragment at the actual click.
  return [...range.getClientRects()].filter(rect=>rect.width>0&&rect.height>0);
}
function distance(rect:{left:number;right:number;top:number;bottom:number},x:number,y:number){return Math.hypot(Math.max(rect.left-x,x-rect.right,0),Math.max(rect.top-y,y-rect.bottom,0));}
function normalizedRect(index:LayerText,rect:DOMRect):PdfMarkerRect|undefined {
  return clipPdfMarker({x:(rect.left-index.bounds.left)/index.bounds.width,y:(rect.top-index.bounds.top)/index.bounds.height,width:rect.width/index.bounds.width,height:rect.height/index.bounds.height});
}
function hintAt(index:LayerText,from:number,to:number):SyncWordHint {
  return{word:index.text.slice(from,to),before:index.text.slice(Math.max(0,from-120),from),after:index.text.slice(to,to+120)};
}
function targets(index:LayerText,filter?:string):PdfWordTarget[] {
  const result:PdfWordTarget[]=[];
  for(const {from,to} of syncWordRanges(index.text)){
    const hint=hintAt(index,from,to);if(filter&&normalizeSyncText(hint.word)!==filter)continue;
    const rects=wordRectangles(index,from,to).flatMap(rect=>{const normalized=normalizedRect(index,rect);return normalized?[normalized]:[];});
    if(rects.length)result.push({rect:rects[0],rects,hint});
  }
  return result;
}
/** Exact character ranges from the text layer; never mutate native selection. */
export function pdfWordAtPoint(layer:HTMLElement,clientX:number,clientY:number):PdfWordTarget|undefined {
  const index=readLayer(layer);if(!index)return;
  const doc=layer.ownerDocument as Document&{caretPositionFromPoint?:(x:number,y:number)=>{offsetNode:Node;offset:number}|null;caretRangeFromPoint?:(x:number,y:number)=>Range|null};
  const caret=doc.caretPositionFromPoint?.(clientX,clientY),range=caret?undefined:doc.caretRangeFromPoint?.(clientX,clientY);
  const node=caret?.offsetNode??range?.startContainer,offset=caret?.offset??range?.startOffset;
  const part=index.parts.find(part=>part.node===node);
  if(part&&offset!==undefined){
    const word=sourceWordAt(index.text,Math.min(part.to,part.from+offset));
    if(word){
      const boxes=wordRectangles(index,word.from,word.to).sort((a,b)=>distance(a,clientX,clientY)-distance(b,clientX,clientY));
      const box=boxes[0];if(box&&distance(box,clientX,clientY)<=Math.max(3,box.height*.4)){
        const rect=normalizedRect(index,box);if(rect)return{rect,rects:boxes.flatMap(box=>{const r=normalizedRect(index,box);return r?[r]:[];}),hint:hintAt(index,word.from,word.to)};
      }
    }
  }
  const nearby=targets(index).flatMap(target=>(target.rects??[target.rect]).map(rect=>({target:{...target,rect},distance:distance({left:index.bounds.left+rect.x*index.bounds.width,right:index.bounds.left+(rect.x+rect.width)*index.bounds.width,top:index.bounds.top+rect.y*index.bounds.height,bottom:index.bounds.top+(rect.y+rect.height)*index.bounds.height},clientX,clientY)}))).sort((a,b)=>a.distance-b.distance);
  return nearby[0]&&nearby[0].distance<=3?nearby[0].target:undefined;
}
function regionDistance(rect:PdfMarkerRect,regions:readonly PdfMarkerRect[]):number {
  return Math.min(...regions.map(region=>Math.hypot(Math.max(region.x-rect.x-rect.width,rect.x-region.x-region.width,0),Math.max(region.y-rect.y-rect.height,rect.y-region.y-region.height,0))));
}
/** Exported separately to exercise repeated-word/context matching without a browser. */
export function choosePdfWord(candidates:readonly PdfWordTarget[],hint:SyncWordHint,regions?:readonly PdfMarkerRect[]):PdfWordTarget|undefined {
  const wanted=normalizeSyncText(hint.word);if(!wanted)return;
  const ranked=candidates.filter(candidate=>normalizeSyncText(candidate.hint.word)===wanted).map(target=>({target,context:scoreWordContext(target.hint,hint),distance:regions?.length?regionDistance(target.rect,regions):0}));
  const near=regions?.length?ranked.filter(item=>item.distance<=.035):ranked;
  near.sort((a,b)=>b.context-a.context||a.distance-b.distance);
  if(!near.length)return;
  // Distinct equally plausible occurrences are not guessed.
  const first=near[0],second=near.find(item=>item.target.hint!==first.target.hint);
  if(second&&first.context===second.context&&Math.abs(first.distance-second.distance)<.002)return;
  return first.target;
}
export function findPdfWord(layer:HTMLElement,hint:SyncWordHint,regions?:readonly PdfMarkerRect[]):PdfWordTarget|undefined {
  const index=readLayer(layer);return index?choosePdfWord(targets(index,normalizeSyncText(hint.word)),hint,regions):undefined;
}
