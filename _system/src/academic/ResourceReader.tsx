import {useCallback,useEffect,useLayoutEffect,useId,useRef,useState,type ReactNode,type RefObject} from 'react';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import {openPdfDocument} from '../pdfDocument';
import {AlignLeft,ArrowLeft,BookmarkPlus,CornerDownLeft,ChevronLeft,ChevronRight,ExternalLink,Languages,LoaderCircle,Maximize2,Minimize2,Minus,NotebookPen,PanelRightClose,PanelRightOpen,Plus,Quote,Trash2,X} from 'lucide-react';
import type {Resource} from '../../shared/workspace-types';
import {readingPage,type ReadingDocument,type ReadingNote} from '../../shared/reading';
import {api,json} from '../api';
import {MODEL_CONFIG_EVENT} from '../modelSettings';
import {loadTranslationAdapters,runTranslationAdapters,type TranslationAdapter,type TranslationCard} from '../translationAdapters';
import {readReadingDraft,writeReadingDraft,clearReadingDraft,validateReadingDraft} from './readingDraft';
import {readingSelectionText} from './readingSelection';
import {readingPosition,readingPageInput} from './readingPosition';
import ContinuousPdf from './ContinuousPdf';
import ReadingSplit from './ReadingSplit';
import BilingualReading from './BilingualReading';
import ResearchTextEditor from './ResearchTextEditor';
import ReadingTranslation from './ReadingTranslation';
import AiMarkdown from '../components/AiMarkdown';
import 'katex/dist/katex.min.css';
import {wheelZoomSteps,zoomShortcutStep} from './readingZoom';
import './resource-reader.css';

type Saved={document:ReadingDocument;hash:string|null};
type PanelTab='excerpts'|'notes';
type ReaderSelection={quote:string;page:number|null;sourceHash:string;context:string};
const ZOOMS=[.5,.75,1,1.25,1.5,1.75,2,2.5,3];
const PREFS='echopaper-reader:prefs';
const AUTOSAVE_MS=1500;
interface Prefs{panel:boolean;tab:PanelTab;auto:boolean;source:string;target:'zh-CN'|'en';fit:boolean;pin:{x:number;y:number}|null;view:'original'|'bilingual';appendix:boolean}
function readPrefs():Prefs{const d:Prefs={panel:true,tab:'excerpts',auto:true,source:'',target:'zh-CN',fit:true,pin:null,view:'original',appendix:false};try{const v=JSON.parse(localStorage.getItem(PREFS)||'null');if(!v||typeof v!=='object')return d;return {panel:typeof v.panel==='boolean'?v.panel:d.panel,tab:v.tab==='notes'?'notes':'excerpts',auto:typeof v.auto==='boolean'?v.auto:d.auto,source:typeof v.source==='string'?v.source:'',target:v.target==='en'?'en':'zh-CN',fit:typeof v.fit==='boolean'?v.fit:d.fit,pin:v.pin&&Number.isFinite(v.pin.x)&&Number.isFinite(v.pin.y)?{x:v.pin.x,y:v.pin.y}:null,view:v.view==='bilingual'?'bilingual':'original',appendix:typeof v.appendix==='boolean'?v.appendix:d.appendix};}catch{return d;}}
function writePrefs(p:Prefs){try{localStorage.setItem(PREFS,JSON.stringify(p));}catch{/* Preferences are optional. */}}

export interface ResourceReaderProps {
 resource:Resource;
 onClose:()=>void;
 initialPage?:number;
 embedded?:boolean;
 onAppendToNote?:(text:string)=>void;
 onGuardChange?:(guard:(()=>Promise<boolean>)|undefined)=>void;
 onImmersiveChange?:(value:boolean)=>void;
 embeddedToolbar?:{title:ReactNode;actions:ReactNode;fullscreenTarget:RefObject<HTMLElement|null>};
}

export function readingExcerptMarkdown(resource:Resource,note:{quote:string;translation?:string;comment?:string;page:number|null;sourceHash?:string}):string {
 const title=(resource.title||resource.name.replace(/\.pdf$/i,'')).replace(/([\\[\]])/g,'\\$1');
 const stale=!!note.sourceHash&&!!resource.hash&&note.sourceHash!==resource.hash;
 const page=note.page!==null&&Number.isSafeInteger(note.page)&&note.page>0?note.page:null;
 const anchor=page!==null&&!stale?`#page=${page}`:'';
 const location=stale?' · 原件版本已变化，页码待核对':page!==null?` · p.${page}`:'';
 return [note.quote.trim().split('\n').map(line=>`> ${line}`).join('\n'),note.translation?.trim(),note.comment?.trim(),`[${title}](/api/workspace/resources/${encodeURIComponent(resource.id)}/raw${anchor})${location}`].filter(Boolean).join('\n\n')+'\n';
}

/**
 * Full-window reading workspace: the source takes most of the screen, selecting text
 * translates it in place, and excerpts / notes live in a side panel that autosaves.
 * Persistence rules are unchanged: per-tab drafts, hash-checked saves, conflict keeps both sides.
 */
