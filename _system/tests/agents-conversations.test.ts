import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_AGENT_LIMITS,type AgentCreateInput,type AgentRun,type AgentRunStatus} from '../shared/agent-types';
import {prepareConversation,type ConversationInput} from '../server/agents/conversation-store';
import {openTaskStore,type TaskStore} from '../server/agents/task-store';
import {HttpError} from '../server/security';
import type {ModelMessage} from '../server/agents/model-gateway';

type Input=AgentCreateInput&ConversationInput;
const input=(conversationId:string,requestId:string,patch:Partial<Input>={}):Input=>({conversationId,requestId,input:`Question ${requestId}`,targetId:'main',expectedLastRunId:null,...patch});
function runFor(value:Input,patch:Partial<AgentRun>={}):AgentRun{
 const createdAt='2026-10-23T00:00:00.000Z';return{id:`run-${value.requestId}`,projectId:'Fixture',conversationId:value.conversationId,requestId:value.requestId,input:value.input,targetId:value.targetId,modelId:'mock-only',status:'queued',phase:'queued',createdAt,updatedAt:createdAt,configRevision:'fixture',summary:'',scope:{},changesets:[],children:[],buildIds:[],usage:{modelCalls:0,tokens:0,estimated:false},limits:{...DEFAULT_AGENT_LIMITS},lastEventSeq:0,version:1,...patch};
}
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-session-'));let store=await openTaskStore(root);return{root,get store(){return store;},async reopen(){store.close();store=await openTaskStore(root);},async close(){store.close();await fs.rm(root,{recursive:true,force:true});}};}
async function accept(f:Awaited<ReturnType<typeof fixture>>,value:Input,patch:Partial<AgentRun>={}){const prepared=await prepareConversation(f.root,f.store,value),run=f.store.create(runFor(value,patch),{input:value},prepared.reservation);return{prepared,run};}
function finish(store:TaskStore,run:AgentRun,status:AgentRunStatus='completed',reply=`Answer ${run.requestId}`){run.status=status;run.reply=reply;store.save(run);}
const conflict=(error:unknown)=>error instanceof HttpError&&error.statusCode===409;
const m=(id:string,role:'user'|'assistant',content:string,extra:Record<string,unknown>={})=>({id,role,content,status:'complete',createdAt:'2026-10-23T00:00:00.000Z',...extra});
async function chats(root:string,conversations:unknown[]){await fs.mkdir(path.join(root,'notes'),{recursive:true});await fs.writeFile(path.join(root,'notes/ai-conversations.json'),JSON.stringify({version:1,selectedId:'A',conversations}));}
function persistContext(store:TaskStore,run:AgentRun,messages:ModelMessage[]){store.save(run,{...store.runtime(run.id),messages});}

test('A and B derive only their owned turns; a late A reply cannot enter B history',async()=>{
 const f=await fixture();try{
  const a=await accept(f,input('A','a1',{input:'A_PRIVATE'}));assert.deepEqual(a.prepared.history,[]);assert.equal(a.prepared.source,'empty');
  const b=await accept(f,input('B','b1',{input:'B_PRIVATE'}));finish(f.store,b.run);finish(f.store,a.run,'completed','Late A answer');
  const nextB=await prepareConversation(f.root,f.store,input('B','b2',{expectedLastRunId:b.run.id}));assert.deepEqual(nextB.history,[{role:'user',content:'B_PRIVATE'},{role:'assistant',content:'Answer b1'}]);assert.ok(!JSON.stringify(nextB).includes('A_PRIVATE'));assert.ok(!JSON.stringify(nextB).includes('Late A'));
  const nextA=await prepareConversation(f.root,f.store,input('A','a2',{expectedLastRunId:a.run.id}));assert.deepEqual(nextA.history,[{role:'user',content:'A_PRIVATE'},{role:'assistant',content:'Late A answer'}]);assert.equal(f.store.conversation('A')?.lastRunId,a.run.id);assert.equal(f.store.conversation('B')?.lastRunId,b.run.id);
 }finally{await f.close();}
});

