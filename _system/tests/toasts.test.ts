import test from 'node:test';
import assert from 'node:assert/strict';
import {createToastQueue,type Toast} from '../src/useToasts';

test('ordinary save notifications automatically disappear after 4.5 seconds',context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 let visible:Toast[]=[];
 const queue=createToastQueue(next=>{visible=next;});
 context.after(()=>queue.dispose());
 queue.notify('记录已保存');
 assert.equal(visible.length,1);
 context.mock.timers.tick(4499);assert.equal(visible.length,1);
 context.mock.timers.tick(1);assert.deepEqual(visible,[]);
});

test('repeated saves merge into one notification and renew its expiry',context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 let visible:Toast[]=[];
 const queue=createToastQueue(next=>{visible=next;});
 context.after(()=>queue.dispose());
 queue.notify('记录已保存');const id=visible[0].id;
 context.mock.timers.tick(2000);
 queue.notify('记录已保存');
 assert.equal(visible.length,1);assert.equal(visible[0].id,id);
 context.mock.timers.tick(2500);assert.equal(visible.length,1);
 context.mock.timers.tick(1999);assert.equal(visible.length,1);
 context.mock.timers.tick(1);assert.deepEqual(visible,[]);
});

test('explicit error notifications retain the existing nine-second duration',context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 let visible:Toast[]=[];
 const queue=createToastQueue(next=>{visible=next;});
 context.after(()=>queue.dispose());
 queue.notify('记录已保存');queue.notify('服务器连接失败',true);
 context.mock.timers.tick(4500);
 assert.deepEqual(visible.map(toast=>toast.message),['服务器连接失败']);
 context.mock.timers.tick(4499);assert.equal(visible.length,1);
 context.mock.timers.tick(1);assert.deepEqual(visible,[]);
});

test('manual dismissal and queue eviction cancel their expiry callbacks',context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const updates:Toast[][]=[];
 const queue=createToastQueue(next=>updates.push(next));
 context.after(()=>queue.dispose());
 for(let index=1;index<=5;index++)queue.notify(`通知 ${index}`);
 const visible=updates.at(-1)!;
 assert.deepEqual(visible.map(toast=>toast.message),['通知 2','通知 3','通知 4','通知 5']);
 queue.dismiss(visible[3].id);
 const count=updates.length;
 context.mock.timers.tick(4500);
 assert.deepEqual(updates.at(-1),[]);
 assert.equal(updates.length,count+3);
});

test('disposing the queue clears timers and rejects late component callbacks',context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const updates:Toast[][]=[];
 const queue=createToastQueue(next=>updates.push(next));
 queue.notify('记录已保存');const id=updates[0][0].id;
 queue.dispose();
 context.mock.timers.tick(10000);
 queue.notify('延迟保存完成');queue.dismiss(id);
 assert.equal(updates.length,1);
});
