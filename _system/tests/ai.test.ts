import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { registerAiRoutes, type AiOptions } from '../server/ai.ts';
import{contextFingerprint}from'../shared/ai-context';

// This entire suite supplies its own credential provider and upstream transport.
// It never reads Keychain, uses a real API key, or sends traffic outside loopback.
const FAKE_KEY = 'sk-test-only-NOT-A-REAL-KEY-abcdefghijklmnopqrstuvwxyz';
const FLASH = 'MiniMax-M3.1-Flash';
const M3 = 'MiniMax-M3';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
interface CapturedRequest { url: string; init: RequestInit; body: Record<string, any>; signal: AbortSignal }
type Handler = (request: CapturedRequest) => Response | Promise<Response>;
type Event = { type: string; text?: string; error?: string; model?: string; usage?: Record<string, number>; reasoning_content?: string; finishReason?: string };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(value => { resolve = value; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('AI test timed out')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function until(predicate: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) { if (Date.now() - start > ms) throw new Error('Expected AI condition did not occur'); await pause(5); }
}
function packet(value: unknown): string { return `data: ${value === '[DONE]' ? '[DONE]' : JSON.stringify(value)}\r\n\r\n`; }
function responseFor(packets: unknown[], byteSize = 0): Response {
  const bytes = new TextEncoder().encode(packets.map(packet).join(''));
  const body = new ReadableStream<Uint8Array>({ start(controller) { if (!byteSize) controller.enqueue(bytes); else for (let i = 0; i < bytes.length; i += byteSize) controller.enqueue(bytes.subarray(i, i + byteSize)); controller.close(); } });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
function answer(text = '建议保留证据边界。'): Response { return responseFor([{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']); }
function events(response: { body: string }): Event[] { return response.body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
function controlledStream(signal: AbortSignal, firstText = '先收到的文字') {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const abort = () => { if (!ended) { ended = true; streamController.error(new DOMException('Mock upstream aborted', 'AbortError')); } };
  const body = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); else controller.enqueue(new TextEncoder().encode(packet({ choices: [{ delta: { content: firstText } }] }))); },
    cancel() { ended = true; signal.removeEventListener('abort', abort); },
  });
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    send(value: unknown) { if (!ended) streamController.enqueue(new TextEncoder().encode(packet(value))); },
    finish() { if (!ended) { streamController.enqueue(new TextEncoder().encode(packet('[DONE]'))); ended = true; streamController.close(); signal.removeEventListener('abort', abort); } },
  };
}
async function fixture(options: { key?: string; getKey?: () => Promise<string>; handler?: Handler; timeoutMs?: number;contextWindow?:number } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-workbench-ai-'));
  for (const id of ['DEMO', 'BETA', 'GAMMA']) {
    await fs.mkdir(path.join(root, 'papers', id, 'manuscript'), { recursive: true });
    await fs.writeFile(path.join(root, 'papers', id, 'project.json'), JSON.stringify({ schemaVersion: 1, id, title: id, stage: 'writing', venue: '', deadline: '', targets: [{ id: 'main', label: '论文', main: 'manuscript/main.tex' }], createdAt: '', updatedAt: '', autoCompile: false }));
    await fs.writeFile(path.join(root, 'papers', id, 'manuscript', 'main.tex'), 'ACTUAL_DISK_ONLY_CONTEXT');
  }
  await fs.mkdir(path.join(root,'_system/runtime'),{recursive:true});
  await fs.writeFile(path.join(root,'_system/runtime/ai-settings.json'),JSON.stringify({defaultModel:FLASH}));
  const app = Fastify({ logger: false, requestTimeout: 0, forceCloseConnections: true });
  app.setErrorHandler((error, _request, reply) => { const failure = error as Error & { statusCode?: number }; reply.code(failure.statusCode || 500).send({ error: failure.message }); });
  let handler = options.handler ?? (() => answer());
  const captured: CapturedRequest[] = [];
  const mockFetch: typeof fetch = async (input, init = {}) => {
    const request: CapturedRequest = { url: String(input), init, body: JSON.parse(String(init.body)), signal: init.signal! };
    captured.push(request);
    return handler(request);
  };
  const ai: AiOptions = { getKey: options.getKey ?? (async () => options.key ?? FAKE_KEY), fetch: mockFetch, timeoutMs: options.timeoutMs ?? 2000,contextWindow:options.contextWindow };
  await registerAiRoutes(app, root, ai);
  const payload = (extra: Record<string, unknown> = {}) => ({ projectId: 'DEMO', model: FLASH, messages: [{ role: 'user', content: '请检查论文逻辑。' }], ...extra });
  return { root, app, captured, payload, setHandler(value: Handler) { handler = value; }, async cleanup() { await app.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('unconfigured AI returns 503 and public configuration never exposes credentials', async () => {
  const f = await fixture({ key: '' });
  try {
    const config = await f.app.inject('/api/ai/config');
    assert.equal(config.statusCode, 200);
    assert.equal(config.json().configured, false);
    assert.ok(!/authorization|apiKey|accessToken/i.test(config.body));
    const result = await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload() });
    assert.equal(result.statusCode, 503);
    assert.equal(f.captured.length, 0);
    assert.match(result.body, /未找到|密钥|配置/);
  } finally { await f.cleanup(); }
  const configured = await fixture();
  try { const config = await configured.app.inject('/api/ai/config'); assert.equal(config.json().configured, true); assert.ok(!config.body.includes(FAKE_KEY)); }
  finally { await configured.cleanup(); }
});

test('default model uses revision protection, persists in v2 and ignores the legacy migration input afterwards', async () => {
 const f=await fixture();try{
  const initial=(await f.app.inject('/api/ai/config')).json();assert.equal(initial.defaultModel,FLASH);assert.deepEqual(initial.models.map((item:{id:string})=>item.id),[FLASH,M3]);
  assert.equal((await f.app.inject({method:'PUT',url:'/api/ai/config',payload:{defaultModel:M3}})).statusCode,409);
  const updated=await f.app.inject({method:'PUT',url:'/api/ai/config',payload:{expectedRevision:initial.revision,defaultModel:M3,apiKey:FAKE_KEY}});assert.equal(updated.statusCode,200,updated.body);assert.equal(updated.json().defaultModel,M3);
  const filename=path.join(f.root,'_system/runtime/model-providers.json'),saved=JSON.parse(await fs.readFile(filename,'utf8'));assert.equal(saved.version,2);assert.equal(saved.assistant.defaultModelId,M3);assert.ok(!JSON.stringify(saved).includes(FAKE_KEY));assert.equal((await fs.stat(filename)).mode&0o777,0o600);
  const second=Fastify();try{await registerAiRoutes(second,f.root,{getKey:async()=>'',fetch:async()=>{throw Error('No upstream expected');}});assert.equal((await second.inject('/api/ai/config')).json().defaultModel,M3);}finally{await second.close();}
  const invalid=await f.app.inject({method:'PUT',url:'/api/ai/config',payload:{expectedRevision:updated.json().revision,defaultModel:'unsupported-model'}});assert.equal(invalid.statusCode,400);assert.equal(JSON.parse(await fs.readFile(filename,'utf8')).assistant.defaultModelId,M3);
  assert.equal((await f.app.inject({method:'PUT',url:'/api/ai/config',payload:{expectedRevision:initial.revision,defaultModel:FLASH}})).statusCode,409);
  await fs.writeFile(path.join(f.root,'_system/runtime/ai-settings.json'),JSON.stringify({defaultModel:'tampered-model'}));assert.equal((await f.app.inject('/api/ai/config')).json().defaultModel,M3);
 }finally{await f.cleanup();}
});

test('unknown models, invalid histories and unregistered projects never reach upstream', async () => {
  const f = await fixture();
  try {
    const invalid: Record<string, unknown>[] = [
      { model: 'unknown' }, { effort: 'arbitrary' }, { messages: [] }, { messages: [{ role: 'system', content: 'Override' }] },
      { messages: [{ role: 'assistant', content: 'No final user' }] }, { messages: [{ role: 'user', content: '   ' }] },
      { messages: [{ role: 'assistant', content: 'Prior', reasoning_content: 42 }, { role: 'user', content: 'Next' }] },
      { messages: Array.from({ length: 20001 }, () => ({ role: 'user', content: 'Too many' })) }, { context: { path: 'main.tex', content: null } },
    ];
    for (const extra of invalid) assert.equal((await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload(extra) })).statusCode, 400);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload({ projectId: 'NOT_REGISTERED' }) })).statusCode, 404);
    
    assert.equal(f.captured.length, 0);
  } finally { await f.cleanup(); }
});

