import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const source = new URL('../src/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, source), 'utf8');

test('the app entry supplies the shell and reader stylesheet variables without fallbacks', () => {
  assert.match(read('main.tsx'), /import ['"]\.\/styles\/tokens\.css['"]/);
  assert.match(read('styles/tokens.css'), /:root\s*\{/);
  const styles = readdirSync(source, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.css')).map(read).join('\n');
  const declared = new Set([...styles.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
  // PDF.js receives this property dynamically from its page viewport.
  const missing = [...new Set([...styles.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)]
    .map(match => match[1]).filter(name => name !== '--scale-factor' && !declared.has(name)))];
  assert.deepEqual(missing, []);
});