test('a new or already owned conversation cannot be seeded by another conversation payload',async()=>{
 const f=await fixture();try{
  const foreign=[{role:'user' as const,content:'FOREIGN_SECRET'}];await assert.rejects(prepareConversation(f.root,f.store,input('new','n1',{history:foreign})),conflict);assert.equal(f.store.conversation('new'),undefined);assert.equal(f.store.list().length,0);
  const first=await accept(f,input('A','a1'));finish(f.store,first.run);await assert.rejects(prepareConversation(f.root,f.store,input('A','a2',{expectedLastRunId:first.run.id,history:foreign})),conflict);assert.equal(f.store.conversation('A')?.lastRunId,first.run.id);
  const own=[{role:'user' as const,content:first.run.input},{role:'assistant' as const,content:'Answer a1'}];const accepted=await prepareConversation(f.root,f.store,input('A','a2',{expectedLastRunId:first.run.id,history:own}));assert.deepEqual(accepted.history,own);
 }finally{await f.close();}
});

test('two prepared windows race through one atomic CAS reservation and the stale window cannot append',async()=>{
 const f=await fixture(),other=await openTaskStore(f.root);try{
  const first=input('A','one'),second=input('A','two'),a=await prepareConversation(f.root,f.store,first),b=await prepareConversation(f.root,other,second);assert.equal(f.store.conversation('A'),undefined,'prepare must not persist a session');
  const accepted=f.store.create(runFor(first),{input:first},a.reservation);assert.throws(()=>other.create(runFor(second),{input:second},b.reservation),conflict);assert.equal(f.store.conversationRuns('A').length,1);assert.equal(other.conversation('A')?.lastRunId,accepted.id);assert.equal(other.byRequest(second.requestId),undefined);
  finish(f.store,accepted);await assert.rejects(prepareConversation(f.root,other,second),conflict);
  const current=await prepareConversation(f.root,other,{...second,expectedLastRunId:accepted.id});other.create(runFor(second),{input:{...second,expectedLastRunId:accepted.id}},current.reservation);assert.equal(f.store.conversationRuns('A').length,2);
 }finally{other.close();await f.close();}
});

test('same requestId retries are idempotent, changed ownership or content is rejected, and failed insert rolls back the session head',async()=>{
 const f=await fixture();try{
  const value=input('A','one'),prepared=await prepareConversation(f.root,f.store,value),first=f.store.create(runFor(value),{input:value},prepared.reservation);
  const duplicate=f.store.create(runFor(value,{id:'different-internal-run-id'}),{input:{targetId:'main',input:value.input,requestId:value.requestId,expectedLastRunId:null,conversationId:'A'}},prepared.reservation);assert.equal(duplicate.id,first.id);assert.equal(f.store.conversationRuns('A').length,1);
  assert.throws(()=>f.store.create(runFor({...value,input:'changed'}),{input:{...value,input:'changed'}},prepared.reservation),conflict);await assert.rejects(prepareConversation(f.root,f.store,{...value,conversationId:'B'}),conflict);await assert.rejects(prepareConversation(f.root,f.store,{...value,input:'changed'}as Input),conflict);
  const retry=await prepareConversation(f.root,f.store,value);assert.equal(retry.existingRun?.id,first.id);assert.deepEqual(retry.history,[]);finish(f.store,first);
  const fresh=input('B','new-session-collision'),freshReady=await prepareConversation(f.root,f.store,fresh);assert.throws(()=>f.store.create(runFor(fresh,{id:first.id}),{input:fresh},freshReady.reservation),conflict);assert.equal(f.store.conversation('B'),undefined,'a failed first run must not leave an orphan session reservation');assert.equal(f.store.byRequest(fresh.requestId),undefined);
  const invalid=input('B','invalid-json'),invalidReady=await prepareConversation(f.root,f.store,invalid),circular:any={input:invalid};circular.self=circular;assert.throws(()=>f.store.create(runFor(invalid),circular,invalidReady.reservation),/circular/i);assert.equal(f.store.conversation('B'),undefined,'JSON serialization failure must roll back the new session');assert.equal(f.store.byRequest(invalid.requestId),undefined);
  const next=input('A','two',{expectedLastRunId:first.id}),ready=await prepareConversation(f.root,f.store,next);assert.throws(()=>f.store.create(runFor(next,{id:first.id}),{input:next},ready.reservation),conflict);assert.equal(f.store.conversation('A')?.lastRunId,first.id);assert.equal(f.store.byRequest('two'),undefined);assert.equal(f.store.conversationRuns('A').length,1);
 }finally{await f.close();}
});

