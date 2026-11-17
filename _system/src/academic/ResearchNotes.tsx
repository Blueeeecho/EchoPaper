import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {Check,Download,FileText,LoaderCircle,PanelLeftClose,PanelLeftOpen,Plus,RefreshCw,RotateCcw,Search,Trash2} from 'lucide-react';
import type {ResearchNoteDocument,ResearchNoteSummary,ResearchNoteSection,ResearchNoteTrashEntry} from '../../shared/research-notes';
import {api,downloadText,json,prettyDate} from '../api';
import AiMarkdown from '../components/AiMarkdown';
import ResearchTextEditor from './ResearchTextEditor';
import './research-notes.css';

type SaveGuard=()=>Promise<boolean>;
interface PendingDelete {noteId:string;expectedHash:string;requestId:string}
export interface ResearchNoteAppend {id:string;noteId:string;text:string}
const noteName=(note:Pick<ResearchNoteSummary,'name'>)=>note.name.replace(/\.md$/i,'');

export default function ResearchNotes({topicId,section,onGuardChange,onRefresh,onDocumentChange,compact=false,appendRequest,onAppendConsumed,onBusyChange,openRequest}:{topicId:string;section:ResearchNoteSection;onGuardChange:(guard:SaveGuard|undefined)=>void;onRefresh:()=>Promise<void>;onDocumentChange?:(document:ResearchNoteDocument|undefined)=>void;compact?:boolean;appendRequest?:ResearchNoteAppend;onAppendConsumed?:(id:string)=>void;onBusyChange?:(busy:boolean)=>void;openRequest?:{id:string;noteId:string}}){
 const endpoint=`/api/workspace/topics/${encodeURIComponent(topicId)}/notes/${section}`;
 const selectionKey=`echopaper:research-notes:${topicId}:${section}`;
 const deleteKey=`${selectionKey}:pending-delete`;
 const [notes,setNotes]=useState<ResearchNoteSummary[]>([]);
 const noteNames=useRef(new Map<string,string>());noteNames.current=new Map(notes.map(note=>[note.id,note.name]));
 const [document,setDocument]=useState<ResearchNoteDocument>();
 const documentRef=useRef<ResearchNoteDocument|undefined>(undefined);
 function showDocument(value:ResearchNoteDocument|undefined){documentRef.current=value;setDocument(value);}
 const [deleting,setDeleting]=useState(false),[restoring,setRestoring]=useState(false),[trashOpen,setTrashOpen]=useState(false),[trash,setTrash]=useState<ResearchNoteTrashEntry[]>([]);
 const [pendingDelete,setPendingDelete]=useState<PendingDelete|undefined>(()=>{try{return readPendingDelete();}catch{return undefined;}}),[lastDeleted,setLastDeleted]=useState<ResearchNoteTrashEntry>(),[comparison,setComparison]=useState<ResearchNoteDocument>();
 const pendingDeleteRef=useRef<PendingDelete|undefined>(pendingDelete);
 const [listCollapsed,setListCollapsed]=useState(section!=='ideation');
 const label=section==='ideation'?'笔记':'记录';
 useEffect(()=>{if(compact)setListCollapsed(true);},[compact]);
 useEffect(()=>{onDocumentChange?.(document);},[document,onDocumentChange]);
 const [notice,setNotice]=useState('');
 const [loading,setLoading]=useState(true),[creating,setCreating]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState('');
 const working=creating||deleting||restoring;
 useEffect(()=>{onBusyChange?.(working||!!pendingDelete);},[working,pendingDelete,onBusyChange]);
 const editorGuard=useRef<SaveGuard|undefined>(undefined),request=useRef(0),listRequest=useRef(0),alive=useRef(true),actionInFlight=useRef(false);
 const pendingCreate=useRef<{requestId:string;day?:string}|undefined>(undefined);
 const pendingKey=`${selectionKey}:pending-create`;
 const selected=useRef<string|undefined>(undefined);
 const setEditorGuard=useCallback((guard:SaveGuard|undefined)=>{editorGuard.current=guard;},[]);
 useEffect(()=>{alive.current=true;onGuardChange(async()=>!actionInFlight.current&&!pendingDeleteRef.current&&(!editorGuard.current||await editorGuard.current()));return()=>{alive.current=false;request.current++;listRequest.current++;onGuardChange(undefined);};},[onGuardChange]);
 function remember(id:string){selected.current=id;try{sessionStorage.setItem(selectionKey,id);}catch{/* Selection is optional. */}}
 async function loadNote(noteId:string,preserveError=false){
  const sequence=++request.current;setLoading(true);if(!preserveError)setError('');showDocument(undefined);
  try{const value=await api<ResearchNoteDocument>(`${endpoint}/${encodeURIComponent(noteId)}`,{timeoutMs:30000});if(alive.current&&sequence===request.current){remember(value.id);showDocument(value);}}
  catch(e:any){if(alive.current&&sequence===request.current)setError(e.message);}
  finally{if(alive.current&&sequence===request.current)setLoading(false);}
 }
 async function loadList(){
  const sequence=++listRequest.current;let noteSequence=request.current;
  setLoading(true);setError('');
  try{
   const [value,bin]=await Promise.all([api<{notes:ResearchNoteSummary[]}>(endpoint,{timeoutMs:30000}),api<{entries:ResearchNoteTrashEntry[]}>(`${endpoint}/trash`,{timeoutMs:30000})]);if(!alive.current||sequence!==listRequest.current)return;setNotes(value.notes);setTrash(bin.entries);
   let recoveryFailed=false,recoveredId:string|undefined;
   try{
    const raw=sessionStorage.getItem(pendingKey),pending=raw?JSON.parse(raw):undefined;
    if(pending&&typeof pending.requestId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(pending.requestId)){
     const recovered=await api<ResearchNoteDocument>(endpoint,{...json('POST',{requestId:pending.requestId,...(typeof pending.day==='string'?{day:pending.day}:{}),expectedHash:null}),timeoutMs:30000});
     if(!alive.current||sequence!==listRequest.current)return;
     sessionStorage.removeItem(pendingKey);pendingCreate.current=undefined;recoveredId=recovered.id;
     value.notes=[recovered,...value.notes.filter(note=>note.id!==recovered.id)];setNotes(value.notes);setNotice('已恢复上次创建的笔记。');
     void onRefresh().catch(()=>{if(alive.current)setError('笔记已恢复，工作台索引暂未刷新。');});
    }
   }catch(e:any){if(!alive.current||sequence!==listRequest.current)return;recoveryFailed=true;setError(`上次新建结果仍待核对。${e.message}`);}
   try{
    const pending=readPendingDelete();
    if(pending){
     pendingDeleteRef.current=pending;setPendingDelete(pending);
     const entry=await deleteRequest(pending);if(!alive.current||sequence!==listRequest.current)return;
     acknowledgeDelete(entry);noteSequence=++request.current;
     if(documentRef.current?.id===entry.noteId){showDocument(undefined);remember('');}
     value.notes=value.notes.filter(note=>note.id!==entry.noteId);setNotes(value.notes);
    }
   }catch(error:any){if(!alive.current||sequence!==listRequest.current)return;recoveryFailed=true;deleteFailed(error);}
   // An explicit note selection can finish while the independent list request is pending.
   if(noteSequence!==request.current)return;
   let remembered=recoveredId||selected.current;try{remembered||=sessionStorage.getItem(selectionKey)||undefined;}catch{/* Selection is optional. */}
   const current=value.notes.find(note=>note.id===remembered)||value.notes[0];
   if(current)await loadNote(current.id,recoveryFailed);else{showDocument(undefined);setLoading(false);}
  }catch(e:any){if(alive.current&&sequence===listRequest.current){setError(e.message);if(noteSequence===request.current)setLoading(false);}}
 }
 useEffect(()=>{void loadList();},[endpoint]);
 useEffect(()=>{if(openRequest)void select(openRequest.noteId);},[openRequest]);
 async function select(noteId:string){if(actionInFlight.current||pendingDeleteRef.current)return;if(noteId===document?.id){setListCollapsed(true);return;}if(editorGuard.current&&!await editorGuard.current())return;await loadNote(noteId);setListCollapsed(true);}
 async function create(){
  if(loading||actionInFlight.current||pendingDeleteRef.current)return;
  actionInFlight.current=true;setCreating(true);setError('');setNotice('');
  try{
   if(editorGuard.current&&!await editorGuard.current())return;
   if(!pendingCreate.current){
    try{const raw=sessionStorage.getItem(pendingKey),saved=raw?JSON.parse(raw):undefined;if(saved&&typeof saved.requestId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(saved.requestId))pendingCreate.current={requestId:saved.requestId,...(typeof saved.day==='string'?{day:saved.day}:{})};}catch{/* A new request remains protected for this mounted editor. */}
   }
   const input=pendingCreate.current||{requestId:crypto.randomUUID()};pendingCreate.current=input;
   try{sessionStorage.setItem(pendingKey,JSON.stringify(input));}catch{setError('新建请求暂存不可用，请在当前窗口核对创建结果。');}
   const value=await api<ResearchNoteDocument>(endpoint,{...json('POST',{...input,expectedHash:null}),timeoutMs:30000});
   pendingCreate.current=undefined;try{sessionStorage.removeItem(pendingKey);}catch{/* The confirmed document is available in the list. */}if(!alive.current)return;
   request.current++;listRequest.current++;remember(value.id);setNotes(previous=>[value,...previous.filter(note=>note.id!==value.id)]);showDocument(value);setLoading(false);setListCollapsed(true);
   void onRefresh().catch(()=>{if(alive.current)setError('记录已创建，工作台索引暂未刷新。');});
  }catch(e:any){if(alive.current)setError(`${e.message} 再次点击新建会核对同一次请求。`);}
  finally{actionInFlight.current=false;if(alive.current)setCreating(false);}
 }
 function clearPendingDelete(){
  pendingDeleteRef.current=undefined;setPendingDelete(undefined);
  try{sessionStorage.removeItem(deleteKey);}catch{/* Replays are idempotent. */}
 }
 function readPendingDelete():PendingDelete|undefined{
  const raw=sessionStorage.getItem(deleteKey);if(!raw)return undefined;
  const value=JSON.parse(raw);
  if(typeof value?.noteId!=='string'||!value.noteId||typeof value.requestId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value.requestId)||typeof value.expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(value.expectedHash))throw Error('删除请求暂存无法读取，请在回收站核对原笔记。');
  return value;
 }
 async function refreshTrash(){const value=await api<{entries:ResearchNoteTrashEntry[]}>(`${endpoint}/trash`,{timeoutMs:30000});if(alive.current)setTrash(value.entries);return value.entries;}
 async function deleteRequest(input:PendingDelete){
  try{return (await api<{deletion:ResearchNoteTrashEntry}>(`${endpoint}/${encodeURIComponent(input.noteId)}`,{...json('DELETE',{expectedHash:input.expectedHash,requestId:input.requestId}),timeoutMs:30000})).deletion;}
  catch(error:any){
   try{const entries=await refreshTrash(),entry=entries.find(item=>item.id===input.requestId);if(entry?.status==='applied')return entry;if(entry)error.deletion=entry;}catch{/* Preserve the confirmed intent until its outcome is known. */}
   throw error;
  }
 }
 function deleteFailed(error:any){
  const entry:ResearchNoteTrashEntry|undefined=error.deletion||error.data?.deletion;
  if(entry?.status==='failed'||entry?.status==='undone'||!entry&&error.status>=400&&error.status<500&&error.status!==408&&!error.data?.uncertain)clearPendingDelete();
  if(error.data?.current)setComparison(error.data.current);
  setError(`${error.message}${pendingDeleteRef.current?' 删除结果仍待核对，点击“重新读取”继续核对。':''}`);
 }
 function acknowledgeDelete(entry:ResearchNoteTrashEntry){
  clearPendingDelete();
  // Restoring the original also makes any older or unreadable window draft available again.
  setTrash(previous=>[entry,...previous.filter(item=>item.id!==entry.id)]);setLastDeleted(entry);setNotice('已移至回收站。');
 }
 async function remove(note:ResearchNoteSummary){
  if(loading||actionInFlight.current||pendingDeleteRef.current)return;
  actionInFlight.current=true;setDeleting(true);setError('');setComparison(undefined);
  try{
   if(editorGuard.current&&!await editorGuard.current())return;
   const current=documentRef.current?.id===note.id?documentRef.current:await api<ResearchNoteDocument>(`${endpoint}/${encodeURIComponent(note.id)}`,{timeoutMs:30000});
   if(!window.confirm(`将“${noteName(current)}”移至回收站？\n可以在本分区的回收站中恢复。`))return;
   const input:PendingDelete={noteId:current.id,expectedHash:current.hash,requestId:crypto.randomUUID()};
   pendingDeleteRef.current=input;setPendingDelete(input);try{sessionStorage.setItem(deleteKey,JSON.stringify(input));}catch{setError('删除请求暂存不可用，请在当前窗口核对操作结果。');}
   const entry=await deleteRequest(input);if(!alive.current)return;
   acknowledgeDelete(entry);request.current++;listRequest.current++;
   const remaining=notes.filter(item=>item.id!==entry.noteId);setNotes(remaining);
   if(documentRef.current?.id===entry.noteId){showDocument(undefined);remember(remaining[0]?.id||'');if(remaining[0])await loadNote(remaining[0].id);else{setLoading(false);setListCollapsed(false);}}
   void onRefresh().catch(()=>{if(alive.current)setError('记录已移至回收站，工作台索引暂未刷新。');});
  }catch(error:any){if(alive.current)deleteFailed(error);}
  finally{actionInFlight.current=false;if(alive.current)setDeleting(false);}
 }
 async function restore(entry:ResearchNoteTrashEntry){
  if(actionInFlight.current||pendingDeleteRef.current)return;
  actionInFlight.current=true;setRestoring(true);setError('');setComparison(undefined);
  try{
   if(editorGuard.current&&!await editorGuard.current())return;
   let value:ResearchNoteDocument;
   try{value=await api<ResearchNoteDocument>(`${endpoint}/trash/${encodeURIComponent(entry.id)}/restore`,{...json('POST',{expectedHash:entry.hash}),timeoutMs:30000});}
   catch(error){const entries=await refreshTrash();if(entries.find(item=>item.id===entry.id)?.status!=='undone')throw error;value=await api<ResearchNoteDocument>(`${endpoint}/${encodeURIComponent(entry.noteId)}`,{timeoutMs:30000});}
   if(!alive.current)return;
   request.current++;listRequest.current++;remember(value.id);setNotes(previous=>[value,...previous.filter(item=>item.id!==value.id)]);showDocument(value);setLoading(false);setListCollapsed(true);
   setTrash(previous=>previous.map(item=>item.id===entry.id?{...item,status:'undone',undoable:false}:item));setLastDeleted(previous=>previous?.id===entry.id?undefined:previous);setNotice('笔记已恢复。');
   void onRefresh().catch(()=>{if(alive.current)setError('笔记已恢复，工作台索引暂未刷新。');});
  }catch(error:any){if(alive.current)setError(`恢复结果需要核对。${error.message}`);}
  finally{actionInFlight.current=false;if(alive.current)setRestoring(false);}
 }
 async function downloadDeleted(entry:ResearchNoteTrashEntry){
  try{const value=await api<{content:string;filename:string}>(`${endpoint}/trash/${encodeURIComponent(entry.id)}`,{timeoutMs:30000});downloadText(value.filename,value.content);}catch(error:any){setError(error.message);}
 }

 const saved=useCallback((value:ResearchNoteDocument)=>{const titleChanged=noteNames.current.get(value.id)!==value.name;setNotes(previous=>previous.map(note=>note.id===value.id?value:note));if(documentRef.current?.id===value.id)showDocument(value);if(value.legacy||titleChanged)void onRefresh().catch(()=>{if(alive.current)setError('记录已保存，课题状态暂未刷新。');});},[onRefresh]);
 const recycled=trash.filter(item=>item.status==='applied'||item.status==='interrupted');
 const filtered=notes.filter(note=>note.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 const navigation=<><button type="button" className="academic-secondary research-notes-list-toggle" aria-label={listCollapsed?`展开${label}列表`:`收起${label}列表`} aria-expanded={!listCollapsed} onClick={()=>setListCollapsed(value=>!value)}>{listCollapsed?<PanelLeftOpen size={14}/>:<PanelLeftClose size={14}/>}{label} {notes.length}</button>{listCollapsed&&<button type="button" className="academic-secondary" disabled={loading||working||!!pendingDelete} onClick={()=>void create()}><Plus size={14}/>{creating?'新建中…':`新建${label}`}</button>}<button type="button" className="academic-secondary" aria-expanded={trashOpen} disabled={working} onClick={()=>{setTrashOpen(value=>!value);void refreshTrash().catch(error=>setError(error.message));}}><Trash2 size={14}/>回收站 {recycled.length}</button></>;
 return <div className={`research-notes-workspace ${listCollapsed?'list-collapsed':''}`}>
  <aside className="research-notes-list" aria-label="Markdown 记录列表">
   <header><strong>{label} <small>{notes.length}</small></strong><div><button type="button" className="academic-icon" title="刷新记录" aria-label="刷新记录" disabled={loading||working||!!pendingDelete} onClick={()=>void (editorGuard.current?editorGuard.current():Promise.resolve(true)).then(ok=>{if(ok)void loadList();})}><RefreshCw size={13}/></button><button type="button" className="academic-primary" disabled={loading||working||!!pendingDelete} onClick={()=>void create()}><Plus size={14}/>{creating?'新建中…':`新建${label}`}</button></div></header>
   {notes.length>5&&<label className="research-notes-search"><Search size={14}/><input aria-label="搜索研究记录" value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索记录…"/></label>}
   <nav>{filtered.map(note=><div className="research-note-row" key={note.id}><button type="button" aria-current={document?.id===note.id?'page':undefined} disabled={working||!!pendingDelete} onClick={()=>void select(note.id)}><FileText size={15}/><span><strong>{noteName(note)}</strong><small>{note.legacy?'原有内容':prettyDate(note.updatedAt)}</small></span></button><button type="button" className="academic-icon research-note-delete" aria-label={`删除${label}“${noteName(note)}”`} title={`删除${label}`} disabled={loading||working||!!pendingDelete} onClick={()=>void remove(note)}><Trash2 size={14}/></button></div>)}</nav>
   {!loading&&!notes.length&&<p className="research-notes-list-empty">{section==='ideation'?'新建笔记，持续记录和整理研究思路。':'按日期记录每次方案、观察与结论。'}</p>}
  </aside>
  <article className="research-notes-document">
   {notice&&<div role="status" className="research-notes-recovered">{notice}{lastDeleted&&<button type="button" className="academic-secondary" disabled={working||!!pendingDelete} onClick={()=>void restore(lastDeleted)}><RotateCcw size={13}/>撤销删除</button>}</div>}
   {error&&<div className="research-notes-error" role="alert"><p>{error}</p><button type="button" className="academic-secondary" disabled={working} onClick={()=>void (editorGuard.current?editorGuard.current():Promise.resolve(true)).then(ok=>{if(ok)void loadList();})}><RefreshCw size={13}/>重新读取</button></div>}
   {comparison&&<details className="research-notes-conflict" open><summary>磁盘当前内容 · {noteName(comparison)}</summary><div className="research-note-markdown"><AiMarkdown text={comparison.content||'（空记录）'}/></div></details>}
   {trashOpen&&<section className="research-notes-trash" aria-label={`${label}回收站`}><header><strong>回收站</strong><button type="button" className="academic-secondary" onClick={()=>setTrashOpen(false)}>收起</button></header>{recycled.length?recycled.map(entry=><article key={entry.id}><div><strong>{noteName(entry)}</strong><small>{prettyDate(entry.deletedAt)}{entry.status==='interrupted'?' · 待核对':''}</small>{entry.error&&<p>{entry.error}</p>}</div><button type="button" className="academic-secondary" aria-label={`下载回收副本“${noteName(entry)}”`} onClick={()=>void downloadDeleted(entry)}>下载副本</button><button type="button" className="academic-secondary" aria-label={`恢复“${noteName(entry)}”`} disabled={working||!!pendingDelete||!entry.undoable} onClick={()=>void restore(entry)}><RotateCcw size={13}/>恢复</button></article>):<p>回收站为空。</p>}</section>}
   {loading?<div className="research-notes-empty" role="status"><LoaderCircle size={20} className="spin"/>正在读取记录…</div>:document?<NoteEditor key={`${topicId}:${section}:${document.id}`} initial={document} endpoint={endpoint} draftKey={`${selectionKey}:${document.id}:draft`} onSaved={saved} onGuardChange={setEditorGuard} navigation={navigation} appendRequest={appendRequest} onAppendConsumed={onAppendConsumed} editorLabel={section==='ideation'?'课题笔记内容':'Markdown 内容'} readOnly={working||!!pendingDelete} onDelete={()=>void remove(document)}/>:<><header className="research-notes-document-head"><div className="research-notes-navigation">{navigation}</div></header><div className="research-notes-empty"><FileText size={28}/><h2>{section==='ideation'?'开始一篇课题笔记':'开始一条记录'}</h2><p>支持 Markdown、表格与公式，输入后自动保存到本地文件。</p><button type="button" className="academic-primary" disabled={working||!!pendingDelete} onClick={()=>void create()}><Plus size={15}/>新建{label}</button></div></>}
  </article>
 </div>;
}

function NoteEditor({initial,endpoint,draftKey,onSaved,onGuardChange,navigation,appendRequest,onAppendConsumed,editorLabel,readOnly,onDelete}:{initial:ResearchNoteDocument;endpoint:string;draftKey:string;onSaved:(value:ResearchNoteDocument)=>void;onGuardChange:(guard:SaveGuard|undefined)=>void;navigation:ReactNode;appendRequest?:ResearchNoteAppend;onAppendConsumed?:(id:string)=>void;editorLabel:string;readOnly:boolean;onDelete:()=>void}){
 const [content,setContent]=useState(initial.content),[base,setBase]=useState(initial);
 const [saving,setSaving]=useState(false),[error,setError]=useState(''),[draftWarning,setDraftWarning]=useState(''),[conflict,setConflict]=useState<ResearchNoteDocument>();
 const [initialized,setInitialized]=useState(false);
 const [damagedDraft,setDamagedDraft]=useState<string>();
 const damaged=useRef<string|undefined>(undefined);
 const text=useRef(initial.content),baseline=useRef(initial),remote=useRef<ResearchNoteDocument|undefined>(undefined),inFlight=useRef<Promise<boolean>|undefined>(undefined),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),alive=useRef(true);
 const endpointRef=useRef(`${endpoint}/${encodeURIComponent(initial.id)}`);
 const consumedAppend=useRef<string|undefined>(undefined);
 useEffect(()=>{
  if(!initialized||!appendRequest||appendRequest.noteId!==initial.id||consumedAppend.current===appendRequest.id)return;
  if(readOnly)return;
  consumedAppend.current=appendRequest.id;
  const content=[text.current.trimEnd(),appendRequest.text].filter(Boolean).join('\n\n')+'\n';
  if(content.length>100000)setError('笔记已达到当前编辑长度上限，请新建笔记继续记录。');else edit(content);
  onAppendConsumed?.(appendRequest.id);
 },[appendRequest,onAppendConsumed,initial.id,readOnly,initialized]);
 const dirty=content!==base.content;
 function persistDraft(value:string,hash:string){if(damaged.current!==undefined)return;try{sessionStorage.setItem(draftKey,JSON.stringify({content:value,hash}));setDraftWarning('');}catch{setDraftWarning('窗口草稿暂存失败，请留意文件保存状态。');}}
 function clearDraft(){if(damaged.current!==undefined)return;try{sessionStorage.removeItem(draftKey);}catch{setDraftWarning('文件已保存，窗口中的旧草稿未能清理。');}}
 const flush=useCallback(async():Promise<boolean>=>{
  clearTimeout(timer.current);if(inFlight.current)return inFlight.current;if(remote.current)return false;
  const work=async()=>{
   while(text.current!==baseline.current.content){
    const snapshot=text.current,previous=baseline.current;
    if(alive.current){setSaving(true);setError('');}
    let value:ResearchNoteDocument;
    try{value=await api<ResearchNoteDocument>(endpointRef.current,{...json('PUT',{content:snapshot,expectedHash:previous.hash}),timeoutMs:30000});}
    catch(e:any){
     const reported=e.status===409?e.data?.current:undefined;
     let latest:ResearchNoteDocument|undefined=reported?.id===initial.id&&typeof reported.content==='string'&&typeof reported.hash==='string'?reported:undefined;
     if(!latest)try{latest=await api<ResearchNoteDocument>(endpointRef.current,{timeoutMs:30000});}catch{/* The local draft remains available while offline. */}
     if(latest?.content===snapshot)value=latest;
     else{
      if(alive.current){
       if(latest&&latest.hash!==previous.hash){remote.current=latest;setConflict(latest);setError('文件已在其他位置修改。请比较磁盘内容，合并后继续保存。');}
       else setError(`${e.message} 当前输入已保留，可重试保存。`);
      }
      return false;
     }
    }
    baseline.current=value;
    if(alive.current){setBase(value);onSaved(value);}
    if(text.current===value.content)clearDraft();else persistDraft(text.current,value.hash);
   }
   return true;
  };
  const promise=work().finally(()=>{inFlight.current=undefined;if(alive.current)setSaving(false);});inFlight.current=promise;return promise;
 },[draftKey,initial.id,onSaved]);
 useEffect(()=>{
  alive.current=true;onGuardChange(flush);
  let raw:string|null=null;
  try{
   raw=sessionStorage.getItem(draftKey);
   if(raw){
    const draft=JSON.parse(raw);
    if(typeof draft.content!=='string'||typeof draft.hash!=='string')throw Error('窗口草稿格式无法读取，请先保留此窗口。');
    if(draft.content===initial.content)clearDraft();
    else{text.current=draft.content;setContent(draft.content);if(draft.hash!==initial.hash){remote.current=initial;setConflict(initial);setError('已恢复窗口草稿，磁盘内容已有变化。请比较后合并。');}else timer.current=setTimeout(()=>void flush(),600);}
   }
  }catch(e:any){if(raw!==null){damaged.current=raw;setDamagedDraft(raw);setDraftWarning('窗口草稿无法读取，原始内容已保留，可下载核对。当前编辑仍会自动保存到文件。');}else setDraftWarning(e.message||'窗口草稿读取失败，请保留此窗口。');}
  setInitialized(true);
  const beforeUnload=(event:BeforeUnloadEvent)=>{if(text.current!==baseline.current.content||inFlight.current){event.preventDefault();event.returnValue='';}};
  const shortcut=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();void flush();}};
  window.addEventListener('beforeunload',beforeUnload);window.addEventListener('keydown',shortcut);
  return()=>{alive.current=false;clearTimeout(timer.current);onGuardChange(undefined);window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('keydown',shortcut);};
 },[flush,onGuardChange]);
 function edit(value:string){
  if(readOnly)return;
  text.current=value;setContent(value);persistDraft(value,baseline.current.hash);clearTimeout(timer.current);
  if(!remote.current)timer.current=setTimeout(()=>void flush(),600);
 }
 function merge(){if(!remote.current)return;baseline.current=remote.current;setBase(remote.current);remote.current=undefined;setConflict(undefined);persistDraft(text.current,baseline.current.hash);setError('');void flush();}
 function useDisk(){if(!remote.current||!window.confirm('使用磁盘版本会替换当前输入。请先下载需要保留的草稿。继续？'))return;const value=remote.current;baseline.current=value;text.current=value.content;setContent(value.content);setBase(value);remote.current=undefined;setConflict(undefined);setError('');clearDraft();onSaved(value);}
 const download=()=>downloadText(base.filename||`${base.name}.md`,text.current);
 return <>
  <header className="research-notes-document-head">
   <div className="research-notes-navigation">{navigation}</div>
   <div className="research-notes-title"><strong>{noteName(base)}</strong><span role="status" className={error?'has-error':''}>{saving?<><LoaderCircle size={12} className="spin"/>保存中…</>:error?'保存待处理':dirty?'编辑中 · 自动保存':<><Check size={12}/>已保存</>}</span></div>
   <div className="research-notes-actions"><button type="button" className="academic-icon" title="下载 Markdown" aria-label="下载 Markdown" onClick={download}><Download size={15}/></button><button type="button" className="academic-secondary research-note-delete" aria-label={editorLabel==='课题笔记内容'?'删除笔记':'删除记录'} title="移至回收站" disabled={readOnly} onClick={onDelete}><Trash2 size={15}/>删除</button></div>
  </header>
  {error&&<div className="research-notes-error" role="alert"><p>{error}</p><button type="button" className="academic-secondary" onClick={download}>下载草稿</button>{conflict?<><button type="button" className="academic-secondary" onClick={useDisk}>使用磁盘版本</button><button type="button" className="academic-primary" onClick={merge}>保存合并内容</button></>:<button type="button" className="academic-primary" disabled={saving} onClick={()=>void flush()}>重试保存</button>}</div>}
  {draftWarning&&<div className="research-notes-warning" role="status">{draftWarning}{damagedDraft!==undefined&&<button type="button" className="academic-secondary" onClick={()=>downloadText('window-draft-recovery.json',damagedDraft)}>下载原始窗口草稿</button>}</div>}
  <div className="research-notes-editor">
   <ResearchTextEditor autoFocus={!initial.legacy&&!initial.content} aria-label={editorLabel} readOnly={readOnly} spellCheck={false} maxLength={100000} value={content} onChange={edit} placeholder="直接开始记录…"/>
  </div>
  {conflict&&<details className="research-notes-conflict" open><summary>磁盘当前内容 · {prettyDate(conflict.updatedAt)}</summary><div className="research-note-markdown"><AiMarkdown text={conflict.content||'（空记录）'}/></div></details>}
  <footer className="research-notes-footer"><span>{content.length.toLocaleString()} 字符 · Markdown</span><span title={base.path||undefined}>{base.filename||'原有汇总记录'} · {dirty?'待保存':prettyDate(base.updatedAt)}</span></footer>
 </>;
}
