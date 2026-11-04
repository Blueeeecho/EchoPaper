import { useCallback, useEffect, useRef, useState } from 'react';
import type { PersistedChat } from '../shared/chat-merge';
import { mergeConversationSelection } from './agentConversation';
import { api, ApiError, json } from './api';
interface RemoteChats {data:PersistedChat|null;hash:string|null}
export function useProjectChats(projectId:string, read:()=>PersistedChat, apply:(data:PersistedChat)=>void, preferredSelection?:()=>string|undefined) {
 const [warning,setWarning]=useState(''),[ready,setReady]=useState(false);
 const [changingId,setChangingId]=useState('');
 const latest=useRef({read,apply,preferredSelection});latest.current={read,apply,preferredSelection};
 const baseline=useRef<PersistedChat|null>(null);
 const hash=useRef<string|null>(null),loaded=useRef(false),pending=useRef(false),running=useRef<Promise<void>|null>(null),timer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
 const mounted=useRef(true);const url=`/api/projects/${encodeURIComponent(projectId)}/chats`;
 const mutating=useRef(false),refreshPending=useRef(false),readGeneration=useRef(0),receiveRef=useRef<()=>Promise<void>>(async()=>{});
 const flush=useCallback(async():Promise<void>=>{
  clearTimeout(timer.current); timer.current=undefined;
  if(!loaded.current)throw Error('对话还在载入本机存储，请稍后重试。');
  if(mutating.current)throw Error('正在更新对话历史，请稍后重试。');
  if(running.current){await running.current;if(pending.current)return flush();return;}
  if(!pending.current)return;
  const work=(async()=>{let retries=0;
   while(pending.current){pending.current=false;const snapshot=latest.current.read();readGeneration.current++;
    try{const saved=await api<RemoteChats>(url,json('PUT',{data:snapshot,expectedHash:hash.current}));hash.current=saved.hash;latest.current.apply(mergeConversationSelection(saved.data,latest.current.read(),latest.current.preferredSelection?.(),snapshot));baseline.current=saved.data;if(mounted.current)setWarning('');}
    catch(e:any){pending.current=true;if(e instanceof ApiError&&e.status===409&&e.data.current&&retries++<2){const remote=e.data.current as RemoteChats;hash.current=remote.hash;latest.current.apply(mergeConversationSelection(remote.data,latest.current.read(),latest.current.preferredSelection?.(),baseline.current));baseline.current=remote.data;continue;}if(mounted.current)setWarning(`对话仍保留在浏览器，但尚未保存到本机：${e.message}`);throw e;}
   }
  })();running.current=work;try{await work;}finally{running.current=null;if(refreshPending.current)void receiveRef.current();}
 },[url]);
 const queue=useCallback(()=>{pending.current=true;if(!loaded.current||timer.current)return;timer.current=setTimeout(()=>{timer.current=undefined;void flush().catch(()=>{});},750);},[flush]);
 const changeLifecycle=useCallback(async(conversationId:string,action:'archive'|'delete'|'restore')=>{
  if(mutating.current)throw Error('正在更新对话历史，请稍后重试。');
  await flush();
  if(mutating.current)throw Error('正在更新对话历史，请稍后重试。');
  mutating.current=true;setChangingId(conversationId);
  readGeneration.current++;
  try{
   const saved=await api<RemoteChats>(`${url}/${encodeURIComponent(conversationId)}`,json('PATCH',{action,expectedHash:hash.current}));
   hash.current=saved.hash;
   const merged=mergeConversationSelection(saved.data,latest.current.read(),latest.current.preferredSelection?.(),baseline.current);baseline.current=saved.data;latest.current.apply(merged);
   if(JSON.stringify(merged)!==JSON.stringify(saved.data))pending.current=true;
   if(mounted.current)setWarning('');
  }catch(error){
   if(error instanceof ApiError&&error.status===409&&error.data.current){const remote=error.data.current as RemoteChats;hash.current=remote.hash;latest.current.apply(mergeConversationSelection(remote.data,latest.current.read(),latest.current.preferredSelection?.(),baseline.current));baseline.current=remote.data;}
   throw error;
  }finally{mutating.current=false;if(mounted.current)setChangingId('');if(pending.current)queue();if(refreshPending.current)void receiveRef.current();}
 },[url,flush,queue]);
 useEffect(()=>{
  mounted.current=true;let active=true;
  const receive=async(initial=false)=>{if(running.current||mutating.current){refreshPending.current=true;return;}refreshPending.current=false;const generation=++readGeneration.current;try{const remote=await api<RemoteChats>(url);if(!active||generation!==readGeneration.current)return;if(running.current||mutating.current){refreshPending.current=true;return;}if(!initial&&remote.hash===hash.current)return;hash.current=remote.hash;
   const merged=mergeConversationSelection(remote.data,latest.current.read(),latest.current.preferredSelection?.(),baseline.current);baseline.current=remote.data;latest.current.apply(merged);loaded.current=true;setReady(true);
   if(JSON.stringify(merged)!==JSON.stringify(remote.data)||pending.current){pending.current=true;await flush();}
  }catch(e:any){if(active)setWarning(`本机对话存储暂不可用，浏览器草稿仍保留：${e.message}`);}};
  receiveRef.current=receive;
  void receive(true);
  const events=new EventSource('/api/events');events.onmessage=e=>{try{const event=JSON.parse(e.data);if(event.projectId===projectId&&event.type==='file.changed'&&event.path==='notes/ai-conversations.json')void receive();}catch{}};
  events.onopen=()=>{if(loaded.current)void receive();};
  return()=>{active=false;mounted.current=false;events.close();clearTimeout(timer.current);timer.current=undefined;};
 },[projectId,url,flush]);
 return{queue,flush,warning,ready,changeLifecycle,changingId};
}