test('running and waiting decisions serialize a conversation, while failure and cancellation retain only user turns',async()=>{
 const f=await fixture();try{
  const first=await accept(f,input('A','one'));for(const status of['queued','running','cancelling','waiting_confirmation']as const){first.run.status=status;f.store.save(first.run);await assert.rejects(prepareConversation(f.root,f.store,input('A','two',{expectedLastRunId:first.run.id})),conflict);}
  finish(f.store,first.run,'failed','Not an authoritative answer');const second=await accept(f,input('A','two',{expectedLastRunId:first.run.id}));assert.deepEqual(second.prepared.history,[{role:'user',content:first.run.input}]);finish(f.store,second.run,'cancelled','Not a final reply');const third=await prepareConversation(f.root,f.store,input('A','three',{expectedLastRunId:second.run.id}));assert.deepEqual(third.history,[{role:'user',content:first.run.input},{role:'user',content:second.run.input}]);
 }finally{await f.close();}
});

test('old turns cannot resume or decide after a later accepted turn, and ledger data survives a service restart',async()=>{
 const f=await fixture();try{
  const first=await accept(f,input('A','one'));finish(f.store,first.run,'interrupted');const second=await accept(f,input('A','two',{expectedLastRunId:first.run.id}));assert.throws(()=>f.store.assertConversationHead(first.run),conflict);assert.doesNotThrow(()=>f.store.assertConversationHead(second.run));finish(f.store,second.run);await f.reopen();
  const next=await prepareConversation(f.root,f.store,input('A','three',{expectedLastRunId:second.run.id}));assert.equal(next.source,'stored');assert.deepEqual(next.history,[{role:'user',content:first.run.input},{role:'user',content:second.run.input},{role:'assistant',content:'Answer two'}]);assert.equal(next.lastRunId,second.run.id);assert.throws(()=>f.store.assertConversationHead(first.run),conflict);
 }finally{await f.close();}
});

test('persisted matching chat imports attachments, cuts the current optimistic pair and excludes proven foreign task links',async()=>{
 const f=await fixture();try{
  const foreign=input('B','foreign'),foreignRun=runFor(foreign,{status:'completed',reply:'Foreign answer'});f.store.create(foreignRun,{input:foreign});
  await chats(f.root,[{id:'A',messages:[m('old-user','user','Earlier question',{attachment:{path:'notes/evidence.md',content:'Explicit old attachment'}}),m('old-answer','assistant','Earlier answer'),m('f-user','user','FOREIGN_SECRET',{taskId:foreignRun.id}),m('f-answer','assistant','FOREIGN_REPLY',{taskId:foreignRun.id}),m('now','user','Current optimistic input'),m('now-answer','assistant','Incomplete prefix',{status:'streaming'}),m('future','user','FUTURE_SECRET')]},{id:'Other',messages:[m('other','user','OTHER_SECRET')]}]);
  const value=input('A','now'),prepared=await prepareConversation(f.root,f.store,value);assert.equal(prepared.source,'chat');assert.equal(prepared.history.length,2);assert.match(prepared.history[0].content,/Earlier question/);assert.match(prepared.history[0].content,/Explicit old attachment/);assert.match(prepared.history[0].content,/notes\/evidence.md/);assert.equal(prepared.history[1].content,'Earlier answer');assert.ok(!JSON.stringify(prepared).includes('SECRET'));assert.equal(f.store.conversation('A'),undefined);
  const compat=await prepareConversation(f.root,f.store,{...value,history:prepared.history});f.store.create(runFor(value,{status:'completed',reply:'New answer'}),{input:value},compat.reservation);await chats(f.root,[{id:'A',messages:[m('injected','user','LATER_FILE_INJECTION')]}]);const next=await prepareConversation(f.root,f.store,input('A','next',{expectedLastRunId:'run-now'}));assert.equal(next.source,'stored');assert.equal(next.history[0].content,prepared.history[0].content);assert.ok(!JSON.stringify(next).includes('LATER_FILE_INJECTION'));
 }finally{await f.close();}
});

