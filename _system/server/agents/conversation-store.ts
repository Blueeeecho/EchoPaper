import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentConversationMessage, AgentCreateInput, AgentRun } from '../../shared/agent-types';
import type {ModelMessage} from './model-gateway';
import {chatMessages} from '../../shared/ai-context';
import {assertNoSymlinks,HttpError} from '../security';
import {sameStoredInput,type ConversationReservation,type ConversationSeedSource,type TaskStore} from './task-store';
import {assertConversationActive} from '../chats';
import {attachmentMetadata,validAgentAttachment} from '../../shared/attachment-types';

export type ConversationInput=Pick<AgentCreateInput,'conversationId'|'requestId'|'history'> & {expectedLastRunId?:string|null};
export interface PreparedConversation {history:AgentConversationMessage[];contextMessages?:ModelMessage[];lastRunId:string|null;source:ConversationSeedSource|'stored'|'legacy';reservation?:ConversationReservation;existingRun?:AgentRun}
const activeStatuses=new Set(['queued','running','cancelling','waiting_confirmation']);
const plainHistory=(value:unknown,label:string):AgentConversationMessage[]=>{
 if(value===undefined)return[];
 if(!Array.isArray(value)||value.some(message=>!message||typeof message!=='object'||Object.keys(message).some(key=>!['role','content','attachments'].includes(key))||!['user','assistant'].includes(message.role)||typeof message.content!=='string'||message.attachments!==undefined&&(!Array.isArray(message.attachments)||message.attachments.length>20||message.attachments.some((item:unknown)=>!validAgentAttachment(item)))))throw new HttpError(400,`${label}须为有效的 user/assistant 文字及附件记录。`);
 return value.map(({role,content,attachments})=>({role,content,...(attachments?.length?{attachments:attachments.map(attachmentMetadata)}:{})}));
};
const sameHistory=(a:AgentConversationMessage[],b:AgentConversationMessage[])=>a.length===b.length&&a.every((message,index)=>message.role===b[index].role&&message.content===b[index].content&&JSON.stringify(message.attachments||[])===JSON.stringify(b[index].attachments||[]));
function appendRun(history:AgentConversationMessage[],run:AgentRun){const reply=run.reply??run.summary;history.push({role:'user',content:run.input,...(run.attachments?.length?{attachments:run.attachments}:{})});if(run.status==='completed'&&reply?.trim())history.push({role:'assistant',content:reply});}
async function importedChat(root:string,store:TaskStore,input:ConversationInput,firstOwnedRun?:AgentRun):Promise<AgentConversationMessage[]|undefined>{
 const filename=await assertNoSymlinks(root,'notes/ai-conversations.json',true);let data:any;
 try{const stat=await fs.stat(filename);if(!stat.isFile()||stat.size>128*1024*1024)throw new HttpError(413,'旧对话文件无效或超过迁移上限。');data=JSON.parse(await fs.readFile(filename,'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;if(error instanceof HttpError)throw error;throw new HttpError(409,'旧对话文件无法读取，原数据已保留；请先修复或恢复对话记录。');}
 if(data?.version!==1||!Array.isArray(data.conversations))throw new HttpError(409,'旧对话格式无效，原数据已保留。');
 const matches=data.conversations.filter((conversation:any)=>conversation?.id===input.conversationId);if(!matches.length)return;if(matches.length!==1||!Array.isArray(matches[0].messages))throw new HttpError(409,'旧会话编号重复或消息无效，原数据已保留。');
 const request=store.byRequest(input.requestId),messages=matches[0].messages,cut=messages.findIndex((message:any)=>message?.id===input.requestId||request&&message?.taskId===request.id||firstOwnedRun&&(message?.id===firstOwnedRun.requestId||message?.taskId===firstOwnedRun.id)),prefix=messages.slice(0,cut<0?undefined:cut);
 // The matching saved chat owns its text even if an old/archived task record is
 // absent. A task link can exclude proven foreign text, never hydrate other data.
 const kept=prefix.filter((message:any)=>{if(!message?.taskId)return true;if(typeof message.taskId!=='string')throw new HttpError(409,'旧会话任务链接无效，原数据已保留。');const run=store.get(message.taskId);return !run?.conversationId||run.conversationId===input.conversationId;});
 if(kept.some((message:any)=>!message||typeof message.id!=='string'||!['user','assistant'].includes(message.role)||typeof message.content!=='string'||!['complete','streaming','stopped','error'].includes(message.status)||message.attachment!==undefined&&(!message.attachment||typeof message.attachment.path!=='string'||typeof message.attachment.content!=='string')))throw new HttpError(409,'旧会话消息无效，原数据已保留。');
 return chatMessages(kept).map(({id,role,content})=>{const attachments=kept.find((message:any)=>message.id===id)?.attachments;if(attachments!==undefined&&(!Array.isArray(attachments)||attachments.length>20||attachments.some((item:unknown)=>!validAgentAttachment(item))))throw new HttpError(409,'旧会话附件记录无效，原数据已保留。');return{role,content,...(attachments?.length?{attachments:attachments.map(attachmentMetadata)}:{})};});
}

/** Prepare only reads. The returned reservation is committed with the run by TaskStore.create. */
export async function prepareConversation(root:string,store:TaskStore,input:ConversationInput):Promise<PreparedConversation>{
 if(path.resolve(store.filename)!==path.resolve(root,'.workbench/agent-state.sqlite'))throw new HttpError(409,'会话存储与当前项目不一致。');
 const supplied=plainHistory(input.history,'对话历史');
 if(input.conversationId===undefined){if(supplied.length>100||supplied.reduce((sum,message)=>sum+message.content.length,0)>200000)throw new HttpError(400,'旧版显式历史最多 100 条、合计 200000 字符。');return{history:supplied,lastRunId:null,source:'legacy'};}
 if(typeof input.conversationId!=='string'||!input.conversationId||input.conversationId.length>100||/[\x00-\x1f]/.test(input.conversationId))throw new HttpError(400,'会话编号无效。');
 if(input.expectedLastRunId!==undefined&&input.expectedLastRunId!==null&&(typeof input.expectedLastRunId!=='string'||!input.expectedLastRunId||input.expectedLastRunId.length>100))throw new HttpError(400,'会话版本编号无效。');
 await assertConversationActive(root,input.conversationId);
 const current=store.conversation(input.conversationId),runs=store.conversationRuns(input.conversationId),previous=store.byRequest(input.requestId);
 if(previous&&previous.conversationId!==input.conversationId)throw new HttpError(409,'此请求编号属于另一个会话。');
 if(previous&&!sameStoredInput(store.runtime(previous.id).input,input))throw new HttpError(409,'此请求编号已经用于不同任务。');
 let seed:AgentConversationMessage[],source:PreparedConversation['source'],seedSource:ConversationSeedSource;
 if(current){seed=plainHistory(current.seedHistory,'已保存的会话种子');source='stored';seedSource=current.source;}
 else if(runs.length){const original=store.runtime(runs[0].id).input as {history?:unknown}|undefined;seed=plainHistory(original?.history,'旧任务历史');if(!seed.length)seed=await importedChat(root,store,input,runs[0])||[];source=seedSource='runs';}
 else{const imported=await importedChat(root,store,input);seed=imported||[];source=seedSource=imported?'chat':'empty';}
 const lastRunId=current?.lastRunId??runs.at(-1)?.id??null,existingIndex=previous?runs.findIndex(run=>run.id===previous.id):-1;
 if(previous&&existingIndex<0)throw new HttpError(409,'请求归属记录与会话账本不一致。');
 const precedingRuns=existingIndex<0?runs:runs.slice(0,existingIndex),history=structuredClone(seed);for(const run of precedingRuns)appendRun(history,run);
 const projection=current?.contextProjection,covered=projection?precedingRuns.findIndex(run=>run.id===projection.throughRunId&&run.status==='completed'):-1;
 let contextMessages:ModelMessage[]|undefined;if(projection&&covered>=0){const tail:AgentConversationMessage[]=[];for(const run of precedingRuns.slice(covered+1))appendRun(tail,run);contextMessages=[...structuredClone(projection.messages),...tail];}
 if(supplied.length&&!sameHistory(supplied,history))throw new HttpError(409,'此会话的历史由服务端保存；请求历史与本会话不一致，未接收外部历史。');
 if(!previous){if(input.expectedLastRunId!==undefined&&input.expectedLastRunId!==lastRunId)throw new HttpError(409,'会话已经收到新的请求，请重新读取并比较后发送。',{lastRunId});if(runs.some(run=>activeStatuses.has(run.status)))throw new HttpError(409,'此会话尚有运行或等待决定的请求，请先完成或停止它。',{lastRunId});}
 return{history,...(contextMessages?{contextMessages}:{}),lastRunId,source,reservation:{conversationId:input.conversationId,expectedLastRunId:lastRunId,seedHistory:structuredClone(seed),source:seedSource},...(previous?{existingRun:previous}:{})};
}
