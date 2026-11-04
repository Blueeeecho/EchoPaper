import type {ContextCheckpoint,ContextUsage} from './ai-context';
import type {AgentAttachment} from './attachment-types';
export interface PersistedMessage { id:string;role:'user'|'assistant';content:string;status:'complete'|'streaming'|'stopped'|'error';createdAt:string;attachments?:AgentAttachment[];[key:string]:any }
export type ConversationState = 'active' | 'archived' | 'deleted';
export interface ChatLifecycle {state:ConversationState;revision:number;updatedAt:string}
export interface PersistedConversation { id:string;title:string;createdAt:string;updatedAt:string;messages:PersistedMessage[];input:string;model:string;effort:any;pendingAttachments?:AgentAttachment[]; contextState?:ContextCheckpoint;contextUsage?:ContextUsage;lifecycle?:ChatLifecycle }
export interface PersistedChat {version:1;selectedId:string;conversations:PersistedConversation[]}
export const conversationState = (conversation: Pick<PersistedConversation, 'lifecycle'>): ConversationState => conversation.lifecycle?.state ?? 'active';

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
function mergeAttachmentDraft(remote:PersistedConversation,local:PersistedConversation,base:PersistedConversation|undefined,messages:PersistedMessage[]):AgentAttachment[]{const old=new Set((base?.pendingAttachments||[]).map(a=>a.id)),left=new Map((local.pendingAttachments||[]).map(a=>[a.id,a])),right=new Map((remote.pendingAttachments||[]).map(a=>[a.id,a]));const consumed=new Set(messages.filter(message=>message.role==='user'&&!!message.taskId&&!base?.messages.some(before=>before.id===message.id)).flatMap(message=>(message.attachments||[]).map(attachment=>attachment.id)));return [...new Set([...left.keys(),...right.keys()])].filter(id=>!consumed.has(id)&&(base?(left.has(id)===old.has(id)?right.has(id):left.has(id)):left.has(id)||right.has(id))).map(id=>left.get(id)||right.get(id)!);}
/** Union histories; preserve divergent text/drafts as explicit recovered entries. */
export function mergeChats(remote:PersistedChat|null,local:PersistedChat,baseline?:PersistedChat|null):PersistedChat {
 if(!remote)return ensureActiveChat(local);
 const localHas=local.conversations.some(c=>conversationState(c)==='active'&&meaningful(c)),localConversations=localHas?local.conversations:local.conversations.filter(c=>c.lifecycle||remote.conversations.some(r=>r.id===c.id));
 const result=new Map(remote.conversations.map(c=>[c.id,structuredClone(c)]));
 for(const c of localConversations){const old=result.get(c.id);if(!old){result.set(c.id,c);continue;}
  const base=baseline?.conversations.find(item=>item.id===c.id),remoteDraftChanged=!base||old.input!==base.input,localDraftChanged=!base||c.input!==base.input;
  const messages=new Map(old.messages.map(m=>[m.id,m]));
  for(const m of c.messages){const other=messages.get(m.id);if(!other){messages.set(m.id,m);continue;}
   if(other.content===m.content){messages.set(m.id,mergedMessage(m,other));continue;}
   if(m.content.startsWith(other.content)){messages.set(m.id,m);continue;}
   if(other.content.startsWith(m.content))continue;
   messages.set(m.id,m);const id=`${m.id.slice(0,65)}-recovered-${suffix(other.content)}`;
   messages.set(id,{...other,id,status:other.status==='streaming'?'stopped':other.status});
  }
  // Lifecycle revisions come from the server and are independent of newer message/draft timestamps.
  const lifecycle=(old.lifecycle?.revision??0)>=(c.lifecycle?.revision??0)?old.lifecycle:c.lifecycle;
  if(remoteDraftChanged&&localDraftChanged&&old.input.trim()&&c.input.trim()&&old.input!==c.input){const id=`${c.id.slice(0,65)}-draft-${suffix(old.input)}`;if(!result.has(id))result.set(id,{...old,...(lifecycle?{lifecycle}:{}),id,title:`草稿恢复 · ${old.title}`.slice(0,2000)});}
  const consumedDraft=c.messages.some(m=>m.role==='user'&&!old.messages.some(remote=>remote.id===m.id)&&m.content.trim()===old.input.trim());
  const input=base&&!localDraftChanged?old.input:base&&!remoteDraftChanged?c.input:!c.input.trim()&&old.input.trim()&&!consumedDraft&&c.updatedAt<=old.updatedAt?old.input:c.input;
  const metadata=old.updatedAt>c.updatedAt?{...c,...old}:{...old,...c};
  const pendingAttachments=mergeAttachmentDraft(old,c,base,[...messages.values()]);
  result.set(c.id,{...metadata,...(lifecycle?{lifecycle}:{}),input,...(pendingAttachments.length||c.pendingAttachments||old.pendingAttachments?{pendingAttachments}:{}),messages:[...messages.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)),updatedAt:old.updatedAt>c.updatedAt?old.updatedAt:c.updatedAt});
 }
 const conversations=[...result.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 const selectedId=localHas&&result.has(local.selectedId)?local.selectedId:remote.selectedId;
 return ensureActiveChat({version:1,conversations,selectedId:result.has(selectedId)?selectedId:conversations[0].id});
}
