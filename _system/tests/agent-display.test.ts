import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFinalReply, agentDecisionDisplay, agentResultDisplay, agentUndoProgress, summarizeAgentChanges } from '../shared/agent-display.ts';
import { DEFAULT_AGENT_LIMITS, type AgentRun, type ChangeSet } from '../shared/agent-types.ts';
import type { Build } from '../shared/types.ts';

const stamp = '2026-11-09T08:10:00Z';
function run(patch: Partial<AgentRun> = {}): AgentRun {
  return { id: 'run-ui', projectId: 'fixture', requestId: 'request-ui', input: '只调整指定段落', targetId: 'main', modelId: 'mock', status: 'completed', phase: '已完成', createdAt: stamp, updatedAt: stamp, configRevision: 'fixture-config', summary: '修改全部成功，编译验证通过。', scope: {}, changesets: [], children: [], buildIds: [], usage: { modelCalls: 2, tokens: 100, estimated: true }, limits: DEFAULT_AGENT_LIMITS, lastEventSeq: 0, version: 1, ...patch };
}
function change(id: string, status: ChangeSet['status']): ChangeSet {
  return { id, runId: 'run-ui', description: id, operations: [{ kind: 'write', path: 'manuscript/main.tex', content: 'new', expectedHash: 'old' }], readSet: {}, status, images: [{ path: 'manuscript/main.tex', beforeHash: 'old', afterHash: 'new' }], createdAt: stamp };
}
const built: Build = { id: 'build-ui', projectId: 'fixture', targetId: 'main', status: 'succeeded', createdAt: stamp, sourceHash: 'source', log: 'mock', diagnostics: [], pdf: 'main.pdf', stale: false };
const verified = { buildIds: ['build-ui'], verifiedBuildId: 'build-ui', verifiedSourceHash: 'source', currentSourceVerified: true };

test('final review summary exposes accepted unresolved findings and retains execution errors', () => {
  const value = run({
    outcome: 'partial',
    scope: { readOnly: true },
    error: '协作结果已保留，主助手逐项处理与科研验收尚待核对。\n文献检索服务暂不可用。',
    children: [{
      id: 'review-child', roleId: 'reviewer', name: '论文审稿人', status: 'completed', task: '核对证据',
      reviewStatus: 'accepted',
      acceptance: {
        disposition: '采纳缺失证据的判断。',
        unresolved: ['摘要和实验结果尚未提供，无法判断结论是否成立。'],
        snapshotHash: 'current', changesHash: 'none', requestRevision: 'request-ui',
      },
    }],
  });
  const reply = agentFinalReply(value);
  assert.match(reply, /摘要和实验结果尚未提供/);
  assert.match(reply, /文献检索服务暂不可用/);
  assert.ok(!reply.includes('主助手逐项处理与科研验收尚待核对'));
  const stale = agentFinalReply({ ...value, children: value.children.map(child => ({ ...child, reviewStatus: 'stale' })) });
  assert.ok(!stale.includes('摘要和实验结果尚未提供'));
  assert.match(stale, /主助手逐项处理与科研验收尚待核对/);
});

test('completed partial work remains visibly partial despite an optimistic model summary', () => {
  const value = agentResultDisplay(run({ outcome: 'partial', changesets: [change('saved', 'applied')] }));
  assert.equal(value.label, '部分完成');
  assert.match(value.summary, /已应用 1 组/);
  assert.match(value.summary, /本轮未编译/);
  assert.match(value.summary, /未解决/);
  assert.ok(!value.summary.includes('全部成功'));
});

test('continued operation records explain the handoff while explicit stops retain their label', () => {
  const continued = agentResultDisplay(run({status:'cancelled',continuedBy:'next',error:'Aborted',changesets:[change('saved','applied')]}));
  assert.equal(continued.label, '已按后续要求接续');
  assert.equal(continued.tone, 'neutral');
  assert.match(continued.summary, /已应用 1 组/);
  assert.equal(agentResultDisplay(run({status:'cancelled'})).label, '已停止');
});

