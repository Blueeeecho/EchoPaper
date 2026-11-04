import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HistoryEntry } from '../shared/types.ts';
import { HttpError, assertNoSymlinks, checkRef, editablePath } from './security.ts';
import { atomicWrite, preserveRecovery, withLock, withProjectMutation } from './storage.ts';

const run = promisify(execFile);
async function git(root: string, args: string[]) { return (await run('/usr/bin/git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })).stdout; }
export async function initializeGit(root: string): Promise<void> { return withLock(`gitinit:${root}`, () => initializeGitUnlocked(root)); }
async function initializeGitUnlocked(root: string): Promise<void> {
  try { const stat = await fs.lstat(path.join(root, '.git')); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HttpError(403, '版本目录无效。'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await git(root, ['init', '-b', 'main']); }
  await fs.writeFile(path.join(root, '.gitignore'), 'build/\nsubmissions/\n.workbench/\n.DS_Store\n*.synctex.gz\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  // Only repository-local identity is supplied; global Git configuration stays intact.
  for (const [key, value] of [['user.name', 'Paper Workbench'], ['user.email', 'workbench@localhost']]) {
    try { await git(root, ['config', '--get', key]); } catch { await git(root, ['config', '--local', key, value]); }
  }
  await git(root, ['config', '--local', 'core.quotepath', 'false']);
}
async function checkpointUnlocked(root: string, message: string): Promise<HistoryEntry> {
  await initializeGit(root);
  await git(root, ['add', '--all', '--', '.']);
  const changes = await git(root, ['diff', '--cached', '--name-only']);
  let hasHead = true; try { await git(root, ['rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }
  if (changes.trim() || !hasHead) await git(root, ['commit', '--no-verify', '-m', message.slice(0, 500) || '保存版本']);
  const row = (await git(root, ['log', '-1', '--format=%H%x1f%aI%x1f%s'])).trim().split('\x1f');
  return { hash: row[0], date: row[1], message: row.slice(2).join('\x1f') };
}
export async function checkpoint(root: string, message: string): Promise<HistoryEntry> { return withLock(`git:${root}`, () => checkpointUnlocked(root, message)); }
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
    let previous: string; try { previous = await git(root, ['show', `${ref}:${filePath}`]); } catch { throw new HttpError(404, '所选版本中没有该文件。'); }
    await checkpointUnlocked(root, `恢复前自动保存：${filePath}`);
    const current = await fs.readFile(path.join(root, filePath)).catch(() => null);
    if (current) {
      await preserveRecovery(root, filePath, current);
    }
    await assertNoSymlinks(root, filePath, true);
    await atomicWrite(path.join(root, filePath), previous);
  })));
}
