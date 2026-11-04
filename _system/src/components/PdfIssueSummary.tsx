import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Code2, ExternalLink, FileWarning, X } from 'lucide-react';
import type { Build } from '../../shared/types';
import { diagnosticSourceLocation, type PdfIssueBucket } from '../pdfIssues';
import {submissionSeverity} from '../../shared/diagnostic-policy';
import { issueGroups, issueCounts, issueLabels } from '../buildIssueSummary';

export default function PdfIssueSummary({ build, displayedBuildId, onNavigateSource, onShowIssues }: {
  build?: Build; displayedBuildId?: string;
  onNavigateSource?: (path: string, line?: number) => void; onShowIssues?: () => void;
}) {
  const [filter, setFilter] = useState<PdfIssueBucket>();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { setFilter(undefined); }, [build?.id, displayedBuildId]);
  useEffect(() => {
    if (!filter) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setFilter(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setFilter(undefined); root.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [filter]);
  if (!build) return null;
  const summary = issueCounts(build.diagnostics), groups = issueGroups(build.diagnostics);
  const buckets = (['error', 'reference', 'warning', 'placeholder'] as PdfIssueBucket[]).filter(bucket => summary[bucket]);
  if (!buckets.length) return null;
  const sameVersion = !!displayedBuildId && build.id === displayedBuildId;
  const versionLabel = sameVersion ? '当前 PDF 编译' : build.status === 'failed' ? '最近编译失败 · PDF 保留成功版本' : '其他编译版本 · 与当前 PDF 不同';
  const time = build.finishedAt || build.createdAt;
  return <div className="pdf-issue-summary" ref={root}>
    <div className="pdf-issue-counts" aria-label="编译问题统计">
      {buckets.map(bucket => <button key={bucket} type="button" className={`pdf-issue-count ${bucket}`} aria-expanded={filter === bucket} title={`${issueLabels[bucket]} ${summary[bucket]} 项 · ${versionLabel}`} onClick={() => setFilter(value => value === bucket ? undefined : bucket)}><span>{issueLabels[bucket]}</span><b>{summary[bucket]}</b>{filter === bucket && <ChevronDown size={11}/>}</button>)}
    </div>
    {filter && <div className="pdf-issue-popover" role="region" aria-label={`${issueLabels[filter]}详情`}>
      <header><span><FileWarning size={14}/>{issueLabels[filter]} <b>{summary[filter]}</b></span><button type="button" className="icon-button" aria-label="关闭编译问题详情" onClick={() => setFilter(undefined)}><X size={14}/></button></header>
      <div className="pdf-issue-version"><strong>{versionLabel}</strong><span title={time}>{time.replace('T', ' ').slice(0, 19)} · {build.id.slice(0, 8)}</span>{!sameVersion && <small>点击问题打开对应源码，旧 PDF 仅供对照。</small>}</div>
      <div className="pdf-issue-list">{groups[filter].map((item, index) => {
        const source = diagnosticSourceLocation(item);
        return <div className={`pdf-issue-item ${filter} ${submissionSeverity(item)==='error'?'serious':''}`} key={`${index}-${item.message}`}>
          <button type="button" className="pdf-issue-message" disabled={!source||!onNavigateSource} title={source?`打开源码 ${source.path}${source.line?`:${source.line}`:''}`:'日志未提供可靠的源码位置'} onClick={() => { if(source&&onNavigateSource){onNavigateSource(source.path,source.line);setFilter(undefined);} }}><span>{item.message}</span><small><Code2 size={12}/>{source?`${source.path}${source.line?`:${source.line}`:'（未提供行号）'} ↗`:'日志未提供可靠的源码位置'}</small></button>
        </div>;
      })}</div>
      {onShowIssues && <button type="button" className="pdf-issue-open-console" onClick={() => { onShowIssues(); setFilter(undefined); }}>查看全部问题与日志<ExternalLink size={12}/></button>}
    </div>}
  </div>;
}
