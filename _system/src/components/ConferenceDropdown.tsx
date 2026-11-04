import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CalendarClock, LoaderCircle, X } from 'lucide-react';
import type { Project } from '../../shared/types';
import type { ConferenceSelection } from '../../shared/conference-types';
import { formatDeadlineLocal } from '../../shared/deadline';
import { api, json, prettyDate } from '../api';
import ConferencePicker from './ConferencePicker';
import '../conference-dropdown.css';

export interface ConferenceDropdownProps {
  project: Project;
  onSaved: (project: Project) => void;
  onClose: () => void;
  onError?: (message: string) => void;
}
type PendingChange = { kind: 'select'; selection: ConferenceSelection } | { kind: 'clear' };
function deadlineLabel(project: Project) {
  try { if (project.deadlineAt && project.deadlineTimezone) return `${formatDeadlineLocal(project.deadlineAt, 'Asia/Shanghai').replace('T', ' ')} · 北京时间`; }
  catch { return '截止配置需重新核对'; }
  return project.deadline ? `${project.deadline} · 时间与时区待补` : '尚未设置正文截止';
}

/** Inline toolbar popover. Reuses the settings picker and the same version-checked project API. */
export default function ConferenceDropdown({ project, onSaved, onClose, onError }: ConferenceDropdownProps) {
  const root = useRef<HTMLDivElement>(null), offset = useRef(0), mounted = useRef(true), saving = useRef(false);
  const close = useRef(onClose); close.current = onClose;
  const [baseline, setBaseline] = useState(project.updatedAt), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<PendingChange>(), [conflict, setConflict] = useState<Project>();
  const source = project.deadlineSource, expired = !!project.deadlineAt && Date.parse(project.deadlineAt) <= Date.now();
  useLayoutEffect(() => {
    const reposition = () => {
      if (!root.current) return;
      const bounds = root.current.getBoundingClientRect(), naturalLeft = bounds.left - offset.current;
      offset.current = Math.min(Math.max(naturalLeft, 10), Math.max(10, window.innerWidth - bounds.width - 10)) - naturalLeft;
      root.current.style.transform = `translateX(${offset.current}px)`;
    };
    reposition(); const observer = new ResizeObserver(reposition); if (root.current) observer.observe(root.current);
    window.addEventListener('resize', reposition); return () => { observer.disconnect(); window.removeEventListener('resize', reposition); };
  }, []);
  useEffect(() => {
    mounted.current = true; const previous = document.activeElement;
    const focus = requestAnimationFrame(() => { const input = root.current?.querySelector<HTMLInputElement>('input[aria-label="搜索会议"]'); input?.focus(); input?.select(); });
    const dismiss = (event: PointerEvent) => {
      if (saving.current || !(event.target instanceof Node) || root.current?.contains(event.target)) return;
      // The anchor controls its own toggle; do not close/reopen it in one pointer event.
      if (event.target instanceof Element && event.target.closest('.deadline-countdown')) return;
      close.current();
    };
    const escape = (event: KeyboardEvent) => { if (event.key !== 'Escape' || event.isComposing || saving.current) return; event.preventDefault(); event.stopPropagation(); close.current(); };
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', escape, true);
    return () => { mounted.current = false; cancelAnimationFrame(focus); document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', escape, true); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  async function persist(change: PendingChange, expectedUpdatedAt = baseline) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(''); setPending(change);
    const patch = change.kind === 'select' ? {
      venue: change.selection.venue, deadlineAt: change.selection.deadlineAt,
      deadlineTimezone: change.selection.deadlineTimezone, deadlineSource: change.selection.deadlineSource,
    } : { deadline: '', deadlineAt: '', deadlineTimezone: '', deadlineSource: null };
    try {
      const saved = await api<Project>(`/api/projects/${encodeURIComponent(project.id)}`, json('PATCH', { ...patch, expectedUpdatedAt }));
      if (!mounted.current) return;
      setBaseline(saved.updatedAt); setConflict(undefined); onSaved(saved); close.current();
    } catch (failure: any) {
      if (!mounted.current) return;
      const message = failure.message || '会议截止保存失败，所选轮次仍保留。'; setError(message);
      if (failure.status === 409 && failure.data?.current) setConflict(failure.data.current);
      onError?.(message);
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  return <div ref={root} className="conference-dropdown" role="dialog" aria-modal="false" aria-labelledby="conference-dropdown-title" aria-busy={busy}>
    <header className="conference-dropdown-heading"><div><CalendarClock size={16}/><h2 id="conference-dropdown-title">选择投稿会议与截止</h2></div><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭截止选择"><X size={17}/></button></header>
    <section className={`conference-dropdown-current ${expired ? 'expired' : ''}`} aria-label="当前投稿计划"><strong>{project.venue || '投稿目标尚未设置'}{expired && <em>已截止</em>}</strong><p>{deadlineLabel(project)}</p>{source && <p>来源：<a href={source.sourceUrl} target="_blank" rel="noreferrer">CCFDDL</a> · {source.year} · {source.roundId} · 获取于 {prettyDate(source.fetchedAt)}</p>}{source?.notes && <details><summary>当前截止来源说明</summary><p>{source.notes}</p></details>}{source?.officialUrl && <p className="conference-current-website">会议官网：<a href={source.officialUrl} target="_blank" rel="noreferrer">{source.officialUrl} ↗</a></p>}</section>
    {error && <div className="conference-dropdown-error" role="alert"><p>{error}</p>{conflict && <><p>最新项目：{conflict.venue || '未设投稿目标'} · {deadlineLabel(conflict)}</p><p>当前选择已保留，请核对最新计划后再保存。</p><button type="button" className="button small" disabled={busy || !pending} onClick={() => { if (pending) void persist(pending, conflict.updatedAt); }}>已核对，按当前选择重试保存</button></>}{!conflict && pending && <button type="button" className="button small" disabled={busy} onClick={() => void persist(pending)}>重试保存</button>}</div>}
    {busy && <div className="conference-dropdown-saving" role="status"><LoaderCircle size={13} className="spin"/>正在保存投稿计划…</div>}
    <fieldset className="conference-dropdown-fields" disabled={busy}><ConferencePicker initialQuery="" selectedRoundId={project.deadlineSource?.roundId} onSelect={selection => { void persist({kind:'select',selection}); }}/></fieldset>
    <footer className="conference-dropdown-footer"><span>聚合来源与缓存状态见上方，最终要求以会议官网为准。</span><button type="button" disabled={busy || !(project.deadline || project.deadlineAt || project.deadlineTimezone)} onClick={() => void persist({kind:'clear'})}>清除投稿截止</button></footer>
  </div>;
}
