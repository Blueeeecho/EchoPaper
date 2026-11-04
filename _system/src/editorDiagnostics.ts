import { EditorState, RangeSet, StateEffect, StateField, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, keymap, showTooltip, type Tooltip } from '@codemirror/view';
import { forEachDiagnostic, lintKeymap, linter, openLintPanel, setDiagnosticsEffect, type Diagnostic as LintDiagnostic } from '@codemirror/lint';
import type { Diagnostic } from '../shared/types';
import {submissionSeverity} from '../shared/diagnostic-policy';

export interface EditorDiagnosticInput {
 path: string;
 diagnostics: readonly Diagnostic[];
 stale?: boolean;
 buildId?: string;
}
interface DiagnosticContext { key: string; path: string; buildId?: string; stale: boolean; unmapped: boolean }
const contextEffect = StateEffect.define<DiagnosticContext>();
export const editorDiagnosticContext = StateField.define<DiagnosticContext>({
 create: () => ({ key: '', path: '', stale: false, unmapped: false }),
 update(context, transaction) {
  if (transaction.docChanged) context = { ...context, stale: true };
  for (const effect of transaction.effects) if (effect.is(contextEffect)) context = effect.value;
  return context;
 },
 provide: field => EditorView.editorAttributes.from(field, context => ({ 'data-diagnostics-stale': String(context.stale) })),
});
const categories: Record<Diagnostic['category'], string> = { compile: '编译', reference: '引用', placeholder: '待补充' };
const severities = { error: '严重问题', warning: '警告', info: '提示', hint: '提示' };

