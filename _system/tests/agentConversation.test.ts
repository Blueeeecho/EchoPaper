import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun, AgentRunDetail, RunEvent } from '../shared/agent-types.ts';
import type { PersistedConversation, PersistedMessage } from '../shared/chat-merge.ts';
import { chatMessages, contextFingerprint, resolveContext, type ContextCheckpoint } from '../shared/ai-context.ts';
import { conversationHead, coordinatorReply, createAgentConversation, mergeConversationSelection, reconcileAgentConversation, runHasOperations } from '../src/agentConversation.ts';

const message = (id: string, role: 'user' | 'assistant', content: string): PersistedMessage => ({ id, role, content, status: 'complete', createdAt: '2026-10-23T00:00:00Z' });
const conversation = (messages: PersistedMessage[]): PersistedConversation => ({ id: 'conversation', title: '原对话', input: '待发送草稿', model: 'chosen-model', effort: 'medium', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', messages });
const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({ id: 'run-1', conversationId: 'conversation', input: '创建 notes/proof.md', modelId: 'chosen-model', status: 'completed', phase: 'completed', createdAt: '2026-10-23T00:00:01Z', updatedAt: '2026-10-23T00:00:02Z', summary: '旧摘要', reply: '笔记已创建。', changesets: [], children: [], buildIds: [], ...overrides } as AgentRun);
const legacyContext = (messages: PersistedMessage[], checkpoint?: ContextCheckpoint) => resolveContext(chatMessages(messages), checkpoint).messages.map(({ role, content }) => ({ role, content }));

test('legacy context remains readable for estimates with snapshots, without tool or reasoning fields', () => {
  const messages = [
    { ...message('u', 'user', '创建笔记'), taskId: 'run-1', attachment: { path: 'notes/proof.md', content: '原稿内容' } },
    { ...message('a', 'assistant', '笔记已创建。'), taskId: 'run-1', reasoning_content: 'private reasoning' },
    { ...message('pending', 'assistant', ''), status: 'streaming' as const },
  ];
  const history = legacyContext(messages);
  assert.equal(history.length, 2);
  assert.match(history[0].content, /notes\/proof.md/); assert.match(history[0].content, /原稿内容/);
  assert.deepEqual(history[1], { role: 'assistant', content: '笔记已创建。' });
  assert.ok(history.every(item => Object.keys(item).sort().join(',') === 'content,role'));
});

test('a valid continuity checkpoint replaces its exact historical prefix while retaining recent corrections', () => {
  const messages = [message('1', 'user', '创建 notes/proof.md'), message('2', 'assistant', '已创建'), message('3', 'user', '把刚才笔记改为第二版'), message('4', 'assistant', '已修改')];
  const checkpoint: ContextCheckpoint = { id: 'c', summary: '已创建并确认 notes/proof.md，不能修改正文。', throughMessageId: '2', sourceFingerprint: contextFingerprint(chatMessages(messages.slice(0, 2))), messageCount: 2, createdAt: '2026-10-23T00:00:00Z', model: 'chosen-model', beforeTokens: 100, afterTokens: 50, round: 1 };
  const history = legacyContext(messages, checkpoint);
  assert.equal(history.length, 3); assert.match(history[0].content, /不能修改正文/); assert.equal(history[1].content, '把刚才笔记改为第二版'); assert.equal(history[2].content, '已修改');
  const corrected = [{ ...messages[0], content: '后来纠正的文件路径' }, ...messages.slice(1)];
  assert.equal(legacyContext(corrected, checkpoint).length, 4);
});

test('a server head comes from the latest linked user or answer without dropping long saved history', () => {
  const messages = Array.from({ length: 101 }, (_, index) => message(String(index), index % 2 ? 'assistant' : 'user', `不可遗漏的历史 ${index}`));
  assert.equal(conversationHead(messages), null);
  messages[98].taskId = 'previous-run'; messages[99].taskId = 'latest-run';
  assert.equal(conversationHead(messages), 'latest-run');
  messages[100].taskId = 'latest-user-run';
  assert.equal(conversationHead(messages), 'latest-user-run');
  assert.equal(messages.length, 101); assert.equal(messages[0].content, '不可遗漏的历史 0');
  assert.equal(conversationHead([]), null);
});

test('refresh recovers a durable natural answer once and preserves the conversation draft and model', () => {
  const before = conversation([]), restored = reconcileAgentConversation(before, [run()]);
  assert.equal(restored.messages.length, 2); assert.equal(restored.messages[1].content, '笔记已创建。');
  assert.equal(restored.messages[0].taskId, 'run-1'); assert.equal(restored.messages[1].taskId, 'run-1');
  assert.equal(restored.input, before.input); assert.equal(restored.model, 'chosen-model');
  assert.equal(reconcileAgentConversation(restored, [run()]), restored);
  assert.equal(before.messages.length, 0);
});

test('a legacy task link recovers its reply without duplicating its existing user message', () => {
  const before = conversation([{ ...message('legacy-id', 'user', '当时的请求'), taskId: 'run-1' }]);
  const restored = reconcileAgentConversation(before, [run({ conversationId: undefined, reply: undefined })]);
  assert.equal(restored.messages.length, 2); assert.equal(restored.messages[0].id, 'legacy-id'); assert.equal(restored.messages[1].content, '旧摘要');
  assert.equal(reconcileAgentConversation(before, [run({ id: 'other', conversationId: 'other-conversation' })]), before);
});

test('a pending reply becomes a final answer after reconnect, and an older error clears after successful resume', () => {
  const pending = reconcileAgentConversation(conversation([]), [run({ status: 'running', reply: undefined, summary: '', error: '旧错误' })]);
  assert.equal(pending.messages[1].status, 'streaming');
  const complete = reconcileAgentConversation(pending, [run()]);
  assert.equal(complete.messages[1].status, 'complete'); assert.equal(complete.messages[1].error, undefined); assert.equal(complete.messages[1].content, '笔记已创建。');
});

test('ordinary natural answers have no operation card; actual read tools, child work and changes do', () => {
  assert.equal(runHasOperations(run()), false);
  assert.equal(runHasOperations(run(), { run: run(), tools: [{ id: 'read' }], events: [] } as unknown as AgentRunDetail), true);
  assert.equal(runHasOperations(run({ children: [{ id: 'child' } as any] })), true);
  assert.equal(runHasOperations(run({ buildIds: ['precise-build'] })), true);
});

test('only the latest main-agent text streams into chat; child output stays in its operation record and the final reply wins', () => {
  const events = [
    { seq: 1, agentId: 'coordinator', type: 'model.started', data: {} },
    { seq: 2, agentId: 'coordinator', type: 'model.delta', data: { text: '先检查文件' } },
    { seq: 3, agentId: 'child-id', type: 'model.delta', data: { text: '子角色内部输出' } },
    { seq: 4, agentId: 'coordinator', type: 'model.started', data: {} },
    { seq: 5, agentId: 'coordinator', type: 'model.delta', data: { text: '已经创建' } },
    { seq: 6, agentId: 'coordinator', type: 'model.delta', data: { text: '笔记。' } },
  ] as RunEvent[];
  assert.equal(coordinatorReply(events), '已经创建笔记。');
  const running = run({ status: 'running', reply: undefined, summary: '' });
  const detail = { run: running, events, tools: [] };
  const streamed = reconcileAgentConversation(conversation([]), [running], { 'run-1': detail });
  assert.equal(streamed.messages[1].content, '已经创建笔记。');
  const final = reconcileAgentConversation(streamed, [run({ reply: '最终证据与回复。' })], { 'run-1': detail });
  assert.equal(final.messages[1].content, '最终证据与回复。');
});

test('a recovered streaming draft does not duplicate the final task-linked answer after chat-store reconciliation', () => {
  const before = conversation([
    { ...message('u', 'user', '创建笔记'), taskId: 'run-1' },
    { ...message('a', 'assistant', '已创建'), taskId: 'run-1' },
    { ...message('a-recovered-prefix', 'assistant', '我将先检查'), taskId: 'run-1', status: 'stopped' },
  ]);
  const after = reconcileAgentConversation(before, [run()]);
  assert.equal(after.messages.length, 2); assert.equal(after.messages[1].id, 'a'); assert.equal(after.messages[1].content, '笔记已创建。');
});

test('an SSE snapshot before the POST response binds the optimistic pair by requestId without guessing repeated text', () => {
  const before = conversation([
    message('prior-user', 'user', '同一句请求'), message('prior-answer', 'assistant', '原答复'),
    message('request-id', 'user', '同一句请求'), { ...message('optimistic-answer', 'assistant', ''), status: 'streaming' },
  ]);
  const snapshot = run({ requestId: 'request-id', status: 'running', reply: undefined, summary: '' });
  const streamed = reconcileAgentConversation(before, [snapshot]);
  assert.equal(streamed.messages.length, 4); assert.equal(streamed.messages[0].taskId, undefined);
  assert.equal(streamed.messages[2].id, 'request-id'); assert.equal(streamed.messages[2].taskId, 'run-1');
  assert.equal(streamed.messages[3].id, 'optimistic-answer'); assert.equal(streamed.messages[3].taskId, 'run-1');
  const completed = reconcileAgentConversation(streamed, [run({ requestId: 'request-id' })]);
  assert.equal(completed.messages.length, 4); assert.equal(completed.messages[3].content, '笔记已创建。');
  assert.equal(reconcileAgentConversation(completed, [run({ requestId: 'request-id' })]), completed);
});

test('a new conversation owns a fresh id, draft and history without carrying prior attachments or checkpoints', () => {
  const first = createAgentConversation('chosen-model', 'high');
  first.messages.push({ ...message('secret', 'user', '测试暗号 BLUE-ORCHID'), attachment: { path: 'notes/a.md', content: '仅属于 A' } });
  first.input = 'A 的未发送草稿'; first.contextState = { summary: '旧摘要' } as ContextCheckpoint;
  first.contextUsage = { tokens: 1000 } as any;
  const next = createAgentConversation('chosen-model', 'high');
  assert.notEqual(next.id, first.id); assert.notEqual(next.messages, first.messages); assert.deepEqual(legacyContext(next.messages, next.contextState), []); assert.equal(conversationHead(next.messages), null);
  assert.equal(next.input, ''); assert.equal(next.contextState, undefined); assert.equal(next.contextUsage, undefined); assert.equal('compactionId' in next, false);
  assert.equal(first.input, 'A 的未发送草稿'); assert.equal(first.messages[0].attachment.content, '仅属于 A');
});

test('initial remote history wins over an automatic blank draft, while an explicitly selected empty conversation survives synchronization', () => {
  const old = createAgentConversation('chosen-model'), next = createAgentConversation('chosen-model');
  const remote = { version: 1 as const, selectedId: old.id, conversations: [old] };
  const local = { version: 1 as const, selectedId: next.id, conversations: [next] };
  assert.equal(mergeConversationSelection(remote, local).selectedId, old.id);
  const explicit = mergeConversationSelection(remote, local, next.id);
  assert.equal(explicit.selectedId, next.id); assert.ok(explicit.conversations.some(item => item.id === old.id)); assert.ok(explicit.conversations.some(item => item.id === next.id));
  assert.equal(mergeConversationSelection(remote, explicit, next.id).selectedId, next.id);
});

test('a preferred selection cannot bring a remotely archived or deleted conversation back into the composer', () => {
  for (const state of ['archived', 'deleted'] as const) {
    const old = conversation([message('user', 'user', '保留的历史')]), next = createAgentConversation('chosen-model');
    const remote = { version: 1 as const, selectedId: next.id, conversations: [{ ...old, lifecycle: { state, revision: 1, updatedAt: '2026-10-24T00:00:00Z' } }, next] };
    const local = { version: 1 as const, selectedId: old.id, conversations: [old] };
    const merged = mergeConversationSelection(remote, local, old.id);
    assert.equal(merged.selectedId, next.id); assert.equal(merged.conversations.find(c => c.id === old.id)?.lifecycle?.state, state);
    assert.equal(merged.conversations.filter(c => c.id === old.id).length, 1);
  }
});

test('run recovery does not repopulate a conversation in the recycle bin', () => {
  const deleted = { ...conversation([]), lifecycle: { state: 'deleted' as const, revision: 1, updatedAt: '2026-10-24T00:00:00Z' } };
  assert.equal(reconcileAgentConversation(deleted, [run()]), deleted);
  assert.deepEqual(deleted.messages, []);
});

test('restored server backups override cached lifecycle revisions while preserving unsent browser text', () => {
  const old = conversation([message('user', 'user', '已备份消息')]);
  const cached = { ...old, input: '备份之后的未发送草稿', updatedAt: '2026-10-24T01:00:00Z', lifecycle: { state: 'deleted' as const, revision: 7, updatedAt: '2026-10-24T01:00:00Z' } };
  const remote = { version: 1 as const, selectedId: old.id, conversations: [old] };
  const merged = mergeConversationSelection(remote, { version: 1, selectedId: cached.id, conversations: [cached] }, cached.id);
  const restored = merged.conversations.find(c => c.id === old.id)!;
  assert.equal(merged.selectedId, old.id); assert.equal(restored.lifecycle, undefined); assert.equal(restored.input, cached.input);
});

test('a run with an explicit owner cannot hydrate another conversation, even when an imported legacy link points at it', () => {
  const other = { ...conversation([{ ...message('foreign', 'user', '引用旧任务'), taskId: 'run-1' }]), id: 'new-conversation' };
  const unchanged = reconcileAgentConversation(other, [run()]); assert.equal(unchanged, other); assert.equal(other.messages.length, 1);
  const fresh = { ...conversation([]), id: 'new-conversation' };
  assert.equal(reconcileAgentConversation(fresh, [run()]), fresh); assert.deepEqual(legacyContext(fresh.messages), []);
});

test('turn invocations survive interleaved compaction and child events, even when they share the coordinator id', () => {
  const events = [
    { seq: 1, agentId: 'coordinator', type: 'model.started', data: { purpose: 'turn', invocationId: 'main' } },
    { seq: 2, agentId: 'coordinator', type: 'model.delta', data: { purpose: 'turn', invocationId: 'main', text: '自然回答' } },
    { seq: 3, agentId: 'coordinator', type: 'model.started', data: { purpose: 'compaction', invocationId: 'compact' } },
    { seq: 4, agentId: 'coordinator', type: 'model.delta', data: { purpose: 'compaction', invocationId: 'compact', text: '内部摘要不可见' } },
    { seq: 5, agentId: 'coordinator', type: 'model.completed', data: { purpose: 'compaction', invocationId: 'compact' } },
    { seq: 6, agentId: 'coordinator', type: 'model.completed', data: { purpose: 'child', invocationId: 'child', text: '子角色内部答复' } },
    { seq: 7, agentId: 'coordinator', type: 'model.completed', data: { purpose: 'turn', invocationId: 'main', phase: 'answer', hasToolCalls: false, toolCallCount: 0, text: '完整自然答复。' } },
  ] as RunEvent[];
  assert.equal(coordinatorReply(events.slice(0, 6)), '自然回答');
  assert.equal(coordinatorReply([...events].reverse()), '完整自然答复。');
});

test('completed tool commentary is removed from the answer and a later invocation owns its own text', () => {
  const events = [
    { seq: 1, agentId: 'coordinator', type: 'model.started', data: { purpose: 'turn', invocationId: 'first' } },
    { seq: 2, agentId: 'coordinator', type: 'model.delta', data: { purpose: 'turn', invocationId: 'first', text: '我先检查项目。' } },
    { seq: 3, agentId: 'coordinator', type: 'model.completed', data: { purpose: 'turn', invocationId: 'first', phase: 'commentary', hasToolCalls: true, toolCallCount: 1, text: '我先检查项目。' } },
    { seq: 4, agentId: 'coordinator', type: 'model.started', data: { purpose: 'turn', invocationId: 'second' } },
    { seq: 5, agentId: 'coordinator', type: 'model.delta', data: { purpose: 'turn', invocationId: 'second', text: '检查结果' } },
    { seq: 6, agentId: 'coordinator', type: 'model.delta', data: { purpose: 'turn', invocationId: 'first', text: '迟到的过程说明' } },
    { seq: 7, agentId: 'coordinator', type: 'model.completed', data: { purpose: 'turn', invocationId: 'second', phase: 'answer', hasToolCalls: false, text: '已找到具体问题。' } },
  ] as RunEvent[];
  assert.equal(coordinatorReply(events.slice(0, 2)), '我先检查项目。');
  assert.equal(coordinatorReply(events.slice(0, 3)), '');
  assert.equal(coordinatorReply(events.slice(0, 6)), '检查结果');
  assert.equal(coordinatorReply(events), '已找到具体问题。');
  const interrupted = run({ status: 'interrupted', reply: undefined, summary: '内部执行摘要' });
  const reconciled = reconcileAgentConversation(conversation([]), [interrupted], { 'run-1': { run: interrupted, events: events.slice(0, 3), tools: [] } });
  assert.equal(reconciled.messages[1].content, '');
});

test('an explicit final reply, including an empty one, is authoritative over stream and operation summary', () => {
  const events = [{ seq: 1, agentId: 'coordinator', type: 'model.completed', data: { purpose: 'turn', invocationId: 'main', phase: 'answer', text: '临时答案' } }] as RunEvent[];
  for (const reply of ['最终自然答复', '']) {
    const complete = run({ reply, summary: '内部操作摘要' });
    const result = reconcileAgentConversation(conversation([]), [complete], { 'run-1': { run: complete, events, tools: [] } });
    assert.equal(result.messages[1].content, reply);
  }
});
