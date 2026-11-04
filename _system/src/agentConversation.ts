import type { AgentRun, AgentRunDetail, RunEvent } from '../shared/agent-types';
import { conversationState, mergeChats, type PersistedChat, type PersistedConversation, type PersistedMessage } from '../shared/chat-merge';

export const runIsActive = (run?: AgentRun) => !!run && ['queued', 'running', 'waiting_confirmation', 'cancelling'].includes(run.status);

export function createAgentConversation(model = '', effort = 'medium'): PersistedConversation {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), title: '新对话', createdAt: now, updatedAt: now, messages: [], input: '', model, effort };
}

/** An explicit local choice also matters when the newly opened conversation is still empty. */
export function mergeConversationSelection(remote: PersistedChat | null, local: PersistedChat, preferredId?: string, baseline?: PersistedChat | null): PersistedChat {
  // The client never creates lifecycle revisions. A restored backup may legitimately
  // contain an older revision, so the live server also owns that comparison.
  const authoritative = new Map(remote?.conversations.map(item => [item.id, item]));
  const aligned = { ...local, conversations: local.conversations.map(item => {
    const saved = authoritative.get(item.id);
    if (!saved) return item;
    const { lifecycle: _cached, ...fields } = item;
    return { ...fields, ...(saved.lifecycle ? { lifecycle: saved.lifecycle } : {}) };
  }) };
  const merged = mergeChats(remote, aligned, baseline), selected = preferredId && aligned.conversations.find(item => item.id === preferredId);
  if (!selected || conversationState(selected) !== 'active') return merged;
  const mergedSelection = merged.conversations.find(item => item.id === selected.id);
  if (mergedSelection && conversationState(mergedSelection) !== 'active') return merged;
  return { ...merged, selectedId: selected.id, conversations: merged.conversations.some(item => item.id === selected.id) ? merged.conversations : [selected, ...merged.conversations] };
}

/** The server owns history; the client supplies only its last observed run head. */
export function conversationHead(messages: PersistedMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index].taskId) return messages[index].taskId!;
  return null;
}
export function runHasOperations(run?: AgentRun, detail?: AgentRunDetail) {
  return !!run && !!(run.children.length || run.changesets.length || run.buildIds.length || run.pendingDecision || detail?.tools.length);
}
export function coordinatorReply(events: RunEvent[]): string | undefined {
  const invocations = new Map<string, { text: string; phase?: 'commentary' | 'answer' }>();
  let latest: string | undefined, legacy: string | undefined;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!['model.started', 'model.delta', 'model.completed'].includes(event.type)) continue;
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
    if (data.purpose !== undefined ? data.purpose !== 'turn' || event.agentId && event.agentId !== 'coordinator' : event.agentId !== 'coordinator') continue;
    let id = typeof data.invocationId === 'string' ? data.invocationId : undefined;
    if (!id) {
      if (event.type === 'model.started' || !legacy) legacy = `legacy:${event.seq}`;
      id = legacy;
    }
    if (!invocations.has(id)) { invocations.set(id, { text: '' }); latest = id; }
    const invocation = invocations.get(id)!;
    if (event.type === 'model.started') latest = id;
    if (event.type === 'model.delta' && invocation.phase === undefined && typeof data.text === 'string') invocation.text += data.text;
    if (event.type === 'model.completed') {
      invocation.phase = data.phase === 'commentary' || data.hasToolCalls === true || typeof data.toolCallCount === 'number' && data.toolCallCount > 0 ? 'commentary' : 'answer';
      if (typeof data.text === 'string') invocation.text = data.text;
    }
  }
  const current = latest === undefined ? undefined : invocations.get(latest);
  return current === undefined ? undefined : current.phase === 'commentary' ? '' : current.text;
}

/** Idempotent recovery from the durable runner, including a reply received while the panel was closed. */
export function reconcileAgentConversation<T extends PersistedConversation>(conversation: T, runs: AgentRun[], details: Record<string, AgentRunDetail> = {}): T {
  if (conversationState(conversation) === 'deleted') return conversation;
  let messages = conversation.messages;
  const relevant = runs.filter(run => run.conversationId ? run.conversationId === conversation.id : messages.some(message => message.taskId === run.id || message.role === 'user' && message.id === run.requestId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const replace = (index: number, next: PersistedMessage) => {
    if (JSON.stringify(messages[index]) === JSON.stringify(next)) return;
    if (messages === conversation.messages) messages = [...messages];
    messages[index] = next;
  };
  const append = (message: PersistedMessage) => { if (messages === conversation.messages) messages = [...messages]; messages.push(message); };
  for (const run of relevant) {
    const optimistic = messages.findIndex(message => message.role === 'user' && message.id === run.requestId && (!message.taskId || message.taskId === run.id));
    if (optimistic >= 0) {
      replace(optimistic, { ...messages[optimistic], taskId: run.id, ...(run.attachments?.length?{attachments:run.attachments}:{}) });
      const response = messages[optimistic + 1];
      if (response?.role === 'assistant' && !response.taskId) replace(optimistic + 1, { ...response, taskId: run.id });
    }
    // Remote draft merging can retain a streamed prefix as a recovered copy.
    // A durable run has one user request and one authoritative assistant reply.
    const seen = new Set<string>();
    const unique = messages.filter(message => {
      if (message.taskId !== run.id) return true;
      if (seen.has(message.role)) return false;
      seen.add(message.role); return true;
    });
    if (unique.length !== messages.length) messages = unique;
    if (!messages.some(message => message.taskId === run.id && message.role === 'user')) append({ id: `agent-user-${run.id}`, role: 'user', taskId: run.id, content: run.input, status: 'complete', createdAt: run.createdAt, ...(run.attachments?.length?{attachments:run.attachments}:{}) });
    const index = messages.findIndex(message => message.taskId === run.id && message.role === 'assistant');
    const status = runIsActive(run) ? 'streaming' : run.status === 'completed' ? 'complete' : run.status === 'failed' || run.status === 'budget_exceeded' ? 'error' : 'stopped';
    const existing = index < 0 ? undefined : messages[index];
    const events = details[run.id]?.events || [], streamed = coordinatorReply(events);
    const typedTurn = events.some(event => event.data && typeof event.data === 'object' && (event.data as { purpose?: unknown }).purpose === 'turn');
    const fallback = run.reply !== undefined ? run.reply : run.summary || existing?.content || '';
    const content = runIsActive(run) ? streamed !== undefined ? streamed : fallback : run.reply !== undefined ? run.reply : typedTurn ? streamed || '' : fallback;
    const next: PersistedMessage = { ...existing, id: existing?.id || `agent-assistant-${run.id}`, role: 'assistant', taskId: run.id, content, status, createdAt: existing?.createdAt || run.createdAt, model: run.modelId, error: run.error };
    if (index < 0) append(next); else replace(index, next);
  }
  return messages === conversation.messages ? conversation : { ...conversation, messages, updatedAt: relevant.reduce((latest, run) => run.updatedAt > latest ? run.updatedAt : latest, conversation.updatedAt) };
}
