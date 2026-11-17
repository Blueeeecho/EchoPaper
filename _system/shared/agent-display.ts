import type { AgentRun, ChangeSet } from './agent-types';
import type { Build } from './types';

export type AgentDisplayTone = 'neutral' | 'progress' | 'success' | 'warning' | 'error';
export interface AgentChangeSummary {
  applied: number; proposed: number; undone: number; failed: number; applying: number;
  files: number; text: string;
}

/** Current journal states, never the model's description of what it intended to do. */
export function summarizeAgentChanges(changes: readonly ChangeSet[]): AgentChangeSummary {
  const originals = changes.filter(change => !change.undoOf);
  const count = (state: ChangeSet['status']) => originals.filter(change => change.status === state).length;
  const applied = count('applied'), proposed = count('proposed'), undone = count('undone');
  const failed = count('failed') + count('conflicted'), applying = count('applying');
  const files = new Set(originals.filter(change => change.status === 'applied').flatMap(change => change.images.map(image => image.path))).size;
  const parts = [applied && `已应用 ${applied} 组修改${files ? `（${files} 个文件）` : ''}`, proposed && `${proposed} 组建议未应用`, undone && `已撤销 ${undone} 组修改`, failed && `${failed} 组变更未成功应用`, applying && `${applying} 组修改正在保存`].filter(Boolean);
  return { applied, proposed, undone, failed, applying, files, text: parts.length ? parts.join('；') + '。' : '本轮没有文件修改记录。' };
}

export interface AgentDecisionDisplay {
  title: string; approveLabel: string; rejectLabel: string; canApprove: boolean;
  change?: ChangeSet; note?: string;
}
export function agentDecisionDisplay(run: AgentRun): AgentDecisionDisplay | undefined {
  const pending = run.pendingDecision;
  if (!pending) return;
  const change = pending.changesetId ? run.changesets.find(value => value.id === pending.changesetId) : undefined;
  const valid = !run.scope.readOnly && run.status === 'waiting_confirmation' && (!pending.changesetId || change?.status === 'proposed');
  const deletion = change?.operations.some(operation => operation.kind === 'delete');
  return {
    title: change ? deletion ? '审阅修改（含删除）' : '审阅修改建议' : '需要你的决定',
    approveLabel: change ? deletion ? '确认并应用（含删除）' : '应用此修改' : '确认此操作',
    rejectLabel: change ? '不应用此修改' : '拒绝此操作',
    canApprove: valid, change,
    ...(!valid ? { note: run.scope.readOnly ? '本轮仅允许只读检查，不能应用修改。' : '此审阅请求与当前变更状态不一致，请刷新记录后再操作。' } : {}),
  };
}

const lifecycleLabels = {
  queued: '排队中', running: '执行中', waiting_confirmation: '等待审阅',
  conflicted: '文件版本冲突', cancelling: '正在停止', completed: '执行已结束',
  failed: '执行失败', cancelled: '已停止', interrupted: '已中断', budget_exceeded: '运行限制中断',
} satisfies Record<AgentRun['status'], string>;
const phaseLabels: Record<string, string> = {
  queued: '等待执行', planning: '理解要求', executing: '处理任务', reviewing: '审阅修改',
  applying: '保存修改', verifying: '验证结果', compiling: '编译检查',
};

export interface AgentResultDisplay {
  label: string; phase: string; tone: AgentDisplayTone; active: boolean;
  summary: string; verification: string; changes: AgentChangeSummary;
  build?: Build; buildVerified: boolean;
}