test('unknown and legacy unowned task links retain only text already saved in the matching chat',async()=>{
 const f=await fixture();try{
  const oldInput={requestId:'unowned',input:'DO_NOT_HYDRATE_RUN_INPUT',targetId:'main'}as Input,unowned=runFor(oldInput,{conversationId:undefined,status:'completed',reply:'DO_NOT_HYDRATE_RUN_REPLY'});f.store.create(unowned,{input:oldInput});
  await chats(f.root,[{id:'A',messages:[m('unknown-user','user','Saved archived task question',{taskId:'archived-task'}),m('unknown-answer','assistant','Saved archived task answer',{taskId:'archived-task'}),m('legacy-user','user','Saved legacy question',{taskId:unowned.id}),m('legacy-answer','assistant','Saved legacy answer',{taskId:unowned.id}),m('partial','assistant','Do not treat partial output as final',{taskId:'archived-task',status:'stopped'})]},{id:'B',messages:[m('other','user','FOREIGN_CHAT_TEXT')]}]);
  const prepared=await prepareConversation(f.root,f.store,input('A','next'));assert.deepEqual(prepared.history,[{role:'user',content:'Saved archived task question'},{role:'assistant',content:'Saved archived task answer'},{role:'user',content:'Saved legacy question'},{role:'assistant',content:'Saved legacy answer'}]);assert.ok(prepared.history.every(message=>Object.keys(message).sort().join(',')==='content,role'));assert.ok(!JSON.stringify(prepared.history).includes('DO_NOT_HYDRATE'));assert.ok(!JSON.stringify(prepared.history).includes('FOREIGN_CHAT_TEXT'));
 }finally{await f.close();}
});

test('completed legacy summary-only runs keep their response while explicit reply, cancellation and failure remain authoritative',async()=>{
 const f=await fixture();try{
  const values=[{request:'summary',status:'completed',summary:'Old completed summary',reply:undefined},{request:'reply',status:'completed',summary:'Do not prefer this summary',reply:'Explicit final reply'},{request:'empty',status:'completed',summary:'Do not replace an explicit empty reply',reply:''},{request:'failed',status:'failed',summary:'Failure summary is not an assistant answer',reply:undefined},{request:'cancelled',status:'cancelled',summary:'Cancellation summary is not an assistant answer',reply:undefined}]as const;
  for(const value of values){const old=input('A',value.request);f.store.create(runFor(old,{status:value.status,summary:value.summary,reply:value.reply}),{input:old});}
  const next=input('A','next',{expectedLastRunId:'run-cancelled'}),prepared=await prepareConversation(f.root,f.store,next);assert.deepEqual(prepared.history,[{role:'user',content:'Question summary'},{role:'assistant',content:'Old completed summary'},{role:'user',content:'Question reply'},{role:'assistant',content:'Explicit final reply'},{role:'user',content:'Question empty'},{role:'user',content:'Question failed'},{role:'user',content:'Question cancelled'}]);f.store.create(runFor(next,{status:'completed',reply:'New final reply'}),{input:next},prepared.reservation);await f.reopen();const restored=await prepareConversation(f.root,f.store,input('A','after',{expectedLastRunId:'run-next'}));assert.deepEqual(restored.history.slice(0,7),prepared.history);assert.equal(restored.history.at(-1)?.content,'New final reply');
 }finally{await f.close();}
});

