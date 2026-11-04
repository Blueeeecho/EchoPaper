import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PageViewport } from 'pdfjs-dist/types/src/display/display_utils';
import PdfLinks from './PdfLinks';
import PdfLiveSelection from './PdfLiveSelection';
import PdfVersionStatus from './PdfVersionStatus';
import PdfIssueSummary from './PdfIssueSummary';
import { measureUnresolvedPdfTokens, unresolvedPdfKinds, type PdfIssueRect } from '../pdfIssues';
import '../pdf-issues.css';
import{pdfPositionKey,normalizePdfPosition,readSession,writeSession,type PdfPosition}from'../workspaceSession';
import type { PdfDestinationLocation } from '../pdfDestinations';
import { shouldLocatePdf, mostVisiblePdfPage } from '../pdfClick';
import { clipPdfMarker, pdfDestinationMarker, type PdfMarkerRect } from '../pdfDestinationMarker';
import { findPdfWord,pdfWordAtPoint } from '../pdfWordTarget';
import { contextWordCandidates,scoreWordContext,type SyncWordHint } from '../syncWords';
import { pdfTextForMatching } from '../pdfTextMatch';
import { ArrowLeft, Download, FileText, Minus, Plus, ScanLine, MessageSquareText, Crosshair } from 'lucide-react';
import { pdfRasterSize } from '../pdfRaster';
import type { PdfSyncLocation } from '../../shared/sync-types';
import type { Build, Diagnostic, PdfAnnotation } from '../../shared/types';
import { applyPdfEmphasis } from '../pdfEmphasis';
import { PdfAnnotationMarks, usePdfAnnotations } from './PdfAnnotations';
GlobalWorkerOptions.workerSrc = workerUrl;
type PdfFocus = PdfSyncLocation & { destination?: boolean;word?:boolean;approximate?:boolean;rects?:PdfMarkerRect[] };

