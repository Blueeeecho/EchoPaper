import { useMemo, useState } from 'react';
import { AlertCircle, Check, FileCode2, Link2, LoaderCircle, Play, Square, Undo2, X } from 'lucide-react';
import type { ChangeImage, ChangeSet } from '../../shared/agent-types';
import type { Build } from '../../shared/types';
import type { ProjectTasks } from '../useProjectTasks';
import { agentDecisionDisplay, agentResultDisplay, agentUndoProgress } from '../../shared/agent-display';
import '../agent-tasks.css';

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
function TextComparison({ image, fallback, reviewing = false }: { image: ChangeImage; fallback?: string; reviewing?: boolean }) {
  const [mode, setMode] = useState<'diff' | 'before' | 'after'>('diff');
  const mime = /\.png$/i.test(image.path) ? 'image/png' : /\.jpe?g$/i.test(image.path) ? 'image/jpeg' : undefined;
  const before = decodeImage(image.beforeBase64) ?? (image.beforeHash === null ? '' : '此记录未包含修改前内容。');
  const after = decodeImage(image.afterBase64) ?? fallback ?? (image.afterHash === null ? '' : '此记录未包含修改后内容。');
  const limit = (text: string) => text.length > 150000 ? text.slice(0, 150000) + '\n…显示已截断，请打开文件查看完整内容。' : text;
  const left = before.split('\n'), right = after.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++;
  const changed = (lines: string[], side: 'before' | 'after') => <pre><span>{limit(lines.slice(0, prefix).join('\n'))}{prefix ? '\n' : ''}</span><span className={'task-diff-' + side}>{limit(lines.slice(prefix, lines.length - suffix).join('\n'))}</span><span>{suffix ? '\n' : ''}{limit(lines.slice(lines.length - suffix).join('\n'))}</span></pre>;
  if (mime) return <details className="task-file-diff" open={reviewing || undefined}><summary><FileCode2 size={12}/>{image.path}</summary><div className="task-diff-columns">{(['before', 'after'] as const).map(side => { const bytes = side === 'before' ? image.beforeBase64 : image.afterBase64; return <div key={side}><strong>{side === 'before' ? '修改前' : '修改后'}</strong>{bytes ? <img style={{ maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} src={`data:${mime};base64,${bytes}`} alt={`${image.path} ${side === 'before' ? '修改前' : '修改后'}`}/> : <p>{side === 'before' ? '新增图片' : '删除图片'}</p>}</div>; })}</div></details>;
  return <details className="task-file-diff" open={reviewing || undefined}><summary><FileCode2 size={12}/>{image.path}</summary><div className="task-diff-tabs" role="group" aria-label={'查看 ' + image.path + ' 的修改'}>{(['diff', 'before', 'after'] as const).map(item => <button key={item} aria-pressed={mode === item} onClick={() => setMode(item)}>{item === 'diff' ? '差异' : item === 'before' ? '修改前' : '修改后'}</button>)}</div><div className={'task-diff-columns ' + (mode === 'diff' ? '' : 'single')}>{mode !== 'after' && <div><strong>修改前</strong>{mode === 'diff' ? changed(left, 'before') : <pre>{limit(before)}</pre>}</div>}{mode !== 'before' && <div><strong>修改后</strong>{mode === 'diff' ? changed(right, 'after') : <pre>{limit(after)}</pre>}</div>}</div><small className="task-hashes">{image.beforeHash?.slice(0, 12) || '不存在'} → {image.afterHash?.slice(0, 12) || '不存在'}</small></details>;
}
interface Props { tasks: ProjectTasks; builds: Build[]; onOpenFile: (path: string) => void; onViewBuild: (id: string) => void; runId?: string; compact?: boolean }
export default function AgentTaskPanel({ tasks, builds, onOpenFile, onViewBuild, runId = tasks.selectedId, compact = false }: Props) {
  const detail = tasks.details[runId], listed = tasks.runs.find(value => value.id === runId);
  const run = detail && (!listed || detail.run.version > listed.version) ? detail.run : listed || detail?.run;
  const display = useMemo(() => run ? agentResultDisplay(run, builds) : undefined, [run, builds]);
  const decision = run ? agentDecisionDisplay(run) : undefined;
  const [undoRequest, setUndoRequest] = useState<{ runId: string; ids: string[]; checking: boolean; error?: string }>();
  const action = (name: 'cancel' | 'resume' | 'decisions' | 'undo', body?: unknown) => tasks.action(name, body, runId);
  const sources = useMemo(() => sourcesFrom([...(detail?.tools.map(tool => tool.result) || []), ...(detail?.events.map(event => event.data) || [])]), [detail?.tools, detail?.events]);
  const pending = run?.pendingDecision;
  const target=run?.changesets.at(-1)?.target;
  const declaredTarget=target?.kind==='files'?target.paths.join('、'):target?.kind==='selection'?target.path+' · 已核对选文':'当前项目内允许修改的文件';
  const canCancel = !!run && ['queued', 'running', 'waiting_confirmation', 'conflicted', 'interrupted'].includes(run.status);
  const canResume = !!run && ['interrupted', 'conflicted'].includes(run.status);
  const canUndo = !!run?.changesets.some(change => change.status === 'applied') && !['queued', 'running', 'cancelling', 'waiting_confirmation'].includes(run.status);
  const undoProgress = run && undoRequest?.runId === runId ? agentUndoProgress(run.changesets, undoRequest.ids, undoRequest.checking) : undefined;
  async function undoChanges(ids: string[]) {
    setUndoRequest({ runId, ids, checking: true });
    let error: string | undefined;
    try {
      await action('undo', ids.length === 1 ? { changesetId: ids[0] } : {});
    } catch (cause) { error = String((cause as Error).message); }
    // action() currently catches rejected requests. Always reread, including after
    // a partial batch failure, rather than treating promise resolution as success.
    try { await tasks.load(runId); }
    catch { error = [error, '未能刷新撤销记录，请重新读取后核对。'].filter(Boolean).join('；'); }
    setUndoRequest({ runId, ids, checking: false, error });
  }
  return <section className={'agent-task-panel' + (compact ? ' compact' : '')} aria-label="助手操作详情">
    {tasks.error && <div className="task-error" role="alert"><AlertCircle size={13}/><span>{tasks.error}</span><button className="icon-button" aria-label="关闭任务提示" onClick={tasks.clearError}><X size={12}/></button></div>}
    {!run || !display ? <div className="task-empty"><LoaderCircle size={18} className="spin"/><p>正在读取操作记录</p></div> : <div className="task-detail">
      <header className="task-state">
        <span className={'task-status tone-' + display.tone} data-result-state={run.status}>{display.active && <LoaderCircle size={12} className="spin"/>}{display.label}</span>
        <span>{display.phase}</span>
        <span className={'task-live ' + (tasks.connected ? '' : 'offline')} title={tasks.connected ? '任务记录已连接' : '记录连接中断；恢复后会重新读取任务快照'}>{tasks.connected ? '记录已连接' : '正在重连'}</span>
      </header>
      <section className="task-result-summary" aria-label="本轮实际结果">
        <h4>本轮实际结果</h4><p>{display.summary}</p>
        {run.error && ((run.continuedBy || !display.active)
          ? <details><summary>查看当时的中断原因</summary><p>以下为历史原因；当前处理方式以上方实际结果为准。</p><p>{run.error}</p></details>
          : <p className="task-result-reason">{run.error}</p>)}
      </section>
      {!compact && <p className="task-request">{run.input}</p>}
      <div className="task-scope"><strong>修改范围</strong><span>{run.scope.readOnly ? '只读检查' : run.scope.selection ? run.scope.selection.path + ' · 仅选区' : run.scope.paths?.length ? run.scope.paths.join('、') : declaredTarget}</span></div>
      {pending && decision && <section className="task-decision" aria-label="修改审阅与决定">
        <strong>{decision.title}</strong><p>{pending.message}</p>
        {decision.change && <p>请先核对下方差异；确认后才会按当前版本与范围检查应用修改。</p>}
        {decision.note && <p role="alert">{decision.note}</p>}
        <div><button disabled={!!tasks.busy || !decision.canApprove} onClick={() => void action('decisions', { decisionId: pending.id, approve: true })}><Check size={12}/>{decision.approveLabel}</button><button disabled={!!tasks.busy || run.status !== 'waiting_confirmation'} onClick={() => void action('decisions', { decisionId: pending.id, approve: false })}><X size={12}/>{decision.rejectLabel}</button></div>
      </section>}
      {!!run.changesets.length && <section className="task-section"><h4>修改与建议</h4>{run.changesets.map(change => <article className="task-changeset" key={change.id} data-changeset-state={change.status}>
        <header><strong>{change.description || '文件修改'}</strong><span>{changeLabels[change.status]}</span></header>
        {change.operations.map((operation, index) => <div className="task-operation" key={index}>{operation.kind === 'project' ? <span>更新编译目标配置</span> : <button onClick={() => onOpenFile(operation.kind === 'move' ? operation.to : operation.path)}><FileCode2 size={11}/>{operation.kind === 'move' ? operation.from + ' → ' + operation.to : operation.path}<small>{operation.kind === 'delete' ? '删除' : operation.kind === 'move' ? '移动' : '写入'}</small></button>}</div>)}
        {change.images.map(image => <TextComparison key={image.path} image={image} reviewing={pending?.changesetId === change.id && change.status === 'proposed'} fallback={change.operations.find(operation => operation.kind === 'write' && operation.path === image.path && operation.content) && (change.operations.find(operation => operation.kind === 'write' && operation.path === image.path) as { content: string }).content}/>)}
        {change.projectBefore !== undefined && <details><summary>项目配置前后内容</summary><div className="task-diff-columns"><pre>{readable(change.projectBefore)}</pre><pre>{readable(change.projectAfter)}</pre></div></details>}
        {change.error && <p className="task-error">{change.error}</p>}
        {canUndo && change.status === 'applied' && <button className="task-undo-group" disabled={!!tasks.busy || !!undoRequest?.checking} onClick={() => void undoChanges([change.id])}><Undo2 size={12}/>撤销此组修改</button>}
      </article>)}</section>}
      {run.buildIds.length > 0 && <section className="task-section"><h4>编译记录</h4>{run.buildIds.map(id => {
        const build = builds.find(value => value.id === id && value.projectId === run.projectId && value.targetId === run.targetId);
        const label = !build ? '记录待核对' : build.status === 'succeeded' ? build.stale ? '已生成 PDF · 旧版' : '已生成 PDF' : build.status === 'failed' ? '编译失败' : build.status === 'cancelled' ? '已取消' : build.status === 'running' ? '编译中' : '排队中';
        return <div className="task-build" key={id}><button onClick={() => onViewBuild(id)} title="在工作区查看此编译"><FileCode2 size={12}/>{id}<small>{label}</small></button><a href={'/api/builds/' + encodeURIComponent(id) + '/artifacts/compile.log'} target="_blank" rel="noreferrer">日志</a></div>;
      })}<p className="task-verification">{display.verification}</p></section>}
      <div className="task-actions">
        {canCancel && <button disabled={!!tasks.busy} onClick={() => void action('cancel')}><Square size={12}/>停止任务</button>}
        {canResume && <button disabled={!!tasks.busy} onClick={() => void action('resume')}><Play size={12}/>继续任务</button>}
        {canUndo && <button disabled={!!tasks.busy || !!undoRequest?.checking} onClick={() => void undoChanges(run.changesets.filter(change => change.status === 'applied').map(change => change.id))}><Undo2 size={12}/>撤销仍已应用的修改</button>}
        {(tasks.busy || undoRequest?.checking && undoRequest.runId === runId) && <LoaderCircle size={13} className="spin"/>}
      </div>
      {undoProgress && <p className={'task-undo-result ' + (undoProgress.complete ? 'confirmed' : '')} role="status">{undoProgress.text}{undoRequest?.error && ' ' + undoRequest.error}</p>}
      <details className="task-execution-details"><summary>执行细节 · {detail?.tools.length || 0} 次工具调用</summary>
        <div className="task-metadata"><span>{run.modelId}</span><span>{run.targetId}</span><span title={run.configRevision}>配置 {run.configRevision.slice(0, 8)}</span><span>{run.usage.modelCalls.toLocaleString()} 次模型调用 · {run.usage.estimated ? '约 ' : ''}{run.usage.tokens.toLocaleString()} tokens</span></div>
        {(run.summary || run.reply) && <details className="task-original-summary"><summary>查看当时的任务摘要与回复</summary><p>以下保留执行当时的文字；当前保存、撤销和编译状态以面板上方记录为准。</p><pre>{[run.summary, run.reply !== run.summary ? run.reply : ''].filter(Boolean).join('\n\n')}</pre></details>}
        {run.children.length > 0 && <section className="task-section"><h4>角色协作</h4>{run.children.map(child => <details className="task-child" key={child.id}><summary><span>{child.name}</span><small>{child.status === 'queued' ? '排队中' : child.status === 'running' ? '执行中' : child.status === 'completed' ? '已返回结果' : child.status === 'cancelled' ? '已停止' : '失败'}</small></summary><p>{child.task}</p><small>{child.requestModel || '模型未记录'} · {child.reviewStatus === 'accepted' ? '主助手已核对' : child.reviewStatus === 'stale' ? '基于旧稿' : child.reviewStatus === 'needs_acceptance' ? '待主助手验收' : '未验收'}</small>{child.result && <pre>{child.result}</pre>}{child.error && <p className="task-error">{child.error}</p>}</details>)}</section>}
        {!!detail?.tools.length && <section className="task-section"><h4>工具记录</h4>{detail.tools.map(tool => <details className={'task-tool ' + tool.status} key={tool.id}><summary>{tool.status === 'running' ? <LoaderCircle size={12} className="spin"/> : tool.status === 'failed' ? <AlertCircle size={12}/> : <Check size={12}/>}<span>{toolLabels[tool.name] || tool.name}</span><small>{run.children.find(child => child.id === tool.agentId)?.name || (tool.agentId === 'coordinator' ? '主助手' : tool.agentId)}</small></summary><p className="task-record-label">调用参数</p><pre>{readable(tool.arguments)}</pre>{tool.result !== undefined && <><p className="task-record-label">实际返回</p><pre>{readable(tool.result)}</pre></>}{tool.error && <p className="task-error">{tool.error}</p>}</details>)}</section>}
        {sources.length > 0 && <section className="task-section task-sources"><h4>工具返回的来源</h4>{sources.map(url => <a href={url} key={url} target="_blank" rel="noreferrer"><Link2 size={11}/>{url}</a>)}<small>来源链接表示工具返回记录，核验结论以该工具结果为准。</small></section>}
        <details className="task-event-log"><summary>执行记录 · {detail?.events.length || 0}</summary>{detail?.events.map(event => <div key={event.seq}><span>{event.seq} · {event.type}</span><time>{new Date(event.createdAt).toLocaleTimeString('zh-CN')}</time><pre>{readable(event.data)}</pre></div>)}</details>
      </details>
    </div>}
  </section>;
}