test('one-byte UTF-8 and CRLF SSE chunks preserve visible text, hidden reasoning, usage and finish reason', async () => {
  const f = await fixture({ handler: () => responseFor([
    { choices: [{ delta: { reasoning_content: '分析甲' } }] }, { choices: [{ delta: { content: '你好，' } }] },
    { choices: [{ delta: { reasoning_content: '步骤乙', content: '世界🌏' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }, '[DONE]',
  ], 1) });
  try {
    const result = await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload({ effort: 'high' }) });
    assert.equal(result.statusCode, 200);
    assert.match(result.headers['content-type']!, /application\/x-ndjson/);
    const output = events(result);
    assert.equal(output.filter(event => event.type === 'delta').map(event => event.text).join(''), '你好，世界🌏');
    assert.equal(output.some(event => event.type === 'error'), false);
    const done = output.find(event => event.type === 'done')!;
    assert.equal(done.reasoning_content, '分析甲步骤乙');
    assert.equal(done.finishReason, 'stop');
    assert.deepEqual(done.usage, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    assert.equal(done.model, FLASH);
    assert.equal(f.captured[0].body.reasoning_split, true);
    assert.equal(f.captured[0].body.reasoning_effort, 'high');
    assert.equal(f.captured[0].body.stream_options.include_usage, true);
    assert.equal(new Headers(f.captured[0].init.headers).get('Authorization'), `Bearer ${FAKE_KEY}`);
    assert.ok(!JSON.stringify(f.captured[0].body.messages).includes(FAKE_KEY));
  } finally { await f.cleanup(); }
});

test('multiturn history preserves assistant reasoning and includes only explicitly attached current content', async () => {
  const f = await fixture();
  try {
    const messages = [{ role: 'user', content: '第一轮问题' }, { role: 'assistant', content: '第一轮回答', reasoning_content: '上一轮思考原文' }, { role: 'user', content: '第二轮问题', reasoning_content: '不得当作助手思考转发' }];
    const plain = await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload({ messages }) });
    assert.equal(plain.statusCode, 200);
    const sent = f.captured[0].body.messages;
    assert.equal(sent[0].role, 'system');
    assert.equal(sent[2].reasoning_content, '上一轮思考原文');
    assert.equal(sent[3].content, '第二轮问题');
    assert.equal(sent[3].reasoning_content, undefined);
    assert.ok(!JSON.stringify(sent).includes('ACTUAL_DISK_ONLY_CONTEXT'));
    const attached = await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload({ messages, context: { path: 'manuscript/main.tex', content: 'UNSAVED_CURRENT_DRAFT_当前内容' } }) });
    assert.equal(attached.statusCode, 200);
    const attachedMessages = f.captured[1].body.messages;
    assert.match(attachedMessages.at(-1).content, /UNSAVED_CURRENT_DRAFT_当前内容/);
    assert.match(attachedMessages.at(-1).content, /manuscript\/main\.tex/);
    assert.ok(!JSON.stringify(attachedMessages).includes('ACTUAL_DISK_ONLY_CONTEXT'));
    assert.equal(await fs.readFile(path.join(f.root, 'papers/DEMO/manuscript/main.tex'), 'utf8'), 'ACTUAL_DISK_ONLY_CONTEXT');
  } finally { await f.cleanup(); }
});

