import type { AiReply } from './aiStream';
import { replaceSelectedText, type EditSelection } from './editReview';

export type { WritingTask as WritingContract } from '../shared/agent-types';

export interface WritingDraft {
  reviewVersion?: number;
  selection: EditSelection;
  instruction: string;
  reply: string;
  result?: AiReply;
  accepted: number[];
}

const key = (projectId: string) => `echopaper:writing-draft:${projectId}:v1`;

export function readWritingDraft(storage: Pick<Storage, 'getItem'>, projectId: string): WritingDraft | undefined {
  try {
    const draft = JSON.parse(storage.getItem(key(projectId)) || 'null') as WritingDraft | null;
    const selection = draft?.selection;
    if (!selection || selection.projectId !== projectId || typeof selection.path !== 'string' ||
        typeof selection.documentText !== 'string' || typeof selection.text !== 'string' ||
        !Number.isSafeInteger(selection.from) || !Number.isSafeInteger(selection.to) ||
        selection.from < 0 || selection.to <= selection.from || selection.to > selection.documentText.length ||
        selection.documentText.slice(selection.from, selection.to) !== selection.text ||
        typeof draft.instruction !== 'string' || typeof draft.reply !== 'string' ||
        !Array.isArray(draft.accepted) || !draft.accepted.every(Number.isSafeInteger)) return;
    if (draft.result && (draft.result.finishReason !== 'stop' || draft.result.text !== draft.reply || !draft.reply.trim())) {
      return { ...draft, result: undefined, accepted: [] };
    }
    return draft.reviewVersion === 2 ? draft : { ...draft, accepted: [] };
  } catch { return; }
}

export function storeWritingDraft(storage: Pick<Storage, 'setItem'>, draft: WritingDraft): boolean {
  try { storage.setItem(key(draft.selection.projectId), JSON.stringify({ ...draft, reviewVersion: 2 })); return true; }
  catch { return false; }
}

export function clearWritingDraft(storage: Pick<Storage, 'removeItem'>, projectId: string) {
  try { storage.removeItem(key(projectId)); } catch { /* Applied content is already saved. */ }
}

export function sameSelection(left: EditSelection, right: EditSelection) {
  return left.projectId === right.projectId && left.path === right.path &&
    left.from === right.from && left.to === right.to && left.documentText === right.documentText;
}

export function completeSuggestion(output: AiReply): AiReply {
  if (output.finishReason === 'length') throw new Error('建议因输出长度被截断，禁止应用，请缩小选区后重试。');
  if (output.finishReason !== 'stop') throw new Error('模型没有明确正常结束，已保留输出但禁止应用，请重试。');
  const text = output.text.replace(/^```(?:latex|tex|text)?\s*\n([\s\S]*?)\n```\s*$/i, '$1');
  if (!text.trim()) throw new Error('AI 没有返回可用替换内容。');
  return { ...output, text };
}

export function selectionScope(selection: EditSelection, projectId: string, path: string, content: string) {
  replaceSelectedText(selection.documentText, selection, selection.text);
  if (selection.projectId !== projectId || selection.path !== path || selection.documentText !== content ||
      content.slice(selection.from, selection.to) !== selection.text) {
    throw new Error('选区基线已过期，请重新选择源码。已保留当前输入。');
  }
  return { selection: { path, from: selection.from, to: selection.to, documentText: content, selectedText: selection.text } };
}
