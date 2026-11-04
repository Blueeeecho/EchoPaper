import test from 'node:test';
import assert from 'node:assert/strict';
import { barrierMatchesPath, bindEditorSessionPageLifecycle, createEditorSession, type EditorSnapshot } from '../src/editorSessions.ts';

test('barriers match exact files and directory boundaries without matching sibling prefixes', () => {
  assert.equal(barrierMatchesPath(['manuscript/a.tex'], 'manuscript/a.tex'), true);
  assert.equal(barrierMatchesPath(['manuscript'], 'manuscript/a.tex'), true);
  assert.equal(barrierMatchesPath(['manuscript/a'], 'manuscript/another.tex'), false);
  assert.equal(barrierMatchesPath(['*'], ''), false);
});
test('editor barrier locks, flushes latest buffer and acknowledges that version before release', async () => {
  let snapshot: EditorSnapshot = { projectId: 'p', path: 'manuscript/main.tex', dirty: true, bufferVersion: 7 };
  const calls: { url: string; options: RequestInit }[] = [], locks: boolean[] = [];
  const session = createEditorSession({ id: 'editor-p', projectId: 'p', read: () => snapshot,
    flush: async () => { assert.equal(locks.at(-1), true); snapshot = { ...snapshot, dirty: false }; return true; },
    onLock: value => locks.push(value), request: async (url, options) => { calls.push({ url, options }); } });
  try {
    await session.barrier({ id: 'barrier', paths: ['manuscript/main.tex'], expiresAt: Date.now() + 5000 });
    assert.deepEqual(JSON.parse(String(calls[0].options.body)), { id: 'editor-p', path: snapshot.path, dirty: false, bufferVersion: 8 });
    assert.match(calls[1].url, /editor-p\/ack$/);
    assert.deepEqual(JSON.parse(String(calls[1].options.body)), { barrierId: 'barrier', bufferVersion: 8, clean: true });
    session.release('other'); assert.equal(locks.at(-1), true);
    session.release('barrier'); assert.equal(locks.at(-1), false);
  } finally { await session.dispose(); }
});
test('save conflict sends clean false and never asserts a successful flush', async () => {
  const calls: RequestInit[] = [];
  const session = createEditorSession({ id: 'e', projectId: 'p', read: () => ({ projectId: 'p', path: 'a.tex', dirty: true, bufferVersion: 4 }), flush: async () => false, onLock: () => {}, request: async (_url, options) => { calls.push(options); } });
  try { await session.barrier({ id: 'b', paths: ['a.tex'], expiresAt: Date.now() + 5000 }); assert.equal(JSON.parse(String(calls.at(-1)!.body)).clean, false); }
  finally { await session.dispose(); }
});
test('a file switch during a flush does not approve a barrier for the previous file', async () => {
  let path = 'a.tex'; const calls: RequestInit[] = [];
  const session = createEditorSession({ id: 'e', projectId: 'p', read: () => ({ projectId: 'p', path, dirty: false, bufferVersion: 2 }), flush: async () => { path = 'b.tex'; return true; }, onLock: () => {}, request: async (_url, options) => { calls.push(options); } });
  try { await session.barrier({ id: 'b', paths: ['a.tex'], expiresAt: Date.now() + 5000 }); assert.equal(JSON.parse(String(calls.at(-1)!.body)).clean, false); }
  finally { await session.dispose(); }
});
test('expired and unrelated barriers neither flush nor lock the editor', async () => {
  let flushes = 0; const locks: boolean[] = [];
  const session = createEditorSession({ id: 'e', projectId: 'p', read: () => ({ projectId: 'p', path: 'a.tex', dirty: true, bufferVersion: 1 }), flush: async () => { flushes++; return true; }, onLock: value => locks.push(value), request: async () => {} });
  await session.barrier({ id: 'b', paths: ['a.tex'], expiresAt: Date.now() - 1 });
  await session.barrier({ id: 'c', paths: ['b.tex'], expiresAt: Date.now() + 5000 });
  assert.equal(flushes, 0); assert.deepEqual(locks, []); await session.dispose();
});
test('duplicate registrations coalesce, and leaving a text file unregisters its clean session', async () => {
  let snapshot: EditorSnapshot = { projectId: 'p', path: 'a.tex', dirty: false, bufferVersion: 1 };
  const calls: RequestInit[] = [];
  const session = createEditorSession({ id: 'e', projectId: 'p', read: () => snapshot, flush: async () => true, onLock: () => {}, request: async (_url, options) => { calls.push(options); } });
  await session.sync(); await session.sync(); assert.equal(calls.length, 1);
  snapshot = { ...snapshot, path: '' }; await session.sync(); assert.equal(calls.at(-1)?.method, 'DELETE'); await session.dispose();
});
test('renewing the same barrier keeps the editor locked without flushing or acknowledging again', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let flushes = 0; const calls: { url: string; options: RequestInit }[] = [], locks: boolean[] = [];
  const session = createEditorSession({ id: 'e', projectId: 'p', read: () => ({ projectId: 'p', path: 'a.tex', dirty: false, bufferVersion: 1 }), flush: async () => { flushes++; return true; }, onLock: value => locks.push(value), request: async (url, options) => { calls.push({ url, options }); } });
  try {
    await session.barrier({ id: 'renewed', paths: ['a.tex'], expiresAt: Date.now() + 5000 });
    context.mock.timers.tick(2000);
    await session.barrier({ id: 'renewed', paths: ['a.tex'], expiresAt: Date.now() + 5000 });
    // An older duplicate must not shorten the renewed lease.
    await session.barrier({ id: 'renewed', paths: ['a.tex'], expiresAt: Date.now() + 1000 });
    context.mock.timers.tick(3100);
    assert.deepEqual(locks, [true]); assert.equal(flushes, 1); assert.equal(calls.filter(call => call.url.endsWith('/ack')).length, 1);
    session.release('renewed'); assert.deepEqual(locks, [true, false]);
  } finally { await session.dispose(); }
});
test('lease timeout unlocks a slow flush without sending a late clean acknowledgement', async () => {
  let finish!: (value: boolean) => void; const waiting = new Promise<boolean>(resolve => { finish = resolve; });
  const locks: boolean[] = [], calls: RequestInit[] = [];
  const session = createEditorSession({ id: 'e', projectId: 'p', read: () => ({ projectId: 'p', path: 'a.tex', dirty: false, bufferVersion: 1 }), flush: () => waiting, onLock: value => locks.push(value), request: async (_url, options) => { calls.push(options); } });
  const barrier = session.barrier({ id: 'b', paths: ['a.tex'], expiresAt: Date.now() + 50 });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(locks.at(-1), false); finish(true); await barrier;
  assert.equal(calls.length, 0); await session.dispose();
});

