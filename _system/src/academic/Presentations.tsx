import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, CheckCircle2, ChevronRight, CircleAlert, Download, FileText, FolderSearch, Image, Layers3, LoaderCircle, Plus, Presentation, RefreshCw, Save, Settings2, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { api, ApiError, downloadText, json, prettyDate } from '../api';
import type { PresentationBlock, PresentationDocument, PresentationFile, PresentationJob, PresentationLanguage, PresentationLayout, PresentationSection, PresentationSlide, PresentationSummary, StylePack } from '../../shared/presentation-types';
import type { Resource, ResourcePage } from '../../shared/workspace-types';
import PresentationPreview from './PresentationPreview';
import {templateCoverUrl} from './templateCover';
import './presentations.css';

export interface PresentationsProps {
  presentationId?: string;
  paperId?: string;
  initialStyleId?: string;
  initialStyleVersion?: string;
  onNavigate: (path: string) => void;
  onDirtyGuard?: (guard: (() => Promise<boolean>) | undefined) => void;
  onError?: (message: string) => void;
}
type Stage = 'materials' | 'style' | 'outline' | 'edit';
type Draft = { document: PresentationDocument; baselineHash: string; baselineDocument?: PresentationDocument; savedAt: string; chartSeriesDrafts?: Record<string, string> };
type AIConfig = { configured?: boolean; defaultModel?: string | null; models?: { id: string; label?: string; configured?: boolean }[] };
const endpoint = (id: string) => `/api/presentations/${encodeURIComponent(id)}`;
const draftKey = (id: string) => `echopaper:presentation-draft:${id}`;
const activeStatuses = ['queued', 'running'];
const sections: PresentationSection[] = ['封面', '目录', '研究背景', '研究内容', '研究结果', '未来计划', '致谢'];
const layouts: Record<PresentationLayout, string> = { cover: '封面', contents: '目录', explanation: '内容说明', comparison: '对照比较', table: '表格', figure: '图文', pipeline: '方法流程', case: '英文案例', thanks: '致谢' };
const noteLabels = { purpose: '本页目的', speech: '讲稿建议', transition: '过渡句', questions: '可能追问' };
const statusLabels: Record<PresentationJob['status'], string> = { queued: '等待执行', running: '正在执行', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const languageLabels: Record<PresentationLanguage, string> = { zh: '中文', en: '英文', 'zh-en': '中英双语' };
const clone = <T,>(value: T): T => structuredClone(value);
const serialize = (value: unknown) => JSON.stringify(value);
const seriesKey = (slideId: string, blockId: string) => `${slideId}:${blockId}`;
const formatSeries = (block: PresentationBlock) => (block.series || []).map(series => [series.name, ...series.values].join(' | ')).join('\n');
function parseSeries(raw: string, columns: number): { series: NonNullable<PresentationBlock['series']>; error?: string } {
  const series: NonNullable<PresentationBlock['series']> = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    const [name, ...numbers] = line.split(/\t|\s*\|\s*/);
    if (!numbers.length || numbers.some(value => !value.trim() || !Number.isFinite(Number(value)))) return { series: [], error: `第 ${index + 1} 行含未完成或无效数字，请填写完整数值。` };
    if (!columns || numbers.length !== columns) return { series: [], error: `第 ${index + 1} 行需要 ${columns || '与横轴对应的'} 个数值，请核对横轴标签。` };
    series.push({ name, values: numbers.map(Number) });
  }
  return series.length ? { series } : { series, error: '请至少填写一行完整数据。' };
}
const uniqueId = (kind: string) => `${kind}-${crypto.randomUUID()}`;
const newBlock = (type: PresentationBlock['type'] = 'text'): PresentationBlock => ({ id: uniqueId('block'), type, ...(type === 'table' ? { headers: ['项目', '内容'], rows: [['', '']] } : type === 'steps' ? { steps: [{ title: '', text: '' }] } : type === 'chart' ? { labels: [], series: [] } : { text: '', textEn: '' }), ...(type === 'case' ? { verbatim: true } : {}) });
const newSlide = (): PresentationSlide => ({ id: uniqueId('slide'), section: '研究内容', layout: 'explanation', title: '新页面', titleEn: '', keyMessage: '', blocks: [newBlock()], notes: { purpose: '', speech: '', transition: '', questions: '' }, sourceIds: [] });

function Dialog({ title, children, onClose, error }: { title: string; children: ReactNode; onClose: () => void; error?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement; ref.current?.focus(); return () => previous?.focus?.(); }, []);
  return <div className="presentation-modal-backdrop"><div className="presentation-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') {
      const fields = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]') || []);
      const first = fields[0], last = fields.at(-1);
      if (first && ((!fields.includes(document.activeElement as HTMLElement)) || (!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first))) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
    }
  }}><header><h2>{title}</h2><button className="presentation-icon-button" aria-label={`关闭${title}`} onClick={onClose}><X size={17}/></button></header>{error && <p className="presentation-error-text" role="alert">{error}</p>}{children}</div></div>;
}

function LanguageSelect({ label, value, onChange }: { label: string; value: PresentationLanguage; onChange: (value: PresentationLanguage) => void }) {
  return <label className="presentation-field"><span>{label}</span><select value={value} onChange={event => onChange(event.target.value as PresentationLanguage)}>{Object.entries(languageLabels).map(([key, text]) => <option value={key} key={key}>{text}</option>)}</select></label>;
}

