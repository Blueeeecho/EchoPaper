import type {ContextCheckpoint,ContextUsage} from './ai-context';
import type {AgentAttachment} from './attachment-types';
export interface PersistedMessage { id:string;role:'user'|'assistant';content:string;status:'complete'|'streaming'|'stopped'|'error';createdAt:string;attachments?:AgentAttachment[];[key:string]:any }
export type ConversationState = 'active' | 'archived' | 'deleted';
export interface ChatLifecycle {state:ConversationState;revision:number;updatedAt:string}
export interface PersistedConversation { id:string;title:string;createdAt:string;updatedAt:string;messages:PersistedMessage[];input:string;model:string;effort:any;pendingAttachments?:AgentAttachment[]; contextState?:ContextCheckpoint;contextUsage?:ContextUsage;lifecycle?:ChatLifecycle }
export interface PersistedChat {version:1;selectedId:string;conversations:PersistedConversation[]}
export const conversationState = (conversation: Pick<PersistedConversation, 'lifecycle'>): ConversationState => conversation.lifecycle?.state ?? 'active';

/** Recursively sort object keys (array order is kept) so equality is not key-order sensitive. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalValue(record[key])]));
  }
  return value;
}
export function chatsEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** A hidden conversation never remains the writable selection, including after remote changes. */
export function ensureActiveChat(data: PersistedChat): PersistedChat {
 const selected = data.conversations.find(conversation => conversation.id === data.selectedId);
 if (selected && conversationState(selected) === 'active') return data;
 const active = data.conversations.find(conversation => conversationState(conversation) === 'active');
 if (active) return { ...data, selectedId: active.id };
 const now = new Date().toISOString(), source = selected || data.conversations[0];
 const fresh: PersistedConversation = { id: crypto.randomUUID(), title: '新对话', createdAt: now, updatedAt: now, messages: [], input: '', model: source?.model || '', effort: source?.effort || 'medium' };
 return { ...data, selectedId: fresh.id, conversations: [fresh, ...data.conversations] };
}
const suffix=(text:string)=>{let n=2166136261;for(let i=0;i<text.length;i++)n=Math.imul(n^text.charCodeAt(i),16777619);return(n>>>0).toString(16);};
const meaningful=(c:PersistedConversation)=>c.messages.length>0||!!c.input.trim()||!!c.pendingAttachments?.length;
function mergedMessage(local:PersistedMessage,remote:PersistedMessage):PersistedMessage{const selected=local.status==='complete'||remote.status!=='complete'?local:remote;const attachments=[...new Map([...(remote.attachments||[]),...(local.attachments||[])].map(attachment=>[attachment.id,attachment])).values()];return attachments.length?{...selected,attachments}:selected;}
/** One stable identity per run/role. Preserve genuinely divergent completed
 * text as an independent recovered message, never as a resurrectable task slot. */
