import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { BuildService, EmitEvent, PdfAnnotation, PdfAnnotationKind, PdfAnnotationRect, PdfAnnotationSource, PdfAnnotationStatus } from '../shared/types.ts';
import { exportAnnotatedPdf, annotationMarkdown } from './annotation-export.ts';
import { getProject } from './projects.ts';
import { assertNoSymlinks, HttpError, registeredRoot, relativePath } from './security.ts';
import { readJson, withLock, writeJson } from './storage.ts';

const relative = 'notes/pdf-annotations.json';
const kinds: PdfAnnotationKind[] = ['highlight', 'comment', 'bold', 'italic'];
interface AnnotationStore { schemaVersion: 1; revision: number; annotations: PdfAnnotation[] }
const emptyStore = (): AnnotationStore => ({ schemaVersion: 1, revision: 0, annotations: [] });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '批注内容无效。');
  return value as Record<string, unknown>;
}
function field(value: unknown, label: string, limit = 20000): string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) throw new HttpError(400, `${label}无效或过长。`);
  return value;
}
function annotationKind(value: unknown): PdfAnnotationKind {
  if (!kinds.includes(value as PdfAnnotationKind)) throw new HttpError(400, '批注类型无效。');
  return value as PdfAnnotationKind;
}
function annotationStatus(value: unknown): PdfAnnotationStatus {
  if (!['open', 'changed', 'verified'].includes(value as string)) throw new HttpError(400, '批注处理状态无效。');
  return value as PdfAnnotationStatus;
}
function annotationSource(value: unknown): PdfAnnotationSource {
  const item = object(value);
  const sourcePath = relativePath(item.path);
  if (!/^(manuscript|reviews)\//.test(sourcePath) || !/\.(tex|bib|md|txt)$/.test(sourcePath) || sourcePath.split('/').some(part => part.startsWith('.')) || typeof item.line !== 'number' || !Number.isSafeInteger(item.line) || item.line < 1 || item.line > 1000000) throw new HttpError(400, '请选择正文或审稿文档中的有效文件与行号。');
  return { path: sourcePath, line: item.line };
}
function rectangles(value: unknown): PdfAnnotationRect[] {
  if (!Array.isArray(value) || !value.length || value.length > 200) throw new HttpError(400, '批注选区应包含 1–200 个矩形。');
  return value.map(rect => {
    const item = object(rect);
    const numbers = ['x', 'y', 'width', 'height'].map(key => item[key]);
    if (!numbers.every(n => typeof n === 'number' && Number.isFinite(n))) throw new HttpError(400, '批注坐标无效。');
    const [x, y, width, height] = numbers as number[];
    if (x < 0 || y < 0 || x >= 1 || y >= 1 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) throw new HttpError(400, '批注选区超出页面。');
    return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
  });
}
function textOffsets(body: Record<string, unknown>): Pick<PdfAnnotation, 'startOffset' | 'endOffset'> {
  if (body.startOffset === undefined && body.endOffset === undefined) return {};
  if (typeof body.startOffset !== 'number' || typeof body.endOffset !== 'number' || !Number.isInteger(body.startOffset) || !Number.isInteger(body.endOffset) || body.startOffset < 0 || body.endOffset <= body.startOffset || body.endOffset > 1000000) throw new HttpError(400, '批注文字选区偏移无效。');
  return { startOffset: body.startOffset, endOffset: body.endOffset };
}
async function readStore(root: string): Promise<AnnotationStore> {
  const filename = await assertNoSymlinks(root, relative, true);
  let result: AnnotationStore;
  try { result = await readJson<AnnotationStore>(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    if (error instanceof SyntaxError) throw new HttpError(409, '批注文件格式无效；已保留原文件，请先检查 notes/pdf-annotations.json。');
    throw error;
  }
  if (!result || result.schemaVersion !== 1 || !Number.isSafeInteger(result.revision) || result.revision < 0 || !Array.isArray(result.annotations) || result.annotations.length > 2000 || result.annotations.some(a => !a || typeof a.id !== 'string' || typeof a.targetId !== 'string' || typeof a.buildId !== 'string' || !Number.isInteger(a.page) || !Array.isArray(a.rects))) throw new HttpError(409, '批注文件格式无效；已保留原文件，请先检查 notes/pdf-annotations.json。');
  try {
    const ids = new Set<string>();
    for (const item of result.annotations) {
      if (!item.id || ids.has(item.id) || item.page < 1 || item.page > 10000 || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.updatedAt !== 'string' || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)) || !Number.isFinite(Date.parse(item.createdAt)) || (item.sourceHash !== undefined && (typeof item.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.sourceHash)))) throw new Error('invalid stored annotation');
      ids.add(item.id);
      annotationKind(item.kind); rectangles(item.rects); field(item.quote, '选中文字', 10000); field(item.comment, '备注'); textOffsets(item as unknown as Record<string, unknown>);
      if (item.status !== undefined) annotationStatus(item.status);
      item.status ??= 'open';
      if (item.source !== undefined) annotationSource(item.source);
      if (item.migratedFrom !== undefined) field(item.migratedFrom, '原批注', 100);
      if (item.migratedTo !== undefined && (!Array.isArray(item.migratedTo) || item.migratedTo.length > 2000 || item.migratedTo.some(id => typeof id !== 'string' || !/^ann-[A-Za-z0-9-]+$/.test(id)))) throw new Error('invalid migration history');
    }
  } catch { throw new HttpError(409, '批注文件格式无效；已保留原文件，请先检查 notes/pdf-annotations.json。'); }
  return result;
}
async function saveStore(root: string, store: AnnotationStore) {
  const notes = await assertNoSymlinks(root, 'notes', true);
  await fs.mkdir(notes, { recursive: true });
  const filename = await assertNoSymlinks(root, relative, true);
  store.revision++;
  await writeJson(filename, store);
}
async function checkTarget(workspaceRoot: string, id: string, value: unknown): Promise<string> {
  const targetId = field(value, '编译目标', 80);
  const project = await getProject(workspaceRoot, id);
  if (!project.targets.some(target => target.id === targetId)) throw new HttpError(400, '请选择当前项目已有的编译目标。');
  return targetId;
}
function existing(store: AnnotationStore, annotationId: string) {
  const item = store.annotations.find(a => a.id === annotationId);
  if (!item) throw new HttpError(404, '批注不存在。');
  return item;
}
function checkVersion(item: PdfAnnotation, expected: unknown) {
  if (typeof expected !== 'string' || expected !== item.updatedAt) throw new HttpError(409, '此批注已被修改，请保留当前草稿并载入最新批注。', { current: item });
}

