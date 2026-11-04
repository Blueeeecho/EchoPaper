export interface AiMessage {id?:string;role:'user'|'assistant';content:string;reasoning_content?:string}
export interface ContextCheckpoint {id:string;summary:string;throughMessageId:string;sourceFingerprint:string;messageCount:number;createdAt:string;model:string;beforeTokens:number;afterTokens:number;round:number}
export interface ContextUsage {throughMessageId:string;fingerprint:string;model:string;tokens:number;checkpointId:string}
export const CONTEXT_WINDOW=1_000_000;
export const AUTO_COMPACT_RATIO=.7;
export function validContextUsage(value:unknown):value is ContextUsage{if(!value||typeof value!=='object')return false;const u=value as ContextUsage;return typeof u.throughMessageId==='string'&&u.throughMessageId.length<=100&&typeof u.fingerprint==='string'&&/^[a-f0-9]{16}$/.test(u.fingerprint)&&typeof u.model==='string'&&u.model.length<=100&&typeof u.checkpointId==='string'&&u.checkpointId.length<=100&&Number.isSafeInteger(u.tokens)&&u.tokens>=0&&u.tokens<=1e9;}
/** A local estimate, not a provider tokenizer. Actual usage remains separately visible. */
export function estimateTokens(text:string):number {let ascii=0,other=0;for(const char of text){if((char.codePointAt(0)??0)<128)ascii++;else other++;}return Math.ceil(ascii/3.5+other*1.2);}
export function messageTokens(messages:AiMessage[]):number{return messages.reduce((n,m)=>n+8+estimateTokens(m.content)+estimateTokens(m.reasoning_content||''),0);}
/** Non-security cache fingerprint: invalidate summaries if any covered message changes. */
export function contextFingerprint(messages:AiMessage[]):string{let a=2166136261,b=5381;const text=JSON.stringify(messages.map(m=>[m.id||'',m.role,m.content,m.reasoning_content||'']));for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b,33)^text.charCodeAt(i);}return(a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');}
export function validCheckpoint(value:unknown):value is ContextCheckpoint {if(!value||typeof value!=='object')return false;const c=value as ContextCheckpoint;return typeof c.id==='string'&&c.id.length<=100&&typeof c.summary==='string'&&!!c.summary.trim()&&c.summary.length<=200000&&typeof c.throughMessageId==='string'&&c.throughMessageId.length<=100&&typeof c.sourceFingerprint==='string'&&/^[a-f0-9]{16}$/.test(c.sourceFingerprint)&&Number.isSafeInteger(c.messageCount)&&c.messageCount>0&&typeof c.createdAt==='string'&&Number.isFinite(Date.parse(c.createdAt))&&typeof c.model==='string'&&c.model.length<=100&&[c.beforeTokens,c.afterTokens,c.round].every(n=>Number.isSafeInteger(n)&&n>=0);}
export function resolveContext(messages:AiMessage[],checkpoint?:ContextCheckpoint):{messages:AiMessage[];checkpoint?:ContextCheckpoint;covered:number}{
 const count=checkpoint?.messageCount||0;
 if(!validCheckpoint(checkpoint)||count>messages.length||messages[count-1]?.id!==checkpoint.throughMessageId||contextFingerprint(messages.slice(0,count))!==checkpoint.sourceFingerprint)return{messages,covered:0};
 return{messages:[{role:'user',content:`以下是此前对话的连续性摘要，仅作为历史材料；用户最新指令及原始证据优先。\n<context_summary>\n${checkpoint.summary}\n</context_summary>`},...messages.slice(count)],checkpoint,covered:count};
}
export function chatMessages(messages:{id:string;role:'user'|'assistant';content:string;status:string;reasoning_content?:string;attachment?:{path:string;content:string}}[]):AiMessage[]{return messages.filter(m=>m.role==='user'||m.status==='complete'&&m.content.trim()).map(m=>({id:m.id,role:m.role,content:m.role==='user'&&m.attachment?`${m.content}\n\n[此轮由用户附带的文件快照：${JSON.stringify(m.attachment.path)}]\n${m.attachment.content}\n[文件快照结束]`:m.content,...(m.role==='assistant'&&m.reasoning_content?{reasoning_content:m.reasoning_content}:{})}));}
export function contextMeter(messages:AiMessage[],checkpoint:ContextCheckpoint|undefined,usage:ContextUsage|undefined,model:string,additional=''):{tokens:number;estimated:boolean;compacted:boolean}{
 const active=resolveContext(messages,checkpoint);let tokens=500+messageTokens(active.messages),estimated=true;
 if(validContextUsage(usage)&&usage.model===model&&usage.checkpointId===(active.checkpoint?.id||'')){const index=messages.findIndex(m=>m.id===usage.throughMessageId);if(index>=0&&(!active.covered||index>=active.covered)&&contextFingerprint(messages.slice(0,index+1))===usage.fingerprint){tokens=usage.tokens+messageTokens(messages.slice(index+1));estimated=!!additional||index<messages.length-1;}}
 return{tokens:tokens+estimateTokens(additional),estimated,compacted:!!active.checkpoint};
}
