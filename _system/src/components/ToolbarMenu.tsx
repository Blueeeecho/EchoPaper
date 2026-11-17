import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {Check,ChevronDown} from 'lucide-react';
export interface ToolbarAction {label:string;icon?:ReactNode;action:()=>void;disabled?:boolean;checked?:boolean}
export interface ToolbarGroup {title:string;items:ToolbarAction[]}
/** Native buttons with predictable focus, arrow-key navigation and outside dismissal. */
export default function ToolbarMenu({label,groups}:{label:string;groups:ToolbarGroup[]}){
 const [open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),last=useRef(false),menuId=useId();
 const close=(focus=false)=>{setOpen(false);if(focus)trigger.current?.focus();};
 useEffect(()=>{
  if(!open)return;
  const items=()=>[...root.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')||[]];
  (last.current?items().at(-1):items()[0])?.focus();
  const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};
  document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
 },[open]);
 return <div ref={root} className="paper-action-menu" onKeyDown={e=>{
  if(e.key==='Escape'&&open){e.preventDefault();e.stopPropagation();close(true);return;}
  if(e.key==='Tab'&&open){close(true);return;}
  if(!open)return;
  const items=[...root.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')||[]],index=items.indexOf(document.activeElement as HTMLButtonElement);
  if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();}
 }}>
  <button ref={trigger} type="button" className={`focus-tool paper-action-trigger ${open?'active':''}`} aria-label={`${label}菜单`} aria-haspopup="menu" aria-expanded={open} aria-controls={open?menuId:undefined} onMouseDown={e=>e.preventDefault()} onKeyDown={e=>{if(!open&&(e.key==='ArrowDown'||e.key==='ArrowUp')){e.preventDefault();last.current=e.key==='ArrowUp';setOpen(true);}}} onClick={()=>{last.current=false;setOpen(!open);}}>{label}<ChevronDown size={12}/></button>
  {open&&<div className="paper-action-popup" role="menu" aria-label={`${label}操作`} id={menuId}>{groups.map((group,index)=><div role="group" aria-label={group.title} key={index}><div className="paper-action-group-title">{group.title}</div>{group.items.map(item=><button key={item.label} type="button" role={item.checked===undefined?'menuitem':'menuitemcheckbox'} aria-checked={item.checked} disabled={item.disabled} onMouseDown={e=>e.preventDefault()} onClick={()=>{close(true);item.action();}}>{item.icon}<span>{item.label}</span>{item.checked&&<Check size={14}/>}</button>)}</div>)}</div>}
 </div>;
}
