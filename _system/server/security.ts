import path from 'node:path';
import fs from 'node:fs/promises';

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}
export function projectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw new HttpError(400, '项目编号只能使用字母、数字、点、下划线和连字符。');
  return value;
}
export function relativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new HttpError(400, '文件路径无效。');
  const segments = value.split('/');
  if (segments.some(p => !p || p === '.' || p === '..')) throw new HttpError(400, '文件路径不能包含空段、. 或 ..。');
  return segments.join('/');
}
export function editablePath(value: unknown): string {
  const result = relativePath(value);
  if (result === 'project.json' || result.split('/').some(p => p.startsWith('.')) || ['build', 'submissions'].includes(result.split('/')[0])) throw new HttpError(403, '此路径由工作台管理，不能通过文件编辑器修改。');
  if (/^reviews\/[^/]+\/response\/responses\.tex$/.test(result)) throw new HttpError(403, 'responses.tex 由逐条回复生成，请在审稿页面修改对应回复。');
  return result;
}
export async function assertNoSymlinks(root: string, relative = '', allowMissing = false): Promise<string> {
  const parts = relative ? relativePath(relative).split('/') : [];
  let cursor = root;
  const rootStat = await fs.lstat(root).catch(() => { throw new HttpError(404, '目录不存在。'); });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new HttpError(403, '项目目录不能是符号链接。');
  for (const segment of parts) {
    cursor = path.join(cursor, segment);
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new HttpError(403, '不允许通过符号链接访问文件。'); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, '文件不存在。'); throw error; }
  }
  return cursor;
}
export async function registeredRoot(workspaceRoot: string, id: string): Promise<string> {
  projectId(id);
  const papers = path.join(workspaceRoot, 'papers');
  await assertNoSymlinks(workspaceRoot, 'papers');
  const root = await assertNoSymlinks(papers, id);
  await assertNoSymlinks(root, 'project.json');
  return root;
}
export function checkRef(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{7,40}$/.test(value)) throw new HttpError(400, '版本编号无效，请选择已有版本。');
  return value;
}
