import {memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type ReactElement} from 'react';
import {createPortal} from 'react-dom';
import {AlertTriangle,BookOpenCheck,ChevronRight,Gauge,LoaderCircle,RefreshCw,SlidersHorizontal,Square} from 'lucide-react';
import katex from 'katex';
import type {PDFDocumentProxy,RenderTask} from 'pdfjs-dist';
import {api,json} from '../api';
import {OCR_CONFIG_EVENT,openModelSettings,readOcrCredentials,type OcrCredentialStatus} from '../modelSettings';
import {isOcrEngineId} from '../serviceSetup';
import type {TranslationAdapter} from '../translationAdapters';
import type {TranslationLanguage} from '../selectionTranslation';
import {bilingualFigureRow,bilingualStats,buildBilingualDocument,type BilingualBlock,type BilingualDocument,type DocumentLayout} from '../../shared/bilingual';
import {ProcessingBadge,useReadingProcessing} from './ReadingProcessing';
import {pdfRegionBounds} from './pdfRegion';
import {readingSplitLimits} from './ReadingSplit';
import {BilingualDivider,BilingualZoom,readBilingualLayout,type BilingualLayout,type BilingualSplitControls,bilingualZoom} from './BilingualLayout';
import {textFingerprint as fingerprint,translationCacheKey as cacheKey,translationIndex} from '../../shared/bilingual-cache';
import {wheelZoomSteps,zoomShortcutStep} from './readingZoom';
import './bilingual.css';

/** 阅读方式：上下、左右、原版对照、仅译文、仅原文。由读者选，不替读者决定。 */
export type ReadingView='stacked'|'columns'|'page'|'zh'|'en';
const VIEWS:[ReadingView,string,string][]=[
 ['stacked','上下','原文一段、译文一段'],
 ['columns','左右','左原文、右译文，逐段对齐'],
 ['page','原版对照','左边原版页面、右边译文'],
 ['zh','仅译文','只看译文，按正文排版'],
 ['en','仅原文','只看原文'],
];
interface Loaded{parsed:boolean;sourceHash:string;stale:boolean;layout:DocumentLayout|null;translations:Record<string,string>}
interface EngineUsage{id:string;label:string;note:string;used:number;quota:number|null;remaining:number|null;kind?:'baidu-cloud'|'aistudio';period?:'month'|'day'}
interface Usage{month:string;day?:string;engines:EngineUsage[];settings:{quota:Record<string,number>;threshold:number;autoSwitch:boolean}}
/** 并发压在 3：解析接口限 2 QPS，翻译来源也各有速率限制。 */
const CONCURRENCY=3,SAVE_EVERY=1;
/** 与服务端单次翻译上限一致，过长的块交给划词翻译处理。 */
const MAX_BLOCK_CHARS=6000;

function lookup(translations:Record<string,string>,byText:Map<string,string>,adapter:TranslationAdapter|undefined,target:string,text:string):string|undefined{
 if(adapter){const exact=translations[cacheKey(adapter,target,text)];if(exact)return exact;}
 return byText.get(fingerprint(target,text));
}
/** 行内公式：把 $…$、\\(…\\) 渲染成真正的符号，读者不必直接面对 LaTeX 源码。 */
const INLINE_MATH=/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]{1,300}?)\$/g;
const MathText=memo(function MathText({text}:{text:string}){
 if(!text||!/[$\\]/.test(text))return <>{text}</>;
 const parts:ReactElement[]=[];
 let last=0,key=0;
 INLINE_MATH.lastIndex=0;
 for(let match=INLINE_MATH.exec(text);match;match=INLINE_MATH.exec(text)){
  const body=(match[1]??match[2]??match[3]??match[4]??'').trim();
  if(!body)continue;
  let html='';
  // 渲染不了就原样保留，宁可显示源码也不能吞掉内容
  try{html=katex.renderToString(body,{displayMode:false,throwOnError:true,output:'html'});}catch{continue;}
  if(match.index>last)parts.push(<span key={key++}>{text.slice(last,match.index)}</span>);
  parts.push(<span key={key++} className="bi-math" dangerouslySetInnerHTML={{__html:html}}/>);
  last=match.index+match[0].length;
 }
 if(!parts.length)return <>{text}</>;
 if(last<text.length)parts.push(<span key={key++}>{text.slice(last)}</span>);
 return <>{parts}</>;
});
function equation(text:string):string{
 const value=(text||'').trim().replace(/^\\\[|\\\]$|^\$\$|\$\$$/g,'').trim();
 if(!value)return '';
 try{return katex.renderToString(value,{displayMode:true,throwOnError:false,output:'html'});}catch{return '';}
}
/** 表格 HTML 来自解析服务，按渲染前的白名单清理，不执行其中的脚本或事件。 */
function safeTable(html:string):string{
 return html.replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,'')
  .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*>/gi,'')
  .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,'')
  .replace(/(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi,'');
}