test('pagehide revokes a clean id immediately while registration is pending, and late completion cannot register queued state', async () => {
  let release!: () => void;
  const registration = new Promise<void>(resolve => { release = resolve; });
  const calls: { url: string; options: RequestInit }[] = [];
  let snapshot: EditorSnapshot = { projectId: 'p', path: 'a.tex', dirty: false, bufferVersion: 1 };
  const session = createEditorSession({ id: 'old-document', projectId: 'p', read: () => snapshot, flush: async () => true, onLock: () => {}, newId: () => 'restored-document', request: async (url, options) => { calls.push({ url, options }); if (options.method === 'POST') await registration; } });
  const pending = session.sync(); snapshot = { ...snapshot, bufferVersion: 2 }; const queued = session.sync();
  await session.suspend();
  assert.equal(calls.length, 2); assert.equal(calls[1].options.method, 'DELETE'); assert.equal(calls[1].options.keepalive, true); assert.match(calls[1].url, /old-document$/);
  assert.deepEqual(JSON.parse(String(calls[1].options.body)), { path: 'a.tex', dirty: false, bufferVersion: 2 });
  release(); await Promise.all([pending, queued]); await session.sync(); assert.equal(calls.length, 2);
  await session.resume(); assert.equal(JSON.parse(String(calls[2].options.body)).id, 'restored-document');
  await session.dispose();
});