test('a proposal is not a saved edit or a resolved goal, even in a completed legacy run', () => {
  const value = agentResultDisplay(run({ outcome: 'resolved', changesets: [change('suggestion', 'proposed')] }));
  assert.equal(value.label, '建议未应用');
  assert.equal(value.changes.applied, 0);
  assert.match(value.summary, /没有可用的应用确认/);
  assert.equal(value.buildVerified, false);
});

test('ordinary proposals have an apply decision without deletion wording and stale decisions cannot apply', () => {
  const value = run({ status: 'waiting_confirmation', changesets: [change('proposal', 'proposed')], pendingDecision: { id: 'decision', changesetId: 'proposal', message: '请审阅' } });
  assert.equal(agentDecisionDisplay(value)?.approveLabel, '应用此修改');
  assert.equal(agentDecisionDisplay(value)?.canApprove, true);
  assert.equal(agentResultDisplay(value).label, '待审阅 · 建议未应用');
  assert.equal(agentDecisionDisplay({ ...value, changesets: [change('proposal', 'applied')] })?.canApprove, false);
  assert.equal(agentDecisionDisplay({ ...value, status: 'cancelled' })?.canApprove, false);
  assert.equal(agentDecisionDisplay({ ...value, changesets: [] })?.canApprove, false);
  assert.equal(agentDecisionDisplay({ ...value, scope: { readOnly: true } })?.canApprove, false);
});

test('mixed delete/write proposals retain explicit deletion information', () => {
  const proposal = change('proposal', 'proposed');
  proposal.operations.push({ kind: 'delete', path: 'notes/old.md', expectedHash: 'old' });
  const decision = agentDecisionDisplay(run({ status: 'waiting_confirmation', changesets: [proposal], pendingDecision: { id: 'd', changesetId: proposal.id, message: '审阅' } }));
  assert.match(decision!.approveLabel, /含删除/);
});

test('stopping or failing a run preserves the visible applied changes and does not imply rollback', () => {
  for (const status of ['cancelled', 'failed', 'conflicted', 'interrupted', 'budget_exceeded'] as const) {
    const value = agentResultDisplay(run({ status, changesets: [change('saved', 'applied')] }));
    assert.match(value.summary, /已应用 1 组/);
    assert.match(value.summary, /不会自动撤销/);
    assert.notEqual(value.tone, 'success');
  }
});

test('saved uncompiled text and compile-verified source have different outcomes', () => {
  const saved = run({ changesets: [change('saved', 'applied')], outcome: 'resolved' });
  assert.equal(agentResultDisplay(saved).label, '已保存 · 本轮未编译');
  const confirmed = agentResultDisplay({ ...saved, ...verified }, [built]);
  assert.equal(confirmed.label, '已保存 · 编译通过');
  assert.match(confirmed.verification, /页面视觉与科学内容仍需分别核对/);
});

test('a newer failed or cancelled compilation never inherits earlier success', () => {
  for (const status of ['failed', 'cancelled'] as const) {
    const last = { ...built, id: 'latest', status, pdf: undefined };
    const value = agentResultDisplay(run({ ...verified, buildIds: ['build-ui', 'latest'], changesets: [change('saved', 'applied')] }), [built, last]);
    assert.equal(value.buildVerified, false);
    assert.notEqual(value.tone, 'success');
    assert.match(value.verification, status === 'failed' ? /编译未通过/ : /编译已取消/);
  }
});

test('stale, foreign, missing, error-bearing, or mismatched build evidence cannot certify the current version', () => {
  for (const evidence of [[], [{ ...built, stale: true }], [{ ...built, projectId: 'other' }], [{ ...built, targetId: 'other' }], [{ ...built, sourceHash: 'different' }], [{ ...built, pdf: undefined }], [{ ...built, diagnostics: [{ severity: 'error', category: 'compile', message: 'unresolved' }] }]] as Build[][]) {
    const value = agentResultDisplay(run({ ...verified, changesets: [change('saved', 'applied')] }), evidence);
    assert.equal(value.buildVerified, false);
    assert.notEqual(value.tone, 'success');
  }
});

