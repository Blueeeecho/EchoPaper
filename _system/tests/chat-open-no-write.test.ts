import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.ts';
import type {BuildService} from '../shared/types.ts';
import type {PersistedChat} from '../shared/chat-merge';
import {mergeChats} from '../shared/chat-merge';
import {reconcileAgentConversation} from '../src/agentConversation';
import {addsBrowserData} from '../src/migrateChats';
import {chatsEqual} from '../shared/chat-merge';
import {mergeConversationSelection} from '../src/agentConversation';
import {createHash} from 'node:crypto';
const sha256 = (text:string) => createHash('sha256').update(text).digest('hex');


// Regression for "opening the AI panel rewrites notes/ai-conversations.json".
const fakeBuilds:BuildService={async request(projectId,targetId){return {id:'b',projectId,targetId,status:'queued',createdAt:new Date().toISOString(),log:'',diagnostics:[]};},async cancel(id){return {id,projectId:'x',targetId:'main',status:'cancelled',createdAt:new Date().toISOString(),log:'',diagnostics:[]};},async list(){return [];},async get(){throw new Error('n/a');},async artifact(){throw new Error('n/a');},async createSubmission(){throw new Error('n/a');},async listSubmissions(){return [];},async submissionArtifact(){throw new Error('n/a');},async close(){}};
const t0='2026-11-10T12:00:00.000Z';
const saved=():PersistedChat=>({version:1,selectedId:'c1',conversations:[{id:'c1',title:'旧对话',createdAt:t0,updatedAt:t0,input:'',model:'m',effort:'medium',messages:[
  {id:'u1',role:'user',content:'你在吗',status:'complete',createdAt:t0,taskId:'run-1'},
  {id:'u1-reply',role:'assistant',content:'',status:'streaming',createdAt:t0,taskId:'run-1'}]}]});
const run:any={id:'run-1',requestId:'u1',conversationId:'c1',status:'completed',version:9,createdAt:t0,updatedAt:'2026-11-11T00:00:00.000Z',input:'你在吗',modelId:'m',reply:'在的。',children:[],changesets:[],buildIds:[],scope:{}};

test('run reconciliation is a display view: it adds task fields in memory and leaves the persisted form untouched',()=>{
  const base=saved(),before=JSON.stringify(base);
  const view=reconcileAgentConversation(base.conversations[0],[run]);
  assert.equal(view.messages[1].content,'在的。');assert.equal(view.messages[1].taskVersion,9);assert.equal(view.messages[1].taskTerminal,true);
  assert.equal(JSON.stringify(base),before,'the persisted chat object must not be mutated by reconciliation');
});

test('legacy browser migration only writes real browser-only data, not run metadata',()=>{
  const remote=saved();
  const display={...remote,conversations:[reconcileAgentConversation(remote.conversations[0],[run])]};
  // A browser cache written by the old panel carried reconciled fields; merging it is metadata only.
  const metaOnly=structuredClone(display);metaOnly.conversations[0].messages[1].content='';metaOnly.conversations[0].messages[1].status='streaming';
  assert.equal(addsBrowserData(remote,mergeChats(remote,metaOnly)),false);
  assert.equal(addsBrowserData(remote,mergeChats(remote,display)),true,'a completed reply text the file lacks is still migrated');
  const extra=structuredClone(remote);extra.conversations[0].messages.push({id:'u2',role:'user',content:'浏览器独有',status:'complete',createdAt:'2026-11-10T12:01:00.000Z'});
  assert.equal(addsBrowserData(remote,mergeChats(remote,extra)),true);
  const draft=structuredClone(remote);draft.conversations[0].input='未发送草稿';draft.conversations[0].updatedAt='2026-11-10T12:02:00.000Z';
  assert.equal(addsBrowserData(remote,mergeChats(remote,draft)),true);
  assert.equal(addsBrowserData(null,remote),true);
});

test('client load path never writes; an explicit send appends one turn and keeps old messages byte-identical',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'chat-open-'));
  for(const template of ['english'])await fs.mkdir(path.join(root,'shared','templates',template),{recursive:true});
  await fs.writeFile(path.join(root,'shared','templates','english','main.tex'),'\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n');
  await fs.mkdir(path.join(root,'papers'));
  const app=await createApp({workspaceRoot:root,buildService:fakeBuilds,watch:false});
  try{
    assert.equal((await app.inject({method:'POST',url:'/api/projects',payload:{id:'Alpha',title:'Alpha',template:'english'}})).statusCode,201);
    const url='/api/projects/Alpha/chats',file=path.join(root,'papers','Alpha','notes','ai-conversations.json');
    const first=await app.inject({method:'PUT',url,payload:{data:saved(),expectedHash:null}});assert.equal(first.statusCode,200,first.body);
    const raw0=await fs.readFile(file,'utf8'),mtime0=(await fs.stat(file)).mtimeMs;
    await new Promise(r=>setTimeout(r,20));
    // Load: GET + in-memory reconciliation, as the panel does on open. No PUT is issued.
    const remote=(await app.inject(url)).json();
    const view={...remote.data,conversations:remote.data.conversations.map((c:any)=>reconcileAgentConversation(c,[run]))};
    assert.notEqual(JSON.stringify(view),JSON.stringify(remote.data),'the display differs from disk, which used to trigger a write-back');
    assert.equal(await fs.readFile(file,'utf8'),raw0);assert.equal((await fs.stat(file)).mtimeMs,mtime0);
    // Explicit send: the persisted base (not the view) gains exactly one user/assistant turn.
    const base=structuredClone(remote.data) as PersistedChat,now='2026-11-11T15:00:00.000Z';
    base.conversations[0].messages.push({id:'u2',role:'user',content:'新消息',status:'complete',createdAt:now},{id:'u2-reply',role:'assistant',content:'',status:'streaming',createdAt:now});
    const sent=await app.inject({method:'PUT',url,payload:{data:base,expectedHash:remote.hash}});assert.equal(sent.statusCode,200,sent.body);
    const before=JSON.parse(raw0).conversations[0].messages,after=JSON.parse(await fs.readFile(file,'utf8')).conversations[0].messages;
    assert.equal(after.length,before.length+2);
    for(const [index,message] of before.entries()){assert.equal(JSON.stringify(after[index]),JSON.stringify(message));assert.ok((await fs.readFile(file,'utf8')).includes(JSON.stringify(message)),'old message bytes are unchanged');}
    assert.deepEqual(after.slice(-2).map((m:any)=>m.id),['u2','u2-reply']);
    assert.equal(after[1].taskVersion,undefined,'reconciled fields are not written for old messages');
  }finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});