export default function Presentations({ presentationId, paperId, initialStyleId, initialStyleVersion, onNavigate, onDirtyGuard, onError }: PresentationsProps) {
  const [summaries, setSummaries] = useState<PresentationSummary[]>([]), [styles, setStyles] = useState<StylePack[]>([]);
  const [file, setFile] = useState<PresentationFile>(), [document, setDocument] = useState<PresentationDocument>();
  const [chartSeriesDrafts, setChartSeriesDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [stage, setStage] = useState<Stage>('materials'), [selectedSlide, setSelectedSlide] = useState(''), [inspector, setInspector] = useState<'content' | 'notes' | 'sources'>('content');
  const [createOpen, setCreateOpen] = useState(false), [createTitle, setCreateTitle] = useState(''), [usePaper, setUsePaper] = useState(!!paperId);
  const [createStyleKey, setCreateStyleKey] = useState('');
  const [jobs, setJobs] = useState<PresentationJob[]>([]), [job, setJob] = useState<PresentationJob>(), [pollStopped, setPollStopped] = useState(false), [pollRevision, setPollRevision] = useState(0);
  const [aiConfig, setAiConfig] = useState<AIConfig>(), [aiReadError, setAiReadError] = useState('');
  const [reviewed, setReviewed] = useState(false), [recovery, setRecovery] = useState<Draft>(), [conflict, setConflict] = useState<PresentationFile>(), [compareOpen, setCompareOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false), [reloadOpen, setReloadOpen] = useState(false), [deleteSlideId, setDeleteSlideId] = useState(''), [removeSourceId, setRemoveSourceId] = useState('');
  const [sourceText, setSourceText] = useState(''), [sourceName, setSourceName] = useState(''), [resourceQuery, setResourceQuery] = useState(''), [resourceSearchOpen, setResourceSearchOpen] = useState(false);
  const [resources, setResources] = useState<Resource[]>([]), [resourceLoading, setResourceLoading] = useState(false), [resourceError, setResourceError] = useState('');
  const [regenerateInstruction, setRegenerateInstruction] = useState('');
  const latest = useRef({ document, file, busy, presentationId, jobs, chartSeriesDrafts });
  latest.current = { document, file, busy, presentationId, jobs, chartSeriesDrafts };
  const actionLock = useRef(false), leaveResolver = useRef<((value: boolean) => void) | undefined>(undefined), errorCallback = useRef(onError);
  errorCallback.current = onError;
  const uploadRef = useRef<HTMLInputElement>(null), loadEpoch = useRef(0), draftStorageWarned = useRef(false);
  const dirty = !!document && !!file && (serialize(document) !== serialize(file.document) || Object.keys(chartSeriesDrafts).length > 0);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const hasActiveJob = !!job && activeStatuses.includes(job.status);
  const disabled = !!busy || hasActiveJob;
  const activeSlide = document?.slides.find(slide => slide.id === selectedSlide) || document?.slides[0];
  const slideIndex = activeSlide ? document!.slides.findIndex(slide => slide.id === activeSlide.id) : 0;
  const style = styles.find(item => item.id === document?.styleId && item.version === document?.styleVersion) || styles.find(item => item.id === document?.styleId);
  const creationStyle = createStyleKey ? styles.find(item => `${item.id}@${item.version}` === createStyleKey) : styles[0];
  const successfulExport = jobs.find(item => item.kind === 'export' && item.status === 'succeeded' && item.downloadUrl);
  const exportedDocumentHash = successfulExport?.documentHash;
  const exportCurrent = !!successfulExport && !!exportedDocumentHash && exportedDocumentHash === file?.hash && !dirty;
  const modelReady = !!aiConfig?.defaultModel && aiConfig.configured !== false;
  const modelName = aiConfig?.models?.find(item => item.id === aiConfig.defaultModel)?.label || aiConfig?.defaultModel;

  const notifyError = useCallback((message: string) => { setError(message); errorCallback.current?.(message); }, []);
  const acceptFile = useCallback((next: PresentationFile) => { setFile(next); setDocument(clone(next.document)); setChartSeriesDrafts({}); setConflict(undefined); setReviewed(false); }, []);
  const refreshAI = useCallback(async () => { try { const next = await api<AIConfig>('/api/ai/config'); setAiConfig(next); setAiReadError(''); } catch (error: unknown) { setAiReadError(error instanceof Error ? error.message : '模型配置读取失败'); } }, []);

  useEffect(() => { void refreshAI(); window.addEventListener('echopaper:model-config-changed', refreshAI); return () => window.removeEventListener('echopaper:model-config-changed', refreshAI); }, [refreshAI]);
  useEffect(() => {
    if (!presentationId && initialStyleId && initialStyleVersion) { setCreateStyleKey(`${initialStyleId}@${initialStyleVersion}`); setCreateOpen(true); }
  }, [presentationId, initialStyleId, initialStyleVersion]);
  useEffect(() => {
    const abort = new AbortController();
    void api<{ styles: StylePack[] }>('/api/presentation-styles', { signal: abort.signal }).then(result => setStyles(result.styles)).catch(error => { if (error.name !== 'AbortError') notifyError(error.message); });
    return () => abort.abort();
  }, [notifyError]);
  useEffect(() => {
    const epoch = ++loadEpoch.current, abort = new AbortController();
    setLoading(true); setError(''); setNotice(''); setRecovery(undefined); setConflict(undefined); setDocument(undefined); setFile(undefined); setChartSeriesDrafts({}); setJobs([]); setJob(undefined); setReviewed(false); setSourceText(''); setSourceName('');
    const load = async () => {
      try {
        if (!presentationId) {
          const result = await api<{ presentations: PresentationSummary[] }>('/api/presentations', { signal: abort.signal });
          if (epoch === loadEpoch.current) setSummaries(result.presentations);
        } else {
          const [next, result] = await Promise.all([api<PresentationFile>(endpoint(presentationId), { signal: abort.signal }), api<{ jobs: PresentationJob[] }>(`${endpoint(presentationId)}/jobs`, { signal: abort.signal })]);
          if (epoch !== loadEpoch.current) return;
          acceptFile(next); setSelectedSlide(next.document.slides[0]?.id || ''); setJobs(result.jobs); setJob(result.jobs.find(item => activeStatuses.includes(item.status)) || result.jobs[0]);
          setStage(next.document.slides.length ? 'edit' : next.document.sources.length ? 'style' : 'materials');
          try { const saved = localStorage.getItem(draftKey(presentationId)); if (saved) { const draft = JSON.parse(saved) as Draft; if (draft.document?.id === presentationId && draft.baselineHash && (serialize(draft.document) !== serialize(next.document) || Object.keys(draft.chartSeriesDrafts || {}).length)) setRecovery(draft); else localStorage.removeItem(draftKey(presentationId)); } } catch { /* An unavailable local draft does not replace the saved document. */ }
        }
      } catch (error: unknown) { if (!abort.signal.aborted) notifyError(error instanceof Error ? error.message : '读取演示项目失败'); }
      finally { if (epoch === loadEpoch.current) setLoading(false); }
    };
    void load();
    return () => abort.abort();
  }, [presentationId, acceptFile, notifyError]);

  useEffect(() => {
    if (!document || !file) return;
    const timer = window.setTimeout(() => {
      try {
        if (dirty) localStorage.setItem(draftKey(document.id), serialize({ document, baselineHash: file.hash, baselineDocument: file.document, chartSeriesDrafts, savedAt: new Date().toISOString() } satisfies Draft));
        else if (!recovery) localStorage.removeItem(draftKey(document.id));
      } catch { if (!draftStorageWarned.current) { setNotice('浏览器本地草稿空间不可用，请及时保存或下载内容备份。'); draftStorageWarned.current = true; } }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [document, file, dirty, recovery, chartSeriesDrafts]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, []);
  useEffect(() => {
    onDirtyGuard?.(async () => {
      if (!dirtyRef.current) return true;
      if (leaveResolver.current) return false;
      return new Promise<boolean>(resolve => { leaveResolver.current = resolve; setLeaveOpen(true); });
    });
    return () => { onDirtyGuard?.(undefined); leaveResolver.current?.(false); leaveResolver.current = undefined; };
  }, [onDirtyGuard]);

  function updateDocument(edit: (next: PresentationDocument) => void) {
    setDocument(current => { if (!current) return current; const next = clone(current); edit(next); delete next.approvedOutlineHash; return next; });
    setReviewed(false); setNotice('');
  }
  function updateSlide(patch: Partial<PresentationSlide>) { if (activeSlide) updateDocument(next => { const index = next.slides.findIndex(slide => slide.id === activeSlide.id); next.slides[index] = { ...next.slides[index], ...patch }; }); }
  function updateBlock(blockId: string, patch: Partial<PresentationBlock>) { if (activeSlide) updateDocument(next => { const block = next.slides.find(slide => slide.id === activeSlide.id)?.blocks.find(block => block.id === blockId); if (block) Object.assign(block, patch); }); }
  function backupDraft() { const current = latest.current.document; if (current) downloadText(`${current.title || current.id}-内容备份.json`, JSON.stringify({ document: current, baselineHash: latest.current.file?.hash, chartSeriesDrafts: latest.current.chartSeriesDrafts, savedAt: new Date().toISOString() }, null, 2)); }
  function persistDraftNow() { const current = latest.current; if (current.document && current.file) { try { localStorage.setItem(draftKey(current.document.id), serialize({ document: current.document, baselineHash: current.file.hash, baselineDocument: current.file.document, chartSeriesDrafts: current.chartSeriesDrafts, savedAt: new Date().toISOString() })); return true; } catch { backupDraft(); return true; } } return false; }
  async function reportFailure(error: unknown) {
    if (error instanceof ApiError && error.status === 409 && latest.current.presentationId) {
      try { const disk = await api<PresentationFile>(endpoint(latest.current.presentationId)); if (disk.hash === latest.current.file?.hash) { notifyError(error.message); return; } setConflict(disk); } catch { /* The local draft remains available when disk re-read fails. */ }
      persistDraftNow(); notifyError('文件已在其他窗口修改。当前编辑已保留，请比较版本或载入最新内容，不能直接覆盖。');
    } else notifyError(error instanceof Error ? error.message : '操作失败，请重试。');
  }
  async function saveDocument(): Promise<PresentationFile | undefined> {
    const current = latest.current;
    if (!current.document || !current.file) return undefined;
    if (!current.document.title.trim()) { notifyError('请填写演示标题后保存。'); return undefined; }
    const snapshot = clone(current.document);
    const documentSnapshot = serialize(current.document), seriesSnapshot = serialize(current.chartSeriesDrafts);
    for (const [key, raw] of Object.entries(current.chartSeriesDrafts)) {
      const [slideId, blockId] = key.split(':');
      const slideIndex = snapshot.slides.findIndex(slide => slide.id === slideId), block = snapshot.slides[slideIndex]?.blocks.find(item => item.id === blockId);
      if (!block || block.type !== 'chart') continue;
      const parsed = parseSeries(raw, block.labels?.length || 0);
      if (parsed.error) { notifyError(`第 ${slideIndex + 1} 页图表数据未保存：${parsed.error}`); return undefined; }
      block.series = parsed.series;
    }
    if (serialize(snapshot) === serialize(current.file.document)) { setChartSeriesDrafts({}); latest.current = { ...latest.current, chartSeriesDrafts: {} }; return current.file; }
    try {
      const next = await api<PresentationFile>(endpoint(snapshot.id), json('PUT', { document: snapshot, expectedHash: current.file.hash }));
      setFile(next);
      const canAdopt = serialize(latest.current.document) === documentSnapshot && serialize(latest.current.chartSeriesDrafts) === seriesSnapshot;
      if (canAdopt) { setDocument(clone(next.document)); setChartSeriesDrafts({}); try { localStorage.removeItem(draftKey(snapshot.id)); } catch { /* Saved on disk. */ } }
      setConflict(undefined); setNotice('内容已保存。');
      latest.current = { ...latest.current, file: next, document: canAdopt ? clone(next.document) : latest.current.document, chartSeriesDrafts: canAdopt ? {} : latest.current.chartSeriesDrafts };
      return next;
    } catch (error: unknown) { await reportFailure(error); return undefined; }
  }
  async function run(label: string, action: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(label); setError(''); setNotice('');
    try { await action(); } catch (error: unknown) { await reportFailure(error); }
    finally { actionLock.current = false; setBusy(''); }
  }
  async function save() { await run('正在保存', async () => { await saveDocument(); }); }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && latest.current.document) { event.preventDefault(); event.stopPropagation(); if (!actionLock.current) void save(); } };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  });
  async function createPresentation() {
    if (!createTitle.trim() || !creationStyle) return;
    await run('正在新建', async () => {
      let next = await api<PresentationFile>('/api/presentations', json('POST', { title: createTitle.trim(), styleId: creationStyle.id, styleVersion: creationStyle.version, ...(usePaper && paperId ? { paperId } : {}) }));
      if (usePaper && paperId && !next.document.sources.some(source => source.paperId === paperId)) {
        try { next = await api<PresentationFile>(`${endpoint(next.document.id)}/sources`, json('POST', { paperId, expectedHash: next.hash })); }
        catch (error: unknown) { notifyError(`演示已创建，但论文材料未接入：${error instanceof Error ? error.message : '请在材料页重试'}`); }
      }
      setCreateOpen(false); setCreateTitle(''); onNavigate(`/presentations/${encodeURIComponent(next.document.id)}`);
    });
  }
  async function addSource(input: { text?: string; name?: string; resourceId?: string; paperId?: string }) {
    await run('正在接入材料', async () => {
      const saved = await saveDocument(); if (!saved) return;
      const next = await api<PresentationFile>(`${endpoint(saved.document.id)}/sources`, json('POST', { ...input, expectedHash: saved.hash }));
      acceptFile(next); setSourceText(''); setSourceName(''); setResourceSearchOpen(false); setNotice('材料已接入；可继续添加或进入样式设置。');
    });
  }
  async function removeSource() {
    await run('正在移除材料', async () => {
      const saved = await saveDocument(); if (!saved) return;
      const next = await api<PresentationFile>(`${endpoint(saved.document.id)}/sources/${encodeURIComponent(removeSourceId)}`, json('DELETE', { expectedHash: saved.hash }));
      acceptFile(next); setRemoveSourceId(''); setNotice('材料已从演示移除。原始文件保持不变。');
    });
  }
  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    const selected = Array.from(files);
    await run('正在导入文件', async () => {
      let saved = await saveDocument(); if (!saved) return;
      for (const file of selected) {
        const body = new FormData(); body.append('file', file);
        saved = await api<PresentationFile>(`${endpoint(saved.document.id)}/sources/upload?expectedHash=${encodeURIComponent(saved.hash)}`, { method: 'POST', body });
        acceptFile(saved); latest.current = { ...latest.current, file: saved, document: clone(saved.document) };
      }
      setNotice(`已导入 ${selected.length} 个文件。`);
    });
    if (uploadRef.current) uploadRef.current.value = '';
  }
  useEffect(() => {
    if (!resourceSearchOpen) return;
    const abort = new AbortController(); setResourceLoading(true); setResourceError('');
    const timer = window.setTimeout(() => { void api<ResourcePage>(`/api/workspace/resources?q=${encodeURIComponent(resourceQuery)}&limit=30`, { signal: abort.signal }).then(result => setResources(result.resources.filter(item => item.kind === 'file' && !item.missing))).catch(error => { if (!abort.signal.aborted) setResourceError(error.message); }).finally(() => { if (!abort.signal.aborted) setResourceLoading(false); }); }, 200);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [resourceQuery, resourceSearchOpen]);
  async function startJob(kind: 'outline' | 'export' | 'slide', manual = false) {
    if (kind === 'export' && !reviewed && stage !== 'edit') { notifyError('请先确认已检查当前大纲。'); return; }
    if (kind !== 'export' && !manual && !modelReady) { notifyError('请先在模型设置中选择助手默认模型，也可手动建立大纲。'); return; }
    await run(kind === 'export' ? '正在提交生成任务' : kind === 'slide' ? '正在提交单页重写' : '正在提交大纲任务', async () => {
      const saved = await saveDocument(); if (!saved) return;
      const path = kind === 'slide' ? `${endpoint(saved.document.id)}/slides/${encodeURIComponent(activeSlide!.id)}/regenerate` : `${endpoint(saved.document.id)}/${kind === 'export' ? 'export' : 'outline'}`;
      const payload = kind === 'export' ? { expectedHash: saved.hash, approvedOutlineHash: saved.hash } : kind === 'outline' ? { expectedHash: saved.hash, manual } : { expectedHash: saved.hash, instruction: regenerateInstruction.trim() };
      const next = await api<PresentationJob>(path, json('POST', payload));
      setJob(next); setJobs(current => [next, ...current.filter(item => item.id !== next.id)]); setPollStopped(false);
      if (kind === 'export') setStage('edit');
    });
  }
  const jobIdentity = job?.id;
  const jobActive = job ? activeStatuses.includes(job.status) : false;
  useEffect(() => {
    if (!presentationId || !jobIdentity || !jobActive) return;
    const abort = new AbortController(); let timer: number | undefined, attempts = 0; const started = Date.now();
    setPollStopped(false);
    const poll = async () => {
      if (abort.signal.aborted) return;
      if (++attempts > 300 || Date.now() - started > 15 * 60 * 1000) { setPollStopped(true); return; }
      try {
        const next = await api<PresentationJob>(`${endpoint(presentationId)}/jobs/${encodeURIComponent(jobIdentity)}`, { signal: abort.signal });
        if (abort.signal.aborted) return;
        if (!activeStatuses.includes(next.status)) {
          const disk = await api<PresentationFile>(endpoint(presentationId), { signal: abort.signal });
          if (abort.signal.aborted) return;
          if (dirtyRef.current) { if (disk.hash !== latest.current.file?.hash) setConflict(disk); }
          else { acceptFile(disk); setSelectedSlide(current => disk.document.slides.some(slide => slide.id === current) ? current : disk.document.slides[0]?.id || ''); }
          if (next.status === 'succeeded') {
            if (dirtyRef.current) setNotice('任务已完成，当前本地编辑已保留。请比较任务结果与当前内容。');
            else { if (next.kind === 'outline') setStage('outline'); setNotice(next.kind === 'export' ? 'PPTX 已生成，请查看检查记录后下载。' : '内容已更新，请逐页检查。'); }
          } else if (next.status === 'failed' || next.status === 'interrupted') notifyError(next.error || `任务${statusLabels[next.status]}；已保留上次成功的文件。`);
          setJob(next); setJobs(current => [next, ...current.filter(item => item.id !== next.id)]);
          return;
        }
        setJob(next); setJobs(current => [next, ...current.filter(item => item.id !== next.id)]);
        timer = window.setTimeout(poll, 2000);
      } catch (error: unknown) { if (!abort.signal.aborted) { setPollStopped(true); notifyError(`任务状态读取失败：${error instanceof Error ? error.message : '网络连接异常'}。可手动刷新状态。`); } }
    };
    timer = window.setTimeout(poll, 500);
    return () => { abort.abort(); if (timer) window.clearTimeout(timer); };
  }, [presentationId, jobIdentity, jobActive, pollRevision, acceptFile, notifyError]);
  async function refreshJobs() {
    await run('正在刷新任务', async () => {
      if (!presentationId) return;
      const result = await api<{ jobs: PresentationJob[] }>(`${endpoint(presentationId)}/jobs`);
      const next = result.jobs.find(item => activeStatuses.includes(item.status)) || result.jobs[0];
      if (next && !activeStatuses.includes(next.status)) {
        const disk = await api<PresentationFile>(endpoint(presentationId));
        if (dirtyRef.current) { if (disk.hash !== latest.current.file?.hash) setConflict(disk); }
        else { acceptFile(disk); if (next.status === 'succeeded' && next.kind === 'outline') setStage('outline'); }
      }
      setJobs(result.jobs); setJob(next); setPollStopped(false); setPollRevision(current => current + 1);
    });
  }
  async function cancelJob() { await run('正在取消任务', async () => { if (!presentationId || !job) return; const next = await api<PresentationJob>(`${endpoint(presentationId)}/jobs/${encodeURIComponent(job.id)}/cancel`, json('POST', {})); if (!dirtyRef.current) acceptFile(await api<PresentationFile>(endpoint(presentationId))); setJob(next); setJobs(current => [next, ...current.filter(item => item.id !== next.id)]); }); }
  async function switchStage(next: Stage) { if (disabled) return; if ((next === 'style' || next === 'outline') && dirty) { await run('正在保存', async () => { if (await saveDocument()) setStage(next); }); } else setStage(next); }
  function moveSlide(from: number, to: number) { if (from === to || to < 0 || !document || to >= document.slides.length) return; updateDocument(next => { const [slide] = next.slides.splice(from, 1); next.slides.splice(to, 0, slide); }); }
  function addSlide() { const slide = newSlide(); updateDocument(next => { const index = next.slides.findIndex(item => item.id === activeSlide?.id); next.slides.splice(index + 1, 0, slide); }); setSelectedSlide(slide.id); setInspector('content'); }
  function removeSlide() { updateDocument(next => { next.slides = next.slides.filter(slide => slide.id !== deleteSlideId); }); if (selectedSlide === deleteSlideId) setSelectedSlide(document?.slides.find(slide => slide.id !== deleteSlideId)?.id || ''); setDeleteSlideId(''); }
  function resolveLeave(value: boolean) { setLeaveOpen(false); leaveResolver.current?.(value); leaveResolver.current = undefined; }
  async function reloadDisk() { await run('正在载入最新内容', async () => { if (!presentationId) return; const current = latest.current; const preserved = dirtyRef.current && current.document && current.file ? { document: clone(current.document), baselineHash: current.file.hash, baselineDocument: clone(current.file.document), chartSeriesDrafts: clone(current.chartSeriesDrafts), savedAt: new Date().toISOString() } satisfies Draft : undefined; if (preserved) persistDraftNow(); const next = await api<PresentationFile>(endpoint(presentationId)); acceptFile(next); setRecovery(preserved); setReloadOpen(false); setNotice('已载入磁盘版本；原本地内容保留在草稿中，可下载后手动整合。'); }); }

  const header = <header className="presentations-heading"><div><span className="presentation-eyebrow">学术汇报</span><h1>{presentationId ? document?.title || '演示文稿' : '演示文稿'}</h1><p>{presentationId ? '从材料到大纲，再到每一页的表达。' : '保留研究逻辑，组织一场清晰的学术汇报。'}</p></div><div className="presentation-heading-actions">{presentationId ? <><span className={`presentation-save-state ${dirty ? 'unsaved' : ''}`}>{busy ? <LoaderCircle size={13} className="presentation-spin"/> : dirty ? <i/> : <Check size={13}/>} {busy || (dirty ? '有未保存修改' : '已保存')}</span><button className="presentation-button" disabled={disabled || !dirty} onClick={() => void save()}><Save size={14}/>保存 <kbd>⌘S</kbd></button></> : <button className="presentation-button primary" onClick={() => { setUsePaper(!!paperId); setCreateOpen(true); }}><Plus size={15}/>新建演示</button>}</div></header>;
  const messages = <>{error && <div className="presentation-message error" role="alert"><CircleAlert size={15}/><span>{error}</span><button aria-label="关闭错误提示" onClick={() => setError('')}><X size={14}/></button></div>}{notice && <div className="presentation-message" role="status"><CheckCircle2 size={15}/><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={14}/></button></div>}</>;
  const creationStyleSelector = <div className="presentation-create-style"><label className="presentation-field"><span>PPT 模板</span><select aria-label="新建演示模板" value={creationStyle ? `${creationStyle.id}@${creationStyle.version}` : createStyleKey} disabled={!!busy || !styles.length} onChange={event => setCreateStyleKey(event.target.value)}>{!creationStyle && <option value={createStyleKey} disabled>请选择可用模板</option>}{styles.map(item => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.name} · v{item.version}</option>)}</select></label>{creationStyle ? <div className="presentation-create-style-summary">{creationStyle.previewUrl && <img src={templateCoverUrl(creationStyle)} alt={`${creationStyle.name} 模板封面预览`}/>}<p><strong>{creationStyle.name}</strong><small>中文 {creationStyle.chineseFont} · 英文 {creationStyle.englishFont}</small></p></div> : <p className="presentation-help">所选模板暂不可用，请等待加载或选择其他模板。</p>}</div>;
  const createDialog = createOpen && <Dialog title="新建演示文稿" error={error} onClose={() => { if (!busy) setCreateOpen(false); }}><form onSubmit={event => { event.preventDefault(); void createPresentation(); }}><label className="presentation-field"><span>汇报标题</span><input autoFocus required maxLength={200} placeholder="例如：面向可信推理的研究进展" value={createTitle} disabled={!!busy} onChange={event => setCreateTitle(event.target.value)}/></label>{creationStyleSelector}{paperId && <label className="presentation-checkbox"><input type="checkbox" checked={usePaper} disabled={!!busy} onChange={event => setUsePaper(event.target.checked)}/><span>接入当前论文材料 <small>{paperId}</small></span></label>}<p className="presentation-help">沿用所选模板整理材料，之后可设置语言。大纲经过确认后才会生成演示文件。</p><footer><button type="button" className="presentation-button" disabled={!!busy} onClick={() => setCreateOpen(false)}>取消</button><button className="presentation-button primary" disabled={!!busy || !createTitle.trim() || !creationStyle}>{busy ? <LoaderCircle className="presentation-spin" size={14}/> : <ArrowRight size={14}/>}创建并整理材料</button></footer></form></Dialog>;
  if (!presentationId) return <section className="presentations-root">{header}{messages}{paperId && <div className="presentation-paper-context"><FileText size={17}/><span>已选论文 <strong>{paperId}</strong>，新建时可直接接入当前主稿。</span></div>}{loading ? <div className="presentation-loading"><LoaderCircle className="presentation-spin"/>正在读取演示项目…</div> : summaries.length ? <div className="presentation-library"><div className="presentation-library-label"><span>{summaries.length} 份演示</span><span>按最近修改排列</span></div><div className="presentation-deck-grid">{summaries.map(item => <button className="presentation-deck-card" key={item.id} onClick={() => onNavigate(`/presentations/${encodeURIComponent(item.id)}`)}><div className="presentation-deck-cover"><span className="presentation-deck-school">学术汇报</span><strong>{item.title}</strong><span className="presentation-deck-line"/><span className="presentation-deck-count">{item.slideCount} 页</span></div><div className="presentation-deck-info"><h2>{item.title}</h2><p><span>{languageLabels[item.language]}</span><span>{prettyDate(item.updatedAt)}</span></p>{item.latestJob && <span className={`presentation-deck-job ${item.latestJob.status}`}>{statusLabels[item.latestJob.status]} · {item.latestJob.kind === 'export' ? '文件生成' : item.latestJob.kind === 'outline' ? '大纲' : '单页重写'}</span>}</div><ChevronRight className="presentation-deck-arrow" size={17}/></button>)}</div></div> : <div className="presentation-library-empty"><div className="presentation-empty-paper"><Presentation size={32}/><span/><span/></div><span className="presentation-eyebrow">从一个清楚的问题开始</span><h2>把研究材料，组织成汇报。</h2><p>导入论文、文字或图片，确认大纲后，生成可编辑的 PowerPoint。</p><button className="presentation-button primary" onClick={() => { setUsePaper(!!paperId); setCreateOpen(true); }}><Plus size={15}/>创建第一份演示</button><div className="presentation-empty-steps"><span>01 整理材料</span><ArrowRight size={12}/><span>02 确认大纲</span><ArrowRight size={12}/><span>03 逐页编辑</span></div></div>}{createDialog}</section>;
  if (loading || !document) return <section className="presentations-root">{header}{messages}<div className="presentation-loading">{loading ? <><LoaderCircle className="presentation-spin"/>正在读取演示文稿…</> : <><CircleAlert/>演示内容无法读取。<button className="presentation-button" onClick={() => onNavigate('/presentations')}>返回演示列表</button></>}</div></section>;

  const modelNotice = (!modelReady || aiReadError) && <div className="presentation-model-notice"><Settings2 size={17}/><div><strong>{aiReadError ? '暂时无法读取模型配置' : '尚未选择助手默认模型'}</strong><p>{aiReadError || '配置模型后可生成大纲、重写单页；手动大纲与文件导出仍可使用。'}</p></div><button className="presentation-button small" onClick={() => window.dispatchEvent(new CustomEvent('echopaper:open-model-settings', { detail: { tab: 'assistant' } }))}>打开模型设置</button><button className="presentation-icon-button" aria-label="重新读取模型配置" onClick={() => void refreshAI()}><RefreshCw size={14}/></button></div>;
  const sourcePanel = <section className="presentation-materials"><div className="presentation-stage-intro"><span className="presentation-eyebrow">01 · 材料与表达目标</span><h2>这一次，想讲清楚什么？</h2><p>材料会随演示保存。生成的大纲可逐页修改，缺失事实需要在汇报前补齐。</p></div><fieldset disabled={disabled} className="presentation-form-fieldset"><div className="presentation-materials-grid"><div className="presentation-source-composer"><div className="presentation-panel-title"><FileText size={17}/><h3>粘贴汇报材料</h3></div><label className="presentation-field"><span>材料名称 <small>选填</small></span><input value={sourceName} placeholder="研究摘要、实验记录或汇报提纲" onChange={event => setSourceName(event.target.value)}/></label><label className="presentation-field"><span>材料正文</span><textarea rows={10} placeholder="粘贴研究问题、方法、已验证结果与待讨论内容…" value={sourceText} onChange={event => setSourceText(event.target.value)}/></label><div className="presentation-source-actions"><button className="presentation-button primary" disabled={!sourceText.trim() || disabled} onClick={() => void addSource({ text: sourceText, ...(sourceName.trim() ? { name: sourceName.trim() } : {}) })}><Plus size={14}/>接入文字</button><button className="presentation-button" onClick={() => uploadRef.current?.click()}><Upload size={14}/>上传文件</button><input className="presentation-visually-hidden" type="file" multiple ref={uploadRef} aria-label="上传 PDF、文字或图片材料" accept=".pdf,.txt,.md,.markdown,.png,.jpg,.jpeg,.webp,.gif" onChange={event => void uploadFiles(event.target.files)}/></div><p className="presentation-help">支持 PDF、TXT、Markdown 与图片。扫描版 PDF 可能需要先提取文字。</p><div className="presentation-source-other"><button onClick={() => setResourceSearchOpen(true)}><FolderSearch size={15}/>从资料库接入<ArrowRight size={13}/></button>{(paperId || document.paperId) && <button onClick={() => void addSource({ paperId: paperId || document.paperId })}><FileText size={15}/>从关联论文接入<ArrowRight size={13}/></button>}</div></div><div className="presentation-attached-sources"><div className="presentation-panel-title"><Layers3 size={17}/><h3>已接入材料</h3><span>{document.sources.length}</span></div>{!document.sources.length ? <div className="presentation-source-empty"><FileText size={26}/><p>材料会列在这里</p><small>添加一份或多份内容，保留可追溯的依据。</small></div> : <ul>{document.sources.map(source => <li key={source.id}><span className="presentation-source-icon">{source.kind === 'image' ? <Image size={16}/> : <FileText size={16}/>}</span><div><strong>{source.name}</strong><small>{source.kind === 'paper' ? '论文主稿' : source.kind === 'resource' ? '资料库文件' : source.kind === 'pdf' ? 'PDF 文档' : source.kind === 'image' ? '图片' : '文字'}{source.page ? ` · 第 ${source.page} 页` : ''}{source.text ? ` · ${source.text.length.toLocaleString()} 字符` : ''}</small>{source.text && <p>{source.text.slice(0, 180)}</p>}</div><button className="presentation-icon-button" aria-label={`移除材料 ${source.name}`} title="从演示移除材料；已被引用的材料需先移除引用" onClick={() => setRemoveSourceId(source.id)}><X size={14}/></button></li>)}</ul>}</div></div><div className="presentation-metadata-row"><label className="presentation-field"><span>汇报标题</span><input value={document.title} onChange={event => updateDocument(next => { next.title = event.target.value; })}/></label><label className="presentation-field"><span>预计时长（分钟）</span><input type="number" min={1} max={180} value={document.durationMinutes} onChange={event => updateDocument(next => { next.durationMinutes = Math.max(1, Math.min(180, Number(event.target.value) || 1)); })}/></label><label className="presentation-field"><span>目标页数</span><input type="number" min={1} max={60} value={document.targetSlides} onChange={event => updateDocument(next => { next.targetSlides = Math.max(1, Math.min(60, Number(event.target.value) || 1)); })}/></label></div></fieldset><div className="presentation-stage-footer"><span>{document.sources.length ? `已接入 ${document.sources.length} 份材料` : '也可以先手动建立大纲，再补充材料'}</span><button className="presentation-button primary" disabled={disabled || !document.title.trim()} onClick={() => void switchStage('style')}>选择样式与语言<ArrowRight size={14}/></button></div></section>;
  const stylePanel = <section className="presentation-style-stage"><div className="presentation-stage-intro"><span className="presentation-eyebrow">02 · 样式与语言</span><h2>让内容有一致的表达。</h2><p>按结构化页面编辑，使用固定模板保持字体、导航与版式一致。</p></div><fieldset disabled={disabled} className="presentation-form-fieldset"><div className="presentation-style-grid">{styles.map(item => <button key={`${item.id}@${item.version}`} className={`presentation-style-card ${document.styleId === item.id && document.styleVersion === item.version ? 'selected' : ''}`} aria-pressed={document.styleId === item.id && document.styleVersion === item.version} onClick={() => updateDocument(next => { next.styleId = item.id; next.styleVersion = item.version; })}><div className="presentation-style-sample">{item.previewUrl ? <img src={item.previewUrl} alt={`${item.name} 样式预览`}/> : <div className="presentation-style-placeholder"><span>研究背景　　研究内容　　研究结果　　未来计划</span><strong>以清晰的逻辑<br/>呈现研究进展</strong><i/></div>}{document.styleId === item.id && document.styleVersion === item.version && <span className="presentation-style-selected"><Check size={13}/>已选择</span>}</div><h3>{item.name}<small>v{item.version}</small></h3><p>{item.description}</p><div className="presentation-style-fonts"><span>中文：{item.chineseFont}</span><span>英文：{item.englishFont}</span></div><small className="presentation-style-provenance">模板指纹 {item.templateHash.slice(0, 12)} · {item.width} × {item.height}</small></button>)}</div>{!styles.length && <p className="presentation-help">样式包未加载，请稍后刷新。演示已保留当前样式设置。</p>}<div className="presentation-language-grid"><LanguageSelect label="幻灯片语言" value={document.language} onChange={value => updateDocument(next => { next.language = value; })}/><LanguageSelect label="讲稿语言" value={document.notesLanguage} onChange={value => updateDocument(next => { next.notesLanguage = value; })}/><label className="presentation-field"><span>汇报人 <small>选填</small></span><input value={document.presenter} placeholder="留空不会生成姓名" onChange={event => updateDocument(next => { next.presenter = event.target.value; })}/></label><label className="presentation-field"><span>指导教师 <small>选填</small></span><input value={document.advisor} placeholder="选填" onChange={event => updateDocument(next => { next.advisor = event.target.value; })}/></label></div><label className="presentation-checkbox"><input type="checkbox" checked={document.preserveExamples} onChange={event => updateDocument(next => { next.preserveExamples = event.target.checked; })}/><span>案例保持英文原文，不自动翻译<small>英文案例块保留完整原文，支持逐字编辑。</small></span></label></fieldset>{modelNotice}<div className="presentation-stage-footer"><button className="presentation-button" disabled={disabled} onClick={() => setStage('materials')}><ArrowLeft size={14}/>返回材料</button><div><button className="presentation-button" disabled={disabled} onClick={() => void startJob('outline', true)}>手动建立大纲</button><button className="presentation-button primary" disabled={disabled || !modelReady || !document.sources.length} onClick={() => void startJob('outline')}><Sparkles size={14}/>生成大纲</button></div></div></section>;

  return <section className="presentations-root presentation-detail">{header}{messages}
    <nav className="presentation-stage-nav" aria-label="演示制作步骤">{([{ id: 'materials', title: '整理材料' }, { id: 'style', title: '样式与语言' }, { id: 'outline', title: '确认大纲' }, { id: 'edit', title: '编辑与导出' }] as { id: Stage; title: string }[]).map((item, index) => <button key={item.id} className={stage === item.id ? 'active' : ''} aria-current={stage === item.id ? 'step' : undefined} disabled={disabled || ((item.id === 'outline' || item.id === 'edit') && !document.slides.length)} onClick={() => void switchStage(item.id)}><span>{String(index + 1).padStart(2, '0')}</span>{item.title}{index < 3 && <ChevronRight size={13}/>}</button>)}</nav>
    {recovery && <div className="presentation-recovery" role="status"><FileText size={17}/><div><strong>发现未保存的浏览器草稿</strong><p>{prettyDate(recovery.savedAt)}{recovery.baselineHash !== file?.hash ? ' · 磁盘版本已变化，恢复后需比较双方内容。' : ' · 可以恢复上次编辑。'}</p></div><button className="presentation-button small" disabled={disabled} onClick={() => { if (recovery.baselineHash !== file?.hash && file) { setConflict(file); setFile({ document: recovery.baselineDocument || file.document, hash: recovery.baselineHash }); } setDocument(clone(recovery.document)); setChartSeriesDrafts(recovery.chartSeriesDrafts || {}); setSelectedSlide(recovery.document.slides[0]?.id || ''); setStage(recovery.document.slides.length ? 'edit' : 'materials'); setRecovery(undefined); }}>恢复草稿</button><button className="presentation-button small" onClick={() => downloadText(`${document.title}-本地草稿.json`, JSON.stringify(recovery, null, 2))}><Download size={13}/>下载</button><button className="presentation-icon-button" aria-label="忽略本地草稿" onClick={() => { try { localStorage.removeItem(draftKey(document.id)); } catch { /* Optional local storage. */ } setRecovery(undefined); }}><X size={14}/></button></div>}
    {conflict && <div className="presentation-conflict" role="alert"><CircleAlert size={18}/><div><strong>检测到外部修改；本地编辑已保留</strong><p>本地基线 {file?.hash.slice(0, 10)} · 磁盘版本 {conflict.hash.slice(0, 10)}。先比较双方内容，再载入磁盘版本并手动整合。</p></div><button className="presentation-button small" onClick={() => setCompareOpen(true)}>比较内容</button><button className="presentation-button small" onClick={backupDraft}><Download size={13}/>下载本地备份</button><button className="presentation-button small" disabled={disabled} onClick={() => setReloadOpen(true)}>载入磁盘版本</button></div>}
    {job && (hasActiveJob || job.status === 'failed' || job.status === 'interrupted' || pollStopped) && <div className={`presentation-job-bar ${job.status}`} role="status">{hasActiveJob ? <LoaderCircle size={17} className={pollStopped ? '' : 'presentation-spin'}/> : <CircleAlert size={17}/>}<div><strong>{statusLabels[job.status]} · {job.kind === 'outline' ? '大纲生成' : job.kind === 'slide' ? '单页重写' : 'PPTX 生成'}</strong><p>{pollStopped ? '已暂停自动查询。任务可能仍在运行，可手动刷新状态。' : job.phase}{job.error ? ` · ${job.error}` : ''}</p></div><button className="presentation-button small" disabled={!!busy} onClick={() => void refreshJobs()}><RefreshCw size={13}/>刷新状态</button>{hasActiveJob && <button className="presentation-button small" disabled={!!busy} onClick={() => void cancelJob()}>取消任务</button>}</div>}
    <div className="presentation-stage-body">{stage === 'materials' ? sourcePanel : stage === 'style' ? stylePanel : <>
      {stage === 'outline' ? <div className="presentation-review-banner"><div><span className="presentation-eyebrow">03 · 大纲审阅</span><h2>逐页确认，再生成演示。</h2><p>检查页面顺序、关键结论、材料依据与英文案例。右侧可以直接修改。</p></div><label className="presentation-checkbox"><input type="checkbox" checked={reviewed} disabled={disabled} onChange={event => setReviewed(event.target.checked)}/><span>我已检查当前大纲</span></label><button className="presentation-button primary" disabled={disabled || !reviewed || !document.slides.length || !!conflict} onClick={() => void startJob('export')}><Presentation size={14}/>确认大纲并生成 PPTX</button></div> : <div className="presentation-editor-toolbar"><div><span className="presentation-editor-count">{document.slides.length} 页</span><span className={`presentation-preview-state ${exportCurrent ? 'current' : ''}`}>{dirty ? '本地内容预览 · 导出前需保存' : exportCurrent ? '对应最近一次生成版本' : '内容已保存 · 尚未生成当前版本'}</span></div><div><button className="presentation-button small" disabled={disabled} onClick={() => setStage('outline')}>重新审阅大纲</button><button className="presentation-button primary small" disabled={disabled || !document.slides.length || !!conflict} onClick={() => { setReviewed(false); setStage('outline'); }}>生成 / 更新 PPTX<ArrowRight size={13}/></button></div></div>}
      <div className="presentation-editor"><aside className="presentation-outline"><header><strong>页面大纲</strong><button className="presentation-icon-button" disabled={disabled} aria-label="添加幻灯片" onClick={addSlide}><Plus size={16}/></button></header><ol>{document.slides.map((slide, index) => <li key={slide.id} className={activeSlide?.id === slide.id ? 'active' : ''}><button className="presentation-outline-select" aria-current={activeSlide?.id === slide.id ? 'true' : undefined} onClick={() => setSelectedSlide(slide.id)}><span className="presentation-outline-number">{String(index + 1).padStart(2, '0')}</span><span><small>{slide.section} · {layouts[slide.layout]}</small><strong>{slide.title || slide.titleEn || '未命名页面'}</strong></span></button><div className="presentation-outline-actions"><button aria-label={`上移第 ${index + 1} 页`} disabled={disabled || index === 0} onClick={() => moveSlide(index, index - 1)}><ArrowUp size={13}/></button><button aria-label={`下移第 ${index + 1} 页`} disabled={disabled || index === document.slides.length - 1} onClick={() => moveSlide(index, index + 1)}><ArrowDown size={13}/></button><button aria-label={`删除第 ${index + 1} 页`} disabled={disabled} onClick={() => setDeleteSlideId(slide.id)}><Trash2 size={12}/></button></div></li>)}</ol><button className="presentation-add-slide" disabled={disabled} onClick={addSlide}><Plus size={14}/>添加页面</button></aside>
      <main className="presentation-preview-workspace">{activeSlide ? <><div className="presentation-preview-caption"><span>第 {slideIndex + 1} 页 / 共 {document.slides.length} 页</span><span>{dirty ? '结构化内容预览' : exportCurrent && successfulExport?.previewUrls?.[slideIndex] ? '生成预览' : '模板内容预览'} · {layouts[activeSlide.layout]}</span></div><PresentationPreview document={document} slide={activeSlide} index={slideIndex} style={style} previewUrl={exportCurrent ? successfulExport?.previewUrls?.[slideIndex] : undefined} savedPreviewUrl={!dirty && file ? `${endpoint(document.id)}/slides/${encodeURIComponent(activeSlide.id)}/preview.svg?expectedHash=${encodeURIComponent(file.hash)}` : undefined}/><p className="presentation-preview-disclaimer">模板内容预览用于检查结构与文字；PowerPoint / WPS 的字体和换行需在打开导出文件后确认。</p><div className="presentation-preview-summary"><span className="presentation-eyebrow">本页核心信息</span><p>{activeSlide.keyMessage || '在右侧填写本页想让听众记住的一句话。'}</p>{activeSlide.sourceIds.length > 0 && <small>材料依据：{activeSlide.sourceIds.map(id => document.sources.find(source => source.id === id)?.name || id).join('、')}</small>}</div><div className="presentation-slide-navigation"><button className="presentation-button small" disabled={slideIndex === 0} onClick={() => setSelectedSlide(document.slides[slideIndex - 1].id)}><ArrowLeft size={13}/>上一页</button><span>{String(slideIndex + 1).padStart(2, '0')}</span><button className="presentation-button small" disabled={slideIndex === document.slides.length - 1} onClick={() => setSelectedSlide(document.slides[slideIndex + 1].id)}>下一页<ArrowRight size={13}/></button></div></> : <div className="presentation-no-slides"><Presentation size={30}/><h3>从一页开始</h3><p>添加页面后，在右侧填写标题、内容与讲稿。</p><button className="presentation-button primary" disabled={disabled} onClick={addSlide}><Plus size={14}/>添加第一页</button></div>}</main>
      <aside className="presentation-inspector"><nav aria-label="当前页面编辑器"><button className={inspector === 'content' ? 'active' : ''} onClick={() => setInspector('content')}>页面内容</button><button className={inspector === 'notes' ? 'active' : ''} onClick={() => setInspector('notes')}>讲稿备注</button><button className={inspector === 'sources' ? 'active' : ''} onClick={() => setInspector('sources')}>材料依据</button></nav>{activeSlide ? <fieldset className="presentation-form-fieldset presentation-inspector-fields" disabled={disabled}>{inspector === 'notes' ? <><div className="presentation-inspector-intro"><h3>第 {slideIndex + 1} 页讲稿</h3><p>每页保留四项备注，导出到 PowerPoint 演讲者备注。</p></div>{Object.entries(noteLabels).map(([key, label]) => <label className="presentation-field" key={key}><span>{label}</span><textarea rows={key === 'speech' ? 7 : 3} value={activeSlide.notes[key as keyof typeof noteLabels]} onChange={event => updateSlide({ notes: { ...activeSlide.notes, [key]: event.target.value } })}/></label>)}</> : inspector === 'sources' ? <><div className="presentation-inspector-intro"><h3>本页材料依据</h3><p>选中来源，方便检查页面内容的证据。</p></div>{document.sources.length ? document.sources.map(source => <label className="presentation-checkbox presentation-source-check" key={source.id}><input type="checkbox" checked={activeSlide.sourceIds.includes(source.id)} onChange={event => updateSlide({ sourceIds: event.target.checked ? [...activeSlide.sourceIds, source.id] : activeSlide.sourceIds.filter(id => id !== source.id) })}/><span>{source.name}<small>{source.text.slice(0, 110) || source.kind}</small></span></label>) : <p className="presentation-help">尚未接入材料。返回“整理材料”补充来源。</p>}<button className="presentation-button small" onClick={() => void switchStage('materials')}>管理全部材料</button></> : <><div className="presentation-inspector-pair"><label className="presentation-field"><span>所属章节</span><select value={activeSlide.section} onChange={event => updateSlide({ section: event.target.value as PresentationSection })}>{sections.map(section => <option key={section}>{section}</option>)}</select></label><label className="presentation-field"><span>版式</span><select value={activeSlide.layout} onChange={event => updateSlide({ layout: event.target.value as PresentationLayout })}>{Object.entries(layouts).filter(([key]) => !style || style.layouts.includes(key as PresentationLayout)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div><label className="presentation-field"><span>中文标题 / 主标题</span><textarea rows={2} value={activeSlide.title} onChange={event => updateSlide({ title: event.target.value })}/></label><label className="presentation-field"><span>英文标题</span><textarea rows={2} className="presentation-english-input" value={activeSlide.titleEn} onChange={event => updateSlide({ titleEn: event.target.value })}/></label><label className="presentation-field"><span>本页核心信息</span><textarea rows={3} value={activeSlide.keyMessage} placeholder="听众应记住的一句话" onChange={event => updateSlide({ keyMessage: event.target.value })}/></label><div className="presentation-block-editor-list">{activeSlide.blocks.map((block, index) => <section className="presentation-block-editor" key={block.id}><header><strong>内容块 {index + 1}</strong><div><button className="presentation-icon-button" aria-label={`上移内容块 ${index + 1}`} disabled={disabled || index === 0} onClick={() => { const blocks = [...activeSlide.blocks]; [blocks[index - 1], blocks[index]] = [blocks[index], blocks[index - 1]]; updateSlide({ blocks }); }}><ArrowUp size={12}/></button><button className="presentation-icon-button" aria-label={`下移内容块 ${index + 1}`} disabled={disabled || index === activeSlide.blocks.length - 1} onClick={() => { const blocks = [...activeSlide.blocks]; [blocks[index + 1], blocks[index]] = [blocks[index], blocks[index + 1]]; updateSlide({ blocks }); }}><ArrowDown size={12}/></button><button className="presentation-icon-button" aria-label={`删除内容块 ${index + 1}`} onClick={() => updateSlide({ blocks: activeSlide.blocks.filter(item => item.id !== block.id) })}><Trash2 size={12}/></button></div></header><label className="presentation-field"><span>内容类型</span><select value={block.type} onChange={event => updateBlock(block.id, { type: event.target.value as PresentationBlock['type'], ...(event.target.value === 'case' ? { verbatim: true } : {}) })}><option value="text">文字</option><option value="table">数据表格</option><option value="steps">方法流程</option><option value="image">图片</option><option value="case">英文案例（保留原文）</option><option value="chart">数据图表</option></select></label><label className="presentation-field"><span>内容块标题 <small>选填</small></span><input value={block.title || ''} onChange={event => updateBlock(block.id, { title: event.target.value })}/></label>{document.language !== 'zh' && <label className="presentation-field"><span>内容块英文标题 <small>选填</small></span><input className="presentation-english-input" value={block.titleEn || ''} onChange={event => updateBlock(block.id, { titleEn: event.target.value })}/></label>}
        {block.type === 'table' ? <><label className="presentation-field"><span>表头 <small>用 Tab 或 | 分隔列</small></span><input value={(block.headers || []).join(' | ')} onChange={event => updateBlock(block.id, { headers: event.target.value.split(/\t|\s*\|\s*/) })}/></label><label className="presentation-field"><span>表格内容 <small>每行一条，用 Tab 或 | 分隔列</small></span><textarea rows={6} value={(block.rows || []).map(row => row.join(' | ')).join('\n')} onChange={event => updateBlock(block.id, { rows: event.target.value.split('\n').map(row => row.split(/\t|\s*\|\s*/)) })}/></label></>
          : block.type === 'steps' ? <label className="presentation-field"><span>流程步骤 <small>每行：步骤标题 | 步骤说明</small></span><textarea rows={6} value={(block.steps || []).map(step => `${step.title}${step.text !== undefined ? ` | ${step.text}` : ''}`).join('\n')} onChange={event => updateBlock(block.id, { steps: event.target.value.split('\n').map(line => { const [title, ...text] = line.split(/\s*\|\s*/); return { title, text: text.join(' | ') }; }) })}/></label>
          : block.type === 'image' ? <><label className="presentation-field"><span>图片素材</span><select value={block.assetId || ''} onChange={event => updateBlock(block.id, { assetId: event.target.value || undefined })}><option value="">选择已导入的图片</option>{document.sources.filter(source => source.assetId).map(source => <option key={source.id} value={source.assetId}>{source.name}</option>)}</select></label><p className="presentation-help">在“整理材料”上传图片后即可在这里关联。</p></>
          : block.type === 'chart' ? <><label className="presentation-field"><span>横轴标签 <small>用 | 分隔</small></span><input value={(block.labels || []).join(' | ')} onChange={event => updateBlock(block.id, { labels: event.target.value.split(/\t|\s*\|\s*/) })}/></label><label className="presentation-field"><span>数据系列 <small>每行：系列名 | 数值 | 数值</small></span><textarea rows={5} value={chartSeriesDrafts[seriesKey(activeSlide.id, block.id)] ?? formatSeries(block)} onChange={event => { const raw = event.target.value; setChartSeriesDrafts(current => ({ ...current, [seriesKey(activeSlide.id, block.id)]: raw })); setReviewed(false); setNotice(''); const parsed = parseSeries(raw, block.labels?.length || 0); if (!parsed.error) updateBlock(block.id, { series: parsed.series }); }}/>{chartSeriesDrafts[seriesKey(activeSlide.id, block.id)] !== undefined && parseSeries(chartSeriesDrafts[seriesKey(activeSlide.id, block.id)], block.labels?.length || 0).error && <small className="presentation-field-error" role="alert">{parseSeries(chartSeriesDrafts[seriesKey(activeSlide.id, block.id)], block.labels?.length || 0).error}预览保留最近有效数值。</small>}</label></>
          : <><label className="presentation-field"><span>{block.type === 'case' ? '英文案例原文' : '正文 / 主内容'}</span><textarea rows={6} className={block.type === 'case' ? 'presentation-english-input' : ''} value={block.text || ''} onChange={event => updateBlock(block.id, { text: event.target.value })}/></label>{block.type !== 'case' && document.language !== 'zh' && <label className="presentation-field"><span>英文正文</span><textarea rows={5} className="presentation-english-input" value={block.textEn || ''} onChange={event => updateBlock(block.id, { textEn: event.target.value })}/></label>}{block.type === 'case' && <p className="presentation-help">此块按原文展示。中英双语模式也不会自动替换案例内容。</p>}</>}
        <label className="presentation-field"><span>图注 / 内容说明 <small>选填</small></span><textarea rows={2} value={block.caption || ''} onChange={event => updateBlock(block.id, { caption: event.target.value })}/></label>{document.sources.length > 0 && <details className="presentation-block-source-links"><summary>内容依据 · {block.sourceIds?.length || 0} 份材料</summary>{document.sources.map(source => <label className="presentation-checkbox" key={source.id}><input type="checkbox" checked={!!block.sourceIds?.includes(source.id)} onChange={event => updateBlock(block.id, { sourceIds: event.target.checked ? [...(block.sourceIds || []), source.id] : (block.sourceIds || []).filter(id => id !== source.id) })}/><span>{source.name}</span></label>)}</details>}</section>)}</div><button className="presentation-add-block" onClick={() => updateSlide({ blocks: [...activeSlide.blocks, newBlock()] })}><Plus size={14}/>添加内容块</button><div className="presentation-regenerate"><h4><Sparkles size={14}/>按要求重写当前页</h4><label className="presentation-field"><span>修改要求</span><textarea rows={3} placeholder="例如：减少文字，保留关键实验条件与结果" value={regenerateInstruction} onChange={event => setRegenerateInstruction(event.target.value)}/></label><p className="presentation-help">使用助手默认模型{modelName ? `：${modelName}` : ''}。重写后仍需检查事实与表达。</p><button className="presentation-button small" disabled={disabled || !modelReady || !regenerateInstruction.trim() || !!conflict} onClick={() => void startJob('slide')}><Sparkles size={13}/>保存并重写本页</button></div></>}</fieldset> : <p className="presentation-help">选择或添加一个页面开始编辑。</p>}</aside></div>
      <section className="presentation-export-panel"><div><Download size={19}/><div><h3>{successfulExport ? '最近生成的演示文件' : '尚未生成 PPTX'}</h3><p>{successfulExport ? `${prettyDate(successfulExport.finishedAt || successfulExport.createdAt)} · ${exportCurrent ? '与当前保存内容一致' : '早于当前内容，更新后请重新生成'}` : '审阅大纲并确认后，生成可编辑的 PowerPoint 文件。'}</p></div></div><div>{successfulExport?.downloadUrl && <a className="presentation-button primary" href={successfulExport.downloadUrl} download><Download size={14}/>{exportCurrent ? '下载 PPTX' : '下载上次 PPTX'}</a>}<button className="presentation-button small" onClick={backupDraft}>下载内容备份</button><button className="presentation-icon-button" disabled={!!busy} aria-label="刷新生成记录" onClick={() => void refreshJobs()}><RefreshCw size={14}/></button></div>{job && job.checks.length > 0 && <details className="presentation-checks"><summary>查看{job.kind === 'export' ? '生成' : '内容'}检查记录 · {job.checks.length} 项</summary><ul>{job.checks.map((check, index) => <li key={`${check.code}-${index}`} className={check.status}><span>{check.status === 'passed' ? <CheckCircle2 size={14}/> : <CircleAlert size={14}/>}</span><strong>{check.status === 'passed' ? '通过' : check.status === 'warning' ? '提示' : check.status === 'not_run' ? '未执行' : '失败'}</strong><p>{check.slide ? `第 ${check.slide} 页 · ` : ''}{check.message}</p></li>)}</ul></details>}</section>
    </>}</div>
    {resourceSearchOpen && <Dialog title="从资料库接入材料" error={error} onClose={() => { if (!busy) setResourceSearchOpen(false); }}><label className="presentation-field"><span>搜索名称、路径或内容</span><input autoFocus value={resourceQuery} placeholder="输入论文或材料名称" onChange={event => setResourceQuery(event.target.value)}/></label>{resourceError && <p className="presentation-error-text" role="alert">{resourceError}</p>}<div className="presentation-resource-results">{resourceLoading ? <p><LoaderCircle size={16} className="presentation-spin"/>正在搜索…</p> : resources.length ? resources.map(resource => <button key={resource.id} disabled={!!busy} onClick={() => void addSource({ resourceId: resource.id })}><FileText size={17}/><span><strong>{resource.name}</strong><small>{resource.path}</small>{resource.snippet && <p>{resource.snippet}</p>}</span><Plus size={15}/></button>) : <p>没有匹配的文件。可在资料库添加来源，或直接上传。</p>}</div></Dialog>}
    {compareOpen && conflict && <Dialog title="比较本地与磁盘内容" onClose={() => setCompareOpen(false)}><p className="presentation-help">当前编辑不会被替换。先下载本地备份，再载入磁盘版本并手动合并需要保留的内容。</p><div className="presentation-compare"><label className="presentation-field"><span>本地编辑 · 基线 {file?.hash.slice(0, 10)}</span><textarea readOnly rows={18} value={JSON.stringify(document, null, 2)}/></label><label className="presentation-field"><span>磁盘版本 · {conflict.hash.slice(0, 10)}</span><textarea readOnly rows={18} value={JSON.stringify(conflict.document, null, 2)}/></label></div><footer><button className="presentation-button" onClick={backupDraft}><Download size={14}/>下载本地内容</button><button className="presentation-button primary" onClick={() => setCompareOpen(false)}>继续编辑</button></footer></Dialog>}
    {reloadOpen && <Dialog title="载入最新磁盘版本" error={error} onClose={() => setReloadOpen(false)}><p>当前本地编辑会保留为浏览器草稿。建议同时下载内容备份，以便载入后手动整合。</p><footer><button className="presentation-button" onClick={backupDraft}><Download size={14}/>先下载本地备份</button><button className="presentation-button primary" disabled={!!busy} onClick={() => void reloadDisk()}>载入磁盘版本</button></footer></Dialog>}
    {leaveOpen && <Dialog title="当前演示有未保存修改" error={error} onClose={() => resolveLeave(false)}><p>可以保存到项目后离开，或将当前内容保留为本地草稿。</p><footer><button className="presentation-button" disabled={!!busy} onClick={() => resolveLeave(false)}>继续编辑</button><button className="presentation-button" disabled={!!busy} onClick={() => { persistDraftNow(); resolveLeave(true); }}>保留草稿并离开</button><button className="presentation-button primary" disabled={disabled || !!conflict} onClick={() => void run('正在保存', async () => { if (await saveDocument()) resolveLeave(true); })}><Save size={14}/>保存并离开</button></footer></Dialog>}
    {removeSourceId && <Dialog title="移除演示材料" error={error} onClose={() => { if (!busy) setRemoveSourceId(''); }}><p>从当前演示移除“{document.sources.find(source => source.id === removeSourceId)?.name}”？原始文件保留；若仍被页面、内容块或图片引用，请先移除相应引用。</p><footer><button className="presentation-button" disabled={!!busy} onClick={() => setRemoveSourceId('')}>取消</button><button className="presentation-button danger" disabled={disabled} onClick={() => void removeSource()}><Trash2 size={14}/>移除材料</button></footer></Dialog>}
    {deleteSlideId && <Dialog title="删除幻灯片" onClose={() => setDeleteSlideId('')}><p>删除“{document.slides.find(slide => slide.id === deleteSlideId)?.title || '未命名页面'}”？此修改会在保存后写入项目。</p><footer><button className="presentation-button" onClick={() => setDeleteSlideId('')}>取消</button><button className="presentation-button danger" onClick={removeSlide}><Trash2 size={14}/>删除页面</button></footer></Dialog>}
  </section>;
}
