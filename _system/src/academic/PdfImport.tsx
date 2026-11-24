import {useCallback,useEffect,useRef,useState} from 'react';
import {FileUp,LoaderCircle,Upload} from 'lucide-react';
import type {PdfImportResult,PdfImportTarget} from '../../shared/workspace-types';
import {api} from '../api';
import './pdf-import.css';

const targetKey=(target?:PdfImportTarget)=>JSON.stringify([target?.topicId||'',target?.rootId||'',target?.directory||'']);
interface PdfImportOptions {
 target?:PdfImportTarget;
 destination:string;
 blocked?:string;
 onImported:(results:PdfImportResult[])=>Promise<void>;
}

/** Both entry points use the same serial batch and content-addressed server import. */
export function usePdfImport(options:PdfImportOptions){
 const latest=useRef(options);latest.current=options;
 const picker=useRef<HTMLInputElement>(null),alive=useRef(true),busyRef=useRef(false),depth=useRef(0);
 const inFlight=useRef<Promise<void>|undefined>(undefined);
 const [busy,setBusy]=useState(false),[drag,setDrag]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const [failures,setFailures]=useState<string[]>([]),[retry,setRetry]=useState<{files:File[];key:string;destination:string}>();
 const [batchDestination,setBatchDestination]=useState(''),[reusedLocations,setReusedLocations]=useState<string[]>([]);
 const scope=targetKey(options.target);
 useEffect(()=>{setError('');},[scope]);
 const waitForIdle=useCallback(async()=>{await inFlight.current;return true;},[]);
 useEffect(()=>{
  alive.current=true;
  const reset=()=>{depth.current=0;setDrag(false);};
  const fileDrag=(event:DragEvent)=>!!event.dataTransfer&&Array.from(event.dataTransfer.types).includes('Files');
  const enter=(event:DragEvent)=>{if(fileDrag(event)){event.preventDefault();depth.current++;setDrag(true);}};
  const over=(event:DragEvent)=>{if(fileDrag(event)){event.preventDefault();event.dataTransfer!.dropEffect='copy';}};
  const leave=(event:DragEvent)=>{if(fileDrag(event)){depth.current=Math.max(0,depth.current-1);if(!depth.current)setDrag(false);}};
  const drop=(event:DragEvent)=>{
   reset();if(!event.dataTransfer?.files.length)return;
   event.preventDefault();void upload(Array.from(event.dataTransfer.files));
  };
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape')reset();};
  const unload=(event:BeforeUnloadEvent)=>{if(busyRef.current){event.preventDefault();event.returnValue='';}};
  window.addEventListener('dragenter',enter);window.addEventListener('dragover',over);window.addEventListener('dragleave',leave);window.addEventListener('drop',drop);window.addEventListener('dragend',reset);window.addEventListener('keydown',key);window.addEventListener('beforeunload',unload);
  return()=>{alive.current=false;window.removeEventListener('dragenter',enter);window.removeEventListener('dragover',over);window.removeEventListener('dragleave',leave);window.removeEventListener('drop',drop);window.removeEventListener('dragend',reset);window.removeEventListener('keydown',key);window.removeEventListener('beforeunload',unload);};
 },[]);
 async function upload(files:File[]){
  if(!files.length)return;
  const {target,destination,blocked,onImported}=latest.current;
  if(busyRef.current){setError('正在导入当前批次，请完成后继续添加 PDF。');return;}
  if(!target||blocked){setError(blocked||'先进入一个课题，再将 PDF 拖入本页。');return;}
  busyRef.current=true;setBusy(true);setError('');setFailures([]);setRetry(undefined);setReusedLocations([]);setBatchDestination(destination);
  const work=async()=>{
   const current={...target},results:PdfImportResult[]=[],failures:string[]=[],remaining:File[]=[];
   let added=0,reused=0,linked=0;
   try{
    for(const [index,file] of files.entries()){
     if(alive.current)setMessage(`正在核对 ${index+1}/${files.length} 篇 · ${file.name}`);
     if(!/\.pdf$/i.test(file.name)){failures.push(`${file.name}：请选择 PDF 文件。`);continue;}
     if(file.size>50*1024*1024){failures.push(`${file.name}：文件超过 50 MB。`);continue;}
     const params=new URLSearchParams({expectedHash:'null'});
     if(current.topicId){params.set('topicId',current.topicId);params.set('expectedRevision',String(current.expectedRevision));}
     if(current.rootId){params.set('rootId',current.rootId);if(current.directory)params.set('directory',current.directory);}
     const body=new FormData();body.append('file',file);
     try{
      const result=await api<PdfImportResult>(`/api/workspace/resources/upload?${params}`,{method:'POST',body});
      results.push(result);
      if(result.topic)current.expectedRevision=result.topic.revision;
      if(result.alreadyLinked)linked++;else if(result.reused)reused++;else added++;
     }catch(failure:any){
      failures.push(`${file.name}：${failure.message}`);
      if(![400,413,415,422].includes(failure.status)){remaining.push(...files.slice(index));break;}
     }
    }
   }finally{
    if(alive.current){
     setMessage(`新增 ${added} 篇 · 复用已有 ${reused} 篇${target.topicId?` · 本课题已收录 ${linked} 篇`:""}${remaining.length?` · ${remaining.length} 篇待重试`:''}`);
     setFailures(failures);setRetry(remaining.length?{files:remaining,key:targetKey(target),destination}:undefined);
     setReusedLocations([...new Set(results.filter(result=>result.reused).map(result=>result.root.label))]);
     try{await onImported(results);}catch(failure:any){if(alive.current)setError(`导入结果已保留，列表刷新失败。${failure.message}`);}
    }
   }
  };
  const promise=work().finally(()=>{busyRef.current=false;inFlight.current=undefined;if(alive.current)setBusy(false);});
  inFlight.current=promise;await promise;
 }
 return {picker,busy,drag,message,error,failures,retry,reusedLocations,upload,waitForIdle,resultDestination:batchDestination,destination:busy?batchDestination:options.destination,blocked:options.blocked,canRetry:!!retry&&retry.key===targetKey(options.target)};
}
export type PdfImporter=ReturnType<typeof usePdfImport>;