export default function BilingualReading({resourceId,pdf,adapter,adapters,onSelectSource,target,translateAppendix,onToggleAppendix,onJumpToPage,toolbarTarget}:{
 toolbarTarget?:HTMLElement|null;resourceId:string;pdf?:PDFDocumentProxy;adapter?:TranslationAdapter;adapters:readonly TranslationAdapter[];onSelectSource:(id:string)=>void;
 target:TranslationLanguage;translateAppendix:boolean;
 onToggleAppendix:(value:boolean)=>void;onJumpToPage?:(page:number)=>void;
}){
 const processing=useReadingProcessing([resourceId]);
 const backgroundStatus=processing.snapshot?.statuses[resourceId];
 const backgroundBusy=!!processing.snapshot?.settings.enabled&&!!backgroundStatus&&['queued','ocr','translating'].includes(backgroundStatus.stage);
 const [loaded,setLoaded]=useState<Loaded>();
 const [error,setError]=useState(''),[notice,setNotice]=useState('');
 const [parsing,setParsing]=useState(false),[needKey,setNeedKey]=useState(false);
 const [credential,setCredential]=useState<OcrCredentialStatus>();
 const [usage,setUsage]=useState<Usage>(),[engine,setEngine]=useState('');
 const configuredEngine=[loaded?.layout?.engine,processing.snapshot?.settings.engineId,credential?.engine,...Object.keys(credential?.engines??{})]
  .find(id=>isOcrEngineId(id)&&credential?.engines[id]);
 const selectedEngine=engine||configuredEngine||credential?.engine;
 const missingKey=needKey||(isOcrEngineId(selectedEngine)&&credential?.engines[selectedEngine]===false);
 const [translations,setTranslations]=useState<Record<string,string>>({});
 const byText=useMemo(()=>translationIndex(translations),[translations]);
 const [running,setRunning]=useState(false),[saving,setSaving]=useState(false),[progress,setProgress]=useState({done:0,total:0});
 const [view,setView]=useState<ReadingView>(()=>{
  try{const value=localStorage.getItem('echopaper-bilingual:view');if(VIEWS.some(([id])=>id===value))return value as ReadingView;}catch{/* Reading preferences are optional. */}
  return 'stacked';
 });
 const displayView=loaded?.stale&&view==='page'?'stacked':view;
 const layoutKey=`echopaper-bilingual:layout:${resourceId}`;
 const [layout,setLayout]=useState(()=>{try{return readBilingualLayout(localStorage.getItem(layoutKey));}catch{return readBilingualLayout(null);}});
 const layoutRef=useRef(layout);layoutRef.current=layout;
 const [activeSide,setActiveSide]=useState<'source'|'translation'>('source');
 const activeSideRef=useRef(activeSide);activeSideRef.current=activeSide;
 const host=useRef<HTMLDivElement>(null),[readingWidth,setReadingWidth]=useState(0);
 useLayoutEffect(()=>{
  const node=host.current;if(!node)return;
  const measure=()=>setReadingWidth(node.clientWidth);
  measure();const observer=new ResizeObserver(measure);observer.observe(node);return()=>observer.disconnect();
 },[loaded?.parsed]);
 function rememberLayout(){try{localStorage.setItem(layoutKey,JSON.stringify(layoutRef.current));}catch{/* Reading preferences are optional. */}}
 function updateLayout(update:Partial<BilingualLayout>,commit=true){const next={...layoutRef.current,...update};layoutRef.current=next;setLayout(next);if(commit)rememberLayout();}
 useEffect(()=>{
  const node=host.current;if(!node)return;
  const scopes=toolbarTarget?[node,toolbarTarget]:[node];
  const wheelState={delta:0,at:0};
  let wheelSide:'source'|'translation'|undefined;
  function sideFor(target:EventTarget|null){
   const side=target instanceof Element?target.closest<HTMLElement>('[data-bi-side]')?.dataset.biSide:undefined;
   return view==='zh'?'translation':view==='en'?'source':side==='source'||side==='translation'?side:activeSideRef.current;
  }
  function activate(target:EventTarget|null){
   const side=sideFor(target);if(activeSideRef.current!==side){activeSideRef.current=side;setActiveSide(side);}return side;
  }
  function change(side:'source'|'translation',steps:number,reset=false){
   const key=side==='source'?'sourceZoom':'translationZoom';
   updateLayout({[key]:reset?100:bilingualZoom(layoutRef.current[key]+steps*10)});
  }
  const pointer=(event:PointerEvent)=>{activate(event.target);};
  const focus=(event:FocusEvent)=>{activate(event.target);};
  const wheel=(event:WheelEvent)=>{
   if(!event.ctrlKey||event.deltaY===0)return;
   event.preventDefault();event.stopPropagation();
   const side=activate(event.target);
   if(wheelSide!==side)wheelState.delta=0;wheelSide=side;
   const steps=wheelZoomSteps(event,wheelState);if(steps)change(side,steps);
  };
  const keyboard=(event:KeyboardEvent)=>{
   const step=zoomShortcutStep(event);if(step===undefined||!node.getClientRects().length)return;
   if(!(event.target instanceof Node)||!scopes.some(scope=>scope.contains(event.target as Node)||scope.matches(':hover')))return;
   if(event.target instanceof Element&&event.target.closest('input:not([type="number"]),textarea,[contenteditable="true"]'))return;
   event.preventDefault();event.stopPropagation();change(activate(event.target),step,step===0);
  };
  for(const scope of scopes){scope.addEventListener('pointerover',pointer);scope.addEventListener('focusin',focus);scope.addEventListener('wheel',wheel,{passive:false});}
  document.addEventListener('keydown',keyboard);
  return()=>{for(const scope of scopes){scope.removeEventListener('pointerover',pointer);scope.removeEventListener('focusin',focus);scope.removeEventListener('wheel',wheel);}document.removeEventListener('keydown',keyboard);};
 },[loaded?.parsed,view,toolbarTarget]);
 const range=readingSplitLimits(Math.max(1,readingWidth-32),160,160);
 const minimum=Math.max(15,range.minimum),maximum=Math.min(85,range.maximum);
 const ratio=Math.max(minimum,Math.min(maximum,layout.ratio));
 const split:BilingualSplitControls={value:ratio,minimum,maximum,onChange:(value,commit=true)=>updateLayout({ratio:value},commit),onCommit:rememberLayout};
 const layoutStyle={
  '--bi-left-track':`calc(${ratio}% - ${8*ratio/100}px)`,
  '--bi-source-size':`${14*layout.sourceZoom/100}px`,
  '--bi-target-size':`${14*layout.translationZoom/100}px`,
  '--bi-source-heading':`${17*layout.sourceZoom/100}px`,
  '--bi-target-heading':`${17*layout.translationZoom/100}px`,
  '--bi-source-title':`${21*layout.sourceZoom/100}px`,
  '--bi-target-title':`${16*layout.translationZoom/100}px`,
  '--bi-source-small':`${13*layout.sourceZoom/100}px`,
  '--bi-target-small':`${13*layout.translationZoom/100}px`,
 } as CSSProperties;
 const unsaved=useRef(new Map<string,Record<string,string>>());
 const alive=useRef(true),abort=useRef<AbortController|undefined>(undefined);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;abort.current?.abort();};},[]);
 useEffect(()=>{try{localStorage.setItem('echopaper-bilingual:view',view);}catch{/* Reading preferences are optional. */}},[view]);
 useEffect(()=>{
  let controller:AbortController|undefined;
  const refreshCredential=()=>{
   controller?.abort();
   const request=controller=new AbortController();
   void readOcrCredentials(request.signal).then(status=>{
    if(!request.signal.aborted){setCredential(status);setNeedKey(false);}
   }).catch(()=>{});
  };
  refreshCredential();
  window.addEventListener(OCR_CONFIG_EVENT,refreshCredential);
  return()=>{controller?.abort();window.removeEventListener(OCR_CONFIG_EVENT,refreshCredential);};
 },[]);

 const backgroundVersion=backgroundStatus?`${backgroundStatus.stage}:${backgroundStatus.done}:${backgroundStatus.updatedAt??''}`:'';
 const backgroundVersionRef=useRef(backgroundVersion);backgroundVersionRef.current=backgroundVersion;
 const syncedBackgroundVersion=useRef(backgroundVersion);
 const loadAbort=useRef<AbortController|undefined>(undefined);
 const load=useCallback(async()=>{
  loadAbort.current?.abort();
  const controller=new AbortController();loadAbort.current=controller;
  setError('');
  try{
   const [value,counts]=await Promise.all([
    api<Loaded>(`/api/workspace/resources/${resourceId}/bilingual`,{signal:controller.signal}),
    api<Usage>('/api/workspace/bilingual/usage',{signal:controller.signal}).catch(()=>undefined),
   ]);
   if(!alive.current||controller.signal.aborted)return;
   syncedBackgroundVersion.current=backgroundVersionRef.current;
   setLoaded(value);setTranslations({...value.translations,...unsaved.current.get(value.layout?.sourceHash??'')});
   if(counts)setUsage(counts);
  }catch(e:any){if(alive.current&&!controller.signal.aborted)setError(e.message);}
 },[resourceId]);
 useEffect(()=>{void load();return()=>loadAbort.current?.abort();},[load]);
 useEffect(()=>{
  if(!loaded||!backgroundVersion||backgroundVersion===syncedBackgroundVersion.current||running||parsing||saving)return;
  syncedBackgroundVersion.current=backgroundVersion;
  const controller=new AbortController();
  void api<Loaded>(`/api/workspace/resources/${resourceId}/bilingual`,{signal:controller.signal}).then(value=>{
   if(!controller.signal.aborted){setLoaded(value);setTranslations({...value.translations,...unsaved.current.get(value.layout?.sourceHash??'')});}
  }).catch(()=>{});
  return()=>controller.abort();
 },[!!loaded,backgroundVersion,resourceId,running,parsing,saving]);

 const doc:BilingualDocument|undefined=useMemo(()=>loaded?.layout?buildBilingualDocument(loaded.layout,{translateAppendix}):undefined,[loaded?.layout,translateAppendix]);
 const stats=useMemo(()=>doc?bilingualStats(doc):undefined,[doc]);
 /** 标题与摘要作为全篇背景，帮助模型统一术语和指代。 */
 const background=useMemo(()=>{
  if(!doc)return '';
  const abstract=doc.blocks.find(b=>b.section==='body'&&b.role==='paragraph'&&b.text.length>80);
  return [doc.title&&`论文标题：${doc.title}`,abstract&&`摘要片段：${abstract.text.slice(0,500)}`].filter(Boolean).join('\n');
 },[doc]);

 async function parse(force=false){
  setParsing(true);setError('');setNotice('');
  try{
   const value=await api<{layout:DocumentLayout;reused:boolean;translations:Record<string,string>;engineLabel?:string;switched?:string}>(`/api/workspace/resources/${resourceId}/bilingual`,json('POST',{force,...(selectedEngine?{engine:selectedEngine}:{})}));
   if(!alive.current)return;
   setLoaded({parsed:true,sourceHash:value.layout.sourceHash,stale:false,layout:value.layout,translations:value.translations||{}});
   setTranslations({...value.translations,...unsaved.current.get(value.layout.sourceHash)});setNeedKey(false);
   setNotice(value.reused?'已使用本机缓存的解析结果，未消耗额度。'
    :`${value.switched??''}解析完成，${value.engineLabel?value.engineLabel+' ':''}计费 ${value.layout.costPages} 页。`);
   const counts=await api<Usage>('/api/workspace/bilingual/usage').catch(()=>undefined);
   if(alive.current&&counts)setUsage(counts);
  }catch(e:any){if(alive.current){setError(e.message);if(/密钥|访问令牌/.test(e.message||''))setNeedKey(true);}}
  finally{if(alive.current)setParsing(false);}
 }

 async function flushTranslations(sourceHash:string){
  const buffer=unsaved.current.get(sourceHash);
  if(!buffer||!Object.keys(buffer).length)return;
  const entries={...buffer};
  await api(`/api/workspace/resources/${resourceId}/bilingual/translations`,json('POST',{entries,sourceHash}));
  for(const [key,value] of Object.entries(entries))if(buffer[key]===value)delete buffer[key];
 }

 /** 逐块翻译：图片、公式、表格、参考文献和附录不会进入队列。 */
 async function translateAll(){
  if(!doc||!adapter||!loaded?.layout||loaded.stale||saving)return;
  const sourceHash=loaded.layout.sourceHash;
  const order=new Map(doc.blocks.map((b,i)=>[b.id,i] as const));
  const neighbour=(index:number,step:1|-1)=>{
   for(let i=index+step;i>=0&&i<doc.blocks.length;i+=step){const b=doc.blocks[i];if(b.role==='paragraph'||b.role==='heading')return b.text;}
   return '';
  };
  const contextFor=(block:BilingualBlock)=>{
   if(!adapter.supportsContext)return undefined;
   const index=order.get(block.id)??0;
   const before=neighbour(index,-1).slice(-500),after=neighbour(index,1).slice(0,500);
   const value=[background,before&&`上文：${before}`,after&&`下文：${after}`].filter(Boolean).join('\n');
   return value?value.slice(0,8000):undefined;
  };
  const pending=doc.blocks.filter(b=>b.translate&&!lookup(translations,byText,adapter,target,b.text));
  if(!pending.length){setNotice('这篇的正文都已翻译完成。');return;}
  const controller=new AbortController();abort.current=controller;
  setRunning(true);setError('');setNotice('');setProgress({done:0,total:pending.length});
  const buffer=unsaved.current.get(sourceHash)??{};
  unsaved.current.set(sourceHash,buffer);
  let done=0,failed=0;
  let saveError='';
  let flushWork:Promise<void>|undefined;
  const flush=()=>flushWork??=flushTranslations(sourceHash)
   .then(()=>{saveError='';})
   .catch((error:Error)=>{saveError=error.message;})
   .finally(()=>{flushWork=undefined;});
  const queue=[...pending];
  const worker=async()=>{
   while(queue.length&&!controller.signal.aborted){
    const block=queue.shift()!;const key=cacheKey(adapter,target,block.text);
    try{
     if(block.text.length>MAX_BLOCK_CHARS){failed++;done++;if(alive.current)setProgress({done,total:pending.length});continue;}
     const context=contextFor(block);
     const text=await adapter.translate({resourceId,text:block.text,target,source:'pdf',context},controller.signal,()=>{});
     if(controller.signal.aborted||!alive.current)return;
     if(text.trim()){buffer[key]=text.trim();setTranslations(current=>({...current,[key]:text.trim()}));}
    }catch(e:any){if(!controller.signal.aborted)failed++;}
    done++;if(alive.current)setProgress({done,total:pending.length});
    if(Object.keys(buffer).length>=SAVE_EVERY)await flush();
   }
  };
  try{await Promise.all(Array.from({length:Math.min(CONCURRENCY,queue.length)},worker));}
  finally{
   await flush();
   if(alive.current){setRunning(false);abort.current=undefined;
    if(saveError)setError(`译文尚未保存成功，请点击重试保存。${saveError}`);
    else if(controller.signal.aborted)setNotice('已停止；已完成的译文都已保存，继续翻译会从未完成处接着来。');
    else if(failed)setError(`有 ${failed} 段未翻译成功，可再次点击“翻译正文”补齐。`);
    else setNotice('正文翻译完成。');}
  }
 }

 if(error&&!loaded)return <div className="bi-state"><AlertTriangle size={18}/><p>{error}</p><button onClick={()=>void load()}>重试</button></div>;
 if(!loaded)return <div className="bi-state"><LoaderCircle size={18} className="spin"/><p>正在读取对照数据…</p></div>;

 if(!loaded.parsed&&backgroundBusy)return <div className="bi-state"><LoaderCircle size={18} className="spin"/><ProcessingBadge status={backgroundStatus}/><p>后台正在准备全文对照，关闭阅读页面后会继续处理。</p>{backgroundStatus?.error&&<p className="bi-hint" role="status">{backgroundStatus.error}</p>}</div>;
 if(!loaded.parsed)return <div className="bi-state bi-intro">
  <BookOpenCheck size={22}/>
  <h2>全文对照</h2>
  <p>先解析这篇 PDF 的版面，再只翻译正文。图片、公式、表格保持原样，参考文献和附录默认保留原文。</p>
  {usage&&<EngineSwitch usage={usage} engine={selectedEngine||''} onEngine={id=>{setEngine(id);setNeedKey(false);setError('');}} disabled={parsing}/>}
  {missingKey?<div className="bi-key">
   <p className="bi-hint">请先配置所选 OCR 引擎的凭据。保存和测试不会提交 PDF，配置好后回到这里解析。</p>
   <button className="bi-primary" onClick={()=>openModelSettings('ocr',selectedEngine)}>配置 OCR API</button>
  </div>:<button className="bi-primary" disabled={parsing} onClick={()=>void parse()}>{parsing?<><LoaderCircle size={15} className="spin"/>正在解析（通常 10–60 秒）…</>:'解析全文版面'}</button>}
  {error&&<p className="bi-error" role="alert">{error}</p>}
  {!error&&backgroundStatus?.stage==='failed'&&backgroundStatus.error&&<p className="bi-error" role="alert">{backgroundStatus.error}</p>}
  <p className="bi-hint">解析结果按这份文件的内容缓存，同一篇不会重复计费。</p>
 </div>;

 const untranslated=doc?doc.blocks.filter(b=>b.translate&&!lookup(translations,byText,adapter,target,b.text)).length:0;
 split.firstId=doc?.blocks.find(block=>block.translate&&block.role==='paragraph')?.id;
 const toolbar=<div className="bi-toolbar">
   <div className="bi-toolbar-row bi-main-controls">
    <div className="bi-modes" role="group" aria-label="阅读方式">{VIEWS.map(([value,label,hint])=><button key={value} type="button" aria-pressed={displayView===value} disabled={loaded.stale&&value==='page'} title={hint} onClick={()=>setView(value)}>{label}</button>)}</div>
    {backgroundBusy&&<span className="bi-cache-status"><ProcessingBadge status={backgroundStatus}/></span>}
    {running?<button className="bi-stop" onClick={()=>abort.current?.abort()}><Square size={13}/>停止（{progress.done}/{progress.total}）</button>
     :!backgroundBusy&&!loaded.stale&&(untranslated>0
      ?adapter?<button className="bi-primary small" disabled={saving||parsing} onClick={()=>void translateAll()} title={`翻译正文剩余 ${untranslated} 段`}>翻译（{untranslated}）</button>
        :<button className="bi-primary small" onClick={()=>openModelSettings('translations')}>配置翻译 API</button>
      :<span className="bi-cache-status">已译</span>)}
    <details className="bi-settings" onKeyDown={event=>{if(event.key==='Escape'&&event.currentTarget.open){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;}}}>
     <summary aria-label="阅读设置" title="翻译来源、解析引擎与阅读设置"><SlidersHorizontal size={15}/></summary>
     <div className="bi-settings-panel">
      {stats&&<p className="bi-stats">正文 {stats.translate} 段 · 参考文献 {stats.references} · 附录 {stats.appendix} · 图 {stats.figures} · 公式 {stats.equations} · 表 {stats.tables}</p>}
      {(displayView==='page'||displayView==='columns')&&<label className="bi-check">原文占比<input type="range" aria-label="原文占比" min={Math.ceil(minimum)} max={Math.floor(maximum)} value={ratio} onChange={event=>updateLayout({ratio:Number(event.target.value)})}/><output>{Math.round(ratio)}%</output></label>}
      {adapters.length>0&&<label className="bi-check">译文来源
     <select aria-label="翻译来源" value={adapter?.id||''} disabled={running} onChange={e=>onSelectSource(e.target.value)}>
      {adapters.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
     </select></label>}
      {usage&&<EngineSwitch usage={usage} engine={selectedEngine||''} onEngine={id=>{setEngine(id);setNeedKey(false);}} disabled={backgroundBusy||parsing||running}/>}
      <label className="bi-check"><input type="checkbox" checked={translateAppendix} onChange={e=>onToggleAppendix(e.target.checked)}/>翻译附录</label>
      <div className="bi-settings-actions">{usage&&<UsageChip usage={usage} onSaved={setUsage}/>}
       <button className="bi-stop" onClick={()=>openModelSettings('ocr',selectedEngine)}>OCR API</button>
       <button className="bi-stop" onClick={()=>openModelSettings('translations')}>{adapter?'翻译 API':'配置翻译 API'}</button>
       <button className="bi-icon" title="重新解析版面（会再次计费）" disabled={backgroundBusy||parsing||running||saving} onClick={()=>{if(missingKey){openModelSettings('ocr',selectedEngine);return;}if(confirm('重新解析会再次消耗文档解析额度。继续？'))void parse(true);}}><RefreshCw size={14}/></button>
      </div>
     </div>
    </details>
   </div>
  </div>;
 const sourceHash=loaded.layout?.sourceHash;
 return <div ref={host} className="bi-root" style={layoutStyle} data-source-hash={sourceHash}>
  {toolbarTarget?createPortal(toolbar,toolbarTarget):toolbar}
  {loaded.stale&&<div className="bi-warn" role="alert">原文已更新，当前显示上一次的对照结果。 <button className="bi-primary small" disabled={backgroundBusy||parsing||saving} onClick={()=>missingKey?openModelSettings('ocr',selectedEngine):void parse()}>{missingKey?'配置 OCR API':parsing?'正在解析…':'解析新版原文'}</button></div>}
  {notice&&<p className="bi-notice">{notice}<button onClick={()=>setNotice('')} aria-label="关闭">×</button></p>}
  {sourceHash&&!loaded.stale&&Object.keys(unsaved.current.get(sourceHash)??{}).length>0&&!running&&<button className="bi-primary small" disabled={saving||parsing} onClick={()=>{
   setSaving(true);void flushTranslations(sourceHash).then(()=>{setError('');setNotice('译文已保存。');}).catch(error=>setError(error.message)).finally(()=>setSaving(false));
  }}>{saving?'正在保存…':'重试保存'}</button>}
  {error&&<p className="bi-error" role="alert">{error}<button onClick={()=>setError('')} aria-label="关闭">×</button></p>}
  {doc&&<article className={`bi-doc view-${displayView}`} tabIndex={0} aria-label="论文阅读正文">
   <div className="bi-pane-tools">
    {view!=='zh'&&<div className="bi-tools-source"><BilingualZoom label="原文" active={view==='en'||activeSide==='source'} value={layout.sourceZoom} onChange={sourceZoom=>updateLayout({sourceZoom})}/></div>}
    {view!=='en'&&<div className="bi-tools-target"><BilingualZoom label="译文" active={view==='zh'||activeSide==='translation'} value={layout.translationZoom} onChange={translationZoom=>updateLayout({translationZoom})}/></div>}
   </div>
   {displayView==='page'
    ?<PageByPage doc={doc} translations={translations} byText={byText} adapter={adapter} target={target} pdf={pdf} split={split} sourceZoom={layout.sourceZoom}/>
    :<Body doc={doc} translations={translations} byText={byText} adapter={adapter} target={target} pdf={loaded.stale?undefined:pdf} onJumpToPage={loaded.stale?undefined:onJumpToPage} split={displayView==='columns'?split:undefined}/>}
  </article>}
 </div>;
}