test('upstream authorization and rate limits retain status distinctions and redact fake credentials', async () => {
  for (const status of [401, 403, 429]) {
    const f = await fixture({ handler: () => Response.json({ error: { message: `Provider detail ${FAKE_KEY} sk-otherFakeCredentialAbcdefghijklmnop` } }, { status }) });
    try {
      const result = await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload() });
      assert.equal(result.statusCode, status === 429 ? 429 : 502);
      assert.match(result.body, status === 429 ? /额度|频率/ : /授权|权限/);
      assert.ok(!result.body.includes(FAKE_KEY));
      assert.ok(!result.body.includes('sk-otherFakeCredential'));
      assert.equal(result.headers['content-type']?.includes('x-ndjson'), false);
    } finally { await f.cleanup(); }
  }
});

test('in-stream errors, provider base errors and malformed packets never emit done', async () => {
  const cases = [
    responseFor([{ choices: [{ delta: { content: '部分回答' } }] }, { error: { message: `stream failed ${FAKE_KEY}` } }]),
    responseFor([{ base_resp: { status_code: 1008, status_msg: `provider failed ${FAKE_KEY}` } }]),
    new Response('data: {invalid-json}\r\n\r\n', { headers: { 'Content-Type': 'text/event-stream' } }),
  ];
  for (const response of cases) {
    const f = await fixture({ handler: () => response });
    try {
      const result = await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload() });
      assert.equal(result.statusCode, 200);
      const output = events(result);
      assert.equal(output.filter(event => event.type === 'error').length, 1);
      assert.equal(output.some(event => event.type === 'done'), false);
      assert.ok(!result.body.includes(FAKE_KEY));
    } finally { await f.cleanup(); }
  }
});

