import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentModelGateway, readAgentCompletion } from '../server/agents/model-gateway';
import { createAgentRuntime } from '../server/agents/runtime';
import { createProviderRegistry, registryPath } from '../server/model-providers';
import { DEFAULT_AGENT_LIMITS, defaultAgentDefinitions } from '../shared/agent-types';

function sseStream(packets: unknown[]) {
  const payload = packets.map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('readAgentCompletion normalizes empty zero-arg tool arguments and null/empty continuation fields', async () => {
  const response = sseStream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_list', type: 'function', function: { name: 'list_', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: '', type: null, function: { name: 'files', arguments: '' } }] }, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]);
  const answer = await readAgentCompletion(response, 'test-model', () => {});
  assert.equal(answer.finishReason, 'tool_calls');
  assert.equal(answer.toolCalls.length, 1);
  assert.equal(answer.toolCalls[0].id, 'call_list');
  assert.equal(answer.toolCalls[0].function.name, 'list_files');
  assert.equal(answer.toolCalls[0].function.arguments, '{}');

  await assert.rejects(
    readAgentCompletion(sseStream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_bad', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ]), 'test-model', () => {}),
    /不完整|JSON/,
  );
});

test('createAgentModelGateway retries transient 529 once before streaming, and fails fast on 402 quota errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echopaper-gw-'));
  try {
    let attempts = 0;
    const registry = createProviderRegistry(root, { getKey: async () => 'sk-fixture-secret' });
    const { data } = await registry.read();
    const model = data.models[0];
    const provider = data.providers.find(p => p.id === model.providerId)!;

    const transientGateway = createAgentModelGateway(registry, {
      fetch: async () => {
        attempts++;
        if (attempts === 1) {
          return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 529, headers: { 'Content-Type': 'application/json' } });
        }
        return sseStream([{ choices: [{ delta: { content: 'Recovered ok' }, finish_reason: 'stop' }] }, '[DONE]']);
      },
    });
    const ok = await transientGateway({
      projectId: 'p1', provider, model,
      messages: [{ role: 'user', content: 'hi' }], tools: [],
      signal: new AbortController().signal,
      onReserve: () => {}, onSettled: () => {},
    });
    assert.equal(attempts, 2);
    assert.equal(ok.text, 'Recovered ok');

    let quotaAttempts = 0;
    const quotaGateway = createAgentModelGateway(registry, {
      fetch: async () => {
        quotaAttempts++;
        return new Response(JSON.stringify({ error: { message: 'Token Plan limit' } }), { status: 402, headers: { 'Content-Type': 'application/json' } });
      },
    });
    await assert.rejects(
      quotaGateway({
        projectId: 'p1', provider, model,
        messages: [{ role: 'user', content: 'hi' }], tools: [],
        signal: new AbortController().signal,
        onReserve: () => {}, onSettled: () => {},
      }),
      /额度已用尽/,
    );
    assert.equal(quotaAttempts, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('live follow-up with activeFile preload keeps assistant tool_calls paired with tool response', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echopaper-followup-preload-'));
  let runtime: Awaited<ReturnType<typeof createAgentRuntime>> | undefined;
  try {
    const projectRoot = path.join(root, 'papers', 'demo');
    await fs.mkdir(path.join(projectRoot, 'manuscript'), { recursive: true });
    const stamp = new Date().toISOString();
    await fs.writeFile(path.join(projectRoot, 'project.json'), JSON.stringify({
      id: 'demo', title: 'Demo Paper', stage: 'writing', createdAt: stamp, updatedAt: stamp,
      targets: [{ id: 'main', label: '主论文', main: 'manuscript/main.tex' }],
    }));
    await fs.writeFile(path.join(projectRoot, 'manuscript/main.tex'), '\\documentclass{article}\n\\begin{document}\nOld title and abstract.\n\\end{document}\n');
    const captured: Array<{ messages: Array<{ role: string; tool_calls?: { id: string }[]; tool_call_id?: string }> }> = [];
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstReady = new Promise<void>(r => { firstEntered = r; });

    await fs.mkdir(path.join(root, '_system/runtime'), { recursive: true });
    await fs.writeFile(path.join(root, registryPath), JSON.stringify({
      version: 2,
      providers: [{ id: 'test', label: 'Test', kind: 'openai-compatible', baseUrl: 'https://provider.invalid/v1', plan: 'test', auth: 'none', enabled: true, includeUsage: true, passReasoning: true }],
      models: [{ id: 'test-model', providerId: 'test', model: 'fixture', label: 'Fixture', contextWindow: 128000, reasoning: 'none', enabled: true, toolCalling: 'supported' }],
      assistant: { modelIds: ['test-model'], defaultModelId: 'test-model', roles: defaultAgentDefinitions().map(r => ({ ...r, enabled: true })), limits: { ...DEFAULT_AGENT_LIMITS } },
      translations: [],
      translationLayout: 'stack',
    }));
    const registry = createProviderRegistry(root, { getKey: async () => 'sk-fixture-secret' });
    const modelId = 'test-model';
    const builds = { list: async () => [], get: async () => { throw new Error('no builds'); }, cancel: async () => {}, request: async () => { throw new Error('no builds'); }, artifact: async () => '', listSubmissions: async () => [], createSubmission: async () => { throw new Error('no'); }, submissionArtifact: async () => '', close: async () => {} } as any;
    runtime = await createAgentRuntime(root, {
      registry,
      builds,
      emit: () => {},
      ai: {
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body || '{}'));
          captured.push(body);
          if (captured.length === 1) {
            firstEntered();
            return new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                let done = false;
                releaseFirst = () => {
                  if (done) return;
                  done = true;
                  controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'first' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'));
                  controller.close();
                };
                init?.signal?.addEventListener('abort', () => {
                  if (done) return;
                  done = true;
                  controller.error(new Error('aborted'));
                }, { once: true });
              },
            }), { headers: { 'Content-Type': 'text/event-stream' } });
          }
          return sseStream([{ choices: [{ delta: { content: 'Follow-up complete' }, finish_reason: 'stop' }] }, '[DONE]']);
        },
      },
    });

    const first = await runtime.create('demo', {
      requestId: 'req-1',
      conversationId: 'conv-1',
      expectedLastRunId: null,
      targetId: 'main',
      modelId,
      activeFile: 'manuscript/main.tex',
      input: '请把标题改成更简洁的版本。',
    });
    await firstReady;

    const second = await runtime.create('demo', {
      requestId: 'req-2',
      conversationId: 'conv-1',
      expectedLastRunId: first.id,
      followUpOf: first.id,
      targetId: 'main',
      modelId,
      activeFile: 'manuscript/main.tex',
      input: '顺便把摘要第一句也润色一下。',
    });
    releaseFirst?.();

    for (let i = 0; i < 80; i++) {
      const detail = await runtime.detail('demo', second.id);
      if (['completed', 'failed', 'cancelled'].includes(detail.run.status)) {
        assert.equal(detail.run.status, 'completed', detail.run.error || '');
        break;
      }
      await new Promise(r => setTimeout(r, 25));
    }

    assert.ok(captured.length >= 2);
    const secondMessages = captured[1].messages;
    const preloadAssistantIdx = secondMessages.findIndex(m => m.role === 'assistant' && m.tool_calls?.some(c => c.id === 'preload-open-file'));
    assert.ok(preloadAssistantIdx >= 0, 'preload assistant message should exist');
    assert.equal(secondMessages[preloadAssistantIdx + 1]?.role, 'tool', 'tool response must immediately follow assistant tool_calls');
    assert.equal(secondMessages[preloadAssistantIdx + 1]?.tool_call_id, 'preload-open-file');
  } finally {
    await runtime?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
