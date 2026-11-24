import path from 'node:path';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import type {FastifyInstance} from 'fastify';

const run = promisify(execFile);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Local developer endpoint: rebuild the web UI and optionally commit _system to Git.
 * Runs only fixed commands, only from this machine, and only with a custom header,
 * so a web page elsewhere cannot trigger it (the header forces a CORS preflight we never approve).
 */
export function registerDevSyncRoutes(app: FastifyInstance, workspaceRoot: string) {
  const system = path.join(workspaceRoot, '_system');
  const env = {...process.env, PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`};
  let running = false;
  const tail = (text: string) => text.split('\n').slice(-60).join('\n');

  app.post('/api/dev/sync', async (request, reply) => {
    if (!LOOPBACK.has(request.ip) || request.headers['x-echopaper-dev'] !== '1') return reply.code(403).send({error: '仅限本机开发使用。'});
    if (running) return reply.code(409).send({error: '已有构建正在进行。'});
    const body = (request.body || {}) as {message?: unknown; commit?: unknown; typecheck?: unknown; test?: unknown; restart?: unknown};
    const message = typeof body.message === 'string' ? body.message.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) : '';
    running = true;
    const result: {ok: boolean; build: string; test?: string; commit?: string; error?: string} = {ok: false, build: ''};
    try {
      // Full build (tsc + vite) by default; typecheck:false skips tsc for a faster preview build.
      const args = body.typecheck === false ? ['vite', 'build'] : ['run', 'build'];
      const command = body.typecheck === false ? 'npx' : 'npm';
      const built = await run(command, args, {cwd: system, env, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024});
      result.build = tail(built.stdout + built.stderr);
      // Optional: the project's own test suite (fixed command), before anything is committed.
      if (body.test === true) {
        const tested = await run('npm', ['test'], {cwd: system, env, timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024});
        result.test = tail(tested.stdout + tested.stderr);
      }
      if (body.commit !== false) {
        await run('git', ['add', '-A'], {cwd: system, env});
        const staged = await run('git', ['diff', '--cached', '--quiet'], {cwd: system, env}).then(() => false, () => true);
        if (staged) {
          await run('git', ['commit', '-q', '-m', message || 'ui: 界面改版'], {cwd: system, env});
          result.commit = (await run('git', ['log', '--oneline', '-1'], {cwd: system, env})).stdout.trim();
        } else result.commit = '没有需要提交的改动';
      }
      result.ok = true;
      // Optional: restart the backend with the project's own control script, after the response is sent.
      if (body.restart === true) {
        const script = 'sleep 1; node scripts/control.mjs stop && node scripts/control.mjs start --no-open';
        const child = spawn('/bin/sh', ['-c', script], {cwd: system, env, detached: true, stdio: 'ignore'});
        child.unref();
        (result as typeof result & {restarting?: boolean}).restarting = true;
      }
      return result;
    } catch (error: any) {
      const all = `${error?.stdout || ''}${error?.stderr || ''}`;
      const failed = all.split('\n').filter(line => /^not ok /.test(line)).slice(0, 30).join('\n');
      result.error = (failed ? `失败的测试：\n${failed}\n\n` : '') + tail(`${all}${error?.message || ''}`);
      return reply.code(500).send(result);
    } finally {
      running = false;
    }
  });
}
