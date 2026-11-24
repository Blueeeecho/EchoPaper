import fs from 'node:fs/promises';
import path from 'node:path';
import { gitExecutable, disabledGitHooks } from './platform';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HistoryEntry } from '../shared/types.ts';
import { HttpError, assertNoSymlinks, checkRef, editablePath } from './security.ts';
import { atomicWrite, preserveRecovery, withLock, withProjectMutation } from './storage.ts';

const run = promisify(execFile);
async function gitBytes(root: string, args: string[], maxBuffer = 8 * 1024 * 1024) {
  return (await run(gitExecutable(), ['--no-pager', '--literal-pathspecs', '-c', 'core.hooksPath=' + disabledGitHooks(), '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, maxBuffer, encoding: 'buffer', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })).stdout;
}
async function git(root: string, args: string[]) { return (await gitBytes(root, args)).toString('utf8'); }
const initializedRepos = new Map<string, string>();
export async function initializeGit(root: string): Promise<void> { return withLock(`gitinit:${root}`, () => initializeGitUnlocked(root)); }
async function gitConfigStamp(root: string): Promise<string> {
  const cfg = await fs.lstat(path.join(root, '.git', 'config')).catch(() => null);
  return cfg ? `${cfg.ino}:${cfg.size}:${cfg.mtimeMs}` : '';
}
async function initializeGitUnlocked(root: string): Promise<void> {
  try {
    const stat = await fs.lstat(path.join(root, '.git'));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HttpError(403, '版本目录无效。');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    initializedRepos.delete(root);
    await git(root, ['init', '-b', 'main']);
  }
  const stamp = await gitConfigStamp(root);
  if (stamp && initializedRepos.get(root) === stamp) return;
  await fs.writeFile(path.join(root, '.gitignore'), 'build/\nsubmissions/\n.workbench/\n.DS_Store\n*.synctex.gz\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  // Only repository-local identity is supplied; global Git configuration stays intact.
  for (const [key, value] of [['user.name', 'Paper Workbench'], ['user.email', 'workbench@localhost']]) {
    try { await git(root, ['config', '--get', key]); } catch { await git(root, ['config', '--local', key, value]); }
  }
  // Read first and write only when different: `git config` rewrites .git/config even for an
  // unchanged value, and this runs on every GET /api/projects.
  let quotepath = ''; try { quotepath = (await git(root, ['config', '--local', '--get', 'core.quotepath'])).trim(); } catch {}
  if (quotepath !== 'false') await git(root, ['config', '--local', 'core.quotepath', 'false']);
  const nextStamp = await gitConfigStamp(root);
  if (nextStamp) initializedRepos.set(root, nextStamp);
}
async function checkpointUnlocked(root: string, message: string, files?: string[]): Promise<HistoryEntry & { committed: boolean }> {
  await initializeGit(root);
  let hasHead = true; try { await git(root, ['rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }
  const commitArgs = ['commit', '--no-verify', '-m', message.slice(0, 500) || '保存版本'];
  let committed = false;
  if (files) {
    const selected = [...new Set(files.map(editablePath))];
    if (selected.length) {
      for (const file of selected) await assertNoSymlinks(root, file, true);
      const newFiles = (await git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...selected])).split('\0').filter(Boolean);
      if (newFiles.length) await git(root, ['add', '--intent-to-add', '--', ...newFiles]);
      const changes = await git(root, hasHead
        ? ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--', ...selected]
        : ['ls-files', '-z', '--cached', '--', ...selected]);
      if (changes) {
        await git(root, [...commitArgs, '--only', '--', ...changes.split('\0').filter(Boolean)]);
        committed = true;
      }
    }
  } else {
    await git(root, ['add', '--all', '--', '.']);
    if ((await git(root, ['diff', '--cached', '--name-only'])).trim() || !hasHead) {
      await git(root, commitArgs);
      committed = true;
    }
  }
  const row = (await git(root, ['log', '-1', '--format=%H%x1f%aI%x1f%s'])).trim().split('\x1f');
  return { hash: row[0], date: row[1], message: row.slice(2).join('\x1f'), committed };
}
export async function checkpoint(root: string, message: string, files?: string[]): Promise<HistoryEntry & { committed: boolean }> { return withLock(`git:${root}`, () => checkpointUnlocked(root, message, files)); }
export async function history(root: string): Promise<HistoryEntry[]> {
  await initializeGit(root);
  try { return (await git(root, ['log', '-100', '--format=%H%x1f%aI%x1f%s'])).trim().split('\n').filter(Boolean).map(line => { const [hash, date, ...message] = line.split('\x1f'); return { hash, date, message: message.join('\x1f') }; }); }
  catch { return []; }
}
export async function diff(root: string, file: string, ref?: string): Promise<string> {
  const filePath = editablePath(file);
  await assertNoSymlinks(root, filePath, true);
  const target = ref ? checkRef(ref) : 'HEAD';
  try {
    const change = await git(root, ['diff', '--no-ext-diff', '--no-textconv', target, '--', filePath]);
    if (change) return change;
    try { await git(root, ['cat-file', '-e', `${target}:${filePath}`]); } catch { const content = await fs.readFile(path.join(root, filePath), 'utf8').catch(() => ''); return content ? `新文件 ${filePath}\n${content.split('\n').map(line => '+' + line).join('\n')}` : ''; }
    return '';
  } catch { throw new HttpError(400, '无法比较该文件或版本。'); }
}
export async function restore(root: string, file: string, ref: string): Promise<void> {
  const filePath = editablePath(file); checkRef(ref);
  return withProjectMutation(root, () => withLock(`git:${root}`, () => withLock(`file:${root}:${filePath}`, async () => {
    await assertNoSymlinks(root, filePath, true);
    let previous: Buffer;
    try { previous = await gitBytes(root, ['cat-file', 'blob', `${ref}:${filePath}`], 64 * 1024 * 1024); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new HttpError(413, '历史文件过大，请通过 Git 单独恢复。');
      throw new HttpError(404, '所选版本中没有该文件。');
    }
    await checkpointUnlocked(root, `恢复前自动保存：${filePath}`, [filePath]);
    const current = await fs.readFile(path.join(root, filePath)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (current) {
      await preserveRecovery(root, filePath, current);
    }
    await assertNoSymlinks(root, filePath, true);
    await atomicWrite(path.join(root, filePath), previous);
  })));
}
