import {visibleChat,shouldFollowChat,type VisibleChat} from '../chat-follow';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Archive, ArchiveRestore, Check, ChevronDown, Copy, FileText, History, Info, ListChecks, LoaderCircle, Settings2, Plus, Paperclip, RefreshCw, RotateCcw, SendHorizontal, SlidersHorizontal, Sparkles, Square, Trash2, X } from 'lucide-react';
import { api, downloadText, json } from '../api';
import { useProjectChats } from '../useProjectChats';
import {submitFrozenTurn, activeConversationRun,restoreQueuedTurns,type QueuedTurn} from '../queuedTurns';
import { chatsEqual, conversationState, ensureActiveChat, mergeTaskMessages, type ChatLifecycle, type ConversationState, type PersistedChat } from '../../shared/chat-merge';
import { chatMessages, contextMeter, resolveContext, type ContextCheckpoint, type ContextUsage } from '../../shared/ai-context';
import { conversationHead, createAgentConversation, reconcileAgentConversation, runHasOperations, runIsActive } from '../agentConversation';
import AiMarkdown from './AiMarkdown';
import 'katex/dist/katex.min.css';
import '../ai-chat.css';
import '../writing-tools.css';
import type { WritingContract } from '../writingDraft';
import { writingRequest } from '../writingRequest';
import { fileChatContext } from '../fileChatContext';
import { isTaskProgressQuestion, taskProgressReply } from '../taskProgress';
import { quoteReference, type WritingQuote } from '../selectionContext';
import type { EditSelection } from '../editReview';
import { MODEL_CONFIG_EVENT, openModelSettings } from '../modelSettings';
import type { AgentCreateInput, AgentRun, AgentRunDetail, AssistantSettings } from '../../shared/agent-types';
import { agentResultDisplay } from '../../shared/agent-display';
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
interface ConversationUi { includeContext: boolean; starting: boolean; taskScope: 'project' | 'file' | 'readOnly' | 'selection'; fileTarget?: string; contextLoading?: boolean; selection?: EditSelection; reference?: {path:string;content:string}; writingTask: WritingContract; phase: string; error: string }
const freshUi = (): ConversationUi => ({ includeContext: false, starting: false, taskScope: 'file', writingTask: { kind: 'focused', outputMode: 'suggest', verification: 'none' }, phase: '', error: '' });
export type TaskStartInput = Omit<AgentCreateInput, 'requestId' | 'targetId' | 'history' | 'compactionId' | 'expectedLastRunId'> & { requestId?: string; expectedLastRunId?: string | null; writingTask?: WritingContract; targetId?:string };
export type AssistantSend = (input: TaskStartInput) => Promise<void>;
interface Props { incomingQuote?: WritingQuote; onReadSelection: () => EditSelection | undefined; projectId: string; targetId:string; currentPath: string; currentContent: string; tasks: ProjectTasks; builds: Build[]; onStartTask: (input: TaskStartInput) => Promise<AgentRun>; onOpenFile: (path: string) => void; onViewBuild: (id: string) => void; onClose: () => void; onFlushReady?: (flush: (() => Promise<void>) | undefined) => void; onSendReady?: (send: AssistantSend | undefined) => void }
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
      if (conversations.length) { const selectedId = conversations.some(c => c.id === stored.selectedId) ? stored.selectedId : conversations[0].id; return ensureActiveChat({ version: 1, selectedId, conversations:conversations.map(c=>({...c,messages:mergeTaskMessages(c.messages)})) }) as StoredChat; }
    }
  } catch { /* Keep a malformed browser draft from blocking the workspace. */ }
  const first = newConversation(); return { version: 1, selectedId: first.id, conversations: [first] };
}
async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); }
  catch { const element = document.createElement('textarea'); element.value = text; element.style.position = 'fixed'; element.style.opacity = '0'; document.body.appendChild(element); element.select(); const copied = document.execCommand('copy'); element.remove(); if (!copied) throw new Error('无法复制，请选中文字后手动复制。'); }
}

