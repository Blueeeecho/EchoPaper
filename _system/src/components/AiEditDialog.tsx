import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, Sparkles, Square, X } from 'lucide-react';
import { api, downloadText } from '../api';
import { streamAiReply, type AiReply } from '../aiStream';
import { applyAcceptedChanges, reviewChanges, type EditSelection } from '../editReview';
import '../writing-tools.css';
import { clearWritingDraft, completeSuggestion, readWritingDraft, sameSelection, storeWritingDraft } from '../writingDraft';
const showChange = (value: string, empty: string) => value || empty;
interface Config { assistant?: { modelIds: string[] }; configured: boolean; defaultModel: string|null; models: {id: string; label: string;configured:boolean;efforts:string[]}[] }
export default function AiEditDialog({ selection, baselineValid = true, onClose, onApply }: { baselineValid?: boolean; selection: EditSelection; onClose: () => void; onApply: (selection: EditSelection, replacement: string) => Promise<void> }) {
  const [restored] = useState(() => {
    const saved = readWritingDraft(sessionStorage, selection.projectId);
    return saved && sameSelection(saved.selection, selection) ? saved : undefined;
  });
  const dialog = useRef<HTMLElement>(null);
  const requirement = useRef<HTMLTextAreaElement>(null);
  const applyingRef = useRef(false);
  const closeAction = useRef(onClose);
  closeAction.current = onClose;
  const [draftWarning, setDraftWarning] = useState(restored && restored.reviewVersion !== 2 ? '建议已按语句重新分组，请重新选择要接受的修改。' : '');
  const [config, setConfig] = useState<Config>();
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('medium');
  const [instruction, setInstruction] = useState(restored?.instruction || '');
  const [reply, setReply] = useState(restored?.reply || ''), [result, setResult] = useState<AiReply | undefined>(restored?.result);
  const [accepted, setAccepted] = useState<Set<number>>(new Set(restored?.accepted || []));
  const [busy, setBusy] = useState(false), [applying, setApplying] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => { let active = true; api<Config>('/api/ai/config').then(data => { if (active) { setConfig(data); setModel(data.defaultModel||''); } }).catch(e => { if (active) setError(e.message); }); return () => { active = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    requirement.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        if (!applyingRef.current) { controller.current?.abort(); closeAction.current(); }
      }
      if (event.key === 'Tab') {
        const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), select:not(:disabled), input:not(:disabled), summary, [tabindex="0"]') || []).filter(item => item.getClientRects().length);
        const first = items[0], last = items[items.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (before?.isConnected) before.focus(); };
  }, []);
  useEffect(() => {
    const saved = storeWritingDraft(sessionStorage, { selection, instruction, reply, result, accepted: [...accepted] });
    if (!saved) setDraftWarning('当前浏览器无法保存建议草稿，请下载建议后再关闭。');
  }, [selection, instruction, reply, result, accepted]);
  const allowedModels = (config?.models || []).filter(item => !config?.assistant || config.assistant.modelIds.includes(item.id));
  const activeModel=allowedModels.find(m=>m.id===model),efforts=activeModel?.efforts||[];
  useEffect(()=>{if(efforts.length&&!efforts.includes(effort))setEffort(efforts.includes('medium')?'medium':efforts[0]);},[model,config]);
  const changes = useMemo(() => result ? reviewChanges(selection.text, reply) : [], [selection.text, reply, result]);
  const combined = useMemo(() => applyAcceptedChanges(selection.text, reply, changes, accepted), [selection.text, reply, changes, accepted]);
  function changeInstruction(value: string) {
    setInstruction(value);
    setResult(undefined);
    setAccepted(new Set());
  }
  async function generate() {
    if(controller.current || !baselineValid) return;
    if(!activeModel?.configured){setError('请先选择助手白名单中已配置的润色模型。');return;}
    setBusy(true); setError(''); setReply(''); setResult(undefined); setAccepted(new Set());
    const abort = new AbortController(); controller.current = abort;
    try {
      const output = await streamAiReply({ projectId: selection.projectId, model, effort, messages: [{ role: 'user', content: `你正在提出可供作者审阅的局部修改。任务：${instruction}\n仅返回选中内容的完整替换文本，不要解释，不要 Markdown 围栏，不要添写未提供的实验结果、作者信息或文献。保持未要求改动的 LaTeX 结构。\n文件：${selection.path}\n<selected_text>\n${selection.text}\n</selected_text>` }] }, abort.signal, setReply);
      if (abort.signal.aborted) throw new Error('已停止生成。');
      const completed = completeSuggestion(output);
      const clean = completed.text;
      setReply(clean); setResult(completed);
      setAccepted(new Set(reviewChanges(selection.text, clean).map((_, i) => i)));
    } catch (e: any) { setError(abort.signal.aborted ? '已停止，当前未完成的建议不会应用。' : e.message); }
    finally { setBusy(false); controller.current = undefined; }
  }
  return <div className="modal-backdrop"><section ref={dialog} className="writing-dialog" role="dialog" aria-modal="true" aria-label="AI 修改差异审阅"><header><div><h2>AI 修改差异审阅</h2><p>{selection.path} · 第 {selection.documentText.slice(0,selection.from).split('\n').length}–{selection.documentText.slice(0,selection.to).split('\n').length} 行 · {selection.text.length} 字符。单次生成建议，逐处接受后保存版本并应用。</p></div><button className="icon-button" disabled={applying} onClick={() => { controller.current?.abort(); onClose(); }} aria-label="关闭 AI 修改审阅"><X size={18}/></button></header><div className="edit-presets" aria-label="修改预设"><button disabled={busy || applying} onClick={() => changeInstruction('仅调整格式、空格和缩进，保留全部措辞、事实、公式与引用键。')}>仅格式</button><button disabled={busy || applying} onClick={() => changeInstruction('改善所选段落的表达与衔接，保留事实、数值、公式、引用键及 LaTeX 结构。')}>表达润色</button><span>仅所选源码 · 单次建议 · 接受后应用</span></div>{!baselineValid && <p className="tools-error" role="alert">当前源码已变化。此建议仍可查看和下载，请重新选择源码后生成。</p>}{draftWarning && <p className="tools-warning" role="status">{draftWarning}</p>}<div className="edit-instructions"><textarea ref={requirement} placeholder="填写具体要求，例如仅统一空格，或改善这一段的表达" aria-label="AI 修改要求" value={instruction} onChange={e => changeInstruction(e.target.value)} disabled={busy || applying}/><div><select aria-label="润色模型" value={model} disabled={busy || applying} onChange={e => setModel(e.target.value)}><option value="">请选择助手模型</option>{allowedModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select><select aria-label="润色推理强度" value={effort} disabled={busy || applying || !efforts.length} onChange={e => setEffort(e.target.value)}>{efforts.length?efforts.map(value=><option key={value} value={value}>{({low:'快速',medium:'均衡',high:'深入',xhigh:'更深入',max:'最高'} as Record<string,string>)[value]||value}</option>):<option value={effort}>模型默认</option>}</select>{busy ? <button className="button" onClick={() => controller.current?.abort()}><Square size={12}/>停止</button> : <button className="button primary" disabled={!baselineValid || !activeModel?.configured || !instruction.trim() || applying} onClick={generate}><Sparkles size={14}/>生成建议</button>}</div></div>{error && <p className="tools-error" role="alert">{error}</p>}<div className="edit-review-body">{!result ? <div className="edit-columns"><section><h3>原文</h3><pre>{selection.text}</pre></section><section><h3>{busy ? '正在生成…' : '修改建议'}</h3><pre>{reply || '生成后可逐条选择接受哪些修改。'}</pre></section></div> : <><div className="edit-review-controls"><strong>{changes.length ? `${changes.length} 组修改，已选 ${accepted.size} 组` : '未发现文字变化'}</strong><button onClick={() => setAccepted(new Set(changes.map((_,i)=>i)))}>全选</button><button onClick={() => setAccepted(new Set())}>全部保留原文</button></div>{changes.map((c,i) => <label className={`edit-change ${accepted.has(i) ? 'accepted' : ''}`} key={i}><input type="checkbox" checked={accepted.has(i)} disabled={applying} onChange={e => setAccepted(old=>{const next=new Set(old);e.target.checked?next.add(i):next.delete(i);return next;})}/><div><span>修改 {i+1}</span><small>原文</small><del>{showChange(selection.text.slice(c.fromA,c.toA),'（新增）')}</del><small>改写后</small><ins>{showChange(reply.slice(c.fromB,c.toB),'（删除）')}</ins></div></label>)}<details><summary>应用后完整选区预览</summary><pre>{combined}</pre></details></>}</div><footer><button className="button" disabled={!reply} onClick={() => downloadText('AI修改建议.txt',reply)}><Copy size={13}/>保存建议</button><span>{result?.usage ? `输入 ${result.usage.prompt_tokens} · 输出 ${result.usage.completion_tokens} tokens` : 'AI 建议需要作者核对'}</span><button className="button primary" disabled={!baselineValid || !result || !accepted.size || applying || busy || combined === selection.text} onClick={async () => { if (applyingRef.current) return; applyingRef.current = true; setApplying(true); setError(''); try { await onApply(selection, combined); clearWritingDraft(sessionStorage, selection.projectId); onClose(); } catch (e:any) { setError(e.message); } finally { applyingRef.current = false; setApplying(false); } }}>{applying ? <LoaderCircle size={13} className="spin"/> : <Check size={13}/>}接受所选修改</button></footer></section></div>;
}