const Body=memo(function Body({doc,translations,byText,adapter,target,pdf,onJumpToPage,split}:{doc:BilingualDocument;translations:Record<string,string>;byText:Map<string,string>;adapter?:TranslationAdapter;target:TranslationLanguage;pdf?:PDFDocumentProxy;onJumpToPage?:(page:number)=>void;split?:BilingualSplitControls}){
 const nodes:ReactElement[]=[];
 const title=doc.blocks.find(b=>b.role==='doc_title');
 const metadata=doc.blocks.filter(b=>b.role==='meta'&&b.page===title?.page).sort((a,b)=>(a.rect?.[1]??0)-(b.rect?.[1]??0));
 let page=-1,group:BilingualBlock[]=[],groupSection:''|'references'|'appendix'='';
 const flush=()=>{
  if(!group.length)return;
  const label=groupSection==='references'?'参考文献':'附录与补充材料';
  const entries=group.filter(b=>b.role==='reference').length;
  const count=entries||group.filter(b=>b.role!=='figure'&&b.role!=='equation').length;
  const unit=entries?'条':'段';
  nodes.push(<details key={`skip-${nodes.length}`} className="bi-skipped"><summary><ChevronRight size={14}/><span>{label}</span><em>保留原文 · {count} {unit}</em></summary>
   <div>{group.map(block=><Block key={block.id} block={block} translations={translations} byText={byText} adapter={adapter} target={target} pdf={pdf} split={split}/>)}</div></details>);
  group=[];groupSection='';
 };
 for(let index=0;index<doc.blocks.length;index++){
  const block=doc.blocks[index];
  if(block.role==='doc_title'||metadata.includes(block))continue;
  const back=(block.section==='references'||block.section==='appendix')&&!block.translate;
  if(back){
   if(groupSection&&groupSection!==block.section)flush();
   groupSection=block.section as 'references'|'appendix';group.push(block);continue;
  }
  flush();
  if(block.page!==page){
   page=block.page;
   const at=page+1;
   nodes.push(<div key={`page-${block.id}`} className="bi-page">
    {onJumpToPage?<button onClick={()=>onJumpToPage(at)} title="在原版 PDF 中打开这一页">第 {at} 页</button>:<span>第 {at} 页</span>}</div>);
  }
  const row=bilingualFigureRow(doc.blocks,index);
  if(row){
   nodes.push(<div key={`figures-${block.id}`} className="bi-figure-row" style={{gridTemplateColumns:row.columns.map(column=>`minmax(0, ${column[0].rect![2]}fr)`).join(' ')}}>
    {row.columns.map(column=><div key={column[0].id}>{column.map(item=><Block key={item.id} block={item} translations={translations} byText={byText} adapter={adapter} target={target} pdf={pdf} split={split}/>)}</div>)}
    {row.captions.length>0&&<div className="bi-figure-row-caption">{row.captions.map(item=><Block key={item.id} block={item} translations={translations} byText={byText} adapter={adapter} target={target} pdf={pdf} split={split}/>)}</div>}
   </div>);
   index+=row.columns.reduce((count,column)=>count+column.length,row.captions.length)-1;
  }else nodes.push(<Block key={block.id} block={block} translations={translations} byText={byText} adapter={adapter} target={target} pdf={pdf} split={split}/>);
 }
 flush();
 return <>
  {title&&<header className="bi-title" data-pdf-page={title.page+1}><h1 data-bi-side="source" lang={target==='zh-CN'?'en':'zh-CN'}><MathText text={title.text}/></h1>
   {lookup(translations,byText,adapter,target,title.text)&&<p data-bi-side="translation" lang={target==='zh-CN'?'zh-CN':'en'}>{lookup(translations,byText,adapter,target,title.text)}</p>}
   {metadata.map(block=><Block key={block.id} block={block} translations={translations} byText={byText} adapter={adapter} target={target} pdf={pdf} split={split}/>)}</header>}
  {nodes}
 </>;
});
const Block=memo(function Block({block,translations,byText,adapter,target,pdf,split}:{block:BilingualBlock;translations:Record<string,string>;byText:Map<string,string>;adapter?:TranslationAdapter;target:TranslationLanguage;pdf?:PDFDocumentProxy;split?:BilingualSplitControls}){
 const zh=block.translate?lookup(translations,byText,adapter,target,block.text):undefined;
 if(block.role==='figure')return <figure className="bi-figure" data-bi-side="source" id={block.id} data-pdf-page={block.page+1}>
  <PdfRegion pdf={pdf} block={block} label={`原文第 ${block.page+1} 页插图`}/></figure>;
 if(block.role==='equation'){const html=equation(block.text);return <div className="bi-equation" data-bi-side="source" id={block.id} data-pdf-page={block.page+1}>{html?<span dangerouslySetInnerHTML={{__html:html}}/>:<code>{block.text}</code>}</div>;}
 // 表格直接用原版截图：重排后的 HTML 表格既失真又过高。
 if(block.role==='table')return <div className="bi-table" data-bi-side="source" id={block.id} data-pdf-page={block.page+1}>
  <PdfRegion pdf={pdf} block={block} label={`原文第 ${block.page+1} 页表格`}
   fallback={block.tableHtml?<div className="bi-table-html" dangerouslySetInnerHTML={{__html:safeTable(block.tableHtml)}}/>:<pre>{block.text}</pre>}/></div>;
 if(block.role==='code')return <pre className="bi-code" data-bi-side="source" id={block.id} data-pdf-page={block.page+1}>{block.text}</pre>;
 if(block.role==='reference')return <p className="bi-ref" data-bi-side="source" id={block.id} data-pdf-page={block.page+1}>{block.text}</p>;
 if(block.role==='meta')return <p className="bi-meta" data-bi-side="source" id={block.id} data-pdf-page={block.page+1}><MathText text={block.text}/></p>;
 const Tag=block.role==='heading'?(block.subType.endsWith('_3')||block.subType.endsWith('_4')?'h3':'h2'):'p';
 return <div className={`bi-pair ${block.role} ${block.translate?'is-translatable':''} ${zh?'has-zh':''}`} id={block.id} data-pdf-page={block.page+1}>
  <Tag className="bi-orig" data-bi-side="source" lang={target==='zh-CN'?'en':'zh-CN'}><MathText text={block.text}/></Tag>
  {split&&block.translate&&<BilingualDivider controls={split} focusable={block.id===split.firstId}/>}
  {zh?<Tag className="bi-zh" data-bi-side="translation" lang={target==='zh-CN'?'zh-CN':'en'}><MathText text={zh}/></Tag>
   :block.translate?<p className="bi-zh bi-waiting" data-bi-side="translation">待翻译</p>
   :block.skipReason&&block.skipReason!=='无需翻译'?<p className="bi-skip-note">{block.skipReason}·保留原文</p>:null}
 </div>;
});

