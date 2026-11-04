export interface AgentAttachment {id:string;name:string;mimeType:string;size:number;kind:'image'|'text'|'pdf'|'document';createdAt:string}
export const AGENT_ATTACHMENT_MAX_BYTES=25*1024*1024;
export const AGENT_IMAGE_MAX_BYTES=10*1024*1024;
export const AGENT_ATTACHMENT_MAX_COUNT=20;
export function validAgentAttachment(value:unknown):value is AgentAttachment{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const item=value as AgentAttachment;
 return typeof item.id==='string'&&/^[a-f0-9-]{36}$/.test(item.id)&&typeof item.name==='string'&&!!item.name&&item.name.length<=255&&!/[\x00-\x1f\/\\]/.test(item.name)&&typeof item.mimeType==='string'&&item.mimeType.length<=150&&Number.isSafeInteger(item.size)&&item.size>0&&item.size<=AGENT_ATTACHMENT_MAX_BYTES&&['image','text','pdf','document'].includes(item.kind)&&typeof item.createdAt==='string'&&Number.isFinite(Date.parse(item.createdAt));
}
export function attachmentMetadata(value:AgentAttachment):AgentAttachment{return{id:value.id,name:value.name,mimeType:value.mimeType,size:value.size,kind:value.kind,createdAt:value.createdAt};}
