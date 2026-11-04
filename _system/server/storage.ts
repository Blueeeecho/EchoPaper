import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { assertNoSymlinks } from './security.ts';

const locks = new Map<string, Promise<unknown>>();
const mutationContext = new AsyncLocalStorage<Set<string>>();
export async function withProjectMutation<T>(root:string,work:()=>Promise<T>):Promise<T>{
  const key=path.resolve(root),held=mutationContext.getStore();
  if(held?.has(key))return work();
  return withLock(`mutation:${key}`,()=>mutationContext.run(new Set([...(held||[]),key]),work));
}
export async function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const preceding = locks.get(key) ?? Promise.resolve();
  const current = preceding.catch(() => undefined).then(work);
  locks.set(key, current);
  try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
}
export const hash = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');
export async function atomicWrite(filename: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  try { await fs.writeFile(temporary, content, { flag: 'wx' }); await fs.rename(temporary, filename); }
  finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}
export async function readJson<T>(filename: string): Promise<T> { return JSON.parse(await fs.readFile(filename, 'utf8')) as T; }
export async function writeJson(filename: string, value: unknown): Promise<void> { await atomicWrite(filename, JSON.stringify(value, null, 2) + '\n'); }
export async function preserveRecovery(root: string, relative: string, content: string | Buffer): Promise<void> {
  const fileKey = hash(relative).slice(0,12); const contentKey = hash(content).slice(0,16);
  const directory = await assertNoSymlinks(root, '.workbench/recovery', true);
  await fs.mkdir(directory, { recursive: true });
  await assertNoSymlinks(root, '.workbench/recovery');
  const existing = (await fs.readdir(directory)).filter(name => name.includes(`-${fileKey}-`)).sort();
  if (!existing.some(name => name.includes(`-${contentKey}-`))) {
    const filename = `${Date.now()}-${fileKey}-${contentKey}-${path.basename(relative)}`;
    await atomicWrite(path.join(directory, filename), content);
    existing.push(filename); existing.sort();
  }
  // Recovery protects recent uncommitted drafts; lasting milestones belong in Git.
  for (const name of existing.slice(0, Math.max(0, existing.length - 60))) await fs.rm(await assertNoSymlinks(root, `.workbench/recovery/${name}`), {force:true});
}
