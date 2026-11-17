import type {AgentCreateInput,AgentRun} from '../shared/agent-types';
import type {AgentAttachment} from '../shared/attachment-types';
import type {PersistedConversation} from '../shared/chat-merge';
export interface QueuedTurn {
 conversationId:string;createdAt:string;mode?:'followup'|'queued';state:'waiting'|'held';error?:string;
 submittedPayload?:AgentCreateInput;
 request:Omit<AgentCreateInput,'targetId'|'conversationId'|'history'|'expectedLastRunId'>;
 reference?:{path:string;content:string};attachments?:AgentAttachment[];
}
export function activeConversationRun(conversation:Pick<PersistedConversation,'id'|'messages'>,runs:AgentRun[],accepted?:AgentRun){
 const values=[...runs];if(accepted){const known=runs.find(run=>run.id===accepted.id);if(!known)values.push(accepted);else if(accepted.version>known.version)values[values.indexOf(known)]=accepted;}
 return values.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).find(run=>['queued','running','cancelling','waiting_confirmation'].includes(run.status)&&(run.conversationId===conversation.id||conversation.messages.some(message=>message.taskId===run.id)));
}
export function restoreQueuedTurns(value:string|null):QueuedTurn[]{
 try{const items=JSON.parse(value||'[]');if(!Array.isArray(items))return[];return items.filter(item=>item&&typeof item.conversationId==='string'&&typeof item.request?.requestId==='string'&&typeof item.request?.input==='string'&&['waiting','held'].includes(item.state)&&typeof item.createdAt==='string');}catch{return[];}
}

// Freeze only at submission, after local preparation. Reloaded retries keep this identity.
export async function submitFrozenTurn(payload:AgentCreateInput, find:()=>Promise<AgentRun|undefined>, post:(input:AgentCreateInput)=>Promise<AgentRun>, retry=false){
 if(retry){const known=await find();if(known)return known;}
 return post(structuredClone(payload));
}
