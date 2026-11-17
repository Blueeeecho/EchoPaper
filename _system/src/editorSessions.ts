import type { EditorBarrier } from '../shared/agent-types';
import { api, json } from './api';

export interface EditorSnapshot { projectId: string; path: string; dirty: boolean; bufferVersion: number }
export function barrierMatchesPath(paths: string[], path: string): boolean {
  return !!path && paths.some(value => value === '*' || value === path || path.startsWith(value.replace(/\/$/, '') + '/'));
}
interface SessionOptions {
  id: string; projectId: string; read: () => EditorSnapshot; flush: () => Promise<boolean>;
  onLock: (locked: boolean) => void;
  onError?: (message: string) => void;
  request?: (url: string, options: RequestInit) => Promise<unknown>;
  newId?: () => string;
}
export function createEditorSession(options: SessionOptions) {
  const request = options.request || api;
  const base = '/api/projects/' + encodeURIComponent(options.projectId) + '/editor-sessions';
  const newId = options.newId || (() => crypto.randomUUID());
  let id = options.id, epoch = 0, disposed = false, suspended = false, registered = false;
  let pending: EditorSnapshot | undefined, work: { epoch: number; promise: Promise<void> } | undefined;
  let observed: EditorSnapshot | undefined, rawObserved: EditorSnapshot | undefined, closing: Promise<void> | undefined;
  let lastSynced: EditorSnapshot | undefined, lastSyncedAt = 0;
  let handling = false, acknowledged = '';
  let activeBarrier = '', activeExpiry = 0, lease: ReturnType<typeof setTimeout> | undefined;
  function unlock() { const locked = !!activeBarrier; activeBarrier = ''; activeExpiry = 0; clearTimeout(lease); lease = undefined; if (locked) options.onLock(false); }
  function renewLease(expiresAt: number) {
    activeExpiry = Math.max(activeExpiry, expiresAt);
    clearTimeout(lease); lease = setTimeout(unlock, Math.max(1, activeExpiry - Date.now()));
  }
  /** State transitions also advance the protocol version, including a successful save clearing dirty. */
  function observe(): EditorSnapshot | undefined {
    const raw = options.read();
    if (raw.projectId !== options.projectId || !raw.path) return;
    const changed = !rawObserved || raw.path !== rawObserved.path || raw.dirty !== rawObserved.dirty || raw.bufferVersion !== rawObserved.bufferVersion;
    const bufferVersion = observed ? Math.max(raw.bufferVersion, observed.bufferVersion + (changed ? 1 : 0)) : raw.bufferVersion;
    rawObserved = { ...raw }; observed = { ...raw, bufferVersion };
    return observed;
  }
  function closeSnapshot() { return observe() || observed || lastSynced; }
  /** Revoke immediately: awaiting an in-flight POST here loses the unload keepalive window. */
  function retire(snapshot = closeSnapshot()): Promise<void> {
    const closingId = id;
    epoch++; pending = undefined; registered = false; lastSynced = undefined; lastSyncedAt = 0; unlock();
    const body = snapshot ? { path: snapshot.path, dirty: snapshot.dirty, bufferVersion: snapshot.bufferVersion } : { path: '', dirty: false, bufferVersion: 0 };
    if (!body.dirty) { id = newId(); observed = undefined; rawObserved = undefined; }
    return request(base + '/' + encodeURIComponent(closingId), { ...json('DELETE', body), keepalive: true }).then(() => {}, () => {});
  }
  async function sync(): Promise<void> {
    if (disposed || suspended || options.read().projectId !== options.projectId) return;
    const snapshot = observe();
    if (!snapshot) { if (registered || work?.epoch === epoch) await retire(); return; }
    pending = snapshot;
    if (work?.epoch === epoch) return work.promise;
    const frame = { epoch, promise: Promise.resolve() }, requestId = id;
    const drain = async () => { while (pending && !disposed && !suspended && frame.epoch === epoch) {
      const next = pending; pending = undefined;
      if (lastSynced && next.path === lastSynced.path && next.dirty === lastSynced.dirty && next.bufferVersion === lastSynced.bufferVersion && Date.now() - lastSyncedAt < 5000) continue;
      registered = true;
      try {
        const response = await request(base, json('POST', { id: requestId, path: next.path, dirty: next.dirty, bufferVersion: next.bufferVersion })) as {barriers?:EditorBarrier[]}|undefined;
        // Recover a lost event through the registration response. Defer until
        // this drain finishes: barrier() itself syncs the saved buffer.
        if(Array.isArray(response?.barriers))for(const value of response.barriers){
          if(value&&typeof value.id==='string'&&Array.isArray(value.paths)&&value.paths.every(path=>typeof path==='string')&&Number.isFinite(value.expiresAt))void frame.promise.then(()=>{
            if(!disposed&&!suspended&&frame.epoch===epoch)return barrier(value);
          }).catch(()=>{});
        }
      }
      catch (error) { if (disposed || suspended || frame.epoch !== epoch) return; throw error; }
      if (disposed || suspended || frame.epoch !== epoch) return;
      lastSynced = next; lastSyncedAt = Date.now();
    } };
    work = frame; frame.promise = drain();
    try { await frame.promise; } finally { if (work === frame) work = undefined; }
  }
  async function barrier(barrier: EditorBarrier): Promise<void> {
    const before = observe(), barrierEpoch = epoch;
    if (disposed || suspended || !before || !barrierMatchesPath(barrier.paths, before.path) || barrier.expiresAt <= Date.now()) return;
    if (activeBarrier === barrier.id) { renewLease(barrier.expiresAt); if (handling || acknowledged === barrier.id) return; }
    activeExpiry = 0;
    activeBarrier = barrier.id; options.onLock(true);
    renewLease(barrier.expiresAt);
    handling = true;
    const progress = (stage: string) => { if(options.onError) void request(base + '/' + encodeURIComponent(id) + '/progress', json('POST', {barrierId:barrier.id,stage})).catch(() => {}); };
    progress('保存');
    let stage = '保存', timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
      const remaining = Math.min(4000, activeExpiry - Date.now() - 250);
      if (remaining <= 0) throw new Error('确认期限已到');
      try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('等待超时')), remaining); })]); }
      finally { clearTimeout(timer); }
    };
    try {
      const saved = await bounded(options.flush);
      const after = observe(), clean = !!after && saved && !after.dirty && after.path === before.path;
      if (disposed || suspended || barrierEpoch !== epoch || activeBarrier !== barrier.id) return;
      stage = '同步'; progress(stage); await bounded(sync);
      if (disposed || suspended || barrierEpoch !== epoch || activeBarrier !== barrier.id) return;
      stage = '确认'; progress(stage);
      await bounded(() => request(base + '/' + encodeURIComponent(id) + '/ack', json('POST', { barrierId: barrier.id, bufferVersion: after?.bufferVersion ?? before.bufferVersion, clean })));
      acknowledged = barrier.id;
      if (!clean) options.onError?.('编辑器未能保存，建议与草稿已保留，请处理保存问题后恢复任务。');
    } catch (error) {
      progress(stage + '失败');
      options.onError?.(`编辑器${stage}失败：${error instanceof Error ? error.message : '请求异常'}。建议与草稿已保留，请检查页面连接后恢复任务。`);
    } finally { handling = false; }

  }
  function release(id: string) { if (id === activeBarrier) unlock(); }
  function suspend(): Promise<void> {
    if (disposed || suspended) return closing || Promise.resolve();
    suspended = true; closing = retire(); return closing;
  }
  async function resume(): Promise<void> {
    if (disposed || !suspended) return;
    suspended = false; closing = undefined; await sync();
  }
  function dispose(): Promise<void> {
    if (disposed) return closing || Promise.resolve();
    disposed = true;
    if (!suspended) { suspended = true; closing = retire(); }
    return closing || Promise.resolve();
  }
  return { sync, barrier, release, suspend, resume, dispose };
}

export function bindEditorSessionPageLifecycle(session: Pick<ReturnType<typeof createEditorSession>, 'suspend' | 'resume'>, target: EventTarget = window) {
  const hide = () => { void session.suspend(); };
  const show = (event: Event) => { if ((event as PageTransitionEvent).persisted) void session.resume().catch(() => {}); };
  target.addEventListener('pagehide', hide); target.addEventListener('pageshow', show);
  return () => { target.removeEventListener('pagehide', hide); target.removeEventListener('pageshow', show); };
}
