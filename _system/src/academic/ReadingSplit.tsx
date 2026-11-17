import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode,type PointerEvent,type KeyboardEvent} from 'react';
import {beginPaneResize} from '../paneResize';
import './reading-split.css';

const GAP=8;
interface SplitSizes {width:number;height:number}
export function readSplitSizes(raw:string|null,defaults:SplitSizes):SplitSizes{
 try{
  const value=JSON.parse(raw||'null');
  const valid=(percent:unknown,fallback:number)=>typeof percent==='number'&&Number.isFinite(percent)?Math.max(5,Math.min(95,percent)):fallback;
  return {width:valid(value?.width,defaults.width),height:valid(value?.height,defaults.height)};
 }catch{return defaults;}
}
export function readingSplitLimits(size:number,firstMinimum:number,secondMinimum:number){
 const available=Math.max(1,size-GAP);
 return {minimum:Math.min(45,firstMinimum/available*100),maximum:100-Math.min(45,secondMinimum/available*100)};
}

/** The two panes stay mounted while their separator changes the available space. */
export default function ReadingSplit({children,className,storageKey,enabled,label,defaultWidth=70,defaultHeight=60,alwaysStacked=false,stackBelow=900}:{children:[ReactNode,ReactNode];className:string;storageKey:string;enabled:boolean;label:string;defaultWidth?:number;defaultHeight?:number;alwaysStacked?:boolean;stackBelow?:number}){
 const host=useRef<HTMLDivElement>(null),cleanup=useRef<(()=>void)|undefined>(undefined);
 const [bounds,setBounds]=useState({width:0,height:0});
 const [sizes,setSizes]=useState(()=>{try{return readSplitSizes(localStorage.getItem(storageKey),{width:defaultWidth,height:defaultHeight});}catch{return {width:defaultWidth,height:defaultHeight};}});
 const latest=useRef(sizes);latest.current=sizes;
 const stacked=alwaysStacked||bounds.width>0&&bounds.width<=stackBelow;
 const axis=stacked?'y':'x',dimension=stacked?'height':'width';
 const limits=readingSplitLimits(bounds[dimension],stacked?180:320,stacked?140:260);
 const percent=Math.max(limits.minimum,Math.min(limits.maximum,sizes[dimension]));
 useLayoutEffect(()=>{
  const element=host.current;if(!element)return;
  const measure=()=>setBounds(previous=>{const next={width:element.clientWidth,height:element.clientHeight};return previous.width===next.width&&previous.height===next.height?previous:next;});
  measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
 },[]);
 useEffect(()=>()=>cleanup.current?.(),[]);
 useEffect(()=>{cleanup.current?.();},[enabled,stacked]);
 function remember(){try{localStorage.setItem(storageKey,JSON.stringify(latest.current));}catch{/* Layout preferences are optional. */}}
 function update(value:number,commit=false){
  const next={...latest.current,[dimension]:value};latest.current=next;setSizes(next);if(commit)remember();
 }
 function start(event:PointerEvent<HTMLDivElement>){
  if(event.button!==0||!enabled)return;
  event.preventDefault();event.currentTarget.focus();cleanup.current?.();
  const rect=host.current!.getBoundingClientRect(),size=rect[dimension];
  const range=readingSplitLimits(size,stacked?180:320,stacked?140:260);
  cleanup.current=beginPaneResize(window,event.currentTarget,event.pointerId,(stacked?rect.top:rect.left)+GAP/2,Math.max(1,size-GAP),value=>update(value),{axis,minimum:range.minimum,maximum:range.maximum,onFinish:remember});
 }
 function reset(){update(Math.max(limits.minimum,Math.min(limits.maximum,stacked?defaultHeight:defaultWidth)),true);}
 function keyboard(event:KeyboardEvent<HTMLDivElement>){
  const step=event.shiftKey?10:2;
  const decrease=stacked?'ArrowUp':'ArrowLeft',increase=stacked?'ArrowDown':'ArrowRight';
  let value=percent;
  if(event.key===decrease)value-=step;
  else if(event.key===increase)value+=step;
  else if(event.key==='Home')value=limits.minimum;
  else if(event.key==='End')value=limits.maximum;
  else if(event.key==='Enter'){event.preventDefault();event.stopPropagation();reset();return;}
  else return;
  event.preventDefault();event.stopPropagation();update(Math.max(limits.minimum,Math.min(limits.maximum,value)),true);
 }
 const track=`calc(${percent}% - ${GAP*percent/100}px)`;
 const style:CSSProperties={gridTemplateColumns:enabled&&!stacked?`${track} ${GAP}px minmax(0,1fr)`:'minmax(0,1fr)',gridTemplateRows:enabled&&stacked?`${track} ${GAP}px minmax(0,1fr)`:'minmax(0,1fr)'};
 return <div ref={host} className={`${className} reading-split`} style={style}>
  {children[0]}
  <div className="reading-divider" role="separator" tabIndex={enabled?0:-1} hidden={!enabled} aria-label={label} aria-orientation={stacked?'horizontal':'vertical'} aria-valuemin={Math.round(limits.minimum)} aria-valuemax={Math.round(limits.maximum)} aria-valuenow={Math.round(percent)} aria-valuetext={`阅读区 ${Math.round(percent)}%，笔记区 ${Math.round(100-percent)}%`} title="拖动调整比例，方向键微调，双击恢复默认比例" onPointerDown={start} onKeyDown={keyboard} onDoubleClick={reset}><span/></div>
  {children[1]}
 </div>;
}
