import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun, AgentRunDetail, RunEvent, ToolCall } from '../shared/agent-types.ts';
import { mergeTaskDetail, mergeTaskEvents, mergeTaskRuns } from '../src/useProjectTasks.ts';
const run = (id: string, version: number, status = 'running') => ({ id, version, status, createdAt: id } as AgentRun);
test('out of order task snapshots never regress a completed task to an earlier running version', () => {
  const completed = run('b', 4, 'completed');
  const result = mergeTaskRuns([completed, run('a', 1)], [run('b', 3), run('c', 1)]);
  assert.deepEqual(result.map(value => value.id), ['c', 'b', 'a']);
  assert.equal(result.find(value => value.id === 'b'), completed);
});
test('event replay merges duplicate sequence numbers and sorts out of order arrivals', () => {
  const event = (seq: number, type = 'tool.started') => ({ seq, runId: 'r', type } as RunEvent);
  const result = mergeTaskEvents([event(2), event(4)], [event(1), event(2, 'tool.completed'), event(3)]);
  assert.deepEqual(result.map(value => value.seq), [1, 2, 3, 4]); assert.equal(result[1].type, 'tool.completed');
});
test('a delayed detail response cannot erase a newer tool completion or a received event', () => {
  const previous: AgentRunDetail = { run: run('r', 4, 'completed'), events: [{ seq: 3 } as RunEvent], tools: [{ id: 't', status: 'completed', result: 'saved' } as ToolCall] };
  const incoming: AgentRunDetail = { run: run('r', 3), events: [{ seq: 2 } as RunEvent], tools: [{ id: 't', status: 'running' } as ToolCall] };
  const merged = mergeTaskDetail(previous, incoming);
  assert.equal(merged.run.status, 'completed'); assert.equal(merged.tools[0].result, 'saved'); assert.deepEqual(merged.events.map(event => event.seq), [2, 3]);
});
