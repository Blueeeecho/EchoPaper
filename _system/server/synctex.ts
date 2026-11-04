import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { BuildService } from '../shared/types.ts';
import type { PdfSyncCapability, PdfSyncForward, PdfSyncInverse, PdfSyncLocation } from '../shared/sync-types.ts';
import { contextWordCandidates, type SyncWordHint } from '../src/syncWords.ts';
import { HttpError, assertNoSymlinks, registeredRoot, relativePath, projectId } from './security.ts';

const unzip = promisify(gunzip);
const MAX_UNPACKED = 16 * 1024 * 1024;
const MAX_RECORDS = 250000;
const SP_PER_BP = 65781.76;
interface RawNode { tag: number; line: number; column?: number; page: number; type: string; h: number; v: number; width: number; height: number; depth: number }
export interface ParsedSyncTeX { inputs: Map<number, string>; nodes: RawNode[]; unit: number; magnification: number; xOffset: number; yOffset: number }
interface PageSize { width: number; height: number }
interface IndexedNode extends PdfSyncLocation { path: string; column?: number; quality: number }
interface SyncIndex { nodes: IndexedNode[]; files: string[]; compiledInputs?: string[]; unmapped: PdfSyncLocation[] }

/**
 * SyncTeX v1 line/box records. Unit conversion follows Jérôme Laurens' parser:
 * https://github.com/jlaurens/synctex/blob/main/synctex_parser.c (final tuning).
 * No external source path is ever opened. Forms/post-transform extensions are
 * rejected rather than silently applying unverified coordinates.
 */
