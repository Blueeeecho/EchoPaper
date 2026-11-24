import {useEffect,useRef,useState,type RefObject} from 'react';
import {TextLayer,type PDFDocumentProxy} from 'pdfjs-dist';
import {mostVisiblePdfPage} from '../pdfClick';

export function PdfPage({pdf,number,zoom,container}:{pdf:PDFDocumentProxy;number:number;zoom:number;container:RefObject<HTMLDivElement|null>}){
 const host=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),layer=useRef<HTMLDivElement>(null);
 const rendering=useRef<ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>|undefined>(undefined);
 const [visible,setVisible]=useState(false),[size,setSize]=useState({width:612,height:792}),[error,setError]=useState(''),[empty,setEmpty]=useState(false);
 useEffect(()=>{const element=host.current;if(!element)return;let closed=false;const observer=new IntersectionObserver(entries=>{if(!closed&&entries[0])setVisible(entries[0].isIntersecting);},{root:container.current,rootMargin:'1000px'});observer.observe(element);return()=>{closed=true;observer.disconnect();};},[]);
 useEffect(()=>{if(!visible&&number!==1)return;let cancelled=false;void pdf.getPage(number).then(p=>{if(!cancelled){const v=p.getViewport({scale:1});setSize({width:v.width,height:v.height});}}).catch(()=>{});return()=>{cancelled=true;};},[pdf,number,visible]);
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
 const startSelecting=()=>{const l=layer.current;if(!l)return;l.classList.add('selecting');const stop=()=>{l.classList.remove('selecting');document.removeEventListener('pointerup',stop);};document.addEventListener('pointerup',stop);};
 return <section onPointerDown={startSelecting} ref={host} data-pdf-page={number} aria-label={`PDF 第${number}页`} style={{width:size.width*zoom,minHeight:size.height*zoom}} className="resource-reader-page">{visible&&<><canvas ref={canvas}/><div ref={layer} className="textLayer"/>{empty&&<p>本页无可选文字，未进行 OCR。</p>}{error&&<p role="alert">{error}</p>}</>}</section>;
}
export default function ContinuousPdf({pdf,zoom,container,onPage,initialPage}:{pdf:PDFDocumentProxy;zoom:number;container:RefObject<HTMLDivElement|null>;onPage:(page:number)=>void;initialPage:number}){
 const callback=useRef(onPage);callback.current=onPage;
 useEffect(()=>{
  const root=container.current;
  if(!root)return;
  const pages=Array.from(root.querySelectorAll<HTMLElement>('[data-pdf-page]'));
  let cancelled=false,frame=0,restoring=true,lastPage:number|undefined;
  const track=()=>{
   if(restoring)return;
   cancelAnimationFrame(frame);
   frame=requestAnimationFrame(()=>{
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
     visible.push({page:Number(pages[index].dataset.pdfPage),top,bottom});
    }
    const current=mostVisiblePdfPage(visible,viewport.top,viewport.bottom);
    if(current&&current!==lastPage){lastPage=current;callback.current(current);}
   });
  };
  root.addEventListener('scroll',track,{passive:true});
  // Only preceding page heights are needed for this initial position.
  void Promise.allSettled(Array.from({length:initialPage},(_,index)=>pdf.getPage(index+1))).then(()=>{
   if(cancelled)return;
   frame=requestAnimationFrame(()=>{
    pages[initialPage-1]?.scrollIntoView({block:'start'});
    frame=requestAnimationFrame(()=>{restoring=false;track();});
   });
  });
  return()=>{cancelled=true;cancelAnimationFrame(frame);root.removeEventListener('scroll',track);};
 },[pdf]);
 return <>{Array.from({length:pdf.numPages},(_,i)=><PdfPage key={i+1} pdf={pdf} number={i+1} zoom={zoom} container={container}/>)}</>;
}