/** Execution completion is distinct from saving, compilation, and visual/scientific validation. */
export function agentResultDisplay(run: AgentRun, builds: readonly Build[] = []): AgentResultDisplay {
  const changes = summarizeAgentChanges(run.changesets);
  const lastBuildId = run.buildIds.at(-1);
  const build = builds.find(value => value.id === lastBuildId && value.projectId === run.projectId && value.targetId === run.targetId);
  // A newer failed build must never inherit the status of an earlier successful build.
  // After undo, old verification flags/replies may remain in legacy records.
  const buildVerified = !changes.undone && !!run.currentSourceVerified && !!run.verifiedSourceHash && !!build
    && build.id === run.verifiedBuildId && build.status === 'succeeded' && !!build.pdf && !build.stale
    && build.sourceHash === run.verifiedSourceHash && !build.diagnostics.some(value => value.severity === 'error');
  let verification: string;
  if (changes.undone) verification = '撤销后当前版本尚未确认通过编译验证。';
  else if (build?.status === 'failed') verification = '本轮最近一次编译未通过；当前版本尚未确认通过编译验证。';
  else if (build?.diagnostics.some(value => value.severity === 'error')) verification = '本轮构建仍有错误诊断；当前版本尚未确认通过编译检查。';
  else if (build?.status === 'cancelled') verification = '本轮最近一次编译已取消；当前版本尚未确认通过编译验证。';
  else if (build?.status === 'queued' || build?.status === 'running') verification = '正在等待本轮编译结果。';
  else if (buildVerified) verification = '当前源码与本轮通过的编译版本一致；页面视觉与科学内容仍需分别核对。';
  else if (lastBuildId && !build) verification = '本轮编译记录待核对，尚不能确认当前版本通过。';
  else if (lastBuildId || run.verifiedBuildId) verification = '构建记录存在，但尚未确认它验证了当前源码版本。';
  else if (changes.applied) verification = '修改已保存；本轮未编译。';
  else verification = '本轮未编译。';

  const active = ['queued', 'running', 'cancelling'].includes(run.status);
  let label: string = lifecycleLabels[run.status], tone: AgentDisplayTone = active ? 'progress' : 'neutral';
  if (run.status === 'waiting_confirmation') {
    label = changes.proposed ? '待审阅 · 建议未应用' : '等待决定'; tone = 'warning';
  } else if (['failed', 'conflicted'].includes(run.status)) tone = 'error';
  else if (['cancelled', 'interrupted', 'budget_exceeded'].includes(run.status)) tone = 'warning';
  else if (run.status === 'completed') {
    if (changes.undone) { label = changes.applied ? '部分撤销' : '已撤销'; tone = changes.applied ? 'warning' : 'neutral'; }
    else if (run.outcome === 'partial' || run.error || changes.failed) { label = '部分完成'; tone = 'warning'; }
    else if (build?.status === 'failed') { label = '编译失败'; tone = 'error'; }
    else if (build?.diagnostics.some(value => value.severity === 'error')) { label = '编译检查未通过'; tone = 'warning'; }
    else if (changes.proposed) { label = '建议未应用'; tone = 'warning'; }
    else if (changes.applied) {
      label = buildVerified ? '已保存 · 编译通过' : !lastBuildId && !run.verifiedBuildId ? '已保存 · 本轮未编译' : '已保存 · 待验证';
      tone = buildVerified ? 'success' : 'neutral';
    } else if (buildVerified) { label = '编译通过'; tone = 'success'; }
    else if (lastBuildId) { label = '执行已结束 · 待验证'; tone = 'warning'; }
    else if (run.outcome === 'resolved') label = '已回复';
  }
  let summary = changes.text;
  if (changes.applied && ['cancelled', 'failed', 'interrupted', 'budget_exceeded', 'conflicted'].includes(run.status)) summary += '已保存的修改仍保留，停止或失败不会自动撤销。';
  if (changes.undone && changes.applied) summary += '仍有修改保留，整批撤销尚未完成。';
  if (changes.proposed && !run.pendingDecision) summary += '当前没有可用的应用确认，请基于当前文件版本重新提交修改请求。';
  if (changes.applied || lastBuildId || changes.undone) summary += verification;
  if (run.outcome === 'partial' || run.error) summary += '本轮仍有未解决事项，请查看具体原因。';
  if (!run.changesets.length && !lastBuildId && run.status === 'completed' && run.outcome === 'resolved' && !run.error) summary = '已返回本轮回复；本轮没有文件修改或编译记录。';
  const phase = active ? phaseLabels[run.phase] || run.phase || '处理任务' : run.status === 'waiting_confirmation' ? '审阅后决定是否应用' : '执行已结束';
  if (run.continuedBy) return {
    label: '已按后续要求接续', tone: 'neutral', phase: '后续任务继续处理', active: false,
    summary: changes.text + '已应用的修改保留，后续要求由接续任务继续处理。',
    verification, changes, build, buildVerified,
  };
  return { label, tone, phase, active, summary, verification, changes, build, buildVerified };
}

