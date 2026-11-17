import {useEffect,useMemo,useState} from 'react';
import {BookOpenText,LoaderCircle,NotebookPen,Quote,Search} from 'lucide-react';
import type {Resource} from '../../shared/workspace-types';
import {readingPage,type ReadingIndexItem,type ReadingNote} from '../../shared/reading';
import {api,prettyDate} from '../api';
import AiMarkdown from '../components/AiMarkdown';
import ResourceReader from './ResourceReader';

type Paper={item:ReadingIndexItem;resource?:Resource;name:string};
const plain=(text:string)=>text.replace(/\s+/g,' ').trim();

/** Every excerpt and reading note in one place: search across papers and jump back to the page. */
export default function ReadingNotes({topicResourceIds,onError}:{topicResourceIds?:string[];onError:(message:string)=>void}){
 const [papers,setPapers]=useState<Paper[]>(),[query,setQuery]=useState(''),[mode,setMode]=useState<'excerpts'|'notes'>('excerpts'),[open,setOpen]=useState<{resource:Resource;page?:number}>(),[reload,setReload]=useState(0);
 useEffect(()=>{let alive=true;void api<{documents:ReadingIndexItem[]}>('/api/workspace/reading').then(async({documents})=>{const list=await Promise.all(documents.map(async item=>{const resource=await api<Resource>(`/api/workspace/resources/${encodeURIComponent(item.resourceId)}`).catch(()=>undefined);const name=resource?.title||resource?.name||item.document.notes[0]?.sourcePath.split('/').pop()||'已失联的资料';return {item,resource,name};}));if(alive)setPapers(list);}).catch(e=>{if(alive){setPapers([]);onError(e.message);}});return()=>{alive=false;};},[reload]);
 const scoped=useMemo(()=>(papers||[]).filter(p=>!topicResourceIds||topicResourceIds.includes(p.item.resourceId)),[papers,topicResourceIds]);
 const q=query.trim().toLocaleLowerCase();
 const match=(n:ReadingNote,p:Paper)=>!q||[n.quote,n.translation,n.comment,p.name].some(v=>v.toLocaleLowerCase().includes(q));
 const excerptGroups=scoped.map(p=>({paper:p,notes:[...p.item.document.notes].filter(n=>match(n,p)).sort((a,b)=>(readingPage(a)??1e9)-(readingPage(b)??1e9))})).filter(g=>g.notes.length);
 const noteDocs=scoped.filter(p=>p.item.document.content.trim()&&(!q||p.item.document.content.toLocaleLowerCase().includes(q)||p.name.toLocaleLowerCase().includes(q)));
 const total=scoped.reduce((n,p)=>n+p.item.document.notes.length,0);
 const openPaper=(p:Paper,page?:number)=>{if(p.resource)setOpen({resource:p.resource,page});else onError('原文件已失联，请在资料库中重新定位后再打开。');};
 return <section className="reading-notes">
  <header className="reading-notes-bar">
   <nav role="tablist"><button role="tab" aria-selected={mode==='excerpts'} onClick={()=>setMode('excerpts')}><Quote size={14}/>摘录<small>{total}</small></button><button role="tab" aria-selected={mode==='notes'} onClick={()=>setMode('notes')}><NotebookPen size={14}/>文献笔记<small>{scoped.filter(p=>p.item.document.content.trim()).length}</small></button></nav>
   <label className="reading-notes-search"><Search size={14}/><input aria-label="搜索阅读笔记" placeholder="搜索原文、译文、判断或论文名…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
  </header>
  {!papers?<div className="reading-notes-empty"><LoaderCircle className="spin" size={18}/>正在读取阅读笔记…</div>
  :mode==='excerpts'?(excerptGroups.length?excerptGroups.map(({paper,notes})=><article key={paper.item.resourceId} className="reading-notes-paper">
    <header><button className="reading-notes-title" onClick={()=>openPaper(paper)} title="打开阅读"><BookOpenText size={15}/>{paper.name.replace(/\.pdf$/i,'')}</button><small>{notes.length} 条摘录 · {prettyDate(paper.item.updatedAt)}</small></header>
    {notes.map(n=>{const at=readingPage(n);return <div key={n.id} className="reading-note-card">
     <button className="reading-note-page" disabled={!paper.resource} onClick={()=>openPaper(paper,at??undefined)} title="打开原文到此页">{at!==null?`p.${at}`:'未定位'}</button>
     <div><blockquote>{n.quote}</blockquote>{n.translation&&<p className="reading-note-translation">{n.translation}</p>}{n.comment&&<p className="reading-note-comment">{n.comment}</p>}</div>
    </div>;})}
   </article>):<div className="reading-notes-empty"><Quote size={22}/><strong>{q?'没有匹配的摘录':'还没有摘录'}</strong><p>{q?'换个关键词试试。':'在阅读器中选中文字，点“存为摘录”，就会汇总到这里。'}</p></div>)
  :(noteDocs.length?noteDocs.map(p=><article key={p.item.resourceId} className="reading-notes-paper">
    <header><button className="reading-notes-title" onClick={()=>openPaper(p)}><BookOpenText size={15}/>{p.name.replace(/\.pdf$/i,'')}</button><small>{prettyDate(p.item.updatedAt)}</small></header>
    <div className="research-note-markdown reading-notes-md"><AiMarkdown text={p.item.document.content}/></div>
   </article>):<div className="reading-notes-empty"><NotebookPen size={22}/><strong>{q?'没有匹配的笔记':'还没有文献笔记'}</strong><p>{q?'换个关键词试试。':'在阅读器右侧“笔记”页写下的整篇笔记会汇总到这里。'}</p></div>)}
  {open&&<ResourceReader key={`${open.resource.id}:${open.page??''}`} resource={open.resource} initialPage={open.page} onClose={()=>{setOpen(undefined);setReload(n=>n+1);}}/>}
 </section>;
}