export function parseSyncTeX(text: string): ParsedSyncTeX {
  if (Buffer.byteLength(text) > MAX_UNPACKED) throw new HttpError(413, '定位数据超过 16 MB。');
  if (!/^SyncTeX Version:1\r?\n/.test(text)) throw new HttpError(422, '暂不支持此 SyncTeX 格式，请使用当前 Tectonic 重新编译。');
  const result: ParsedSyncTeX = { inputs: new Map(), nodes: [], unit: 1, magnification: 1000, xOffset: 0, yOffset: 0 };
  let page = 0, inContent = false, inPost = false;
  for (const record of text.split(/\r?\n/)) {
    const input = /^Input:(\d+):(.*)$/.exec(record);
    if (input) { result.inputs.set(Number(input[1]), input[2]); continue; }
    if (record === 'Content:') { inContent = true; continue; }
    if (/^Postamble:/.test(record)) { inContent = false; continue; }
    if (/^Post [Ss]criptum:/.test(record)) { inPost = true; continue; }
    const property = /^(Magnification|Unit|X Offset|Y Offset):(.+)$/.exec(record);
    if (property) {
      if (inPost) throw new HttpError(422, '此 PDF 包含额外的 SyncTeX 坐标变换，暂不能可靠定位。');
      const value = Number(property[2]);
      if (!Number.isFinite(value) || Math.abs(value) > 1e12) throw new HttpError(422, '定位数据中的坐标单位无效。');
      if (property[1] === 'Magnification') result.magnification = value;
      if (property[1] === 'Unit') result.unit = value;
      if (property[1] === 'X Offset') result.xOffset = value;
      if (property[1] === 'Y Offset') result.yOffset = value;
      continue;
    }
    if (!inContent) continue;
    const sheet = /^\{(\d+)$/.exec(record);
    if (sheet) { page = Number(sheet[1]); continue; }
    if (record.startsWith('}')) { page = 0; continue; }
    if (record.startsWith('<') || record.startsWith('>') || record.startsWith('f')) throw new HttpError(422, '此 PDF 使用了尚不支持的 SyncTeX 表单定位，请从正文附近定位。');
    if (!page || !'[(hvgkxr$'.includes(record[0] || '\0')) continue;
    const node = /^(\d+),(\d+)(?:,(-?\d+))?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?$/.exec(record.slice(1));
    if (!node) continue;
    const values = node.slice(1).map(value => value === undefined ? undefined : Number(value));
    if (values.some(value => value !== undefined && (!Number.isSafeInteger(value) || Math.abs(value) > 1e12))) continue;
    if (!values[0] || !values[1] || page > 2000) continue;
    result.nodes.push({ type: record[0], tag: values[0]!, line: values[1]!, column: values[2] === undefined || values[2]! < 0 ? undefined : values[2], h: values[3]!, v: values[4]!, width: values[5] || 0, height: values[6] || 0, depth: values[7] || 0, page });
    if (result.nodes.length > MAX_RECORDS) throw new HttpError(413, '定位记录过多。');
  }
  if (result.unit <= 0 || result.magnification <= 0) throw new HttpError(422, '定位数据中的缩放参数无效。');
  if (!result.nodes.length) throw new HttpError(422, '此编译版本没有可用的源码定位记录。');
  return result;
}

function inputRelative(value: string, buildId: string, manifest: Set<string>): string | undefined {
  if (!value || value.includes('\0') || value.includes('\\') || value.split('/').includes('..')) return;
  let candidate = value;
  if (path.posix.isAbsolute(value)) {
    const marker = `/build/${buildId}/source/`;
    const position = value.lastIndexOf(marker);
    if (position < 0) return;
    candidate = value.slice(position + marker.length);
  } else candidate = value.replace(/^\.\//, '');
  if (!manifest.has(candidate) || !/\.tex$/i.test(candidate) || candidate.split('/').some(part => part.startsWith('.'))) return;
  return candidate;
}
export function indexSyncTeX(parsed: ParsedSyncTeX, buildId: string, prefix: string, manifest: Set<string>, pages: PageSize[]): SyncIndex {
  const inputs = new Map<number, string>();
  for (const [tag, input] of parsed.inputs) {
    const relative = inputRelative(input, buildId, manifest);
    if (relative) inputs.set(tag, `${prefix}/${relative}`);
  }
  const factor = parsed.unit / SP_PER_BP * parsed.magnification / 1000;
  const offsetX = parsed.xOffset * parsed.unit / SP_PER_BP, offsetY = parsed.yOffset * parsed.unit / SP_PER_BP;
  const nodes: IndexedNode[] = [];
  const unmapped: PdfSyncLocation[] = [];
  for (const node of parsed.nodes) {
    const source = inputs.get(node.tag), size = pages[node.page - 1];
    const rawInput = parsed.inputs.get(node.tag);
    // Tectonic can emit an empty input name for generated bibliography text.
    // Keep its geometry as an exclusion region, never forge a .tex mapping.
    const generated = rawInput !== undefined && (!rawInput.trim() || /\.bbl$/i.test(rawInput));
    if ((!source && !generated) || !size) continue;
    const h = node.h * factor + offsetX, v = node.v * factor + offsetY;
    let w = Math.abs(node.width * factor), height = Math.abs(node.height * factor), depth = Math.abs(node.depth * factor);
    const box = ['(', 'h', '[', 'v'].includes(node.type);
    if (box && (!w || height + depth < 1 || height + depth > 48 || w > size.width * .95)) continue;
    if (!box) { w = Math.min(w || 4, 12); height = 7; depth = 3; }
    const left = Math.max(0, h), right = Math.min(size.width, h + w);
    const top = Math.max(0, v - height), bottom = Math.min(size.height, v + depth);
    if (right <= left || bottom <= top || left >= size.width || top >= size.height) continue;
    const geometry = {sourceLine: node.line, page: node.page, x: left / size.width, y: top / size.height, width: (right - left) / size.width, height: (bottom - top) / size.height};
    if (!source) { unmapped.push(geometry); continue; }
    nodes.push({ path: source, column: node.column, ...geometry, quality: box ? node.type === '(' ? 0 : 1 : 2 });
  }
  // Captured environments such as acmart's abstract can be read as inputs but
  // rendered under the caller's tag. Retain that verified input membership even
  // when there are no geometric records belonging to the original file.
  return { nodes, unmapped, files: [...new Set(nodes.map(node => node.path))].sort(), compiledInputs: [...new Set(inputs.values())].sort() };
}
const location = ({ page, x, y, width, height, sourceLine }: IndexedNode): PdfSyncLocation => ({ page, x, y, width, height, sourceLine });
export function syncForward(index: SyncIndex, sourcePath: string, line: number): Omit<PdfSyncForward, 'stale' | 'warning'> {
  const matches = index.nodes.filter(node => node.path === sourcePath);
  if (!matches.length) throw new HttpError(404, '此文件没有排版定位记录；宏定义、摘要存储或未引用文件可能只能定位到调用处。');
  const distance = matches.reduce((minimum, node) => Math.min(minimum, Math.abs(node.sourceLine - line)), Infinity);
  const nearest = matches.filter(node => Math.abs(node.sourceLine - line) === distance);
  const rowBoxes = index.nodes.filter(node => node.path === sourcePath && node.quality < 2 && node.height <= .025).slice(0, 5000);
  const expanded = nearest.slice(0, 8192).map(node => {
    const row = rowBoxes.filter(box => box.page === node.page && Math.abs(box.sourceLine - node.sourceLine) <= 2
      && box.x <= node.x + node.width / 2 && box.x + box.width >= node.x + node.width / 2
      && box.y - .004 <= node.y + node.height / 2 && box.y + box.height + .004 >= node.y + node.height / 2)
      .sort((a,b) => b.width - a.width)[0];
    return row ? {...row, sourceLine: node.sourceLine} : node;
  });
  const ordered = expanded.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  // Include kern/glue anchors: XeTeX often attributes entire line boxes to the
  // paragraph-ending line, while in-line citation boxes carry the exact line.
  // Preferring only hboxes would incorrectly jump to a citation mid-paragraph.
  const groups: IndexedNode[] = [];
  for (const node of ordered) {
    const existing = groups.find(group => group.page === node.page
      && Math.abs(group.y + group.height / 2 - node.y - node.height / 2) <= .008
      && node.x <= group.x + group.width + .018 && group.x <= node.x + node.width + .018);
    if (!existing) { groups.push({...node}); continue; }
    const right = Math.max(existing.x + existing.width, node.x + node.width);
    const bottom = Math.max(existing.y + existing.height, node.y + node.height);
    existing.x = Math.min(existing.x, node.x); existing.y = Math.min(existing.y, node.y);
    existing.width = right - existing.x; existing.height = bottom - existing.y;
  }
  // A single source paragraph can wrap into many PDF lines. Keep its later
  // locations so word-level matching is not restricted to the first 24 rows.
  return { locations: groups.slice(0, 128).map(location), sourceLine: groups[0].sourceLine, lineDistance: distance };
}
export function syncInverse(index: SyncIndex, page: number, x: number, y: number): Omit<PdfSyncInverse, 'stale' | 'warning'> {
  const matches = index.nodes.filter(node => node.page === page);
  if (!matches.length) throw new HttpError(404, '此页没有可定位到当前稿件的正文记录。');
  const score = (node: PdfSyncLocation) => {
    const dx = Math.max(node.x - x, 0, x - node.x - node.width);
    const dy = Math.max(node.y - y, 0, y - node.y - node.height);
    return dx * 2 + dy * 4 + node.width * node.height * .02;
  };
  let best = matches.reduce((a, b) => score(a) <= score(b) ? a : b);
  // Overlapping row/glue records can name different input files. Preserve a
  // bounded local candidate set for frontend word/context disambiguation.
  const seen=new Set<string>();
  const alternatives=matches.filter(node=>score(node)<=Math.min(.08,score(best)+.025)).sort((a,b)=>score(a)-score(b)).flatMap(node=>{
    const key=`${node.path}:${node.sourceLine}`;if(seen.has(key))return[];seen.add(key);
    return[{path:node.path,line:node.sourceLine,...(node.column!==undefined?{column:node.column}:{})}];
  }).slice(0,8);
  const generated = index.unmapped.filter(node => node.page === page);
  if (generated.some(node => score(node) <= score(best) + .002)) throw new HttpError(404, '此处是参考文献等自动生成内容，缺少可靠的正文源码记录；请通过文献面板打开 .bib 文件。');
  if (score(best) > .08) throw new HttpError(404, '此位置附近没有可靠的源码定位记录；请点击正文或表格中的文字。');
  // XeTeX's enclosing paragraph row may point at its ending blank line. Prefer
  // an in-row text/glue anchor when available, retaining the row for geometry.
  if (best.quality < 2) {
    const box = best;
    const leaves = matches.filter(node => node.quality === 2
      && node.x >= box.x - .005 && node.x <= box.x + box.width + .005
      && node.y + node.height / 2 >= box.y - .004
      && node.y + node.height / 2 <= box.y + box.height + .004);
    if (leaves.length) best = leaves.reduce((a, b) => score(a) <= score(b) ? a : b);
  }
  return { path: best.path, line: best.sourceLine, ...(best.column !== undefined ? {column: best.column} : {}), location: location(best),alternatives };
}

const integer = (value: unknown, label: string, maximum = 1000000) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new HttpError(400, `${label}无效。`);
  const number = Number(value); if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new HttpError(400, `${label}无效。`); return number;
};
const normalized = (value: unknown) => { if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'PDF 坐标无效。'); const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 1) throw new HttpError(400, 'PDF 坐标必须位于页面范围内。'); return number; };
const staleWarning = '源码已变化，当前定位依据上次成功编译，行号可能偏移；请重新编译后核对。';