test('truncated streams are marked incomplete and reasoning-only completions are actionable errors', async () => {
  const cases = [
    { response: responseFor([{ choices: [{ delta: { content: '中途收到的回答' } }] }]), message: /提前中断|不完整/ },
    { response: responseFor([{ choices: [{ delta: { reasoning_content: 'Only hidden reasoning' }, finish_reason: 'length' }] }, '[DONE]']), message: /未生成可见回答|思考/ },
  ];
  for (const item of cases) {
    const f = await fixture({ handler: () => item.response });
    try {
      const result = await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload() });
      const output = events(result);
      assert.equal(output.some(event => event.type === 'done'), false);
      assert.match(output.find(event => event.type === 'error')!.error!, item.message);
    } finally { await f.cleanup(); }
  }
});

test('HTTP 200 non-SSE payloads and empty bodies cannot masquerade as completed answers', async () => {
  for (const response of [Response.json({ message: 'Unexpected JSON payload' }), new Response(''), new Response(null, { status: 200 })]) {
    const f = await fixture({ handler: () => response });
    try {
      const result = await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload() });
      if (result.statusCode === 200) {
        const output = events(result);
        assert.ok(output.some(event => event.type === 'error'));
        assert.ok(!output.some(event => event.type === 'done'));
      } else { assert.equal(result.statusCode, 502); assert.match(result.body, /数据流|请求失败|中断|未返回流式回答/); }
    } finally { await f.cleanup(); }
  }
});

test('MiniMax-M3 is forwarded without a Flash-specific effort parameter and output length is explicit', async () => {
  const f = await fixture({ handler: () => responseFor([{ choices: [{ delta: { content: '达到长度限制的文字' }, finish_reason: 'length' }] }, '[DONE]']) });
  try {
    const response = await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload({ model: M3, effort: 'max' }) });
    assert.equal(response.statusCode, 200);
    assert.equal(f.captured[0].body.model, M3);
    assert.equal(f.captured[0].body.reasoning_effort, undefined);
    const done = events(response).find(event => event.type === 'done')!;
    assert.equal(done.finishReason, 'length');
    assert.equal(done.model, M3);
  } finally { await f.cleanup(); }
});