test('all old owned runs import the earliest saved history without the unrelated list limit or other-session leakage',async()=>{
 const f=await fixture();try{
  for(let i=0;i<205;i++){const value=input('A',`old-${i}`,{history:[{role:'user',content:i===0?'EARLIEST_PRIVATE_HISTORY':'DO_NOT_DUPLICATE_LATER_PAYLOAD'}]});f.store.create(runFor(value,{status:'completed',reply:`Reply ${i}`}),{input:value});}
  const unrelated=input('B','foreign',{history:[{role:'user',content:'OTHER_SESSION_SECRET'}]});f.store.create(runFor(unrelated,{status:'completed',reply:'FOREIGN_REPLY'}),{input:unrelated});assert.equal(f.store.list().length,200);assert.equal(f.store.conversationRuns('A').length,205);
  const value=input('A','next',{expectedLastRunId:'run-old-204'}),prepared=await prepareConversation(f.root,f.store,value);assert.equal(prepared.source,'runs');assert.equal(prepared.history.length,411);assert.equal(prepared.history[0].content,'EARLIEST_PRIVATE_HISTORY');assert.equal(prepared.history[1].content,'Question old-0');assert.equal(prepared.history.at(-1)?.content,'Reply 204');assert.ok(!JSON.stringify(prepared).includes('OTHER_SESSION_SECRET'));assert.ok(!JSON.stringify(prepared).includes('DO_NOT_DUPLICATE_LATER_PAYLOAD'));f.store.create(runFor(value,{status:'completed',reply:'Latest'}),{input:value},prepared.reservation);await f.reopen();assert.equal((await prepareConversation(f.root,f.store,input('A','after',{expectedLastRunId:'run-next'}))).history.length,413);
 }finally{await f.close();}
});

test('a legacy task without explicit history retains the saved discussion preceding its first owned run',async()=>{
 const f=await fixture();try{
  const original=input('A','old'),old=runFor(original,{status:'completed',reply:'Canonical task reply'});f.store.create(old,{input:original});await chats(f.root,[{id:'A',messages:[m('discussion','user','Earlier discussion'),m('discussion-answer','assistant','Earlier reasoning'),m('old','user',original.input,{taskId:old.id}),m('task-answer','assistant','Stale streamed task reply',{taskId:old.id}),m('next','user','Current optimistic request')]}]);
  const value=input('A','next',{expectedLastRunId:old.id}),prepared=await prepareConversation(f.root,f.store,value);assert.equal(prepared.source,'runs');assert.deepEqual(prepared.history,[{role:'user',content:'Earlier discussion'},{role:'assistant',content:'Earlier reasoning'},{role:'user',content:original.input},{role:'assistant',content:'Canonical task reply'}]);f.store.create(runFor(value),{input:value},prepared.reservation);assert.throws(()=>f.store.create(runFor(input('A','unreserved')),{input:input('A','unreserved')}),conflict);assert.equal(f.store.byRequest('unreserved'),undefined);
 }finally{await f.close();}
});

test('project roots isolate identical conversation IDs and legacy requests keep explicit history without owning a session',async()=>{
 const a=await fixture(),b=await fixture();try{
  const first=await accept(a,input('same','one'));finish(a.store,first.run);const second=await prepareConversation(b.root,b.store,input('same','one'));assert.deepEqual(second.history,[]);assert.equal(second.lastRunId,null);
  await assert.rejects(prepareConversation(b.root,a.store,input('same','two')),conflict);
  const history=[{role:'user' as const,content:'Explicit legacy input'},{role:'assistant' as const,content:'Explicit legacy answer'}],legacy=await prepareConversation(a.root,a.store,{requestId:'legacy',history});assert.deepEqual(legacy.history,history);assert.equal(legacy.source,'legacy');assert.equal(legacy.reservation,undefined);assert.equal(a.store.conversationRuns('same').length,1);await assert.rejects(prepareConversation(a.root,a.store,{requestId:'bad',history:[{role:'system',content:'bad'}]as any}),error=>error instanceof HttpError&&error.statusCode===400);
 }finally{await a.close();await b.close();}
});

test('an unreadable or symlinked legacy chat never replaces the original source or creates a session',async()=>{
 const f=await fixture();try{
  await fs.mkdir(path.join(f.root,'notes'));const filename=path.join(f.root,'notes/ai-conversations.json');await fs.writeFile(filename,'broken legacy JSON');await assert.rejects(prepareConversation(f.root,f.store,input('A','one')),conflict);assert.equal(await fs.readFile(filename,'utf8'),'broken legacy JSON');assert.equal(f.store.conversation('A'),undefined);
  await fs.unlink(filename);await fs.symlink('/etc/passwd',filename);await assert.rejects(prepareConversation(f.root,f.store,input('A','one')),error=>error instanceof HttpError&&error.statusCode===403);assert.equal(f.store.list().length,0);
 }finally{await f.close();}
});

