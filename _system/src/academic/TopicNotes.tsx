import {useCallback,useEffect,useId,useRef,useState,type MouseEvent} from 'react';
import {ArrowLeft,BookOpen,BookmarkPlus,Columns2,FileText,NotebookPen,PanelRightClose,PanelRightOpen,Search} from 'lucide-react';
import type {ResearchTopic,Resource} from '../../shared/workspace-types';
import type {ResearchNoteDocument} from '../../shared/research-notes';
import type {TopicIdea} from '../../shared/topic-notebook';
import {IDEA_KIND_LABELS} from '../../shared/topic-notebook';
import {paperTitle,uniquePaperResources} from '../../shared/resource-order';
import {prettyDate} from '../api';
import AiMarkdown from '../components/AiMarkdown';
import ResearchNotes,{type ResearchNoteAppend} from './ResearchNotes';
import ResourceReader from './ResourceReader';
import ReadingSplit from './ReadingSplit';
import './topic-notes.css';

type SaveGuard=()=>Promise<boolean>;
export interface TopicPaperRequest {id:string;paper:Resource}
function rememberedStudy(topicId:string):{expanded:boolean;paperId?:string;notesVisible:boolean}{
 try{const value=JSON.parse(sessionStorage.getItem(`echopaper:topic-study:${topicId}`)||'null');return {expanded:value?.expanded===true,paperId:typeof value?.paperId==='string'?value.paperId:undefined,notesVisible:value?.notesVisible!==false};}
 catch{return {expanded:false,notesVisible:true};}
}

