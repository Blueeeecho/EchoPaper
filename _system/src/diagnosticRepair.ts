import type { Diagnostic } from '../shared/types';
import type { ReferenceIndex } from '../shared/reference-types';

export interface DiagnosticRepair {
 message: string;
 definitions: { file: string; line: number }[];
}

function sanePath(value: string): boolean {
 return Boolean(value) && !/^[A-Za-z]:/.test(value) && !/[\\\u0000-\u001f]/.test(value)
  && value.split('/').every(part => Boolean(part) && part !== '.' && part !== '..');
}

/** Offer navigation and checks only; a workspace index cannot prove target inclusion. */
export function diagnosticRepair(diagnostic: Diagnostic, index: ReferenceIndex, sourceRoot: string): DiagnosticRepair | undefined {
 if (diagnostic.category !== 'reference') return;
 const match = /\b(Reference|Citation)\s+[`'"“]([^`'"’”\r\n]+)[`'"’”][^\r\n]*\bundefined\b/i.exec(diagnostic.message);
 if (!match) return;
 const citation = match[1].toLowerCase() === 'citation';
 const candidates = citation ? index.entries : index.labels;
 const definitions: DiagnosticRepair['definitions'] = [];
 const seen = new Set<string>();
 if (sanePath(sourceRoot)) for (const entry of candidates) {
  if (entry.key !== match[2] || !sanePath(entry.file) || !entry.file.startsWith(`${sourceRoot}/`)
   || !Number.isInteger(entry.line) || entry.line < 1) continue;
  const identity = JSON.stringify([entry.file, entry.line]);
  if (seen.has(identity)) continue;
  seen.add(identity); definitions.push({ file: entry.file, line: entry.line });
  if (definitions.length === 5) break;
 }
 return {
  message: definitions.length
   ? citation
    ? '当前工作区存在同名文献条目，请检查其文献库是否被本次目标引入。'
    : '当前工作区存在同名标签，请检查所在文件是否被本次目标引入。'
   : citation
    ? '请核对引用键的拼写、文献条目及文献库引入配置；当前索引可能不完整。'
    : '请核对标签键的拼写、标签定义及所在文件的引入配置；当前索引可能不完整。',
  definitions,
 };
}