export async function registerSyncRoutes(app: FastifyInstance, workspaceRoot: string, builds: BuildService) {
  const cache = new Map<string, { stamp: string; promise: Promise<SyncIndex> }>();
  async function load(id: string) {
    projectId(id);
    const build = await builds.get(id);
    const root = await registeredRoot(workspaceRoot, build.projectId);
    if (build.status !== 'succeeded' || !build.pdf) throw new HttpError(422, '请先成功编译 PDF，再使用双向定位。');
    const relative = `build/${projectId(build.id)}`;
    const config = JSON.parse(await fs.readFile(await assertNoSymlinks(root, `${relative}/compile-config.json`), 'utf8')) as {prefix: string; main: string; targetMain: string};
    const prefix = relativePath(config.prefix), main = relativePath(config.main);
    if (main.includes('/') || !main.endsWith('.tex') || config.targetMain !== `${prefix}/${main}` || !(/^manuscript(?:\/[^/]+)*$/.test(prefix) || /^reviews\/[^/]+\/response(?:\/[^/]+)*$/.test(prefix))) throw new HttpError(422, '此编译版本的源码定位配置无效。');
    const synctex = await assertNoSymlinks(root, `${relative}/artifacts/${main.replace(/\.tex$/, '.synctex.gz')}`);
    const pdf = await assertNoSymlinks(root, `${relative}/artifacts/${relativePath(build.pdf)}`);
    const [stat, pdfStat] = await Promise.all([fs.stat(synctex), fs.stat(pdf)]);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || !pdfStat.isFile() || pdfStat.size > 64 * 1024 * 1024) throw new HttpError(413, '定位文件过大，暂不能读取。');
    const stamp = `${synctex}:${stat.mtimeMs}:${stat.size}:${pdfStat.mtimeMs}:${pdfStat.size}`;
    let entry = cache.get(id);
    if (!entry || entry.stamp !== stamp) {
      const promise = (async () => {
        const unpacked = await unzip(await fs.readFile(synctex), { maxOutputLength: MAX_UNPACKED }).catch(() => { throw new HttpError(422, 'SyncTeX 数据损坏或解压后超过 16 MB。'); });
        const parsed = parseSyncTeX(unpacked.toString('utf8'));
        const manifestFile = await assertNoSymlinks(root, `${relative}/source-manifest.json`);
        const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as {path: string}[];
        if (!Array.isArray(manifest) || manifest.length > 20000) throw new HttpError(422, '源码清单无效。');
        const paths = new Set(manifest.map(file => relativePath(file.path)));
        const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const document = await getDocument({ data: new Uint8Array(await fs.readFile(pdf)), disableFontFace: true, useSystemFonts: false }).promise;
        try {
          if (document.numPages > 2000) throw new HttpError(413, 'PDF 页数超过定位上限。');
          const pages: PageSize[] = [];
          for (let n = 1; n <= document.numPages; n++) {
            const page = await document.getPage(n);
            if (page.rotate !== 0 || page.view[0] !== 0 || page.view[1] !== 0) throw new HttpError(422, '带旋转或裁切原点的 PDF 暂不支持源码定位。');
            pages.push({ width: page.view[2], height: page.view[3] });
          }
          const index = indexSyncTeX(parsed, id, prefix, paths, pages);
          if (!index.nodes.length) throw new HttpError(422, '此 PDF 没有可映射到稿件的定位记录。');
          return index;
        } finally { await document.destroy(); }
      })();
      entry = { stamp, promise }; cache.set(id, entry);
      promise.catch(() => { if (cache.get(id)?.promise === promise) cache.delete(id); });
      if (cache.size > 4) cache.delete(cache.keys().next().value!);
    }
    return { index: await entry.promise, stale: !!build.stale, root, prefix, relative };
  }
  app.get<{Params:{id:string}}>('/api/builds/:id/sync', async request => {
    try { const {index,stale} = await load(request.params.id); return {available:true,method:'synctex-v1',files:index.files,stale,...(stale ? {warning:staleWarning} : {})} satisfies PdfSyncCapability; }
    catch (error) { const failure = error as HttpError; if (failure.statusCode === 403 || failure.statusCode === 400) throw error; return {available:false,stale:false,reason:failure.statusCode && failure.statusCode < 500 ? failure.message : '定位数据读取失败，请重新编译后重试。'} satisfies PdfSyncCapability; }
  });
  app.get<{Params:{id:string};Querystring:{path?:string;line?:string}}>('/api/builds/:id/sync/forward', async request => {
    const sourcePath = relativePath(request.query.path), line = integer(request.query.line, '源码行号');
    const {index,stale,root} = await load(request.params.id);
    await assertNoSymlinks(root, sourcePath);
    const result = syncForward(index, sourcePath, line);
    const warning = [stale ? staleWarning : '', result.lineDistance ? `此行没有直接排版记录，已定位到最近的第 ${result.sourceLine} 行。` : ''].filter(Boolean).join(' ');
    return {...result,stale,...(warning ? {warning} : {})} satisfies PdfSyncForward;
  });
  app.get<{Params:{id:string};Querystring:{page?:string;x?:string;y?:string}}>('/api/builds/:id/sync/inverse', async request => {
    const page = integer(request.query.page,'PDF 页码',2000), x = normalized(request.query.x), y = normalized(request.query.y);
    const {index,stale,root} = await load(request.params.id);
    const result = syncInverse(index,page,x,y);
    await assertNoSymlinks(root,result.path);
    return {...result,stale,...(stale ? {warning:staleWarning} : {})} satisfies PdfSyncInverse;
  });
  app.get<{Params:{id:string};Querystring:{word?:string;before?:string;after?:string}}>('/api/builds/:id/sync/word', async request => {
    const bounded = (value: unknown, limit: number, required = false) => {
      if (value === undefined && !required) return '';
      if (typeof value !== 'string' || value.length > limit || value.includes('\0') || (required && !value.trim())) throw new HttpError(400, '词语或上下文无效或过长。');
      return value;
    };
    const hint: SyncWordHint = {word: bounded(request.query.word,120,true),before: bounded(request.query.before,240),after: bounded(request.query.after,240)};
    const {index,stale,root,prefix,relative} = await load(request.params.id);
    const inputs = index.compiledInputs || index.files;
    if (inputs.length > 2000) throw new HttpError(413, '参与编译的源码文件过多，暂不能按词定位。');
    type Candidate = {path:string;line:number;column:number;from:number;to:number;score:number};
    let best: Candidate | undefined, runnerUp: Candidate | undefined;
    let bytes = 0;
    for (const sourcePath of inputs) {
      // Only scan manifest-backed inputs reported by this successful build.
      // Never read the live manuscript or an arbitrary SyncTeX absolute path.
      if (!sourcePath.startsWith(`${prefix}/`)) throw new HttpError(422, '编译源码索引无效。');
      const file = await assertNoSymlinks(root,`${relative}/source/${relativePath(sourcePath.slice(prefix.length+1))}`);
      const stat = await fs.stat(file);
      bytes += stat.size;
      if (!stat.isFile() || stat.size > 2*1024*1024 || bytes > 8*1024*1024) throw new HttpError(413, '参与编译的源码过大，暂不能按词定位。');
      const text = await fs.readFile(file,'utf8');
      for (const match of contextWordCandidates(text,hint)) {
        const candidate: Candidate = {path:sourcePath,line:match.line,column:match.from-text.lastIndexOf('\n',match.from-1),from:match.from,to:match.to,score:match.score};
        if (best && candidate.path===best.path && candidate.from===best.from && candidate.to===best.to) continue;
        if (!best || candidate.score>best.score) { runnerUp=best;best=candidate; }
        else if (!runnerUp || candidate.score>runnerUp.score) runnerUp=candidate;
      }
    }
    if (!best || best.score<8 || (runnerUp && best.score-runnerUp.score<2)) throw new HttpError(404, '此词在编译源码中没有唯一可靠的上下文匹配。');
    return {path:best.path,line:best.line,column:best.column,stale,...(stale ? {warning:staleWarning} : {})};
  });
}