function revokeBlob(url:string){if(url.startsWith('blob:'))URL.revokeObjectURL(url);}
function canvasToBlobUrl(canvas:HTMLCanvasElement):Promise<string>{
 return new Promise<string>((resolve,reject)=>{
  const release=()=>{canvas.width=0;canvas.height=0;};
  if(typeof canvas.toBlob!=='function'){
   try{const url=canvas.toDataURL('image/png');release();resolve(url);}catch(e){release();reject(e);}
   return;
  }
  canvas.toBlob(blob=>{
   release();
   if(blob)resolve(URL.createObjectURL(blob));else reject(Error('无法编码图像'));
  },'image/png');
 });
}

/**
 * 按版面坐标从原 PDF 裁出一块区域渲染成图片：表格与插图因此保持原版式。
 * 坐标来自解析结果的 position，按该页尺寸换算到 PDF 点坐标；进入视口才渲染。
 */
function PdfRegion({pdf,block,label,fallback}:{pdf?:PDFDocumentProxy;block:BilingualBlock;label:string;fallback?:ReactElement}){
 const host=useRef<HTMLDivElement>(null);
 const [url,setUrl]=useState('');
 const [failed,setFailed]=useState(false);
 const [sourceFailed,setSourceFailed]=useState(false);
 const source=block.imageUrl&&!sourceFailed?block.imageUrl:undefined;
 const ready=!!pdf&&!!block.rect&&!!block.pageWidth&&!!block.pageHeight;
 const geometry=JSON.stringify([block.page,block.rect,block.cropRect,block.pageWidth,block.pageHeight]);
 useEffect(()=>setSourceFailed(false),[block.imageUrl]);
 useEffect(()=>{
  setUrl(old=>{revokeBlob(old);return '';});setFailed(false);
  if(source||!ready)return;
  const node=host.current;if(!node)return;
  let cancelled=false,currentBlob='';
  let renderTask:RenderTask|undefined;
  const observer=new IntersectionObserver(async entries=>{
   if(!entries[0].isIntersecting||cancelled)return;
   observer.disconnect();
   try{
    const page=await pdf!.getPage(block.page+1);
    if(cancelled)return;
    const base=page.getViewport({scale:1});
    const bounds=pdfRegionBounds(block,base);
    if(!bounds)throw Error('区域无效');
    const {x,y,width:w,height:h}=bounds;
    const scale=Math.min(4,Math.max(2,(node.clientWidth||700)/w*(window.devicePixelRatio||1)));
    const canvas=document.createElement('canvas');
    canvas.width=Math.round(w*scale);canvas.height=Math.round(h*scale);
    const context=canvas.getContext('2d');if(!context)throw Error('无法绘制');
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
    renderTask=page.render({canvas,canvasContext:context,viewport:page.getViewport({scale}),transform:[1,0,0,1,-x*scale,-y*scale]});
    await renderTask.promise;
    const blobUrl=await canvasToBlobUrl(canvas);
    if(cancelled){revokeBlob(blobUrl);return;}
    currentBlob=blobUrl;setUrl(blobUrl);
   }catch{if(!cancelled)setFailed(true);}
  },{rootMargin:'600px'});
  observer.observe(node);
  return()=>{cancelled=true;observer.disconnect();renderTask?.cancel();revokeBlob(currentBlob);};
 },[ready,pdf,block.id,geometry,source]);
 if(source)return <div ref={host} className="bi-region"><img src={source} alt={label} loading="lazy" onError={()=>setSourceFailed(true)}/></div>;
 if(!ready||failed)return <div ref={host} className="bi-region">{fallback??<div className="bi-placeholder">{label}</div>}</div>;
 return <div ref={host} className="bi-region">{url?<img src={url} alt={label} loading="lazy"/>:<div className="bi-region-wait">{label} · 正在取原版…</div>}</div>;
}

