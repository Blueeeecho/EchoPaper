import {memo,useEffect,useLayoutEffect,useRef,useState,type PointerEvent,type RefObject} from 'react';
import {TextLayer,type PDFDocumentProxy} from 'pdfjs-dist';
import {mostVisiblePdfPage} from '../pdfClick';
import {readingPageInput} from './readingPosition';

export function PdfPage({pdf,number,zoom,visible,onLayout}:{pdf:PDFDocumentProxy;number:number;zoom:number;visible:boolean;onLayout:()=>void}){
 const host=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),layer=useRef<HTMLDivElement>(null);
 const rendering=useRef<ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>|undefined>(undefined);
 const [size,setSize]=useState({width:612,height:792}),[error,setError]=useState(''),[empty,setEmpty]=useState(false);
 const stopSelection=useRef<(()=>void)|undefined>(undefined);
 useLayoutEffect(()=>{if(visible)onLayout();},[visible,size,onLayout]);
 useEffect(()=>()=>stopSelection.current?.(),[visible,pdf,number,zoom]);
 useEffect(()=>{
  const drawingCanvas=canvas.current,textContainer=layer.current;
  if(!visible||!drawingCanvas||!textContainer)return;
  let cancelled=false,render:ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>|undefined,textLayer:TextLayer|undefined;
  const current=()=>!cancelled&&canvas.current===drawingCanvas&&layer.current===textContainer;
  const draw=async()=>{
   const page=await pdf.getPage(number);
   if(!current())return;
   const previous=rendering.current;
   if(previous){await previous.promise.catch(()=>{});if(!current())return;}
   const base=page.getViewport({scale:1});
   setSize(previous=>previous.width===base.width&&previous.height===base.height?previous:{width:base.width,height:base.height});
   const viewport=page.getViewport({scale:zoom}),context=drawingCanvas.getContext('2d');
   if(!context)throw Error('无法创建 PDF 画布。');
   setError('');setEmpty(false);
   drawingCanvas.width=viewport.width;drawingCanvas.height=viewport.height;
   textContainer.replaceChildren();textContainer.style.setProperty('--scale-factor',String(zoom));textContainer.style.setProperty('--total-scale-factor',String(zoom));
   render=page.render({canvas:drawingCanvas,canvasContext:context,viewport});rendering.current=render;
   // Cancellation may settle while text extraction is still pending.
   const drawing=render;
   void drawing.promise.catch(()=>{}).finally(()=>{if(rendering.current===drawing)rendering.current=undefined;});
   const content=await page.getTextContent();
   if(!current())return;
   setEmpty(!content.items.some(item=>'str'in item&&item.str.trim()));
   textLayer=new TextLayer({textContentSource:content,container:textContainer,viewport});
   await textLayer.render();
   if(!current())return;
   const end=document.createElement('div');end.className='endOfContent';textContainer.append(end);
   await render.promise;
  };
  void draw().catch(error=>{
   if(current()&&!['RenderingCancelledException','AbortException','AbortError'].includes(error?.name))setError(error instanceof Error?error.message:String(error));
  });
  return()=>{cancelled=true;render?.cancel();textLayer?.cancel();};
 },[pdf,number,zoom,visible]);
 const startSelecting=(event:PointerEvent)=>{
  const l=layer.current;
  if(!l||!event.isPrimary||event.button!==0)return;
  stopSelection.current?.();
  l.classList.add('selecting');
  const stop=(e?:globalThis.PointerEvent)=>{
   if(e&&e.pointerId!==event.pointerId)return;
   l.classList.remove('selecting');document.removeEventListener('pointerup',stop);document.removeEventListener('pointercancel',stop);window.removeEventListener('blur',cleanup);stopSelection.current=undefined;
  };
  const cleanup=()=>stop();
  stopSelection.current=cleanup;
  document.addEventListener('pointerup',stop);document.addEventListener('pointercancel',stop);window.addEventListener('blur',cleanup);
 };
 return <section onPointerDown={startSelecting} ref={host} data-pdf-page={number} aria-label={`PDF 第${number}页`} style={{width:size.width*zoom,minHeight:size.height*zoom}} className="resource-reader-page">{visible&&<><canvas ref={canvas}/><div ref={layer} className="textLayer"/>{empty&&<p>本页无可选文字，未进行 OCR。</p>}{error&&<p role="alert">{error}</p>}</>}</section>;
}
const WindowedPage=memo(PdfPage);

