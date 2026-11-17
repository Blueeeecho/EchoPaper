import {useEffect,useMemo,useState} from 'react';
import {CornerDownLeft,LoaderCircle,Quote,Search,X} from 'lucide-react';
import type {Resource} from '../../shared/workspace-types';
import {readingPage,type ReadingIndexItem,type ReadingNote} from '../../shared/reading';
import {api} from '../api';

type Row={note:ReadingNote;paper:string};
const texEscape=(text:string)=>text.replace(/\\/g,'\\textbackslash{}').replace(/([%#&_{}$])/g,'\\$1').replace(/~/g,'\\textasciitilde{}').replace(/\^/g,'\\textasciicircum{}');

/** Reading excerpts, searchable from the editor, inserted at the cursor with their source kept. */
export default function ExcerptPicker({path,onInsert,onClose}:{path:string;onInsert:(text:string)=>void;onClose:()=>void}){
 const [rows,setRows]=useState<Row[]>(),[query,setQuery]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let alive=true;void api<{documents:ReadingIndexItem[]}>('/api/workspace/reading').then(async({documents})=>{const names=await Promise.all(documents.map(d=>api<Resource>(`/api/workspace/resources/${encodeURIComponent(d.resourceId)}`).then(r=>r.name).catch(()=>d.document.notes[0]?.sourcePath.split('/').pop()||'未知来源')));if(alive)setRows(documents.flatMap((d,i)=>d.document.notes.map(note=>({note,paper:names[i].replace(/\.pdf$/i,'')}))));}).catch(e=>{if(alive){setRows([]);setError(e.status===404?'需要重启工作台后才能读取阅读摘录。':e.message);}});return()=>{alive=false;};},[]);
 const q=query.trim().toLocaleLowerCase();
 const list=useMemo(()=>(rows||[]).filter(r=>!q||[r.note.quote,r.note.translation,r.note.comment,r.paper].some(v=>v.toLocaleLowerCase().includes(q))).sort((a,b)=>b.note.createdAt.localeCompare(a.note.createdAt)),[rows,q]);
 const tex=/\.tex$/i.test(path);
 function format(row:Row,useTranslation:boolean){const text=(useTranslation&&row.note.translation?row.note.translation:row.note.quote).trim();const page=readingPage(row.note);const source=`${row.paper}${page!==null?`, p.${page}`:''}`;
  if(tex)return `% 摘录来源：${source.replace(/\n/g,' ')}\n\\begin{quote}\n${texEscape(text)}\n\\end{quote}\n`;
  return `${text.split('\n').map(l=>'> '+l).join('\n')}\n>\n> — ${source}\n\n`;}
 return <aside className="excerpt-picker" aria-label="阅读摘录">
  <header><strong><Quote size={15}/>阅读摘录</strong><button onClick={onClose} aria-label="关闭"><X size={16}/></button></header>
  <label className="excerpt-picker-search"><Search size={14}/><input autoFocus aria-label="搜索摘录" placeholder="搜索原文、译文、判断或论文…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
  <p className="excerpt-picker-hint">插入到光标处，{tex?'以 quote 环境并保留来源注释':'以 Markdown 引用并保留来源'}。</p>
  <div className="excerpt-picker-list">
   {!rows?<p className="excerpt-picker-empty"><LoaderCircle size={16} className="spin"/>正在读取…</p>:error?<p className="excerpt-picker-empty">{error}</p>:!list.length?<p className="excerpt-picker-empty">{q?'没有匹配的摘录。':'还没有摘录。在资料库阅读论文时选中文字，点“存为摘录”。'}</p>
   :list.map(row=><article key={row.note.id}>
     <small>{row.paper}{readingPage(row.note)!==null?` · p.${readingPage(row.note)}`:''}</small>
     <blockquote>{row.note.quote}</blockquote>
     {row.note.translation&&<p className="excerpt-picker-tr">{row.note.translation}</p>}
     {row.note.comment&&<p className="excerpt-picker-comment">{row.note.comment}</p>}
     <footer><button onClick={()=>onInsert(format(row,false))}><CornerDownLeft size={13}/>插入原文</button>{row.note.translation&&<button onClick={()=>onInsert(format(row,true))}><CornerDownLeft size={13}/>插入译文</button>}</footer>
    </article>)}
  </div>
 </aside>;
}