export default function AiPanel({ incomingQuote, onReadSelection, projectId, targetId, currentPath, currentContent, tasks, builds, onStartTask, onOpenFile, onViewBuild, onClose, onFlushReady, onSendReady }: Props) {
  const [stored, setStored] = useState<StoredChat>(() => restore(projectId));
  const storedRef = useRef(stored);
  // baseRef is the persisted form; storedRef/stored is the display view rebuilt from durable runs.
  // Run reconciliation stays in memory and is never written back on its own.
  const baseRef = useRef(stored);
  const tasksRef = useRef(tasks); tasksRef.current = tasks;
  const chatView = (base: StoredChat): StoredChat => { const conversations = base.conversations.map(item => reconcileAgentConversation(item, tasksRef.current.runs, tasksRef.current.details)); return conversations.some((item, index) => item !== base.conversations[index]) ? { ...base, conversations } : base; };
  const openedWithHistory = useRef(!!localStorage.getItem(storageKey(projectId)));
  const [config, setConfig] = useState<AiConfig>();
  const [configLoading, setConfigLoading] = useState(true), [configError, setConfigError] = useState('');
  const [storageWarning, setStorageWarning] = useState(''), [modelSaving, setModelSaving] = useState(false);
  const [conversationUi, setConversationUi] = useState<Record<string, ConversationUi>>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`echopaper:writing-chat:${projectId}`) || '{}');
      const restored: Record<string, ConversationUi> = {};
      for (const [id, value] of Object.entries(saved)) {
        const draft = value as Partial<ConversationUi>;
        if (!['project', 'file', 'selection', 'readOnly'].includes(draft.taskScope || '')) continue;
        const contract = draft.writingTask;
        if (!contract || !['focused','project','repair'].includes(contract.kind) || !['suggest','apply'].includes(contract.outputMode) || !['none','compile'].includes(contract.verification)) continue;
        restored[id] = { ...freshUi(), taskScope: draft.selection ? 'selection' : draft.fileTarget ? 'file' : draft.reference ? 'readOnly' : 'file', fileTarget: draft.fileTarget, selection: draft.selection, reference: draft.reference };
      }
      return restored;
    } catch { return {}; }
  });
  const uiRef = useRef(conversationUi);
  useEffect(() => {
    try { sessionStorage.setItem(`echopaper:writing-chat:${projectId}`, JSON.stringify(conversationUi)); }
    catch { setStorageWarning('写作范围草稿无法保存，请在刷新页面前记录选区与要求。'); }
  }, [conversationUi, projectId]);
  const [initialSelection] = useState(() => { try { return sessionStorage.getItem(selectionKey(projectId)) || undefined; } catch { return undefined; } });
  const preferredSelection = useRef<string | undefined>(initialSelection);
  const [copiedId, setCopiedId] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false), [contextOpen, setContextOpen] = useState(false), [recordsOpen, setRecordsOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false), [quoteOpen, setQuoteOpen] = useState(false);
  useEffect(() => { setOptionsOpen(false); setQuoteOpen(false); }, [stored.selectedId, incomingQuote]);
  const [historyFilter, setHistoryFilter] = useState<ConversationState>('active'), [historyNotice, setHistoryNotice] = useState(''), [historyError, setHistoryError] = useState('');
  const mounted = useRef(true), composing = useRef(false), sending = useRef(new Set<string>());
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const messageArea = useRef<HTMLDivElement>(null), shouldFollow = useRef(true);
  const acceptedRuns = useRef(new Map<string, AgentRun>());
  const queueKey=`echopaper:queued-turns:${projectId}`;
  const [queuedTurns,setQueuedTurns]=useState<QueuedTurn[]>(()=>{try{return restoreQueuedTurns(sessionStorage.getItem(queueKey));}catch{return[];}});
  const queuedRef=useRef(queuedTurns),drainingTurns=useRef(new Set<string>());queuedRef.current=queuedTurns;
  function updateQueue(update:(items:QueuedTurn[])=>QueuedTurn[]){const next=update(queuedRef.current);queuedRef.current=next;setQueuedTurns(next);try{sessionStorage.setItem(queueKey,JSON.stringify(next));}catch{setStorageWarning('排队消息暂存在本窗口，请勿关闭页面。');}}

  const [uploads,setUploads]=useState<Record<string,PendingAttachmentUpload[]>>({}),uploadsRef=useRef<Record<string,PendingAttachmentUpload[]>>({}),uploadControllers=useRef(new Map<string,AbortController>()),fileInput=useRef<HTMLInputElement>(null),dragDepth=useRef(0);
  const [dragging,setDragging]=useState(false),[preview,setPreview]=useState<AttachmentPreview>();
  const conversation = stored.conversations.find(item => item.id === stored.selectedId) || stored.conversations[0];
  const { includeContext, starting, taskScope, selection, reference, fileTarget, contextLoading, phase, error } = conversationUi[conversation.id] || freshUi();
  function updateUi(id: string, patch: Partial<ConversationUi>) { const next = { ...uiRef.current, [id]: { ...(uiRef.current[id] || freshUi()), ...patch } }; uiRef.current = next; if (mounted.current) setConversationUi(next); }
  const setError = (error: string, id = storedRef.current.selectedId) => updateUi(id, { error });
  const setStarting = (starting: boolean, id: string) => updateUi(id, { starting });
  const setPhase = (phase: string, id: string) => updateUi(id, { phase });
  function captureSelection() {
    const selected = onReadSelection();
    if (!selected) { setError('请先在源码中选择段落。PDF 选文可通过右键加入只读参考。'); return; }
    updateUi(storedRef.current.selectedId, { selection: selected, fileTarget: undefined, reference: undefined, taskScope: 'selection', writingTask: { kind: 'focused', outputMode: 'suggest', verification: 'none' } });
  }
  const lastQuote = useRef<WritingQuote | undefined>(undefined), fileContextRequest = useRef(0);
  useEffect(() => {
    if (!incomingQuote || incomingQuote.projectId !== projectId || lastQuote.current === incomingQuote) return;
    lastQuote.current = incomingQuote;
    if (incomingQuote.source === 'source') {
      updateUi(storedRef.current.selectedId, { selection: incomingQuote.selection, fileTarget: undefined, reference: undefined, taskScope: 'selection', writingTask: { kind: 'focused', outputMode: 'suggest', verification: 'none' } });
    } else if (incomingQuote.source === 'file') {
      const owner = storedRef.current.selectedId, controller = new AbortController(), requestNo = ++fileContextRequest.current;
      updateUi(owner, { contextLoading: true, error: '' });
      void fileChatContext(projectId, incomingQuote.path, incomingQuote.content, controller.signal).then(({reference,attachment}) => {
        if (controller.signal.aborted) return;
        const chat = storedRef.current.conversations.find(item=>item.id===owner);
        if (!chat || conversationState(chat)!=='active') throw new Error('原对话已归档或删除，文件尚未加入。');
        if (attachment) {
          if ((chat.pendingAttachments?.length||0) >= MAX_MESSAGE_ATTACHMENTS) throw new Error('本轮附件已满，请先移除部分附件再添加文件。');
          editConversation(owner,item=>({...item,pendingAttachments:uniqueAttachments([...(item.pendingAttachments||[]),attachment])}));
        }
        updateUi(owner, { selection: undefined, reference, fileTarget: incomingQuote.path, taskScope: 'file' });
      }).catch(error=>{if(!controller.signal.aborted)setError(error.message||'文件未能加入对话，请重试。',owner);})
        .finally(()=>{if(mounted.current&&requestNo===fileContextRequest.current)updateUi(owner,{contextLoading:false});});
      return ()=>{controller.abort();if(lastQuote.current===incomingQuote)lastQuote.current=undefined;updateUi(owner,{contextLoading:false});};
    } else {
      updateUi(storedRef.current.selectedId, { selection: undefined, fileTarget: undefined, reference: quoteReference(incomingQuote), taskScope: 'readOnly', writingTask: { kind: 'focused', outputMode: 'suggest', verification: 'none' } });
    }
  }, [incomingQuote, projectId]);
  const selectedModel = config?.models.find(model => model.id === conversation.model);
  const allowedEfforts = selectedModel?.efforts || [], supportsEffort = allowedEfforts.length > 0;
  const isConfigured = !!selectedModel && (selectedModel.configured ?? config?.configured ?? false);
  const taskModelAllowed = !config?.assistant || config.assistant.modelIds.includes(conversation.model);
  const invalidModel = !!config && (!conversation.model || !selectedModel);
  const providerLabel = selectedModel?.providerLabel || config?.provider || 'AI';
  const currentRun = activeConversationRun(conversation,tasks.runs,acceptedRuns.current.get(conversation.id));
  const busy = starting || !!currentRun;
  const willQueue=busy||queuedTurns.some(turn=>turn.conversationId===conversation.id);
  const pendingAttachments=conversation.pendingAttachments||[],currentUploads=uploads[conversation.id]||[],attachmentsBlocked=currentUploads.length>0;
  const taskError = conversation.messages.some(message => message.taskId && message.taskId === tasks.selectedId) ? tasks.error : '';
  const legacyMeter = useMemo(() => contextMeter(chatMessages(conversation.messages), conversation.contextState, conversation.contextUsage, conversation.model, conversation.input + (includeContext ? currentContent : '')), [conversation, includeContext, currentContent]);
  const contextRun = tasks.runs.filter(run=>run.conversationId===conversation.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  const requestContext = contextRun?.context?.modelId===conversation.model ? contextRun.context : undefined;
  const meter = requestContext ? {tokens:requestContext.tokens,estimated:requestContext.estimated} : legacyMeter;
  const contextWindow = requestContext?.contextWindow || selectedModel?.contextWindow || 1_000_000, contextPercent = Math.min(100, Math.max(0, meter.tokens / contextWindow * 100));
  const activeCheckpoint = resolveContext(chatMessages(conversation.messages), conversation.contextState).checkpoint;
  const hiddenConversationIds = new Set(stored.conversations.filter(item => conversationState(item) !== 'active').map(item => item.id));
  const recordRuns = tasks.runs.filter(run => !hiddenConversationIds.has(run.conversationId || '') && runHasOperations(run, tasks.details[run.id]));
  const remoteChats = useProjectChats(projectId, () => baseRef.current as PersistedChat, data => {
    const base = data as StoredChat;
    if(chatsEqual(base,baseRef.current))return;
    baseRef.current = base;
    const shown = chatView(base);
    storedRef.current = shown;
    if (mounted.current) setStored(shown);
    try { localStorage.setItem(storageKey(projectId), JSON.stringify(baseRef.current)); } catch {}
  }, () => preferredSelection.current);
  useEffect(() => { onFlushReady?.(remoteChats.flush); return () => onFlushReady?.(undefined); }, [remoteChats.flush, onFlushReady]);
  function persist() {
    remoteChats.queue();
    try { localStorage.setItem(storageKey(projectId), JSON.stringify(baseRef.current)); }
    catch { if (mounted.current) setStorageWarning('本机浏览器存储空间不足。当前会话仍保留在窗口中，请及时复制重要内容。'); }
  }
  /** Updates the persisted form. Pass save=false for load-time normalization that must not write the file. */
  function commit(update: StoredChat | ((state: StoredChat) => StoredChat), immediate = true, save = true) {
    const next = typeof update === 'function' ? update(baseRef.current) : update;
    if (next === baseRef.current) return;
    baseRef.current = next;
    const shown = chatView(next);
    storedRef.current = shown;
    if (mounted.current) setStored(shown);
    if (!save) { try { localStorage.setItem(storageKey(projectId), JSON.stringify(baseRef.current)); } catch {} return; }
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
      }) }), true, false);
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
  const visibleContent=visibleChat(conversation.id,conversation.messages).content;
  const visibleBefore=useRef<VisibleChat|undefined>(undefined);
  useEffect(()=>{const previous=visibleBefore.current;visibleBefore.current={id:conversation.id,content:visibleContent};if(messageArea.current&&shouldFollowChat(previous,{id:conversation.id,content:visibleContent},shouldFollow.current))messageArea.current.scrollTop=messageArea.current.scrollHeight;},[conversation.id,visibleContent]);
  useEffect(() => {
    // Display only: rebuild from durable runs without queueing a save.
    const shown = chatView(baseRef.current);
    if (JSON.stringify(shown) !== JSON.stringify(storedRef.current)) { storedRef.current = shown; if (mounted.current) setStored(shown); }
    for (const [id, before] of acceptedRuns.current) acceptedRuns.current.set(id, tasks.runs.find(run => run.id === before.id) || before);
  }, [tasks.runs, tasks.details, stored]);
  useEffect(() => {
    const ids = new Set(conversation.messages.map(message => message.taskId).filter((id): id is string => !!id));
    for (const id of ids) { const run = tasks.runs.find(item => item.id === id), detail = tasks.details[id]; if (run && (!detail || run.version > detail.run.version)) void tasks.load(id).catch(() => {}); }
  }, [conversation.id, conversation.messages, tasks.runs, tasks.details, tasks.load]);
  useEffect(() => { if (recordsOpen) for (const run of tasks.runs) if (!tasks.details[run.id]) void tasks.load(run.id).catch(() => {}); }, [recordsOpen, tasks.runs, tasks.details, tasks.load]);

  async function changeModel(model: string) {
    const efforts = config?.models.find(m => m.id === model)?.efforts || [];
    editConversation(conversation.id, item => ({ ...item, model, ...(efforts.length && !efforts.includes(item.effort) ? { effort: (efforts.includes('medium') ? 'medium' : efforts[0]) as Effort } : {}) })); setModelSaving(true); setError('');
    try { const result = await api<AiConfig>('/api/ai/config', json('PUT', { defaultModel: model, expectedRevision: config?.revision })); if (mounted.current) setConfig(result); }
    catch (e: any) { if (mounted.current) setError(`默认模型未能保存：${e.message}`, conversation.id); }
    finally { if (mounted.current) setModelSaving(false); }
  }

  async function send(quick?: TaskStartInput, queued?: QueuedTurn) {
    const active = storedRef.current.conversations.find(item => item.id === (queued?.conversationId||storedRef.current.selectedId))!;
    if(!active)return;
    if (conversationState(active) !== 'active') { setError('请先恢复此对话，再继续发送。', active.id); return; }
    const draft = uiRef.current[active.id] || freshUi();
    const attachedFiles=queued?.attachments||(!quick?active.pendingAttachments||[]:[]);
    const prompt = attachmentPrompt(quick?.input ?? active.input,attachedFiles);
    const requestedModel=queued?.submittedPayload?.modelId||queued?.request.modelId||active.model;
    const activeModel = config?.models.find(model => model.id === requestedModel);
    if (!prompt) return;
    if (draft.contextLoading) { setError('文件正在加入对话，请完成后再发送。', active.id); return; }
    if(!quick&&uploadsRef.current[active.id]?.length){setError(uploadsRef.current[active.id].some(item=>item.status==='error')?'请先重试或移除上传失败的附件。':'附件正在上传，请完成后再发送。',active.id);return;}
    const ongoing=activeConversationRun(active,tasks.runs,acceptedRuns.current.get(active.id));
    if(queued&&(sending.current.has(active.id)||ongoing&&queued.mode!=='followup'))return;
    if (!remoteChats.ready || configLoading) { setError('正在载入对话和模型配置，请稍后发送。', active.id); return; }
    if (!activeModel || !(activeModel.configured ?? config?.configured) || config?.assistant && !config.assistant.modelIds.includes(requestedModel)) { setError('请在助手设置中明确选择已配置且允许使用的模型。', active.id); return; }
    if (!queued?.submittedPayload && ongoing && !sending.current.has(active.id) && !attachedFiles.length && isTaskProgressQuestion(prompt)) {
      sending.current.add(active.id);
      setStarting(true, active.id);
      try {
        const detail = await api<AgentRunDetail>(`/api/projects/${encodeURIComponent(projectId)}/agent-runs/${encodeURIComponent(ongoing.id)}`);
        const id = quick?.requestId || crypto.randomUUID();
        const createdAt = new Date().toISOString();
        editConversation(active.id, item => ({
          ...item,
          input: !quick && item.input === active.input ? '' : item.input,
          messages: [...item.messages.filter(message => message.id !== id && message.id !== id + '-reply'),
            { id, role: 'user', content: prompt, status: 'complete', createdAt },
            { id: id + '-reply', role: 'assistant', content: taskProgressReply(detail.run), status: 'complete', createdAt }],
        }));
        if (queued) updateQueue(items => items.filter(item => item.request.requestId !== id));
        setError('', active.id);
      } catch (error: any) {
        setError(error.message || '暂时无法读取进度，输入已保留。', active.id);
        if (queued) updateQueue(items => items.map(item => item.request.requestId === queued.request.requestId ? { ...item, state: 'held', error: error.message } : item));
      } finally {
        sending.current.delete(active.id);
        setStarting(false, active.id);
      }
      return;
    }
    let inferred: ReturnType<typeof writingRequest> | undefined;
    if (!quick) {
      try {
        inferred = writingRequest(active.input, { projectId, path: draft.fileTarget || currentPath, content: currentContent, selection: draft.selection, pdfReference: !draft.fileTarget && draft.reference?.path.startsWith('PDF'), fileReference: !!draft.fileTarget });
      } catch (error: any) { setError(error.message, active.id); return; }
    }
    const reference=queued?.reference||(!quick&&draft.reference?draft.reference:!quick&&draft.taskScope==='selection'&&draft.selection?{path:draft.selection.path,content:draft.selection.text}:!quick&&draft.includeContext&&currentPath?{path:currentPath,content:currentContent}:undefined);
    if(!queued&&(sending.current.has(active.id)||queuedRef.current.some(item=>item.conversationId===active.id))){
      const request={...quick,...(!quick?inferred:{}),requestId:quick?.requestId||crypto.randomUUID(),input:prompt,modelId:active.model,...(activeModel.efforts?.includes(active.effort)?{effort:active.effort}:{}),...(attachedFiles.length?{attachments:attachedFiles.map(item=>item.id)}:{})};
      updateQueue(items=>[...items,{conversationId:active.id,createdAt:new Date().toISOString(),state:'waiting',mode:'followup',request,reference,...(attachedFiles.length?{attachments:attachedFiles}:{})}]);
      if(!quick)editConversation(active.id,item=>({...item,input:'',pendingAttachments:[]}));
      setError('',active.id);return;
    }
    sending.current.add(active.id); setStarting(true, active.id); setError('', active.id); setContextOpen(false); setHistoryOpen(false); setRecordsOpen(false);
    const now = new Date().toISOString();
    const attachment = reference;
    const user: ChatMessage = { id: quick?.requestId||crypto.randomUUID(), role: 'user', content: prompt, status: 'complete', createdAt: now, ...(attachment ? { attachment, contextPath: attachment.path } : {}), ...(attachedFiles.length?{attachments:attachedFiles}:{}) };
    const assistant: ChatMessage = { id: user.id+'-reply', role: 'assistant', content: '', status: 'streaming', createdAt: now, model: requestedModel, providerLabel };
    let submitted = false;
    let submittedPayload:AgentCreateInput|undefined=queued?.submittedPayload;
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
      editConversation(active.id, item => ({ ...item, input: quick||item.input!==active.input ? item.input : '', ...(!quick?{pendingAttachments:(item.pendingAttachments||[]).filter(attachment=>!attachedFiles.some(sent=>sent.id===attachment.id))}:{}), title: item.messages.length ? item.title : prompt.slice(0, 28), messages: [...item.messages.filter(message=>message.id!==user.id&&message.id!==assistant.id), user, assistant] }));
      submitted = true; setPhase(ongoing?'正在按新要求调整…':'', active.id);
      submittedPayload ||= structuredClone({targetId,...{ requestId: user.id, input, ...(quick?.attachments?.length?{attachments:quick.attachments}:attachedFiles.length?{attachments:attachedFiles.map(attachment=>attachment.id)}:{}), conversationId: active.id, expectedLastRunId, ...(ongoing&&ongoing.id===expectedLastRunId?{followUpOf:ongoing.id}:{}), modelId: requestedModel, ...(activeModel.efforts?.includes(queued?.request.effort||active.effort) ? { effort: queued?.request.effort||active.effort } : {}), ...(quick?.roleId ? { roleId: quick.roleId } : {}), ...(quick?.scope ? { scope: quick.scope } : {}), ...(quick?.buildId ? { buildId: quick.buildId } : {}), ...(quick?.diagnostic ? { diagnostic: quick.diagnostic } : {}), ...(!quick ? inferred : quick.writingTask ? { writingTask: quick.writingTask } : {}) }});
      const frozen=submittedPayload;
      updateQueue(items=>{const existing=items.find(item=>item.request.requestId===user.id);return existing?items.map(item=>item===existing?{...item,submittedPayload:frozen}:item):[...items,{conversationId:active.id,createdAt:now,state:'held',mode:'followup',request:{...frozen,input:prompt},submittedPayload:frozen,reference,attachments:attachedFiles}];});
      const run = await submitFrozenTurn(frozen,async()=>{const result=await api<{runs:AgentRun[]}>(`/api/projects/${encodeURIComponent(projectId)}/agent-runs`);return result.runs.find(run=>run.requestId===frozen.requestId);},onStartTask,!!queued?.submittedPayload);
      acceptedRuns.current.set(active.id, run);
      updateQueue(items=>items.filter(item=>item.request.requestId!==user.id));
      editConversation(active.id, item => reconcileAgentConversation({ ...item, messages: item.messages.map(message => message.id === user.id || message.id === assistant.id ? { ...message, taskId: run.id } : message) }, [run]));
    } catch (e: any) {
      if(submitted)updateQueue(items=>items.map(item=>item.request.requestId===user.id?{...item,state:'held',error:e.message||'发送未确认，内容已保留。'}:item));
      if(submitted)void tasks.refresh().catch(()=>{});
      if(submitted&&!queued)updateQueue(items=>items.some(item=>item.request.requestId===user.id)?items:[...items,{conversationId:active.id,createdAt:now,state:'held',mode:'followup',error:e.message||'发送未确认，内容已保留。',request:{...quick,...(!quick?inferred:{}),requestId:user.id,input:prompt,modelId:requestedModel,...(activeModel.efforts?.includes(active.effort)?{effort:active.effort}:{}),...(attachedFiles.length?{attachments:attachedFiles.map(item=>item.id)}:{})},reference,attachments:attachedFiles,submittedPayload}]);
      if (submitted) editConversation(active.id, item => ({ ...item, messages: item.messages.map(message => message.id === assistant.id ? { ...message, status: 'error', error: e.message || '消息未能发送' } : message) }));
      if (mounted.current) setError(e.message || '消息未能发送', active.id);
    } finally { sending.current.delete(active.id); if (mounted.current) { setStarting(false, active.id); setPhase('', active.id); } }
  }
  const sendQueuedRef=useRef(send);sendQueuedRef.current=send;
  useEffect(()=>{
    if(!remoteChats.ready||configLoading||tasks.loading)return;
    for(const turn of queuedRef.current){
      const known=tasks.runs.find(run=>run.requestId===turn.request.requestId);
      if(known){editConversation(turn.conversationId,item=>reconcileAgentConversation(item,[known]));updateQueue(items=>items.filter(item=>item.request.requestId!==turn.request.requestId));continue;}
      if(turn.state!=='waiting'||drainingTurns.current.has(turn.conversationId))continue;
      const owner=storedRef.current.conversations.find(item=>item.id===turn.conversationId);
      if(!owner||conversationState(owner)!=='active')continue;
      if(queuedRef.current.find(item=>item.conversationId===owner.id)?.request.requestId!==turn.request.requestId)continue;
      const ongoing=activeConversationRun(owner,tasks.runs,acceptedRuns.current.get(owner.id));
      if(sending.current.has(owner.id)||ongoing&&turn.mode!=='followup'||ongoing?.status==='cancelling')continue;
      // One project writer at a time. Other conversations' draft queues remain visible.
      if(tasks.runs.some(run=>runIsActive(run)&&!run.scope.readOnly&&run.id!==ongoing?.id))continue;
      drainingTurns.current.add(owner.id);
      void sendQueuedRef.current(turn.request,turn).finally(()=>drainingTurns.current.delete(owner.id));
    }
  },[queuedTurns,tasks.runs,tasks.loading,configLoading,remoteChats.ready,conversationUi]);
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
    return sending.current.has(item.id)||uiRef.current[item.id]?.starting||!!activeConversationRun(item,tasks.runs,acceptedRuns.current.get(item.id))||queuedRef.current.some(turn=>turn.conversationId===item.id);
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
    <div className="ai-panel-heading"><button className="ai-conversation-switch" aria-label="AI 对话历史" title={'当前对话：' + conversation.title + '；点击切换历史'} aria-expanded={historyOpen} onClick={() => { setHistoryOpen(!historyOpen); setHistoryFilter('active'); setHistoryError(''); setHistoryNotice(''); setContextOpen(false); setRecordsOpen(false); }}><History size={13}/><span className="ai-current-conversation" aria-label="当前对话标题">{conversation.title}</span><small>历史</small><ChevronDown size={11}/></button><div className="ai-panel-actions"><button className="ai-new-conversation" aria-label="新建 AI 对话" title={remoteChats.ready && !configLoading ? '新建独立上下文，当前对话仍会保留' : '正在载入对话与模型，请稍后新建'} disabled={!remoteChats.ready || configLoading || !!remoteChats.changingId} onClick={startConversation}><Plus size={13}/><span>新对话</span></button><button className="icon-button" aria-label="关闭 AI 助手" onClick={onClose}><X size={15}/></button></div>{historyPopover}</div>
    <div className="ai-controls"><select className="ai-model-select" aria-label="AI 模型" title={`${conversation.model} · ${providerLabel} ${selectedModel?.plan || ''}`} value={conversation.model} disabled={!config || configLoading || modelSaving || busy} onChange={e => void changeModel(e.target.value)}>{(!conversation.model || config && !selectedModel) && <option value={conversation.model}>{conversation.model ? conversation.model + ' · 已不可用' : '请选择模型'}</option>}{(config?.models || []).map(model => <option key={model.id} value={model.id}>{model.providerLabel ? `${model.providerLabel} · ${model.label.replace('MiniMax-', '')}` : model.label}</option>)}</select><select className="ai-effort-select" aria-label="AI 推理强度" title={supportsEffort ? '推理强度' : '模型默认深度'} value={conversation.effort} disabled={busy || !supportsEffort} onChange={e => editConversation(conversation.id, item => ({ ...item, effort: e.target.value as Effort }))}>{supportsEffort ? EFFORTS.filter(item => allowedEfforts.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.label}</option>) : <option value={conversation.effort}>默认深度</option>}</select><button className={`ai-context-ring ${contextPercent >= 95 ? 'at-limit' : contextPercent >= 75 ? 'near-limit' : ''} ${phase ? 'compacting' : ''}`} aria-label={`上下文用量${meter.estimated ? '估算' : ''} ${contextPercent.toFixed(1)}%`} aria-expanded={contextOpen} title={`上下文${meter.estimated ? '约 ' : ''}${meter.tokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`} onClick={() => { setContextOpen(!contextOpen); setHistoryOpen(false); }}><svg width="27" height="27" viewBox="0 0 27 27" aria-hidden="true"><circle className="ring-track" cx="13.5" cy="13.5" r="11"/><circle className="ring-value" cx="13.5" cy="13.5" r="11" strokeDasharray={Math.PI * 22} strokeDashoffset={Math.PI * 22 * (1 - contextPercent / 100)}/></svg><span>{contextPercent < 1 ? '<1' : Math.round(contextPercent)}%</span></button>{contextOpen && <section className="ai-context-popover" aria-label="上下文用量详情"><header><strong>上下文窗口</strong><button className="icon-button" aria-label="关闭上下文详情" onClick={() => setContextOpen(false)}><X size={13}/></button></header><p>{meter.estimated ? '约 ' : ''}{meter.tokens.toLocaleString()} / {contextWindow.toLocaleString()} tokens · {contextPercent.toFixed(1)}%</p><small>{requestContext ? '最近一次主助手请求（不含尚未发送的草稿）；包含系统、工具及已读材料。' : '仅聊天文字估算；尚无助手请求读数，未计系统及工具材料。'} 自动压缩阈值为模型窗口的70%，累计消耗不作为上下文读数。</small>{requestContext?.lastCompaction && <small>本任务已压缩 {requestContext.compactions} 次：约 {requestContext.lastCompaction.beforeTokens.toLocaleString()} → {requestContext.lastCompaction.afterTokens.toLocaleString()} tokens；保留最近 {requestContext.lastCompaction.retainedMessages} 条请求消息，系统指令及原始记录保留。</small>}{requestContext?.compactionError && <small>压缩失败：{requestContext.compactionError}</small>}{activeCheckpoint && <><small>旧记录已压缩 {activeCheckpoint.round} 次 · 早期 {activeCheckpoint.messageCount} 条消息</small><details><summary>查看旧记录连续性摘要</summary><pre>{activeCheckpoint.summary}</pre></details></>}</section>}</div>
    {remoteChats.warning && <p className="ai-error" role="alert">{remoteChats.warning}</p>}
    {(configError || config && !isConfigured) && <div className="ai-config-notice" role="status"><AlertCircle size={15}/><div><strong>{configError ? '无法读取 AI 配置' : 'AI 助手尚未配置'}</strong><p>{configError || '此模型的服务尚未配置。可在模型设置中添加 API 与凭据。'}</p><button onClick={() => openModelSettings('assistant')}><Settings2 size={12}/>配置模型与 API</button><button onClick={() => void loadConfig()} disabled={configLoading}><RefreshCw size={12}/>重新读取配置</button></div></div>}
    {invalidModel && <div className="ai-model-invalid" role="alert">{conversation.model ? '历史模型已不可用。请选择模型后再继续，原记录会保留。' : '尚未选择默认模型。请明确选择模型后再发送。'}</div>}
    {!taskModelAllowed && <div className="ai-model-invalid">此模型未加入助手允许列表，请在助手设置中明确配置。</div>}
    {phase && <div className="ai-compaction-status" role="status"><LoaderCircle size={12} className="spin"/>{phase}</div>}
    {recordsOpen && <section className="ai-record-drawer" aria-label="助手操作记录列表"><header><strong>操作记录</strong><button className="icon-button" aria-label="关闭操作记录" onClick={() => setRecordsOpen(false)}><X size={13}/></button></header><div role="listbox" aria-label="历史操作">{recordRuns.map(run => <button key={run.id} role="option" aria-selected={tasks.selectedId === run.id} onClick={() => openRecord(run)}><span>{run.input}</span><small>{agentResultDisplay(run, builds).label} · {new Date(run.createdAt).toLocaleString('zh-CN')}</small></button>)}{!recordRuns.length && <p>还没有工具或文件操作记录。</p>}</div></section>}
    <div className="ai-messages" ref={messageArea} onScroll={e => { const el = e.currentTarget; shouldFollow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} aria-label="AI 对话内容" aria-busy={busy}>
      {!conversation.messages.length ? <div className="ai-chat-empty"><h2>有什么可以帮你？</h2></div> : conversation.messages.map(message => {
        const run = message.taskId ? tasks.runs.find(item => item.id === message.taskId) : undefined;
        const detail = message.taskId ? tasks.details[message.taskId] : undefined;
        const operations = message.role === 'assistant' && runHasOperations(run, detail);
        const result = run ? agentResultDisplay(run, builds) : undefined;
        return <article className={`ai-message ${message.role}`} key={message.id} data-run-id={message.role === 'assistant' ? message.taskId : undefined} aria-label={message.role === 'user' ? '你的消息' : 'AI 回复'}>{message.contextPath && <details className="ai-history-snapshot"><summary><FileText size={11}/>{message.contextPath} · 当时快照</summary><small>{new Date(message.createdAt).toLocaleString('zh-CN')} · 历史参考材料</small><pre>{message.attachment?.content || '旧记录未包含快照正文。'}</pre></details>}<div className="ai-message-content">{operations && result && !result.active && <p className="ai-message-status">当时回复（保留原文）；当前版本状态请查看下方操作记录。</p>}{message.content ? message.role === 'assistant' ? <AiMarkdown text={message.content}/> : message.content : message.status === 'streaming' ? <span className="ai-generating"><LoaderCircle size={13} className="spin"/>{operations ? '正在处理…' : '正在思考…'}</span> : message.status === 'stopped' ? '本轮已停止。' : message.error ? '' : '未收到回复内容。'}</div>{!!message.attachments?.length&&<MessageAttachments projectId={projectId} attachments={message.attachments} onPreview={setPreview}/>} {message.error && <div className="ai-message-error"><AlertCircle size={12}/>{operations && result && !result.active ? `当时中断原因：${message.error}。当前处理方式请查看操作记录。` : message.error}</div>}{message.status === 'stopped' && message.content && <div className="ai-message-status">本轮已停止 · 已保留收到的内容</div>}{message.content && <div className="ai-message-actions"><button className="icon-button" aria-label={message.role === 'assistant' ? '复制 AI 回复' : '复制问题'} title="复制内容" onClick={() => void copy(message)}>{copiedId === message.id ? <Check size={12}/> : <Copy size={12}/>}</button>{message.role === 'assistant' && (message.model || message.usage || run?.usage) && <details className="ai-message-info"><summary aria-label="回复信息" title="查看模型与用量"><Info size={12}/></summary><div><span>{[message.providerLabel, message.model].filter(Boolean).join(' · ') || '回复用量'}</span>{message.usage ? <span>输入 {message.usage.prompt_tokens.toLocaleString()} · 输出 {message.usage.completion_tokens.toLocaleString()} tokens</span> : run && <span>{run.usage.modelCalls} 次模型调用 · {run.usage.estimated ? '约 ' : ''}{run.usage.tokens.toLocaleString()} tokens</span>}{message.finishReason === 'length' && <span>回复达到长度上限，内容可能不完整。</span>}</div></details>}</div>}{operations && run && <details className="ai-operation-record" open={!!run.pendingDecision}><summary><ListChecks size={12}/><span>操作记录</span>{runIsActive(run) && <LoaderCircle size={11} className="spin"/>}<span className={'task-status tone-' + result?.tone}>{result?.label}</span><ChevronDown size={12}/></summary><AgentTaskPanel compact runId={run.id} tasks={tasks} builds={builds} onOpenFile={onOpenFile} onViewBuild={onViewBuild}/></details>}</article>;
      })}
    </div>
    {(error || storageWarning || taskError) && <div className="ai-chat-error" role="alert"><AlertCircle size={14}/><span>{error || storageWarning || taskError}</span><button className="icon-button" aria-label="关闭 AI 提示" onClick={() => { setError(''); setStorageWarning(''); tasks.clearError(); }}><X size={12}/></button></div>}
    <div className={`ai-composer ${dragging?'ai-attachment-dragging':''}`} onDragEnter={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();dragDepth.current++;setDragging(true);}}} onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}}} onDragLeave={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();if(--dragDepth.current<=0){dragDepth.current=0;setDragging(false);}}}} onDrop={event=>{if(event.dataTransfer.files.length){event.preventDefault();dragDepth.current=0;setDragging(false);addFiles(Array.from(event.dataTransfer.files));}}}>
      {dragging&&<section className="ai-attachment-drop-hint"><Paperclip size={16}/>松开以添加图片或文件</section>}
      <div className="ai-composer-context">
        <button type="button" className="ai-context-chip" aria-label="查看本轮上下文" aria-expanded={quoteOpen} title={reference?.path || (taskScope === 'selection' ? selection?.path : currentPath)} onClick={() => setQuoteOpen(!quoteOpen)}>
          <FileText size={13}/><span>{reference ? (reference.path.startsWith('PDF') ? 'PDF 选文' : reference.path.split('/').pop()) : taskScope === 'selection' ? `所选文字 · ${selection?.text.length || 0} 字` : '当前论文'}</span><ChevronDown size={11}/>
        </button>
        {(reference || taskScope === 'selection') && <button type="button" className="icon-button" aria-label="移除引用选文" disabled={busy} onClick={() => { updateUi(conversation.id, { reference: undefined, fileTarget: undefined, selection: undefined, taskScope: currentPath ? 'file' : 'readOnly', writingTask: { kind: 'focused', outputMode: 'suggest', verification: 'none' } }); setQuoteOpen(false); }}><X size={12}/></button>}
        <button type="button" className={`ai-options-toggle ${optionsOpen ? 'active' : ''}`} aria-label="更多对话操作" aria-expanded={optionsOpen} onClick={() => { setOptionsOpen(!optionsOpen); setQuoteOpen(false); }}><SlidersHorizontal size={13}/>更多</button>
      </div>
      {quoteOpen && <div className="ai-quote-preview">
        <small>{reference?.path || (taskScope === 'selection' ? selection?.path : currentPath) || '当前对话'}</small>
        {reference || taskScope === 'selection' ? <pre>{reference?.content || selection?.text}</pre> : <p>{`可按需读取当前论文的整个写作目录。${currentPath ? `当前查看 ${currentPath}。` : ''}`}</p>}
      </div>}
      {optionsOpen && <section className="ai-conversation-more" aria-label="更多对话操作">
        <div className="ai-options-actions">
          <button disabled={busy || !currentPath} onMouseDown={event=>event.preventDefault()} onClick={() => { captureSelection(); setOptionsOpen(false); }}>使用源码选区</button>
          <button onClick={() => openModelSettings('assistant')}>模型设置</button>
          <button onClick={() => { setRecordsOpen(!recordsOpen); setOptionsOpen(false); setHistoryOpen(false); setContextOpen(false); }}>操作记录</button>
          <button onClick={() => downloadText(`${projectId}-AI对话.json`, JSON.stringify(storedRef.current, null, 2))}>导出对话</button>
        </div>
      </section>}
      {contextLoading&&<p role="status" className="ai-composer-hint">正在添加文件…</p>}
      <ComposerAttachments projectId={projectId} attachments={pendingAttachments} uploads={currentUploads} onRemove={id=>editConversation(conversation.id,item=>({...item,pendingAttachments:(item.pendingAttachments||[]).filter(attachment=>attachment.id!==id)}))} onRemoveUpload={id=>removeUpload(conversation.id,id)} onRetry={upload=>void uploadAttachment(upload.file,conversation.id,upload)} onPreview={setPreview}/>
      <input type="file" hidden multiple accept={ATTACHMENT_ACCEPT} ref={fileInput} aria-label="选择 AI 附件" onChange={event=>{addFiles(Array.from(event.currentTarget.files||[]));event.currentTarget.value='';}}/>
      {queuedTurns.filter(turn=>turn.conversationId===conversation.id).map(turn=><section key={turn.request.requestId} className="ai-queued-turn" aria-label="待发送消息"><div role="status"><strong>{turn.state==='held'?'发送待核对':turn.mode==='followup'?'准备跟进':'已排队'}</strong><span>{turn.state==='held'?turn.error:turn.mode==='followup'?'正在同步上一条消息，随后立即按新要求调整。':currentRun?.status==='waiting_confirmation'?'上一轮等待审阅，请先接受或停止建议。':'上一轮结束后自动发送。'}</span><p>{turn.request.input}</p></div>{turn.state==='held'&&<button onClick={()=>{void tasks.refresh().then(()=>updateQueue(items=>items.map(item=>item.request.requestId===turn.request.requestId?{...item,state:'waiting',error:undefined}:item)));}}>核对后重试</button>}<button onClick={()=>{editConversation(conversation.id,item=>({...item,input:item.input.trim()?turn.request.input+'\n\n'+item.input:turn.request.input,pendingAttachments:uniqueAttachments([...(item.pendingAttachments||[]),...(turn.attachments||[])])}));updateQueue(items=>items.filter(item=>item.request.requestId!==turn.request.requestId));}} disabled={drainingTurns.current.has(conversation.id)}>取消排队</button></section>)}
      <textarea aria-label="AI 消息" onPaste={event=>{const files=Array.from(event.clipboardData.items).filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter((file):file is File=>!!file);if(files.length){event.preventDefault();addFiles(files);}}} placeholder={isConfigured ? '提问，或粘贴、拖入图片与文件…' : '配置模型与 API 后可在此发送消息'} value={conversation.input} onChange={e => editConversation(conversation.id, item => ({ ...item, input: e.target.value }))} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send(); } }} rows={3}/><div className="ai-composer-toolbar"><button type="button" className="ai-composer-attach" aria-label="添加图片或文件" title="添加图片或文件，也可拖入或粘贴图片" disabled={!remoteChats.ready||starting} onClick={()=>fileInput.current?.click()}><Paperclip size={15}/></button><span className="ai-composer-hint">图片 / 文件 · Enter 发送</span>{currentRun && <button className="ai-stop" aria-label="停止当前操作" onClick={() => void tasks.action('cancel', {}, currentRun.id)}><Square size={12}/>停止</button>}<button className="ai-send" disabled={!isConfigured || !taskModelAllowed || (!conversation.input.trim()&&!pendingAttachments.length) || attachmentsBlocked || contextLoading || configLoading || modelSaving || !remoteChats.ready} aria-label={willQueue?'跟进当前任务':'发送 AI 消息'} onClick={() => void send()}><SendHorizontal size={15}/>{willQueue&&<span>立即跟进</span>}</button></div></div>
    {preview&&<AttachmentPreviewDialog preview={preview} onClose={()=>setPreview(undefined)}/>}
  </aside>;
}
