import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Archive, ArchiveRestore, Check, ChevronDown, Copy, FileText, History, Info, ListChecks, LoaderCircle, Settings2, Plus, Paperclip, RefreshCw, RotateCcw, SendHorizontal, Sparkles, Square, Trash2, X } from 'lucide-react';
import { api, downloadText, json } from '../api';
import { useProjectChats } from '../useProjectChats';
import { conversationState, ensureActiveChat, type ChatLifecycle, type ConversationState, type PersistedChat } from '../../shared/chat-merge';
import { chatMessages, contextMeter, resolveContext, type ContextCheckpoint, type ContextUsage } from '../../shared/ai-context';
import { conversationHead, createAgentConversation, reconcileAgentConversation, runHasOperations, runIsActive } from '../agentConversation';
import AiMarkdown from './AiMarkdown';
import 'katex/dist/katex.min.css';
import '../ai-chat.css';
import { MODEL_CONFIG_EVENT, openModelSettings } from '../modelSettings';
import type { AgentCreateInput, AgentRun, AssistantSettings } from '../../shared/agent-types';
import type { Build } from '../../shared/types';
import type { ProjectTasks } from '../useProjectTasks';
import AgentTaskPanel from './AgentTaskPanel';
import type {AgentAttachment} from '../../shared/attachment-types';
import {ATTACHMENT_ACCEPT,MAX_MESSAGE_ATTACHMENTS,attachmentFileError,attachmentPrompt,imageAttachment,uniqueAttachments,type PendingAttachmentUpload} from '../aiAttachments';
import {AttachmentPreviewDialog,ComposerAttachments,MessageAttachments,type AttachmentPreview} from './AiAttachments';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
interface AiConfig { revision: string; assistant?: AssistantSettings; configured: boolean; provider: string; plan: string; defaultModel: string | null; models: { id: string; label: string; contextWindow: number; providerLabel?: string; plan?: string; configured?: boolean; efforts?: string[] }[]; credentialStore: 'macOS Keychain' }
interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number }
interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; reasoning_content?: string; model?: string; usage?: Usage; finishReason?: string; status: 'complete' | 'streaming' | 'stopped' | 'error'; error?: string; providerLabel?: string; contextPath?: string; taskId?: string; attachment?: { path: string; content: string }; attachments?:AgentAttachment[]; createdAt: string }
interface Conversation { id: string; title: string; createdAt: string; updatedAt: string; messages: ChatMessage[]; input: string; model: string; effort: Effort; pendingAttachments?:AgentAttachment[]; contextState?: ContextCheckpoint; contextUsage?: ContextUsage; lifecycle?: ChatLifecycle }
interface StoredChat { version: 1; selectedId: string; conversations: Conversation[] }
interface ConversationUi { includeContext: boolean; starting: boolean; taskScope: 'project' | 'file' | 'readOnly'; phase: string; error: string }
const freshUi = (): ConversationUi => ({ includeContext: false, starting: false, taskScope: 'project', phase: '', error: '' });
export type TaskStartInput = Omit<AgentCreateInput, 'requestId' | 'targetId' | 'history' | 'compactionId' | 'expectedLastRunId'> & { requestId?: string; expectedLastRunId?: string | null };
export type AssistantSend = (input: TaskStartInput) => Promise<void>;
interface Props { projectId: string; currentPath: string; currentContent: string; tasks: ProjectTasks; builds: Build[]; onStartTask: (input: TaskStartInput) => Promise<AgentRun>; onOpenFile: (path: string) => void; onViewBuild: (id: string) => void; onClose: () => void; onFlushReady?: (flush: (() => Promise<void>) | undefined) => void; onSendReady?: (send: AssistantSend | undefined) => void }
const DEFAULT_MODEL = '';
const EFFORTS: { id: Effort; label: string }[] = [{ id: 'low', label: '快速' }, { id: 'medium', label: '均衡' }, { id: 'high', label: '深入' }, { id: 'xhigh', label: '更深入' }, { id: 'max', label: '最高' }];
const storageKey = (projectId: string) => `echopaper:ai:${projectId}:v1`;
const newConversation = (model = DEFAULT_MODEL, effort: Effort = 'medium'): Conversation => createAgentConversation(model, effort) as Conversation;
const selectionKey = (projectId: string) => `echopaper:ai-selection:${projectId}`;
function restore(projectId: string): StoredChat {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey(projectId)) || 'null') as StoredChat | null;
    if (stored?.version === 1 && Array.isArray(stored.conversations) && stored.conversations.length) {
      const conversations = stored.conversations.filter(item => typeof item.id === 'string' && Array.isArray(item.messages)).map(item => ({ ...item, input: typeof item.input === 'string' ? item.input : '', model: item.model || DEFAULT_MODEL, effort: EFFORTS.some(e => e.id === item.effort) ? item.effort : 'medium' as Effort, messages: item.messages.filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map(message => message.status === 'streaming' && !message.taskId ? { ...message, status: 'stopped' as const } : message) }));
      if (conversations.length) return ensureActiveChat({ version: 1, conversations, selectedId: conversations.some(c => c.id === stored.selectedId) ? stored.selectedId : conversations[0].id }) as StoredChat;
    }
  } catch { /* Keep a malformed browser draft from blocking the workspace. */ }
  const first = newConversation(); return { version: 1, selectedId: first.id, conversations: [first] };
}
async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); }
  catch { const element = document.createElement('textarea'); element.value = text; element.style.position = 'fixed'; element.style.opacity = '0'; document.body.appendChild(element); element.select(); const copied = document.execCommand('copy'); element.remove(); if (!copied) throw new Error('无法复制，请选中文字后手动复制。'); }
}

