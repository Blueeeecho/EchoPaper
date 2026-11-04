import {useEffect,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react';
import {createPortal} from 'react-dom';
import {EditorView} from '@codemirror/view';
import {EditorSelection} from '@codemirror/state';
import {ArrowDown,ArrowUp,ArrowLeftRight,Check,ChevronDown,Copy,Columns2,GripHorizontal,Languages,Layers3,LoaderCircle,Pin,PinOff,RefreshCw,Settings2,Square,X} from 'lucide-react';
import {MAX_TRANSLATION_SELECTION,type TranslationLanguage} from '../selectionTranslation';
import {translationCharacterCount,translationLengthMessage} from '../../shared/translation-limits';
import {configuredTranslationAdapters,runTranslationAdapters,type TranslationAdapter,type TranslationCard} from '../translationAdapters';
import {clampTranslationPlacement,defaultTranslationPlacement,translationGesture,translationKeyboardGesture,dismissSelectionTranslation,type TranslationPlacement} from '../translationWindow';
import '../selection-translation.css';
import type{PublicRegistry}from'../../shared/model-providers';
import{MODEL_CONFIG_EVENT,moveTranslationSource,openModelSettings,readModelRegistry,saveTranslationSources}from'../modelSettings';
interface SelectedText{id:number;text:string;source:'tex'|'pdf';left:number;bottom:number}
const preferenceKey='echopaper:translation-window:v1';
const viewport=()=>({width:window.innerWidth,height:window.innerHeight});
function initialPlacement(){try{return clampTranslationPlacement({...defaultTranslationPlacement,...JSON.parse(localStorage.getItem(preferenceKey)||'{}')},viewport());}catch{return defaultTranslationPlacement;}}

export default function SelectionTranslation({projectId,adapters}:{projectId:string;adapters?:readonly TranslationAdapter[]}){
 const [selection,setSelection]=useState<SelectedText>(),[open,setOpen]=useState(false),[target,setTarget]=useState<TranslationLanguage>('zh-CN');
 const [cards,setCards]=useState<TranslationCard[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0),[copied,setCopied]=useState('');
 const[registry,setRegistry]=useState<PublicRegistry>(),[sourceMenu,setSourceMenu]=useState(false),[sourceLanguage,setSourceLanguage]=useState<'auto'|TranslationLanguage>('auto'),[configTick,setConfigTick]=useState(0),[configSaving,setConfigSaving]=useState(false),[collapsed,setCollapsed]=useState<Set<string>>(new Set());
 const retryOnly=useRef(''),appliedRevision=useRef(''),manualOpen=useRef(false),openRef=useRef(open);openRef.current=open;
 useEffect(()=>{let alive=true;const reload=()=>{void readModelRegistry().then(settings=>{if(!alive)return;setRegistry(settings);if(settings.translationFingerprint===appliedRevision.current)return;appliedRevision.current=settings.translationFingerprint;retryOnly.current='';setAttempt(0);setConfigTick(value=>value+1);}).catch(()=>{});};window.addEventListener(MODEL_CONFIG_EVENT,reload);return()=>{alive=false;window.removeEventListener(MODEL_CONFIG_EVENT,reload);};},[]);
 useEffect(()=>{if(!registry)return;setCards(previous=>registry.translations.filter(source=>source.enabled).flatMap(source=>{const card=previous.find(card=>card.id===source.id);return card?[{...card,label:source.label,color:source.color,model:registry.models.find(model=>model.id===source.modelId)?.label||card.model}]:[];}));},[registry]);
 const [placement,setPlacement]=useState<TranslationPlacement>(initialPlacement);
 const bubble=useRef<HTMLDivElement>(null),controller=useRef<AbortController|undefined>(undefined),placementRef=useRef(placement),drag=useRef<{id:number;x:number;y:number;left:number;top:number}|undefined>(undefined);
 placementRef.current=placement;
 const close=()=>{controller.current?.abort();setOpen(false);setSourceMenu(false);};
 useEffect(()=>{const timer=setTimeout(()=>{try{localStorage.setItem(preferenceKey,JSON.stringify(placement));}catch{/* Position remains usable without storage. */}},150);return()=>clearTimeout(timer);},[placement]);
 useEffect(()=>{
  let frame=0,armed=false,selecting=false,keyboard=false;
  let pdfDrag:{id:number;layer:Element;node:Node;offset:number}|undefined;
  let texDrag:{id:number;layer:HTMLElement;view:EditorView;anchor:number}|undefined,lastSurface:Element|null=null;
  const inside=(target:EventTarget|null)=>target instanceof Node&&!!bubble.current?.contains(target);
  const surface=(target:EventTarget|null)=>target instanceof Element?target.closest('.source-editor .cm-content,.pdf-scroll .textLayer'):null;
  const activateSurface=(layer:Element)=>{
   if(layer.matches('.textLayer')){
    // CodeMirror keeps its own selection after blur. Collapse the actual state,
    // rather than hiding its decoration while leaving an old editing range.
    for(const content of document.querySelectorAll<HTMLElement>('.source-editor .cm-content')){
     const editor=EditorView.findFromDOM(content);if(!editor)continue;
     if(editor.state.selection.ranges.some(range=>!range.empty))editor.dispatch({selection:EditorSelection.cursor(editor.state.selection.main.head),userEvent:'select.pointer'});
     if(editor.hasFocus)editor.contentDOM.blur();
    }
   }else{
    const native=window.getSelection(),inPdf=(node:Node|null)=>!!(node?.nodeType===1?node as Element:node?.parentElement)?.closest('.pdf-scroll .textLayer');
    if(native&&(inPdf(native.anchorNode)||inPdf(native.focusNode)))native.removeAllRanges();
   }
  };
  const read=(manual=false)=>{
   if(manual)manualOpen.current=true;
   cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
    if(selecting)return;
    const native=window.getSelection(),range=native&&!native.isCollapsed&&native.rangeCount===1?native.getRangeAt(0):undefined,parent=(node:Node)=>node.nodeType===1?node as Element:node.parentElement;
    const start=range?surface(parent(range.startContainer)):null,end=range?surface(parent(range.endContainer)):null;
    const content=lastSurface?.isConnected&&lastSurface.matches('.cm-content')?lastSurface:start?.matches('.cm-content')?start:null;
    const editor=content?EditorView.findFromDOM(content as HTMLElement):null;
    let text='',anchor:{left:number;bottom:number}|undefined,source:'tex'|'pdf'='pdf';
    if(editor){
     // CodeMirror owns source selection; native DOM ranges can be collapsed,
     // stale or limited to the rendered viewport after focus/layout changes.
     const selected=editor.state.selection.main;source='tex';
     if(!selected.empty){text=editor.state.sliceDoc(selected.from,selected.to).trim();anchor=editor.coordsAtPos(selected.head,selected.head>selected.anchor?-1:1)||editor.coordsAtPos(selected.anchor)||undefined;}
    }else if(range&&start&&start===end){text=native!.toString().trim().replace(/\s+/g,' ');anchor=Array.from(range.getClientRects()).filter(r=>r.width>0&&r.height>0&&r.bottom>0&&r.top<window.innerHeight).at(-1);}
    if(!text||!anchor){if(manual){setSelection(undefined);setOpen(true);}return;}
    manualOpen.current=manual;retryOnly.current='';setAttempt(0);setSourceMenu(false);setSelection({id:Date.now(),text,source,left:anchor.left,bottom:anchor.bottom});
    setPlacement(old=>old.pinned?old:clampTranslationPlacement({...old,x:anchor.left,y:anchor.bottom+10},viewport()));setOpen(true);
   });
  };
  const down=(event:PointerEvent)=>{
   if(inside(event.target))return;
   cancelAnimationFrame(frame);
   const target=event.target instanceof Element?event.target:null;
   // Settings are a child workflow of this popup, even though rendered in another portal.
   const settings=!!target?.closest('.model-settings-dialog,.model-settings-backdrop,.translation-toolbar-button');
   if(dismissSelectionTranslation({open:openRef.current,pinned:placementRef.current.pinned,manual:manualOpen.current,inside:false,settings})){
    cancelAnimationFrame(frame);controller.current?.abort();setOpen(false);setSourceMenu(false);
   }
   const layer=surface(event.target);
   if(layer){lastSurface=layer;if(event.button===0)activateSurface(layer);}
   armed=!settings&&translationGesture(event,!!layer);selecting=armed;keyboard=false;
   if(armed&&layer?.matches('.cm-content')){
    const view=EditorView.findFromDOM(layer as HTMLElement),anchor=view?.posAtCoords({x:event.clientX,y:event.clientY});
    if(!view||anchor==null){armed=false;selecting=false;return;}
    // macOS Control-click is a context-menu gesture. Select via CodeMirror's
    // public state API, without depending on a compatible native mousedown.
    event.preventDefault();view.focus();view.dispatch({selection:EditorSelection.cursor(anchor),userEvent:'select.pointer'});
    texDrag={id:event.pointerId,layer:layer as HTMLElement,view,anchor};layer.setPointerCapture(event.pointerId);
   }
   if(armed&&layer?.matches('.textLayer')){
    const caret=caretAt(layer,event);
    if(!caret){armed=false;selecting=false;return;}
    if(caret){
     // macOS treats native Control-click as a context-menu gesture. Handle only
     // this PDF drag ourselves, using the existing text nodes and original ink.
     event.preventDefault();pdfDrag={id:event.pointerId,layer,...caret};
     window.getSelection()?.setBaseAndExtent(caret.node,caret.offset,caret.node,caret.offset);
     layer.setPointerCapture(event.pointerId);
    }
   }
  };
  const caretAt=(layer:Element,event:PointerEvent)=>{
   const doc=layer.ownerDocument as Document&{caretPositionFromPoint?:(x:number,y:number)=>{offsetNode:Node;offset:number}|null};
   const position=doc.caretPositionFromPoint?.(event.clientX,event.clientY);
   const range=position?undefined:doc.caretRangeFromPoint?.(event.clientX,event.clientY);
   const node=position?.offsetNode||range?.startContainer,offset=position?.offset??range?.startOffset;
   return node&&offset!==undefined&&layer.contains(node)?{node,offset}:undefined;
  };
  const moveSelection=(event:PointerEvent)=>{
   if(texDrag?.id===event.pointerId){const head=texDrag.view.posAtCoords({x:event.clientX,y:event.clientY});if(head!=null){event.preventDefault();texDrag.view.dispatch({selection:EditorSelection.single(texDrag.anchor,head),userEvent:'select.pointer'});}return;}
   if(!pdfDrag||pdfDrag.id!==event.pointerId)return;const caret=caretAt(pdfDrag.layer,event);if(caret){event.preventDefault();window.getSelection()?.setBaseAndExtent(pdfDrag.node,pdfDrag.offset,caret.node,caret.offset);}
  };
  const releaseSelection=()=>{if(pdfDrag?.layer.hasPointerCapture(pdfDrag.id))pdfDrag.layer.releasePointerCapture(pdfDrag.id);pdfDrag=undefined;if(texDrag?.layer.hasPointerCapture(texDrag.id))texDrag.layer.releasePointerCapture(texDrag.id);texDrag=undefined;};
  const up=(event:PointerEvent)=>{if(!armed)return;moveSelection(event);releaseSelection();selecting=false;armed=false;read();};
  const cancel=()=>{releaseSelection();armed=false;selecting=false;keyboard=false;};
  const key=(event:KeyboardEvent)=>{
   if((event.target as Element)?.closest?.('.model-settings-dialog'))return;
   if(event.key==='Escape'){cancel();controller.current?.abort();setOpen(false);return;}
   if(translationKeyboardGesture(event,!!surface(event.target))){lastSurface=surface(event.target);activateSurface(lastSurface!);keyboard=true;}
  };
  const keyup=()=>{if(keyboard){keyboard=false;read();}};
  // macOS may generate a context menu for Control-click while dragging a PDF selection.
  const context=(event:MouseEvent)=>{if(event.ctrlKey&&surface(event.target)){event.preventDefault();event.stopPropagation();}};
  const manual=()=>read(true),resize=()=>setPlacement(old=>clampTranslationPlacement(old,viewport()));
  document.addEventListener('pointerdown',down,true);document.addEventListener('pointermove',moveSelection,{capture:true,passive:false});document.addEventListener('pointerup',up,true);document.addEventListener('pointercancel',cancel,true);window.addEventListener('blur',cancel);
  document.addEventListener('keydown',key,true);document.addEventListener('keyup',keyup,true);document.addEventListener('contextmenu',context,true);
  window.addEventListener('echopaper:translate-selection',manual);window.addEventListener('resize',resize);
  return()=>{cancel();cancelAnimationFrame(frame);controller.current?.abort();document.removeEventListener('pointerdown',down,true);document.removeEventListener('pointermove',moveSelection,true);document.removeEventListener('pointerup',up,true);document.removeEventListener('pointercancel',cancel,true);window.removeEventListener('blur',cancel);document.removeEventListener('keydown',key,true);document.removeEventListener('keyup',keyup,true);document.removeEventListener('contextmenu',context,true);window.removeEventListener('echopaper:translate-selection',manual);window.removeEventListener('resize',resize);};
 },[]);
 useEffect(()=>{
  if(!open)return;
  let active=true;const abort=new AbortController();controller.current=abort;const only=retryOnly.current;retryOnly.current='';setError('');setBusy(!!selection);setCopied('');
  void(async()=>{
   if(selection){const count=translationCharacterCount(selection.text);if(count>MAX_TRANSLATION_SELECTION)throw Error(translationLengthMessage(count));}
   const settings=adapters?undefined:await readModelRegistry(abort.signal);if(!active||abort.signal.aborted)return;if(settings){appliedRevision.current=settings.translationFingerprint;setRegistry(settings);}
   if(!selection)return;
   const all=adapters||configuredTranslationAdapters(settings!);if(!all.length){setCards([]);throw Error('请先启用一个翻译来源。');}
   const services=only?all.filter(service=>service.id===only):all;
   if(only)setCards(old=>old.map(card=>card.id===only?{...card,text:'',status:'loading',error:undefined}:card));else setCards(all.map(service=>({id:service.id,label:service.label,model:service.model,color:service.color,text:'',status:'loading'})));
   await runTranslationAdapters(services,{projectId,text:selection.text,target,source:selection.source,sourceLanguage},abort.signal,card=>{if(active&&!abort.signal.aborted)setCards(old=>old.map(item=>item.id===card.id?card:item));},attempt>0);
  })().catch(e=>{if(active&&!abort.signal.aborted)setError(e.message||'翻译失败，请重试。');}).finally(()=>{if(active&&!abort.signal.aborted)setBusy(false);});
  return()=>{active=false;abort.abort();};
 },[open,selection?.id,projectId,target,sourceLanguage,attempt,adapters,configTick]);
 useEffect(()=>{
  if(!open||!bubble.current)return;
  const observer=new ResizeObserver(entries=>{const box=entries[0]?.target.getBoundingClientRect();if(!box)return;setPlacement(old=>Math.abs(old.width-box.width)<1&&Math.abs(old.height-box.height)<1?old:clampTranslationPlacement({...old,width:box.width,height:box.height},viewport()));});
  observer.observe(bubble.current);return()=>observer.disconnect();
 },[open]);
 const move=(event:ReactPointerEvent)=>{const held=drag.current;if(!held||held.id!==event.pointerId)return;setPlacement(old=>clampTranslationPlacement({...old,x:held.left+event.clientX-held.x,y:held.top+event.clientY-held.y},viewport()));};
 const startDrag=(event:ReactPointerEvent)=>{if(event.button!==0||(event.target as Element).closest('button,select,input,.translation-source-picker'))return;event.preventDefault();drag.current={id:event.pointerId,x:event.clientX,y:event.clientY,left:placementRef.current.x,top:placementRef.current.y};event.currentTarget.setPointerCapture(event.pointerId);};
 const stop=()=>{controller.current?.abort();setBusy(false);if(!cards.length)setError('翻译已停止。');setCards(old=>old.map(card=>card.status==='loading'?{...card,status:'stopped'}:card));};
 const copy=(id:string,text:string)=>void navigator.clipboard.writeText(text).then(()=>setCopied(id)).catch(()=>setError('复制失败，请直接选择文字复制。'));
 const isBusy=busy||cards.some(card=>card.status==='loading');
 async function updateSources(sources:PublicRegistry['translations'],layout=registry?.translationLayout){if(!registry||configSaving||!layout)return;setConfigSaving(true);setError('');try{setRegistry(await saveTranslationSources(registry,sources,layout));}catch(e:any){setError(e.message);void readModelRegistry().then(setRegistry).catch(()=>{});}finally{setConfigSaving(false);}}
 const retry=(id='')=>{retryOnly.current=id;setAttempt(value=>value+1);};
 const toggleCard=(id:string)=>setCollapsed(old=>{const next=new Set(old);next.has(id)?next.delete(id):next.add(id);return next;});
 const swap=()=>{const translated=cards.find(card=>card.status==='done'&&card.text)?.text;if(!selection||!translated)return;const nextTarget=sourceLanguage==='auto'?(target==='zh-CN'?'en':'zh-CN'):sourceLanguage;setSourceLanguage(target);setTarget(nextTarget);retryOnly.current='';setAttempt(0);setSelection({...selection,id:Date.now(),text:translated});};
 return open?createPortal(<div ref={bubble} className={`selection-translation ${placement.pinned?'pinned':''}`} role="dialog" aria-label="选区翻译" style={{left:placement.x,top:placement.y,width:placement.width,height:placement.height}}>
  <header onPointerDown={startDrag} onPointerMove={move} onPointerUp={()=>{drag.current=undefined;}} onLostPointerCapture={()=>{drag.current=undefined;}}>
   <button className="translation-icon" aria-label="固定翻译位置" aria-pressed={placement.pinned} title={placement.pinned?'已固定：后续翻译沿用当前位置，可继续拖动调整':'固定当前位置，后续翻译不跟随选区移动'} onClick={()=>setPlacement(old=>({...old,pinned:!old.pinned}))}>{placement.pinned?<Pin size={16} fill="currentColor"/>:<PinOff size={16}/>}</button>
   <strong><Languages size={15}/>翻译</strong><GripHorizontal className="translation-grip" size={17}/>
   <button className="translation-icon" aria-label="选择翻译来源" aria-expanded={sourceMenu} title="选择来源与显示顺序" onClick={()=>setSourceMenu(!sourceMenu)}><Layers3 size={16}/></button>
   <button className="translation-icon" aria-label="切换译文排列" title={registry?.translationLayout==='columns'?'切换为纵向卡片':'切换为并排对照'} disabled={!registry||configSaving} onClick={()=>registry&&void updateSources(registry.translations,registry.translationLayout==='columns'?'stack':'columns')}><Columns2 size={15}/></button>
   <button className="translation-icon" aria-label="翻译模型与 API 设置" title="管理模型与翻译来源" onClick={()=>{setSourceMenu(false);openModelSettings('translations');}}><Settings2 size={16}/></button>
   {isBusy?<button className="translation-icon" aria-label="停止选区翻译" onClick={stop}><Square size={14}/></button>:<button className="translation-icon" aria-label="重新翻译选区" disabled={!selection} onClick={()=>retry()}><RefreshCw size={14}/></button>}
   <button className="translation-icon" aria-label="关闭选区翻译" onClick={close}><X size={16}/></button>
  </header>
  {sourceMenu&&<section className="translation-source-picker" aria-label="翻译来源选择"><div><strong>同时显示的来源</strong><button className="translation-icon" aria-label="关闭来源选择" onClick={()=>setSourceMenu(false)}><X size={13}/></button></div>{registry?.translations.map((source,index)=><div className="translation-picker-row" key={source.id}><label><input type="checkbox" aria-label={`显示来源 ${source.label}`} checked={source.enabled} disabled={configSaving} onChange={e=>void updateSources(registry.translations.map(s=>s.id===source.id?{...s,enabled:e.target.checked}:s))}/><i style={{background:source.color}}/><span>{source.label}</span></label><button className="translation-icon" aria-label={`上移 ${source.label}`} disabled={configSaving||index===0} onClick={()=>void updateSources(moveTranslationSource(registry.translations,index,index-1))}><ArrowUp size={12}/></button><button className="translation-icon" aria-label={`下移 ${source.label}`} disabled={configSaving||index===registry.translations.length-1} onClick={()=>void updateSources(moveTranslationSource(registry.translations,index,index+1))}><ArrowDown size={12}/></button></div>)}<button className="translation-picker-manage" onClick={()=>{setSourceMenu(false);openModelSettings('translations');}}><Settings2 size={13}/>添加或管理翻译来源</button></section>}
  <div className="translation-window-scroll">
   {selection?<><section className="translation-original"><p>{selection.text}</p><div className="translation-original-footer"><button className="translation-icon" aria-label="复制翻译原文" onClick={()=>copy('source',selection.text)}>{copied==='source'?<Check size={13}/>:<Copy size={13}/>}</button><span>{sourceLanguage==='auto'?'自动检测原文语言':sourceLanguage==='en'?'English':'简体中文'}</span></div></section>
    <div className="translation-languages"><select aria-label="翻译原文语言" value={sourceLanguage} onChange={event=>{retryOnly.current='';setAttempt(0);setSourceLanguage(event.target.value as typeof sourceLanguage);}}><option value="auto">自动检测</option><option value="en">English</option><option value="zh-CN">简体中文</option></select><button className="translation-icon" aria-label="交换翻译语言与文本" disabled={isBusy||!cards.some(c=>c.status==='done')} title="用第一份完整译文反向翻译" onClick={swap}><ArrowLeftRight size={15}/></button><select aria-label="翻译目标语言" value={target} onChange={event=>{retryOnly.current='';setAttempt(0);setTarget(event.target.value as TranslationLanguage);}}><option value="zh-CN">简体中文</option><option value="en">English</option></select></div>
    <div className={`translation-results layout-${registry?.translationLayout||'stack'}`}>{busy&&!cards.length&&<p className="translation-empty"><LoaderCircle size={13} className="spin"/> 正在连接翻译服务…</p>}{[...cards].sort((a,b)=>(registry?.translations.findIndex(source=>source.id===a.id)??0)-(registry?.translations.findIndex(source=>source.id===b.id)??0)).map(card=><section key={card.id} className={`translation-result ${collapsed.has(card.id)?'collapsed':''}`} aria-label={`${card.label} 译文`}><div className="translation-result-heading"><span className="translation-brand" style={{background:card.color||'#8375cf'}}>{Array.from(card.label)[0]}</span><button className="translation-card-toggle" aria-expanded={!collapsed.has(card.id)} onClick={()=>toggleCard(card.id)}><strong>{card.label}</strong><small title={card.model}>{card.model}</small></button>{card.status==='loading'&&<LoaderCircle size={13} className="spin"/>}<button className="translation-icon" aria-label={`${collapsed.has(card.id)?'展开':'收起'} ${card.label}`} aria-expanded={!collapsed.has(card.id)} onClick={()=>toggleCard(card.id)}><ChevronDown size={15}/></button></div>{!collapsed.has(card.id)&&<><div className="selection-translation-text" aria-busy={card.status==='loading'}>{card.text||(card.status==='loading'?'正在翻译…':'')}</div>{card.error&&<p className="selection-translation-error" role="alert">{card.error}</p>}{card.status==='stopped'&&<small className="translation-stopped">已停止，译文可能不完整</small>}<footer className="translation-result-actions"><button className="translation-icon" aria-label={`复制 ${card.label} 译文`} disabled={!card.text} onClick={()=>copy(card.id,card.text)}>{copied===card.id?<Check size={14}/>:<Copy size={14}/>}</button><button className="translation-icon" aria-label={`重新翻译 ${card.label}`} title="仅重试此来源" disabled={isBusy} onClick={()=>retry(card.id)}><RefreshCw size={13}/></button><span>{card.status==='done'?'':card.status==='loading'?'正在翻译':card.status==='stopped'?'已停止':'需要重试'}</span></footer></>}</section>)}</div>
   </>:<p className="translation-empty">按住 Ctrl 拖选正文，或选中文字后点击顶栏「翻译」。</p>}
   {error&&<p className="selection-translation-error" role="alert">{error}</p>}
  </div>
 </div>,document.body):null;
}
