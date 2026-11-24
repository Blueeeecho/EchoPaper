import {useCallback,useEffect,useRef,useState} from 'react';
import {emptyTopicNotebook,type TopicNotebook} from '../../shared/topic-notebook';
import {ApiError,api,json} from '../api';

/** Saves use a loaded baseline and invalidate reads started before the edit. */
export function useTopicNotebook(topicId:string,onError:(message:string)=>void){
 const [notebook,setNotebook]=useState<TopicNotebook>(()=>emptyTopicNotebook(topicId)),[loaded,setLoaded]=useState(false),[saving,setSaving]=useState(false);
 const [loadFailed,setLoadFailed]=useState(false);
 const hashRef=useRef<string|null|undefined>(undefined),current=useRef(notebook),readRequest=useRef(0),writeInFlight=useRef(false);
 const endpoint=`/api/workspace/topics/${encodeURIComponent(topicId)}/notebook`;
 const load=useCallback(async()=>{
  if(writeInFlight.current)return;
  const sequence=++readRequest.current;
  try{
   const value=await api<{notebook:TopicNotebook;hash:string|null}>(endpoint,{timeoutMs:15000});
   if(sequence!==readRequest.current)return;
   hashRef.current=value.hash;
   current.current=value.notebook;
   setNotebook(value.notebook);
   setLoaded(true);
   setLoadFailed(false);
  }catch(error){
   if(sequence===readRequest.current)setLoadFailed(true);
   throw error;
  }
 },[endpoint]);
 useEffect(()=>{
  let active=true;
  const empty=emptyTopicNotebook(topicId);
  hashRef.current=undefined;
  current.current=empty;
  setLoaded(false);
  setLoadFailed(false);
  setNotebook(empty);
  void load().catch((error:Error)=>{if(active)onError(error.message);});
  return()=>{active=false;readRequest.current++;};
 },[topicId,load,onError]);
 const update=useCallback(async(change:(n:TopicNotebook)=>TopicNotebook)=>{
  const expectedHash=hashRef.current,previous=current.current;
  if(expectedHash===undefined||writeInFlight.current||previous.topicId!==topicId)return false;
  const next=change(previous),sequence=++readRequest.current;
  writeInFlight.current=true;
  setSaving(true);
  current.current=next;
  setNotebook(next);
  let reload=false;
  try{
   const value=await api<{notebook:TopicNotebook;hash:string|null}>(endpoint,{...json('PUT',{notebook:next,expectedHash}),timeoutMs:15000});
   if(sequence!==readRequest.current)return false;
   hashRef.current=value.hash;
   current.current=value.notebook;
   setNotebook(value.notebook);
   return true;
  }catch(error){
   if(sequence!==readRequest.current)return false;
   current.current=previous;
   setNotebook(previous);
   reload=error instanceof ApiError&&(error.status===409||error.status===408);
   if(reload){
    hashRef.current=undefined;
    setLoaded(false);
   }
   onError(error instanceof ApiError&&error.status===409?'重点文献记录在其他窗口发生变化，请核对后重新标记。':error instanceof Error?error.message:'重点文献标记保存失败。');
  }finally{
   writeInFlight.current=false;
   setSaving(false);
  }
  if(reload)await load().catch(()=>{});
  return false;
 },[topicId,endpoint,load,onError]);
 return {notebook,loaded,saving,loadFailed,update,refresh:load};
}
