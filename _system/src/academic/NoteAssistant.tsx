import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Download, LoaderCircle, Sparkles, Undo2, X } from 'lucide-react';
import type { PublicModel } from '../../shared/model-providers';
import { api, downloadText, json } from '../api';
import AiMarkdown from '../components/AiMarkdown';
import './note-assistant.css';
type Selection = {
    before: string;
    from: number;
    to: number;
};
type Proposal = Selection & {
    text: string;
    model: string;
};
export interface NoteTextSelection {selectionStart:number;selectionEnd:number}
const actions = [
    ['整理格式', '整理 Markdown 格式，调整标题层级、段落、列表和表格，保留全部内容与原有顺序。'],
    ['润色表达', '调整表达，使文字清晰、通顺、准确，保留原意、全部事实和证据状态。'],
    ['精简文字', '精简重复与冗余表达，保留事实、关键细节、逻辑关系和证据状态。'],
] as const;
export default function NoteAssistant({ value, onChange, editorRef, disabled = false, maxLength = 100000, label = '当前笔记' }: {
    value: string;
    onChange: (value: string) => void;
    editorRef: RefObject<NoteTextSelection | null>;
    disabled?: boolean;
    maxLength?: number;
    label?: string;
}) {
    const id = useId();
    const [open, setOpen] = useState(false);
    const [models, setModels] = useState<PublicModel[]>([]);
    const [model, setModel] = useState('');
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [instruction, setInstruction] = useState<string>(actions[0][1]);
    const [selection, setSelection] = useState<Selection>();
    const [scope, setScope] = useState<'document' | 'selection'>('document');
    const [proposal, setProposal] = useState<Proposal>();
    const [undo, setUndo] = useState<{
        before: string;
        after: string;
    }>();
    const [source, setSource] = useState(false);
    const current = useRef(value);
    const controller = useRef<AbortController | undefined>(undefined);
    const sequence = useRef(0);
    current.current = value;
    useEffect(() => () => { sequence.current++; controller.current?.abort(); }, []);
    useEffect(() => {
        if (!open) {
            return;
        }
        const abort = new AbortController();
        setLoading(true);
        setError('');
        void api<{
            models: PublicModel[];
            defaultModel: string | null;
        }>('/api/ai/config', { signal: abort.signal }).then(config => {
            if (abort.signal.aborted) {
                return;
            }
            setModels(config.models);
            setModel(previous => config.models.some(item => item.id === previous) ? previous : config.defaultModel || config.models.find(item => item.configured)?.id || '');
        }).catch(error => {
            if (!abort.signal.aborted) setError(error.message);
        }).finally(() => {
            if (!abort.signal.aborted) setLoading(false);
        });
        return () => abort.abort();
    }, [open]);
    function toggle() {
        if (open) {
            sequence.current++;
            controller.current?.abort();
            setBusy(false);
            setOpen(false);
            return;
        }
        const editor = editorRef.current;
        const from = editor?.selectionStart ?? 0;
        const to = editor?.selectionEnd ?? 0;
        const selected = to > from ? { before: value, from, to } : undefined;
        setSelection(selected);
        setScope(selected ? 'selection' : 'document');
        setOpen(true);
    }
    async function generate() {
        if (busy || disabled || !model || !instruction.trim() || !value.trim()) {
            return;
        }
        if (scope === 'selection' && (!selection || selection.before !== current.current)) {
            setError('选区内容已有变化，请收起助手后重新选择，或改为整理全文。');
            return;
        }
        const snapshot: Selection = scope === 'selection' ? selection! : { before: current.current, from: 0, to: current.current.length };
        const request = ++sequence.current;
        const abort = new AbortController();
        controller.current = abort;
        setBusy(true);
        setError('');
        setProposal(undefined);
        try {
            const result = await api<{
                text: string;
                model: string;
            }>('/api/ai/edit-note', { ...json('POST', { content: snapshot.before, instruction, model, ...(scope === 'selection' ? { selection: { from: snapshot.from, to: snapshot.to } } : {}) }), signal: abort.signal });
            if (request === sequence.current && !abort.signal.aborted) {
                setProposal({ ...snapshot, ...result });
            }
        }
        catch (error: any) {
            if (request === sequence.current && !abort.signal.aborted) {
                setError(error.message);
            }
        }
        finally {
            if (request === sequence.current) {
                setBusy(false);
                controller.current = undefined;
            }
        }
    }
    const changed = !!proposal && proposal.before !== value;
    const replacement = proposal ? proposal.before.slice(0, proposal.from) + proposal.text + proposal.before.slice(proposal.to) : '';
    const tooLong = !!proposal && replacement.length > maxLength;
    const canUndo = !!undo && value === undo.after;
    function apply() {
        if (!proposal || disabled || busy || current.current !== proposal.before || replacement.length > maxLength) {
            return;
        }
        setUndo({ before: proposal.before, after: replacement });
        onChange(replacement);
        setProposal(undefined);
        setError('');
    }
    return <div className="note-assistant" onClick={event => event.stopPropagation()}>
        <div className="note-assistant-bar">
            <button type="button" className="note-assistant-trigger" aria-expanded={open} aria-controls={id} disabled={disabled} onClick={toggle}>
                <Sparkles size={13}/>AI 助手
            </button>
            {canUndo && <button type="button" disabled={disabled || busy} onClick={() => {
                if (undo && current.current === undo.after) {
                    onChange(undo.before);
                    setUndo(undefined);
                }
            }}><Undo2 size={12}/>撤销 AI 修改</button>}
        </div>
        {open && <section id={id} className="note-assistant-panel" aria-label={`${label} AI 助手`} onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Escape') {
                event.preventDefault();
                toggle();
            }
        }}>
            <header>
                <strong>{label}</strong>
                <button type="button" aria-label="收起 AI 助手" onClick={toggle}><X size={14}/></button>
            </header>
            <div className="note-assistant-options">
                <div>
                    <span>模型</span>
                    <select aria-label="笔记助手模型" value={model} disabled={busy || loading} onChange={event => setModel(event.target.value)}>
                        <option value="">{loading ? '正在读取模型…' : '选择助手模型'}</option>
                        {models.map(item => <option key={item.id} value={item.id} disabled={!item.configured}>
                            {item.providerLabel} · {item.label}{!item.configured ? '（未配置）' : ''}
                        </option>)}
                    </select>
                </div>
                <div>
                    <span>修改范围</span>
                    <select aria-label="笔记修改范围" value={scope} disabled={busy} onChange={event => setScope(event.target.value as typeof scope)}>
                        <option value="document">全文</option>
                        {selection && <option value="selection">选中内容 · {selection.to - selection.from} 字符</option>}
                    </select>
                </div>
            </div>
            {!loading && !models.length && <p className="note-assistant-status">请在“设置与模型”中启用助手模型。</p>}
            <div className="note-assistant-presets">
                {actions.map(([title, prompt]) => <button type="button" key={title} aria-pressed={instruction === prompt} disabled={busy} onClick={() => setInstruction(prompt)}>{title}</button>)}
            </div>
            <textarea aria-label="笔记修改要求" rows={2} maxLength={2000} value={instruction} disabled={busy} onChange={event => setInstruction(event.target.value)} placeholder="说明希望怎样整理格式或调整表达…"/>
            <div className="note-assistant-controls">
                {busy ? <button type="button" onClick={() => {
                    sequence.current++;
                    controller.current?.abort();
                    setBusy(false);
                    setError('生成已停止，可修改要求后重试。');
                }}>停止生成</button> : <button type="button" className="note-assistant-primary" disabled={disabled || loading || !models.some(item => item.id === model && item.configured) || !value.trim() || !instruction.trim()} onClick={() => void generate()}>生成修改建议</button>}
                {busy && <span role="status"><LoaderCircle size={13} className="spin"/>正在整理…</span>}
            </div>
            {error && <p className="note-assistant-error" role="alert">{error}</p>}
            {proposal && <div className="note-assistant-result">
                <div className="note-assistant-result-bar">
                    <strong>修改建议</strong><small>{proposal.model}</small>
                    <button type="button" onClick={() => setSource(!source)}>{source ? '查看排版' : '查看 Markdown'}</button>
                </div>
                <details>
                    <summary>查看原文</summary><pre>{proposal.before.slice(proposal.from, proposal.to)}</pre>
                </details>
                <div className="note-assistant-preview research-note-markdown">
                    {source ? <pre>{proposal.text}</pre> : <AiMarkdown text={proposal.text}/>}
                </div>
                {changed && <p className="note-assistant-error" role="alert">笔记已继续编辑，请重新生成建议。当前建议可下载保留。</p>}
                {tooLong && <p className="note-assistant-error" role="alert">应用后超过本字段的 {maxLength.toLocaleString()} 字符限制，请缩小修改范围。</p>}
                <div className="note-assistant-controls">
                    <button type="button" onClick={() => downloadText('note-suggestion.md', proposal.text)}><Download size={13}/>下载建议</button>
                    <button type="button" className="note-assistant-primary" disabled={disabled || busy || changed || tooLong} onClick={apply}>
                        {proposal.from === 0 && proposal.to === proposal.before.length ? '应用到全文' : '替换选中内容'}
                    </button>
                </div>
            </div>}
        </section>}
    </div>;
}
