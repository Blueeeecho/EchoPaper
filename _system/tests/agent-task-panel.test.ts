import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as React from 'react';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentRun, ChangeSet } from '../shared/agent-types.ts';
import { DEFAULT_AGENT_LIMITS } from '../shared/agent-types.ts';
import type { Build } from '../shared/types.ts';
import type { ProjectTasks } from '../src/useProjectTasks.ts';

// Bundle only local component code in memory; CSS has no role in static markup.
// React remains external so the component shares the renderer's hook dispatcher.
const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/components/AgentTaskPanel.tsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'empty' }, jsx: 'automatic' });
const componentModule = { exports: {} as { default: ComponentType<any> } };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), componentModule, componentModule.exports);
const Panel = componentModule.exports.default;
const stamp = '2026-11-09T08:10:00Z';
const base: AgentRun = { id: 'run', projectId: 'fixture', requestId: 'request', input: '仅修改此段', targetId: 'main', modelId: 'mock', status: 'completed', phase: '已完成', createdAt: stamp, updatedAt: stamp, configRevision: 'fixture-config', summary: '历史中声称全部完成。', scope: {}, changesets: [], children: [], buildIds: [], usage: { modelCalls: 3, tokens: 300, estimated: true }, limits: DEFAULT_AGENT_LIMITS, lastEventSeq: 0, version: 1 };
function change(status: ChangeSet['status']): ChangeSet {
  return { id: 'suggestion', runId: 'run', description: '修订选中句', operations: [{ kind: 'write', path: 'manuscript/main.tex', content: 'new sentence', expectedHash: 'old' }], readSet: {}, status, images: [{ path: 'manuscript/main.tex', beforeHash: 'old', afterHash: 'new', beforeBase64: Buffer.from('old sentence').toString('base64'), afterBase64: Buffer.from('new sentence').toString('base64') }], createdAt: stamp };
}
function render(value: AgentRun, compact: boolean, detailRun = value, builds: Build[] = []): string {
  const tasks: ProjectTasks = { runs: [value], detail: undefined, details: { run: { run: detailRun, events: [], tools: [{ id: 'tool', runId: 'run', agentId: 'coordinator', name: 'read_file', arguments: { path: 'main.tex' }, status: 'completed', result: 'evidence', createdAt: stamp }] } }, selectedId: 'run', loading: false, connected: true, error: '', busy: '', select() {}, async refresh() {}, clearError() {}, async create() { return value; }, async load() {}, async action() {} };
  return renderToStaticMarkup(createElement(Panel, { tasks, builds, runId: 'run', compact, onOpenFile() {}, onViewBuild() {} }));
}
const currentResult = (html: string) => html.slice(html.indexOf('<header class="task-state"'), html.indexOf('<div class="task-scope"'));

test('compact and full panels always show the same actual partial result before folded execution details', () => {
  const value = { ...base, outcome: 'partial' as const, changesets: [change('applied')] };
  for (const compact of [true, false]) {
    const html = render(value, compact), visible = currentResult(html);
    assert.match(visible, /部分完成/);
    assert.match(visible, /已应用 1 组/);
    assert.match(visible, /本轮未编译/);
    assert.ok(!visible.includes('历史中声称全部完成'));
    assert.match(html, /<details class="task-execution-details"><summary>/);
    assert.ok(html.includes('历史中声称全部完成'));
    assert.ok(html.indexOf('本轮实际结果') < html.indexOf('执行细节'));
  }
});

test('ordinary pending proposals expose the real diff and an apply button in either panel size', () => {
  const value: AgentRun = { ...base, status: 'waiting_confirmation', changesets: [change('proposed')], pendingDecision: { id: 'decision', changesetId: 'suggestion', message: '请审阅此建议' } };
  for (const compact of [true, false]) {
    const html = render(value, compact);
    assert.match(currentResult(html), /建议未应用/);
    assert.match(html, /应用此修改<\/button>/);
    assert.match(html, /<details class="task-file-diff" open="">/);
    assert.ok(html.includes('old sentence') && html.includes('new sentence'));
    assert.ok(!html.includes('确认删除'));
  }
});

test('cancelled edits retain a clear saved-changes statement and group undo, without a success heading', () => {
  const value: AgentRun = { ...base, status: 'cancelled', changesets: [change('applied')] };
  const html = render(value, true);
  assert.match(currentResult(html), /已停止/);
  assert.match(currentResult(html), /不会自动撤销/);
  assert.ok(!currentResult(html).includes('tone-success'));
  assert.match(html, /撤销此组修改/);
});