test('a persisted compaction projection is reused after restart and only the same conversation tail is appended',async()=>{
 const f=await fixture();try{
  const first=await accept(f,input('A','one',{input:'OLD_RAW_SENTINEL'}));finish(f.store,first.run);assert.equal(f.store.conversation('A')?.contextProjection,undefined);
  const second=await accept(f,input('A','two',{expectedLastRunId:first.run.id}));finish(f.store,second.run);const messages:ModelMessage[]=[{role:'system',content:'CURRENT_SYSTEM_NEVER_SAVED'},{role:'user',content:'<context_summary>A_SUMMARY_SENTINEL</context_summary>'},{role:'user',content:second.run.input},{role:'assistant',content:second.run.reply!}];persistContext(f.store,second.run,messages);assert.equal(f.store.installConversationProjection(second.run,messages),true);await f.reopen();
  const next=input('A','three',{expectedLastRunId:second.run.id}),prepared=await prepareConversation(f.root,f.store,next);assert.ok(JSON.stringify(prepared.history).includes('OLD_RAW_SENTINEL'));assert.ok(!JSON.stringify(prepared.contextMessages).includes('OLD_RAW_SENTINEL'));assert.equal(JSON.stringify(prepared.contextMessages).match(/A_SUMMARY_SENTINEL/g)?.length,1);assert.ok(!JSON.stringify(f.store.conversation('A')?.contextProjection).includes('CURRENT_SYSTEM_NEVER_SAVED'));
  const third=f.store.create(runFor(next),{input:next},prepared.reservation);finish(f.store,third);const fourth=await prepareConversation(f.root,f.store,input('A','four',{expectedLastRunId:third.id}));assert.deepEqual(fourth.contextMessages?.slice(-2),[{role:'user',content:third.input},{role:'assistant',content:third.reply}]);assert.equal(JSON.stringify(fourth.contextMessages).match(/A_SUMMARY_SENTINEL/g)?.length,1);assert.equal(f.store.conversation('A')?.contextProjection?.throughRunId,second.run.id);assert.equal(fourth.history.length,6);
  const b=await prepareConversation(f.root,f.store,input('B','b-one'));assert.deepEqual(b.history,[]);assert.equal(b.contextMessages,undefined);assert.ok(!JSON.stringify(b).includes('A_SUMMARY_SENTINEL'));
 }finally{await f.close();}
});

test('projection installation preserves complete native tool pairs and rejects orphan, duplicate or unfinished tool results',async()=>{
 const f=await fixture();try{
  const accepted=await accept(f,input('A','one'));finish(f.store,accepted.run);const calls:NonNullable<ModelMessage['tool_calls']>=[{id:'read',type:'function',function:{name:'read_file',arguments:'{"path":"notes/a.md"}'}},{id:'search',type:'function',function:{name:'search_files',arguments:'{"query":"evidence"}'}}];
  const valid:ModelMessage[]=[{role:'system',content:'System is replaced on each turn'},{role:'user',content:'Compacted earlier history'},{role:'assistant',content:null,tool_calls:calls,reasoning_content:'Native continuation state'},{role:'tool',tool_call_id:'search',content:'{"results":[]}'},{role:'tool',tool_call_id:'read',content:'{"content":"evidence"}'},{role:'assistant',content:accepted.run.reply!}];persistContext(f.store,accepted.run,valid);assert.equal(f.store.installConversationProjection(accepted.run,valid),true);const saved=f.store.conversation('A')?.contextProjection;assert.deepEqual(saved?.messages,valid.slice(1));
  const invalid:ModelMessage[][]=[[valid[2]],[valid[3]],[valid[2],valid[3],valid[3],valid[4]],[valid[2],{role:'tool',tool_call_id:'wrong-id',content:'{}'}],[valid[2],valid[4],valid[5]]];
  for(const messages of invalid){persistContext(f.store,accepted.run,messages);assert.throws(()=>f.store.installConversationProjection(accepted.run,messages),conflict);assert.deepEqual(f.store.conversation('A')?.contextProjection,saved);}
  persistContext(f.store,accepted.run,valid);assert.throws(()=>f.store.installConversationProjection(accepted.run,[{role:'user',content:'FOREIGN_CONTEXT'}]),conflict);assert.deepEqual(f.store.conversation('A')?.contextProjection,saved);
 }finally{await f.close();}
});

