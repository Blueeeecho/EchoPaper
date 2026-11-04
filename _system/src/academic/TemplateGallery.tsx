import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, ImageOff, LoaderCircle, Presentation, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { StylePack } from '../../shared/presentation-types';
import './template-gallery.css';
import {templateCoverUrl} from './templateCover';

export interface TemplateGalleryProps {
  onSelect: (style: StylePack) => void;
  onBrowse?: () => void;
}

function TemplatePreview({ style, onSelect }: { style: StylePack; onSelect: () => void }) {
  const previewUrl = templateCoverUrl(style);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setFailed(false); }, [previewUrl]);
  return <div className="template-gallery-picture" style={{ aspectRatio: style.width > 0 && style.height > 0 ? `${style.width} / ${style.height}` : '16 / 9' }}>
    <button type="button" className="template-gallery-preview" onClick={onSelect} aria-label={`使用 ${style.name} 模板，版本 ${style.version}`}>
      {previewUrl && !failed ? <img key={attempt} src={previewUrl} alt={`${style.name} 模板封面预览`} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)}/>
        : <span className="template-gallery-no-image"><ImageOff size={23}/><span>{failed ? '模板图片暂时无法载入' : '此模板尚未提供预览图片'}</span></span>}
    </button>
    {failed && <button type="button" className="template-gallery-image-retry" onClick={() => { setAttempt(value => value + 1); setFailed(false); }}><RefreshCw size={12}/>重试图片</button>}
  </div>;
}

export default function TemplateGallery({ onSelect, onBrowse }: TemplateGalleryProps) {
  const [styles, setStyles] = useState<StylePack[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [edges, setEdges] = useState({ previous: false, next: false });
  const track = useRef<HTMLDivElement>(null);
  const headingId = useId(), trackId = useId();
  const multiple = styles.length > 1;

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError('');
    void api<{ styles: StylePack[] }>('/api/presentation-styles', { signal: abort.signal }).then(result => {
      if (!Array.isArray(result.styles)) throw new Error('模板列表格式异常，请重新读取。');
      if (!abort.signal.aborted) setStyles(result.styles);
    }).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '暂时无法读取汇报模板。'); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [revision]);

  function measureEdges() {
    const element = track.current;
    if (!element) return;
    const next = { previous: element.scrollLeft > 2, next: element.scrollLeft + element.clientWidth < element.scrollWidth - 2 };
    setEdges(current => current.previous === next.previous && current.next === next.next ? current : next);
  }
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    measureEdges();
    const observer = new ResizeObserver(measureEdges);
    observer.observe(element);
    return () => observer.disconnect();
  }, [styles, loading, error]);

  function scrollToCard(direction: 'previous' | 'next' | 'first' | 'last') {
    const element = track.current;
    if (!element) return;
    const items = Array.from(element.children) as HTMLElement[];
    const start = items[0]?.offsetLeft || 0, positions = items.map(item => item.offsetLeft - start);
    const left = direction === 'first' ? 0 : direction === 'last' ? positions.at(-1)
      : direction === 'next' ? positions.find(position => position > element.scrollLeft + 2)
        : positions.slice().reverse().find(position => position < element.scrollLeft - 2);
    if (left !== undefined) element.scrollTo({ left, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  function navigateTrack(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || !multiple) return;
    const direction = { ArrowLeft: 'previous', ArrowRight: 'next', Home: 'first', End: 'last' }[event.key] as 'previous' | 'next' | 'first' | 'last' | undefined;
    if (direction) { event.preventDefault(); scrollToCard(direction); }
  }

  return <section className="academic-resume-card academic-template-gallery" aria-labelledby={headingId}>
    <header><span className="academic-module-icon"><Presentation size={20}/></span><h3 id={headingId}>汇报模板</h3><div className="template-gallery-actions">
      {onBrowse && <button type="button" className="template-gallery-browse" onClick={onBrowse}>全部汇报<ArrowUpRight size={14}/></button>}
      {!loading && !error && multiple && <div className="template-gallery-arrows" aria-label="浏览汇报模板"><button type="button" aria-label="上一个汇报模板" aria-controls={trackId} disabled={!edges.previous} onClick={() => scrollToCard('previous')}><ChevronLeft size={16}/></button><button type="button" aria-label="下一个汇报模板" aria-controls={trackId} disabled={!edges.next} onClick={() => scrollToCard('next')}><ChevronRight size={16}/></button></div>}
    </div></header>
    {loading ? <div className="template-gallery-status" role="status"><LoaderCircle size={20} className="spin"/><p>正在读取汇报模板…</p></div>
      : error ? <div className="template-gallery-status template-gallery-error" role="alert"><p>{error}</p><button type="button" className="academic-secondary" onClick={() => setRevision(value => value + 1)}><RefreshCw size={13}/>重新读取模板</button></div>
        : !styles.length ? <div className="template-gallery-status"><Presentation size={25}/><p>暂无可用的汇报模板。</p><button type="button" className="academic-secondary" onClick={() => setRevision(value => value + 1)}><RefreshCw size={13}/>刷新模板</button></div>
          : <div ref={track} id={trackId} className={`template-gallery-track${multiple ? ' is-multiple' : ''}`} role="list" aria-label={multiple ? '汇报模板，使用左右方向键浏览' : '汇报模板'} tabIndex={multiple ? 0 : undefined} onKeyDown={navigateTrack} onScroll={measureEdges}>
            {styles.map(style => <article className="template-gallery-card" key={`${style.id}:${style.version}`} role="listitem">
              <TemplatePreview style={style} onSelect={() => onSelect(style)}/>
              <div className="template-gallery-details"><button type="button" className="template-gallery-name" onClick={() => onSelect(style)} aria-label={`使用此模板：${style.name}，版本 ${style.version}`} title={`${style.name} · v${style.version}`}>{style.name}</button><small>v{style.version}</small></div>
            </article>)}
          </div>}
  </section>;
}
