import { mergeChats, type PersistedChat } from '../shared/chat-merge';
import { api, ApiError, json } from './api';
/** True when the merge carries user data the server file lacks (not only run status/version metadata). */
export function addsBrowserData(remote:PersistedChat|null,merged:PersistedChat):boolean{
  if(!remote)return true;
  const saved=new Map(remote.conversations.map(c=>[c.id,c]));
  return merged.conversations.some(c=>{const old=saved.get(c.id);if(!old)return true;
    if((c.input||'')!==(old.input||'')||JSON.stringify(c.pendingAttachments||[])!==JSON.stringify(old.pendingAttachments||[]))return true;
    const messages=new Map(old.messages.map(m=>[m.id,m]));
    return c.messages.some(m=>{const before=messages.get(m.id);return !before||before.content!==m.content||JSON.stringify(before.attachments||[])!==JSON.stringify(m.attachments||[]);});});
}
export async function migrateBrowserChats(projectIds: readonly string[]) {
  for (const projectId of projectIds) {
    const key=`echopaper:ai:${projectId}:v1`, raw=localStorage.getItem(key);
    if(!raw)continue;
    const parse=(text:string):PersistedChat=>{try{return JSON.parse(text);}catch{throw Error(`${projectId} 的浏览器对话格式有误，原数据仍保留。`);}};
    let local:PersistedChat=parse(raw);
    if(local?.version!==1||!Array.isArray(local.conversations)||!local.conversations.length)continue;
    const url=`/api/projects/${encodeURIComponent(projectId)}/chats`;
    let remote=await api<{data:PersistedChat|null;hash:string|null}>(url);
    for(let retry=0;;retry++){
      // Another window can edit the browser cache while either request is in flight.
      // Re-read before merging, and never replace a cache that changed during PUT.
      const browserRaw=localStorage.getItem(key);
      if(browserRaw)local=mergeChats(local,parse(browserRaw));
      const merged=mergeChats(remote.data,local);
      // Opening the app must not rewrite the file: only browser-only conversations,
      // messages, text or drafts are migrated. Run metadata is rebuilt in memory.
      if(JSON.stringify(merged)===JSON.stringify(remote.data)||!addsBrowserData(remote.data,merged)){if(JSON.stringify(merged)===JSON.stringify(remote.data))localStorage.setItem(key,JSON.stringify(merged));break;}
      try{const saved=await api<{data:PersistedChat;hash:string}>(url,json('PUT',{data:merged,expectedHash:remote.hash}));
        if(localStorage.getItem(key)!==browserRaw){remote=saved;local=merged;if(retry<7)continue;throw Error(`${projectId} 的对话仍在其他窗口变化，已保留浏览器草稿，请稍后重试迁移。`);}
        localStorage.setItem(key,JSON.stringify(saved.data));break;}
      catch(e){if(e instanceof ApiError&&e.status===409&&e.data.current&&retry<7){remote=e.data.current;continue;}throw e;}
    }
  }
}