/** The hook can resolve despite a rejected undo request: only journal changes prove success. */
export function agentUndoProgress(changes: readonly ChangeSet[], requestedIds: readonly string[], checking = false): { complete: boolean; text: string } {
  const requested = [...new Set(requestedIds)];
  const current = requested.map(id => changes.find(change => change.id === id));
  const undone = current.filter(change => change?.status === 'undone').length;
  const applied = current.filter(change => change?.status === 'applied').length;
  const unknown = current.length - undone - applied;
  const complete = !!requested.length && undone === requested.length;
  const parts = [`已确认撤销 ${undone}/${requested.length} 组`, applied && `仍已应用 ${applied} 组`, unknown && `${unknown} 组状态待核对`].filter(Boolean);
  return { complete, text: parts.join('；') + (checking ? '；正在核对记录。' : complete ? '。撤销已完成，当前版本需重新验证。' : '。本次撤销尚未全部确认完成，请查看逐组状态和错误。') };
}


/** Deterministic closing text uses persisted outcomes, without another model call. */
export function agentFinalReply(run: AgentRun, options: { build?: Build; skipCompile?: boolean; readiness?: number } = {}): string {
  const changes = summarizeAgentChanges(run.changesets);
  const display = agentResultDisplay(run, options.build ? [options.build] : []);
  const lines: string[] = [];
  if (run.status === 'completed' && run.outcome === 'partial') lines.push('本轮部分完成。');
  else if (run.status !== 'completed') lines.push(`${display.label}。`);
  const changeText = run.status !== 'completed' && changes.applied
    ? changes.text.replace(`已应用 ${changes.applied} 组修改`, `已应用的 ${changes.applied} 组修改可审阅和撤销`)
    : changes.text;
  if (changes.applied || changes.proposed || changes.undone || changes.failed) lines.push(changeText);
  else if (run.outcome === 'partial' || run.status !== 'completed') lines.push('本次未发生文件修改。');
  else if (run.buildIds.length) lines.push('编译检查已结束。');
  else lines.push('检查已结束。');

  if (run.buildIds.length || run.verifiedBuildId) {
    lines.push(display.buildVerified ? '当前源码已通过编译验证。' : display.verification);
  } else if (changes.applied) {
    lines.push(options.skipCompile ? '按本次要求未执行编译。' : '本轮未编译。');
  }
  const paragraphs = [lines.join('')];
  if (options.readiness) paragraphs.push(`稿件仍有 ${options.readiness} 项投稿检查待办。`);
  const reviewProblems = run.children
    .filter(child => child.reviewStatus === 'accepted')
    .flatMap(child => child.acceptance?.unresolved || []);
  if (run.error || reviewProblems.length) {
    const reasons = [...new Set([
      ...(run.error || '').split('\n').map(line => line.trim()).filter(line => line && (
        !reviewProblems.length || line !== '协作结果已保留，主助手逐项处理与科研验收尚待核对。'
      )),
      ...reviewProblems,
    ])];
    paragraphs.push(reasons.map(reason => `- ${reason}`).join('\n'));
  } else if (run.outcome === 'partial') {
    paragraphs.push('本轮仍有未完成事项，请查看操作记录中的修改与检查结果。');
  }
  return paragraphs.join('\n\n');
}
