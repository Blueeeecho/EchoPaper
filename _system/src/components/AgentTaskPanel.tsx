import { useMemo, useState } from 'react';
import { AlertCircle, Check, FileCode2, Link2, LoaderCircle, Play, RefreshCw, Square, Undo2, X } from 'lucide-react';
import type { AgentRunStatus, ChangeImage, ChangeSet } from '../../shared/agent-types';
import type { Build } from '../../shared/types';
import type { ProjectTasks } from '../useProjectTasks';
import '../agent-tasks.css';

const statusLabels: Record<AgentRunStatus, string> = { queued: '排队中', running: '执行中', waiting_confirmation: '等待决定', conflicted: '文件版本冲突', cancelling: '正在停止', completed: '已完成', failed: '执行失败', cancelled: '已停止', interrupted: '已中断', budget_exceeded: '运行限制中断' };
const phases: Record<string, string> = { queued: '等待执行', planning: '分析任务', executing: '执行工具', reviewing: '审阅修改', applying: '保存修改', verifying: '验证结果', compiling: '编译检查', completed: '已完成', stopped: '已停止' };
const toolLabels: Record<string, string> = { list_files: '列出文件', read_file: '读取文件', search_files: '搜索源码', read_diagnostics: '读取编译诊断', reference_index: '读取引用索引', verify_reference: '核验文献', inspect_pdf: '检查 PDF', propose_changes: '提出修改', apply_changes: '应用修改', compile: '编译验证', delegate: '委派角色' };
const changeLabels: Record<ChangeSet['status'], string> = { proposed: '待应用', applying: '正在应用', applied: '已应用', undone: '已撤销', conflicted: '版本冲突', failed: '应用失败' };
function readable(value: unknown): string { if (typeof value === 'string') return value; try { return JSON.stringify(value, null, 2) || ''; } catch { return '无法显示此记录'; } }
function decodeImage(value?: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > 3_000_000) return '文件过大，请打开文件或下载版本查看。';
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value), char => char.charCodeAt(0))); }
  catch { return '二进制文件；内容已保留在任务版本中。'; }
}
function sourcesFrom(values: unknown[]): string[] {
  const found = new Set<string>();
  function visit(value: unknown, depth: number) {
    if (depth > 7 || found.size >= 50) return;
    if (typeof value === 'string') for (const match of value.matchAll(/https?:\/\/[^\s<>"')\]}]+/g)) {
      try { const url = new URL(match[0].replace(/[.,;，。；]+$/, '')); if (url.protocol === 'http:' || url.protocol === 'https:') found.add(url.href); } catch {}
    }
    else if (Array.isArray(value)) value.forEach(item => visit(item, depth + 1));
    else if (value && typeof value === 'object') Object.values(value).forEach(item => visit(item, depth + 1));
  }
  values.forEach(value => visit(value, 0)); return [...found];
}
function TextComparison({ image, fallback }: { image: ChangeImage; fallback?: string }) {
  const [mode, setMode] = useState<'diff' | 'before' | 'after'>('diff');
  const before = decodeImage(image.beforeBase64) ?? (image.beforeHash === null ? '' : '此记录未包含修改前内容。');
  const after = decodeImage(image.afterBase64) ?? fallback ?? (image.afterHash === null ? '' : '此记录未包含修改后内容。');
  const limit = (text: string) => text.length > 150000 ? text.slice(0, 150000) + '\n…显示已截断，请打开文件查看完整内容。' : text;
  const left = before.split('\n'), right = after.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++;
  const changed = (lines: string[], side: 'before' | 'after') => <pre><span>{limit(lines.slice(0, prefix).join('\n'))}{prefix ? '\n' : ''}</span><span className={'task-diff-' + side}>{limit(lines.slice(prefix, lines.length - suffix).join('\n'))}</span><span>{suffix ? '\n' : ''}{limit(lines.slice(lines.length - suffix).join('\n'))}</span></pre>;
  return <details className="task-file-diff"><summary><FileCode2 size={12}/>{image.path}</summary><div className="task-diff-tabs" role="group" aria-label={'查看 ' + image.path + ' 的修改'}>{(['diff', 'before', 'after'] as const).map(item => <button key={item} aria-pressed={mode === item} onClick={() => setMode(item)}>{item === 'diff' ? '差异' : item === 'before' ? '修改前' : '修改后'}</button>)}</div><div className={'task-diff-columns ' + (mode === 'diff' ? '' : 'single')}>{mode !== 'after' && <div><strong>修改前</strong>{mode === 'diff' ? changed(left, 'before') : <pre>{limit(before)}</pre>}</div>}{mode !== 'before' && <div><strong>修改后</strong>{mode === 'diff' ? changed(right, 'after') : <pre>{limit(after)}</pre>}</div>}</div><small className="task-hashes">{image.beforeHash?.slice(0, 12) || '不存在'} → {image.afterHash?.slice(0, 12) || '不存在'}</small></details>;
}
interface Props { tasks: ProjectTasks; builds: Build[]; onOpenFile: (path: string) => void; onViewBuild: (id: string) => void; runId?: string; compact?: boolean }
export default function AgentTaskPanel({ tasks, builds, onOpenFile, onViewBuild, runId = tasks.selectedId, compact = false }: Props) {
  const detail = tasks.details[runId], run = tasks.runs.find(value => value.id === runId) || detail?.run;
  const action = (name: 'cancel' | 'resume' | 'decisions' | 'undo', body?: unknown) => tasks.action(name, body, runId);
  const sources = useMemo(() => sourcesFrom([...(detail?.tools.map(tool => tool.result) || []), ...(detail?.events.map(event => event.data) || [])]), [detail?.tools, detail?.events]);
  const pending = run?.pendingDecision;
  const canCancel = !!run && ['queued', 'running', 'waiting_confirmation', 'conflicted', 'interrupted'].includes(run.status);
  const canResume = !!run && ['interrupted', 'conflicted'].includes(run.status);
  const canUndo = !!run?.changesets.some(change => change.status === 'applied') && !['queued', 'running', 'cancelling'].includes(run.status);
  return <section className={"agent-task-panel" + (compact ? " compact" : "")} aria-label="助手操作详情">
    {tasks.error && <div className="task-error" role="alert"><AlertCircle size={13}/><span>{tasks.error}</span><button className="icon-button" aria-label="关闭任务提示" onClick={tasks.clearError}><X size={12}/></button></div>}
    {!run ? <div className="task-empty"><LoaderCircle size={18} className="spin"/><p>正在读取操作记录</p></div> : <div className="task-detail"><header className="task-state"><span className={'task-status ' + run.status}>{['running', 'queued', 'cancelling'].includes(run.status) && <LoaderCircle size={12} className="spin"/>}{statusLabels[run.status]}</span><span>{phases[run.phase] || run.phase}</span><span className={'task-live ' + (tasks.connected ? '' : 'offline')} title={tasks.connected ? '任务记录已连接' : '记录连接中断；恢复后会重新读取任务快照'}>{tasks.connected ? '记录同步中' : '正在重连'}</span></header>{run.status === 'budget_exceeded' && <p className="task-verification">此处保留该任务停止时的记录。当前不设模型调用次数或 token 上限。</p>}{!compact && <p className="task-request">{run.input}</p>}<div className="task-metadata"><span>{run.modelId}</span><span>{run.targetId}</span><span title={run.configRevision}>配置 {run.configRevision.slice(0, 8)}</span><span>{run.usage.modelCalls.toLocaleString()} 次调用 · {run.usage.estimated ? '约 ' : ''}{run.usage.tokens.toLocaleString()} tokens</span></div><div className="task-scope"><strong>修改范围</strong><span>{run.scope.readOnly ? '只读检查' : run.scope.selection ? run.scope.selection.path + ' · 仅选区' : run.scope.paths?.length ? run.scope.paths.join('、') : '当前项目内允许修改的文件'}</span></div>
      {run.children.length > 0 && <section className="task-section"><h4>角色协作</h4>{run.children.map(child => <details className="task-child" key={child.id}><summary><span>{child.name}</span><small>{child.status === 'running' ? '执行中' : child.status === 'completed' ? '已完成' : child.status === 'cancelled' ? '已停止' : '失败'}</small></summary><p>{child.task}</p>{child.result && <pre>{child.result}</pre>}{child.error && <p className="task-error">{child.error}</p>}</details>)}</section>}
      {!!detail?.tools.length && <section className="task-section"><h4>工具执行 <span>{detail?.tools.length}</span></h4>{detail?.tools.map(tool => <details className={'task-tool ' + tool.status} key={tool.id}><summary>{tool.status === 'running' ? <LoaderCircle size={12} className="spin"/> : tool.status === 'failed' ? <AlertCircle size={12}/> : <Check size={12}/>}<span>{toolLabels[tool.name] || tool.name}</span><small>{run.children.find(child => child.id === tool.agentId)?.name || (tool.agentId === 'coordinator' ? '主助手' : tool.agentId)}</small></summary><p className="task-record-label">调用参数</p><pre>{readable(tool.arguments)}</pre>{tool.result !== undefined && <><p className="task-record-label">实际返回</p><pre>{readable(tool.result)}</pre></>}{tool.error && <p className="task-error">{tool.error}</p>}</details>)}</section>}
      {!!run.changesets.length && <section className="task-section"><h4>文件修改</h4>{run.changesets.map(change => <article className="task-changeset" key={change.id}><header><strong>{change.description || '文件修改'}</strong><span>{changeLabels[change.status]}</span></header>{change.operations.map((operation, index) => <div className="task-operation" key={index}>{operation.kind === 'project' ? <span>更新编译目标配置</span> : <button onClick={() => onOpenFile(operation.kind === 'move' ? operation.to : operation.path)}><FileCode2 size={11}/>{operation.kind === 'move' ? operation.from + ' → ' + operation.to : operation.path}<small>{operation.kind === 'delete' ? '删除' : operation.kind === 'move' ? '移动' : '写入'}</small></button>}</div>)}{change.images.map(image => <TextComparison key={image.path} image={image} fallback={change.operations.find(operation => operation.kind === 'write' && operation.path === image.path && operation.content) && (change.operations.find(operation => operation.kind === 'write' && operation.path === image.path) as { content: string }).content}/>)}{change.projectBefore !== undefined && <details><summary>项目配置前后内容</summary><div className="task-diff-columns"><pre>{readable(change.projectBefore)}</pre><pre>{readable(change.projectAfter)}</pre></div></details>}{change.error && <p className="task-error">{change.error}</p>}</article>)}</section>}
      {run.buildIds.length > 0 && <section className="task-section"><h4>编译与验证</h4>{run.buildIds.map(id => { const build = builds.find(value => value.id === id); return <div className="task-build" key={id}><button onClick={() => onViewBuild(id)} title="在工作区查看此编译"><FileCode2 size={12}/>{id}<small>{build?.status === 'succeeded' ? '已生成 PDF' : build?.status === 'failed' ? '编译失败' : build?.status === 'running' ? '编译中' : '查看记录'}</small></button><a href={'/api/builds/' + encodeURIComponent(id) + '/artifacts/compile.log'} target="_blank" rel="noreferrer">日志</a></div>; })}<p className="task-verification">{run.currentSourceVerified ? '已验证当前源码版本。' : '当前源码版本尚未确认通过验证。'}{run.verifiedBuildId && ' 验证编译：' + run.verifiedBuildId}</p></section>}
      {sources.length > 0 && <section className="task-section task-sources"><h4>工具返回的来源</h4>{sources.map(url => <a href={url} key={url} target="_blank" rel="noreferrer"><Link2 size={11}/>{url}</a>)}<small>来源链接表示工具返回记录，核验结论以该工具结果为准。</small></section>}
      {!compact && run.summary && <section className="task-section task-summary"><h4>{run.outcome === 'partial' ? '部分完成' : '任务摘要'}</h4><p>{run.summary}</p></section>}{run.error && <p className="task-error" role="alert"><AlertCircle size={13}/><span>{run.status === 'budget_exceeded' && '当时停止原因：'}{run.error}</span></p>}
      {pending && <section className="task-decision" aria-label="需要决定的操作"><strong>需要你的决定</strong><p>{pending.message}</p><div><button disabled={!!tasks.busy} onClick={() => void action('decisions', { decisionId: pending.id, approve: true })}><Check size={12}/>允许此操作</button><button disabled={!!tasks.busy} onClick={() => void action('decisions', { decisionId: pending.id, approve: false })}><X size={12}/>拒绝</button></div></section>}
      <div className="task-actions">{canCancel && <button disabled={!!tasks.busy} onClick={() => void action('cancel')}><Square size={12}/>停止任务</button>}{canResume && <button disabled={!!tasks.busy} onClick={() => void action('resume')}><Play size={12}/>继续任务</button>}{canUndo && <button disabled={!!tasks.busy} onClick={() => void action('undo')}><Undo2 size={12}/>撤销本次修改</button>}{tasks.busy && <LoaderCircle size={13} className="spin"/>}</div>
      <details className="task-event-log"><summary>执行记录 · {detail?.events.length || 0}</summary>{detail?.events.map(event => <div key={event.seq}><span>{event.seq} · {event.type}</span><time>{new Date(event.createdAt).toLocaleTimeString('zh-CN')}</time><pre>{readable(event.data)}</pre></div>)}</details>
    </div>}
  </section>;
}
