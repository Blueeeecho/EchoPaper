import {useEffect,useMemo,useRef,useState} from 'react';
import {BookOpenText,FileText,Folder,FolderOpen,LoaderCircle,MoreHorizontal,NotebookPen,Search,Sparkles,Star} from 'lucide-react';
import type {CSSProperties} from 'react';
import {ProcessingBadge,readingStatusText,type ReadingProcessing} from './ReadingProcessing';
import {resourceGroup} from '../../shared/resource-kind';
import type {Resource,ResourcePage} from '../../shared/workspace-types';
import {api} from '../api';
import {compareResourceNames,paperTitle,uniquePaperResources} from '../../shared/resource-order';
import SearchExcerpt from './SearchExcerpt';
/** Full, searchable reference list. Clicking a paper opens it in the in-app reader. */
// Notes are sorted newest first and tagged by what they are, so summaries and our own notes are easy to tell apart.
const noteKind=(name:string)=>resourceGroup(name)==='summary'?'整理报告':/\.bib$/i.test(name)?'参考文献库':/\.(json|csv|tsv|ya?ml)$/i.test(name)?'数据':'笔记';
export interface ReferenceListSearch {value:string;onChange:(value:string)=>void;loading:boolean;total:number;offset?:number}
export interface ReferenceListProps {processing?:ReadingProcessing;files:Resource[];onOpen?:(file:Resource)=>void;variant?:'papers'|'notes'|'files';starred?:Set<string>;onToggleStar?:(file:Resource)=>void;starDisabled?:boolean;topicId?:string;search?:ReferenceListSearch;onDetails?:(file:Resource)=>void;selectedId?:string}
export default function ReferenceList({files,onOpen,variant='papers',starred,onToggleStar,starDisabled,processing,topicId,search,onDetails,selectedId}:ReferenceListProps){
 const [localQuery,setQuery]=useState('');
 const query=search?.value??localQuery;
 const [searchResult,setSearchResult]=useState<{key:string;resources:Resource[];error?:string}>();
 const [searching,setSearching]=useState(false),[retry,setRetry]=useState(0);
 const request=useRef(0);
 const keywords=query.trim().replace(/\s+/g,' ');
 const remoteSearch=!search&&!!topicId&&!!keywords;
 const fileScope=files.map(file=>`${file.id}:${file.revision}`).sort().join(',');
 const searchKey=JSON.stringify([topicId,variant,keywords,fileScope]);
 const cacheProgress=files.map(file=>{
  const status=processing?.snapshot?.statuses[file.id];
  return status?`${file.id}:${status.stage}:${status.pageCount}:${status.done}`:'';
 }).filter(Boolean).sort().join(',');
 useEffect(()=>{
  const generation=++request.current;
  if(search||!topicId||!keywords){setSearchResult(undefined);setSearching(false);return;}
  const controller=new AbortController();
  setSearching(true);
  const timer=setTimeout(()=>{
   const params=new URLSearchParams({q:keywords,topicId,limit:'1000',deduplicate:'true',starredFirst:'true'});
   if(variant==='papers')params.set('group','paper');
   void api<ResourcePage>(`/api/workspace/resources?${params}`,{signal:controller.signal,timeoutMs:30000})
    .then(result=>{if(generation===request.current&&!controller.signal.aborted)setSearchResult({key:searchKey,resources:result.resources});})
    .catch((error:Error)=>{if(generation===request.current&&!controller.signal.aborted)setSearchResult({key:searchKey,resources:[],error:error.message});})
    .finally(()=>{if(generation===request.current&&!controller.signal.aborted)setSearching(false);});
  },180);
  return()=>{request.current++;clearTimeout(timer);controller.abort();};
 },[topicId,keywords,variant,searchKey,cacheProgress,retry,!!search]);
 const currentResult=searchResult?.key===searchKey?searchResult:undefined;
 const waiting=search?search.loading:remoteSearch&&(searching||!currentResult);
 const filtered=useMemo(()=>{
  const ids=new Set(files.map(file=>file.id));
  const terms=keywords.toLocaleLowerCase().split(' ').filter(Boolean);
  const candidates=search?files:remoteSearch?(currentResult?.resources||[]).filter(file=>ids.has(file.id)):files.filter(file=>terms.every(term=>[file.title??'',file.name,file.path,...file.tags].some(value=>value.toLocaleLowerCase().includes(term))));
  return uniquePaperResources(candidates,starred)
   .sort((first,second)=>{
    if(variant==='notes')return second.modifiedAt.localeCompare(first.modifiedAt);
    if(variant==='files')return compareResourceNames(first,second);
    const priority=Number(!!starred?.has(second.id))-Number(!!starred?.has(first.id));
    return priority||compareResourceNames(first,second);
   });
 },[files,keywords,remoteSearch,currentResult,variant,starred,!!search]);
 return <div className="reference-list">
  <label className="reference-search"><Search size={14}/><input aria-label={search?'搜索资料':'筛选已存文献'} placeholder={variant==='notes'?`搜索 ${search?.total??files.length} 份笔记与整理的名称、内容…`:variant==='files'?`搜索 ${search?.total??files.length} 份资料的名称、正文、译文…`:`搜索 ${search?.total??files.length} 篇文献的标题、原文、译文…`} value={query} onChange={e=>(search?.onChange??setQuery)(e.target.value)}/>{keywords&&(waiting?<LoaderCircle size={13} className="spin" aria-label="正在搜索"/>:!currentResult?.error&&<small>{search?.total??filtered.length} {variant==='papers'?'篇':'项'}</small>)}</label>
  <ol className="reference-rows" aria-busy={waiting}>{filtered.map((f,index)=>{const number=variant==='papers'?String((search?.offset??0)+index+1):undefined;const status=processing?.snapshot?.statuses[f.id];const title=paperTitle(f);const version=f.name.match(/\d{4}\.\d{4,5}v\d+/)?.[0];const isStarred=!!starred?.has(f.id);const match=keywords?f.searchMatch:undefined;const starAction=isStarred?'移出重点文献':'设为重点文献';return <li key={f.id} className={[isStarred?'starred':'',match?'has-search-excerpt':'',selectedId===f.id?'is-selected':''].filter(Boolean).join(' ')}>
   {onToggleStar&&<button className="reference-star" disabled={starDisabled} aria-pressed={isStarred} aria-label={`${starAction} ${title}`} title={starAction} onClick={()=>onToggleStar(f)}><Star size={14}/></button>}
   <button disabled={f.missing} onClick={()=>onOpen?onOpen(f):window.open(`/api/workspace/resources/${f.id}/raw`,'_blank','noopener')} title={f.missing?'原文件已失联':`${variant==='files'?'打开':'阅读'}：${f.title||f.name}`}>
    <span className={`reference-number ${status?.stage==='complete'?'is-cached':status?`is-${status.stage}`:''}`} title={status?readingStatusText(status,processing?.snapshot?.settings.enabled):undefined} aria-label={status?`${number||'文献'}，${readingStatusText(status,processing?.snapshot?.settings.enabled)}`:undefined} style={{'--cache-progress':`${status?.total?status.done/status.total*100:0}%`} as CSSProperties}>{f.kind==='directory'?<Folder size={14}/>:variant==='notes'?(noteKind(f.name)==='整理报告'?<Sparkles size={14}/>:<NotebookPen size={14}/>):number||<FileText size={14}/>}</span>
    <span className="reference-title"><span className="reference-name">{variant==='papers'?title:f.title||f.name}</span>{variant==='notes'&&<small>{noteKind(f.name)} · {f.modifiedAt.slice(0,10)}</small>}{!f.title&&/\.pdf$/i.test(f.name)&&<small>论文标题待核对</small>}{f.title&&version&&<small>arXiv {version}</small>}{variant==='papers'&&status&&<ProcessingBadge status={status} enabled={processing?.snapshot?.settings.enabled}/>} {f.tags.length>0&&<small>{f.tags.join(' · ')}</small>}{match&&<SearchExcerpt match={match}/>}</span>
    <span className="reference-open">{f.missing?'失联':variant==='files'?<><FolderOpen size={14}/>打开</>:<><BookOpenText size={14}/>阅读</>}</span>
   </button>{status?.stage==='failed'&&<button className="reference-retry" disabled={processing?.busy||!processing?.snapshot?.settings.enabled} title={status.error} onClick={()=>void processing?.enqueue([f.id])}>重试</button>}{onDetails&&<button className="reference-details" aria-label={`查看 ${f.title||f.name}`} title="详情、标签与课题关联" onClick={()=>onDetails(f)}><MoreHorizontal size={15}/></button>}</li>;})}</ol>
  {waiting&&!filtered.length&&<p className="reference-search-status" role="status">{keywords?'正在搜索本地原文与译文…':'正在读取资料…'}</p>}
  {remoteSearch&&currentResult?.error&&<p className="reference-search-status" role="alert">搜索失败，{currentResult.error}<button onClick={()=>setRetry(value=>value+1)}>重试</button></p>}
  {!filtered.length&&!waiting&&!currentResult?.error&&<p className="reference-empty">{variant==='notes'?'没有匹配的笔记与整理。':variant==='files'?'没有匹配的资料。':'没有匹配的文献。'}</p>}
 </div>;
}