test('panel wiring: loading and run updates do not queue saves',async()=>{
  const hook=await fs.readFile('src/useProjectChats.ts','utf8'),panel=await fs.readFile('src/components/AiPanel.tsx','utf8');
  assert.doesNotMatch(hook,/JSON\.stringify\(merged\)!==JSON\.stringify\(remote\.data\)\|\|pending\.current/,'receive() must not save just because the merged view differs');
  assert.match(hook,/if\(pending\.current\)await flush\(\);/);
  assert.match(panel,/useProjectChats\(projectId, \(\) => baseRef\.current as PersistedChat/,'saves read the persisted base, not the reconciled view');
  assert.match(panel,/\}\) \}\), true, false\);\s*openedWithHistory\.current = true;/,'model normalisation on load does not save');
  assert.doesNotMatch(panel,/commit\(state => \(\{ \.\.\.state, conversations \}\)\)/,'the run reconciliation effect no longer commits');
  assert.match(hook,/if\(chatsEqual\(snapshot,baseline\.current\)\)break;/,'flush compares with key-sorted canonical JSON');
  assert.match(hook,/if\(loaded\.current&&chatsEqual\(latest\.current\.read\(\),baseline\.current\)\)\{pending\.current=false;return;\}/,'queue must not set pending when content is unchanged');
  assert.match(panel,/clearTimeout\(persistTimer\.current\); persist\(\);/,'leaving the panel still persist()s; queue is a no-op if unchanged');
});

test('键序不同但内容相同: canonical compare ignores object key order and keeps array order',()=>{
  const file=saved();
  const put={version:1 as const,conversations:file.conversations,selectedId:file.selectedId};
  assert.notEqual(JSON.stringify(put),JSON.stringify(file),'raw stringify is key-order sensitive');
  assert.equal(chatsEqual(put,file),true);
  assert.equal(chatsEqual({a:[{c:1,b:2},1]},{a:[{b:2,c:1},1]}),true,'nested object keys are sorted');
  assert.equal(chatsEqual({a:[1,2]},{a:[2,1]}),false,'array order is significant');
});

test('开面板后离开不 PUT: restore/merge key order plus a reordered PUT must not write',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'chat-leave-'));
  for(const template of ['english'])await fs.mkdir(path.join(root,'shared','templates',template),{recursive:true});
  await fs.writeFile(path.join(root,'shared','templates','english','main.tex'),'\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n');
  await fs.mkdir(path.join(root,'papers'));
  const app=await createApp({workspaceRoot:root,buildService:fakeBuilds,watch:false});
  try{
    assert.equal((await app.inject({method:'POST',url:'/api/projects',payload:{id:'Alpha',title:'Alpha',template:'english'}})).statusCode,201);
    const url='/api/projects/Alpha/chats',file=path.join(root,'papers','Alpha','notes','ai-conversations.json');
    const first=await app.inject({method:'PUT',url,payload:{data:saved(),expectedHash:null}});assert.equal(first.statusCode,200,first.body);
    const remote=(await app.inject(url)).json();
    // Opening the panel: localStorage restore historically used {version,conversations,selectedId}.
    const snapshot={version:1 as const,conversations:remote.data.conversations,selectedId:remote.data.selectedId};
    const merged=mergeConversationSelection(remote.data,snapshot as typeof remote.data,undefined,null);
    assert.notEqual(JSON.stringify(snapshot),JSON.stringify(remote.data),'raw stringify still sees the historical key-order mismatch');
    assert.equal(chatsEqual(snapshot,remote.data),true,'flush must treat the loaded snapshot as unchanged');
    assert.equal(chatsEqual(merged,remote.data),true);
    // queue()/flush() therefore must not PUT. A stale flush that still PUTs is also a no-op on disk.
    const raw0=await fs.readFile(file,'utf8'),mtime0=(await fs.stat(file)).mtimeMs,digest0=sha256(raw0);
    await new Promise(r=>setTimeout(r,50));
    const stale=await app.inject({method:'PUT',url,payload:{data:snapshot,expectedHash:remote.hash}});
    assert.equal(stale.statusCode,200,stale.body);
    assert.equal('wrote' in stale.json(),false,'HTTP body must not expose the write flag');
    const raw1=await fs.readFile(file,'utf8');
    assert.equal(raw1,raw0);
    assert.equal(sha256(raw1),digest0);
    assert.equal((await fs.stat(file)).mtimeMs,mtime0,'identical normalised content must not bump mtime');
    // A real edit still writes.
    const edited=structuredClone(merged);edited.conversations[0].input='草稿';
    const changed=await app.inject({method:'PUT',url,payload:{data:edited,expectedHash:stale.json().hash||remote.hash}});
    assert.equal(changed.statusCode,200,changed.body);
    assert.notEqual(await fs.readFile(file,'utf8'),raw0);
  }finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});
