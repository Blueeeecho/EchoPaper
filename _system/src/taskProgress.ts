import type { AgentRun } from '../shared/agent-types';
import { agentResultDisplay } from '../shared/agent-display';

export function isTaskProgressQuestion(input: string): boolean {
  const text = input.trim().replace(/[\s，。！？、,.!?]/gu, '').toLowerCase();
  const progressPhrase = /^(?:请问(?:一下)?|想问(?:一下)?|麻烦问(?:一下)?|请告诉我)?(?:(?:现在|目前|当前)的?)?(?:(?:任务|工作)的?)?(?:进度(?:怎么样|如何|到哪(?:一步)?了|呢)?|状态(?:怎么样|如何)?|(?:做到|进行到|到)哪(?:一步)?了)$/u;
  if (progressPhrase.test(text)) return true;
  return new Set([
    '现在到哪了', '现在到哪一步了', '进行到哪了', '进行到哪一步了',
    '目前进度如何', '当前进度', '当前状态', '任务状态', '现在什么进度',
    '进度如何', '进度怎么样', '进度呢', '做完了吗', '完成了吗',
    '还在运行吗', '你还在吗', '你在吗', '现在到哪一步',
    'whatisthestatus', 'whatisthecurrentstatus', 'whatistheprogress',
    'howisitgoing', 'areyoustillworking',
  ]).has(text);
}

export function taskProgressReply(run: AgentRun): string {
  const display = agentResultDisplay(run);
  const applied = display.changes.applied;
  const phase = run.status === 'completed' ? display.label : run.phase;
  const completedState = display.label === '部分完成'
    ? '本轮部分完成，仍有未解决事项。'
    : `当前结果为${display.label}。`;
  const state = run.status === 'waiting_confirmation'
    ? '当前等待审阅建议。'
    : ['running', 'queued'].includes(run.status)
      ? '任务继续执行。'
      : run.status === 'completed' ? completedState : `当前状态为${run.phase}。`;
  return `当前${phase}。已应用 ${applied} 组修改，已启动 ${run.buildIds.length} 次构建。\n${state}`;
}
