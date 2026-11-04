import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { activeTexFiles, parseDiagnostics, placeholderDiagnostics, sourceDiagnostics } from '../server/diagnostics.ts';
import type { SourceFile } from '../server/compile-utils.ts';

const files = (entries: Record<string, string>): SourceFile[] => Object.entries(entries).map(([path, text]) => {
  const bytes = Buffer.from(text); return { path, bytes, hash: createHash('sha256').update(bytes).digest('hex') };
});

test('undefined figure/table labels and citations are anchored to active source, duplicates to both definitions', () => {
  const source = files({
    'main.tex': '\\input{sections/body}\n\\bibliography{references}',
    'sections/body.tex': '\\ref{fig:missing}\n\\cref{tab:missing,fig:known}\n\\citep[see][p. 2]{known,missing}\n\\label{fig:known}\n\\label{duplicate}\n\\label{duplicate}',
    'references.bib': '@article{known, title={Known}}',
    'unused.tex': '\\label{fig:missing}\n\\ref{unused}\n\\input{absent.tex}',
  });
  const result = sourceDiagnostics(source, 'main.tex', 'manuscript');
  assert.equal(result.length, 5);
  assert.deepEqual(result.filter(d => /undefined/.test(d.message)).map(d => [d.message, d.file, d.line]), [
    ["Reference 'fig:missing' undefined.", 'manuscript/sections/body.tex', 1],
    ["Reference 'tab:missing' undefined.", 'manuscript/sections/body.tex', 2],
    ["Citation 'missing' undefined.", 'manuscript/sections/body.tex', 3],
  ]);
  assert.deepEqual(result.filter(d => /multiply defined/.test(d.message)).map(d => d.line), [5, 6]);
  assert.ok(result.every(d => d.severity === 'warning'));
});

test('comments, escaped percent, dormant multiline definitions, false branches and literal code are not dependencies', () => {
  const source = files({ 'main.tex': String.raw`% \input{comment.tex} \ref{comment}
\newcommand{\example}[1]{
  \input{macro.tex}\includegraphics{macro.png}\ref{macro}
}
\def\other#1{\input{primitive.tex}}
\newenvironment{example}{\input{environment.tex}}{}
\verb|\input{verb.tex}|
\begin{verbatim}
\ref{verbatim}\input{verbatim.tex}
\end{verbatim}
\begin{lstlisting}
\input{listing.tex}
\end{lstlisting}
\iffalse\input{false.tex}\else\label{real}\fi
\iftrue\ref{real}\else\input{false2.tex}\fi
\ifdefined\draft\input{uncertain.tex}\fi
Escaped percent \% \ref{missing}
\end{document}
\input{after-end.tex}` });
  assert.deepEqual(sourceDiagnostics(source, 'main.tex', ''), [], 'hidden dependencies defer absence checks to the engine');
  const result = parseDiagnostics("LaTeX Warning: Reference `missing' on page 1 undefined on input line 17.", '', 'main.tex', { succeeded: true, files: source });
  assert.equal(result.length, 1);
  assert.match(result[0].message, /Reference.*missing.*undefined/);
  assert.equal(result[0].line, 17);
  assert.deepEqual([...activeTexFiles(source, 'main.tex')], ['main.tex']);
});

test('local import and graphicspath resolution includes only frozen active dependencies', () => {
  const source = files({
    'main.tex': '\\graphicspath{{figures/}}\n\\import{sections/}{body}\n\\bibliography{references}\n\\includegraphics{present}',
    'sections/body.tex': '\\subimport{sub/}{child}\n\\includegraphics{chart}\n\\input{sections/sub/literal.tex}',
    'sections/sub/child.tex': '\\label{present}',
    'sections/sub/literal.tex': '\\ref{present}',
    'sections/chart.pdf': 'image', 'figures/present.png': 'image', 'references.bib': '@article{ref,title={x}}',
    'unused/template.tex': '\\includegraphics{not-real}\n\\input{missing.tex}',
  });
  assert.deepEqual(sourceDiagnostics(source, 'main.tex', ''), []);
  assert.deepEqual([...activeTexFiles(source, 'main.tex')].sort(), ['main.tex', 'sections/body.tex', 'sections/sub/child.tex', 'sections/sub/literal.tex']);
});