/**
 * 原版对照：左边是没有改动过的原版页面，右边只放这一页的译文。
 * 图、表、公式都留在左边的原版里，右边因此是一列干净的中文正文。
 */
function PageByPage({doc,translations,byText,adapter,target,pdf,split,sourceZoom}:{doc:BilingualDocument;translations:Record<string,string>;byText:Map<string,string>;adapter?:TranslationAdapter;target:TranslationLanguage;pdf?:PDFDocumentProxy;split:BilingualSplitControls;sourceZoom:number}){
 const pages=new Map<number,BilingualBlock[]>();
 for(const block of doc.blocks){
  const list=pages.get(block.page);
  if(list)list.push(block);else pages.set(block.page,[block]);
 }
 return <>{[...pages.entries()].sort((a,b)=>a[0]-b[0]).map(([page,blocks],index)=>{
  const prose=blocks.filter(b=>['doc_title','heading','paragraph','caption','footnote'].includes(b.role));
  const back=blocks.length>0&&blocks.every(b=>(b.section==='references'||b.section==='appendix')&&!b.translate);
  return <section key={page} className="bi-spread" data-pdf-page={page+1}>
   <div className="bi-spread-left" data-bi-side="source"><PdfPageImage pdf={pdf} page={page} zoom={sourceZoom}/><span className="bi-spread-no">第 {page+1} 页</span></div>
   <BilingualDivider controls={split} focusable={index===0} label={`调整原文与译文比例 · 第 ${page+1} 页`}/>
   <div className="bi-spread-right" data-bi-side="translation">
    {back?<p className="bi-spread-note">本页属于参考文献或附录，按设置保留原文。</p>
     :prose.length?prose.map(block=>{
      const zh=block.translate?lookup(translations,byText,adapter,target,block.text):undefined;
      const heading=block.role==='heading'||block.role==='doc_title';
      if(!zh)return <p key={block.id} className={`bi-spread-raw ${heading?'heading':''}`} lang={target==='zh-CN'?'en':'zh-CN'}><MathText text={block.text}/></p>;
      return heading
       ?<h2 key={block.id} className="bi-spread-h" lang="zh-CN"><MathText text={zh}/></h2>
       :<p key={block.id} className={`bi-spread-p ${block.role==='caption'||block.role==='footnote'?'small':''}`} lang="zh-CN"><MathText text={zh}/></p>;
     })
     :<p className="bi-spread-note">本页没有需要翻译的正文。</p>}
   </div>
  </section>;
 })}</>;
}

