import test from 'node:test';
import assert from 'node:assert/strict';
import {api,ApiError} from '../src/api';
import {activeConversationRun,restoreQueuedTurns} from '../src/queuedTurns';
import type {AgentRun} from '../shared/agent-types';
const conversation={id:'c',messages:[]},run=(status:AgentRun['status'],version:number)=>({id:'r',conversationId:'c',status,version}as AgentRun);
test('terminal server state releases a stale accepted-run lock',()=>{
 assert.equal(activeConversationRun(conversation,[run('completed',3)],run('running',1)),undefined);
 assert.equal(activeConversationRun(conversation,[run('failed',3)],run('running',1)),undefined);
 assert.equal(activeConversationRun(conversation,[],run('running',1))?.id,'r');
 assert.equal(activeConversationRun(conversation,[run('waiting_confirmation',2)])?.id,'r');
 assert.equal(activeConversationRun({id:'other',messages:[]},[run('running',1)]),undefined);
});
test('queued input and stable request ID survive reload without importing malformed queue entries',()=>{
 const turn={conversationId:'c',createdAt:'2026-11-09T12:00:00Z',state:'waiting',request:{requestId:'original-id',input:'Please revise only this sentence',scope:{paths:['manuscript/main.tex']}}};
 assert.deepEqual(restoreQueuedTurns(JSON.stringify([turn])),[turn]);assert.deepEqual(restoreQueuedTurns('{broken'),[]);assert.deepEqual(restoreQueuedTurns(JSON.stringify([{request:{input:'missing identity'}}])),[]);
});
test('message control request timeout releases its promise instead of hanging the composer',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async(_url,options)=>new Promise((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
 try{await assert.rejects(api('/api/projects/QA/chats',{timeoutMs:15}),error=>error instanceof ApiError&&error.status===408&&error.data.uncertain===true);}finally{globalThis.fetch=original;}
});
test('timeout covers a response body that never finishes, and keeps external cancellation distinct',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async(_url,options)=>({ok:true,json:()=>new Promise((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))})as Response;
 try{await assert.rejects(api('/api/projects/QA/chats',{timeoutMs:15}),error=>error instanceof ApiError&&error.status===408);}finally{globalThis.fetch=original;}
});