/** The note editor stays mounted as the left-hand paper changes. */
export default function TopicNotes({topic,files,paperRequest,noteRequest,legacyIdeas,onRefresh,onGuardChange}:{topic:ResearchTopic;files:Resource[];paperRequest?:TopicPaperRequest;noteRequest?:{id:string;noteId:string};legacyIdeas:TopicIdea[];onRefresh:()=>Promise<void>;onGuardChange:(guard:SaveGuard|undefined)=>void}){
 const panel=useRef<HTMLElement>(null),notesId=useId();
 const [initial]=useState(()=>rememberedStudy(topic.id));
 const [notesVisible,setNotesVisible]=useState(initial.notesVisible);
 const [immersive,setImmersive]=useState(false);
 const [expanded,setExpanded]=useState(initial.expanded),[paper,setPaper]=useState<Resource>(),[paperQuery,setPaperQuery]=useState('');
 const [currentNote,setCurrentNote]=useState<ResearchNoteDocument>(),[appendRequest,setAppendRequest]=useState<ResearchNoteAppend>();
 const [noteBusy,setNoteBusy]=useState(false);
 const [error,setError]=useState(''),[mobilePane,setMobilePane]=useState<'paper'|'note'>(initial.notesVisible?'note':'paper');
 const [startPage,setStartPage]=useState<number>(),[readerGeneration,setReaderGeneration]=useState(0);
 const noteGuard=useRef<SaveGuard|undefined>(undefined),readerGuard=useRef<SaveGuard|undefined>(undefined),switchRequest=useRef(0);
 const setNoteGuard=useCallback((value:SaveGuard|undefined)=>{noteGuard.current=value;},[]);
 const setReaderGuard=useCallback((value:SaveGuard|undefined)=>{readerGuard.current=value;},[]);
 const papers=uniquePaperResources(files.filter(file=>file.kind==='file'&&!file.missing&&/\.pdf$/i.test(file.name)));
 useEffect(()=>{if(!paper&&papers.length)setPaper(papers.find(file=>file.id===initial.paperId)||papers[0]);},[files]);
 useEffect(()=>{try{sessionStorage.setItem(`echopaper:topic-study:${topic.id}`,JSON.stringify({expanded,paperId:paper?.id||initial.paperId,notesVisible}));}catch{/* Reading preferences are optional. */}},[expanded,paper?.id,topic.id,notesVisible]);
 useEffect(()=>{onGuardChange(async()=>{
  if(readerGuard.current&&!await readerGuard.current())return false;
  return !noteGuard.current||await noteGuard.current();
 });return()=>onGuardChange(undefined);},[onGuardChange]);
 useEffect(()=>{
  if(!expanded)return;
  const previous=document.body.style.overflow,before=document.activeElement as HTMLElement|null;
  document.body.style.overflow='hidden';
  const focus=requestAnimationFrame(()=>{
   const selector=!notesVisible||mobilePane==='paper'?'.topic-notes-paper select':'.topic-notes-writing [contenteditable="true"]';
   const target=Array.from(panel.current?.querySelectorAll<HTMLElement>(selector)||[]).find(node=>node.getClientRects().length>0);
   (target||Array.from(panel.current?.querySelectorAll<HTMLElement>('button')||[]).find(node=>node.getClientRects().length>0))?.focus();
  });
  const key=(event:KeyboardEvent)=>{
   if(event.key!=='Tab')return;
   const nodes=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]')||[]).filter(node=>node.getClientRects().length>0);
   const first=nodes[0],last=nodes.at(-1);if(!first||!last)return;
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  };
  document.addEventListener('keydown',key);
  return()=>{cancelAnimationFrame(focus);document.body.style.overflow=previous;document.removeEventListener('keydown',key);if(before?.isConnected)before.focus();};
 },[expanded]);
 async function selectPaper(value:Resource,open=true,page?:number){
  const sequence=++switchRequest.current;
  if(readerGuard.current&&!await readerGuard.current())return;
  if(sequence!==switchRequest.current)return;
  setError('');setPaper(value);setStartPage(page);if(page!==undefined)setReaderGeneration(previous=>previous+1);
  if(open)setExpanded(true);setMobilePane('paper');
 }
 useEffect(()=>{if(paperRequest)void selectPaper(paperRequest.paper);},[paperRequest]);
 useEffect(()=>{if(!noteRequest)return;setNotesVisible(true);setMobilePane('note');if(!expanded)panel.current?.scrollIntoView({block:'start',behavior:'smooth'});},[noteRequest]);
 async function collapse(){if(readerGuard.current&&!await readerGuard.current())return;setExpanded(false);}
 function toggleNotes(){setNotesVisible(value=>!value);setMobilePane(notesVisible?'paper':'note');}
 function choosePaper(id:string){const value=papers.find(file=>file.id===id);if(value)void selectPaper(value);}
 const consumeAppend=useCallback((id:string)=>setAppendRequest(previous=>previous?.id===id?undefined:previous),[]);
 function append(text:string){
  if(noteBusy){setError('笔记操作完成后可继续追加来源。');return;}
  if(!currentNote){setError('先新建或打开一篇课题笔记，再将文献内容写入。');return;}
  setAppendRequest({id:crypto.randomUUID(),noteId:currentNote.id,text});setNotesVisible(true);setMobilePane('note');setError('');
 }
 function followSource(event:MouseEvent){
  if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  const target=event.target instanceof Element?event.target.closest('a[href]'):null;if(!target)return;
  const url=new URL(target.getAttribute('href')!,location.href);if(url.origin!==location.origin)return;
  const raw=url.pathname.match(/^\/api\/workspace\/resources\/([^/]+)\/raw$/);
  const route=url.hash.startsWith('#/library?')?new URLSearchParams(url.hash.split('?')[1]):undefined;
  const id=raw?.[1]||route?.get('resource');const source=papers.find(file=>file.id===id);if(!source)return;
  const at=Number(new URLSearchParams(url.hash.slice(1)).get('page'));const page=Number.isSafeInteger(at)&&at>0?at:undefined;
  event.preventDefault();event.stopPropagation();void selectPaper(source,true,page);
 }
 const query=paperQuery.trim().toLocaleLowerCase();
 const choices=papers.filter(file=>!query||[paperTitle(file),...file.tags].some(value=>value.toLocaleLowerCase().includes(query)));
 if(paper&&!choices.some(file=>file.id===paper.id))choices.unshift(paper);
 const compactChoices=paper&&!papers.some(file=>file.id===paper.id)?[paper,...papers]:papers;
 const embeddedToolbar={
  title:<select aria-label="切换左侧文献" value={paper?.id||''} onChange={event=>choosePaper(event.target.value)}>{compactChoices.map(file=><option key={file.id} value={file.id}>{paperTitle(file)}</option>)}</select>,
  actions:<>{paper&&currentNote&&<button type="button" className="reader-icon" aria-label="记录来源" title="记录来源" disabled={noteBusy} onClick={()=>append(`[${paperTitle(paper)}](/api/workspace/resources/${paper.id}/raw)`)}><BookmarkPlus size={15}/></button>}<button type="button" className="reader-study-note-toggle" aria-label={notesVisible?'隐藏课题笔记':'展开课题笔记'} aria-expanded={notesVisible} aria-controls={notesId} onClick={toggleNotes}>{notesVisible?<PanelRightClose size={15}/>:<PanelRightOpen size={15}/>}<span>笔记</span></button></>,
  fullscreenTarget:panel,
 };
 return <section ref={panel} className={`topic-notes ${expanded?'is-expanded':''} ${expanded&&immersive?'is-immersive':''} mobile-${mobilePane}`} role={expanded?'dialog':undefined} aria-modal={expanded||undefined} aria-label={expanded?'课题笔记与文献分栏工作区':'课题笔记'}>
  <header className="topic-notes-head">
   <div>{expanded&&<button type="button" className="academic-secondary" aria-label="退出边读边记" onClick={()=>void collapse()}><ArrowLeft size={15}/>返回课题</button>}<h2><NotebookPen size={17}/>课题笔记</h2>{expanded&&<span>{topic.title}</span>}</div>
   <div>{expanded?<nav className="topic-notes-mobile-tabs" aria-label="分栏工作区面板"><button type="button" aria-pressed={mobilePane==='paper'} onClick={()=>setMobilePane('paper')}><BookOpen size={14}/>文献</button><button type="button" aria-pressed={mobilePane==='note'} onClick={()=>{setNotesVisible(true);setMobilePane('note');}}><FileText size={14}/>笔记</button></nav>:<button type="button" className="academic-primary" onClick={()=>{setNotesVisible(true);setExpanded(true);setMobilePane('note');}}><Columns2 size={15}/>边读边记</button>}{expanded&&<button type="button" className="academic-secondary topic-notes-visibility-toggle" aria-label={notesVisible?'隐藏课题笔记':'展开课题笔记'} aria-expanded={notesVisible} aria-controls={notesId} onClick={toggleNotes}>{notesVisible?<PanelRightClose size={15}/>:<PanelRightOpen size={15}/>}{notesVisible?'隐藏笔记':'展开笔记'}</button>}</div>
  </header>
  {error&&<p role="alert" className="academic-inline-error">{error}</p>}
  <ReadingSplit className="topic-notes-columns" enabled={expanded&&notesVisible} label="调整文献与课题笔记比例" storageKey="echopaper:topic-note-split" defaultWidth={55} stackBelow={0}>
   <aside className="topic-notes-paper" hidden={!expanded} aria-label="左侧文献阅读">
    <div className="topic-notes-paper-picker"><label><Search size={14}/><input aria-label="筛选分栏文献" value={paperQuery} onChange={event=>setPaperQuery(event.target.value)} placeholder="按标题筛选文献"/></label><select aria-label="切换左侧文献" value={paper?.id||''} onChange={event=>choosePaper(event.target.value)}><option value="" disabled>选择课题文献</option>{choices.map(file=><option key={file.id} value={file.id}>{paperTitle(file)}</option>)}</select>{paper&&currentNote&&<button type="button" className="academic-secondary" disabled={noteBusy} onClick={()=>append(`[${paperTitle(paper)}](/api/workspace/resources/${paper.id}/raw)`)}>记录来源</button>}</div>
    <div className="topic-notes-reader">{expanded&&paper?<ResourceReader key={`${paper.id}:${paper.hash||''}:${readerGeneration}`} embedded resource={paper} initialPage={startPage} onClose={()=>void collapse()} onGuardChange={setReaderGuard} onImmersiveChange={setImmersive} embeddedToolbar={embeddedToolbar} onAppendToNote={currentNote&&!noteBusy?append:undefined}/>:<div className="topic-notes-paper-empty"><BookOpen size={28}/><p>课题中添加 PDF 后，可在这里切换阅读。</p></div>}</div>
   </aside>
   <div id={notesId} className="topic-notes-writing" hidden={expanded&&!notesVisible} onClickCapture={followSource}>
    <ResearchNotes topicId={topic.id} section="ideation" onGuardChange={setNoteGuard} onRefresh={onRefresh} onDocumentChange={setCurrentNote} compact={expanded} appendRequest={appendRequest} onAppendConsumed={consumeAppend} onBusyChange={setNoteBusy} openRequest={noteRequest}/>
   </div>
  </ReadingSplit>
  {!expanded&&legacyIdeas.length>0&&<details className="topic-notes-legacy"><summary>原有想法记录 · {legacyIdeas.length}</summary>{legacyIdeas.map(idea=><article key={idea.id}><small>{IDEA_KIND_LABELS[idea.kind]} · {prettyDate(idea.createdAt)}</small><AiMarkdown text={idea.text}/></article>)}</details>}
 </section>;
}