test('the first visible token is delivered before upstream completes', async () => {
  let stream: ReturnType<typeof controlledStream> | undefined;
  const f = await fixture({ handler: request => { stream = controlledStream(request.signal, '即时文字🌏'); return stream.response; } });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await within(fetch(address + '/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.payload()) }));
    reader = response.body!.getReader();
    const first = new TextDecoder().decode((await within(reader.read())).value);
    assert.match(first, /即时文字🌏/);
    assert.ok(!first.includes('"type":"done"'));
    stream!.send({ choices: [{ delta: { content: '后续文字' }, finish_reason: 'stop' }] });
    stream!.finish();
    let rest = '';
    for (;;) { const chunk = await within(reader.read()); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
    assert.match(rest, /后续文字/);
    assert.match(rest, /"type":"done"/);
  } finally { stream?.finish(); await reader?.cancel().catch(() => undefined); await f.cleanup(); }
});

test('timeout before headers aborts upstream and releases the per-project busy reservation', async () => {
  let timedOut = false;
  const f = await fixture({ timeoutMs: 35, handler: request => new Promise<Response>((_resolve, reject) => { request.signal.addEventListener('abort', () => { timedOut = true; reject(new DOMException('Mock timeout', 'AbortError')); }, { once: true }); }) });
  try {
    const response = await within(f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload() }));
    assert.equal(response.statusCode, 502);
    assert.match(response.body, /停止|超时/);
    assert.equal(timedOut, true);
    f.setHandler(() => answer());
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload() })).statusCode, 200);
  } finally { await f.cleanup(); }
});

test('timeout after partial output emits an incomplete error instead of done', async () => {
  let signal: AbortSignal | undefined;
  const f = await fixture({ timeoutMs: 40, handler: request => { signal = request.signal; return controlledStream(request.signal).response; } });
  try {
    const response = await within(f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload() }));
    const output = events(response);
    assert.ok(output.some(event=>event.type==='delta'));
    assert.ok(output.some(event => event.type === 'error' && /停止|超时/.test(event.error!)));
    assert.ok(!output.some(event => event.type === 'done'));
    assert.equal(signal?.aborted, true);
  } finally { await f.cleanup(); }
});

test('client cancellation aborts upstream and a subsequent question can start', async () => {
  let upstreamSignal: AbortSignal | undefined;
  const f = await fixture({ handler: request => { upstreamSignal = request.signal; return controlledStream(request.signal).response; } });
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await within(fetch(address + '/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.payload()), signal: controller.signal }));
    reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await within(reader.read())).value), /先收到的文字/);
    controller.abort();
    await until(() => upstreamSignal?.aborted === true);
    f.setHandler(() => answer('取消后新问题'));
    let nextStatus = 409;
    await until(async () => { const next = await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload() }); nextStatus = next.statusCode; return nextStatus !== 409; });
    assert.equal(nextStatus, 200);
  } finally { controller.abort(); await reader?.cancel().catch(() => undefined); await f.cleanup(); }
});

test('active project is busy and at most two different projects run simultaneously', async () => {
  const streams: ReturnType<typeof controlledStream>[] = [];
  const f = await fixture({ handler: request => { const stream = controlledStream(request.signal); streams.push(stream); return stream.response; } });
  const pending: Promise<unknown>[] = [];
  try {
    const first = Promise.resolve(f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload() })); pending.push(first);
    await until(() => f.captured.length === 1);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload() })).statusCode, 409);
    const second = Promise.resolve(f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload({ projectId: 'BETA' }) })); pending.push(second);
    await until(() => f.captured.length === 2);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload({ projectId: 'GAMMA' }) })).statusCode, 409);
  } finally { for (const stream of streams) stream.finish(); await Promise.allSettled(pending); await f.cleanup(); }
});

