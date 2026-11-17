import { diff, Change } from '@codemirror/merge';
export interface EditSelection { projectId: string; path: string; from: number; to: number; text: string; documentText: string }
export interface ReviewChange extends Change { edits: readonly Change[] }
interface TextRange { from: number; to: number }

function sentenceRanges(text: string): TextRange[] {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const ranges: TextRange[] = [];
  // Source line breaks are also boundaries, including TeX commands and lists.
  for (const line of text.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/g)) {
    if (!line[0]) continue;
    for (const part of segmenter.segment(line[0])) {
      ranges.push({ from: line.index + part.index, to: line.index + part.index + part.segment.length });
    }
  }
  return ranges;
}

function containingRange(ranges: TextRange[], from: number, to: number): TextRange {
  const first = ranges.find(range => range.to > from) || ranges.at(-1);
  const last = ranges.find(range => range.to >= Math.max(to, from + 1)) || ranges.at(-1);
  return { from: first?.from ?? from, to: last?.to ?? to };
}

export function reviewChanges(before: string, after: string): ReviewChange[] {
  const edits = diff(before, after, { scanLimit: 1000000, timeout: 200 });
  const rangesA = sentenceRanges(before), rangesB = sentenceRanges(after);
  const groups: { edits: Change[]; a: TextRange; b: TextRange }[] = [];
  for (const edit of edits) {
    const a = containingRange(rangesA, edit.fromA, edit.toA);
    const b = containingRange(rangesB, edit.fromB, edit.toB);
    const previous = groups.at(-1);
    if (previous && (a.from < previous.a.to || b.from < previous.b.to)) {
      previous.edits.push(edit);
      previous.a.to = Math.max(previous.a.to, a.to);
      previous.b.to = Math.max(previous.b.to, b.to);
    } else groups.push({ edits: [edit], a, b });
  }
  return groups.map((group, index) => {
    const first = group.edits[0], last = group.edits.at(-1)!;
    const previous = groups[index - 1]?.edits.at(-1), next = groups[index + 1]?.edits[0];
    // Extend both versions equally through unchanged text so the reader sees
    // comparable sentences. Exact edits remain separate from display context.
    const left = Math.min(Math.max(first.fromA - group.a.from, first.fromB - group.b.from), first.fromA - (previous?.toA ?? 0), first.fromB - (previous?.toB ?? 0));
    const right = Math.min(Math.max(group.a.to - last.toA, group.b.to - last.toB), (next?.fromA ?? before.length) - last.toA, (next?.fromB ?? after.length) - last.toB);
    return Object.assign(new Change(first.fromA - left, last.toA + right, first.fromB - left, last.toB + right), { edits: group.edits });
  });
}
export function applyAcceptedChanges(before: string, after: string, changes: readonly Change[], accepted: ReadonlySet<number>): string {
  let result = before, right = before.length;
  const edits = changes.flatMap((change, index) => accepted.has(index) ? (change as Partial<ReviewChange>).edits || [change] : []);
  for (let i = edits.length - 1; i >= 0; i--) {
    const c = edits[i];
    if (c.fromA < 0 || c.toA > right || c.toA < c.fromA || c.fromB < 0 || c.toB > after.length || c.toB < c.fromB) throw new Error('修改差异不完整，请重新生成。');
    result = result.slice(0, c.fromA) + after.slice(c.fromB, c.toB) + result.slice(c.toA);
    right = c.fromA;
  }
  return result;
}
export function replaceSelectedText(current: string, selection: EditSelection, replacement: string): string {
  if (!Number.isSafeInteger(selection.from) || !Number.isSafeInteger(selection.to) || selection.from < 0 || selection.to < selection.from || selection.to > current.length) throw new Error('选区范围无效，请重新选择。');
  if (current !== selection.documentText || current.slice(selection.from, selection.to) !== selection.text) throw new Error('源码已发生变化，已保留建议。请重新选择片段，避免覆盖后续修改。');
  return current.slice(0, selection.from) + replacement + current.slice(selection.to);
}
