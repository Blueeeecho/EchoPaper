import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
async function component(file: string, react = React) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(file, import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs',
    packages: 'external', loader: { '.css': 'empty' }, jsx: 'automatic',
  });
  const loaded = { exports: {} as { default: React.ComponentType<any> } };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    (name: string) => name === 'react' ? react : name.endsWith('.css') ? {} : require(name), loaded, loaded.exports,
  );
  return loaded.exports.default;
}

const Panel = await component('../src/components/AiPanel.tsx');
const stamp = '2026-11-09T08:40:00Z';
const conversation = { id: 'chat', title: '对话', createdAt: stamp, updatedAt: stamp, messages: [], input: 'Keep this draft', model: '', effort: 'medium' };
const props = { projectId: 'fixture', currentPath: 'main.tex', currentContent: 'source', tasks: { runs: [], details: {} }, builds: [], onReadSelection() {}, onStartTask() {}, onOpenFile() {}, onViewBuild() {}, onClose() {} };

test('chat opens with a composer and compact context instead of permanent task controls', () => {
  const before = { local: globalThis.localStorage, session: globalThis.sessionStorage };
  Object.assign(globalThis, {
    localStorage: { getItem: () => JSON.stringify({ version: 1, selectedId: 'chat', conversations: [conversation] }) },
    sessionStorage: { getItem: () => null },
  });
  try {
    const html = renderToStaticMarkup(React.createElement(Panel, props));
    assert.ok(html.includes('aria-label="AI 消息"'));
    assert.ok(html.includes('Keep this draft'));
    assert.ok(html.includes('aria-label="更多对话操作" aria-expanded="false"'));
    assert.ok(!html.includes('aria-label="助手操作范围"'));
    assert.ok(!html.includes('aria-label="写作任务方式"'));
    assert.ok(!html.includes('aria-label="写作输出方式"'));
  } finally { Object.assign(globalThis, { localStorage: before.local, sessionStorage: before.session }); }
});

test('a saved PDF quote is compact by default while its draft stays in the composer', () => {
  const before = { local: globalThis.localStorage, session: globalThis.sessionStorage };
  const quote = 'A long quoted paragraph that should be available on demand.';
  Object.assign(globalThis, {
    localStorage: { getItem: () => JSON.stringify({ version: 1, selectedId: 'chat', conversations: [conversation] }) },
    sessionStorage: { getItem: (key: string) => key.startsWith('echopaper:writing-chat:') ? JSON.stringify({ chat: { taskScope: 'readOnly', reference: { path: 'PDF 只读参考 · 构建 old-build · 第 3 页', content: quote }, writingTask: { kind: 'focused', outputMode: 'suggest', verification: 'none' } } }) : null },
  });
  try {
    const html = renderToStaticMarkup(React.createElement(Panel, props));
    assert.ok(html.includes('PDF 选文'));
    assert.ok(!html.includes(quote));
    assert.ok(html.includes('aria-label="移除引用选文"'));
    assert.ok(html.includes('Keep this draft'));
  } finally { Object.assign(globalThis, { localStorage: before.local, sessionStorage: before.session }); }
});

test('same-page PDF right-click delegates to its one menu and cross-page quotes consume the event', async () => {
  const before = { document: globalThis.document, window: globalThis.window, Element: globalThis.Element };
  const effects: (() => void | (() => void))[] = [], updates: any[] = [];
  const listeners = new Map<string, (event: any) => void>();
  const ownedRoot = {};
  class Element {
    constructor(readonly layer?: Element) {}
    closest(selector: string): any {
      if (selector === '.textLayer') return this.layer || this;
      if (selector === '.writing-area') return ownedRoot;
      if (selector === '[data-ai-selection-menu="true"]') return ownedRoot;
      if (selector === '[data-page]') return { dataset: { page: '3' } };
      return null;
    }
  }
  const first = new Element(), last = new Element();
  let crossPage = false;
  const fakeWindow = new EventTarget() as EventTarget & Record<string, any>;
  Object.assign(fakeWindow, { innerWidth: 1000, innerHeight: 800, getSelection: () => ({ rangeCount: 1, toString: () => 'Selected PDF text', getRangeAt: () => ({ startContainer: first, endContainer: crossPage ? last : first }) }) });
  Object.assign(globalThis, {
    Element,
    window: fakeWindow,
    document: { activeElement: null, addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener), removeEventListener() {} },
  });
  const cleanups: (() => void)[] = [];
  try {
    const Menu = await component('../src/components/WritingSelectionMenu.tsx', {
      ...React,
      useState: (value: any) => [value, (next: any) => { updates.push(next); }],
      useRef: (value: any) => ({ current: value }),
      useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
    } as any);
    (Menu as any)({ projectId: 'fixture', buildId: 'build', readSource() {}, onAdd() {}, onEdit() {} });
    for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
    const event = () => ({ target: first, button: 2, ctrlKey: false, clientX: 100, clientY: 200, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
    updates.length = 0;
    const samePage = event();
    listeners.get('pointerdown')!(samePage);
    listeners.get('contextmenu')!(samePage);
    assert.equal(updates.filter(Boolean).length, 0);
    assert.equal(samePage.prevented, false);
    crossPage = true;
    updates.length = 0;
    const multiPage = event();
    listeners.get('pointerdown')!(multiPage);
    listeners.get('contextmenu')!(multiPage);
    assert.equal(updates.filter(Boolean).length, 1);
    assert.equal(multiPage.prevented, true);
    assert.equal(multiPage.stopped, true);
    fakeWindow.dispatchEvent(new Event('echopaper:selection-menu-open'));
    assert.equal(updates.at(-1), undefined);
  } finally {
    for (const cleanup of cleanups) cleanup();
    Object.assign(globalThis, before);
  }
});
