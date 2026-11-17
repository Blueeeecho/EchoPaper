import {useState} from 'react';
import ResearchTextEditor from './ResearchTextEditor';
import {Check,Lightbulb,Pencil,Trash2,X} from 'lucide-react';
import {IDEA_KIND_LABELS,type IdeaKind,type TopicIdea,type TopicNotebook} from '../../shared/topic-notebook';
import {prettyDate} from '../api';
import AiMarkdown from '../components/AiMarkdown';

const KINDS=Object.keys(IDEA_KIND_LABELS) as IdeaKind[];

/** Ideas, hypotheses and open questions for a topic: a quick-add box and a timeline. */
export function TopicIdeas({notebook,update}:{notebook:TopicNotebook;update:(change:(n:TopicNotebook)=>TopicNotebook)=>void}){
 const [kind,setKind]=useState<IdeaKind>('idea'),[text,setText]=useState(''),[filter,setFilter]=useState<IdeaKind|''>(''),[editing,setEditing]=useState<{id:string;text:string}>();
 const add=()=>{const value=text.trim();if(!value)return;const now=new Date().toISOString();update(n=>({...n,ideas:[{id:crypto.randomUUID(),kind,text:value,createdAt:now,updatedAt:now},...n.ideas]}));setText('');};
 const patch=(id:string,change:Partial<TopicIdea>)=>update(n=>({...n,ideas:n.ideas.map(i=>i.id===id?{...i,...change,updatedAt:new Date().toISOString()}:i)}));
 const list=notebook.ideas.filter(i=>!filter||i.kind===filter);
 return <section className="topic-ideas">
  <header><h2><Lightbulb size={16}/>想法与假设</h2><nav>{(['',...KINDS] as const).map(k=><button key={k||'all'} aria-pressed={filter===k} onClick={()=>setFilter(k)}>{k?IDEA_KIND_LABELS[k]:'全部'}<small>{k?notebook.ideas.filter(i=>i.kind===k).length:notebook.ideas.length}</small></button>)}</nav></header>
  <div className="topic-idea-composer">
   <div className="topic-idea-kinds">{KINDS.map(k=><button key={k} className={`kind-${k}`} aria-pressed={kind===k} onClick={()=>setKind(k)}>{IDEA_KIND_LABELS[k]}</button>)}</div>
   <ResearchTextEditor aria-label="记录想法" maxLength={20000} rows={2} value={text} onChange={setText} onKeyDown={e=>{if(!e.nativeEvent.isComposing&&e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();add();}}} placeholder={kind==='hypothesis'?'写下一个可检验的假设：如果…那么…':kind==='question'?'写下一个还没想清楚的问题…':kind==='todo'?'写下需要验证或查证的事项…':'随手记下一个想法，⌘↩ 保存（支持 Markdown）'}/>
   <button className="academic-primary" disabled={!text.trim()} onClick={add}>记录</button>
  </div>
  {!list.length?<p className="topic-ideas-empty">{notebook.ideas.length?'这一类还没有记录。':'还没有记录。把阅读中冒出的想法、要检验的假设和没想清楚的问题都记在这里。'}</p>:
  <ol className="topic-idea-list">{list.map(i=><li key={i.id} className={i.done?'done':''}>
   <span className={`topic-idea-kind kind-${i.kind}`}>{IDEA_KIND_LABELS[i.kind]}</span>
   <div className="topic-idea-body">{editing?.id===i.id?<><ResearchTextEditor autoFocus aria-label="编辑想法" maxLength={20000} rows={3} value={editing.text} onChange={value=>setEditing({id:i.id,text:value})} onKeyDown={e=>{if(!e.nativeEvent.isComposing&&e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();if(editing.text.trim())patch(i.id,{text:editing.text.trim()});setEditing(undefined);}if(e.key==='Escape')setEditing(undefined);}}/><div className="topic-idea-edit-actions"><button onClick={()=>setEditing(undefined)}><X size={13}/>取消</button><button className="primary" disabled={!editing.text.trim()} onClick={()=>{patch(i.id,{text:editing.text.trim()});setEditing(undefined);}}><Check size={13}/>保存</button></div></>:<div className="research-note-markdown topic-idea-text"><AiMarkdown text={i.text}/></div>}<time>{prettyDate(i.createdAt)}{i.updatedAt!==i.createdAt?' · 已编辑':''}</time></div>
   <div className="topic-idea-actions">{(i.kind==='todo'||i.kind==='question'||i.kind==='hypothesis')&&<button title={i.done?'标为未解决':'标为已解决 / 已验证'} onClick={()=>patch(i.id,{done:!i.done})}><Check size={14}/></button>}<button title="编辑" onClick={()=>setEditing({id:i.id,text:i.text})}><Pencil size={13}/></button><button title="删除" onClick={()=>{if(confirm('删除这条记录？'))update(n=>({...n,ideas:n.ideas.filter(x=>x.id!==i.id)}));}}><Trash2 size={13}/></button></div>
  </li>)}</ol>}
 </section>;
}
