import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonExecutable } from './platform.ts';

const script = fileURLToPath(new URL('../scripts/provider-keychain.py', import.meta.url));
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

const cacheKey = (provider: string, url: string) =>
  `${process.env.WORKBENCH_ROOT || ''}\0${provider}@${url}`;

function invoke(mode: 'read' | 'write', provider: string, url: string, value = ''): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable(), [script, mode, provider, url], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(Error('钥匙串操作超时。')); }, 15000);
    timer.unref();
    child.stdout.on('data', part => {
      bytes += part.length;
      if (bytes > 16384) { child.kill(); return; }
      output += part;
    });
    child.stderr.resume();
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
    child.stdin.on('error', () => {});
    child.stdin.end(value);
  });
}

/** Read a credential from the OS keychain, cached for the process lifetime until written or invalidated. */
export async function readKeychain(provider: string, url: string): Promise<string> {
  const key = cacheKey(provider, url);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = invoke('read', provider, url).then(({ code, output }) => {
    const value = code === 0 ? output.trim() : '';
    cache.set(key, value);
    return value;
  }).finally(() => {
    if (inflight.get(key) === task) inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}

/** Write a credential to the OS keychain via stdin and refresh the in-memory cache. */
export async function writeKeychain(provider: string, url: string, value: string): Promise<void> {
  const trimmed = value.trim();
  const { code } = await invoke('write', provider, url, trimmed);
  if (code !== 0) throw Error('无法读写系统凭据库，请检查系统访问权限。');
  const key = cacheKey(provider, url);
  inflight.delete(key);
  cache.set(key, trimmed);
}

export function invalidateKeychain(provider: string, url: string): void {
  const key = cacheKey(provider, url);
  cache.delete(key);
  inflight.delete(key);
}