function PdfPage({ pdf, pageNumber, width, zoom, pixelRatio, annotations, diagnostics, activeId, onOpen, focus, onNavigateDestination,forceRender=false }: { pdf: PDFDocumentProxy; pageNumber: number; width: number; zoom: number; pixelRatio: number; annotations: PdfAnnotation[]; diagnostics: Diagnostic[]; activeId?: string; onOpen: (annotation: PdfAnnotation) => void; focus?: PdfFocus;onNavigateDestination:(location:PdfDestinationLocation)=>void|Promise<void>;forceRender?:boolean }) {
  const pageAnnotations = useMemo(() => annotations.filter(a => a.page === pageNumber), [annotations, pageNumber]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  // The first page must render even before a freshly opened WebKit window
  // delivers its first IntersectionObserver notification.
  const [visible, setVisible] = useState(pageNumber === 1);
  const [renderError, setRenderError] = useState('');
  const [renderState, setRenderState] = useState('waiting');
  const [layout,setLayout]=useState<{page:PDFPageProxy;viewport:PageViewport}>();
  const [destinationMarker,setDestinationMarker]=useState<{focus:PdfFocus;rect:PdfMarkerRect}>();
  const [issueRects, setIssueRects] = useState<PdfIssueRect[]>([]);
  const height=layout?.viewport.height??width*zoom*1.42;
  useEffect(()=>{let active=true;void pdf.getPage(pageNumber).then(page=>{const base=page.getViewport({scale:1});if(active)setLayout({page,viewport:page.getViewport({scale:width/base.width*zoom})});}).catch(error=>{if(active){setRenderState('error');setRenderError(error.message||'页面几何信息读取失败');}});return()=>{active=false;};},[pdf,pageNumber,width,zoom]);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const root = wrapper.current?.closest('.pdf-scroll') || null;
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) setVisible(true); }, { root, rootMargin: '700px' });
    if (wrapper.current) observer.observe(wrapper.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if ((!visible&&!forceRender) || width < 40 || !layout) return;
    setRenderError('');
    setRenderState('rendering');
    let cancelled = false;
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    let layer: TextLayer | undefined;
    (async () => {
      const {page,viewport}=layout;
      if (cancelled || !canvas.current || !text.current) return;

      const raster = pdfRasterSize(viewport.width, viewport.height, pixelRatio);
      const surface = canvas.current;
      surface.width = raster.pixelWidth; surface.height = raster.pixelHeight;
      surface.style.width = `${viewport.width}px`; surface.style.height = `${viewport.height}px`;
      text.current.style.width = `${viewport.width}px`; text.current.style.height = `${viewport.height}px`;
      text.current.style.setProperty('--scale-factor', String(viewport.scale));
      task = page.render({ canvasContext: surface.getContext('2d')!, canvas: surface, viewport, transform: [raster.scaleX, 0, 0, raster.scaleY, 0, 0] });
      await task.promise;
      if (cancelled || !text.current) return;
      setRenderState('canvas-ready');
      const textContent = await page.getTextContent();
      if (cancelled || !text.current) return;
      text.current.replaceChildren();
      layer = new TextLayer({ textContentSource: textContent, container: text.current, viewport });
      await layer.render();
      if (!cancelled) setRenderState('ready');
    })().catch(error => {
      if (error?.name !== 'RenderingCancelledException' && !cancelled) {
        console.warn('PDF 页面渲染失败', error);
        setRenderState('error');
        setRenderError(`${error?.name || 'Error'}: ${error?.message || String(error)}`);
      }
    });
    return () => { cancelled = true; task?.cancel(); layer?.cancel(); };
  }, [pdf, layout, visible, forceRender, pixelRatio]);
  useEffect(() => {
    if (renderState === 'ready' && text.current) applyPdfEmphasis(text.current, pageAnnotations);
  }, [pageAnnotations, renderState]);
  useEffect(() => {
    setIssueRects([]);
    if (renderState !== 'ready' || !text.current) return;
    // Measure after annotation emphasis, without changing the PDF text layer.
    const frame = requestAnimationFrame(() => {
      if (text.current) setIssueRects(measureUnresolvedPdfTokens(text.current, unresolvedPdfKinds(diagnostics, pageNumber)));
    });
    return () => cancelAnimationFrame(frame);
  }, [renderState, layout, diagnostics, pageNumber, pageAnnotations]);
  useLayoutEffect(()=>{
    if(!focus?.destination||renderState!=='ready'||!text.current)return;
    const sheet=text.current.getBoundingClientRect();if(!sheet.width||!sheet.height)return;
    const rects=[...text.current.querySelectorAll<HTMLElement>('span')].filter(span=>span.textContent?.trim()).map(span=>{
      const box=span.getBoundingClientRect();return{x:(box.left-sheet.left)/sheet.width,y:(box.top-sheet.top)/sheet.height,width:box.width/sheet.width,height:box.height/sheet.height};
    });
    setDestinationMarker({focus,rect:pdfDestinationMarker(focus,rects)});
  },[focus,renderState,layout]);
  const marker=focus?.destination?(destinationMarker?.focus===focus?destinationMarker.rect:undefined):focus&&clipPdfMarker(focus);
  const markers=focus?.rects?.length?focus.rects.map(clipPdfMarker).filter((r):r is PdfMarkerRect=>!!r):marker?[marker]:[];
  return <section className="pdf-sheet-wrap" ref={wrapper} data-page={pageNumber} data-render-state={renderState} data-layout-ready={!!layout} data-layout-width={layout?.viewport.width} aria-label={`PDF 第 ${pageNumber} 页`}>
    <div className="pdf-sheet" style={{ width: width * zoom, minHeight: height }}><canvas ref={canvas}/><div ref={text} className="textLayer"/><PdfLiveSelection layer={text.current} ready={renderState==='ready'} layoutKey={layout}/>{renderState==='ready'&&issueRects.length>0&&<div className="pdf-unresolved-marks" aria-hidden="true">{issueRects.map((rect,index)=><span key={index} className="pdf-unresolved-mark" style={rect}/>)}</div>}{visible&&layout&&renderState==='ready'&&<PdfLinks pdf={pdf} page={layout.page} viewport={layout.viewport} onNavigateDestination={onNavigateDestination}/>}{markers.map((marker,index)=><div key={index} className={`source-sync-flash ${focus?.word?'word':''}`} aria-label="跳转目标" title={focus?.approximate?'附近排版位置，未能可靠匹配词语':''} style={{left:`${marker.x*100}%`,top:`${marker.y*100}%`,width:`${marker.width*100}%`,height:`${marker.height*100}%`}}/>)}<PdfAnnotationMarks pageHeight={height} annotations={pageAnnotations} activeId={activeId} onOpen={onOpen}/>{renderError && <div role="alert" style={{ position: 'absolute', inset: '20px', lineHeight: 1.8, fontSize: 12, color: '#a44641', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', zIndex: 2 }}>第 {pageNumber} 页渲染失败：{renderError}</div>}</div>
    <span className="page-label">{String(pageNumber).padStart(2, '0')}</span>
  </section>;
}

export default function PdfPreview({ url, stale, status, buildDate, projectId, targetId, buildId, issuesBuild, pdfDiagnostics, onShowIssues, hideAnnotationTools = false, historical = false, onReturnLatest, onNavigateSource, onViewBuild, onSourceLocate, syncJump, syncNotice }: { url?: string; stale: boolean; status?: string; buildDate?: string; projectId: string; targetId: string; buildId?: string; issuesBuild?: Build; pdfDiagnostics?: Diagnostic[]; onShowIssues?: () => void; hideAnnotationTools?: boolean; historical?: boolean; onReturnLatest?: () => void; onNavigateSource?: (path:string,line?:number)=>void; onViewBuild?: (buildId:string)=>void; onSourceLocate?: (page:number,x:number,y:number,hint?:SyncWordHint)=>Promise<void>; syncJump?: {id:number;buildId:string;locations:PdfSyncLocation[];hint?:SyncWordHint};syncNotice?:string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const displayedPdf = loadedUrl === url ? pdf : undefined;
  const [error, setError] = useState('');
  const [wordNotice,setWordNotice]=useState('');
  const [wordRenderPages,setWordRenderPages]=useState<number[]>([]);
  const matchingText=useRef(new Map<number,Promise<string>>());
  const positionKey=pdfPositionKey(projectId,targetId);
  const [initialPosition]=useState(()=>normalizePdfPosition(readSession(positionKey)));
  const resumeAnchor=useRef<PdfPosition|undefined>(initialPosition),resumePending=useRef(true);
  const [zoom, setZoom] = useState(initialPosition?.zoom||1);
  const [width, setWidth] = useState(500);
  const [page, setPage] = useState(initialPosition?.page||1);
  const [locating, setLocating] = useState(true);
  const [readingHistory,setReadingHistory]=useState<{top:number;left:number;page:number}[]>([]);
  const navigation=useRef(0),identity=useRef(url);identity.current=url;
  const gesture=useRef<{x:number;y:number;id:number;dragged:boolean}|undefined>(undefined);
  const [syncFocus, setSyncFocus] = useState<PdfFocus>();
  const [pixelRatio, setPixelRatio] = useState(window.devicePixelRatio || 1);
  const area = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(initialPosition?.top||0);
  useEffect(() => {
    let media: MediaQueryList;
    const update = () => {
      media?.removeEventListener('change', update);
      const ratio = window.devicePixelRatio || 1;
      setPixelRatio(ratio);
      media = window.matchMedia(`(resolution: ${ratio}dppx)`);
      media.addEventListener('change', update);
    };
    update();
    window.addEventListener('resize', update);
    return () => { media.removeEventListener('change', update); window.removeEventListener('resize', update); };
  }, []);
  useEffect(() => {
    if (!area.current) return;
    const observer = new ResizeObserver(entries => {
      const gutter = parseFloat(getComputedStyle(entries[0].target).getPropertyValue('--pdf-page-gutter')) || 6;
      setWidth(Math.max(200, entries[0].contentRect.width - gutter * 2));
    });
    observer.observe(area.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    resumePending.current=true;
    setPdf(undefined); setLoadedUrl(undefined); setError(''); setLocating(true); setSyncFocus(undefined);setReadingHistory([]);setWordRenderPages([]);matchingText.current=new Map();navigation.current++;
    if (!url) return;
    let active = true;
    const loading = getDocument({
      url,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
    });
    loading.promise.then(doc => {
      if (active) { setPdf(doc); setLoadedUrl(url); setPage(value => Math.min(value, doc.numPages)); }
    }).catch(e => { if (active) setError(e.message || 'PDF 加载失败'); });
    return () => { active = false; void loading.destroy(); };
  }, [url]);
  const persistPosition=()=>{
    const scroll=area.current;if(!scroll||!displayedPdf||resumePending.current)return;
    const viewport=scroll.getBoundingClientRect(),elements=Array.from(scroll.querySelectorAll<HTMLElement>('[data-page]'));
    const n=mostVisiblePdfPage(elements.map(el=>{const r=el.getBoundingClientRect();return{page:Number(el.dataset.page),top:r.top,bottom:r.bottom};}),viewport.top,viewport.bottom)||page;
    const wrapper=scroll.querySelector<HTMLElement>(`[data-page="${n}"]`),bounds=wrapper?.getBoundingClientRect();
    const position={page:n,offset:bounds?.height?(viewport.top-bounds.top)/bounds.height:0,top:scroll.scrollTop,zoom};
    resumeAnchor.current=position;writeSession(positionKey,position);
  };
  const persistReading=useRef(persistPosition);persistReading.current=persistPosition;
  useEffect(()=>{const persist=()=>persistReading.current();window.addEventListener('pagehide',persist);return()=>{persist();window.removeEventListener('pagehide',persist);};},[positionKey]);
  useEffect(()=>{persistReading.current();},[zoom]);
  useLayoutEffect(()=>{
    if(!displayedPdf||!resumePending.current)return;
    let frame=0,attempts=0;
    const restore=()=>{
      const scroll=area.current;if(!scroll)return;
      const saved=resumeAnchor.current,n=Math.min(saved?.page||1,displayedPdf.numPages);
      const preceding=Array.from(scroll.querySelectorAll<HTMLElement>('[data-page]')).filter(el=>Number(el.dataset.page)<=n);
      const ready=preceding.length===n&&preceding.every(el=>Math.abs(Number(el.dataset.layoutWidth)-width*zoom)<.2);
      if(!ready&&attempts++<120){frame=requestAnimationFrame(restore);return;}
      const wrapper=scroll.querySelector<HTMLElement>(`[data-page="${n}"]`);
      scroll.scrollTop=saved&&wrapper?Math.max(0,scroll.scrollTop+wrapper.getBoundingClientRect().top-scroll.getBoundingClientRect().top+saved.offset*wrapper.getBoundingClientRect().height):savedScroll.current;
      savedScroll.current=scroll.scrollTop;resumePending.current=false;
    };
    frame=requestAnimationFrame(restore);return()=>cancelAnimationFrame(frame);
  },[displayedPdf,width,zoom]);
  function scrollToPage(value: number, y?: number, behavior:ScrollBehavior='smooth', x?:number) {
    const n = Math.max(1, Math.min(value, displayedPdf?.numPages || 1)); setPage(n);
    const sheet = area.current?.querySelector<HTMLElement>(`[data-page="${n}"] .pdf-sheet`);
    if (typeof y === 'number' && area.current && sheet) {
      const top = area.current.scrollTop + sheet.getBoundingClientRect().top - area.current.getBoundingClientRect().top + y * sheet.clientHeight - area.current.clientHeight * .28;
      const left=typeof x==='number'?Math.max(0,area.current.scrollLeft+sheet.getBoundingClientRect().left-area.current.getBoundingClientRect().left+x*sheet.clientWidth-area.current.clientWidth*.3):area.current.scrollLeft;
      area.current.scrollTo({ top: Math.max(0, top), left, behavior });
    } else sheet?.scrollIntoView({ block: 'start', behavior });
  }
  useEffect(() => {
    if (!displayedPdf || !syncJump || syncJump.buildId !== buildId || (!syncJump.locations.length&&!syncJump.hint)) return;
    let active=true;const token=++navigation.current,currentUrl=url;
    setWordNotice('');setSyncFocus(undefined);setWordRenderPages([]);
    void(async()=>{
      let pages=[...new Set(syncJump.locations.map(location=>location.page))];
      // Captured environments (ACM abstract) have no own SyncTeX geometry.
      // Search PDF text metadata first; render only the confidently matched page.
      if(!pages.length&&syncJump.hint){
        if(displayedPdf.numPages>256){setWordNotice('此文档过长，暂无可核对的摘要排版记录。');return;}
        const hint=syncJump.hint,cache=matchingText.current;
        const matches:{page:number;from:number;score:number}[]=[];
        for(let first=1;first<=Math.min(displayedPdf.numPages,256);first+=4){
          if(!active||token!==navigation.current||identity.current!==currentUrl)return;
          const numbers=Array.from({length:Math.min(4,displayedPdf.numPages-first+1,257-first)},(_,i)=>first+i);
          const texts=await Promise.all(numbers.map(n=>{
            let text=cache.get(n);
            if(!text){text=displayedPdf.getPage(n).then(p=>p.getTextContent()).then(content=>pdfTextForMatching(content.items.filter((item):item is Extract<typeof item,{str:string}>=>'str' in item)));cache.set(n,text);}
            return text;
          }));
          texts.forEach((text,i)=>contextWordCandidates(text,hint).forEach(match=>matches.push({page:numbers[i],from:match.from,score:match.score})));
        }
        if(!active||token!==navigation.current||identity.current!==currentUrl)return;
        matches.sort((a,b)=>b.score-a.score);
        const best=matches[0],next=matches[1];
        if(!best||best.score<8||(next&&best.score-next.score<2)){setWordNotice('这个词的 PDF 上下文不足或存在歧义，未跳转到不确定的位置。');return;}
        pages=[best.page];setWordRenderPages(pages);
      }
      await Promise.all(pages.map(n=>displayedPdf.getPage(n)));
      for(let frame=0;frame<240;frame++){
        if(!active||token!==navigation.current||identity.current!==currentUrl)return;
        if(pages.every(n=>area.current?.querySelector(`[data-page="${n}"]`)?.getAttribute('data-render-state')==='ready'))break;
        await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      }
      if(!active||token!==navigation.current||identity.current!==currentUrl)return;
      const candidates=syncJump.hint?pages.flatMap(n=>{
        const layer=area.current?.querySelector<HTMLElement>(`[data-page="${n}"] .textLayer`);if(!layer)return[];
        const word=findPdfWord(layer,syncJump.hint!,syncJump.locations.filter(location=>location.page===n));
        return word?[{page:n,...word,score:scoreWordContext(word.hint,syncJump.hint!)}]:[];
      }).sort((a,b)=>b.score-a.score):[];
      const word=candidates[0],location=syncJump.locations[0];
      if(word){scrollToPage(word.page,word.rect.y,'instant',word.rect.x);setSyncFocus({page:word.page,...word.rect,rects:word.rects,word:true,sourceLine:location?.sourceLine??0});}
      else if(location){
        scrollToPage(location.page,location.y,'instant',location.x);
        setSyncFocus({...location,width:Math.min(.014,1-location.x),height:Math.min(.012,1-location.y),approximate:true});
        if(syncJump.hint)setWordNotice('未能可靠匹配这个词，已定位到附近排版位置。');
      }else setWordNotice('这个词暂时没有可靠的 PDF 文字位置。');
    })().catch(()=>{if(active)setWordNotice('词语定位暂不可用，请在当前 PDF 上重试。');});
    return()=>{active=false;};
  }, [syncJump?.id, displayedPdf, buildId]);
  useEffect(()=>{if(!syncFocus)return;const timer=setTimeout(()=>setSyncFocus(undefined),4500);return()=>clearTimeout(timer);},[syncFocus]);
  const notes = usePdfAnnotations({ projectId, targetId, buildId: displayedPdf ? buildId : undefined, root: area, goToPage: scrollToPage, pdf: displayedPdf, onNavigateSource, onViewBuild });
  const noMarks = useMemo<PdfAnnotation[]>(() => [], []);
  const noDiagnostics = useMemo<Diagnostic[]>(() => [], []);
  useEffect(()=>()=>{navigation.current++;},[]);
  async function navigateDestination(location:PdfDestinationLocation){
    if(!displayedPdf||!area.current)return;
    const token=++navigation.current,currentUrl=url,scroll=area.current;
    const previous={top:scroll.scrollTop,left:scroll.scrollLeft,page};
    await displayedPdf.getPage(location.page);
    for(let frame=0;frame<120;frame++){
      if(identity.current!==currentUrl||token!==navigation.current)return;
      const predecessors=[...scroll.querySelectorAll<HTMLElement>('[data-page]')].filter(el=>Number(el.dataset.page)<=location.page);
      if(predecessors.length===location.page&&predecessors.every(el=>el.dataset.layoutReady==='true'))break;
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    }
    if(identity.current!==currentUrl||token!==navigation.current)return;
    const sheet=scroll.querySelector<HTMLElement>(`[data-page="${location.page}"] .pdf-sheet`);if(!sheet)return;
    setReadingHistory(old=>[...old.slice(-39),previous]);setPage(location.page);
    const y=location.y*sheet.clientHeight;
    scroll.scrollTo({top:Math.max(0,scroll.scrollTop+sheet.getBoundingClientRect().top-scroll.getBoundingClientRect().top+y-24),left:Math.max(0,scroll.scrollLeft+sheet.getBoundingClientRect().left-scroll.getBoundingClientRect().left+location.x*sheet.clientWidth-24),behavior:'instant'});
    setSyncFocus({page:location.page,x:location.x,y:location.y,width:0,height:0,sourceLine:0,...(location.rect??{}),destination:!location.rect});
  }
  function backToReading(){const previous=readingHistory.at(-1);if(!previous||!area.current)return;navigation.current++;setReadingHistory(old=>old.slice(0,-1));setPage(previous.page);setSyncFocus(undefined);area.current.scrollTo({top:previous.top,left:previous.left,behavior:'instant'});}
  function locateFromPdf(e:React.MouseEvent){
    // Only the explicit double-click gesture navigates; ordinary clicks remain native.
    if(e.type!=='dblclick')return;
    if(!onSourceLocate||!displayedPdf||!(e.target instanceof Element))return;
    const sheet=e.target.closest<HTMLElement>('.pdf-sheet'),surface=sheet?.querySelector('canvas');if(!surface||!sheet)return;
    const selection=window.getSelection(),selected=!!selection&&!selection.isCollapsed&&!!selection.anchorNode&&sheet.contains(selection.anchorNode);
    const interactive=!!e.target.closest('button,a,input,textarea,select,.pdf-document-link,.pdf-selection-menu');
    if(!shouldLocatePdf({button:e.button,detail:e.detail,enabled:locating,modified:e.metaKey||e.ctrlKey,interactive,dragged:gesture.current?.dragged??false,selected}))return;
    const box=surface.getBoundingClientRect(),n=Number(sheet.closest<HTMLElement>('[data-page]')?.dataset.page),x=Math.max(0,Math.min(1,(e.clientX-box.left)/box.width)),y=Math.max(0,Math.min(1,(e.clientY-box.top)/box.height));
    navigation.current++;setWordNotice('');
    const layer=sheet.querySelector<HTMLElement>('.textLayer'),word=layer?pdfWordAtPoint(layer,e.clientX,e.clientY):undefined;
    if(word)setSyncFocus({page:n,...word.rect,rects:word.rects,sourceLine:0,word:true});
    void onSourceLocate(n,x,y,word?.hint);
  }
  return <div className="preview-panel">
    <div className="panel-title"><div><FileText size={15}/><span>PDF 预览</span><span className="quiet" title="按显示器像素密度高清渲染；可用加号放大，PDF 原文件保持矢量文字">高清</span>{pdf && <span className="quiet">{pdf.numPages} 页</span>}<PdfVersionStatus hasPdf={!!url} stale={stale} status={status} historical={historical} notice={[syncNotice,wordNotice].filter(Boolean).join('\n')}/></div><div><PdfIssueSummary build={issuesBuild} displayedBuildId={displayedPdf ? buildId : undefined} onNavigateSource={onNavigateSource} onShowIssues={onShowIssues}/>{url && !hideAnnotationTools && <button type="button" className={`icon-button ${notes.open ? 'active' : ''}`} aria-label="切换 PDF 批注" aria-expanded={notes.open} title="批注：选择文字后右键，或右键空白处添加备注" onClick={notes.toggle}><MessageSquareText size={15}/><span className="pdf-notes-count">{notes.count || ''}</span></button>}{url && <a className="icon-button" href={url} download title="下载 PDF" aria-label="下载 PDF"><Download size={15}/></a>}</div></div>
    {historical && <div className="pdf-notice">正在查看历史编译版本 · 当前主稿未改变 <button onClick={onReturnLatest}>返回最新 PDF</button></div>}
    
    <div className="pdf-toolbar"><div className="page-input"><button className="icon-button" aria-label="返回上一阅读位置" disabled={!readingHistory.length} title="返回引用跳转前的位置" onClick={backToReading}><ArrowLeft size={14}/></button><input aria-label="跳转 PDF 页码" type="number" min="1" max={pdf?.numPages || 1} value={page} onChange={e => setPage(Number(e.target.value))} onKeyDown={e => { if (e.key === 'Enter') scrollToPage(page); }} onBlur={() => scrollToPage(page)}/><span>/ {pdf?.numPages || '—'}</span></div><div><button className="icon-button" onClick={() => setZoom(z => Math.max(.5, z - .1))} aria-label="缩小 PDF"><Minus size={14}/></button><span className="zoom-label" title="以适应栏宽为基准；点击右侧按钮恢复适宽">{Math.abs(zoom - 1) < .01 ? '适宽' : `适宽 ×${zoom.toFixed(1)}`}</span><button className="icon-button" onClick={() => setZoom(z => Math.min(3, z + .1))} aria-label="放大 PDF"><Plus size={14}/></button>{onSourceLocate && <button className={`icon-button ${locating ? 'active' : ''}`} aria-label="从 PDF 定位源码" aria-pressed={locating} title="双击 PDF 正文定位到源码对应词；单击或拖动只选择文字。点击此按钮开关双击定位" onClick={() => setLocating(!locating)}><Crosshair size={15}/></button>}<button className="icon-button" onClick={() => setZoom(1)} aria-label="适应宽度" title="适应宽度"><ScanLine size={15}/></button></div></div>
    <div className="pdf-scroll" ref={area} onPointerDown={e=>{gesture.current={x:e.clientX,y:e.clientY,id:e.pointerId,dragged:false};}} onPointerMove={e=>{const start=gesture.current;if(start&&e.buttons&&e.pointerId===start.id&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>4)start.dragged=true;}} onPointerCancel={()=>{gesture.current=undefined;}} onDoubleClick={locateFromPdf} onContextMenu={hideAnnotationTools ? undefined : notes.onContextMenu} onScroll={e => { if(resumePending.current)return; savedScroll.current = e.currentTarget.scrollTop; const elements = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-page]')); const viewport=e.currentTarget.getBoundingClientRect();const nearest=mostVisiblePdfPage(elements.map(el=>{const box=el.getBoundingClientRect();return{page:Number(el.dataset.page),top:box.top,bottom:box.bottom};}),viewport.top,viewport.bottom);if(nearest)setPage(nearest); persistReading.current(); }}>
      {error ? <div className="empty-state compact"><FileText size={32}/><h3>PDF 加载失败</h3><p>{error}</p></div> : displayedPdf ? Array.from({ length: displayedPdf.numPages }, (_, i) => <PdfPage key={`${url}-${i}`} pdf={displayedPdf} pageNumber={i + 1} width={width} zoom={zoom} pixelRatio={pixelRatio} focus={syncFocus?.page === i+1 ? syncFocus : undefined} annotations={hideAnnotationTools ? noMarks : notes.current} diagnostics={pdfDiagnostics || noDiagnostics} activeId={notes.activeId} onOpen={notes.show} onNavigateDestination={navigateDestination} forceRender={wordRenderPages.includes(i+1)||(syncJump?.buildId===buildId&&!!syncJump?.locations.some(location=>location.page===i+1))}/>) : <div className="empty-state"><div className="empty-document"><FileText size={35} strokeWidth={1}/></div><h3>{url ? '正在载入 PDF…' : '让文字成为论文'}</h3><p>{url ? '加载完成后即可选择文字添加批注。' : <>选择编译目标，点击「编译」<br/>成功后将在这里显示完整 PDF。</>}</p><span className="small-label">SOURCE → TECTONIC → PDF</span></div>}
    </div>
    {!hideAnnotationTools && <>{notes.panel}{notes.contextMenu}</>}
    <div className="preview-footer"><span className={url && !stale ? 'success-text' : 'quiet'}>{url ? stale ? '历史成功版本' : '最新编译版本' : '等待首次编译'}</span><span>{buildDate || '本地预览'}</span></div>
  </div>;
}
