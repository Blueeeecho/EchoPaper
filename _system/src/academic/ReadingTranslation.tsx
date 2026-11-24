import {useState,type PointerEvent} from 'react';
import {Check,ChevronDown,Copy,GripHorizontal,LoaderCircle,Pin,PinOff,RefreshCw,X} from 'lucide-react';
import type {TranslationCard} from '../translationAdapters';
import {openModelSettings} from '../modelSettings';

interface ReadingTranslationProps {
 cards:TranslationCard[];
 error:string;
 selected:boolean;
 hasSources:boolean;
 busy:boolean;
 pinned:boolean;
 onDrag:(event:PointerEvent)=>void;
 onPin:()=>void;
 onClose:()=>void;
 onRetry:(id:string)=>void;
}

export default function ReadingTranslation({cards,error,selected,hasSources,busy,pinned,onDrag,onPin,onClose,onRetry}:ReadingTranslationProps) {
 const [collapsed,setCollapsed]=useState<Set<string>>(new Set());
 const [copied,setCopied]=useState(''),[copyError,setCopyError]=useState('');
 function toggle(id:string) {
  setCollapsed(previous=>{
   const next=new Set(previous);
   if(next.has(id))next.delete(id);
   else next.add(id);
   return next;
  });
 }
 async function copy(card:TranslationCard) {
  try {
   await navigator.clipboard.writeText(card.text);
   setCopied(card.id);setCopyError('');
  } catch {
   setCopyError('复制失败，可直接选中译文复制。');
  }
 }
 return <>
  <header className="reader-pop-head" onPointerDown={onDrag} title="拖动翻译窗口">
   <button type="button" onPointerDown={event=>event.stopPropagation()} onClick={onPin} aria-label={pinned?'取消固定':'固定位置'} title={pinned?'取消固定':'固定位置'}>{pinned?<PinOff size={15}/>:<Pin size={15}/>}</button>
   <GripHorizontal size={15} className="reader-pop-grip"/>
   <button type="button" onPointerDown={event=>event.stopPropagation()} onClick={onClose} aria-label="关闭翻译" title="关闭翻译"><X size={15}/></button>
  </header>
  <div className="reader-pop-body">
   {error&&<p className="reader-pop-error" role="alert">{error}</p>}
   {!selected?<p className="reader-muted">选中文字后显示译文。</p>
    :!hasSources?<button className="translation-picker-manage" onClick={()=>openModelSettings('translations')}>配置翻译 API</button>
    :!cards.length?<p className="reader-muted" role="status">正在翻译…</p>:null}
   {cards.map(card=><section key={card.id} className="reader-translation-card" aria-label={`${card.label}译文`}>
    <div className="reader-translation-card-head">
     <span className="reader-translation-brand" style={{background:card.color||'var(--r-accent)'}}>{Array.from(card.label)[0]}</span>
     <button type="button" className="reader-translation-name" aria-expanded={!collapsed.has(card.id)} onClick={()=>toggle(card.id)}>{card.label}</button>
     {card.status==='loading'&&<LoaderCircle size={13} className="spin"/>}
     <button type="button" className="reader-translation-collapse" aria-label={`${collapsed.has(card.id)?'展开':'收起'}${card.label}译文`} aria-expanded={!collapsed.has(card.id)} onClick={()=>toggle(card.id)}><ChevronDown size={14}/></button>
    </div>
    {!collapsed.has(card.id)&&<>
     <div className="reader-pop-text" aria-busy={card.status==='loading'}>{card.text||(card.status==='loading'?'正在翻译…':'')}{card.text&&card.status==='loading'&&<span className="reader-caret"/>}</div>
     {card.error&&<p className="reader-pop-error" role="alert">{card.error}</p>}
     {card.status==='stopped'&&<p className="reader-muted">翻译已停止。</p>}
     <div className="reader-translation-actions">
      <button type="button" disabled={!card.text} aria-label={`复制${card.label}译文`} title="复制译文" onClick={()=>void copy(card)}>{copied===card.id?<Check size={14}/>:<Copy size={14}/>}</button>
      {(card.status==='error'||card.status==='stopped')&&<button type="button" disabled={busy} aria-label={`重试${card.label}翻译`} title="重试翻译" onClick={()=>onRetry(card.id)}><RefreshCw size={14}/></button>}
     </div>
    </>}
   </section>)}
   {copyError&&<p className="reader-pop-error" role="alert">{copyError}</p>}
  </div>
 </>;
}
