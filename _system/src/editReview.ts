import { presentableDiff, type Change } from '@codemirror/merge';
export interface EditSelection { projectId: string; path: string; from: number; to: number; text: string; documentText: string }
export function reviewChanges(before: string, after: string) { return presentableDiff(before, after, { scanLimit: 10000, timeout: 150 }); }
export function applyAcceptedChanges(before: string, after: string, changes: readonly Change[], accepted: ReadonlySet<number>): string {
  let result = before, right = before.length;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    if (c.fromA < 0 || c.toA > right || c.toA < c.fromA || c.fromB < 0 || c.toB > after.length || c.toB < c.fromB) throw new Error('修改差异不完整，请重新生成。');
    if (accepted.has(i)) result = result.slice(0, c.fromA) + after.slice(c.fromB, c.toB) + result.slice(c.toA);
    right = c.fromA;
  }
  return result;
}
export function replaceSelectedText(current: string, selection: EditSelection, replacement: string): string {
  if (!Number.isSafeInteger(selection.from) || !Number.isSafeInteger(selection.to) || selection.from < 0 || selection.to < selection.from || selection.to > current.length) throw new Error('选区范围无效，请重新选择。');
  if (current !== selection.documentText || current.slice(selection.from, selection.to) !== selection.text) throw new Error('源码已发生变化，已保留建议。请重新选择片段，避免覆盖后续修改。');
  return current.slice(0, selection.from) + replacement + current.slice(selection.to);
}