/** 整页原版渲染，进入视口才画，避免一次性渲染几十页。 */
function PdfPageImage({pdf,page,zoom}:{pdf?:PDFDocumentProxy;page:number;zoom:number}){
 const host=useRef<HTMLDivElement>(null),renderedFor=useRef<{pdf?:PDFDocumentProxy;page:number;width:number;url:string}>(undefined);
 const [url,setUrl]=useState(''),[failed,setFailed]=useState(false),[visible,setVisible]=useState(false),[width,setWidth]=useState(0);
 useEffect(()=>{
  const node=host.current;if(!node)return;
  const observer=new IntersectionObserver(entries=>setVisible(entries[0]?.isIntersecting??false),{rootMargin:'900px'});
  observer.observe(node);return()=>observer.disconnect();
 },[]);
 useLayoutEffect(()=>{
  const node=host.current;if(!node)return;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const measure=()=>{clearTimeout(timer);timer=setTimeout(()=>setWidth(Math.round(node.clientWidth)),120);};
  setWidth(Math.round(node.clientWidth));const observer=new ResizeObserver(measure);observer.observe(node);
  return()=>{clearTimeout(timer);observer.disconnect();};
 },[]);
 useEffect(()=>()=>{if(renderedFor.current){revokeBlob(renderedFor.current.url);renderedFor.current=undefined;}},[]);
 useEffect(()=>{
  if(!pdf||!width)return;
  if(!visible){
   if(renderedFor.current){revokeBlob(renderedFor.current.url);renderedFor.current=undefined;setUrl('');}
   return;
  }
  if(renderedFor.current?.pdf===pdf&&renderedFor.current.page===page&&renderedFor.current.width===width&&renderedFor.current.url)return;
  let cancelled=false,task:RenderTask|undefined;
  setFailed(false);
  void (async()=>{
   try{
    const target=await pdf.getPage(page+1);if(cancelled)return;
    const base=target.getViewport({scale:1});
    const scale=Math.min(4,Math.max(1,width*(window.devicePixelRatio||1)/base.width));
    const viewport=target.getViewport({scale}),canvas=document.createElement('canvas');
    canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    const context=canvas.getContext('2d');if(!context)throw Error('无法绘制');
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
    task=target.render({canvas,canvasContext:context,viewport});await task.promise;
    const blobUrl=await canvasToBlobUrl(canvas);
    if(cancelled){revokeBlob(blobUrl);return;}
    if(renderedFor.current)revokeBlob(renderedFor.current.url);
    renderedFor.current={pdf,page,width,url:blobUrl};setUrl(blobUrl);
   }catch{if(!cancelled)setFailed(true);}
  })();
  return()=>{cancelled=true;task?.cancel();};
 },[pdf,page,width,visible]);
 return <div ref={host} className="bi-pageshot" style={{width:`${zoom}%`}}>
  {url?<img src={url} alt={`原文第 ${page+1} 页`} loading="lazy"/>:<div className="bi-region-wait">{failed?'无法读取原版页面':'正在渲染原版页面…'}</div>}
 </div>;
}