test('simultaneous requests cannot bypass busy checks through asynchronous credential lookup', async () => {
  const credential = deferred<string>();
  let keyCalls = 0;
  const f = await fixture({ getKey: async () => { keyCalls++; return credential.promise; }, handler: async () => { await pause(25); return answer(); } });
  try {
    const first = Promise.resolve(f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload() }));
    await until(() => keyCalls >= 1);
    const second = Promise.resolve(f.app.inject({ method: 'POST', url: '/api/ai/chat', payload: f.payload() }));
    await pause(20);
    credential.resolve(FAKE_KEY);
    const result = await within(Promise.all([first, second]));
    assert.deepEqual(result.map(response => response.statusCode).sort(), [200, 409], 'Exactly one simultaneous request may own a project, even while Keychain lookup is pending');
    assert.equal(f.captured.length, 1);
  } finally { credential.resolve(FAKE_KEY); await f.cleanup(); }
});

test('malformed streams abort the provider and cancel its reader before releasing the project slot', async () => {
  let signal: AbortSignal | undefined; let cancelled = false;
  const f = await fixture({ handler: request => {
    signal = request.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {invalid-json}\n\n')); },
      cancel() { cancelled = true; },
    }), {headers:{'Content-Type':'text/event-stream'}});
  } });
  try {
    const result = await within(f.app.inject({method:'POST',url:'/api/ai/chat',payload:f.payload()}));
    assert.ok(events(result).some(event=>event.type==='error'));
    assert.equal(signal?.aborted,true);
    assert.equal(cancelled,true);
    f.setHandler(()=>answer());
    assert.equal((await f.app.inject({method:'POST',url:'/api/ai/chat',payload:f.payload()})).statusCode,200);
  } finally {await f.cleanup();}
});

