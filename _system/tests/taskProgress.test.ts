import test from 'node:test';
import assert from 'node:assert/strict';
import { isTaskProgressQuestion, taskProgressReply } from '../src/taskProgress';
import type { AgentRun } from '../shared/agent-types';

test('standalone progress questions use current facts while correction requests remain on the writing path', () => {
  for (const input of ['现在到哪了？', '请问现在进度怎么样？', '麻烦问一下目前任务的进度如何', '现在工作做到哪一步了', '目前进度如何', '还在运行吗', 'What is the current status?']) assert.equal(isTaskProgressQuestion(input), true, input);
  for (const input of ['现在到哪了，顺便把图改黑色', '把进度写进笔记', '为什么编译报错', '先暂停然后解释']) assert.equal(isTaskProgressQuestion(input), false, input);
  const run = { status: 'running', phase: '读取相关源码', changesets: [{status:'applied',images:[]},{status:'proposed',images:[]}], buildIds: ['b'] } as unknown as AgentRun;
  assert.match(taskProgressReply(run), /已应用 1 组修改/);
  assert.match(taskProgressReply(run), /任务继续执行/);
  assert.equal(run.status, 'running');
  assert.match(taskProgressReply({...run,status:'waiting_confirmation'}), /等待审阅建议/);
  const partial = taskProgressReply({...run,status:'completed',outcome:'partial'});
  assert.match(partial, /部分完成/);
  assert.ok(!partial.includes('当前任务已完成'));
});

test('legacy completed records keep progress consistent with failed, proposed and undone changes', () => {
  const expected = {
    failed: '部分完成',
    conflicted: '部分完成',
    proposed: '建议未应用',
    undone: '已撤销',
  };
  for (const [status, label] of Object.entries(expected)) {
    const run = {
      status: 'completed', phase: '已完成', outcome: 'resolved',
      changesets: [{status, images: [], operations: []}], buildIds: [],
    } as unknown as AgentRun;
    const reply = taskProgressReply(run);
    assert.match(reply, new RegExp(`^当前${label}。`), status);
    assert.ok(!reply.includes('当前已完成'), status);
    assert.ok(!reply.includes('当前任务已完成'), status);
  }
});
