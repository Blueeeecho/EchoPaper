import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { diagnosticCount, forEachDiagnostic, type Diagnostic as LintDiagnostic } from '@codemirror/lint';
import { diagnosticPath, diagnosticsForPath, editorDiagnostics, editorDiagnosticContext, editorDiagnosticTransaction, mapEditorDiagnostics,editorMarkerSeverity } from '../src/editorDiagnostics.ts';
import type { Diagnostic } from '../shared/types.ts';
const diagnostic = (overrides: Partial<Diagnostic> = {}): Diagnostic => ({ severity: 'warning', category: 'reference', message: 'Reference `missing` undefined', file: 'manuscript/main.tex', line: 2, ...overrides });
const input = (overrides: Record<string, unknown> = {}) => ({ path: 'manuscript/main.tex', diagnostics: [diagnostic()], buildId: 'build-001', ...overrides });
function create(doc = 'header\n  \\ref{missing}\nlast') { return EditorState.create({ doc, selection: { anchor: 3 }, extensions: editorDiagnostics }); }
function apply(state: EditorState, transaction?: TransactionSpec) { return transaction ? state.update(transaction).state : state; }
function active(state: EditorState) {
 const result: { diagnostic: LintDiagnostic; from: number; to: number }[] = [];
 forEachDiagnostic(state, (diagnostic, from, to) => result.push({ diagnostic, from, to })); return result;
}
test('filter exact project-relative paths without basename, missing-file or traversal guesses', () => {
 const items = [diagnostic(), diagnostic({ file: './manuscript/main.tex' }), diagnostic({ file: 'reviews/main.tex' }), diagnostic({ file: 'main.tex' }), diagnostic({ file: undefined }), diagnostic({ file: '/tmp/manuscript/main.tex' })];
 assert.equal(diagnosticsForPath('manuscript/main.tex', items).length, 2);
 assert.equal(diagnosticPath('manuscript\\main.tex'), 'manuscript/main.tex');
 for (const path of ['/tmp/main.tex', '../main.tex', 'manuscript/../main.tex', 'C:\\main.tex', '']) assert.equal(diagnosticPath(path), undefined);
});
test('only valid source lines become markers, upgrading submission blockers and deduplicating rows', () => {
 const state = create();
 const diagnostics = [diagnostic(), diagnostic(), ...[0, -1, 4, 1.5, NaN, undefined].map(line => diagnostic({ line })), diagnostic({ severity: 'error', category: 'compile', line: 1, message: 'Undefined control sequence' })];
 const mapped = mapEditorDiagnostics(state, input({ diagnostics }));
 assert.equal(mapped.length, 2);
 assert.equal(mapped[0].severity, 'error'); assert.equal(mapped[0].source, '引用');
 assert.equal(state.sliceDoc(mapped[0].from, mapped[0].to), 'missing');
 assert.equal(mapped[1].severity, 'error');
});
test('empty source lines have a valid zero-length marker without clamping bad lines', () => {
 const state = create('header\n\nlast'); const mapped = mapEditorDiagnostics(state, input());
 assert.equal(mapped.length, 1); assert.equal(mapped[0].from, 7); assert.equal(mapped[0].to, 7);
});
test('diagnostic effects preserve document and selection; repeated SSE snapshots do not relocate edited ranges', () => {
 let state = create(); state = apply(state, editorDiagnosticTransaction(state, input()));
 assert.equal(diagnosticCount(state), 1); assert.equal(state.selection.main.head, 3);
 const old = active(state)[0];
 state = state.update({ changes: { from: 0, insert: 'new\n' } }).state;
 assert.equal(active(state)[0].from, old.from + 4);
 assert.equal(state.field(editorDiagnosticContext).stale, true);
 assert.equal(editorDiagnosticTransaction(state, input({ diagnostics: [diagnostic()] })), undefined);
 assert.equal(state.doc.lineAt(active(state)[0].from).number, 3);
});
test('a new build resets mapped positions, while file switches clear markers', () => {
 let state = create(); state = apply(state, editorDiagnosticTransaction(state, input()));
 state = state.update({ changes: { from: 0, insert: 'new\n' } }).state;
 state = apply(state, editorDiagnosticTransaction(state, input({ buildId: 'build-002' })));
 assert.equal(state.doc.lineAt(active(state)[0].from).number, 2);
 assert.equal(state.field(editorDiagnosticContext).stale, false);
 state = apply(state, editorDiagnosticTransaction(state, input({ path: 'manuscript/other.tex' })));
 assert.equal(diagnosticCount(state), 0);
});
test('fresh stale snapshots cannot guess offsets; retained markers remain explicitly stale after save', () => {
 let state = create(); state = apply(state, editorDiagnosticTransaction(state, input({ stale: true })));
 assert.equal(diagnosticCount(state), 0); assert.equal(state.field(editorDiagnosticContext).unmapped, true);
 state = apply(state, editorDiagnosticTransaction(state, input({ buildId: 'build-002' })));
 assert.equal(diagnosticCount(state), 1);
 state = apply(state, editorDiagnosticTransaction(state, input({ buildId: 'build-002', stale: true })));
 assert.equal(diagnosticCount(state), 1);
 assert.equal(editorDiagnosticTransaction(state, input({ buildId: 'build-002', stale: false })), undefined);
 assert.equal(state.field(editorDiagnosticContext).stale, true);
});
test('reference keys mark matching command arguments across duplicate occurrences, never prose or citation arguments', () => {
 const text = "missing prose \\cite{missing} \\ref{other} \\ref{missing} and \\eqref{ missing } % \\ref{missing}";
 const state = create(`header\n${text}\nlast`);
 const mapped = mapEditorDiagnostics(state, input());
 assert.equal(mapped.length, 2);
 assert.deepEqual(mapped.map(d => state.sliceDoc(d.from, d.to)), ['missing', 'missing']);
 assert.deepEqual(mapped.map(d => d.from - state.doc.line(2).from), [text.indexOf('missing}', text.indexOf('\\ref{missing}')), text.indexOf(' missing ') + 1]);
});
test('citation matching isolates comma-delimited keys and skips optional citation notes with the same word', () => {
 const text = "missing \\citep[missing][p. 3]{other, missing, missing} \\ref{missing} \\textcite{missing}";
 const state = create(`header\n${text}\nlast`);
 const mapped = mapEditorDiagnostics(state, input({ diagnostics: [diagnostic({ message: "Citation 'missing' undefined." })] }));
 assert.equal(mapped.length, 3);
 assert.ok(mapped.every(d => state.sliceDoc(d.from, d.to) === 'missing'));
 assert.equal(mapped[0].from - state.doc.line(2).from, text.indexOf(' missing,') + 1);
 assert.equal(mapped[1].from - state.doc.line(2).from, text.indexOf(' missing}') + 1);
 assert.equal(mapped[2].from - state.doc.line(2).from, text.lastIndexOf('missing}'));
});
test('duplicate label diagnostics narrow to labels rather than references or ordinary key text', () => {
 const state = create('header\n fig:one prose \\ref{fig:one} \\label{fig:one} \\label{fig:two}\nlast');
 const mapped = mapEditorDiagnostics(state, input({ diagnostics: [diagnostic({ message: "Label `fig:one' multiply defined." })] }));
 assert.equal(mapped.length, 1); assert.equal(state.sliceDoc(mapped[0].from, mapped[0].to), 'fig:one');
 assert.equal(state.sliceDoc(mapped[0].from - 7, mapped[0].from), '\\label{');
});
test('quoted filenames narrow only to the matching dependency command and preserve explicit extensions', () => {
 const text = "plots/result.pdf prose \\input{plots/result.pdf} \\includegraphics[width=.4\\linewidth]{plots/result.png} \\includegraphics{plots/result.pdf}";
 const state = create(`header\n${text}\nlast`);
 const mapped = mapEditorDiagnostics(state, input({ diagnostics: [diagnostic({ category: 'compile', message: "Image file 'plots/result.pdf' was not found in the frozen source snapshot." })] }));
 assert.equal(mapped.length, 1); assert.equal(state.sliceDoc(mapped[0].from, mapped[0].to), 'plots/result.pdf');
 assert.equal(mapped[0].from - state.doc.line(2).from, text.lastIndexOf('plots/result.pdf'));
 const unbraced = create('header\n  chapter.tex prose \\input chapter\nlast');
 const inputMapped = mapEditorDiagnostics(unbraced, input({ diagnostics: [diagnostic({ category: 'compile', message: "Input file `chapter.tex' not found." })] }));
 assert.equal(inputMapped.length, 1); assert.equal(unbraced.sliceDoc(inputMapped[0].from, inputMapped[0].to), 'chapter');
});
test('diagnostics without a matching quoted command argument keep a trimmed line fallback', () => {
 const state = create('header\n   missing prose \\ref{other}\nlast');
 const mapped = mapEditorDiagnostics(state, input());
 assert.equal(mapped.length, 1); assert.equal(state.sliceDoc(mapped[0].from, mapped[0].to), 'missing prose \\ref{other}');
});
test('placeholders use a yellow gutter reminder without losing submission-blocking severity',()=>{
 const state=create('header\nAn entire long paragraph with a TODO result to fill in.\nlast');
 const placeholders=mapEditorDiagnostics(state,input({diagnostics:[diagnostic({category:'placeholder',severity:'info',message:'TODO: fill in results'})]}));
 assert.equal(placeholders[0].severity,'error');
 assert.equal(placeholders[0].markClass,'ep-diagnostic-placeholder');
 assert.equal(editorMarkerSeverity(placeholders),'warning');
 const reference=mapEditorDiagnostics(create(),input());
 assert.equal(editorMarkerSeverity([...placeholders,...reference]),'error','An actual citation error on the same line takes precedence');
 assert.equal(reference[0].markClass,'ep-diagnostic-range');
});