test('cancelling during credential lookup never starts a paid provider request', async () => {
  const credential=deferred<string>();let keyCalls=0;
  const f=await fixture({getKey:async()=>{keyCalls++;return credential.promise;}});
  const controller=new AbortController();
  try {
    const address=await f.app.listen({host:'127.0.0.1',port:0});
    const result=fetch(address+'/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(f.payload()),signal:controller.signal}).catch(()=>null);
    await until(()=>keyCalls===1);controller.abort();await result;
    await pause(20);credential.resolve(FAKE_KEY);await pause(30);
    assert.equal(f.captured.length,0);
    assert.equal((await f.app.inject({method:'POST',url:'/api/ai/chat',payload:f.payload()})).statusCode,200);
  } finally {controller.abort();credential.resolve(FAKE_KEY);await f.cleanup();}
});

test('HTTP 200 JSON quota errors retain the actionable provider cause and redact credentials', async () => {
  const f=await fixture({handler:()=>new Response(JSON.stringify({base_resp:{status_code:1008,status_msg:`quota exhausted ${FAKE_KEY}`}}),{headers:{'Content-Type':'application/json'}})});
  try {
    const result=await f.app.inject({method:'POST',url:'/api/ai/chat',payload:f.payload()});
    assert.equal(result.statusCode,502);assert.match(result.json().error,/quota exhausted/);
    assert.ok(!result.body.includes(FAKE_KEY));assert.match(result.body,/REDACTED/);
  } finally {await f.cleanup();}
});

test('key helper unknown commands exit with usage before loading any Security framework', async () => {
  const {spawnSync}=await import('node:child_process');
  const {fileURLToPath}=await import('node:url');
  const script=fileURLToPath(new URL('../scripts/minimax-keychain.py',import.meta.url));
  const guard="import ctypes,runpy,sys\nctypes.CDLL=lambda *args,**kwargs: (_ for _ in ()).throw(RuntimeError('SECURITY_FRAMEWORK_MUST_NOT_LOAD'))\nfilename=sys.argv[1];sys.argv=[filename]+sys.argv[2:];runpy.run_path(filename,run_name='__main__')";
  for(const args of [[],['--help'],['typo']]) {
    const result=spawnSync('/usr/bin/python3',['-c',guard,script,...args],{encoding:'utf8'});
    assert.notEqual(result.status,0);assert.equal(result.stdout,'');assert.match(result.stderr,/Usage:/);
    assert.ok(!result.stderr.includes('SECURITY_FRAMEWORK_MUST_NOT_LOAD'));
  }
});

test('chat has no application output token cap, accepts more than 64 messages and keeps long visible output',async()=>{
 const f=await fixture({handler:()=>answer('完整回复'.repeat(10000))});try{const messages=Array.from({length:65},(_,i)=>({role:i%2?'assistant':'user',content:'消息 '+i}));const r=await f.app.inject({method:'POST',url:'/api/ai/chat',payload:f.payload({messages})});assert.equal(r.statusCode,200,r.body);assert.equal(events(r).filter(e=>e.type==='delta').map(e=>e.text).join(''),'完整回复'.repeat(10000));assert.equal(f.captured[0].body.max_tokens,undefined);assert.equal(f.captured[0].body.max_completion_tokens,undefined);assert.equal(f.captured[0].body.messages.length,66);}finally{await f.cleanup();}
});
test('auto compaction sends a continuity summary and recent turns, checkpoints survive follow-up without deleting transcript',async()=>{
 const f=await fixture({contextWindow:10000,handler:r=>answer(r.body.messages[0].content.includes('接续摘要')?'连续性摘要：作者要求保留引用键和证据边界。':'接续后的回答')});try{const messages=Array.from({length:21},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',content:('历史材料 '+i+'：保留证据，不改模板。').repeat(65)}));const before=JSON.stringify(messages);const r=await f.app.inject({method:'POST',url:'/api/ai/chat',payload:f.payload({messages})});const output=events(r);assert.ok(output.some(e=>e.type==='context'));const checkpoint=(output.find(e=>e.type==='compacted') as any)?.checkpoint;assert.ok(checkpoint,JSON.stringify(output));assert.ok(checkpoint.afterTokens<checkpoint.beforeTokens);const final=f.captured.at(-1)!.body.messages;assert.match(final[1].content,/context_summary/);assert.ok(final.length<messages.length);assert.equal(final.at(-1).content,messages.at(-1)!.content);assert.equal(JSON.stringify(messages),before);const calls=f.captured.length;const follow=[...messages,{id:'m21',role:'assistant',content:'回答'},{id:'m22',role:'user',content:'继续'}];const next=await f.app.inject({method:'POST',url:'/api/ai/chat',payload:f.payload({messages:follow,checkpoint})});assert.ok(events(next).some(e=>e.type==='done'));assert.equal(f.captured.length,calls+1);assert.match(f.captured.at(-1)!.body.messages[1].content,/连续性摘要/);}finally{await f.cleanup();}
});
test('provider context overflow automatically compacts and retries once before any visible answer',async()=>{
 let calls=0;const f=await fixture({handler:r=>{calls++;return calls===1?new Response(JSON.stringify({error:{message:'context_length_exceeded'}}),{status:400,headers:{'Content-Type':'application/json'}}):answer(r.body.messages[0].content.includes('接续摘要')?'保留用户的论文写作要求。':'正常回答');}});try{const messages=[{id:'u',role:'user',content:'保留实验的证据边界。'.repeat(100)},{id:'a',role:'assistant',content:'了解，不捏造结果。'.repeat(100)},{id:'next',role:'user',content:'继续检查'}];const r=await f.app.inject({method:'POST',url:'/api/ai/chat',payload:f.payload({messages})});assert.ok(events(r).some(e=>e.type==='compacted'),r.body);assert.ok(events(r).some(e=>e.type==='done'));assert.equal(calls,3);}finally{await f.cleanup();}
});
test('failed compaction preserves old state and never sends a false success or final answer',async()=>{
 const f=await fixture({handler:()=>responseFor([{choices:[{delta:{content:'截断的摘要'},finish_reason:'length'}]},'[DONE]'])});try{const r=await f.app.inject({method:'POST',url:'/api/ai/chat',payload:f.payload({forceCompact:true,messages:[{id:'u',role:'user',content:'材料'.repeat(500)},{id:'a',role:'assistant',content:'回复'.repeat(300)},{id:'next',role:'user',content:'继续'}]})});assert.ok(events(r).some(e=>e.type==='error'&&/未完整/.test(e.error!)));assert.ok(!events(r).some(e=>e.type==='compacted'||e.type==='done'||e.type==='delta'));assert.equal(f.captured.length,1);}finally{await f.cleanup();}
});
test('idle timeout resets on ongoing output rather than cutting off a long running answer',async()=>{let timer:ReturnType<typeof setInterval>|undefined;const f=await fixture({timeoutMs:80,handler:r=>{const stream=controlledStream(r.signal);let count=0;timer=setInterval(()=>{stream.send({choices:[{delta:{content:'持续输出'}}]});if(++count===8){clearInterval(timer);stream.finish();}},20);return stream.response;}});try{const r=await f.app.inject({method:'POST',url:'/api/ai/chat',payload:f.payload()});assert.ok(events(r).some(e=>e.type==='done'),r.body);assert.ok(!events(r).some(e=>e.type==='error'));}finally{clearInterval(timer);await f.cleanup();}});
test('cancellation during compaction aborts summary work and releases the project slot without a false checkpoint',async()=>{let signal:AbortSignal|undefined;const f=await fixture({handler:r=>{signal=r.signal;return controlledStream(r.signal).response;}}),controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;try{const base=await f.app.listen({host:'127.0.0.1',port:0});const response=await fetch(base+'/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(f.payload({forceCompact:true,messages:[{id:'u',role:'user',content:'材料'.repeat(300)},{id:'a',role:'assistant',content:'建议'.repeat(300)},{id:'v',role:'user',content:'继续'}]})),signal:controller.signal});reader=response.body!.getReader();const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/compacting/);assert.ok(!first.includes('compacted'));await until(()=>!!signal);controller.abort();await until(()=>signal?.aborted===true);f.setHandler(()=>answer('取消后可继续'));await until(async()=>{const r=await f.app.inject({method:'POST',url:'/api/ai/chat',payload:f.payload()});return r.statusCode===200;});}finally{controller.abort();await reader?.cancel().catch(()=>{});await f.cleanup();}});
test('actual usage baseline triggers compaction, while a changed prefix invalidates the baseline',async()=>{const f=await fixture({handler:r=>answer(r.body.messages[0].content.includes('接续摘要')?'保留论文的证据边界。':'正常回答')});try{const messages=[{id:'u',role:'user' as const,content:'论文材料'.repeat(300)},{id:'a',role:'assistant' as const,content:'已保留要求'.repeat(300)},{id:'v',role:'user' as const,content:'继续'}],contextUsage={throughMessageId:'a',fingerprint:contextFingerprint(messages.slice(0,2)),model:FLASH,checkpointId:'',tokens:850000};const first=await f.app.inject({method:'POST',url:'/api/ai/chat',payload:f.payload({messages,contextUsage})});assert.ok(events(first).some(e=>e.type==='compacted'),first.body);const calls=f.captured.length;messages[0].content+='改变';const second=await f.app.inject({method:'POST',url:'/api/ai/chat',payload:f.payload({messages,contextUsage})});assert.ok(events(second).some(e=>e.type==='done'));assert.ok(!events(second).some(e=>e.type==='compacted'));assert.equal(f.captured.length,calls+1);}finally{await f.cleanup();}});
