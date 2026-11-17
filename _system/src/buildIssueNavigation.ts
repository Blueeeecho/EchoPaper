import type { Build } from '../shared/types';
import { issueGroups, type IssueKind } from './buildIssueSummary';

export type BuildIssueFilter = 'problems' | 'all' | IssueKind;
export const issueOrder: IssueKind[] = ['error', 'reference', 'warning', 'placeholder', 'info'];

export function visibleIssueKinds(filter: BuildIssueFilter) {
  return issueOrder.filter(kind => filter === 'all' ||
    filter === 'problems' && ['error', 'reference', 'warning'].includes(kind) || filter === kind);
}

export function resolveIssueBuild(builds: Build[], projectId: string, targetId: string, selectedId: string) {
  const matching = builds.filter(build => build.projectId === projectId && build.targetId === targetId);
  return matching.find(build => build.id === selectedId) ||
    matching.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export function issueFilterCount(build: Build | undefined, filter: BuildIssueFilter) {
  const groups = issueGroups(build?.diagnostics || []);
  return visibleIssueKinds(filter).reduce((count, kind) => count + groups[kind].length, 0);
}


/** Check selection and displayed PDF can belong to different builds. */
export function buildIssueVersionNotices(check?: Build, preview?: Build, latest?: Build): string[] {
  if (!check) return [];
  const notices: string[] = [];
  if (latest && check.id !== latest.id) notices.push('历史检查');
  if (preview?.pdf) {
    if (check.id !== preview.id) notices.push('检查结果与显示 PDF 不同版本');
  } else notices.push('当前未显示 PDF');
  if (check.status === 'queued') notices.push('检查排队中，数量尚未生成');
  if (check.status === 'running') notices.push('检查进行中，数量尚未定稿');
  if (latest && check.id !== latest.id && ['queued', 'running'].includes(latest.status)) {
    notices.push(latest.status === 'queued' ? '新编译排队中，当前保留所选检查结果' : '新编译进行中，当前保留所选检查结果');
  }
  return notices;
}