export function mergeTaskMessages(messages:PersistedMessage[]):PersistedMessage[]{
 const groups=new Map<string,PersistedMessage[]>();for(const m of messages)if(m.taskId){const key=m.taskId+':'+m.role;groups.set(key,[...(groups.get(key)||[]),m]);}
 const chosen=new Map<string,PersistedMessage>(),recovered:PersistedMessage[]=[];
 const rank=(m:PersistedMessage)=>[Number(m.taskVersion)||0,m.taskTerminal===true?1:0,m.status==='complete'?3:m.status==='streaming'?0:1,m.id.startsWith('agent-')?0:1];
 for(const [key,items]of groups){
  const sorted=[...items].sort((a,b)=>{const left=rank(a),right=rank(b);for(let i=0;i<left.length;i++)if(left[i]!==right[i])return right[i]-left[i];if(a.content.startsWith(b.content)||b.content.startsWith(a.content)){if(a.content.length!==b.content.length)return b.content.length-a.content.length;}return a.id.localeCompare(b.id);});
  const best=sorted[0],attachments=[...new Map(items.flatMap(m=>m.attachments||[]).map(a=>[a.id,a])).values()].sort((a,b)=>a.id.localeCompare(b.id));chosen.set(key,attachments.length?{...best,attachments}:best);
  for(const m of sorted.slice(1))if(m.status==='complete'&&best.status==='complete'&&m.content&&best.content&&!m.content.startsWith(best.content)&&!best.content.startsWith(m.content)){
   const {taskId:_taskId,taskVersion:_version,taskTerminal:_terminal,...fields}=m;
   recovered.push({...fields,id:`task-conflict-${suffix(key+'\0'+m.content)}`,status:'complete'});
  }
 }
 const emitted=new Set<string>(),output:PersistedMessage[]=[];
 for(const m of messages){if(!m.taskId){output.push(m);continue;}const key=m.taskId+':'+m.role;if(!emitted.has(key)){emitted.add(key);output.push(chosen.get(key)!);}}
 const existing=new Set(output.map(m=>m.id));for(const m of recovered)if(!existing.has(m.id)){existing.add(m.id);output.push(m);}
 return output.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
}
const sameMessage=(a:PersistedMessage,b:PersistedMessage)=>a.id===b.id||!!a.taskId&&a.taskId===b.taskId&&a.role===b.role;
function mergeAttachmentDraft(remote:PersistedConversation,local:PersistedConversation,base:PersistedConversation|undefined,messages:PersistedMessage[]):AgentAttachment[]{const old=new Set((base?.pendingAttachments||[]).map(a=>a.id)),left=new Map((local.pendingAttachments||[]).map(a=>[a.id,a])),right=new Map((remote.pendingAttachments||[]).map(a=>[a.id,a]));const consumed=new Set(messages.filter(message=>message.role==='user'&&!!message.taskId&&!base?.messages.some(before=>sameMessage(before,message))).flatMap(message=>(message.attachments||[]).map(attachment=>attachment.id)));return [...new Set([...left.keys(),...right.keys()])].filter(id=>!consumed.has(id)&&(base?(left.has(id)===old.has(id)?right.has(id):left.has(id)):left.has(id)||right.has(id))).map(id=>left.get(id)||right.get(id)!);}
/** Union histories; preserve divergent text/drafts as explicit recovered entries. */
export function mergeChats(remote:PersistedChat|null,local:PersistedChat,baseline?:PersistedChat|null):PersistedChat {
 if(!remote)return ensureActiveChat(local);
 const localHas=local.conversations.some(c=>conversationState(c)==='active'&&meaningful(c)),localConversations=localHas?local.conversations:local.conversations.filter(c=>c.lifecycle||remote.conversations.some(r=>r.id===c.id));
 const result=new Map(remote.conversations.map(c=>[c.id,structuredClone(c)]));
 for(const c of localConversations){const old=result.get(c.id);if(!old){result.set(c.id,c);continue;}
  const base=baseline?.conversations.find(item=>item.id===c.id),remoteDraftChanged=!base||old.input!==base.input,localDraftChanged=!base||c.input!==base.input;
  const messages=new Map(old.messages.map(m=>[m.id,m]));
  for(const m of c.messages){const other=messages.get(m.id);if(!other){messages.set(m.id,m);continue;}
   if(m.taskId&&m.taskId===other.taskId&&m.role===other.role){for(const merged of mergeTaskMessages([other,m]))messages.set(merged.id,merged);continue;}
   if(other.content===m.content){messages.set(m.id,mergedMessage(m,other));continue;}
   if(m.content.startsWith(other.content)){messages.set(m.id,m);continue;}
   if(other.content.startsWith(m.content))continue;
   messages.set(m.id,m);const id=`${m.id.slice(0,65)}-recovered-${suffix(other.content)}`;
   messages.set(id,{...other,id,status:other.status==='streaming'?'stopped':other.status});
  }
  // Lifecycle revisions come from the server and are independent of newer message/draft timestamps.
  const lifecycle=(old.lifecycle?.revision??0)>=(c.lifecycle?.revision??0)?old.lifecycle:c.lifecycle;
  if(remoteDraftChanged&&localDraftChanged&&old.input.trim()&&c.input.trim()&&old.input!==c.input){const id=`${c.id.slice(0,65)}-draft-${suffix(old.input)}`;if(!result.has(id))result.set(id,{...old,...(lifecycle?{lifecycle}:{}),id,title:`草稿恢复 · ${old.title}`.slice(0,2000)});}
  const consumedDraft=c.messages.some(m=>m.role==='user'&&!old.messages.some(remote=>sameMessage(remote,m))&&m.content.trim()===old.input.trim());
  const input=base&&!localDraftChanged?old.input:base&&!remoteDraftChanged?c.input:!c.input.trim()&&old.input.trim()&&!consumedDraft&&c.updatedAt<=old.updatedAt?old.input:c.input;
  const metadata=old.updatedAt>c.updatedAt?{...c,...old}:{...old,...c};
  const pendingAttachments=mergeAttachmentDraft(old,c,base,[...messages.values()]);
  result.set(c.id,{...metadata,...(lifecycle?{lifecycle}:{}),input,...(pendingAttachments.length||c.pendingAttachments||old.pendingAttachments?{pendingAttachments}:{}),messages:mergeTaskMessages([...messages.values()]),updatedAt:old.updatedAt>c.updatedAt?old.updatedAt:c.updatedAt});
 }
 const conversations=[...result.values()].map(c=>({...c,messages:mergeTaskMessages(c.messages)})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 const selectedId=localHas&&result.has(local.selectedId)?local.selectedId:remote.selectedId;
 return ensureActiveChat({version:1,conversations,selectedId:result.has(selectedId)?selectedId:conversations[0].id});
}