/**
 * 本月解析用量。接口不返回账户余额，这里是 EchoPaper 自己解析掉的页数；
 * 额度由读者按自己账户填写，剩余不足阈值时自动换到还有余量的引擎。
 */
/** 解析引擎摆在工具栏上直接可点，并标出本月已用与剩余，不用翻设置。 */
function EngineSwitch({usage,engine,onEngine,disabled}:{usage:Usage;engine:string;onEngine:(id:string)=>void;disabled:boolean}){
 const active=engine||usage.engines[0].id;
 return <span className="bi-engines" role="group" aria-label="解析引擎">
  <span className="bi-engines-label">引擎</span>
  {usage.engines.map(item=>{
   const short=item.label.replace(/^文档解析[（(](.*)[）)]$/,'$1');
   const low=item.remaining!==null&&item.remaining<=usage.settings.threshold;
   const span=item.period==='day'?'今日':'本月';
   return <button key={item.id} aria-pressed={active===item.id} disabled={disabled}
    className={low?'low':''}
    title={`${item.label}｜${item.note}｜${span}已用 ${item.used} 页${item.remaining!==null?`，剩 ${item.remaining} 页`:'（未设额度）'}`}
    onClick={()=>onEngine(item.id)}>
    <span className="bi-engine-name">{short}</span>
    <small>{item.remaining!==null?`${span}剩 ${item.remaining}`:`${span}已用 ${item.used}`}</small>
   </button>;
  })}
 </span>;
}

