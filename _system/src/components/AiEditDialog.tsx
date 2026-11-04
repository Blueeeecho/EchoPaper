import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, Sparkles, Square, X } from 'lucide-react';
import { api, downloadText } from '../api';
import { streamAiReply, type AiReply } from '../aiStream';
import { applyAcceptedChanges, reviewChanges, type EditSelection } from '../editReview';
import '../writing-tools.css';
const showChange=(value:string,empty:string)=>value?value.replace(/\n/g,'↵\n').replace(/\t/g,'⇥').replace(/^ +$/gm,s=>'·'.repeat(s.length)):empty;
interface Config { configured: boolean; defaultModel: string|null; models: {id: string; label: string;configured:boolean;efforts:string[]}[] }
export default function AiEditDialog({ selection, onClose, onApply }: { selection: EditSelection; onClose: () => void; onApply: (selection: EditSelection, replacement: string) => Promise<void> }) {
  const [config, setConfig] = useState<Config>();
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('medium');
  const [instruction, setInstruction] = useState('学术润色：改善逻辑衔接、清晰度和英文表达，保留原有事实、数值、引用键、公式和 LaTeX 命令。');
  const [reply, setReply] = useState(''), [result, setResult] = useState<AiReply>();
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false), [applying, setApplying] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => { let active = true; api<Config>('/api/ai/config').then(data => { if (active) { setConfig(data); setModel(data.defaultModel||''); } }).catch(e => { if (active) setError(e.message); }); return () => { active = false; controller.current?.abort(); }; }, []);
  const activeModel=config?.models.find(m=>m.id===model),efforts=activeModel?.efforts||[];
  useEffect(()=>{if(efforts.length&&!efforts.includes(effort))setEffort(efforts.includes('medium')?'medium':efforts[0]);},[model,config]);
  const changes = useMemo(() => result ? reviewChanges(selection.text, reply) : [], [selection.text, reply, result]);
  const combined = useMemo(() => applyAcceptedChanges(selection.text, reply, changes, accepted), [selection.text, reply, changes, accepted]);
  async function generate() {
    if(!activeModel?.configured){setError('请先选择助手白名单中已配置的润色模型。');return;}
    setBusy(true); setError(''); setReply(''); setResult(undefined); setAccepted(new Set());
    const abort = new AbortController(); controller.current = abort;
    try {
      const output = await streamAiReply({ projectId: selection.projectId, model, effort, messages: [{ role: 'user', content: `你正在提出可供作者审阅的局部修改。任务：${instruction}\n仅返回选中内容的完整替换文本，不要解释，不要 Markdown 围栏，不要添写未提供的实验结果、作者信息或文献。保持未要求改动的 LaTeX 结构。\n文件：${selection.path}\n<selected_text>\n${selection.text}\n</selected_text>` }] }, abort.signal, setReply);
      if (output.finishReason === 'length') throw new Error('建议因输出长度被截断，禁止应用，请缩小选区后重试。');
      if (output.finishReason !== 'stop') throw new Error('模型没有明确正常结束，已保留输出但禁止应用，请重试。');
      const clean = output.text.replace(/^```(?:latex|tex|text)?\s*\n([\s\S]*?)\n```\s*$/i, '$1');
      if (!clean.trim()) throw new Error('AI 没有返回可用替换内容。');
      setReply(clean); setResult({ ...output, text: clean });
      setAccepted(new Set(reviewChanges(selection.text, clean).map((_, i) => i)));
    } catch (e: any) { setError(abort.signal.aborted ? '已停止，当前未完成的建议不会应用。' : e.message); }
    finally { setBusy(false); controller.current = undefined; }
  }
  return <div className="modal-backdrop"><section className="writing-dialog" role="dialog" aria-modal="true" aria-label="AI 修改差异审阅"><header><div><h2>AI 修改差异审阅</h2><p>{selection.path} · 仅发送所选 {selection.text.length} 个字符；接受后先保存版本再应用。</p></div><button className="icon-button" disabled={applying} onClick={onClose} aria-label="关闭 AI 修改审阅"><X size={18}/></button></header><div className="edit-instructions"><textarea aria-label="AI 修改要求" value={instruction} onChange={e => setInstruction(e.target.value)} disabled={busy || applying}/><div><select aria-label="润色模型" value={model} disabled={busy || applying} onChange={e => setModel(e.target.value)}><option value="">请选择助手模型</option>{(config?.models || []).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select><select aria-label="润色推理强度" value={effort} disabled={busy || applying || !efforts.length} onChange={e => setEffort(e.target.value)}>{efforts.length?efforts.map(value=><option key={value} value={value}>{({low:'快速',medium:'均衡',high:'深入',xhigh:'更深入',max:'最高'} as Record<string,string>)[value]||value}</option>):<option value={effort}>模型默认</option>}</select>{busy ? <button className="button" onClick={() => controller.current?.abort()}><Square size={12}/>停止</button> : <button className="button primary" disabled={!activeModel?.configured || !instruction.trim() || applying} onClick={generate}><Sparkles size={14}/>生成建议</button>}</div></div>{error && <p className="tools-error" role="alert">{error}</p>}<div className="edit-review-body">{!result ? <div className="edit-columns"><section><h3>原文</h3><pre>{selection.text}</pre></section><section><h3>{busy ? '正在生成…' : '修改建议'}</h3><pre>{reply || '生成后可逐条选择接受哪些修改。'}</pre></section></div> : <><div className="edit-review-controls"><strong>{changes.length ? `${changes.length} 处变化，已选 ${accepted.size} 处` : '未发现文字变化'}</strong><button onClick={() => setAccepted(new Set(changes.map((_,i)=>i)))}>全选</button><button onClick={() => setAccepted(new Set())}>全部保留原文</button></div>{changes.map((c,i) => <label className={`edit-change ${accepted.has(i) ? 'accepted' : ''}`} key={i}><input type="checkbox" checked={accepted.has(i)} disabled={applying} onChange={e => setAccepted(old=>{const next=new Set(old);e.target.checked?next.add(i):next.delete(i);return next;})}/><div><span>修改 {i+1}</span><del>{showChange(selection.text.slice(c.fromA,c.toA),'（新增）')}</del><ins>{showChange(reply.slice(c.fromB,c.toB),'（删除）')}</ins></div></label>)}<details><summary>应用后完整选区预览</summary><pre>{combined}</pre></details></>}</div><footer><button className="button" disabled={!reply} onClick={() => downloadText('AI修改建议.txt',reply)}><Copy size={13}/>保存建议</button><span>{result?.usage ? `输入 ${result.usage.prompt_tokens} · 输出 ${result.usage.completion_tokens} tokens` : 'AI 建议需要作者核对'}</span><button className="button primary" disabled={!result || !accepted.size || applying || busy || combined === selection.text} onClick={async () => { setApplying(true); setError(''); try { await onApply(selection, combined); onClose(); } catch (e:any) { setError(e.message); } finally { setApplying(false); } }}>{applying ? <LoaderCircle size={13} className="spin"/> : <Check size={13}/>}接受所选修改</button></footer></section></div>;
}