export default function ResourceReader({resource:r,onClose,initialPage,embedded=false,onAppendToNote,onGuardChange,onImmersiveChange,embeddedToolbar}:ResourceReaderProps){
 const key=`echopaper-reading:${r.id}`,posKey=key+':position';
 const panelId=useId();
 const raw=`/api/workspace/resources/${r.id}/raw`,isPdf=/\.pdf$/i.test(r.name);
 const [prefs,setPrefsState]=useState<Prefs>(readPrefs);
 const [embeddedPanel,setEmbeddedPanel]=useState(false);
 const [fullscreen,setFullscreen]=useState(false);
 const [bilingualToolbar,setBilingualToolbar]=useState<HTMLDivElement|null>(null);
 const showPanel=embedded?embeddedPanel:prefs.panel,activeTab=embedded?'excerpts':prefs.tab;
 const prefsRef=useRef(prefs);prefsRef.current=prefs;
 const setPrefs=(update:Partial<Prefs>)=>setPrefsState(p=>{const next={...p,...update};writePrefs(next);return next;});
 const [saved,setSaved]=useState<Saved>(),[doc,setDoc]=useState<ReadingDocument>(),[error,setError]=useState(''),[status,setStatus]=useState('加载中'),[conflict,setConflict]=useState<Saved>();
 const [selected,setSelected]=useState<ReaderSelection>(),[translationCards,setTranslationCards]=useState<TranslationCard[]>([]),[translationError,setTranslationError]=useState('');
 const [adapters,setAdapters]=useState<TranslationAdapter[]>([]),[adapterError,setAdapterError]=useState(''),[translating,setTranslating]=useState(false);
 const [pdf,setPdf]=useState<PDFDocumentProxy>(),[text,setText]=useState<string>(),[page,setPage]=useState(1),[pageDraft,setPageDraft]=useState('1'),[zoom,setZoom]=useState(1),[fitZoom,setFitZoom]=useState(1),[busy,setBusy]=useState(false);
 const [sourceError,setSourceError]=useState(''),[sourceAttempt,setSourceAttempt]=useState(0);
 const [pop,setPop]=useState<{x:number;y:number;above:boolean}>();
 const [confirmExit,setConfirmExit]=useState(false),[readingError,setReadingError]=useState(''),[readingLoading,setReadingLoading]=useState(true),[dirtyView,setDirtyView]=useState(false);
 const selectionRef=useRef<ReaderSelection>(undefined),sourceVersion=useRef<string>(undefined),positionChanged=useRef(false);
 const shell=useRef<HTMLDivElement>(null),reading=useRef<HTMLDivElement>(null),alive=useRef(true),dirty=useRef(false),selectionEpoch=useRef(0),translationAbort=useRef<AbortController|undefined>(undefined),autosave=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),draftTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),scrollTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),dragCleanup=useRef<(()=>void)|undefined>(undefined);
 const translationAttempt=useRef('');
 const onKeyRef=useRef<(e:KeyboardEvent)=>void>(()=>{});
 const effectiveZoom=isPdf&&prefs.fit?fitZoom:zoom;
 const source=adapters.find(a=>a.id===prefs.source)||adapters[0];
 const markDirty=(value:boolean)=>{dirty.current=value;setDirtyView(value);};
 useEffect(()=>{onImmersiveChange?.(true);},[onImmersiveChange]);
 useEffect(()=>()=>onImmersiveChange?.(false),[onImmersiveChange]);
 useEffect(()=>{
  const changed=()=>{const target=embeddedToolbar?.fullscreenTarget.current||shell.current;setFullscreen(!!target&&document.fullscreenElement===target);};
  changed();document.addEventListener('fullscreenchange',changed);return()=>document.removeEventListener('fullscreenchange',changed);
 },[embeddedToolbar?.fullscreenTarget]);
 async function toggleFullscreen(){
  const target=embeddedToolbar?.fullscreenTarget.current||shell.current;if(!target)return;
  try{if(document.fullscreenElement===target)await document.exitFullscreen();else await target.requestFullscreen();}
  catch{setError('无法进入全屏，请通过浏览器的全屏功能继续阅读。');}
 }
 async function finishClose(){
  const target=embeddedToolbar?.fullscreenTarget.current||shell.current;
  if(target&&document.fullscreenElement===target)await document.exitFullscreen().catch(()=>{});
  onClose();
 }

 // ---------- loading ----------
 useEffect(()=>{
  alive.current=true;
  let savedPosition=readingPosition(null,r.hash);
  try{savedPosition=readingPosition(localStorage.getItem(posKey),r.hash);}catch{/* Use the default position when storage is unavailable. */}
  const start=initialPage&&initialPage>0?initialPage:savedPosition.page;
  setPage(start);setPageDraft(String(start));setZoom(savedPosition.zoom);
  void loadReading();
  return()=>{alive.current=false;translationAbort.current?.abort();clearTimeout(autosave.current);clearTimeout(draftTimer.current);clearTimeout(scrollTimer.current);dragCleanup.current?.();};
 },[]);
 useEffect(()=>{
  setSourceError('');setPdf(undefined);setText(undefined);sourceVersion.current=undefined;
  if(r.missing)return;
  const controller=new AbortController();
  let task:ReturnType<typeof openPdfDocument>|undefined;
  async function loadSource(){
   try{
    if(isPdf){
     task=openPdfDocument(r.hash?`${raw}?sourceHash=${encodeURIComponent(r.hash)}`:raw);
     const document=await task.promise;
     if(!controller.signal.aborted){sourceVersion.current=r.hash;setPdf(document);}
    }else{
     const result=await api<{content:string;hash:string}>(`/api/workspace/resources/${r.id}/text`,{signal:controller.signal});
     if(!controller.signal.aborted){sourceVersion.current=result.hash;setText(result.content);}
    }
   }catch(error){
    if(controller.signal.aborted)return;
    setSourceError((error as {status?:number})?.status===409?'原文件已更新，请返回资料列表刷新后重新打开。':error instanceof Error?error.message:'请重试加载原文。');
   }
  }
  void loadSource();
  return()=>{controller.abort();void task?.destroy().catch(()=>{});};
 },[isPdf,r.id,r.hash,r.missing,raw,sourceAttempt]);
 useEffect(()=>{
  let request:AbortController|undefined;
  const reload=()=>{
   request?.abort();
   const controller=request=new AbortController();
   void loadTranslationAdapters(controller.signal).then(items=>{
    if(controller.signal.aborted)return;
    setAdapters(items);setAdapterError('');
    setTranslationCards(cards=>cards.filter(card=>items.some(item=>item.id===card.id)));
   }).catch(error=>{
    if(!controller.signal.aborted)setAdapterError(error.message);
   });
  };
  reload();
  window.addEventListener(MODEL_CONFIG_EVENT,reload);
  return()=>{request?.abort();window.removeEventListener(MODEL_CONFIG_EVENT,reload);};
 },[]);
 useEffect(()=>{if(!text||isPdf)return;try{const p=readingPosition(localStorage.getItem(posKey+':text'),sourceVersion.current);if(reading.current)reading.current.scrollTop=p.top;}catch{}},[text,isPdf,posKey]);
 useEffect(()=>{const flush=()=>{if(draftTimer.current&&docRef.current){clearTimeout(draftTimer.current);draftTimer.current=undefined;try{writeReadingDraft(sessionStorage,key,{document:docRef.current,hash:savedRef.current?.hash??null});}catch{}}};const h=(e:BeforeUnloadEvent)=>{flush();if(dirty.current)e.preventDefault();};window.addEventListener('beforeunload',h);window.addEventListener('pagehide',flush);return()=>{flush();window.removeEventListener('beforeunload',h);window.removeEventListener('pagehide',flush);};},[key]);
 useEffect(()=>{document.addEventListener('selectionchange',select);return()=>document.removeEventListener('selectionchange',select);},[]);
 // The reader covers the whole window; keep the page behind it from scrolling.
 useEffect(()=>{if(embedded)return;const previous=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.body.style.overflow=previous;};},[embedded]);

 // Fit-to-width follows the reading column, including when the side panel opens or closes.
 useLayoutEffect(()=>{if(!pdf||!reading.current)return;let width=612,cancelled=false;const measure=()=>{const host=reading.current;if(!host||cancelled)return;const available=Math.max(1,host.clientWidth-(embedded?24:56));setFitZoom(Math.max(embedded ? .25 : .5,Math.min(3,available/width)));};void pdf.getPage(1).then(p=>{if(cancelled)return;width=p.getViewport({scale:1}).width;measure();}).catch(error=>{if(!cancelled&&alive.current)setError(error instanceof Error?error.message:String(error));});const observer=new ResizeObserver(measure);observer.observe(reading.current);return()=>{cancelled=true;observer.disconnect();};},[pdf,embedded]);
 useEffect(()=>{clearSelection();if(!positionChanged.current)return;try{localStorage.setItem(posKey,JSON.stringify({hash:r.hash,page,zoom}));}catch{setError('无法保存阅读位置');}},[zoom,prefs.fit]);

 async function loadReading(){setReadingLoading(true);setReadingError('');setStatus('加载中');await api<Saved>(`/api/workspace/resources/${r.id}/reading`).then(v=>{if(!alive.current)return;setSaved(v);let draft;try{draft=readReadingDraft(sessionStorage,localStorage,key);if(draft!==null)validateReadingDraft(draft,r.id);}catch{throw new Error('本机草稿读取失败，无法确认未保存文字；已暂停笔记编辑和保存。原草稿保持不变，请保留此窗口并先恢复草稿存储。');}if(draft?.document?.resourceId===r.id){setDoc(draft.document);markDirty(true);if(draft.hash!==v.hash){setConflict(v);setStatus('草稿与服务器版本不同，请比较');}else setStatus('已恢复未保存草稿');}else{setDoc(v.document);setStatus('已保存');}}).catch(e=>{if(alive.current){setReadingError(e.message);setStatus('笔记加载失败');}}).finally(()=>{if(alive.current)setReadingLoading(false);});}

 // ---------- notes persistence ----------
 const docRef=useRef<ReadingDocument|undefined>(undefined);docRef.current=doc;
 const savedRef=useRef<Saved|undefined>(undefined);savedRef.current=saved;
 const conflictRef=useRef<Saved|undefined>(undefined);conflictRef.current=conflict;
 const busyRef=useRef(false);busyRef.current=busy;
 const saveInFlight=useRef<Promise<boolean>|undefined>(undefined);
 const save=useCallback(async():Promise<boolean>=>{
  const current=docRef.current,base=savedRef.current;
  if(!current||!base||conflictRef.current||busyRef.current)return false;
  clearTimeout(autosave.current);setBusy(true);busyRef.current=true;setError('');setStatus('保存中…');
  const operation=(async()=>{
   try{
    const value=await api<Saved>(`/api/workspace/resources/${r.id}/reading`,json('PUT',{document:current,expectedHash:base.hash}));
    if(!alive.current)return false;
    setSaved(value);savedRef.current=value;
    if(docRef.current===current){
     markDirty(false);setStatus('已保存');
     try{clearReadingDraft(sessionStorage,key);}catch{setError('服务器笔记已保存，但本机旧草稿清理失败；再次打开时请比较版本。');}
    }else{
     try{writeReadingDraft(sessionStorage,key,{document:docRef.current,hash:value.hash});}catch{}
     scheduleSave();
    }
    return true;
   }catch(error:any){
    if(!alive.current)return false;
    setError(error.message);setStatus('保存失败');
    if(error.status===409){try{const latest=await api<Saved>(`/api/workspace/resources/${r.id}/reading`);setConflict(latest);conflictRef.current=latest;setStatus('与其他窗口的修改冲突');}catch{}}
    return false;
   }finally{if(alive.current){setBusy(false);busyRef.current=false;}}
  })();
  saveInFlight.current=operation;
  try{return await operation;}finally{if(saveInFlight.current===operation)saveInFlight.current=undefined;}
 },[r.id]);
 useEffect(()=>{
  if(!onGuardChange)return;
  const guard=async()=>{
   if(saveInFlight.current)await saveInFlight.current;
   if(!dirty.current)return true;
   if(conflictRef.current){if(embedded)setEmbeddedPanel(true);return false;}
   return await save()&&!dirty.current;
  };
  onGuardChange(guard);
  return()=>onGuardChange(undefined);
 },[onGuardChange,save,embedded]);
 function flushDraftNow(d=docRef.current){clearTimeout(draftTimer.current);draftTimer.current=undefined;if(!d)return;try{writeReadingDraft(sessionStorage,key,{document:d,hash:savedRef.current?.hash??null});}catch{setError('本机草稿保存失败，请保持页面并保存服务器笔记');}}
 function scheduleSave(){clearTimeout(autosave.current);autosave.current=setTimeout(()=>{if(dirty.current)void save();},AUTOSAVE_MS);}
 function edit(d:ReadingDocument){setDoc(d);docRef.current=d;markDirty(true);setStatus('编辑中');clearTimeout(draftTimer.current);draftTimer.current=setTimeout(()=>flushDraftNow(d),300);if(!conflictRef.current)scheduleSave();}
 function requestClose(){flushDraftNow();if(busy||dirty.current){if(!conflict&&!busy&&saved){void save().then(ok=>{if(ok)void finishClose();else setConfirmExit(true);});return;}setConfirmExit(true);return;}void finishClose();}

 // ---------- selection & translation ----------
 function clearSelection(){invalidateTranslation();selectionRef.current=undefined;setSelected(undefined);setTranslationCards([]);setTranslationError('');if(!prefsRef.current.auto||!prefsRef.current.pin)setPop(undefined);}
 function invalidateTranslation(){selectionEpoch.current++;translationAbort.current?.abort();translationAbort.current=undefined;setTranslating(false);}
 function select(){
  const selection=window.getSelection(),quote=readingSelectionText(selection,reading.current);
  if(quote===undefined)return;
  if(!quote){if(selectionRef.current)clearSelection();return;}
  const range=selection!.getRangeAt(0),node=range.startContainer;
  const element=node instanceof Element?node:node.parentElement;
  const pageElement=element?.closest('[data-pdf-page]'),pageNumber=Number(pageElement?.getAttribute('data-pdf-page'));
  const page=isPdf&&Number.isSafeInteger(pageNumber)&&pageNumber>0?pageNumber:null;
  const sourceHash=element?.closest('[data-source-hash]')?.getAttribute('data-source-hash')||sourceVersion.current||r.hash||'';
  if(quote===selectionRef.current?.quote&&page===selectionRef.current.page&&sourceHash===selectionRef.current.sourceHash)return;
  const container=pageElement?.querySelector('.textLayer')||reading.current;
  let offset=0;try{const preceding=document.createRange();preceding.selectNodeContents(container!);preceding.setEnd(node,range.startOffset);offset=preceding.toString().length;}catch{}
  const full=container?.textContent||'',context=full.slice(Math.max(0,offset-1500),offset+quote.length+1500).slice(0,9000);
  const next={quote,page,sourceHash,context};
  selectionRef.current=next;
  invalidateTranslation();setSelected(next);setTranslationCards([]);setTranslationError('');
 }
 function popoverBounds(){return embedded&&shell.current?shell.current.getBoundingClientRect():{left:0,top:0,right:window.innerWidth,bottom:window.innerHeight,width:window.innerWidth};}
 function clampPin(p:{x:number;y:number}){const bounds=popoverBounds(),width=Math.min(440,Math.max(0,bounds.width-24));return {x:Math.max(bounds.left+8,Math.min(bounds.right-width-8,p.x)),y:Math.max(bounds.top+56,Math.min(bounds.bottom-80,p.y))};}
 function placePopover(){if(prefsRef.current.auto&&prefsRef.current.pin){setPop({...clampPin(prefsRef.current.pin),above:false});return;}const selection=window.getSelection();if(!selection?.rangeCount||!selectionRef.current){return;}const rect=selection.getRangeAt(0).getBoundingClientRect();if(!rect.width&&!rect.height)return;const bounds=popoverBounds(),width=Math.min(440,Math.max(0,bounds.width-24)),x=Math.max(bounds.left+12,Math.min(bounds.right-width-12,rect.left+rect.width/2-width/2)),below=bounds.bottom-rect.bottom;const above=below<260&&rect.top-bounds.top>below;setPop({x,y:above?rect.top-10:rect.bottom+10,above});}
 const translate=useCallback(async(textToTranslate:string,onlyId?:string)=>{
  const services=onlyId?adapters.filter(adapter=>adapter.id===onlyId):adapters;
  if(!prefsRef.current.auto||!services.length||!textToTranslate)return;
  const epoch=selectionEpoch.current,controller=new AbortController();
  const attempt=JSON.stringify([epoch,textToTranslate,prefs.target,adapters.map(adapter=>[adapter.id,adapter.model,adapter.cacheVersion])]);
  if(!onlyId&&translationAbort.current&&translationAttempt.current===attempt)return;
  translationAttempt.current=attempt;
  translationAbort.current?.abort();translationAbort.current=controller;
  setTranslating(true);setTranslationError('');
  const loading=services.map(adapter=>({id:adapter.id,label:adapter.label,model:adapter.model,color:adapter.color,text:'',status:'loading' as const}));
  setTranslationCards(previous=>onlyId?previous.map(card=>loading.find(next=>next.id===card.id)||card):loading);
  try{
   const selection=selectionRef.current;
   let context=services.some(adapter=>adapter.supportsContext)?selection?.context:undefined;
   const at=selection?.page;
   if(pdf&&context&&at!=null&&selection?.sourceHash===sourceVersion.current){
    const surrounding=await Promise.allSettled([at-1,at+1].map(async number=>{
     if(number<1||number>pdf.numPages)return '';
     const content=await (await pdf.getPage(number)).getTextContent();
     const value=content.items.map(item=>'str'in item?item.str:'').join(' ');
     return number<at?value.slice(-1500):value.slice(0,1500);
    }));
    if(controller.signal.aborted||epoch!==selectionEpoch.current)return;
    context=[surrounding[0].status==='fulfilled'?surrounding[0].value:'',context,surrounding[1].status==='fulfilled'?surrounding[1].value:''].filter(Boolean).join('\n').slice(0,9000);
   }
   await runTranslationAdapters(services,{resourceId:r.id,text:textToTranslate,context,target:prefs.target,source:'pdf'},controller.signal,card=>{
    if(alive.current&&!controller.signal.aborted&&epoch===selectionEpoch.current)setTranslationCards(previous=>previous.map(item=>item.id===card.id?card:item));
   },!!onlyId);
  }catch(error){
   if(alive.current&&epoch===selectionEpoch.current&&!controller.signal.aborted)setTranslationError(error instanceof Error?error.message:'翻译失败，请重试。');
  }finally{
   if(alive.current&&translationAbort.current===controller){translationAbort.current=undefined;setTranslating(false);}
  }
 },[adapters,pdf,prefs.target,r.id]);
 // Translate automatically once the selection settles.
 useEffect(()=>{
  if(!selected||!prefs.auto||!adapters.length)return;
  const attempt=JSON.stringify([selectionEpoch.current,selected.quote,prefs.target,adapters.map(adapter=>[adapter.id,adapter.model,adapter.cacheVersion])]);
  const timer=setTimeout(()=>{if(prefsRef.current.auto&&translationAttempt.current!==attempt)void translate(selected.quote);},350);
  return()=>clearTimeout(timer);
 },[selected,prefs.auto,prefs.target,adapters,translate]);
 function closeTranslation(){window.getSelection()?.removeAllRanges();clearSelection();setPop(undefined);}
 function toggleTranslation(){
  const auto=!prefsRef.current.auto;
  prefsRef.current={...prefsRef.current,auto};setPrefs({auto});
  if(!auto){clearSelection();setPop(undefined);return;}
  select();requestAnimationFrame(placePopover);
 }

 // Dragging the box pins it where it is dropped; later selections update it in place.
 function startDrag(e:React.PointerEvent){if(!pop)return;e.preventDefault();dragCleanup.current?.();const box=(e.currentTarget as HTMLElement).closest('.reader-pop') as HTMLElement|null;const rect=box?.getBoundingClientRect();if(!rect)return;const dx=e.clientX-rect.left,dy=e.clientY-rect.top;let last={x:rect.left,y:rect.top};const move=(ev:PointerEvent)=>{last=clampPin({x:ev.clientX-dx,y:ev.clientY-dy});setPop({...last,above:false});};const up=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',up);if(dragCleanup.current===up)dragCleanup.current=undefined;if(alive.current)setPrefs({pin:last});};dragCleanup.current=up;document.addEventListener('pointermove',move);document.addEventListener('pointerup',up);document.addEventListener('pointercancel',up);}
 function togglePin(){if(prefs.pin){setPrefs({pin:null});if(!selectionRef.current)setPop(undefined);else requestAnimationFrame(placePopover);return;}const box=shell.current?.querySelector('.reader-pop')?.getBoundingClientRect();if(box)setPrefs({pin:clampPin({x:box.left,y:box.top})});}
 useEffect(()=>{
  if(!pop)return;
  const node=shell.current?.querySelector<HTMLElement>('.reader-pop');if(!node)return;
  const place=()=>{
   const rect=node.getBoundingClientRect(),bounds=popoverBounds();
   const dx=Math.max(bounds.left+8-rect.left,Math.min(0,bounds.right-8-rect.right));
   const dy=Math.max(bounds.top+44-rect.top,Math.min(0,bounds.bottom-8-rect.bottom));
   if(Math.abs(dx)>.5||Math.abs(dy)>.5)setPop(previous=>previous?{...previous,x:previous.x+dx,y:previous.y+dy}:previous);
  };
  place();const observer=new ResizeObserver(place);observer.observe(node);window.addEventListener('resize',place);
  return()=>{observer.disconnect();window.removeEventListener('resize',place);};
 },[!!pop]);
 // A pinned box is shown from the start as a fixed translation panel.
 useEffect(()=>{if(prefs.auto&&prefs.pin)setPop({...clampPin(prefs.pin),above:false});},[]);
 function addExcerpt(){
  const current=docRef.current,selection=selectionRef.current;
  if(!current||!selection)return;
  const completed=translationCards.filter(card=>card.status==='done');
  const preferred=completed.find(card=>card.id===source?.id)??completed[0];
  const note:ReadingNote={
   id:crypto.randomUUID(),quote:selection.quote,sourceHash:selection.sourceHash,page:selection.page,
   translation:preferred?.text||'',translationSource:preferred?.label||'',comment:'',
   locationKind:selection.page===null?'unlocated':'pdf-page',sourcePath:r.path,createdAt:new Date().toISOString(),
  };
  const next={...current,notes:[...current.notes,note]};
  edit(next);
  flushDraftNow(next);
  closeTranslation();
  if(embedded)setEmbeddedPanel(true);
  else setPrefs({panel:true,tab:'excerpts'});
 }
 // Excerpts become Markdown in the document notes so they can be reorganised freely.
 function insertIntoNotes(n:ReadingNote){if(!doc)return;const at=isPdf?readingPage(n):null;const block=[n.quote.split('\n').map(line=>'> '+line).join('\n'),n.translation?`\n${n.translation}`:'',`\n*— ${at!==null?`p.${at}`:'未定位'}*`,n.comment?`\n\n${n.comment}`:''].join('');const content=doc.content.trimEnd();edit({...doc,content:(content?content+'\n\n':'')+block+'\n'});setPrefs({tab:'notes'});}
 function appendExcerpt(note:ReadingNote){onAppendToNote?.(readingExcerptMarkdown(r,{...note,page:isPdf?readingPage(note):null}));}
 function changePage(value:number){
  clearSelection();positionChanged.current=true;
  const next=readingPageInput(value,pdf?.numPages??Number.MAX_SAFE_INTEGER);
  setPage(next);setPageDraft(String(next));
  if(prefsRef.current.view==='bilingual')setPrefs({view:'original'});
  else reading.current?.querySelector(`[data-pdf-page="${next}"]`)?.scrollIntoView({block:'start'});
 }
 function stepZoom(direction:1|-1){positionChanged.current=true;const current=effectiveZoom;const next=direction>0?ZOOMS.find(z=>z>current+.01)??ZOOMS.at(-1)!:[...ZOOMS].reverse().find(z=>z<current-.01)??ZOOMS[0];setPrefs({fit:false});setZoom(next);}

 function shortcutZoom(steps:number,reset=false){
  const fitted=prefsRef.current.fit?effectiveZoom:undefined;
  positionChanged.current=true;setPrefs({fit:false});
  setZoom(current=>reset?1:Math.max(.5,Math.min(3,Math.round(((fitted??current)+steps*.1)*100)/100)));
 }
 useEffect(()=>{
  const node=reading.current;if(!node||!isPdf||prefs.view!=='original')return;
  const accumulator={delta:0,at:0};
  const wheel=(event:WheelEvent)=>{
   if(!event.ctrlKey||event.deltaY===0)return;
   event.preventDefault();event.stopPropagation();
   const steps=wheelZoomSteps(event,accumulator);if(steps)shortcutZoom(steps);
  };
  node.addEventListener('wheel',wheel,{passive:false});return()=>node.removeEventListener('wheel',wheel);
 },[isPdf,prefs.view,effectiveZoom]);

 // ---------- keyboard ----------
 onKeyRef.current=(e:KeyboardEvent)=>{if(embedded&&(!(e.target instanceof Node)||!shell.current?.contains(e.target)))return;const step=zoomShortcutStep(e);if(isPdf&&prefsRef.current.view==='original'&&step!==undefined&&e.target instanceof Node&&(reading.current?.contains(e.target)||reading.current?.matches(':hover'))&&!(e.target instanceof Element&&e.target.closest('input:not([type="number"]),textarea,[contenteditable="true"]'))){e.preventDefault();shortcutZoom(step,step===0);return;}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(embedded)e.stopPropagation?.();void save();return;}if(e.key==='Escape'){if(document.fullscreenElement){e.preventDefault();void document.exitFullscreen();return;}if(confirmExit){setConfirmExit(false);return;}if(pop){closeTranslation();return;}if(selectionRef.current){window.getSelection()?.removeAllRanges();clearSelection();return;}requestClose();}};
 useEffect(()=>{const onKey=(e:KeyboardEvent)=>onKeyRef.current(e);document.addEventListener('keydown',onKey);return()=>document.removeEventListener('keydown',onKey);},[]);

 const excerpts=doc?[...doc.notes].reverse():[];
 const statusTone=conflict||readingError?'warn':dirtyView||busy?'busy':'ok';
 const popupOrigin=embedded&&pop?shell.current?.getBoundingClientRect():undefined;
 return <div ref={shell} className={`reader-shell ${embedded?'embedded':''} is-immersive`} role={embedded?'region':'dialog'} aria-modal={embedded?undefined:true} aria-label={`阅读 · ${r.title||r.name}`}>
  <header className="reader-bar">
   <div className="reader-bar-start">
    <button className="reader-back" onClick={requestClose} aria-label={embeddedToolbar?'返回课题':embedded?'返回文献列表':'返回上一页'} title={embedded?'关闭当前文献':'返回上一页（Esc）'}><ArrowLeft size={17}/><span>{embeddedToolbar?'返回课题':embedded?'文献列表':'返回'}</span></button>
    {embeddedToolbar?<div className="reader-paper-title">{embeddedToolbar.title}</div>:<h1 title={r.path}>{r.title||r.name.replace(/\.pdf$/i,'')}</h1>}
   </div>
   {isPdf&&<div className="reader-bar-center">
    <div className="reader-views" role="group" aria-label="阅读视图">
     <button aria-pressed={prefs.view==='original'} onClick={()=>setPrefs({view:'original'})} title="原版 PDF">原版</button>
     <button aria-pressed={prefs.view==='bilingual'} onClick={()=>setPrefs({view:'bilingual'})} title="全文对照：只翻正文，图表公式与参考文献保留原文"><AlignLeft size={13}/>对照</button>
    </div>
    {prefs.view==='original'&&<><div className="reader-pager">
     <button aria-label="上一页" disabled={!pdf||page<=1} onClick={()=>changePage(page-1)}><ChevronLeft size={16}/></button>
     <input aria-label="页码" inputMode="numeric" disabled={!pdf} value={pageDraft} onChange={e=>setPageDraft(e.target.value.replace(/\D/g,''))} onBlur={()=>changePage(Number(pageDraft))} onKeyDown={e=>{if(e.key==='Enter')changePage(Number(pageDraft));}}/>
     <span>/ {pdf?.numPages||'…'}</span>
     <button aria-label="下一页" disabled={!pdf||page>=pdf.numPages} onClick={()=>changePage(page+1)}><ChevronRight size={16}/></button>
    </div>
    </>}
   </div>}
   {isPdf&&<div className="reader-bilingual-controls" ref={setBilingualToolbar} hidden={prefs.view!=='bilingual'}/>}
   <div className="reader-bar-end">
    {embeddedToolbar&&<div className="reader-study-actions">{embeddedToolbar.actions}</div>}
    <span className={`reader-status ${statusTone}`} role="status">{status}</span>
    <button className="reader-icon" aria-label={fullscreen?'退出全屏':'全屏阅读'} title={fullscreen?'退出全屏':'全屏阅读'} onClick={()=>void toggleFullscreen()}>{fullscreen?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button>
    <button className={`reader-toggle ${prefs.auto?'on':''}`} onPointerDown={event=>event.preventDefault()} onClick={toggleTranslation} title={prefs.auto?'关闭划词翻译':'开启划词翻译'} aria-label="划词翻译" aria-pressed={prefs.auto}><Languages size={16}/><span>翻译</span></button>
    {!r.missing&&<a className="reader-icon" href={raw} target="_blank" rel="noreferrer" title="用系统程序打开原文件"><ExternalLink size={16}/></a>}
    <button className={`reader-panel-toggle ${embedded?'reader-icon':'reader-toggle'}`} aria-label={embedded?(showPanel?'收起单篇摘录':'查看单篇摘录'):(showPanel?'隐藏笔记':'展开笔记')} aria-expanded={showPanel} aria-controls={panelId} onClick={()=>embedded?setEmbeddedPanel(value=>!value):setPrefs({panel:!prefs.panel})} title={embedded?(showPanel?'收起单篇摘录':'查看单篇摘录'):(showPanel?'隐藏笔记':'展开笔记')}>{showPanel?<PanelRightClose size={17}/>:<PanelRightOpen size={17}/>}<span>{embedded?'摘录':showPanel?'隐藏笔记':'展开笔记'}</span></button>
   </div>
  </header>
  {error&&<div className="reader-alert" role="alert">{error}<button onClick={()=>setError('')} aria-label="关闭提示"><X size={14}/></button></div>}
  <ReadingSplit className={`reader-body ${showPanel?'with-panel':''}`} enabled={showPanel} label={embedded?'调整阅读与摘录比例':'调整阅读与笔记比例'} storageKey={embedded?'echopaper:reading-excerpt-split':'echopaper:reading-note-split'} alwaysStacked={embedded} defaultHeight={embedded?65:60}>
   <div ref={reading} className="reader-source" tabIndex={0} aria-label="资料原文阅读区"
    onScroll={e=>{if(pop&&!(prefs.auto&&prefs.pin))setPop(undefined);if(!isPdf){const top=e.currentTarget.scrollTop;clearTimeout(scrollTimer.current);scrollTimer.current=setTimeout(()=>{try{localStorage.setItem(posKey+':text',JSON.stringify({hash:sourceVersion.current,top}));}catch{}},250);}}}
    onMouseUp={()=>{select();requestAnimationFrame(placePopover);}} onKeyUp={()=>{select();requestAnimationFrame(placePopover);}}>
    {isPdf&&prefs.view==='original'&&<div className="reader-source-tools"><div className="reader-zoom" title="Ctrl + 滚轮，Ctrl/⌘ + 加减号缩放，Ctrl/⌘ + 0 恢复 100%">
     <button aria-label="缩小" onClick={()=>stepZoom(-1)}><Minus size={13}/></button>
     <span>{Math.round(effectiveZoom*100)}%</span>
     <button aria-label="放大" onClick={()=>stepZoom(1)}><Plus size={13}/></button>
     <button className={prefs.fit?'on':''} onClick={()=>{positionChanged.current=true;setPrefs({fit:!prefs.fit});}} title="适应宽度">适宽</button>
    </div></div>}
    {r.missing?<div className="reader-empty"><p>原文件已失联；已有笔记仍可查看、编辑和保存。</p><p>请在资料详情中重新定位原文件后继续阅读和摘录。</p></div>
     :isPdf&&prefs.view==='bilingual'?<BilingualReading toolbarTarget={bilingualToolbar} resourceId={r.id} pdf={pdf} adapter={source} adapters={adapters} onSelectSource={id=>setPrefs({source:id})} target={prefs.target} translateAppendix={prefs.appendix} onToggleAppendix={value=>setPrefs({appendix:value})} onJumpToPage={changePage}/>
     :sourceError?<div className="reader-empty" role="alert"><p>{isPdf?'PDF 无法打开':'原文无法读取'}</p><p>{sourceError}</p><button type="button" className="reader-retry" onClick={()=>setSourceAttempt(attempt=>attempt+1)}>重试加载原文</button></div>
     :isPdf?(pdf?<ContinuousPdf pdf={pdf} zoom={effectiveZoom} container={reading} initialPage={readingPageInput(page,pdf.numPages)} onPage={value=>{positionChanged.current=true;setPage(value);setPageDraft(String(value));try{localStorage.setItem(posKey,JSON.stringify({hash:r.hash,page:value,zoom}));}catch{}}}/>:<div className="reader-empty" role="status"><LoaderCircle className="spin" size={20}/><p>正在加载 PDF…</p></div>)
     :text===undefined?<div className="reader-empty" role="status"><LoaderCircle className="spin" size={20}/><p>正在加载原文…</p></div>
     :/\.(md|markdown)$/i.test(r.name)&&text?<article className="reader-text reader-md reader-md-doc" style={{fontSize:15*zoom}}><AiMarkdown text={text}/></article>:<article className="reader-text" style={{fontSize:16*zoom}}>{text||'没有可读取的文本；可打开原文件并记录笔记。'}</article>}
   </div>
   <aside id={panelId} className="reader-panel" aria-label="摘录与笔记" hidden={!showPanel}>
    <div className="reader-tabs" role="tablist">
     <button role="tab" aria-selected={activeTab==='excerpts'} onClick={()=>setPrefs({tab:'excerpts'})}><Quote size={14}/>摘录<small>{doc?.notes.length||0}</small></button>
     {!embedded&&<button role="tab" aria-selected={activeTab==='notes'} onClick={()=>setPrefs({tab:'notes'})}><NotebookPen size={14}/>笔记</button>}
    </div>
    {readingError&&<div className="reader-alert inline" role="alert"><p>笔记未能载入：{readingError}</p><p>原文阅读不受影响。</p><button disabled={readingLoading} onClick={()=>void loadReading()}>重试加载笔记</button></div>}
    {conflict&&doc&&<div className="reader-alert inline" role="alert"><p><strong>与服务器版本冲突</strong>，双方内容均已保留，未自动覆盖。</p><details><summary>查看服务器内容</summary><pre>{JSON.stringify(conflict.document,null,2)}</pre></details><button onClick={()=>{const merged={...doc,content:doc.content+'\n\n【服务器笔记，待合并】\n'+conflict.document.content,notes:[...doc.notes,...conflict.document.notes.filter(n=>!doc.notes.some(x=>JSON.stringify(x)===JSON.stringify(n))).map(n=>({...n,id:crypto.randomUUID()}))]};setSaved(conflict);savedRef.current=conflict;setConflict(undefined);conflictRef.current=undefined;edit(merged);}}>保留双方后继续编辑</button></div>}
    {doc&&activeTab==='excerpts'&&<div className="reader-excerpts">
     {!excerpts.length&&<div className="reader-hint"><Quote size={20}/><p>{r.missing?'这篇文献还没有摘录。':'选中文字后，点击“存为摘录”。'}</p></div>}
     {excerpts.map(n=>{const at=isPdf?readingPage(n):null;return <article key={n.id} className="reader-excerpt">
      <header>{at!==null?<button className="reader-page-chip" disabled={n.sourceHash!==r.hash} onClick={()=>changePage(Math.min(pdf?.numPages||at,at))} title="跳转到该页">p.{at}</button>:<span className="reader-page-chip muted">未定位{n.locationKind===undefined?' · 待核对':''}</span>}{n.sourceHash!==r.hash&&<span className="reader-flag">原文件已变</span>}<time>{n.createdAt.slice(0,10)}</time><button className="reader-mini insert" aria-label="插入到笔记" title="以 Markdown 引用插入到笔记" onClick={()=>insertIntoNotes(n)}><CornerDownLeft size={13}/></button>{onAppendToNote&&<button className="reader-mini insert" aria-label="写入课题笔记" title="将此摘录和来源写入课题笔记" onClick={()=>appendExcerpt(n)}><NotebookPen size={13}/></button>}<button className="reader-mini" aria-label="删除摘录" title="删除摘录" onClick={()=>{if(confirm('删除这条摘录？保存后不可在此恢复。'))edit({...doc,notes:doc.notes.filter(v=>v.id!==n.id)});}}><Trash2 size={13}/></button></header>
      <blockquote>{n.quote}</blockquote>
      {n.translation&&<p className="reader-translation" title={n.translationSource}>{n.translation}</p>}
      <ResearchTextEditor aria-label="个人判断" placeholder="写下你的判断、疑问或可用之处…" value={n.comment} rows={Math.min(8,Math.max(2,n.comment.split('\n').length))} onChange={value=>edit({...doc,notes:doc.notes.map(v=>v.id===n.id?{...v,comment:value}:v)})}/>
     </article>;})}
    </div>}
    {doc&&activeTab==='notes'&&<div className="reader-notes">
     <div className="reader-notes-area">
      <ResearchTextEditor aria-label="文档笔记" maxLength={200000} placeholder="直接开始记录…" value={doc.content} onChange={value=>edit({...doc,content:value})}/>
     </div>
    </div>}
    <footer className="reader-panel-footer">
     <label>译为<select aria-label="翻译目标语言" value={prefs.target} onChange={e=>{clearSelection();setPrefs({target:e.target.value as Prefs['target']});}}><option value="zh-CN">中文</option><option value="en">English</option></select></label>
     {adapters.length>1&&<label>来源<select aria-label="翻译来源" value={source?.id||''} onChange={e=>{clearSelection();setPrefs({source:e.target.value});}}>{adapters.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select></label>}
     {!adapters.length&&<span className="reader-muted">未启用翻译来源</span>}
     <button className="reader-save" disabled={busy||!!conflict||!doc||!dirtyView} onClick={()=>void save()} title="⌘S">{busy?'保存中…':dirtyView?'保存':'已保存'}</button>
    </footer>
   </aside>
  </ReadingSplit>
  {pop&&(selected||prefs.auto&&prefs.pin)&&<div className={`reader-pop ${pop.above?'above':''} ${prefs.auto&&prefs.pin?'pinned':''}`} style={{left:pop.x-(popupOrigin?.left??0),top:pop.y-(popupOrigin?.top??0)}} onMouseDown={event=>{if(event.target instanceof Element&&event.target.closest('button'))event.preventDefault();}} role="dialog" aria-label={prefs.auto?'选区翻译与摘录':'选区摘录'}>
   {prefs.auto&&<ReadingTranslation cards={translationCards} error={translationError||adapterError} selected={!!selected} hasSources={adapters.length>0} busy={translating} pinned={!!prefs.pin} onDrag={startDrag} onPin={togglePin} onClose={closeTranslation} onRetry={id=>{if(selected)void translate(selected.quote,id);}}/>}
   {selected&&<footer>
    <span className="reader-muted">{selected.page!==null?`第 ${selected.page} 页 · `:''}{selected.quote.length} 字</span>
    <button type="button" className="primary" disabled={!doc} onClick={addExcerpt}><BookmarkPlus size={14}/>存为摘录</button>
    {!prefs.auto&&<button type="button" onClick={closeTranslation} aria-label="关闭摘录工具"><X size={14}/></button>}
   </footer>}
  </div>}
  {confirmExit&&<div className="reader-exit" role="alertdialog" aria-label="笔记尚未保存"><div>
   <h2>{busy?'笔记正在保存':'笔记尚未保存'}</h2>
   <p>{busy?'请等待保存完成。':conflict?'当前笔记与服务器版本冲突，请先在笔记栏中处理。':'关闭前请保存，或明确放弃本次修改。'}</p>
   <div><button onClick={()=>setConfirmExit(false)}>继续编辑</button><button disabled={busy||!!conflict||!saved} className="primary" onClick={()=>void save().then(ok=>{if(ok)void finishClose();})}>保存并关闭</button><button className="danger" disabled={busy} onClick={()=>{try{clearReadingDraft(sessionStorage,key);}catch{setError('无法清理当前窗口草稿，未关闭；请继续编辑或保存。');return;}markDirty(false);void finishClose();}}>放弃修改</button></div>
  </div></div>}
 </div>;
}
