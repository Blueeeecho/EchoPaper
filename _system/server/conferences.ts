import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { parse } from 'yaml';
import { HttpError, assertNoSymlinks } from './security.ts';
import { atomicWrite } from './storage.ts';
import { localDeadlineToUtc } from '../shared/deadline.ts';
import type { ConferenceEdition, ConferenceResponse, ConferenceRound, ConferenceSelection, ConferenceFilters } from '../shared/conference-types.ts';
export const CONFERENCE_SOURCE = 'https://ccfddl.top/';
// GitHub Pages currently redirects through HTTP; request the canonical HTTPS host directly.
export const CONFERENCE_DATASET = 'https://ccfddl.com/conference/allconf.yml';
const MAX_BYTES = 4 * 1024 * 1024, TTL = 6 * 60 * 60 * 1000;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown, max = 4000): string => typeof value === 'string' ? value.slice(0, max) : '';
function webUrl(value: unknown): string | undefined { if (typeof value !== 'string' || value.length > 2000) return; try { const url = new URL(value); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch {} }
export function conferenceTimezone(value: unknown): string {
  const raw = str(value, 100).trim();
  if (!raw || raw.toLowerCase() === 'aoe') return 'Etc/GMT+12';
  if (raw === 'PT') return 'America/Los_Angeles';
  const match = /^UTC(?:([+-])(\d{1,2}))?$/.exec(raw);
  if (match && Number(match[2] ?? 0) <= 12) { const n = Number(match[2] ?? 0); return n === 0 ? 'UTC' : `Etc/GMT${match[1] === '+' ? '-' : '+'}${n}`; }
  throw new Error(`数据中的时区不受支持：${raw || '空'}`);
}
function dateValue(raw: string, timezone: string): { at?: string; note?: string; error?: string } {
  if (!raw || /^TBD$/i.test(raw.trim())) return { error: '尚未公布截止时间（TBD），不能自动填写。' };
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/.exec(raw.trim());
  if (!match) return { error: '日期格式不明确，请查看原始记录与官网。' };
  try { return { at: localDeadlineToUtc(`${match[1]}T${match[2] ?? '23:59:59'}`, timezone), ...(!match[2] ? { note: '原记录未写时刻；按 CCFDDL 约定使用 23:59:59，未经会议官网确认。' } : {}) }; }
  catch (error) { return { error: error instanceof Error ? error.message : '日期无效。' }; }
}
export function parseConferenceData(yaml: string): ConferenceEdition[] {
  if (Buffer.byteLength(yaml) > MAX_BYTES) throw new Error('会议数据超过大小限制。');
  const parsed: unknown = parse(yaml, { maxAliasCount: 0, uniqueKeys: true });
  if (!Array.isArray(parsed) || parsed.length > 5000) throw new Error('会议数据结构无效。');
  const editions: ConferenceEdition[] = [], seen = new Set<string>();
  for (const raw of parsed) {
    const item = object(raw), title = str(item.title, 150); if (!title || !Array.isArray(item.confs)) continue;
    for (const rawConf of item.confs) {
      const conf = object(rawConf), year = Number(conf.year), id = str(conf.id, 100);
      if (!id || !Number.isInteger(year) || year < 1970 || year > 2200 || seen.has(id) || !Array.isArray(conf.timeline)) continue;
      seen.add(id); if (editions.length >= 20000) throw new Error('会议记录超过数量限制。');
      const rounds: ConferenceRound[] = [];
      for (const [index, rawRound] of conf.timeline.slice(0,100).entries()) {
        const round = object(rawRound), notes: string[] = [];
        const sourceTimezone = str(round.timezone ?? conf.timezone, 100) || 'AoE（CCFDDL 默认）';
        if (!round.timezone && !conf.timezone) notes.push('原记录未写时区；按 CCFDDL 约定使用 AoE，未经会议官网确认。');
        let timezone: string | undefined, zoneError: string | undefined;
        try { timezone = conferenceTimezone(round.timezone ?? conf.timezone); } catch (error) { zoneError = (error as Error).message; }
        const rawDeadline = str(round.deadline, 100), rawAbstractDeadline = str(round.abstract_deadline,100) || undefined;
        const date = timezone ? dateValue(rawDeadline,timezone) : { error: zoneError };
        const abstract = rawAbstractDeadline && timezone ? dateValue(rawAbstractDeadline,timezone) : undefined;
        if (date.note) notes.push(date.note); if (abstract?.note) notes.push(`摘要：${abstract.note}`);
        const comment = str(round.comment) || undefined; const extra = str(round.note ?? conf.note ?? conf.notes); if (extra) notes.push(extra);
        rounds.push({ id: `${id}:round-${index + 1}`, label: `第 ${index + 1} 轮`, rawDeadline, rawAbstractDeadline, deadlineAt: date.at, abstractDeadlineAt: abstract?.at, deadlineTimezone: timezone, sourceTimezone, comment, notes, unavailableReason: date.error });
      }
      editions.push({ id, title, description: str(item.description,1000), year, ccf: str(object(item.rank).ccf,20) || undefined, officialUrl: webUrl(conf.link), date: str(conf.date,500) || undefined, place: str(conf.place,500) || undefined, rounds });
    }
  }
  if (!editions.length) throw new Error('会议数据中没有可识别的记录。');
  return editions;
}
interface Cached { fetchedAt: string; yaml: string; conferences: ConferenceEdition[] }
export function conferenceSelection(edition: ConferenceEdition, round: ConferenceRound, fetchedAt: string): ConferenceSelection | undefined {
  if (!round.deadlineAt || !round.deadlineTimezone) return;
  return { venue: `${edition.title} ${edition.year}`, deadlineAt: round.deadlineAt, deadlineTimezone: round.deadlineTimezone, deadlineSource: { sourceUrl: CONFERENCE_SOURCE, conferenceId: edition.id, year: edition.year, roundId: round.id, fetchedAt, ...(edition.officialUrl ? { officialUrl: edition.officialUrl } : {}), notes: ['CCFDDL 聚合记录，未独立核对会议官网。', `${round.label}；原始截止：${round.rawDeadline}；时区：${round.sourceTimezone}`, round.rawAbstractDeadline ? `摘要截止原文：${round.rawAbstractDeadline}` : '', round.comment, ...round.notes].filter(Boolean).join('\n').slice(0,4000) } };
}
export interface ConferenceOptions { fetcher?: typeof fetch; now?: () => number; timeoutMs?: number }
export function createConferenceService(workspaceRoot: string, options: ConferenceOptions = {}) {
  let cached: Cached | undefined, pending: Promise<void> | undefined, loaded = false, warning: string | undefined;
  const now = options.now ?? Date.now;
  async function readCache() {
    if (loaded) return; loaded = true;
    try {
      const file = await assertNoSymlinks(workspaceRoot, '_system/runtime/conferences-cache.json', true);
      if ((await fs.stat(file)).size > MAX_BYTES * 2) return;
      const value = JSON.parse(await fs.readFile(file,'utf8'));
      if (typeof value.yaml !== 'string' || typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt)) || Date.parse(value.fetchedAt) > now()+60000) return;
      cached = { fetchedAt: value.fetchedAt, yaml: value.yaml, conferences: parseConferenceData(value.yaml) };
    } catch { /* Cache is disposable; a network refresh can rebuild it. */ }
  }
  async function refresh() {
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),options.timeoutMs ?? 15000);
      try {
        const response = await (options.fetcher ?? fetch)(CONFERENCE_DATASET, { signal: controller.signal, redirect: 'error', headers: { Accept: 'text/yaml,text/plain' } });
        if (!response.ok || !response.body) throw new Error(`数据源响应 ${response.status}`);
        if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('数据源内容过大');
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > MAX_BYTES) throw new Error('数据源内容过大'); chunks.push(part.value); } } finally { await reader.cancel().catch(()=>{}); }
        const yaml = new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)), conferences = parseConferenceData(yaml), fetchedAt = new Date(now()).toISOString();
        cached = { yaml, conferences, fetchedAt }; warning = undefined;
        try { const file = await assertNoSymlinks(workspaceRoot,'_system/runtime/conferences-cache.json',true); await atomicWrite(file,JSON.stringify({fetchedAt,yaml})); }
        catch { warning = '已取得公开数据，但本地缓存写入失败；本次结果仍可使用。'; }
      } catch { warning = cached ? '公开数据刷新失败，正显示上次成功缓存；采用前请核对官网。' : '无法取得 CCFDDL 数据，请检查网络后重试。'; }
      finally { clearTimeout(timer); pending = undefined; }
    })();
    return pending;
  }
  async function dataset(force = false): Promise<Cached> {
    await readCache(); if (force || !cached || now()-Date.parse(cached.fetchedAt)>TTL) await refresh();
    if (!cached) throw new HttpError(503,warning ?? '会议数据暂不可用。');
    return cached;
  }
  return { async query(query: string, force = false, filters: ConferenceFilters = {}): Promise<ConferenceResponse> {
    const data = await dataset(force), timestamp = now(), rank = filters.rank ?? 'all', upcoming = filters.upcoming ?? false, sort = filters.sort ?? 'year';
    const offset = filters.offset ?? 0, limit = filters.limit ?? 80;
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matching = data.conferences.filter(c=>{
      const searchable = `${c.title} ${c.description} ${c.year} ${c.id}`.toLowerCase();
      return tokens.every(token=>searchable.includes(token)) && (rank === 'all' || c.ccf?.toUpperCase() === rank);
    });
    const currentYear = Number(new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',year:'numeric'}).format(timestamp));
    // An unpublished deadline cannot be classified as future. Count current/
    // later conference years separately, without making their rounds selectable.
    const pendingCount = matching.filter(edition=>edition.year>=currentYear).reduce((n,edition)=>n+edition.rounds.filter(round=>!round.rawDeadline||/^TBD$/i.test(round.rawDeadline.trim())).length,0);
    const roundTime = (round: ConferenceRound) => round.deadlineAt ? Date.parse(round.deadlineAt) : Infinity;
    const all = matching.map(edition=>{
      const rounds = edition.rounds.filter(round=>!upcoming || !!round.deadlineAt && !!round.deadlineTimezone && roundTime(round)>timestamp);
      if (upcoming || sort === 'deadline') rounds.sort((a,b)=>roundTime(a)-roundTime(b)||a.id.localeCompare(b.id));
      return {...edition,rounds};
    }).filter(edition=>!upcoming || edition.rounds.length>0);
    const firstDeadline = (edition: ConferenceEdition) => edition.rounds.reduce((first,round)=>Math.min(first,roundTime(round)),Infinity);
    all.sort((a,b)=>(sort === 'deadline' ? firstDeadline(a)-firstDeadline(b) : 0)||b.year-a.year||a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
    const fetchedAt = data.fetchedAt;
    return { conferences: all.slice(offset,offset+limit).map(edition=>({...edition,rounds:edition.rounds.map(round=>({...round,selection:conferenceSelection(edition,round,fetchedAt)}))})), total: all.length, sourceUrl: CONFERENCE_SOURCE, datasetUrl: CONFERENCE_DATASET, fetchedAt, stale: timestamp-Date.parse(fetchedAt)>TTL || !!warning, warning, pendingCount, evaluatedAt:new Date(timestamp).toISOString(), filters:{rank,upcoming,sort}, pagination:{offset,limit,hasMore:offset+limit<all.length} };
  }, async selection(conferenceId: string, roundId: string) {
    const data=await dataset(),edition=data.conferences.find(item=>item.id===conferenceId),round=edition?.rounds.find(item=>item.id===roundId);
    if (!edition || !round) throw new HttpError(404,'找不到指定会议年份或轮次。');
    const selection=conferenceSelection(edition,round,data.fetchedAt);
    if (!selection) throw new HttpError(409,round.unavailableReason??'该轮尚无可采用的截止时间。');
    return {selection,stale:now()-Date.parse(data.fetchedAt)>TTL||!!warning,fetchedAt:data.fetchedAt,warning};
  }};
}
export async function registerConferenceRoutes(app: FastifyInstance, workspaceRoot: string, options: ConferenceOptions = {}) {
  const service = createConferenceService(workspaceRoot,options);
  app.get<{Querystring:{q?:string;refresh?:string;rank?:string;upcoming?:string;sort?:string;offset?:string;limit?:string}}>('/api/conferences',async request=>{
    if (request.query.q !== undefined && (typeof request.query.q !== 'string' || request.query.q.length>100)) throw new HttpError(400,'会议搜索词最多 100 个字符。');
    if (request.query.refresh !== undefined && !['0','1'].includes(request.query.refresh)) throw new HttpError(400,'刷新参数无效。');
    const {rank,upcoming,sort,offset,limit}=request.query;
    if (rank !== undefined && !['A','B','C','all'].includes(rank)) throw new HttpError(400,'CCF 等级须为 A、B、C 或 all。');
    if (upcoming !== undefined && !['0','1'].includes(upcoming)) throw new HttpError(400,'未来截止筛选参数无效。');
    if (sort !== undefined && !['year','deadline'].includes(sort)) throw new HttpError(400,'会议排序参数无效。');
    const numeric=(value:string|undefined,name:string,minimum:number,maximum:number)=>{if(value===undefined)return undefined;if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<minimum||Number(value)>maximum)throw new HttpError(400,`${name}无效。`);return Number(value);};
    return service.query(request.query.q ?? '',request.query.refresh==='1',{rank:rank as ConferenceFilters['rank'],upcoming:upcoming==='1',sort:sort as ConferenceFilters['sort'],offset:numeric(offset,'分页位置',0,20000),limit:numeric(limit,'分页数量',1,200)});
  });
  app.get<{Querystring:{conferenceId?:string;roundId?:string}}>('/api/conferences/selection',async request=>{
    const {conferenceId,roundId}=request.query;
    if (typeof conferenceId!=='string'||!conferenceId||conferenceId.length>200||typeof roundId!=='string'||!roundId||roundId.length>250) throw new HttpError(400,'请指定会议 ID 和轮次 ID。');
    return service.selection(conferenceId,roundId);
  });
}
