import test from'node:test';import assert from'node:assert/strict';import{conversationState,ensureActiveChat,mergeChats,type PersistedChat}from'../shared/chat-merge.ts';
const chat=(text:string,input=''):PersistedChat=>({version:1,selectedId:'c',conversations:[{id:'c',title:'t',createdAt:'2026-01-01',updatedAt:'2026-01-01',model:'MiniMax-M3.1-Flash',effort:'medium',input,messages:[{id:'m',role:'assistant',content:text,status:'complete',createdAt:'2026-01-01'}]}]});
test('chat merge preserves divergent histories and input drafts',()=>{const a=chat('remote','remote draft'),b=chat('local','local draft');const merged=mergeChats(a,b);assert.equal(merged.conversations.length,2);const c=merged.conversations.find(c=>c.id==='c')!;assert.equal(c.messages.length,2);assert.deepEqual(new Set(c.messages.map(m=>m.content)),new Set(['remote','local']));assert.equal(c.input,'local draft');assert.ok(merged.conversations.some(c=>c.input==='remote draft'));assert.deepEqual(mergeChats(merged,b),merged);});
test('streaming prefix merges keep complete longer answer without duplication',()=>{const merged=mergeChats(chat('finished response'),chat('finished'));assert.equal(merged.conversations[0].messages.length,1);assert.equal(merged.conversations[0].messages[0].content,'finished response');});

test('empty stale window does not erase a remote unsent draft',()=>{const merged=mergeChats(chat('answer','important unsent input'),chat('answer'));assert.equal(merged.conversations[0].input,'important unsent input');});
test('sending a remote draft does not resurrect it as unsent input',()=>{const remote=chat('answer','question');const local=chat('answer');local.conversations[0].messages.push({id:'user2',role:'user',content:'question',status:'complete',createdAt:'2026-02-01'});assert.equal(mergeChats(remote,local).conversations[0].input,'');});
test('an explicitly newer empty draft is kept empty instead of resurrecting deleted input',()=>{const remote=chat('answer','removed draft'),local=chat('answer');local.conversations[0].updatedAt='2026-02-01';assert.equal(mergeChats(remote,local).conversations[0].input,'');});

test('a stale window with newer messages cannot unarchive or undelete a server lifecycle revision',()=>{
 for(const state of ['archived','deleted']as const){
  const remote=chat('saved answer'),local=chat('saved answer','unsaved text remains recoverable');
  remote.conversations[0].lifecycle={state,revision:1,updatedAt:'2026-02-01T00:00:00Z'};
  local.conversations[0].updatedAt='2099-01-01T00:00:00Z';local.conversations[0].messages.push({id:'later',role:'user',content:'Newer local draft message',status:'complete',createdAt:'2099-01-01T00:00:00Z'});
  const merged=mergeChats(remote,local),hidden=merged.conversations.find(c=>c.id==='c')!;
  assert.equal(conversationState(hidden),state);assert.equal(hidden.lifecycle?.revision,1);assert.equal(hidden.input,local.conversations[0].input);assert.ok(hidden.messages.some(m=>m.id==='later'));
  assert.notEqual(merged.selectedId,'c');assert.equal(conversationState(merged.conversations.find(c=>c.id===merged.selectedId)!),'active');
 }
});

test('explicit restoration wins over an older tombstone independently of draft timestamps',()=>{
 const restored=chat('answer'),stale=chat('answer');
 restored.conversations[0].lifecycle={state:'active',revision:3,updatedAt:'2026-03-01T00:00:00Z'};
 stale.conversations[0].lifecycle={state:'deleted',revision:2,updatedAt:'2026-02-01T00:00:00Z'};stale.conversations[0].updatedAt='2099-01-01';
 for(const merged of[mergeChats(restored,stale),mergeChats(stale,restored)]){assert.equal(merged.selectedId,'c');assert.equal(conversationState(merged.conversations[0]),'active');assert.equal(merged.conversations[0].lifecycle?.revision,3);}
});

test('archiving the only conversation creates an independent blank selection without discarding the original',()=>{
 const original=chat('answer','saved draft');original.conversations[0].lifecycle={state:'archived',revision:1,updatedAt:'2026-02-01T00:00:00Z'};
 const result=ensureActiveChat(original),fresh=result.conversations.find(c=>c.id===result.selectedId)!;
 assert.equal(result.conversations.length,2);assert.notEqual(fresh.id,'c');assert.equal(fresh.model,original.conversations[0].model);assert.deepEqual(fresh.messages,[]);assert.equal(fresh.input,'');assert.equal(fresh.lifecycle,undefined);
 assert.equal(result.conversations.find(c=>c.id==='c')?.input,'saved draft');assert.equal(ensureActiveChat(result),result);
});

test('divergent drafts from a hidden conversation remain hidden during recovery',()=>{
 const remote=chat('answer','remote draft'),local=chat('answer','local draft');remote.conversations[0].lifecycle={state:'deleted',revision:5,updatedAt:'2026-02-01T00:00:00Z'};
 const merged=mergeChats(remote,local),recovered=merged.conversations.find(c=>c.title.startsWith('草稿恢复'))!;
 assert.equal(recovered.input,'remote draft');assert.equal(conversationState(recovered),'deleted');assert.ok(merged.conversations.filter(c=>conversationState(c)==='active').every(c=>!c.messages.length&&!c.input));
});

test('save acknowledgements and untouched peer windows do not create false draft recovery conversations',()=>{
 const base=chat('answer','earlier draft'),typed=chat('answer','latest typed draft');typed.conversations[0].updatedAt='2026-03-01';
 const acknowledged=mergeChats(base,typed,base);assert.equal(acknowledged.conversations.length,1);assert.equal(acknowledged.conversations[0].input,'latest typed draft');
 const untouchedPeer=mergeChats(typed,base,base);assert.equal(untouchedPeer.conversations.length,1);assert.equal(untouchedPeer.conversations[0].input,'latest typed draft');
 const cleared=chat('answer');assert.equal(mergeChats(base,cleared,base).conversations[0].input,'');
});

test('three-way draft comparison still preserves actual concurrent changes in both windows',()=>{
 const base=chat('answer','original draft'),remote=chat('answer','remote edit'),local=chat('answer','local edit');
 const merged=mergeChats(remote,local,base);assert.equal(merged.conversations.length,2);assert.equal(merged.conversations.find(c=>c.id==='c')?.input,'local edit');assert.ok(merged.conversations.some(c=>c.input==='remote edit'&&c.title.startsWith('草稿恢复')));
});
