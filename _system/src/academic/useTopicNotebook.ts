import {useCallback,useEffect,useRef,useState} from 'react';
import {emptyTopicNotebook,type TopicNotebook} from '../../shared/topic-notebook';
import {api,json} from '../api';

/** Load and save one topic's ideas and key references; saves are hash-checked, a conflict reloads and keeps nothing silently. */
export function useTopicNotebook(topicId:string,onError:(message:string)=>void){
 const [notebook,setNotebook]=useState<TopicNotebook>(()=>emptyTopicNotebook(topicId)),[loaded,setLoaded]=useState(false),[saving,setSaving]=useState(false);
 const hashRef=useRef<string|null>(null),queue=useRef(Promise.resolve()),current=useRef(notebook),readRequest=useRef(0);current.current=notebook;
 const load=useCallback(async()=>{const sequence=++readRequest.current;const v=await api<{notebook:TopicNotebook;hash:string|null}>(`/api/workspace/topics/${encodeURIComponent(topicId)}/notebook`);if(sequence!==readRequest.current)return;hashRef.current=v.hash;setNotebook(v.notebook);current.current=v.notebook;setLoaded(true);},[topicId]);
 useEffect(()=>{setLoaded(false);setNotebook(emptyTopicNotebook(topicId));void load().catch(e=>{setLoaded(true);onError(e.message);});return()=>{readRequest.current++;};},[topicId]);
 const update=useCallback((change:(n:TopicNotebook)=>TopicNotebook)=>{readRequest.current++;const next=change(current.current);current.current=next;setNotebook(next);
  const saved=queue.current.then(async()=>{setSaving(true);try{const v=await api<{notebook:TopicNotebook;hash:string|null}>(`/api/workspace/topics/${encodeURIComponent(topicId)}/notebook`,json('PUT',{notebook:current.current,expectedHash:hashRef.current}));hashRef.current=v.hash;return true;}catch(e:any){onError(e.status===409?'课题笔记已在其他窗口修改，已载入最新版本，请重新输入刚才的修改。':e.message);await load().catch(()=>{});return false;}finally{setSaving(false);}});
  queue.current=saved.then(()=>{});return saved;
 },[topicId,load,onError]);
 return {notebook,loaded,saving,update,refresh:load};
}