test('literal missing images, input and bibliography are warnings; failed engine evidence makes missing dependency an anchored error', () => {
  const source = files({ 'main.tex': '\\input{parts/absent}\n\\includegraphics[width=1cm]{figures/plot}\n\\bibliography{absent}\n\\includegraphics{\\dynamic}\n\\input{\\generated}' });
  const succeeded = parseDiagnostics('', 'manuscript', 'main.tex', { succeeded: true, files: source });
  assert.equal(succeeded.length, 3);
  assert.ok(succeeded.every(d => d.severity === 'warning'));
  const failed = parseDiagnostics("error: main.tex:1: I can't find file `parts/absent'.", 'manuscript', 'main.tex', { succeeded: false, files: source });
  const input = failed.filter(d => d.message.includes('parts/absent'));
  assert.equal(input.length, 1);
  assert.equal(input[0].severity, 'error');
  assert.equal(input[0].file, 'manuscript/main.tex');
  assert.equal(input[0].line, 1);
  assert.match(input[0].message, /can't find/);
});

test('external and macro generated labels and dynamic graphics search paths do not cause false missing diagnostics', () => {
  const source = files({ 'main.tex': String.raw`\externaldocument{remote}
\newcommand{\figurelabel}[1]{\label{#1}}
\figurelabel{fig:generated}\ref{fig:generated}\ref{external}
\graphicspath{{\figurefolder/}}
\includegraphics{generated}
\input{glyphtounicode}` });
  assert.deepEqual(sourceDiagnostics(source, 'main.tex', '', { succeeded: true }), []);
  const engine = parseDiagnostics("(main.tex\nLaTeX Warning: Reference `external' on page 1 undefined on input line 3.\n)", '', 'main.tex', { succeeded: true, files: source });
  assert.equal(engine.length, 1);
  assert.equal(engine[0].line, 3);
  assert.equal(engine[0].severity, 'warning');
});

test('includeonly and placeholder scanning follow the active graph and ignore multiline macro definitions', () => {
  const source = files({
    'main.tex': '\\includeonly{included}\n\\include{included}\n\\include{excluded}\n\\newcommand{\\todo}{\nTODO\n}\n\\input{nested}',
    'included.tex': '\\label{ok}', 'excluded.tex': '\\ref{inactive}\nTODO', 'nested.tex': 'TODO\n\\ref{ok}',
  });
  assert.deepEqual(sourceDiagnostics(source, 'main.tex', ''), []);
  assert.deepEqual(placeholderDiagnostics(source, 'main.tex', '').map(d => [d.file, d.line]), [['nested.tex', 1]]);
});

test('engine final pass is authoritative for citations and source warnings deduplicate identical line occurrences', () => {
  const source = files({ 'main.tex': '\\bibliography{refs}\n\\ref{missing}\n\\ref{missing}\n\\cite{known}', 'refs.bib': '@article{known,title={x}}' });
  const stream = "note: Running TeX ...\nwarning: main.tex:4: Citation `known' undefined.\nnote: Rerunning TeX ...\n";
  const finalLog = "(main.tex\nLaTeX Warning: Reference `missing' on page 1 undefined on input line 2.\n)";
  const result = parseDiagnostics(stream, '', 'main.tex', { succeeded: true, files: source, finalLog });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(d => d.line), [2, 3]);
  assert.ok(result.every(d => d.category === 'reference' && d.severity === 'warning'));
  assert.match(result[0].message, /on page 1/);
});


test('fatal diagnostics preserve multiline explanation and source context while retaining separate errors', () => {
  const source = files({ 'main.tex': '\\begin{document}\n\\broken\n\\ref{missing}\n\\end{document}' });
  const log = '(main.tex\n! Undefined control sequence.\nl.2 \\broken\nThe control sequence at the end of the top line was never defined.\n\nerror: main.tex:3: A second fatal error\n  More precise engine detail\nnote: Rerunning TeX ...';
  const result = parseDiagnostics(log, '', 'main.tex', { succeeded: false, files: source });
  const errors = result.filter(d => d.severity === 'error');
  assert.equal(errors.length, 2);
  assert.equal(errors[0].line, 2);
  assert.match(errors[0].message, /l\.2 \\broken/);
  assert.match(errors[0].message, /never defined/);
  assert.match(errors[1].message, /More precise engine detail/);
  assert.equal(errors[1].line, 3);
  assert.ok(result.some(d => d.category === 'reference' && d.severity === 'warning'));
});


test('nested known conditionals and inherited includeonly never activate discarded dependencies', () => {
  const source = files({
    'main.tex': '\\includeonly{kept}\n\\iftrue\\iffalse\\input{discarded.tex}\\fi\\fi\n\\input{child}\n\\iffalse\\input{no.tex}\\else\\iftrue\\label{yes}\\else\\input{no2.tex}\\fi\\fi\n\\ref{yes}',
    'child.tex': '\\include{excluded}\n\\include{kept}',
    'excluded.tex': '\\input{missing.tex}', 'kept.tex': '\\ref{yes}',
  });
  assert.deepEqual(sourceDiagnostics(source, 'main.tex', ''), []);
  assert.deepEqual([...activeTexFiles(source, 'main.tex')].sort(), ['child.tex', 'kept.tex', 'main.tex']);
});


test('newif declarations do not swallow the rest of the document as an unknown conditional', () => {
  const source = files({ 'main.tex': '\\newif\\ifdraft\n\\draftfalse\n\\ifdraft Draft text\\fi\n\\ref{missing}' });
  assert.deepEqual(sourceDiagnostics(source, 'main.tex', '').map(d => [d.message, d.line]), [["Reference 'missing' undefined.", 4]]);
});