test('only a completed owned head installs a projection and retries cannot observe a projection from a later turn',async()=>{
 const f=await fixture();try{
  const firstInput=input('A','one'),first=await accept(f,firstInput),firstMessages:ModelMessage[]=[{role:'user',content:'FIRST_SUMMARY'},{role:'assistant',content:'Answer one'}];persistContext(f.store,first.run,firstMessages);assert.equal(f.store.installConversationProjection({...first.run,status:'completed'},firstMessages),false);finish(f.store,first.run);persistContext(f.store,first.run,firstMessages);assert.equal(f.store.installConversationProjection(first.run,firstMessages),true);assert.equal(f.store.installConversationProjection({...first.run,conversationId:'B'},firstMessages),false);
  const secondInput=input('A','two',{expectedLastRunId:first.run.id}),second=await accept(f,secondInput);assert.equal(f.store.installConversationProjection(first.run,firstMessages),false);finish(f.store,second.run);const later:ModelMessage[]=[{role:'user',content:'LATER_SUMMARY_SENTINEL'},{role:'assistant',content:'Answer two'}];persistContext(f.store,second.run,later);assert.equal(f.store.installConversationProjection(second.run,later),true);
  const retryFirst=await prepareConversation(f.root,f.store,firstInput),retrySecond=await prepareConversation(f.root,f.store,secondInput);assert.equal(retryFirst.existingRun?.id,first.run.id);assert.deepEqual(retryFirst.history,[]);assert.equal(retryFirst.contextMessages,undefined);assert.deepEqual(retrySecond.history,[{role:'user',content:first.run.input},{role:'assistant',content:first.run.reply}]);assert.equal(retrySecond.contextMessages,undefined);assert.ok(!JSON.stringify(retrySecond).includes('LATER_SUMMARY_SENTINEL'));
 }finally{await f.close();}
});

test('malformed, system-bearing, foreign or unknown projection anchors fall back to the complete raw ledger',async()=>{
 const f=await fixture();try{
  const a=await accept(f,input('A','one'));finish(f.store,a.run);const b=await accept(f,input('B','b-one'));finish(f.store,b.run);const expected=[{role:'user' as const,content:a.run.input},{role:'assistant' as const,content:a.run.reply!}];
  for(const body of['{',JSON.stringify({throughRunId:'unknown',messages:[{role:'user',content:'DO_NOT_IMPORT'}]}),JSON.stringify({throughRunId:b.run.id,messages:[{role:'user',content:'B_PRIVATE_SUMMARY'}]}),JSON.stringify({throughRunId:a.run.id,messages:[{role:'system',content:'DO_NOT_IMPORT_SYSTEM'}]}),JSON.stringify({throughRunId:a.run.id,messages:[{role:'tool',tool_call_id:'orphan',content:'DO_NOT_IMPORT_TOOL'}]})]){
   f.store.saver.db.prepare('UPDATE agent_conversations SET context_projection = ? WHERE id = ?').run(body,'A');const prepared=await prepareConversation(f.root,f.store,input('A','next',{expectedLastRunId:a.run.id}));assert.deepEqual(prepared.history,expected);assert.equal(prepared.contextMessages,undefined);assert.equal(f.store.conversationRuns('A').length,1);
  }
 }finally{await f.close();}
});

