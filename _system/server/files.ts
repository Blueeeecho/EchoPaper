import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileDocument, FileEntry } from '../shared/types.ts';
import { HttpError, assertNoSymlinks, editablePath, relativePath } from './security.ts';
import { hash, preserveRecovery, withLock, withProjectMutation } from './storage.ts';

const excluded = new Set(['.git', 'build', 'submissions', '.workbench', '.DS_Store']);
export async function listFiles(root: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  async function walk(folder: string, prefix = '') {
    await assertNoSymlinks(root, prefix);
    for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name) || entry.name.startsWith('.') || (!prefix && entry.name === 'project.json') || entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { entries.push({ path: relative, name: entry.name, type: 'directory' }); await walk(path.join(folder, entry.name), relative); }
      else if (entry.isFile()) entries.push({ path: relative, name: entry.name, type: 'file', size: (await fs.stat(path.join(folder, entry.name))).size });
    }
  }
  await walk(root); return entries;
}
export async function document(root: string, value: string): Promise<FileDocument> {
  const file = relativePath(value);
  if (file === 'project.json' || file.split('/').some(p => p.startsWith('.')) || ['build','submissions'].includes(file.split('/')[0])) throw new HttpError(403, '此文件不在编辑区内。');
  const filename = await assertNoSymlinks(root, file);
  const stat = await fs.stat(filename);
  if (!stat.isFile()) throw new HttpError(400, '请选择文件。');
  if (stat.size > 3 * 1024 * 1024) throw new HttpError(413, '该文件较大，请下载或使用预览打开。');
  const bytes = await fs.readFile(filename);
  if (bytes.includes(0)) throw new HttpError(415, '二进制文件请使用预览或下载。');
  return { path: file, content: bytes.toString('utf8'), hash: hash(bytes) };
}
export async function saveDocument(root: string, value: string, content: unknown, expectedHash: unknown): Promise<FileDocument> {
  const file = editablePath(value);
  if (typeof content !== 'string' || Buffer.byteLength(content) > 3 * 1024 * 1024) throw new HttpError(400, '文件内容无效或超过 3 MB。');
  if (expectedHash !== null && (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))) throw new HttpError(400, '保存时必须提供文件版本；新文件使用 null。');
  return withProjectMutation(root, () => withLock(`file:${root}:${file}`, async () => {
    const filename = await assertNoSymlinks(root, file, true);
    let current: FileDocument | null = null;
    try { current = await document(root, file); } catch (error) { if ((error as HttpError).statusCode !== 404) throw error; }
    if ((current?.hash ?? null) !== expectedHash) throw new HttpError(409, '磁盘文件已变化，已保留双方内容。请比较后再保存。', { current });
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await assertNoSymlinks(root, file, true);
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, content, {flag:'wx'});
      if (current) await preserveRecovery(root, file, current.content);
      // Recheck after preparing the replacement so an external editor cannot be
      // overwritten merely because it saved while we were writing the temp file.
      let latest: FileDocument | null = null;
      try { latest = await document(root, file); } catch (error) { if ((error as HttpError).statusCode !== 404) throw error; }
      if ((latest?.hash ?? null) !== expectedHash) throw new HttpError(409, '磁盘文件在保存期间发生变化，浏览器草稿已保留。', { current: latest });
      await assertNoSymlinks(root, file, true);
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, {force:true}); }
    return { path: file, content, hash: hash(content) };
  }));
}
export async function renameDocument(root: string, fromValue: string, toValue: string, expectedHash: unknown): Promise<FileDocument> {
  const from = editablePath(fromValue), to = editablePath(toValue);
  if (from === to) return document(root, from);
  return withProjectMutation(root, () => withLock(`rename:${root}`, () => withLock(`file:${root}:${from}`, () => withLock(`file:${root}:${to}`, async () => {
    const source = await document(root, from);
    if (source.hash !== expectedHash) throw new HttpError(409, '文件已变化，请重新载入后再重命名。', { current: source });
    const destination = await assertNoSymlinks(root, to, true);
    if (await fs.lstat(destination).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; })) throw new HttpError(409, '目标文件已存在。');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await assertNoSymlinks(root, to, true);
    await fs.rename(path.join(root, from), destination);
    return { ...source, path: to };
  }))));
}
export async function upload(root: string, directory: string, name: string, buffer: Buffer): Promise<string> {
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) throw new HttpError(400, '上传文件名无效。');
  const target = editablePath(directory ? `${relativePath(directory)}/${name}` : name);
  return withProjectMutation(root, () => withLock(`file:${root}:${target}`, async () => {
    const filename = await assertNoSymlinks(root, target, true);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await assertNoSymlinks(root, target, true);
    try { await fs.writeFile(filename, buffer, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, '同名文件已存在，请更名后上传。'); throw error; }
    return target;
  }));
}
export async function createDirectory(root:string,value:unknown,expectedHash:unknown):Promise<{path:string}> {
  const folder=editablePath(value);
  if(folder.split('/')[0]==='project.json')throw new HttpError(403,'项目配置不允许作为新建目录的路径。');
  if(expectedHash!==null)throw new HttpError(400,'新建目录必须使用 expectedHash:null。');
  return withProjectMutation(root,()=>withLock(`file:${root}:${folder}`,async()=>{
    const filename=await assertNoSymlinks(root,folder,true);
    await fs.mkdir(path.dirname(filename),{recursive:true});
    await assertNoSymlinks(root,folder,true);
    try{await fs.mkdir(filename);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new HttpError(409,'同名文件或目录已存在，请更名后创建。');throw error;}
    return{path:folder};
  }));
}
export async function search(root: string, query: string): Promise<{ path: string; line: number; text: string }[]> {
  if (!query.trim()) return [];
  if (query.length > 200) throw new HttpError(400, '搜索词过长。');
  const results: { path: string; line: number; text: string }[] = [];
  for (const entry of await listFiles(root)) {
    if (entry.type !== 'file' || !/\.(tex|bib|md|txt|json|csv|sty|cls|bst)$/i.test(entry.path) || (entry.size ?? 0) > 2 * 1024 * 1024) continue;
    const content = await fs.readFile(await assertNoSymlinks(root, entry.path), 'utf8');
    for (const [index, line] of content.split('\n').entries()) {
      if (line.toLowerCase().includes(query.toLowerCase())) results.push({ path: entry.path, line: index + 1, text: line.slice(0, 400) });
      if (results.length >= 200) return results;
    }
  }
  return results;
}