/** Match project-relative paths exactly; a shared basename is never sufficient. */
export function diagnosticPath(path: string | undefined): string | undefined {
 if (!path) return;
 const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
 if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(part => part === '..' || !part)) return;
 return normalized;
}
export function diagnosticsForPath(path: string, diagnostics: readonly Diagnostic[]): Diagnostic[] {
 const normalized = diagnosticPath(path);
 return normalized ? diagnostics.filter(diagnostic => diagnosticPath(diagnostic.file) === normalized) : [];
}
interface ArgumentRange { from: number; to: number; value: string }
function isEscaped(text: string, offset: number): boolean {
 let slashes = 0; while (offset > 0 && text[--offset] === '\\') slashes++;
 return slashes % 2 === 1;
}
function argumentAt(text: string, offset: number, open = '{', close = '}'): ArgumentRange | undefined {
 while (/\s/.test(text[offset] || '') && offset < text.length) offset++;
 if (text[offset] !== open) return;
 const from = ++offset; let depth = 1;
 for (; offset < text.length; offset++) {
  if (isEscaped(text, offset)) continue;
  if (text[offset] === open) depth++;
  else if (text[offset] === close && --depth === 0) return { from, to: offset, value: text.slice(from, offset) };
 }
}
/** Quoted engine identities narrow marks only within relevant TeX arguments. */
function diagnosticArgumentRanges(text: string, message: string): { from: number; to: number }[] {
 const identity = message.match(/\b(Reference|Citation|Label)\s+[`'"“‘]([^`'"”’]+)[`'"”’]/i);
 const dependency = message.match(/\b(?:(Input|Image|Bibliography)\s+)?file\s+[`'"“‘]([^`'"”’]+)[`'"”’]/i);
 if (!identity && !dependency) return [];
 const kind = identity?.[1].toLowerCase() || dependency?.[1]?.toLowerCase() || 'file';
 const target = (identity?.[2] || dependency?.[2] || '').trim();
 if (!target) return [];
 // Ignore commented commands, preserving all offsets before the comment.
 for (let i = 0; i < text.length; i++) if (text[i] === '%' && !isEscaped(text, i)) { text = text.slice(0, i); break; }
 const ranges: { from: number; to: number }[] = [];
 const command = /\\([A-Za-z@]+)\*?/g; let match: RegExpExecArray | null;
 while ((match = command.exec(text))) {
  if (isEscaped(text, match.index)) continue;
  const name = match[1];
  const citation = /cite/i.test(name);
  const reference = /^(?:(?:page|auto|name|eq|v|V)?ref|[cC](?:page)?ref(?:range)?)$/.test(name);
  const label = /^(?:label|linelabel)$/.test(name);
  const image = /^(?:includegraphics|pgfimage|epsfig)$/.test(name);
  const input = /^(?:input|include|subfile|verbatiminput|lstinputlisting)$/.test(name);
  const bibliography = /^(?:bibliography|addbibresource)$/.test(name);
  if (kind === 'citation' ? !citation : kind === 'reference' ? !reference : kind === 'label' ? !label : kind === 'image' ? !image : kind === 'input' ? !input : kind === 'bibliography' ? !bibliography : !(image || input || bibliography)) continue;
  let cursor = command.lastIndex;
  for (let i = 0; i < 2; i++) { const option = argumentAt(text, cursor, '[', ']'); if (option) cursor = option.to + 1; }
  let argument = argumentAt(text, cursor);
  if (!argument && name === 'input') {
   const unbraced = text.slice(cursor).match(/^\s*([^\s{}]+)/);
   if (unbraced) { const from = cursor + unbraced[0].indexOf(unbraced[1]); argument = { from, to: from + unbraced[1].length, value: unbraced[1] }; }
  }
  if (!argument) continue;
  const tokens = citation || reference || bibliography ? [...argument.value.matchAll(/[^,]+/g)] : [{ 0: argument.value, index: 0 }];
  for (const token of tokens) {
   const value = token[0].trim();
   const fileIdentity = (name: string) => name.replace(/^\.\//, '').replace(/\\/g, '/');
   const withoutExtension = (name: string) => fileIdentity(name).replace(input ? /\.tex$/i : bibliography ? /\.bib$/i : /\.(?:pdf|png|jpe?g|eps|svg|webp)$/i, '');
   const matches = identity ? value === target : fileIdentity(value) === fileIdentity(target) || fileIdentity(value) === withoutExtension(target) || withoutExtension(value) === fileIdentity(target);
   if (!matches || !value) continue;
   const from = argument.from + (token.index || 0) + token[0].indexOf(value);
   ranges.push({ from, to: from + value.length });
  }
 }
 return ranges;
}
export function mapEditorDiagnostics(state: EditorState, input: EditorDiagnosticInput): LintDiagnostic[] {
 const seen = new Set<string>();
 return diagnosticsForPath(input.path, input.diagnostics).flatMap(diagnostic => {
  if (!Number.isInteger(diagnostic.line) || diagnostic.line! < 1 || diagnostic.line! > state.doc.lines) return [];
  const key = JSON.stringify(diagnostic);
  if (seen.has(key)) return [];
  seen.add(key);
  const line = state.doc.line(diagnostic.line!);
  const matches = diagnosticArgumentRanges(line.text, diagnostic.message);
  const ranges = matches.length ? matches : [{ from: line.text.match(/^\s*/)?.[0].length || 0, to: line.length }];
  return ranges.map(range => ({
   from: line.from + range.from, to: line.from + range.to, severity: submissionSeverity(diagnostic), source: categories[diagnostic.category],
   message: diagnostic.message, markClass: diagnostic.category==='placeholder'?'ep-diagnostic-placeholder':'ep-diagnostic-range',
   renderMessage: (view: EditorView) => diagnosticMessage(view, diagnostic),
  }));
 });
}
function baselineLabel(state: EditorState): string {
 const context = state.field(editorDiagnosticContext);
 return `${context.stale ? '上次编译结果 · 源码已变化，位置仅供参考' : '本次编译结果'}${context.buildId ? ` · ${context.buildId.slice(-12)}` : ''}`;
}
function diagnosticMessage(view: EditorView, diagnostic: Diagnostic): HTMLElement {
 const result = document.createElement('div'); result.className = 'ep-diagnostic-message';
 const baseline = document.createElement('small'); baseline.className = 'ep-diagnostic-baseline'; baseline.textContent = baselineLabel(view.state);
 const message = document.createElement('span'); message.textContent = `${categories[diagnostic.category]} · ${severities[submissionSeverity(diagnostic)]}：${diagnostic.message}`;
 result.append(baseline, message); return result;
}
/** A repeated SSE snapshot must not reset positions already mapped through edits. */
export function editorDiagnosticTransaction(state: EditorState, input: EditorDiagnosticInput): TransactionSpec | undefined {
 const previous = state.field(editorDiagnosticContext);
 const path = diagnosticPath(input.path) || '';
 const diagnostics = diagnosticsForPath(path, input.diagnostics);
 const key = JSON.stringify([path, input.buildId || '', diagnostics]);
 const same = previous.key === key;
 const stale = Boolean(input.stale || (same && previous.stale));
 if (same && stale === previous.stale) return;
 const context = { key, path, buildId: input.buildId, stale, unmapped: same ? previous.unmapped : stale };
 const effects = [contextEffect.of(context)];
 if (!same) {
  // A fresh stale snapshot has no trustworthy current offsets. Existing live
  // markers can be mapped through edits, but a historical file cannot be guessed.
  return { effects: [...effects, setDiagnosticsEffect.of(stale ? [] : mapEditorDiagnostics(state, input)), diagnosticTooltipEffect.of(null)] };
 }
 return { effects };
}
export function updateEditorDiagnostics(view: EditorView, input: EditorDiagnosticInput): void {
 const transaction = editorDiagnosticTransaction(view.state, input);
 if (transaction) view.dispatch(transaction);
}

const diagnosticTooltipEffect = StateEffect.define<Tooltip | null>();
const diagnosticTooltip = StateField.define<Tooltip | null>({
 create: () => null,
 update(value, transaction) {
  if (transaction.docChanged || transaction.selection) value = null;
  for (const effect of transaction.effects) if (effect.is(diagnosticTooltipEffect)) value = effect.value;
  return value;
 },
 provide: field => showTooltip.from(field),
});
function openLineDetails(view: EditorView, from: number): void {
 view.dispatch({ selection: { anchor: from }, effects: diagnosticTooltipEffect.of(null), scrollIntoView: true });
 openLintPanel(view);
}
let tooltipId = 0;
/** A quiet yellow gutter reminder need not change submission-blocking policy. */
export function editorMarkerSeverity(diagnostics:readonly LintDiagnostic[]):'error'|'warning'|'info'{
 const issues=diagnostics.filter(d=>d.source!=='待补充');
 return issues.some(d=>d.severity==='error')?'error':diagnostics.some(d=>d.source==='待补充'||d.severity==='warning')?'warning':'info';
}
class DiagnosticMarker extends GutterMarker {
 private hideTimer?: ReturnType<typeof setTimeout>;
 destroy(): void { if (this.hideTimer) clearTimeout(this.hideTimer); }
 constructor(readonly from: number, readonly diagnostics: readonly LintDiagnostic[], readonly baseline: string) { super(); }
 eq(other: DiagnosticMarker): boolean {
  return this.from === other.from && this.baseline === other.baseline && this.diagnostics.length === other.diagnostics.length && this.diagnostics.every((d, i) => d === other.diagnostics[i]);
 }
 toDOM(view: EditorView): HTMLElement {
  const button = document.createElement('button'); button.type = 'button';
  const descriptionId = `ep-diagnostic-tooltip-${++tooltipId}`;
  button.setAttribute('aria-describedby', descriptionId);
  const severity = editorMarkerSeverity(this.diagnostics);
  button.className = `ep-diagnostic-marker ep-diagnostic-marker-${severity}`;
  const line = view.state.doc.lineAt(this.from).number;
  button.setAttribute('aria-label', `第 ${line} 行，${this.diagnostics.length} 条${severities[severity]}。${this.baseline}。按回车查看问题`);
  button.title = `${this.baseline}\n${this.diagnostics.map(d => `${d.source} · ${severities[d.severity]}：${d.message}`).join('\n')}`;
  const cancelHide = () => { if (this.hideTimer) clearTimeout(this.hideTimer); };
  const hide = () => { cancelHide(); view.dispatch({ effects: diagnosticTooltipEffect.of(null) }); };
  const scheduleHide = () => { cancelHide(); this.hideTimer = setTimeout(hide, 160); };
  const show = () => { cancelHide(); view.dispatch({ effects: diagnosticTooltipEffect.of({
   pos: this.from, above: false, clip: false,
   create: () => {
    const dom = document.createElement('div'); dom.className = 'ep-diagnostic-tooltip';
    dom.id = descriptionId; dom.setAttribute('role', 'tooltip');
    for (const diagnostic of this.diagnostics) {
     const item = document.createElement('div'); item.className = 'ep-diagnostic-tooltip-item';
     if (diagnostic.renderMessage) item.append(diagnostic.renderMessage(view)); else item.textContent = `${diagnostic.source}：${diagnostic.message}`;
     dom.append(item);
    }
    const details = document.createElement('button'); details.type = 'button'; details.textContent = '查看问题列表';
    details.addEventListener('click', () => openLineDetails(view, this.from)); dom.append(details);
    dom.addEventListener('mouseenter', cancelHide);
    dom.addEventListener('mouseleave', scheduleHide);
    dom.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); hide(); view.focus(); } });
    return { dom, getCoords: () => { const rect = button.getBoundingClientRect(); return { left: rect.right + 10, right: rect.right + 10, top: rect.top, bottom: rect.bottom }; } };
   },
  }) }); };
  button.addEventListener('click', show);
  button.addEventListener('mouseenter', show); button.addEventListener('focus', show);
  button.addEventListener('mouseleave', event => {
   if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest('.ep-diagnostic-tooltip')) scheduleHide();
  });
  button.addEventListener('blur', event => {
   if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest('.ep-diagnostic-tooltip')) scheduleHide();
  });
  button.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); hide(); view.focus(); } });
  return button;
 }
}
const diagnosticGutter = gutter({
 class: 'ep-diagnostic-gutter',
 markers(view) {
  const lines = new Map<number, LintDiagnostic[]>();
  forEachDiagnostic(view.state, (diagnostic, from) => {
   const pos = view.state.doc.lineAt(from).from;
   const items = lines.get(pos) || []; items.push(diagnostic); lines.set(pos, items);
  });
  const baseline = baselineLabel(view.state);
  return RangeSet.of([...lines].map(([from, diagnostics]) => new DiagnosticMarker(from, diagnostics, baseline).range(from)), true);
 },
});
/** Installed once; diagnostic updates are state effects, never extension reconfiguration. */
export const editorDiagnostics: Extension = [
 editorDiagnosticContext, diagnosticTooltip, linter(null, { autoPanel: false,tooltipFilter:diagnostics=>diagnostics.filter(d=>d.source!=='待补充') }), diagnosticGutter,
 keymap.of(lintKeymap),
 EditorView.updateListener.of(update => {
  if (update.startState.field(editorDiagnosticContext) !== update.state.field(editorDiagnosticContext)) {
   for (const element of update.view.dom.querySelectorAll('.ep-diagnostic-baseline')) element.textContent = baselineLabel(update.state);
  }
 }),
 EditorState.phrases.of({ 'Diagnostics': '当前文件问题', 'No diagnostics': '没有可定位的问题', 'close': '关闭' }),
];