export default function ContinuousPdf({pdf,zoom,container,onPage,initialPage,navigation}:{pdf:PDFDocumentProxy;zoom:number;container:RefObject<HTMLDivElement|null>;onPage:(page:number)=>void;initialPage:number;navigation?:{page:number}}){
 const callback=useRef(onPage);callback.current=onPage;
 const [active,setActive]=useState<ReadonlySet<number>>(()=>new Set());
 const anchor=useRef<number|undefined>(undefined),lastPage=useRef<number|undefined>(undefined);
 const align=useRef<()=>void>(()=>{});
 const onLayout=useRef(()=>align.current()).current;
 const loadedPdf=useRef<PDFDocumentProxy|undefined>(undefined);
 useLayoutEffect(()=>{
  const root=container.current;
  if(!root)return;
  const pages=Array.from(root.querySelectorAll<HTMLElement>('[data-pdf-page]'));
  let frame=0;
  const syncAnchor=()=>{
   const target=anchor.current===undefined?undefined:pages[anchor.current-1];
   if(!target)return;
   // Scroll this pane only, and keep the target aligned when estimated page sizes resolve.
   const delta=target.getBoundingClientRect().top-root.getBoundingClientRect().top-root.clientTop;
   const next=Math.max(0,Math.min(root.scrollHeight-root.clientHeight,root.scrollTop+delta));
   if(Math.abs(root.scrollTop-next)>.75)root.scrollTop=next;
  };
  align.current=syncAnchor;
  const report=(page:number)=>{if(page!==lastPage.current){lastPage.current=page;callback.current(page);}};
  const track=()=>{
   cancelAnimationFrame(frame);
   frame=requestAnimationFrame(()=>{
    if(anchor.current!==undefined){syncAnchor();return;}
    const viewport=root.getBoundingClientRect();
    let first=0,end=pages.length;
    while(first<end){
     const middle=Math.floor((first+end)/2);
     if(pages[middle].getBoundingClientRect().bottom<=viewport.top)first=middle+1;
     else end=middle;
    }
    const visible=[];
    for(let index=first;index<pages.length;index++){
     const {top,bottom}=pages[index].getBoundingClientRect();
     if(top>=viewport.bottom)break;
     visible.push({page:index+1,top,bottom});
    }
    const current=mostVisiblePdfPage(visible,viewport.top,viewport.bottom);
    if(current)report(current);
   });
  };
  // Explicit jumps outrank overlap until actual scrolling resumes (not a layout-induced scroll event).
  const wheel=(event:WheelEvent)=>{if(!event.ctrlKey)anchor.current=undefined;};
  const touch=()=>{anchor.current=undefined;};
  const pointer=(event:globalThis.PointerEvent)=>{
   const rect=root.getBoundingClientRect();
   if(event.button===1||(event.target===root&&(event.clientX<rect.left+root.clientLeft||event.clientX>=rect.left+root.clientLeft+root.clientWidth)))anchor.current=undefined;
  };
  const keyboard=(event:KeyboardEvent)=>{if(['PageDown','PageUp','Home','End','ArrowUp','ArrowDown',' '].includes(event.key))anchor.current=undefined;};
  const observer=new IntersectionObserver(entries=>{
   setActive(previous=>{
    const next=new Set(previous);
    for(const entry of entries){
     const page=Number((entry.target as HTMLElement).dataset.pdfPage);
     if(entry.isIntersecting)next.add(page);else next.delete(page);
    }
    return next.size===previous.size&&[...next].every(page=>previous.has(page))?previous:next;
   });
  },{root,rootMargin:'1000px'});
  for(const page of pages)observer.observe(page);
  root.addEventListener('scroll',track,{passive:true});
  root.addEventListener('wheel',wheel,{passive:true});
  root.addEventListener('touchmove',touch,{passive:true});
  root.addEventListener('pointerdown',pointer);
  root.addEventListener('keydown',keyboard);
  const resize=new ResizeObserver(syncAnchor);resize.observe(root);
  return()=>{
   align.current=()=>{};cancelAnimationFrame(frame);observer.disconnect();resize.disconnect();
   root.removeEventListener('scroll',track);root.removeEventListener('wheel',wheel);
   root.removeEventListener('touchmove',touch);root.removeEventListener('pointerdown',pointer);root.removeEventListener('keydown',keyboard);
  };
 },[pdf,container]);
 useLayoutEffect(()=>{
  const next=readingPageInput(loadedPdf.current===pdf&&navigation?navigation.page:initialPage,pdf.numPages);
  loadedPdf.current=pdf;
  anchor.current=next;
  align.current();
  if(lastPage.current!==next){lastPage.current=next;callback.current(next);}
 },[pdf,navigation]);
 useLayoutEffect(()=>align.current(),[zoom]);
 return <>{Array.from({length:pdf.numPages},(_,i)=><WindowedPage key={i+1} pdf={pdf} number={i+1} zoom={zoom} visible={active.has(i+1)} onLayout={onLayout}/>)}</>;
}
