import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticRepair } from '../src/diagnosticRepair.ts';
import type { Diagnostic } from '../shared/types.ts';
import type { LabelEntry, ReferenceEntry, ReferenceIndex } from '../shared/reference-types.ts';

const diagnostic = (message: string, category: Diagnostic['category'] = 'reference'): Diagnostic => ({ severity: 'warning', category, message });
const label = (key: string, file = 'manuscript/body.tex', line = 2): LabelEntry => ({ key, file, line, context: '' });
const entry = (key: string, file = 'manuscript/refs.bib', line = 3): ReferenceEntry => ({ key, file, line, type: 'article', title: '', author: '', year: '', doi: '' });
const index = (labels: LabelEntry[] = [], entries: ReferenceEntry[] = []): ReferenceIndex => ({ labels, entries, warnings: [] });

test('named undefined references match exact label keys without crossing citation namespace', () => {
 const result = diagnosticRepair(diagnostic("LaTeX Warning: Reference `same' on page 1 undefined on input line 2."), index([label('same'), label('Same'), label('similar')], [entry('same')]), 'manuscript');
 assert.deepEqual(result?.definitions, [{ file: 'manuscript/body.tex', line: 2 }]);
 assert.match(result!.message, /同名标签.*本次目标引入/);
 const citationOnly = diagnosticRepair(diagnostic("Reference 'same' undefined."), index([], [entry('same')]), 'manuscript');
 assert.deepEqual(citationOnly?.definitions, []);
 assert.match(citationOnly!.message, /拼写.*索引可能不完整/);
});

test('citations use bibliography entries and describe inclusion as a check', () => {
 const result = diagnosticRepair(diagnostic('Citation “known” undefined.'), index([label('known')], [entry('known')]), 'manuscript');
 assert.deepEqual(result?.definitions, [{ file: 'manuscript/refs.bib', line: 3 }]);
 assert.match(result!.message, /同名文献条目.*文献库.*本次目标引入/);
 const missing = diagnosticRepair(diagnostic("Citation `Known' undefined."), index([label('Known')], [entry('known')]), 'manuscript');
 assert.deepEqual(missing?.definitions, []);
 assert.match(missing!.message, /引用键的拼写.*索引可能不完整/);
});

test('definition locations stay inside the exact sane source root with valid lines', () => {
 const paths = ['reviews/round-01/response/main.tex', 'manuscript2/main.tex', 'manuscript/../reviews/main.tex', '/manuscript/main.tex', 'C:/manuscript/main.tex', 'manuscript//main.tex', 'manuscript/./main.tex', 'manuscript\\main.tex', 'manuscript/private\u0000.tex'];
 const labels = [...paths.map(file => label('key', file)), ...[0, -1, 1.5, NaN, Infinity].map(line => label('key', 'manuscript/body.tex', line)), label('key')];
 assert.deepEqual(diagnosticRepair(diagnostic("Reference 'key' undefined."), index(labels), 'manuscript')?.definitions, [{ file: 'manuscript/body.tex', line: 2 }]);
 assert.deepEqual(diagnosticRepair(diagnostic("Reference 'key' undefined."), index(labels), 'reviews/round-01/response')?.definitions, [{ file: paths[0], line: 2 }]);
 for (const root of ['', '/manuscript', 'manuscript/', '../manuscript', 'manuscript/../reviews', 'C:/manuscript', 'manuscript\\nested']) {
  assert.deepEqual(diagnosticRepair(diagnostic("Reference 'key' undefined."), index(labels), root)?.definitions, []);
 }
});

test('locations are deduplicated and capped at five', () => {
 const labels = [label('key'), label('key'), ...Array.from({ length: 8 }, (_, i) => label('key', `manuscript/part-${i}.tex`, i + 1))];
 const result = diagnosticRepair(diagnostic("Reference 'key' undefined."), index(labels), 'manuscript');
 assert.equal(result?.definitions.length, 5);
 assert.equal(new Set(result?.definitions.map(value => JSON.stringify(value))).size, 5);
});

test('summaries, duplicate labels and unrelated compiler messages have no repair suggestion', () => {
 for (const message of ['There were undefined references.', 'There were undefined citations.', "Label 'key' multiply defined.", 'Undefined control sequence.', "Reference 'key' is valid."]) {
  assert.equal(diagnosticRepair(diagnostic(message), index([label('key')]), 'manuscript'), undefined);
 }
 assert.equal(diagnosticRepair(diagnostic("Reference 'key' undefined.", 'compile'), index([label('key')]), 'manuscript'), undefined);
});