export async function registerAnnotationRoutes(app: FastifyInstance, workspaceRoot: string, builds: BuildService, emit: EmitEvent) {
  async function successfulBuild(projectId: string, targetId: string, value: unknown) {
    const buildId = field(value, '编译版本', 100);
    if (!/^[A-Za-z0-9_-]+$/.test(buildId)) throw new HttpError(400, '编译版本无效。');
    const build = await builds.get(buildId);
    if (build.projectId !== projectId || build.targetId !== targetId) throw new HttpError(400, '编译版本不属于当前项目及目标。');
    if (build.status !== 'succeeded' || !build.pdf) throw new HttpError(400, '只能批注已有 PDF 的成功编译版本。');
    return build;
  }
  app.get<{ Params: {id: string}; Querystring: {targetId?: string} }>('/api/projects/:id/annotations', async request => {
    const targetId = await checkTarget(workspaceRoot, request.params.id, request.query.targetId);
    const store = await readStore(await registeredRoot(workspaceRoot, request.params.id));
    return { annotations: store.annotations.filter(a => a.targetId === targetId), revision: store.revision };
  });
  app.get<{ Params: {id: string}; Querystring: {targetId?: string; buildId?: string; format?: string} }>('/api/projects/:id/annotations/export', async (request, reply) => {
    const targetId = await checkTarget(workspaceRoot, request.params.id, request.query.targetId);
    const build = await successfulBuild(request.params.id, targetId, request.query.buildId);
    const store = await readStore(await registeredRoot(workspaceRoot, request.params.id));
    const annotations = store.annotations.filter(a => a.targetId === targetId && a.buildId === build.id);
    const prefix = `${request.params.id}-${targetId.replace(/[^A-Za-z0-9._-]/g, '_')}-${build.id}-annotations`;
    const format = request.query.format ?? 'pdf';
    if (!['pdf', 'json', 'md'].includes(format)) throw new HttpError(400, '请选择 PDF、JSON 或 Markdown 格式。');
    reply.header('Content-Disposition', `attachment; filename="${prefix}.${format}"`);
    if (format === 'json') return reply.type('application/json; charset=utf-8').send({ schemaVersion: 1, projectId: request.params.id, targetId, buildId: build.id, sourceHash: build.sourceHash, exportedAt: new Date().toISOString(), annotations });
    if (format === 'md') return reply.type('text/markdown; charset=utf-8').send(annotationMarkdown(request.params.id, build.id, annotations));
    const source = await builds.artifact(build.id, build.pdf!);
    const stat = await fs.stat(source);
    if (stat.size > 100 * 1024 * 1024) throw new HttpError(413, 'PDF 超过 100 MB，请先导出批注清单。');
    const bytes = await exportAnnotatedPdf(await fs.readFile(source), annotations);
    return reply.type('application/pdf').send(Buffer.from(bytes));
  });
  app.post<{ Params: {id: string}; Body: unknown }>('/api/projects/:id/annotations', async (request, reply) => {
    const body = object(request.body);
    const targetId = await checkTarget(workspaceRoot, request.params.id, body.targetId);
    const build = await successfulBuild(request.params.id, targetId, body.buildId);
    const buildId = build.id;
    if (typeof body.page !== 'number' || !Number.isInteger(body.page) || body.page < 1 || body.page > 10000) throw new HttpError(400, '批注页码无效。');
    const kind = annotationKind(body.kind);
    const quote = field(body.quote ?? '', '选中文字', 10000);
    const comment = field(body.comment ?? '', '备注');
    if (kind === 'comment' ? !comment.trim() : !quote.trim()) throw new HttpError(400, kind === 'comment' ? '请输入文字备注。' : '请先选择需要标记的文字。');
    const rects = rectangles(body.rects);
    const offsets = textOffsets(body);
    const root = await registeredRoot(workspaceRoot, request.params.id);
    const annotation = await withLock(`annotations:${root}`, async () => {
      const store = await readStore(root);
      if (store.annotations.length >= 2000) throw new HttpError(400, '本项目已达到 2000 条批注上限，请整理旧批注。');
      const now = new Date().toISOString();
      const result: PdfAnnotation = { id: `ann-${randomUUID()}`, targetId, buildId, status: 'open', ...(build.sourceHash ? {sourceHash: build.sourceHash} : {}), ...offsets, page: body.page as number, kind, quote, rects, comment, createdAt: now, updatedAt: now, revision: 1 };
      store.annotations.push(result);
      await saveStore(root, store);
      return result;
    });
    emit({ type: 'annotation.changed', projectId: request.params.id, path: relative });
    return reply.code(201).send(annotation);
  });
  app.patch<{ Params: {id: string; annotationId: string}; Body: unknown }>('/api/projects/:id/annotations/:annotationId', async request => {
    const body = object(request.body);
    const root = await registeredRoot(workspaceRoot, request.params.id);
    const annotation = await withLock(`annotations:${root}`, async () => {
      const store = await readStore(root);
      const item = existing(store, request.params.annotationId);
      checkVersion(item, body.expectedUpdatedAt);
      if (body.kind === undefined && body.comment === undefined && body.status === undefined && body.source === undefined) throw new HttpError(400, '请选择要更新的批注内容。');
      const kind = body.kind === undefined ? item.kind : annotationKind(body.kind);
      const comment = body.comment === undefined ? item.comment : field(body.comment, '备注');
      if (kind === 'comment' && !comment.trim()) throw new HttpError(400, '请输入文字备注。');
      if (kind !== 'comment' && !item.quote.trim()) throw new HttpError(400, '此位置没有选中文字，请重新选择。');
      item.kind = kind;
      item.comment = comment;
      if (body.status !== undefined) item.status = annotationStatus(body.status);
      if (body.source === null) delete item.source;
      else if (body.source !== undefined) {
        const source = annotationSource(body.source);
        const file = await assertNoSymlinks(root, source.path);
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 3 * 1024 * 1024) throw new HttpError(400, '修改位置必须是 3 MB 以内的文本文件。');
        if (source.line > (await fs.readFile(file, 'utf8')).split('\n').length) throw new HttpError(400, '关联行号超出文件，请核对当前位置。');
        item.source = source;
      }
      item.revision++;
      item.updatedAt = new Date(Math.max(Date.now(), Date.parse(item.updatedAt) + 1)).toISOString();
      await saveStore(root, store);
      return item;
    });
    emit({ type: 'annotation.changed', projectId: request.params.id, path: relative });
    return annotation;
  });
  app.post<{ Params: {id: string; annotationId: string}; Body: unknown }>('/api/projects/:id/annotations/:annotationId/migrate', async (request, reply) => {
    const body = object(request.body);
    if (body.confirmed !== true) throw new HttpError(400, '请先核对候选位置，再确认迁移。');
    const root = await registeredRoot(workspaceRoot, request.params.id);
    const result = await withLock(`annotations:${root}`, async () => {
      const store = await readStore(root);
      const original = existing(store, request.params.annotationId);
      checkVersion(original, body.expectedUpdatedAt);
      const build = await successfulBuild(request.params.id, original.targetId, body.buildId);
      if (build.id === original.buildId) throw new HttpError(400, '请选择不同的编译版本。');
      if (store.annotations.some(a => a.buildId === build.id && a.migratedFrom === original.id)) throw new HttpError(409, '此批注已迁移到该编译版本。');
      if (store.annotations.length >= 2000) throw new HttpError(400, '批注数量已达到上限。');
      if (typeof body.page !== 'number' || !Number.isInteger(body.page) || body.page < 1 || body.page > 10000) throw new HttpError(400, '候选页码无效。');
      const quote = field(body.quote ?? original.quote, '候选原文', 10000);
      if (!original.quote.trim() && body.manualSelection !== true) throw new HttpError(400, '位置备注没有原文，请在新版手动选区后重新关联。');
      const rects = rectangles(body.rects), offsets = textOffsets(body);
      const now = new Date().toISOString();
      const annotation: PdfAnnotation = { ...original, id: `ann-${randomUUID()}`, migratedFrom: original.id, migratedTo: undefined, buildId: build.id, sourceHash: build.sourceHash, page: body.page, quote, rects, startOffset: offsets.startOffset, endOffset: offsets.endOffset, createdAt: now, updatedAt: now, revision: 1 };
      original.migratedTo = [...(original.migratedTo ?? []), annotation.id];
      original.updatedAt = new Date(Math.max(Date.now(), Date.parse(original.updatedAt) + 1)).toISOString(); original.revision++;
      store.annotations.push(annotation); await saveStore(root, store);
      return { annotation, original };
    });
    emit({ type: 'annotation.changed', projectId: request.params.id, path: relative });
    return reply.code(201).send(result);
  });
  app.delete<{ Params: {id: string; annotationId: string}; Querystring: {expectedUpdatedAt?: string}; Body: {expectedUpdatedAt?: unknown} | undefined }>('/api/projects/:id/annotations/:annotationId', async request => {
    const root = await registeredRoot(workspaceRoot, request.params.id);
    await withLock(`annotations:${root}`, async () => {
      const store = await readStore(root);
      const item = existing(store, request.params.annotationId);
      checkVersion(item, request.query.expectedUpdatedAt ?? request.body?.expectedUpdatedAt);
      store.annotations = store.annotations.filter(a => a.id !== item.id);
      await saveStore(root, store);
    });
    emit({ type: 'annotation.changed', projectId: request.params.id, path: relative });
    return { deleted: request.params.annotationId };
  });
}