test('a newer detail snapshot wins over a stale list after undo and historical prose stays folded', () => {
  const old = { ...base, version: 1, changesets: [change('applied')] };
  const latest = { ...old, version: 2, changesets: [change('undone')] };
  const html = render(old, true, latest);
  assert.match(currentResult(html), /已撤销/);
  assert.ok(!html.includes('撤销此组修改'));
  assert.match(html, /查看当时的任务摘要与回复/);
});

test('stale review decisions cannot present an enabled apply action', () => {
  const value: AgentRun = { ...base, status: 'waiting_confirmation', pendingDecision: { id: 'decision', changesetId: 'missing', message: '过期建议' } };
  const html = render(value, true);
  assert.match(html, /状态不一致/);
  assert.match(html, /<button disabled="">[^]*?确认此操作<\/button>/);
});

test('failed builds and saved uncompiled changes remain identifiable in compact and full panels', () => {
  const value: AgentRun = { ...base, outcome: 'resolved', buildIds: ['failed-build'], changesets: [change('applied')] };
  const build: Build = { id: 'failed-build', projectId: 'fixture', targetId: 'main', status: 'failed', createdAt: stamp, diagnostics: [], log: 'mock failure' };
  for (const compact of [true, false]) {
    assert.match(currentResult(render(value, compact, value, [build])), /编译失败/);
    assert.ok(!currentResult(render(value, compact, value, [build])).includes('tone-success'));
    assert.match(currentResult(render({ ...value, buildIds: [] }, compact)), /已保存 · 本轮未编译/);
  }
});

function interaction(value: AgentRun, action: ProjectTasks['action']) {
  const updates: any[] = [], loads: string[] = [], require = createRequire(import.meta.url);
  const exports = { exports: {} as { default: (props: any) => any } };
  const hooks = { ...React, useMemo: (calculate: () => unknown) => calculate(), useState: () => [undefined, (update: unknown) => updates.push(update)] };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)((id: string) => id === 'react' ? hooks : require(id), exports, exports.exports);
  const tasks = { runs: [value], details: {}, selectedId: 'run', connected: true, busy: '', error: '', action, async load(id: string) { loads.push(id); } };
  const tree = exports.exports.default({ tasks, builds: [], runId: 'run', compact: true, onOpenFile() {}, onViewBuild() {} });
  const text = (node: any): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : '';
  const button = (label: string) => {
    let found: any;
    const visit = (node: any) => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node?.props) { if (node.type === 'button' && text(node).trim() === label) found = node; visit(node.props.children); }
    };
    visit(tree); assert.ok(found, label); return found;
  };
  return { button, updates, loads };
}

test('accepting an ordinary proposal submits only its actual pending decision to the existing action', async () => {
  const calls: unknown[] = [];
  const value: AgentRun = { ...base, status: 'waiting_confirmation', changesets: [change('proposed')], pendingDecision: { id: 'decision-actual', changesetId: 'suggestion', message: '审阅' } };
  const ui = interaction(value, async (...args) => { calls.push(args); });
  ui.button('应用此修改').props.onClick();
  assert.deepEqual(calls, [['decisions', { decisionId: 'decision-actual', approve: true }, 'run']]);
});

test('group undo always refreshes the journal after an action failure and never creates a success toast', async () => {
  const calls: unknown[] = [];
  const ui = interaction({ ...base, changesets: [change('applied')] }, async (...args) => { calls.push(args); throw new Error('后续编辑冲突'); });
  ui.button('撤销此组修改').props.onClick();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['undo', { changesetId: 'suggestion' }, 'run']]);
  assert.deepEqual(ui.loads, ['run']);
  assert.equal(ui.updates.at(-1).checking, false);
  assert.equal(ui.updates.at(-1).error, '后续编辑冲突');
  assert.ok(!ui.updates.some(value => value?.success));
});

test('image import suggestions render the actual image for review', () => {
  const imageChange = change('proposed');
  imageChange.operations = [{kind:'attachment',path:'manuscript/figures/figure-1.png',attachmentId:'00000000-0000-4000-8000-000000000001',expectedHash:null}];
  imageChange.images = [{path:'manuscript/figures/figure-1.png',beforeHash:null,afterHash:'image-hash',afterBase64:'iVBORw0KGgo='}];
  const html = render({...base,status:'waiting_confirmation',changesets:[imageChange],pendingDecision:{id:'decision',changesetId:imageChange.id,message:'审阅换图'}},true);
  assert.match(html,/<img[^>]+src="data:image\/png;base64,iVBORw0KGgo="/);assert.match(html,/新增图片/);assert.match(html,/应用此修改/);
});
