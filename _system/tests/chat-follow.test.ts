import {test} from 'node:test';import assert from 'node:assert/strict';import {visibleChat,shouldFollowChat} from '../src/chat-follow';
import type {PersistedMessage} from '../shared/chat-merge';
const message={id:'a',taskId:'run',role:'assistant',content:'one',status:'streaming',createdAt:'now'} as PersistedMessage;
test('only selected visible content follows from a prior bottom position',()=>{
 const before=visibleChat('selected',[message]),same=visibleChat('selected',[{...message,status:'complete'}]);assert.equal(shouldFollowChat(before,same,true),false);
 const stream=visibleChat('selected',[{...message,content:'one two'}]);assert.equal(shouldFollowChat(before,stream,true),true);assert.equal(shouldFollowChat(before,stream,false),false);
 assert.equal(shouldFollowChat(before,visibleChat('selected',[message]),true),false); // draft or another conversation changes nothing visible
 assert.equal(shouldFollowChat(before,visibleChat('other',[message]),false),false);
});