export function PdfImportButton({importer,primary=false}:{importer:PdfImporter;primary?:boolean}){
 return <><button type="button" className={primary?'academic-primary':'academic-secondary'} disabled={importer.busy||!!importer.blocked} title={importer.blocked||`归档到 ${importer.destination}`} onClick={()=>importer.picker.current?.click()}>{importer.busy?<LoaderCircle size={14} className="spin"/>:<Upload size={14}/>}<span>{importer.busy?'正在导入…':'添加 PDF'}</span></button><input ref={importer.picker} type="file" multiple accept="application/pdf,.pdf" hidden onChange={event=>{void importer.upload(Array.from(event.target.files||[]));event.target.value='';}}/></>;
}
export function PdfImportFeedback({importer,showDestination=true}:{importer:PdfImporter;showDestination?:boolean}){
 if(!showDestination&&!importer.message&&!importer.reusedLocations.length&&!importer.error&&!importer.failures.length)return null;
 return <div className="pdf-import-feedback">
  {showDestination&&<p className="pdf-import-destination">{importer.blocked||`可拖入 PDF · 归档到 ${importer.destination}`}</p>}
  {importer.message&&<p role="status"><span>{importer.message}</span>{importer.resultDestination!==importer.destination&&<small> · {importer.resultDestination}</small>}</p>}
  {importer.reusedLocations.length>0&&<p>已有文献位置 · {importer.reusedLocations.join('、')}</p>}
  {importer.error&&<p role="alert" className="pdf-import-error">{importer.error}</p>}
  {importer.failures.length>0&&<div role="alert" className="pdf-import-error"><ul>{importer.failures.map((failure,index)=><li key={index}>{failure}</li>)}</ul>{importer.retry&&<><button type="button" className="academic-secondary" disabled={importer.busy||!importer.canRetry} onClick={()=>void importer.upload(importer.retry!.files)}>重试未完成（{importer.retry.files.length}）</button>{!importer.canRetry&&<p>切回 {importer.retry.destination} 后可重试这批文件。</p>}</>}</div>}
 </div>;
}
export function PdfImportOverlay({importer}:{importer:PdfImporter}){
 if(!importer.drag)return null;
 return <div className="pdf-import-overlay"><FileUp size={30}/><strong>{importer.blocked||`松开以导入 ${importer.destination}`}</strong><small>支持多篇 PDF，每篇最多 50 MB · 复用已有文献和翻译缓存</small></div>;
}