export default function AiPanel({ projectId, currentPath, currentContent, tasks, builds, onStartTask, onOpenFile, onViewBuild, onClose, onFlushReady, onSendReady }: Props) {
  const [stored, setStored] = useState<StoredChat>(() => restore(projectId));
  const storedRef = useRef(stored);
  const openedWithHistory = useRef(!!localStorage.getItem(storageKey(projectId)));
  const [config, setConfig] = useState<AiConfig>();
  const [configLoading, setConfigLoading] = useState(true), [configError, setConfigError] = useState('');
  const [storageWarning, setStorageWarning] = useState(''), [modelSaving, setModelSaving] = useState(false);
  const [conversationUi, setConversationUi] = useState<Record<string, ConversationUi>>({});
  const uiRef = useRef(conversationUi);
  const [initialSelection] = useState(() => { try { return sessionStorage.getItem(selectionKey(projectId)) || undefined; } catch { return undefined; } });
  const preferredSelection = useRef<string | undefined>(initialSelection);
  const [copiedId, setCopiedId] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false), [contextOpen, setContextOpen] = useState(false), [recordsOpen, setRecordsOpen] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<ConversationState>('active'), [historyNotice, setHistoryNotice] = useState(''), [historyError, setHistoryError] = useState('');
  const mounted = useRef(true), composing = useRef(false), sending = useRef(new Set<string>());
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const messageArea = useRef<HTMLDivElement>(null), shouldFollow = useRef(true);
  const acceptedRuns = useRef(new Map<string, AgentRun>());
  const [uploads,setUploads]=useState<Record<string,PendingAttachmentUpload[]>>({}),uploadsRef=useRef<Record<string,PendingAttachmentUpload[]>>({}),uploadControllers=useRef(new Map<string,AbortController>()),fileInput=useRef<HTMLInputElement>(null),dragDepth=useRef(0);
  const [dragging,setDragging]=useState(false),[preview,setPreview]=useState<AttachmentPreview>();
  const conversation = stored.conversations.find(item => item.id === stored.selectedId) || stored.conversations[0];
  const { includeContext, starting, taskScope, phase, error } = conversationUi[conversation.id] || freshUi();
  function updateUi(id: string, patch: Partial<ConversationUi>) { const next = { ...uiRef.current, [id]: { ...(uiRef.current[id] || freshUi()), ...patch } }; uiRef.current = next; if (mounted.current) setConversationUi(next); }
  const setError = (error: string, id = storedRef.current.selectedId) => updateUi(id, { error });
  const setStarting = (starting: boolean, id: string) => updateUi(id, { starting });
  const setPhase = (phase: string, id: string) => updateUi(id, { phase });
  const setIncludeContext = (includeContext: boolean) => updateUi(storedRef.current.selectedId, { includeContext });
  const setTaskScope = (taskScope: ConversationUi['taskScope']) => updateUi(storedRef.current.selectedId, { taskScope });
  const selectedModel = config?.models.find(model => model.id === conversation.model);
  const allowedEfforts = selectedModel?.efforts || [], supportsEffort = allowedEfforts.length > 0;
  const isConfigured = !!selectedModel && (selectedModel.configured ?? config?.configured ?? false);
  const taskModelAllowed = !config?.assistant || config.assistant.modelIds.includes(conversation.model);
  const invalidModel = !!config && (!conversation.model || !selectedModel);
  const providerLabel = selectedModel?.providerLabel || config?.provider || 'AI';
  const currentRun = tasks.runs.find(run => runIsActive(run) && (run.conversationId === conversation.id || conversation.messages.some(message => message.taskId === run.id)));
  const busy = starting || !!currentRun;
  const pendingAttachments=conversation.pendingAttachments||[],currentUploads=uploads[conversation.id]||[],attachmentsBlocked=currentUploads.length>0;
  const taskError = conversation.messages.some(message => message.taskId && message.taskId === tasks.selectedId) ? tasks.error : '';
  const meter = useMemo(() => contextMeter(chatMessages(conversation.messages), conversation.contextState, conversation.contextUsage, conversation.model, conversation.input + (includeContext ? currentContent : '')), [conversation, includeContext, currentContent]);
  const contextWindow = selectedModel?.contextWindow || 1_000_000, contextPercent = Math.min(100, Math.max(0, meter.tokens / contextWindow * 100));
  const activeCheckpoint = resolveContext(chatMessages(conversation.messages), conversation.contextState).checkpoint;
  const hiddenConversationIds = new Set(stored.conversations.filter(item => conversationState(item) !== 'active').map(item => item.id));
  const recordRuns = tasks.runs.filter(run => !hiddenConversationIds.has(run.conversationId || '') && runHasOperations(run, tasks.details[run.id]));
  const remoteChats = useProjectChats(projectId, () => storedRef.current as PersistedChat, data => {
    storedRef.current = data as StoredChat;
    if (mounted.current) setStored(data as StoredChat);
    try { localStorage.setItem(storageKey(projectId), JSON.stringify(data)); } catch {}
  }, () => preferredSelection.current);
  useEffect(() => { onFlushReady?.(remoteChats.flush); return () => onFlushReady?.(undefined); }, [remoteChats.flush, onFlushReady]);
  function persist() {
    remoteChats.queue();
    try { localStorage.setItem(storageKey(projectId), JSON.stringify(storedRef.current)); }
    catch { if (mounted.current) setStorageWarning('本机浏览器存储空间不足。当前会话仍保留在窗口中，请及时复制重要内容。'); }
  }
  function commit(update: StoredChat | ((state: StoredChat) => StoredChat), immediate = true) {
    const next = typeof update === 'function' ? update(storedRef.current) : update;
    if (next === storedRef.current) return;
    storedRef.current = next;
    if (mounted.current) setStored(next);
    clearTimeout(persistTimer.current);
    if (immediate) persist(); else persistTimer.current = setTimeout(persist, 150);
  }
  function editConversation(id: string, update: (value: Conversation) => Conversation, immediate = true) {
    commit(state => ({ ...state, conversations: state.conversations.map(item => item.id === id ? { ...update(item), updatedAt: new Date().toISOString() } : item) }), immediate);
  }
  function editUploads(conversationId:string,update:(before:PendingAttachmentUpload[])=>PendingAttachmentUpload[]){const next={...uploadsRef.current,[conversationId]:update(uploadsRef.current[conversationId]||[])};uploadsRef.current=next;if(mounted.current)setUploads(next);}
  function removeUpload(conversationId:string,clientId:string){uploadControllers.current.get(clientId)?.abort();uploadControllers.current.delete(clientId);const upload=uploadsRef.current[conversationId]?.find(item=>item.clientId===clientId);if(upload?.previewUrl)URL.revokeObjectURL(upload.previewUrl);editUploads(conversationId,before=>before.filter(item=>item.clientId!==clientId));}
  async function uploadAttachment(file:File,conversationId:string,retry?:PendingAttachmentUpload){
    const clientId=retry?.clientId||crypto.randomUUID(),failure=attachmentFileError(file),entry:PendingAttachmentUpload={clientId,file,status:failure?'error':'uploading',...(failure?{error:failure}:{}),previewUrl:retry?.previewUrl||(!failure&&imageAttachment(file)?URL.createObjectURL(file):undefined)};
    editUploads(conversationId,before=>retry?before.map(item=>item.clientId===clientId?entry:item):[...before,entry]);if(failure)return;
    const controller=new AbortController();uploadControllers.current.set(clientId,controller);
    try{const form=new FormData();form.append('file',file,file.name);const attachment=await api<AgentAttachment>(`/api/projects/${encodeURIComponent(projectId)}/agent-attachments`,{method:'POST',body:form,signal:controller.signal});if(controller.signal.aborted||!uploadsRef.current[conversationId]?.some(item=>item.clientId===clientId))return;
      editConversation(conversationId,item=>({...item,pendingAttachments:uniqueAttachments([...(item.pendingAttachments||[]),attachment])}));removeUpload(conversationId,clientId);
    }catch(error:any){if(!controller.signal.aborted)editUploads(conversationId,before=>before.map(item=>item.clientId===clientId?{...item,status:'error',error:error.message||'上传失败，请重试。'}:item));}
    finally{uploadControllers.current.delete(clientId);}
  }
  function addFiles(files:File[]){const conversationId=storedRef.current.selectedId,current=storedRef.current.conversations.find(item=>item.id===conversationId);if(!current||conversationState(current)!=='active')return;let count=(current.pendingAttachments?.length||0)+(uploadsRef.current[conversationId]?.length||0);for(const file of files){if(count++>=MAX_MESSAGE_ATTACHMENTS){setError(`每条消息最多附带 ${MAX_MESSAGE_ATTACHMENTS} 个文件，请先移除部分附件。`,conversationId);break;}void uploadAttachment(file,conversationId);}}
  useEffect(()=>()=>{for(const controller of uploadControllers.current.values())controller.abort();for(const uploads of Object.values(uploadsRef.current))for(const upload of uploads)if(upload.previewUrl)URL.revokeObjectURL(upload.previewUrl);},[]);
  useEffect(()=>{dragDepth.current=0;setDragging(false);},[conversation.id]);
  async function loadConfig() {
    setConfigLoading(true); setConfigError('');
    try {
      const result = await api<AiConfig>('/api/ai/config');
      if (!mounted.current) return;
      setConfig(result);
      commit(state => ({ ...state, conversations: state.conversations.map(item => {
        const model = !openedWithHistory.current && !item.messages.length && !item.model ? result.defaultModel || '' : item.model;
        const efforts = result.models.find(entry => entry.id === model)?.efforts || [];
        return { ...item, model, ...(efforts.length && !efforts.includes(item.effort) ? { effort: (efforts.includes('medium') ? 'medium' : efforts[0]) as Effort } : {}) };
      }) }));
      openedWithHistory.current = true;
    } catch (e: any) { if (mounted.current) setConfigError(e.message || '无法读取 AI 配置'); }
    finally { if (mounted.current) setConfigLoading(false); }
  }
  useEffect(() => {
    mounted.current = true; void loadConfig();
    const save = () => persist(), reload = () => void loadConfig();
    window.addEventListener(MODEL_CONFIG_EVENT, reload); window.addEventListener('pagehide', save);
    return () => { mounted.current = false; window.removeEventListener(MODEL_CONFIG_EVENT, reload); window.removeEventListener('pagehide', save); clearTimeout(persistTimer.current); persist(); };
  }, []);
  useEffect(() => { for (const id of Object.keys(uiRef.current)) if (uiRef.current[id].includeContext) updateUi(id, { includeContext: false }); }, [currentPath, projectId]);
  useEffect(() => { if (shouldFollow.current && messageArea.current) messageArea.current.scrollTop = messageArea.current.scrollHeight; }, [stored, starting]);
  useEffect(() => {
    const conversations = storedRef.current.conversations.map(item => reconcileAgentConversation(item, tasks.runs, tasks.details));
    if (conversations.some((item, index) => item !== storedRef.current.conversations[index])) commit(state => ({ ...state, conversations }));
    for (const [id, before] of acceptedRuns.current) acceptedRuns.current.set(id, tasks.runs.find(run => run.id === before.id) || before);
  }, [tasks.runs, tasks.details, stored]);
  useEffect(() => {
    const ids = new Set(conversation.messages.map(message => message.taskId).filter((id): id is string => !!id));
    for (const id of ids) { const run = tasks.runs.find(item => item.id === id), detail = tasks.details[id]; if (!detail || run && run.version > detail.run.version) void tasks.load(id).catch(() => {}); }
  }, [conversation.id, conversation.messages, tasks.runs, tasks.details, tasks.load]);
  useEffect(() => { if (recordsOpen) for (const run of tasks.runs) if (!tasks.details[run.id]) void tasks.load(run.id).catch(() => {}); }, [recordsOpen, tasks.runs, tasks.details, tasks.load]);

  async function changeModel(model: string) {
    const efforts = config?.models.find(m => m.id === model)?.efforts || [];
    editConversation(conversation.id, item => ({ ...item, model, ...(efforts.length && !efforts.includes(item.effort) ? { effort: (efforts.includes('medium') ? 'medium' : efforts[0]) as Effort } : {}) })); setModelSaving(true); setError('');
    try { const result = await api<AiConfig>('/api/ai/config', json('PUT', { defaultModel: model, expectedRevision: config?.revision })); if (mounted.current) setConfig(result); }
    catch (e: any) { if (mounted.current) setError(`默认模型未能保存：${e.message}`, conversation.id); }
    finally { if (mounted.current) setModelSaving(false); }
  }

  async function send(quick?: TaskStartInput) {
    const active = storedRef.current.conversations.find(item => item.id === storedRef.current.selectedId)!;
    if (conversationState(active) !== 'active') { setError('请先恢复此对话，再继续发送。', active.id); return; }
    const draft = uiRef.current[active.id] || freshUi();
    const attachedFiles=!quick?active.pendingAttachments||[]:[];
    const prompt = attachmentPrompt(quick?.input ?? active.input,attachedFiles);
    const activeModel = config?.models.find(model => model.id === active.model);
    if (!prompt) return;
    if(!quick&&uploadsRef.current[active.id]?.length){setError(uploadsRef.current[active.id].some(item=>item.status==='error')?'请先重试或移除上传失败的附件。':'附件正在上传，请完成后再发送。',active.id);return;}
    if (sending.current.has(active.id) || tasks.runs.some(run => runIsActive(run) && (run.conversationId === active.id || active.messages.some(message => message.taskId === run.id))) || runIsActive(acceptedRuns.current.get(active.id))) { setError('请等待当前回复完成，或先停止当前操作。', active.id); return; }
    if (!remoteChats.ready || configLoading) { setError('正在载入对话和模型配置，请稍后发送。', active.id); return; }
    if (!activeModel || !(activeModel.configured ?? config?.configured) || config?.assistant && !config.assistant.modelIds.includes(active.model)) { setError('请在助手设置中明确选择已配置且允许使用的模型。', active.id); return; }
    if (!quick && draft.taskScope === 'file' && !currentPath) { setError('请先打开当前文件。', active.id); return; }
    sending.current.add(active.id); setStarting(true, active.id); setError('', active.id); setContextOpen(false); setHistoryOpen(false); setRecordsOpen(false); shouldFollow.current = true;
    const now = new Date().toISOString();
    const attachment = !quick && draft.includeContext && currentPath ? { path: currentPath, content: currentContent } : undefined;
    const user: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: prompt, status: 'complete', createdAt: now, ...(attachment ? { attachment, contextPath: attachment.path } : {}), ...(attachedFiles.length?{attachments:attachedFiles}:{}) };
    const assistant: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', status: 'streaming', createdAt: now, model: active.model, providerLabel };
    let submitted = false;
    try {
      const input = chatMessages([user])[0].content;
      if (input.length > 200000) throw new Error('本轮输入与附带材料超过 200000 字符，完整内容已保留，请缩小材料后重试。');
      setPhase('正在同步对话…', active.id);
      // Import only saved earlier messages. The new request remains separate from server history.
      await remoteChats.flush();
      if (!mounted.current) throw new Error('论文已切换，本轮消息未执行；原会话内容已保留。');
      const latestConversation = storedRef.current.conversations.find(item => item.id === active.id);
      if (!latestConversation || conversationState(latestConversation) !== 'active') throw new Error('此对话已在其他窗口归档或删除，请恢复后再继续。');
      const expectedLastRunId = conversationHead(storedRef.current.conversations.find(item => item.id === active.id)?.messages || active.messages);
      editConversation(active.id, item => ({ ...item, input: quick ? item.input : '', ...(!quick?{pendingAttachments:[]}:{}), title: item.messages.length ? item.title : prompt.slice(0, 28), messages: [...item.messages, user, assistant] }));
      submitted = true; setPhase('', active.id);
      const run = await onStartTask({ requestId: user.id, input, ...(quick?.attachments?.length?{attachments:quick.attachments}:attachedFiles.length?{attachments:attachedFiles.map(attachment=>attachment.id)}:{}), conversationId: active.id, expectedLastRunId, modelId: active.model, ...(activeModel.efforts?.includes(active.effort) ? { effort: active.effort } : {}), ...(quick?.roleId ? { roleId: quick.roleId } : {}), ...(quick?.scope ? { scope: quick.scope } : {}), ...(quick?.buildId ? { buildId: quick.buildId } : {}), ...(quick?.diagnostic ? { diagnostic: quick.diagnostic } : {}), ...(!quick && draft.taskScope !== 'project' ? { scope: draft.taskScope === 'readOnly' ? { readOnly: true } : { paths: [currentPath] } } : {}) });
      acceptedRuns.current.set(active.id, run);
      editConversation(active.id, item => reconcileAgentConversation({ ...item, messages: item.messages.map(message => message.id === user.id || message.id === assistant.id ? { ...message, taskId: run.id } : message) }, [run]));
    } catch (e: any) {
      if (submitted&&!quick)editConversation(active.id,item=>({...item,input:item.input||active.input,pendingAttachments:uniqueAttachments([...(item.pendingAttachments||[]),...attachedFiles])}));
      if (submitted) editConversation(active.id, item => ({ ...item, messages: item.messages.map(message => message.id === assistant.id ? { ...message, status: 'error', error: e.message || '消息未能发送' } : message) }));
      if (mounted.current) setError(e.message || '消息未能发送', active.id);
    } finally { sending.current.delete(active.id); if (mounted.current) { setStarting(false, active.id); setPhase('', active.id); } }
  }
  const sendRef = useRef<AssistantSend>(async () => {}); sendRef.current = send;
  useEffect(() => { if (remoteChats.ready && !configLoading) onSendReady?.(input => sendRef.current(input)); else onSendReady?.(undefined); return () => onSendReady?.(undefined); }, [remoteChats.ready, configLoading, onSendReady]);

  function chooseConversation(id: string) {
    const target = storedRef.current.conversations.find(item => item.id === id);
    if (!target || conversationState(target) !== 'active') return;
    preferredSelection.current = id; try { sessionStorage.setItem(selectionKey(projectId), id); } catch {}
    commit(state => ({ ...state, selectedId: id })); setHistoryOpen(false); setContextOpen(false); setRecordsOpen(false); shouldFollow.current = true;
  }
  function startConversation() {
    if (!remoteChats.ready || configLoading || remoteChats.changingId) return;
    const next = newConversation(config?.defaultModel || DEFAULT_MODEL, conversation.effort);
    commit(state => ({ ...state, conversations: [next, ...state.conversations] })); chooseConversation(next.id);
  }
  function conversationBusy(item: Conversation) {
    return sending.current.has(item.id) || uiRef.current[item.id]?.starting || runIsActive(acceptedRuns.current.get(item.id)) || tasks.runs.some(run => runIsActive(run) && (run.conversationId === item.id || item.messages.some(message => message.taskId === run.id)));
  }
  async function changeConversationState(item: Conversation, action: 'archive' | 'delete' | 'restore') {
    setHistoryError(''); setHistoryNotice('');
    try {
      await remoteChats.changeLifecycle(item.id, action);
      if (!mounted.current) return;
      preferredSelection.current = storedRef.current.selectedId;
      try { sessionStorage.setItem(selectionKey(projectId), storedRef.current.selectedId); } catch {}
      if (action === 'restore') { chooseConversation(item.id); setHistoryFilter('active'); }
      else setHistoryNotice(action === 'archive' ? '已归档，可在“已归档”中恢复。' : '已移入回收站，可恢复对话。');
    } catch (error: any) { if (mounted.current) setHistoryError(error.message || '对话历史未能更新，请重试。'); }
  }
  function openRecord(run: AgentRun) {
    const existing = storedRef.current.conversations.find(item => item.id === run.conversationId || item.messages.some(message => message.taskId === run.id));
    if (existing) chooseConversation(existing.id);
    else {
      const item = newConversation(run.modelId); item.id = run.conversationId || `history-${run.id}`; item.title = run.input.slice(0, 28); item.messages = [{ id: `agent-user-${run.id}`, role: 'user', content: run.input, status: 'complete', taskId: run.id, createdAt: run.createdAt }];
      const recovered = reconcileAgentConversation(item, [run]); commit(state => ({ ...state, conversations: [recovered, ...state.conversations] })); chooseConversation(recovered.id);
    }
    tasks.select(run.id); setRecordsOpen(false); shouldFollow.current = false;
    setTimeout(() => { const message = messageArea.current?.querySelector(`[data-run-id="${CSS.escape(run.id)}"]`); message?.scrollIntoView({ block: 'nearest' }); const details = message?.querySelector('details.ai-operation-record') as HTMLDetailsElement | null; if (details) details.open = true; }, 0);
  }
  async function copy(message: ChatMessage) { try { await copyText(message.content); setCopiedId(message.id); setTimeout(() => { if (mounted.current) setCopiedId(''); }, 2000); } catch (e: any) { setError(e.message, conversation.id); } }

  const historyItems = stored.conversations.filter(item => conversationState(item) === historyFilter);
  const historyPopover = historyOpen && <div className="ai-history-popover" role="dialog" aria-label="AI 对话历史记录">
    <div className="ai-history-tabs" role="tablist" aria-label="AI 对话分类">
      {([{ state: 'active', label: '对话' }, { state: 'archived', label: '已归档' }, { state: 'deleted', label: '回收站' }] as const).map(({ state, label }) => <button key={state} role="tab" aria-selected={historyFilter === state} onClick={() => { setHistoryFilter(state); setHistoryNotice(''); setHistoryError(''); }}>{label}<span>{stored.conversations.filter(item => conversationState(item) === state).length}</span></button>)}
    </div>
    <div className="ai-history-list" role="list" aria-label={historyFilter === 'active' ? '当前对话' : historyFilter === 'archived' ? '已归档对话' : '已删除对话'}>
      {historyItems.map(item => {
        const running = conversationBusy(item), disabled = !remoteChats.ready || !!remoteChats.changingId;
        return <div className={'ai-history-row' + (stored.selectedId === item.id ? ' selected' : '')} role="listitem" key={item.id} data-conversation-id={item.id} data-state={historyFilter}>
          {historyFilter === 'active' ? <button className="ai-history-title" aria-current={stored.selectedId === item.id ? 'true' : undefined} title={item.title} onClick={() => chooseConversation(item.id)}>{item.title}</button> : <span className="ai-history-title" title={item.title}>{item.title}</span>}
          <div className="ai-history-actions">
            {historyFilter === 'active' ? <button className="icon-button" aria-label={'归档对话：' + item.title} title={running ? '请先等待回复完成或停止任务' : '归档对话'} disabled={disabled || running} onClick={() => void changeConversationState(item, 'archive')}><Archive size={13}/></button> : <button className="icon-button" aria-label={'恢复对话：' + item.title} title={historyFilter === 'archived' ? '取消归档并继续对话' : '从回收站恢复对话'} disabled={disabled} onClick={() => void changeConversationState(item, 'restore')}>{historyFilter === 'archived' ? <ArchiveRestore size={13}/> : <RotateCcw size={13}/>}</button>}
            {historyFilter !== 'deleted' && <button className="icon-button ai-history-delete" aria-label={'删除对话：' + item.title} title={running ? '请先等待回复完成或停止任务' : '移入回收站，可恢复'} disabled={disabled || running} onClick={() => void changeConversationState(item, 'delete')}><Trash2 size={13}/></button>}
            {remoteChats.changingId === item.id && <LoaderCircle size={12} className="spin"/>}
          </div>
        </div>;
      })}
      {!historyItems.length && <p className="ai-history-empty">{historyFilter === 'archived' ? '暂无归档对话' : historyFilter === 'deleted' ? '回收站为空' : '暂无对话'}</p>}
    </div>
    {historyNotice && <p className="ai-history-notice" role="status">{historyNotice}</p>}
    {historyError && <p className="ai-history-error" role="alert">{historyError}</p>}
  </div>;

  return <aside className="ai-panel ai-chat-panel" aria-label="AI 助手面板">
    <div className="ai-panel-heading"><button className="ai-conversation-switch" aria-label="AI 对话历史" title={'当前对话：' + conversation.title + '；点击切换历史'} aria-expanded={historyOpen} onClick={() => { setHistoryOpen(!historyOpen); setHistoryFilter('active'); setHistoryError(''); setHistoryNotice(''); setContextOpen(false); setRecordsOpen(false); }}><History size={13}/><span className="ai-current-conversation" aria-label="当前对话标题">{conversation.title}</span><small>历史</small><ChevronDown size={11}/></button><div className="ai-panel-actions"><button className="ai-new-conversation" aria-label="新建 AI 对话" title={remoteChats.ready && !configLoading ? '新建独立上下文，当前对话仍会保留' : '正在载入对话与模型，请稍后新建'} disabled={!remoteChats.ready || configLoading || !!remoteChats.changingId} onClick={startConversation}><Plus size={13}/><span>新对话</span></button><button className="icon-button" aria-label="模型与 API 设置" title="模型与 API 设置" onClick={() => openModelSettings('assistant')}><Settings2 size={14}/></button><button className="icon-button" aria-label="助手操作记录" title="操作记录" aria-expanded={recordsOpen} onClick={() => { setRecordsOpen(!recordsOpen); setHistoryOpen(false); setContextOpen(false); }}><ListChecks size={14}/></button><button className="icon-button" aria-label="导出 AI 对话" title="导出当前项目全部对话" onClick={() => downloadText(`${projectId}-AI对话.json`, JSON.stringify(storedRef.current, null, 2))}><FileText size={14}/></button><button className="icon-button" aria-label="关闭 AI 助手" onClick={onClose}><X size={15}/></button></div>{historyPopover}</div>
    <div className="ai-controls"><select className="ai-model-select" aria-label="AI 模型" title={`${conversation.model} · ${providerLabel} ${selectedModel?.plan || ''}`} value={conversation.model} disabled={!config || configLoading || modelSaving || busy} onChange={e => void changeModel(e.target.value)}>{(!conversation.model || config && !selectedModel) && <option value={conversation.model}>{conversation.model ? conversation.model + ' · 已不可用' : '请选择模型'}</option>}{(config?.models || []).map(model => <option key={model.id} value={model.id}>{model.providerLabel ? `${model.providerLabel} · ${model.label.replace('MiniMax-', '')}` : model.label}</option>)}</select><select className="ai-effort-select" aria-label="AI 推理强度" title={supportsEffort ? '推理强度' : '模型默认深度'} value={conversation.effort} disabled={busy || !supportsEffort} onChange={e => editConversation(conversation.id, item => ({ ...item, effort: e.target.value as Effort }))}>{supportsEffort ? EFFORTS.filter(item => allowedEfforts.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.label}</option>) : <option value={conversation.effort}>默认深度</option>}</select><button className={`ai-context-ring ${contextPercent >= 95 ? 'at-limit' : contextPercent >= 75 ? 'near-limit' : ''} ${phase ? 'compacting' : ''}`} aria-label={`上下文用量${meter.estimated ? '估算' : ''} ${contextPercent.toFixed(1)}%`} aria-expanded={contextOpen} title={`上下文${meter.estimated ? '约 ' : ''}${meter.tokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`} onClick={() => { setContextOpen(!contextOpen); setHistoryOpen(false); }}><svg width="27" height="27" viewBox="0 0 27 27" aria-hidden="true"><circle className="ring-track" cx="13.5" cy="13.5" r="11"/><circle className="ring-value" cx="13.5" cy="13.5" r="11" strokeDasharray={Math.PI * 22} strokeDashoffset={Math.PI * 22 * (1 - contextPercent / 100)}/></svg><span>{contextPercent < 1 ? '<1' : Math.round(contextPercent)}%</span></button>{contextOpen && <section className="ai-context-popover" aria-label="上下文用量详情"><header><strong>上下文窗口</strong><button className="icon-button" aria-label="关闭上下文详情" onClick={() => setContextOpen(false)}><X size={13}/></button></header><p>{meter.estimated ? '约 ' : ''}{meter.tokens.toLocaleString()} / {contextWindow.toLocaleString()} tokens · {contextPercent.toFixed(1)}%</p><small>此处兼容旧记录的本地估算；助手由本机服务管理上下文并按需压缩，完整聊天记录保留。</small>{activeCheckpoint && <><small>旧记录已压缩 {activeCheckpoint.round} 次 · 早期 {activeCheckpoint.messageCount} 条消息</small><details><summary>查看旧记录连续性摘要</summary><pre>{activeCheckpoint.summary}</pre></details></>}</section>}</div>
    {remoteChats.warning && <p className="ai-error" role="alert">{remoteChats.warning}</p>}
    {(configError || config && !isConfigured) && <div className="ai-config-notice" role="status"><AlertCircle size={15}/><div><strong>{configError ? '无法读取 AI 配置' : 'AI 助手尚未配置'}</strong><p>{configError || '此模型的服务尚未配置。可在模型设置中添加 API 与凭据。'}</p><button onClick={() => openModelSettings('assistant')}><Settings2 size={12}/>配置模型与 API</button><button onClick={() => void loadConfig()} disabled={configLoading}><RefreshCw size={12}/>重新读取配置</button></div></div>}
    {invalidModel && <div className="ai-model-invalid" role="alert">{conversation.model ? '历史模型已不可用。请选择模型后再继续，原记录会保留。' : '尚未选择默认模型。请明确选择模型后再发送。'}</div>}
    {!taskModelAllowed && <div className="ai-model-invalid">此模型未加入助手允许列表，请在助手设置中明确配置。</div>}
    {phase && <div className="ai-compaction-status" role="status"><LoaderCircle size={12} className="spin"/>{phase}</div>}
    {recordsOpen && <section className="ai-record-drawer" aria-label="助手操作记录列表"><header><strong>操作记录</strong><button className="icon-button" aria-label="关闭操作记录" onClick={() => setRecordsOpen(false)}><X size={13}/></button></header><div role="listbox" aria-label="历史操作">{recordRuns.map(run => <button key={run.id} role="option" aria-selected={tasks.selectedId === run.id} onClick={() => openRecord(run)}><span>{run.input}</span><small>{runIsActive(run) ? '进行中' : run.status === 'completed' ? '已完成' : '需查看'} · {new Date(run.createdAt).toLocaleString('zh-CN')}</small></button>)}{!recordRuns.length && <p>还没有工具或文件操作记录。</p>}</div></section>}
    <div className="ai-messages" ref={messageArea} onScroll={e => { const el = e.currentTarget; shouldFollow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} aria-label="AI 对话内容" aria-busy={busy}>
      {!conversation.messages.length ? <div className="ai-chat-empty"><h2>有什么可以帮你？</h2></div> : conversation.messages.map(message => {
        const run = message.taskId ? tasks.runs.find(item => item.id === message.taskId) : undefined;
        const detail = message.taskId ? tasks.details[message.taskId] : undefined;
        const operations = message.role === 'assistant' && runHasOperations(run, detail);
        return <article className={`ai-message ${message.role}`} key={message.id} data-run-id={message.role === 'assistant' ? message.taskId : undefined} aria-label={message.role === 'user' ? '你的消息' : 'AI 回复'}>{message.contextPath && <div className="ai-attached-file"><FileText size={11}/>{message.contextPath}</div>}<div className="ai-message-content">{message.content ? message.role === 'assistant' ? <AiMarkdown text={message.content}/> : message.content : message.status === 'streaming' ? <span className="ai-generating"><LoaderCircle size={13} className="spin"/>{operations ? '正在处理…' : '正在思考…'}</span> : message.status === 'stopped' ? '本轮已停止。' : message.error ? '' : '未收到回复内容。'}</div>{!!message.attachments?.length&&<MessageAttachments projectId={projectId} attachments={message.attachments} onPreview={setPreview}/>} {message.error && <div className="ai-message-error"><AlertCircle size={12}/>{message.error}</div>}{message.status === 'stopped' && message.content && <div className="ai-message-status">本轮已停止 · 已保留收到的内容</div>}{message.content && <div className="ai-message-actions"><button className="icon-button" aria-label={message.role === 'assistant' ? '复制 AI 回复' : '复制问题'} title="复制内容" onClick={() => void copy(message)}>{copiedId === message.id ? <Check size={12}/> : <Copy size={12}/>}</button>{message.role === 'assistant' && (message.model || message.usage || run?.usage) && <details className="ai-message-info"><summary aria-label="回复信息" title="查看模型与用量"><Info size={12}/></summary><div><span>{[message.providerLabel, message.model].filter(Boolean).join(' · ') || '回复用量'}</span>{message.usage ? <span>输入 {message.usage.prompt_tokens.toLocaleString()} · 输出 {message.usage.completion_tokens.toLocaleString()} tokens</span> : run && <span>{run.usage.modelCalls} 次模型调用 · {run.usage.estimated ? '约 ' : ''}{run.usage.tokens.toLocaleString()} tokens</span>}{message.finishReason === 'length' && <span>回复达到长度上限，内容可能不完整。</span>}</div></details>}</div>}{operations && run && <details className="ai-operation-record" open={!!run.pendingDecision}><summary><ListChecks size={12}/><span>操作记录</span>{runIsActive(run) && <LoaderCircle size={11} className="spin"/>}<small>{detail?.tools.length ? `${detail.tools.length} 次工具调用` : run.children.length ? `${run.children.length} 个协作角色` : '查看修改与检查'}</small><ChevronDown size={12}/></summary><AgentTaskPanel compact runId={run.id} tasks={tasks} builds={builds} onOpenFile={onOpenFile} onViewBuild={onViewBuild}/></details>}</article>;
      })}
    </div>
    {(error || storageWarning || taskError) && <div className="ai-chat-error" role="alert"><AlertCircle size={14}/><span>{error || storageWarning || taskError}</span><button className="icon-button" aria-label="关闭 AI 提示" onClick={() => { setError(''); setStorageWarning(''); tasks.clearError(); }}><X size={12}/></button></div>}
    <details className="ai-operation-scope"><summary>操作范围<ChevronDown size={12}/></summary><div><p>助手按问题直接回答，或按需读取、修改及委派。操作仅限本项目；正文、笔记、文献文件和审稿回复可保存修改，官方模板与投稿快照受保护。</p><label>本轮范围<select aria-label="助手操作范围" value={taskScope} disabled={busy} onChange={event => setTaskScope(event.target.value as typeof taskScope)}><option value="project">当前项目允许范围</option><option value="file" disabled={!currentPath}>仅当前文件</option><option value="readOnly">只读</option></select></label><label><input type="checkbox" checked={includeContext} disabled={!currentPath || busy} onChange={event => setIncludeContext(event.target.checked)}/><FileText size={12}/>附带当前编辑快照</label>{includeContext && <small>{currentPath} · 快照会保留在此对话历史中。</small>}</div></details>
    <div className={`ai-composer ${dragging?'ai-attachment-dragging':''}`} onDragEnter={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();dragDepth.current++;setDragging(true);}}} onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}}} onDragLeave={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();if(--dragDepth.current<=0){dragDepth.current=0;setDragging(false);}}}} onDrop={event=>{if(event.dataTransfer.files.length){event.preventDefault();dragDepth.current=0;setDragging(false);addFiles(Array.from(event.dataTransfer.files));}}}>
      {dragging&&<section className="ai-attachment-drop-hint"><Paperclip size={16}/>松开以添加图片或文件</section>}
      <ComposerAttachments projectId={projectId} attachments={pendingAttachments} uploads={currentUploads} onRemove={id=>editConversation(conversation.id,item=>({...item,pendingAttachments:(item.pendingAttachments||[]).filter(attachment=>attachment.id!==id)}))} onRemoveUpload={id=>removeUpload(conversation.id,id)} onRetry={upload=>void uploadAttachment(upload.file,conversation.id,upload)} onPreview={setPreview}/>
      <input type="file" hidden multiple accept={ATTACHMENT_ACCEPT} ref={fileInput} aria-label="选择 AI 附件" onChange={event=>{addFiles(Array.from(event.currentTarget.files||[]));event.currentTarget.value='';}}/>
      <textarea aria-label="AI 消息" onPaste={event=>{const files=Array.from(event.clipboardData.items).filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter((file):file is File=>!!file);if(files.length){event.preventDefault();addFiles(files);}}} placeholder={isConfigured ? '提问，或粘贴、拖入图片与文件…' : '配置模型与 API 后可在此发送消息'} value={conversation.input} onChange={e => editConversation(conversation.id, item => ({ ...item, input: e.target.value }))} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send(); } }} rows={3}/><div className="ai-composer-toolbar"><button type="button" className="ai-composer-attach" aria-label="添加图片或文件" title="添加图片或文件，也可拖入或粘贴图片" disabled={!remoteChats.ready||starting} onClick={()=>fileInput.current?.click()}><Paperclip size={15}/></button><span className="ai-composer-hint">图片 / 文件 · Enter 发送</span>{currentRun ? <button className="ai-stop" aria-label="停止当前操作" onClick={() => void tasks.action('cancel', {}, currentRun.id)}><Square size={12}/>停止</button> : <button className="ai-send" disabled={!isConfigured || !taskModelAllowed || (!conversation.input.trim()&&!pendingAttachments.length) || attachmentsBlocked || configLoading || modelSaving || starting || !remoteChats.ready || taskScope === 'file' && !currentPath} aria-label="发送 AI 消息" onClick={() => void send()}>{starting ? <LoaderCircle size={14} className="spin"/> : <SendHorizontal size={15}/>}</button>}</div></div>
    {preview&&<AttachmentPreviewDialog preview={preview} onClose={()=>setPreview(undefined)}/>}
  </aside>;
}