test('citation and reference identities remain separate when their keys are identical', () => {
  const source = files({ 'main.tex': '\\cite{same}\n\\ref{same}\n\\label{same}' });
  const result = parseDiagnostics("(main.tex\nLaTeX Warning: Citation `same' on page 1 undefined on input line 1.\n)", 'manuscript', 'main.tex', { succeeded: true, files: source });
  assert.equal(result.length, 1);
  assert.match(result[0].message, /Citation/);
  assert.equal(result[0].line, 1);
  assert.equal(result[0].page, 1);
  const reverse = files({ 'main.tex': '\\bibliography{refs}\n\\ref{same}\n\\cite{same}', 'refs.bib': '@article{same,title={x}}' });
  const references = parseDiagnostics("(main.tex\nLaTeX Warning: Reference `same' on page 2 undefined on input line 2.\n)", '', 'main.tex', { succeeded: true, files: reverse });
  assert.equal(references.length, 1);
  assert.match(references[0].message, /Reference/);
  assert.equal(references[0].line, 2);
});

test('external absolute filenames cannot borrow the basename of a frozen local source', () => {
  const source = files({ 'main.tex': 'line 1\nline 2' });
  const result = parseDiagnostics('error: /usr/local/share/texmf/foo/main.tex:2: A package error', 'manuscript', 'main.tex', { succeeded: false, files: source });
  assert.equal(result.length, 1);
  assert.equal(result[0].file, undefined);
  assert.equal(result[0].line, undefined);
  assert.match(result[0].message, /\/usr\/local\/share\/texmf\/foo\/main\.tex:2/);
  const snapshot = parseDiagnostics('error: /workspace/build/b-1/source/main.tex:2: Local error', 'manuscript', 'main.tex', { succeeded: false, files: source });
  assert.equal(snapshot[0].file, 'manuscript/main.tex');
  assert.equal(snapshot[0].line, 2);
  const unknown = parseDiagnostics('error: /workspace/source/unknown.tex:2: Unknown source', 'manuscript', 'main.tex', { succeeded: false, files: source });
  assert.equal(unknown[0].file, undefined);
  const citationSource = files({ 'main.tex': '\\cite{same}\n\\bibliography{refs}', 'refs.bib': '@article{same,title={x}}' });
  const externalCitation = parseDiagnostics("warning: /usr/local/foo/main.tex:1: Citation `same' on page 9 undefined.", '', 'main.tex', { succeeded: true, files: citationSource });
  assert.equal(externalCitation.length, 1);
  assert.equal(externalCitation[0].file, undefined);
  assert.equal(externalCitation[0].page, 9);

});

test('macro and dynamic input graphs require engine evidence before claiming a label is absent', () => {
  for (const main of [
    '\\newcommand{\\load}{\\input{labels}}\n\\load\n\\ref{known}',
    '\\ifdefined\\draft\\input{labels}\\fi\n\\ref{known}',
    '\\input{\\sourcefile}\n\\ref{known}',
  ]) {
    const source = files({ 'main.tex': main, 'labels.tex': '\\label{known}' });
    assert.deepEqual(parseDiagnostics('', '', 'main.tex', { succeeded: true, files: source }), []);
    const line = main.split('\n').length;
    const result = parseDiagnostics(`LaTeX Warning: Reference \`known' on page 4 undefined on input line ${line}.`, '', 'main.tex', { succeeded: true, files: source });
    assert.equal(result.length, 1);
    assert.equal(result[0].file, 'main.tex');
    assert.equal(result[0].line, line);
    assert.ok(result.every(d => d.severity === 'warning'));
    assert.equal(result[0].page, 4);
  }
});

test('engine pages survive source anchor recovery and distinguish repeated warnings on different PDF pages', () => {
  const source = files({ 'main.tex': '\\ref{missing}' });
  const log = "LaTeX Warning: Reference `missing' on page 2 undefined on input line 1.\n\nLaTeX Warning: Reference `missing' on page 3 undefined on input line 1.";
  const result = parseDiagnostics(log, '', 'main.tex', { succeeded: true, files: source });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(d => d.page), [2, 3]);
  assert.ok(result.every(d => d.file === 'main.tex' && d.line === 1));
});


test('engine termination summary does not count the preceding missing file twice', () => {
 const source=files({'main.tex': String.raw`\includegraphics{absent}`});
 const result=parseDiagnostics("error: main.tex:1: LaTeX Error: File `absent' not found.\nerror: halted on potentially-recoverable error as specified", 'manuscript','main.tex',{succeeded:false,files:source});
 assert.equal(result.filter(item=>item.severity==='error').length,1);
 assert.equal(result.find(item=>item.message.startsWith('halted'))?.severity,'info');
 assert.equal(parseDiagnostics('error: halted on potentially-recoverable error as specified','','main.tex',{succeeded:false})[0].severity,'error');
});
