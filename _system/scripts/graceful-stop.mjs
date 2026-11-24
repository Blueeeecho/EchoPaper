import net from 'node:net';
import path from 'node:path';

export const WORKBENCH_PORTS = Array.from({ length: 31 }, (_, i) => 4173 + i);

export const sameWorkspacePath = (a, b) => {
  if (typeof a !== 'string' || !path.isAbsolute(a) || typeof b !== 'string' || !path.isAbsolute(b)) return false;
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};

export async function probeWorkspacePort(port, workspaceRoot, { timeoutMs = 1000, request = fetch } = {}) {
  try {
    const response = await request(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.ok && sameWorkspacePath(data.workspaceRoot, workspaceRoot) ? { port, health: data } : null;
  } catch {
    return null;
  }
}

export async function findWorkspaceInstance(workspaceRoot, { preferredPort, timeoutMs = 1000, request = fetch } = {}) {
  if (Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535) {
    const fast = await probeWorkspacePort(preferredPort, workspaceRoot, { timeoutMs, request });
    if (fast) return fast;
  }
  const results = await Promise.all(WORKBENCH_PORTS.map(port =>
    port === preferredPort ? null : probeWorkspacePort(port, workspaceRoot, { timeoutMs, request })
  ));
  return results.find(Boolean) || null;
}

// Fail closed: a failed shutdown must never authorize a forced kill or restart.
export async function requestGracefulStop(port, request = fetch) {
  let response;
  try {
    response = await request(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST', signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error('正常退出请求失败；保留后台和运行记录，未强制终止。');
  }
  if (response.status !== 202) {
    throw new Error(`正常退出未获接纳（HTTP ${response.status}）；保留后台和运行记录，未强制终止。`);
  }
}

/** A health endpoint may disappear while pending work still owns the listener. */
export async function portReleased(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1' }, () => server.close(error => resolve(!error)));
  });
}

export async function waitForPortRelease(port, {
  isReleased = portReleased,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  timeoutMs = 30000,
  intervalMs = 100,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await isReleased(port)) return;
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('后台端口尚未释放，已保留运行记录，请稍后重试。');
    await wait(Math.min(intervalMs, remaining));
  }
}