function UsageChip({usage,onSaved}:{usage:Usage;onSaved:(value:Usage)=>void}){
 const [open,setOpen]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const [quota,setQuota]=useState<Record<string,string>>(()=>Object.fromEntries(usage.engines.map(e=>[e.id,e.quota?String(e.quota):''])));
 const [threshold,setThreshold]=useState(String(usage.settings.threshold));
 const [auto,setAuto]=useState(usage.settings.autoSwitch);
 const used=usage.engines.reduce((n,e)=>n+e.used,0);
 const low=usage.engines.find(e=>e.remaining!==null&&e.remaining<=usage.settings.threshold);
 async function save(){
  setSaving(true);setError('');
  try{
   const saved=await api<Usage['settings']>('/api/workspace/bilingual/usage',json('PUT',{quota,threshold:Number(threshold)||0,autoSwitch:auto}));
   const next=await api<Usage>('/api/workspace/bilingual/usage');
   onSaved(next);setOpen(false);void saved;
  }catch(e:any){setError(e.message);}
  finally{setSaving(false);}
 }
 return <span className="bi-usage">
  <button className={`bi-usage-chip ${low?'low':''}`} onClick={()=>setOpen(v=>!v)} title={`当前周期内共解析 ${used} 页 · 设置额度与自动切换`}>
   <Gauge size={13}/>额度
  </button>
  {open&&<div className="bi-usage-panel" role="dialog" aria-label="解析额度设置">
   <p className="bi-hint">统计的是 EchoPaper 自己解析掉的页数：智能云按月（{usage.month}），星河社区按天（{usage.day}）。
    接口都不返回账户余额，这里按你填的额度倒推剩余，真实余额以控制台为准：
    <a href="https://console.bce.baidu.com/ai-engine/ocr/overview/index?type=6" target="_blank" rel="noreferrer">文字识别控制台</a>。
    本地估算不代表免费额度，请按对应服务控制台的实际限制调整。</p>
   {usage.engines.map(item=><label key={item.id} className="bi-usage-row">
    <span className="bi-usage-name">{item.label}<small>{item.note}</small></span>
    <span className="bi-usage-used">{item.period==='day'?'今日':'本月'}已用 {item.used}</span>
    <input className="bi-usage-quota" inputMode="numeric" placeholder={item.period==='day'?'每天额度':'每月额度'} value={quota[item.id]??''}
     onChange={e=>setQuota(v=>({...v,[item.id]:e.target.value.replace(/\D/g,'')}))}/>
    {item.remaining!==null&&<span className="bi-usage-left">剩 {item.remaining}</span>}
   </label>)}
   <label className="bi-usage-foot">剩余不足
    <input className="bi-usage-quota" inputMode="numeric" value={threshold} onChange={e=>setThreshold(e.target.value.replace(/\D/g,''))}/>
    页时
    <label className="bi-check"><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/>自动换另一个引擎</label>
   </label>
   {error&&<p className="bi-error" role="alert">{error}</p>}
   <div className="bi-usage-actions"><button onClick={()=>setOpen(false)}>取消</button><button className="bi-primary small" disabled={saving} onClick={()=>void save()}>{saving?'保存中…':'保存'}</button></div>
  </div>}
 </span>;
}
