import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { findWorkspaceInstance, portReleased, requestGracefulStop, waitForPortRelease, WORKBENCH_PORTS } from '../scripts/graceful-stop.mjs';
test('shutdown rejection preserves the failure instead of permitting restart', async () => {
  for (const status of [200, 403, 409, 500]) {
    await assert.rejects(requestGracefulStop(4173, async () => ({status})), /未强制终止/);
  }
});
test('transport failure is surfaced without fallback termination', async () => {
  await assert.rejects(requestGracefulStop(4173, async () => { throw new Error('offline'); }), /保留后台和运行记录/);
});
test('only accepted graceful shutdown passes', async () => {
  await requestGracefulStop(4173, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:4173/api/shutdown');
    assert.equal(options.method, 'POST');
    assert.ok(options.signal);
    return {status:202};
  });
});
test('controller has no forced kill fallback and refuses incomplete stop', async () => {
  const source = await readFile(new URL('../scripts/control.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.kill/);
  assert.match(source, /后台尚未完成正常退出/);
  const stop = source.slice(source.indexOf('async function stop()'), source.indexOf('\ntry {'));
  const waiting = stop.indexOf('await waitForPortRelease(saved.port)');
  assert.ok(waiting >= 0 && waiting < stop.indexOf('await fs.rm(stateFile'));
  assert.match(source, /await stop\(\); await start\(\)/);
  assert.match(source, /await freePort\(saved\?\.port\)/);
  assert.match(source, /if \(savedPort\) await waitForPortRelease\(savedPort\)/);
});

test('offline health waits for the owned TCP listener to release before the same port is reused', async () => {
  const events = [];
  const listener = http.createServer((_request, response) => response.writeHead(503).end());
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  const replacement = net.createServer();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 503);
    await health.body.cancel();
    assert.equal(await portReleased(port), false);
    await waitForPortRelease(port, {
      wait: async () => {
        assert.deepEqual(events, []);
        await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
        events.push('listener released');
      },
    });
    events.push('replacement starting');
    await new Promise((resolve, reject) => {
      replacement.once('error', reject);
      replacement.listen(port, '127.0.0.1', resolve);
    });
    assert.deepEqual(events, ['listener released', 'replacement starting']);
    assert.equal(replacement.address().port, port);
  } finally {
    if (listener.listening) await new Promise(resolve => listener.close(resolve));
    if (replacement.listening) await new Promise(resolve => replacement.close(resolve));
  }
});

test('a listener that outlasts the deadline blocks restart and preserves the timeout failure', async () => {
  let elapsed = 0, started = false;
  const waits = [];
  await assert.rejects(async () => {
    await waitForPortRelease(4173, {
      isReleased: async port => { assert.equal(port, 4173); return false; },
      now: () => elapsed,
      wait: async milliseconds => { waits.push(milliseconds); elapsed += milliseconds; },
      timeoutMs: 250,
      intervalMs: 100,
    });
    started = true;
  }, /后台端口尚未释放.*保留运行记录/);
  assert.equal(started, false);
  assert.equal(elapsed, 250);
  assert.deepEqual(waits, [100, 100, 50]);
});

test('an already released port permits immediate continuation', async () => {
  await waitForPortRelease(4173, {
    isReleased: async () => true,
    wait: async () => assert.fail('an available port must not delay startup'),
  });
});

test('parallel workspace instance discovery matches target workspace across ports', async () => {
  const probed = [];
  const found = await findWorkspaceInstance('/tmp/target-ws', {
    preferredPort: 4173,
    request: async url => {
      probed.push(url);
      if (url.includes(':4174/')) {
        return { ok: true, json: async () => ({ ok: true, workspaceRoot: '/tmp/target-ws', pid: 999 }) };
      }
      return { ok: true, json: async () => ({ ok: true, workspaceRoot: '/tmp/other-ws', pid: 111 }) };
    },
  });
  assert.equal(found?.port, 4174);
  assert.equal(found?.health.pid, 999);
  assert.equal(probed.length, 31);
});

test('stop follows the workspace when its saved port is stale or from a copied folder', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'echopaper stop 测试-'));
  const scripts = path.join(root, '_system', 'scripts');
  const runtime = path.join(root, '_system', 'runtime');
  const state = path.join(runtime, 'instance.json');
  const run = promisify(execFile);
  const servers = [];
  const listen = async (workspaceRoot, shouldStop) => {
    let shutdownCount = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({ ok: true, workspaceRoot }));
      } else if (req.method === 'POST' && req.url === '/api/shutdown') {
        shutdownCount++;
        res.writeHead(202).end(() => { if (shouldStop) server.close(); });
      } else res.writeHead(404).end();
    });
    servers.push(server);
    for (const port of [...WORKBENCH_PORTS].reverse()) {
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
        return { port, shutdownCount: () => shutdownCount };
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
      }
    }
    throw new Error('No free fixture port');
  };
  try {
    await mkdir(scripts, { recursive: true });
    await mkdir(runtime);
    for (const file of ['control.mjs', 'graceful-stop.mjs']) {
      await copyFile(new URL(`../scripts/${file}`, import.meta.url), path.join(scripts, file));
    }
    const foreignRoot = path.join(root, 'different');
    const foreign = await listen(foreignRoot, false);
    for (const savedRoot of [root, foreignRoot]) {
      const own = await listen(root, true);
      await writeFile(state, JSON.stringify({ root: savedRoot, port: foreign.port }));
      await run(process.execPath, [path.join(scripts, 'control.mjs'), 'stop'], { timeout: 8000 });
      assert.equal(own.shutdownCount(), 1);
      assert.equal(foreign.shutdownCount(), 0);
      assert.equal(await portReleased(own.port), true);
      await assert.rejects(readFile(state), { code: 'ENOENT' });
    }
  } finally {
    await Promise.all(servers.filter(s => s.listening).map(s => new Promise(resolve => s.close(resolve))));
    await rm(root, { recursive: true, force: true });
  }
});
