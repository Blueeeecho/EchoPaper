import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bold, Highlighter, Italic, MessageSquarePlus, X, Trash2, Check } from 'lucide-react';
import type { PdfAnnotation, PdfAnnotationKind, PdfAnnotationSource, PdfAnnotationStatus, WorkspaceEvent } from '../../shared/types';
import { api, ApiError, json, prettyDate } from '../api';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { findMigrationCandidates, type MigrationCandidate } from '../annotationMigration';
import '../annotations-workflow.css';
import { capturePdfSelection, type PdfTextSelection } from '../pdfSelection';

type AnnotationSelection = Omit<PdfTextSelection, 'startOffset' | 'endOffset'> & Partial<Pick<PdfTextSelection, 'startOffset' | 'endOffset'>>;
type AnnotationDraft = { buildId: string; targetId: string; selection?: AnnotationSelection; existing?: PdfAnnotation; comment: string };
function restoreDraft(key: string, targetId: string): AnnotationDraft | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null') as AnnotationDraft | null;
    if (!value || value.targetId !== targetId || typeof value.buildId !== 'string' || typeof value.comment !== 'string' || !value.comment.trim() || value.comment.length > 20000) return;
    if (value.existing) {
      if (typeof value.existing.id !== 'string' || typeof value.existing.updatedAt !== 'string' || typeof value.existing.quote !== 'string') return;
    } else if (!value.selection || !Number.isSafeInteger(value.selection.page) || typeof value.selection.quote !== 'string' || !Array.isArray(value.selection.rects) || !value.selection.rects.length) return;
    return value;
  } catch { return; }
}
const statusLabels: Record<PdfAnnotationStatus, string> = { open: '待处理', changed: '已修改', verified: '已核验' };
const labels: Record<PdfAnnotationKind, string> = { highlight: '标黄', comment: '文字备注', bold: '加粗标记', italic: '斜体标记' };
export function PdfAnnotationMarks({ annotations, activeId, onOpen, pageHeight }: { annotations: PdfAnnotation[]; activeId?: string; onOpen: (annotation: PdfAnnotation) => void; pageHeight: number }) {
  const sorted = [...annotations].sort((a, b) => a.rects[0].y - b.rects[0].y);
  const tops = sorted.map(a => Math.max(0, a.rects[0].y * pageHeight - 4));
  for (let i = 1; i < tops.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + 29);
  if (tops.length) tops[tops.length - 1] = Math.min(tops[tops.length - 1], pageHeight - 28);
  for (let i = tops.length - 2; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - 29);
  const positions = new Map(sorted.map((a, i) => [a.id, Math.max(0, tops[i])]));
  return <div className="pdf-annotation-marks" aria-label="本页阅读标记">{annotations.map((a, index) => <div key={a.id}>{a.rects.map((rect, i) => <span key={i} className={`pdf-annotation-rect ${a.kind} ${activeId === a.id ? 'active' : ''}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}/>) }{a.kind === 'comment' && <button type="button" className={`pdf-inline-note ${activeId === a.id ? 'active' : ''}`} style={{ left: `${Math.min(.94, a.rects[0].x + a.rects[0].width) * 100}%`, top: `${a.rects[0].y * 100}%` }} onClick={() => onOpen(a)} aria-label={`打开文字备注 ${a.comment}`} title={a.comment}><MessageSquarePlus size={17}/></button>}<button type="button" className={`pdf-annotation-pin ${a.kind} ${activeId === a.id ? 'active' : ''}`} style={{ top: positions.get(a.id) }} onClick={() => onOpen(a)} aria-label={`${labels[a.kind]}：${a.comment || a.quote}`} title={`批注 ${index + 1} · ${labels[a.kind]}${a.comment ? `：${a.comment}` : ''}`}><small>{a.kind === 'bold' ? 'B' : a.kind === 'italic' ? 'I' : a.kind === 'comment' ? <MessageSquarePlus size={10}/> : <Highlighter size={10}/>}</small><span>{index + 1}</span></button></div>)}</div>;
}

export function usePdfAnnotations({ projectId, targetId, buildId, root, goToPage, pdf, onNavigateSource, onViewBuild }: { projectId: string; targetId: string; buildId?: string; root: React.RefObject<HTMLDivElement | null>; goToPage: (page: number, y?: number) => void; pdf?: PDFDocumentProxy; onNavigateSource?: (path: string, line: number) => void; onViewBuild?: (buildId: string) => void }) {
  const draftKey = `echopaper:pdf-note-draft:${projectId}:${targetId}:v1`;
  const [draft, setDraft] = useState<AnnotationDraft | undefined>(() => restoreDraft(draftKey, targetId));
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [open, setOpen] = useState(!!draft);
  const [activeId, setActiveId] = useState<string>();
  const [scope, setScope] = useState<'current' | 'history'>('current');
  const [menu, setMenu] = useState<{ x: number; y: number; selection: AnnotationSelection }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | PdfAnnotationStatus>('all');
  const [migration, setMigration] = useState<{ original: PdfAnnotation; candidates: MigrationCandidate[]; selected?: number; manual?: boolean; limited?: boolean }>();
  const migrationToken = useRef(0);
  const [searchingMigration, setSearchingMigration] = useState(false);
  const currentKey = `${projectId}:${targetId}`;
  const keyRef = useRef(currentKey); keyRef.current = currentKey;
  const url = `/api/projects/${encodeURIComponent(projectId)}/annotations`;
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!projectId || !targetId) return;
    const key = keyRef.current, token = ++generation.current;
    try {
      const result = await api<{ annotations: PdfAnnotation[] }>(`${url}?targetId=${encodeURIComponent(targetId)}`);
      if (keyRef.current === key && token === generation.current) { setAnnotations(result.annotations); setError(''); }
    } catch (e: any) { if (keyRef.current === key && token === generation.current) setError(e.message); }
  }, [url, projectId, targetId]);
  useEffect(() => { setAnnotations([]); setMenu(undefined); setActiveId(undefined); setScope('current'); void refresh(); }, [currentKey, refresh]);
  useEffect(() => { setMenu(undefined); setActiveId(undefined); setMigration(undefined); setSearchingMigration(false); migrationToken.current++; }, [buildId]);
  useEffect(() => {
    try {
      if (draft?.comment.trim()) localStorage.setItem(draftKey, JSON.stringify(draft));
      else localStorage.removeItem(draftKey);
    } catch { setError('浏览器无法保存批注草稿，请先复制备注文字，避免刷新后丢失。'); }
  }, [draft, draftKey]);
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.onmessage = e => { try { const event: WorkspaceEvent = JSON.parse(e.data); if (event.projectId === projectId && (event.type === 'annotation.changed' || event.type === 'file.changed' && event.path === 'notes/pdf-annotations.json')) void refresh(); } catch {} };
    events.onopen = () => { void refresh(); };
    return () => events.close();
  }, [projectId, refresh]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (e: KeyboardEvent | PointerEvent) => { if (e instanceof KeyboardEvent && e.key !== 'Escape') return; if (e.target instanceof Element && e.target.closest('.pdf-selection-menu')) return; setMenu(undefined); };
    window.addEventListener('pointerdown', dismiss); window.addEventListener('keydown', dismiss);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', dismiss); };
  }, [menu]);
  const current = useMemo(() => annotations.filter(a => a.buildId === buildId), [annotations, buildId]);
  const older = useMemo(() => annotations.filter(a => a.buildId !== buildId), [annotations, buildId]);
  const onContextMenu = (e: React.MouseEvent) => {
    if (!root.current || !buildId) return;
    let selection: AnnotationSelection | null = capturePdfSelection(root.current, window.getSelection());
    if (!selection) {
      // A collapsed selection can anchor a free-position note on this page.
      if (!window.getSelection()?.isCollapsed) return;
      const sheet = e.target instanceof Element ? e.target.closest('.pdf-sheet') : null;
      const canvas = sheet?.querySelector('canvas');
      if (!sheet || !canvas || !root.current.contains(sheet)) return;
      const bounds = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(.98, (e.clientX - bounds.left) / bounds.width));
      const y = Math.max(0, Math.min(.98, (e.clientY - bounds.top) / bounds.height));
      selection = { page: Number(sheet.closest<HTMLElement>('[data-page]')?.dataset.page), quote: '', rects: [{ x, y, width: .015, height: .012 }] };
    }
    e.preventDefault(); setError('');
    setMenu({ selection, x: Math.max(8, Math.min(e.clientX, window.innerWidth - 220)), y: Math.max(8, Math.min(e.clientY, window.innerHeight - 255)) });
  };
  function discardDraft() {
    setDraft(undefined);
    try { localStorage.removeItem(draftKey); } catch {}
  }
  function startDraft(value: AnnotationDraft) {
    setOpen(true);
    if (draft?.comment.trim()) { setError('还有未保存的备注，请先保存或取消当前草稿。'); return; }
    setDraft(value); setError('');
  }
  async function mutate(action: () => Promise<unknown>, clearDraft = false) {
    const key = keyRef.current; setBusy(true); setError('');
    try { await action(); if (keyRef.current !== key) return; if (clearDraft) { if (draft?.buildId !== buildId) setScope('history'); discardDraft(); } setMenu(undefined); window.getSelection()?.removeAllRanges(); await refresh(); return true; }
    catch (e: any) { if (keyRef.current === key) { setError(e instanceof ApiError && e.status === 409 ? '这条批注已被其他窗口修改。你的备注仍保留，请复制后载入最新批注再编辑。' : e.message); if (e instanceof ApiError && e.status === 409) { await refresh(); setError('这条批注已被其他窗口修改。你的备注仍保留，请复制后载入最新批注再编辑。'); } } return false; }
    finally { setBusy(false); }
  }
  function add(kind: PdfAnnotationKind) {
    if (!menu || busy) return;
    if (kind === 'comment') { if (buildId) startDraft({ selection: menu.selection, comment: '', buildId, targetId }); setMenu(undefined); setScope('current'); return; }
    const selection = menu.selection;
    void mutate(() => api(url, json('POST', { ...selection, buildId, targetId, kind, comment: '' })));
  }
  function show(a: PdfAnnotation) {
    setOpen(true); setStatusFilter('all'); setActiveId(a.id); setScope(a.buildId === buildId ? 'current' : 'history');
    if (a.buildId === buildId) goToPage(a.page, a.rects[0].y);
    requestAnimationFrame(() => document.getElementById(`pdf-note-${a.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
  function patch(a: PdfAnnotation, body: Record<string, unknown>, expectedUpdatedAt = a.updatedAt) {
    void mutate(() => api(`${url}/${encodeURIComponent(a.id)}`, json('PATCH', { expectedUpdatedAt, ...body })));
  }
  async function startMigration(a: PdfAnnotation) {
    if (!pdf || !buildId || a.buildId === buildId) { setError('请先预览需要迁入的另一成功编译版本。'); return; }
    setError(''); setScope('history');
    if (!a.quote.trim()) { setMigration({ original: a, candidates: [], manual: true }); return; }
    const token = ++migrationToken.current; setSearchingMigration(true);
    try {
      const result = await findMigrationCandidates(pdf, a.quote);
      if (migrationToken.current !== token) return;
      setMigration({ original: a, candidates: result.candidates, limited: result.limited, manual: !result.candidates.length });
    } catch (e: any) { if (migrationToken.current === token) setError(e.message || '候选定位失败，请尝试手动选区。'); }
    finally { if (migrationToken.current === token) setSearchingMigration(false); }
  }
  function selectCandidate(index: number) {
    if (!migration) return;
    const candidate = migration.candidates[index];
    setMigration({ ...migration, selected: index }); setActiveId('migration-preview'); goToPage(candidate.page, candidate.rects[0].y);
  }
  async function confirmMigration() {
    if (!migration || migration.selected === undefined || !buildId) return;
    const value = migration, candidate = value.candidates[value.selected!];
    const ok = await mutate(() => api(`${url}/${encodeURIComponent(value.original.id)}/migrate`, json('POST', { ...candidate, expectedUpdatedAt: value.original.updatedAt, buildId, confirmed: true, manualSelection: !!value.manual })));
    if (ok) { setMigration(undefined); setScope('current'); }
  }
  const preview = useMemo<PdfAnnotation | undefined>(() => {
    if (!migration || migration.selected === undefined || !buildId) return;
    const candidate = migration.candidates[migration.selected];
    return { ...migration.original, ...candidate, id: 'migration-preview', buildId, kind: 'highlight', comment: '迁移候选（尚未保存，请核对后确认）' };
  }, [migration, buildId]);
  const displayCurrent = useMemo(() => preview ? [...current, preview] : current, [current, preview]);
  const listed = (scope === 'current' ? current : older).filter(a => statusFilter === 'all' || (a.status ?? 'open') === statusFilter);
  const exportBase = `${url}/export?targetId=${encodeURIComponent(targetId)}&buildId=${encodeURIComponent(buildId || '')}`;
  const panel = open && <aside className="pdf-notes-panel" aria-label="PDF 批注面板">
    <header><strong>阅读批注</strong><button type="button" className="icon-button" aria-label="关闭 PDF 批注" onClick={() => setOpen(false)}><X size={15}/></button></header>
    <p className="pdf-notes-help">标记不改正文。原始 PDF 保持干净；阅读副本可单独导出。</p>
    <div className="pdf-notes-tabs"><button className={scope === 'current' ? 'active' : ''} onClick={() => setScope('current')}>当前版本 {current.length}</button><button className={scope === 'history' ? 'active' : ''} onClick={() => setScope('history')}>历史版本 {older.length}</button></div>
    <div className="annotation-workflow-toolbar"><select aria-label="筛选批注处理状态" value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}><option value="all">全部处理状态</option>{Object.entries(statusLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      {buildId && <details><summary>导出当前版本</summary><a href={`${exportBase}&format=pdf`} download>带批注 PDF</a><a href={`${exportBase}&format=md`} download>Markdown 清单</a><a href={`${exportBase}&format=json`} download>JSON 清单</a><p>加粗/斜体阅读标记导出为带类型说明的下划线/波浪线批注，保留原 PDF 字体。</p></details>}
    </div>
    {error && <p role="alert" className="pdf-notes-error">{error}</p>}
    {migration && <section className="annotation-migration" aria-label="批注迁移候选"><header><strong>迁移到当前预览版本</strong><button className="icon-button" aria-label="关闭批注迁移" onClick={() => { setMigration(undefined); setActiveId(undefined); }}><X size={13}/></button></header><blockquote>{migration.original.quote || '位置备注（无原文）'}</blockquote>
      <p>候选仅供定位，请核对原文与上下文，再确认复制；原批注会保留。</p>
      {migration.limited && <p>已限制扫描前 300 页或前 40 个候选，请按需手动选区。</p>}
      {migration.candidates.map((candidate, index) => <button key={index} className={migration.selected === index ? 'active' : ''} onClick={() => selectCandidate(index)}>第 {candidate.page} 页 · {candidate.match === 'partial' ? '局部匹配，原文有变化' : '原文匹配'}<small>{candidate.context}</small></button>)}
      {migration.manual && !migration.candidates.length && <p>请在当前 PDF 用鼠标选择新位置，右键选择「关联此选区」。空白备注不会自动猜测位置。</p>}
      <div className="annotation-migration-actions"><button onClick={() => setMigration({ ...migration, manual: true, candidates: [], selected: undefined })}>手动选择位置</button><button className="button primary small" disabled={busy || migration.selected === undefined} onClick={() => void confirmMigration()}>确认复制批注</button></div>
    </section>}
    {draft && <form className="pdf-note-draft" onSubmit={e => { e.preventDefault(); if (!draft.comment.trim() || busy) return; const value = draft; void mutate(() => value.existing ? api(`${url}/${encodeURIComponent(value.existing.id)}`, json('PATCH', { expectedUpdatedAt: value.existing.updatedAt, comment: value.comment })) : api(url, json('POST', { ...value.selection, buildId: value.buildId, targetId: value.targetId, kind: 'comment', comment: value.comment })), true); }}><strong>{draft.existing ? '编辑备注' : '添加文字备注'}</strong><p className="quiet">已保留浏览器草稿{draft.buildId !== buildId ? ' · 属于先前编译，保存后在历史版本查看' : ''}</p><blockquote>{draft.selection?.quote || draft.existing?.quote}</blockquote><textarea autoFocus disabled={busy} aria-label="PDF 批注备注" maxLength={10000} required value={draft.comment} onChange={e => setDraft({ ...draft, comment: e.target.value })} placeholder="写下修改建议、疑问或待办…"/><div><button type="button" className="button small" disabled={busy} onClick={discardDraft}>取消</button><button className="button primary small" disabled={busy || !draft.comment.trim()}><Check size={12}/>保存备注</button></div></form>}
    <div className="pdf-notes-list">{!listed.length && <p className="pdf-notes-empty">{statusFilter === 'all' ? '此版本范围内没有批注' : '没有符合处理状态的批注'}</p>}
      {listed.map(a => <article key={a.id} id={`pdf-note-${a.id}`} data-status={a.status ?? 'open'} className={`pdf-note-card ${a.kind} ${activeId === a.id ? 'active' : ''}`}>
        <button className="pdf-note-anchor" onClick={() => show(a)}><span>{labels[a.kind]} · 第 {a.page} 页</span><small>{prettyDate(a.createdAt)}</small><blockquote className={a.kind}>{a.quote}</blockquote></button>
        <label className="annotation-status"><span>处理状态</span><select aria-label={`批注状态 ${a.id}`} value={a.status ?? 'open'} disabled={busy} onChange={e => patch(a, {status:e.target.value})}>{Object.entries(statusLabels).map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        {a.comment && <p>{a.comment}</p>}
        {a.migratedFrom && <small className="annotation-lineage">由历史批注确认迁入</small>}
        {a.source && <button className="annotation-source-link" title="打开当前源码；若正文已变化，请核对关联行号" onClick={() => onNavigateSource?.(a.source!.path, a.source!.line)} disabled={!onNavigateSource}>{a.source.path}:{a.source.line}</button>}
        <AnnotationSourceForm annotation={a} disabled={busy} onSave={(source, expected) => patch(a, {source}, expected)}/>
        {a.buildId !== buildId && <div className="annotation-history-actions"><small className="pdf-note-old">历史编译 {a.buildId}</small><button disabled={busy || !onViewBuild} onClick={() => onViewBuild?.(a.buildId)}>查看该版 PDF</button><button disabled={busy || searchingMigration || !buildId || !pdf} onClick={() => void startMigration(a)}>{searchingMigration ? '正在寻找位置…' : '定位到当前版本'}</button></div>}
        <div className="pdf-note-actions"><button disabled={busy} onClick={() => { startDraft({ existing: a, comment: a.comment, buildId: a.buildId, targetId: a.targetId }); setActiveId(a.id); }}>{a.comment ? '编辑备注' : '补充备注'}</button><button disabled={busy} aria-label={`删除批注 ${a.quote.slice(0, 25)}`} onClick={() => { void mutate(() => api(`${url}/${encodeURIComponent(a.id)}?expectedUpdatedAt=${encodeURIComponent(a.updatedAt)}`, { method: 'DELETE' })); }}><Trash2 size={12}/>移除</button></div>
      </article>)}
    </div>
  </aside>;
  const contextMenu = menu && createPortal(<div className="pdf-selection-menu" role="menu" aria-label="PDF 选区批注" style={{ left: menu.x, top: menu.y }} onMouseDown={e => e.preventDefault()}><div>PDF 阅读标记 · 不改正文</div>{migration?.manual && <button role="menuitem" onClick={() => { const candidate: MigrationCandidate = { ...menu.selection, startOffset: menu.selection.startOffset ?? 0, endOffset: menu.selection.endOffset ?? 1, match: 'normalized', context: menu.selection.quote || '手动位置备注' }; setMigration({ ...migration, candidates: [candidate], selected: 0 }); setMenu(undefined); setActiveId('migration-preview'); }}>关联此选区</button>}<button role="menuitem" disabled={busy || !menu.selection.quote.trim()} onClick={() => add('bold')}><Bold size={15}/>加粗标记</button><button role="menuitem" disabled={busy || !menu.selection.quote.trim()} onClick={() => add('italic')}><Italic size={15}/>斜体标记</button><button role="menuitem" disabled={busy || !menu.selection.quote.trim()} onClick={() => add('highlight')}><Highlighter size={15}/>标黄</button><button role="menuitem" disabled={busy} onClick={() => add('comment')}><MessageSquarePlus size={15}/>添加文字备注</button>{error && <p role="alert">{error}</p>}</div>, document.body);
  return { current: displayCurrent, activeId, show, onContextMenu, panel, contextMenu, toggle: () => setOpen(value => !value), count: current.length, open };
}

function AnnotationSourceForm({annotation,disabled,onSave}:{annotation:PdfAnnotation;disabled:boolean;onSave:(source:PdfAnnotationSource|null,expectedUpdatedAt:string)=>void}) {
  const [path,setPath]=useState(annotation.source?.path || ''); const [line,setLine]=useState(String(annotation.source?.line || ''));
  const [expected,setExpected]=useState(annotation.updatedAt);
  return <details className="annotation-source-form" onToggle={e=>{if(e.currentTarget.open){setPath(annotation.source?.path || '');setLine(String(annotation.source?.line || ''));setExpected(annotation.updatedAt);}}}><summary>{annotation.source ? '修改关联位置' : '关联修改位置'}</summary><form onSubmit={e=>{e.preventDefault();onSave({path:path.trim(),line:Number(line)},expected);}}><input aria-label={`关联文件 ${annotation.id}`} placeholder="manuscript/tex/章节.tex" required value={path} disabled={disabled} onChange={e=>setPath(e.target.value)}/><input aria-label={`关联行号 ${annotation.id}`} type="number" min="1" max="1000000" placeholder="行号" required value={line} disabled={disabled} onChange={e=>setLine(e.target.value)}/><button className="button small" disabled={disabled}>保存关联</button>{annotation.source && <button type="button" disabled={disabled} onClick={()=>onSave(null,expected)}>移除关联</button>}</form></details>;
}
