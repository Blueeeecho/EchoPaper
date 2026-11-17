import {useEffect,useState} from 'react';
import {ArrowUpRight,BookOpenText} from 'lucide-react';
import type {Resource} from '../../shared/workspace-types';
import type {ReadingIndexItem} from '../../shared/reading';
import {api,prettyDate} from '../api';
import ResourceReader from './ResourceReader';

/** Home: the papers read most recently, reopened at the last position. */
export default function ContinueReading({onNavigate}:{onNavigate:(path:string)=>void}){
 const [items,setItems]=useState<{item:ReadingIndexItem;resource?:Resource}[]>(),[open,setOpen]=useState<Resource>();
 useEffect(()=>{let alive=true;void api<{documents:ReadingIndexItem[]}>('/api/workspace/reading').then(async({documents})=>{const list=await Promise.all(documents.slice(0,4).map(async item=>({item,resource:await api<Resource>(`/api/workspace/resources/${encodeURIComponent(item.resourceId)}`).catch(()=>undefined)})));if(alive)setItems(list);}).catch(()=>{if(alive)setItems([]);});return()=>{alive=false;};},[open]);
 return <section className="continue-reading">
  <div className="academic-section-title"><h2>继续阅读</h2><button onClick={()=>onNavigate('/library')}>资料库<ArrowUpRight size={13}/></button></div>
  {!items?<p className="research-quiet-message">正在读取…</p>:!items.length?<p className="research-quiet-message">还没有阅读记录。在资料库点开一篇论文开始阅读，摘录与笔记会出现在这里。</p>:
  <div className="continue-reading-list">{items.map(({item,resource})=><button key={item.resourceId} disabled={!resource||resource.missing} onClick={()=>resource&&setOpen(resource)}>
   <BookOpenText size={16}/><span><strong>{(resource?.name||'已失联的资料').replace(/^\d+_/,'').replace(/\.pdf$/i,'')}</strong><small>{item.document.notes.length} 条摘录{item.document.content.trim()?' · 有笔记':''} · {prettyDate(item.updatedAt)}</small></span>
  </button>)}</div>}
  {open&&<ResourceReader key={open.id} resource={open} onClose={()=>setOpen(undefined)}/>}
 </section>;
}
