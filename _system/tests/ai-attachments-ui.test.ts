import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentAttachment} from '../shared/attachment-types';
import type {AgentRun} from '../shared/agent-types';
import {mergeChats,type PersistedChat} from '../shared/chat-merge';
import {reconcileAgentConversation} from '../src/agentConversation';
import {attachmentFileError,attachmentPrompt,attachmentRawUrl} from '../src/aiAttachments';
const attachment=(id:string,kind:AgentAttachment['kind']='image'):AgentAttachment=>({id,name:kind==='image'?'figure.png':'paper.pdf',mimeType:kind==='image'?'image/png':'application/pdf',size:1200,kind,createdAt:'2026-10-25T01:00:00Z'});
const image=attachment('11111111-1111-4111-8111-111111111111'),pdf=attachment('22222222-2222-4222-8222-222222222222','pdf');
const chat=(attachments:AgentAttachment[]=[]):PersistedChat=>({version:1,selectedId:'c',conversations:[{id:'c',title:'Chat',createdAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T01:00:00Z',messages:[],input:'',model:'mock',effort:'medium',pendingAttachments:attachments}]});
test('attachment-only requests get a useful prompt and image/document validation stays explicit',()=>{
 assert.equal(attachmentPrompt('',[image]),'请查看并分析所附图片。');assert.equal(attachmentPrompt(' ',[pdf]),'请阅读并分析所附文件。');assert.equal(attachmentPrompt('保留原文',[image]),'保留原文');assert.equal(attachmentPrompt('',[]),'');
 assert.match(attachmentFileError({name:'diagram.svg',size:100}),/不支持/);assert.match(attachmentFileError({name:'photo.png',size:11*1024*1024}),/10 MB/);assert.match(attachmentFileError({name:'empty.txt',size:0}),/为空/);assert.equal(attachmentFileError({name:'draft.docx',size:5000}),'');
 assert.equal(attachmentRawUrl('my paper','a/b'),'/api/projects/my%20paper/agent-attachments/a%2Fb/raw');
});
test('attachment-only drafts survive peer merging, including concurrent additions and explicit removal',()=>{
 const base=chat(),remote=chat([image]),local=chat([pdf]);
 assert.deepEqual(new Set(mergeChats(remote,local,base).conversations[0].pendingAttachments?.map(a=>a.id)),new Set([image.id,pdf.id]));
 assert.deepEqual(mergeChats(chat([image,pdf]),chat(),chat([image])).conversations[0].pendingAttachments?.map(a=>a.id),[pdf.id]);
});
test('sending consumes accepted attachment drafts while a failed request keeps attachments available',()=>{
 const base=chat([image]),accepted=chat();accepted.conversations[0].messages.push({id:'u',role:'user',content:'分析图片',status:'complete',createdAt:'2026-10-25T01:10:00Z',taskId:'run',attachments:[image]});
 const sent=mergeChats(base,accepted,base).conversations[0];assert.deepEqual(sent.pendingAttachments,[]);assert.deepEqual(sent.messages[0].attachments,[image]);
 const failed=chat([image]);failed.conversations[0].messages.push({...accepted.conversations[0].messages[0],taskId:undefined});assert.deepEqual(mergeChats(base,failed,base).conversations[0].pendingAttachments,[image]);
 const stale=structuredClone(accepted);delete stale.conversations[0].messages[0].attachments;assert.deepEqual(mergeChats(accepted,stale).conversations[0].messages[0].attachments,[image]);
});
test('durable run recovery restores attachment cards without binary content in chat',()=>{
 const run={id:'run',requestId:'u',conversationId:'c',input:'查看图片',status:'completed',reply:'已查看',summary:'',createdAt:'2026-10-25T01:10:00Z',updatedAt:'2026-10-25T01:11:00Z',modelId:'mock',attachments:[image]} as AgentRun;
 const recovered=reconcileAgentConversation(chat().conversations[0],[run]);assert.deepEqual(recovered.messages.find(message=>message.role==='user')?.attachments,[image]);assert.ok(!JSON.stringify(recovered).includes('base64'));
});