test('dirty pagehide sends the latest unsynchronized version and BFCache resumes the same protective identity', async () => {
  let snapshot: EditorSnapshot = { projectId: 'p', path: 'a.tex', dirty: false, bufferVersion: 3 };
  const calls: { url: string; options: RequestInit }[] = [];
  const session = createEditorSession({ id: 'dirty-document', projectId: 'p', read: () => snapshot, flush: async () => true, onLock: () => {}, newId: () => 'must-not-be-used', request: async (url, options) => { calls.push({ url, options }); } });
  await session.sync(); snapshot = { ...snapshot, dirty: true, bufferVersion: 9 }; await session.suspend();
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.options.body)), { path: 'a.tex', dirty: true, bufferVersion: 9 });
  await session.resume(); assert.equal(JSON.parse(String(calls.at(-1)!.options.body)).id, 'dirty-document');
  snapshot = { ...snapshot, dirty: false }; await session.sync();
  assert.equal(JSON.parse(String(calls.at(-1)!.options.body)).bufferVersion, 10);
  await session.dispose(); assert.deepEqual(JSON.parse(String(calls.at(-1)!.options.body)), { path: 'a.tex', dirty: false, bufferVersion: 10 });
});

test('a restored clean document can sync with a new id before the old registration finishes', async () => {
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const ids: string[] = [];
  const session = createEditorSession({ id: 'old', projectId: 'p', read: () => ({ projectId: 'p', path: 'a.tex', dirty: false, bufferVersion: 1 }), flush: async () => true, onLock: () => {}, newId: () => 'new', request: async (_url, options) => { if (options.method === 'POST') { const { id } = JSON.parse(String(options.body)); ids.push(id); if (id === 'old') await waiting; } } });
  const pending = session.sync(); await session.suspend(); await session.resume(); assert.deepEqual(ids, ['old', 'new']);
  release(); await pending; await session.sync(); assert.deepEqual(ids, ['old', 'new']); await session.dispose();
});

test('dispose does not wait for registration and closes with the latest snapshot belonging to the old project', async () => {
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  let snapshot: EditorSnapshot = { projectId: 'p', path: 'a.tex', dirty: true, bufferVersion: 7 };
  const calls: { url: string; options: RequestInit }[] = [];
  const session = createEditorSession({ id: 'old-project', projectId: 'p', read: () => snapshot, flush: async () => true, onLock: () => {}, request: async (url, options) => { calls.push({ url, options }); if (options.method === 'POST') await waiting; } });
  const pending = session.sync(); snapshot = { projectId: 'q', path: 'other.tex', dirty: false, bufferVersion: 1 };
  await session.dispose(); assert.equal(calls[1].options.keepalive, true);
  assert.deepEqual(JSON.parse(String(calls[1].options.body)), { path: 'a.tex', dirty: true, bufferVersion: 7 });
  release(); await pending; await session.sync(); assert.equal(calls.length, 2);
});

test('leaving a clean text file retires its identity before another file opens', async () => {
  let snapshot: EditorSnapshot = { projectId: 'p', path: 'a.tex', dirty: false, bufferVersion: 1 };
  const calls: RequestInit[] = [];
  const session = createEditorSession({ id: 'first', projectId: 'p', read: () => snapshot, flush: async () => true, onLock: () => {}, newId: () => 'second', request: async (_url, options) => { calls.push(options); } });
  await session.sync(); snapshot = { ...snapshot, path: '' }; await session.sync();
  snapshot = { ...snapshot, path: 'b.tex' }; await session.sync(); assert.equal(JSON.parse(String(calls.at(-1)!.body)).id, 'second');
  await session.dispose();
});

test('page lifecycle bindings suspend on pagehide, restore only BFCache pages and remove their handlers', async () => {
  const target = new EventTarget(), calls: string[] = [];
  const unbind = bindEditorSessionPageLifecycle({ suspend: async () => { calls.push('suspend'); }, resume: async () => { calls.push('resume'); } }, target);
  target.dispatchEvent(new Event('pagehide')); target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false })); target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.deepEqual(calls, ['suspend', 'resume']); unbind();
  target.dispatchEvent(new Event('pagehide')); target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })); assert.deepEqual(calls, ['suspend', 'resume']);
});