test('the optional projection column migrates an existing conversation table without changing its seed or head',async()=>{
 const f=await fixture();try{
  const accepted=await accept(f,input('A','one'));finish(f.store,accepted.run);const before=f.store.conversation('A');f.store.saver.db.exec('ALTER TABLE agent_conversations DROP COLUMN context_projection');await f.reopen();assert.deepEqual(f.store.conversation('A'),before);assert.equal((await prepareConversation(f.root,f.store,input('A','next',{expectedLastRunId:accepted.run.id}))).history.length,2);assert.ok(f.store.saver.db.prepare('PRAGMA table_info(agent_conversations)').all().some((column:any)=>column.name==='context_projection'));
 }finally{await f.close();}
});

test('archive and recycle admission rejects both new turns and old retries without changing the owned ledger or projection',async()=>{
 const f=await fixture();try{const seed=[m('prior','user','Saved discussion')];await chats(f.root,[{id:'A',messages:seed}]);const original=input('A','one'),accepted=await accept(f,original);finish(f.store,accepted.run);const projected:ModelMessage[]=[{role:'user',content:'Owned compacted discussion'},{role:'assistant',content:accepted.run.reply!}];persistContext(f.store,accepted.run,projected);assert.equal(f.store.installConversationProjection(accepted.run,projected),true);const before=structuredClone(f.store.conversation('A'));
  for(const [index,state]of ['archived','deleted'].entries()){await chats(f.root,[{id:'A',messages:seed,lifecycle:{state,revision:index+1,updatedAt:'2026-10-24T00:00:00.000Z'}}]);const filename=path.join(f.root,'notes/ai-conversations.json'),saved=await fs.readFile(filename,'utf8');for(const value of [original,input('A','later',{expectedLastRunId:accepted.run.id})])await assert.rejects(prepareConversation(f.root,f.store,value),error=>conflict(error)&&/恢复后继续/.test((error as Error).message));assert.deepEqual(f.store.conversation('A'),before);assert.equal(f.store.conversationRuns('A').length,1);assert.equal(await fs.readFile(filename,'utf8'),saved);}
  await chats(f.root,[{id:'A',messages:seed,lifecycle:{state:'active',revision:3,updatedAt:'2026-10-24T00:00:01.000Z'}}]);const restored=await prepareConversation(f.root,f.store,input('A','after-restore',{expectedLastRunId:accepted.run.id}));assert.deepEqual(restored.history,[{role:'user',content:'Saved discussion'},{role:'user',content:accepted.run.input},{role:'assistant',content:accepted.run.reply}]);assert.deepEqual(restored.contextMessages,projected);assert.equal(restored.lastRunId,accepted.run.id);assert.deepEqual(f.store.conversation('A'),before);
 }finally{await f.close();}
});

test('lifecycle admission accepts minimal legacy chat records but rejects malformed state even for a known session',async()=>{
 const f=await fixture();try{const accepted=await accept(f,input('A','one'));finish(f.store,accepted.run);for(const lifecycle of [null,false,{state:'hidden',revision:1,updatedAt:'2026-10-24T00:00:00.000Z'},{state:'active',revision:0,updatedAt:'2026-10-24T00:00:00.000Z'},{state:'active',revision:1,updatedAt:'invalid'}]){await chats(f.root,[{id:'A',messages:[],lifecycle}]);const before=await fs.readFile(path.join(f.root,'notes/ai-conversations.json'),'utf8');await assert.rejects(prepareConversation(f.root,f.store,input('A','next',{expectedLastRunId:accepted.run.id})),conflict);assert.equal(await fs.readFile(path.join(f.root,'notes/ai-conversations.json'),'utf8'),before);}
  await chats(f.root,[{id:'A',messages:[],lifecycle:{state:'active',revision:1,updatedAt:'2026-10-24T00:00:00.000Z'}}]);const ready=await prepareConversation(f.root,f.store,input('A','next',{expectedLastRunId:accepted.run.id}));assert.equal(ready.history.length,2);assert.equal(ready.lastRunId,accepted.run.id);await fs.rm(path.join(f.root,'notes/ai-conversations.json'));assert.deepEqual((await prepareConversation(f.root,f.store,input('A','next',{expectedLastRunId:accepted.run.id}))).history,ready.history);
 }finally{await f.close();}
});
