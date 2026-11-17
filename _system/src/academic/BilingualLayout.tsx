import {useEffect,useRef,useState,type KeyboardEvent,type PointerEvent} from 'react';
import {Minus,Plus} from 'lucide-react';
import {beginPaneResize} from '../paneResize';

export interface BilingualLayout {
 ratio:number;
 sourceZoom:number;
 translationZoom:number;
}

export const DEFAULT_BILINGUAL_LAYOUT:BilingualLayout = {
 ratio:50,
 sourceZoom:100,
 translationZoom:100,
};

export function bilingualZoom(value:number) {
 return Math.max(50,Math.min(300,Math.round(value)));
}

export function readBilingualLayout(raw:string|null):BilingualLayout {
 try {
  const value = JSON.parse(raw||'null');
  const valid = (item:unknown)=>typeof item==='number'&&Number.isFinite(item);
  return {
   ratio:valid(value?.ratio)?Math.max(15,Math.min(85,value.ratio)):50,
   sourceZoom:valid(value?.sourceZoom)?bilingualZoom(value.sourceZoom):100,
   translationZoom:valid(value?.translationZoom)?bilingualZoom(value.translationZoom):100,
  };
 } catch {
  return {...DEFAULT_BILINGUAL_LAYOUT};
 }
}

export interface BilingualSplitControls {
 value:number;
 minimum:number;
 maximum:number;
 firstId?:string;
 onChange:(value:number,commit?:boolean)=>void;
 onCommit:()=>void;
}

export function BilingualDivider({controls,focusable=true,label='调整原文与译文比例'}:{controls:BilingualSplitControls;focusable?:boolean;label?:string}) {
 const cleanup = useRef<(()=>void)|undefined>(undefined);
 useEffect(()=>()=>cleanup.current?.(),[]);

 function start(event:PointerEvent<HTMLDivElement>) {
  if (event.button!==0) return;
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.focus();
  cleanup.current?.();
  const parent = event.currentTarget.parentElement!;
  const box = parent.getBoundingClientRect();
  const style = getComputedStyle(parent);
  const left = parseFloat(style.paddingLeft)||0;
  const right = parseFloat(style.paddingRight)||0;
  cleanup.current = beginPaneResize(
   window,event.currentTarget,event.pointerId,
   box.left+left+4,Math.max(1,box.width-left-right-8),
   value=>controls.onChange(value,false),
   {minimum:controls.minimum,maximum:controls.maximum,onFinish:controls.onCommit},
  );
 }

 function keyboard(event:KeyboardEvent<HTMLDivElement>) {
  const step = event.shiftKey?10:2;
  let value = controls.value;
  if (event.key==='ArrowLeft') value-=step;
  else if (event.key==='ArrowRight') value+=step;
  else if (event.key==='Home') value=controls.minimum;
  else if (event.key==='End') value=controls.maximum;
  else if (event.key==='Enter') value=50;
  else return;
  event.preventDefault();
  event.stopPropagation();
  controls.onChange(Math.max(controls.minimum,Math.min(controls.maximum,value)),true);
 }

 return <div
  className="bi-divider" role="separator" tabIndex={focusable?0:-1}
  aria-label={label} aria-orientation="vertical"
  aria-valuemin={Math.round(controls.minimum)} aria-valuemax={Math.round(controls.maximum)}
  aria-valuenow={Math.round(controls.value)}
  aria-valuetext={`原文 ${Math.round(controls.value)}%，译文 ${Math.round(100-controls.value)}%`}
  title="拖动调整原文与译文比例，方向键微调，双击恢复均分"
  onPointerDown={start} onKeyDown={keyboard} onDoubleClick={()=>controls.onChange(50,true)}
 ><span/></div>;
}

export function BilingualZoom({label,value,onChange,active=false}:{label:string;value:number;onChange:(value:number)=>void;active?:boolean}) {
 const [draft,setDraft] = useState(String(value));
 useEffect(()=>setDraft(String(value)),[value]);

 function commit(raw:string) {
  const parsed = Number(raw);
  const next = raw.trim()&&Number.isFinite(parsed)?bilingualZoom(parsed):value;
  setDraft(String(next));
  onChange(next);
 }

 function keyboard(event:KeyboardEvent<HTMLInputElement>) {
  if (event.key==='Enter') {
   event.preventDefault();
   event.currentTarget.blur();
  }
  if (event.key==='Escape'&&draft!==String(value)) {
   event.stopPropagation();
   event.currentTarget.value=String(value);
   setDraft(String(value));
   event.currentTarget.blur();
  }
 }

 return <div
  className="bi-zoom" role="group" data-bi-side={label==='原文'?'source':'translation'}
  data-active={active} aria-label={`${label}缩放`}
  title="Ctrl + 滚轮缩放当前一侧，Ctrl/⌘ + 加减号缩放，Ctrl/⌘ + 0 恢复 100%"
 >
  <span>{label}</span>
  <button type="button" aria-label={`缩小${label}`} disabled={value<=50} onClick={()=>onChange(bilingualZoom(value-10))}><Minus size={13}/></button>
  <label>
   <input
    aria-label={`${label}缩放比例`} type="number" min="50" max="300" step="10"
    value={draft} onChange={event=>setDraft(event.target.value)}
    onBlur={event=>commit(event.currentTarget.value)} onKeyDown={keyboard}
   />
   <span>%</span>
  </label>
  <button type="button" aria-label={`放大${label}`} disabled={value>=300} onClick={()=>onChange(bilingualZoom(value+10))}><Plus size={13}/></button>
 </div>;
}