test('undo journal states override old success and verification flags', () => {
  const value = agentResultDisplay(run({ ...verified, changesets: [change('a', 'undone'), change('b', 'applied')] }), [built]);
  assert.equal(value.label, '部分撤销');
  assert.equal(value.buildVerified, false);
  assert.match(value.summary, /已撤销 1 组/);
  assert.match(value.summary, /仍有修改保留/);
  assert.match(value.verification, /撤销后/);
  assert.equal(agentResultDisplay(run({ ...verified, changesets: [change('a', 'undone')] }), [built]).label, '已撤销');
});

test('undo outcomes describe partial success, unchanged records, and unknown groups without claiming an all-or-nothing result', () => {
  const partial = agentUndoProgress([change('a', 'undone'), change('b', 'applied')], ['a', 'b']);
  assert.equal(partial.complete, false);
  assert.match(partial.text, /1\/2/);
  assert.match(partial.text, /仍已应用 1 组/);
  assert.match(partial.text, /尚未全部确认/);
  assert.equal(agentUndoProgress([change('a', 'applied')], ['a']).complete, false);
  assert.match(agentUndoProgress([], ['lost']).text, /状态待核对/);
  assert.equal(agentUndoProgress([change('a', 'undone')], ['a', 'a']).complete, true);
  assert.equal(agentUndoProgress([], []).complete, false);
});

test('change counts report current groups and unique affected files, excluding inverse journal entries', () => {
  const inverse = { ...change('undo', 'applied'), undoOf: 'old' };
  const value = summarizeAgentChanges([change('a', 'applied'), change('b', 'applied'), change('c', 'failed'), inverse]);
  assert.equal(value.applied, 2);
  assert.equal(value.files, 1);
  assert.equal(value.failed, 1);
});

test('execution completion alone is not reported as goal success, while a resolved read-only answer is identified precisely', () => {
  assert.equal(agentResultDisplay(run()).label, '执行已结束');
  const answered = agentResultDisplay(run({ outcome: 'resolved', scope: { readOnly: true } }));
  assert.equal(answered.label, '已回复');
  assert.match(answered.summary, /没有文件修改或编译记录/);
});

test('a generated PDF with error diagnostics is distinct from a failed compiler process', () => {
  const value = agentResultDisplay(run({ ...verified }), [{ ...built, diagnostics: [{ severity: 'error', category: 'reference', message: 'Unresolved citation' }] }]);
  assert.equal(value.label, '编译检查未通过');
  assert.match(value.verification, /错误诊断/);
  assert.equal(value.buildVerified, false);
});


test('automatic closing replies lead with results and keep unresolved reasons without build identifiers', () => {
  const saved = run({ ...verified, outcome: 'resolved', changesets: [change('saved', 'applied')] });
  const complete = agentFinalReply(saved, { build: built });
  assert.equal(complete, '已应用 1 组修改（1 个文件）。当前源码已通过编译验证。');
  assert.ok(!complete.includes(built.id));
  const partial = agentFinalReply({ ...saved, outcome: 'partial', error: '引用 DOI 不匹配。\n第二项缺少原始数据。' }, { build: built, readiness: 2 });
  assert.ok(partial.startsWith('本轮部分完成。'));
  assert.match(partial, /2 项投稿检查待办/);
  assert.match(partial, /- 引用 DOI 不匹配。\n- 第二项缺少原始数据。/);
  const failed = agentFinalReply(run({ status: 'failed', outcome: 'partial', error: '服务返回 503', changesets: [change('saved', 'applied')] }));
  assert.ok(failed.startsWith('执行失败。已应用的 1 组修改可审阅和撤销'));
  assert.match(failed, /503/);
  assert.match(failed, /本轮未编译/);
  const stale = agentFinalReply({ ...saved, currentSourceVerified: false }, { build: { ...built, stale: true } });
  assert.ok(!stale.includes('当前源码已通过'));
  assert.match(stale, /尚未确认/);
});
