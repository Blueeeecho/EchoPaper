import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { editorCommands } from './editorCommands';
import { beginPaneResize } from './paneResize';
import ProjectLibrary,{type CreateMode}from'./components/ProjectLibrary';
import ZipProjectImport from './components/ZipProjectImport';
import ModelSettings from './components/ModelSettings';
import SourceEditor,{type EditorHistoryAvailability} from './components/SourceEditor';
import {undo,redo} from '@codemirror/commands';
import BuildProgress from './components/BuildProgress';
import BuildIssuesPanel from './components/BuildIssuesPanel';
import {buildStatusLabel,issueCounts} from './buildIssueSummary';
import { autocompletion } from '@codemirror/autocomplete';
import type { ReferenceIndex } from '../shared/reference-types';
import type { PdfSyncForward, PdfSyncInverse } from '../shared/sync-types';
import { referenceCompletion } from './referenceCompletion';
import { latexCompletion } from './latexCompletion';
import { sourceLocationEffect } from './sourceLocation';
import './text-selection.css';
import SelectionTranslation from './components/SelectionTranslation';
import { findSourceWord,sourceWordAt,scoreWordContext,type SyncWordHint } from './syncWords';
import { replaceSelectedText, type EditSelection } from './editReview';
import { migrateBrowserChats } from './migrateChats';
import AiEditDialog from './components/AiEditDialog';
import ReferencePanel from './components/ReferencePanel';
import VersionCompare from './components/VersionCompare';
import Backups from './components/Backups';
import KeyboardHelp from './components/KeyboardHelp';
import DeadlineCountdown from './components/DeadlineCountdown';
import ConferenceDropdown from './components/ConferenceDropdown';
import { AlertCircle, AlertTriangle, Archive, ArrowRight, BookOpen, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleHelp, Columns2, Crosshair, Download, FileCode2, Files, FileText, FolderPlus, GitBranch, History, Info, LoaderCircle, MessageSquareText, MoreHorizontal, Pencil, Play, Plus, RefreshCw, Save, Search, Settings2, Sparkles, Square, Terminal, Wifi, WifiOff, X, Languages, Undo2, Redo2, Home } from 'lucide-react';
import { STAGES, STAGE_LABELS, type Build, type FileDocument, type FileEntry, type Project, type Stage, type WorkspaceEvent } from '../shared/types';
import { api, ApiError, downloadText, json, prettyDate, queryPath } from './api';
import PdfPreview from './components/PdfPreview';
import AiPanel, { type AssistantSend, type TaskStartInput } from './components/AiPanel';
import { useProjectTasks } from './useProjectTasks';
import { bindEditorSessionPageLifecycle, createEditorSession } from './editorSessions';
import FileTree from './components/FileTree';
import FileCreateDialog from './components/FileCreateDialog';
import { ProjectSettings, Reviews, Submissions, Versions } from './components/Lifecycle';

import{initialWorkspace,workspaceSessionKey,normalizeWorkspaceSession,readSession,writeSession,resumeFile,type WorkspaceSession,type WorkspaceView}from'./workspaceSession';

const noDiagnostics:import('../shared/types').Diagnostic[]=[];
type View=WorkspaceView;
type Toast = { id: number; message: string; error: boolean };
type ProjectConfigConflict = { projectId: string; attempted: Partial<Project>; current?: Project };
const pathUrl = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
const textual = (path: string) => !/\.(pdf|png|jpg|jpeg|gif|webp|ico|zip|gz|woff2?|ttf|otf|eps|mp4|docx|pptx|xlsx)$/i.test(path);
const draftKey = (id: string, path: string) => `motai:draft:${id}:${path}`;
const paperSessionKey = (id: string) => `${workspaceSessionKey}:paper:${id}`;
function readPaperSession(id: string): WorkspaceSession | undefined {
  const saved = normalizeWorkspaceSession(readSession(paperSessionKey(id)));
  return saved?.projectId === id ? saved : undefined;
}
type FrozenWordSource={path:string;line:number;column?:number;stale:boolean;warning?:string};
const frozenWordSource=(buildId:string,hint:SyncWordHint)=>api<FrozenWordSource>(`/api/builds/${encodeURIComponent(buildId)}/sync/word?${new URLSearchParams({word:hint.word,before:hint.before,after:hint.after})}`);

const statusLabel = buildStatusLabel;

function Modal({ title, children, onClose, wide = false }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { function key(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); } window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'wide' : ''}`}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭弹窗"><X size={18}/></button></div>{children}</section></div>;
}

function NewProjectModal({ onClose, onCreated, notify, initialMode='new' }: { initialMode?:CreateMode;onClose: () => void; onCreated: (p: Project) => void; notify: (m: string, e?: boolean) => void }) {
  const [mode, setMode] = useState<'new' | 'import'>(initialMode==='import'?'import':'new'); const [id, setId] = useState(''); const [title, setTitle] = useState(''); const [template, setTemplate] = useState(initialMode==='empty'?'empty':'english'); const [importPath, setImportPath] = useState(''); const [busy, setBusy] = useState(false);
  async function create(e: React.FormEvent) { e.preventDefault(); setBusy(true); try { const p = await api<Project>('/api/projects', json('POST', { id: id.trim(), title: title.trim(), template, ...(mode === 'import' ? { importPath: importPath.trim() } : {}) })); onCreated(p); onClose(); notify('论文工作空间已建立'); } catch (error: any) { notify(error.message, true); } finally { setBusy(false); } }
  return <Modal title="建立论文工作空间" onClose={onClose}><div className="segmented"><button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>从模板新建</button><button className={mode === 'import' ? 'active' : ''} onClick={() => setMode('import')}>导入已有工程</button></div><form onSubmit={create} className="modal-form"><label><span>项目标识</span><input autoFocus required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,79}" placeholder="例如 WWW、ICLR-2027" value={id} onChange={e => setId(e.target.value)}/><small>用于文件夹名称，最多 80 字符，支持英文字母、数字、点、短横线与下划线。</small></label><label><span>论文标题</span><input required value={title} placeholder="填写当前论文标题" onChange={e => setTitle(e.target.value)}/></label>{mode === 'new' ? <label><span>初始模板</span><select value={template} onChange={e => setTemplate(e.target.value)}><option value="empty">空项目 · 最小 LaTeX 文档</option><option value="english">英文论文 · article</option><option value="chinese">中文文章 · ctexart</option></select></label> : <label><span>已有工程文件夹</span><input required value={importPath} onChange={e => setImportPath(e.target.value)} placeholder="输入本机 LaTeX 工程的完整路径"/><small>将工程放在工作空间根目录后填入其完整路径。导入会复制文件并保留原目录。</small></label>}<div className="modal-actions"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle size={14} className="spin"/> : <FolderPlus size={14}/>}建立工作空间</button></div></form></Modal>;
}

export interface PaperHubNavigation { route:{paperId?:string;paperView?:WorkspaceView}; navigate:(path:string)=>void; registerGuard:(guard:(()=>Promise<boolean>)|undefined)=>void }
export default function App({hub}:{hub?:PaperHubNavigation}={}) {
  const hubMode=!!hub;
  const [initialSession]=useState(()=>{
    const recent=initialWorkspace(),id=hub?.route.paperId||recent.projectId;
    const saved=readPaperSession(id)||(recent.projectId===id?recent:{...recent,projectId:id,path:'',targetId:'',aiOpen:false});
    return {...saved,screen:hub?(hub.route.paperId?'project' as const:'library' as const):recent.screen,view:hub?(hub.route.paperView||'writing' as const):saved.view};
  });
  const bootSession=useRef<WorkspaceSession|undefined>(initialSession);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectConfigConflict,setProjectConfigConflict]=useState<ProjectConfigConflict>();
  const [projectConfigSaving,setProjectConfigSaving]=useState(false);
  const [projectId, setProjectId] = useState(initialSession.projectId);
  const [stageFilter, setStageFilter] = useState('all');
  const [view, setView] = useState<View>(initialSession.view);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [doc, setDoc] = useState<FileDocument | null>(null);
  const [content, setContent] = useState('');
  const [conflict, setConflict] = useState<FileDocument | null>(null);
  const conflictRef = useRef(conflict); conflictRef.current = conflict;
  const [editorBarrierLocked, setEditorBarrierLocked] = useState(false);
  const editorBarrierLockedRef = useRef(false);
  const editorSession = useRef<ReturnType<typeof createEditorSession> | undefined>(undefined);
  const bufferVersion = useRef(0);
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [builds, setBuilds] = useState<Build[]>([]);
  const [targetId, setTargetId] = useState(initialSession.targetId);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode,setCreateMode]=useState<CreateMode>('new');
  const [libraryOpen,setLibraryOpen]=useState(initialSession.screen==='library');
  const [modelSettingsOpen,setModelSettingsOpen]=useState(false),[modelSettingsTab,setModelSettingsTab]=useState<'providers'|'translations'|'assistant'>('providers');
  useEffect(()=>{if(hubMode)return;const open=(event:Event)=>{const requested=(event as CustomEvent).detail?.tab;setModelSettingsTab(requested==='translations'?'translations':requested==='assistant'?'assistant':'providers');setModelSettingsOpen(true);};window.addEventListener('echopaper:open-model-settings',open);return()=>window.removeEventListener('echopaper:open-model-settings',open);},[hubMode]);
  const [zipOpen,setZipOpen]=useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<{ path: string; line: number; text: string }[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [consoleTab, setConsoleTab] = useState<'issues' | 'log'>('issues');
  const [taskBuildId, setTaskBuildId] = useState('');
  const pendingTaskPreview = useRef('');
  const [consoleOpen, setConsoleOpen] = useState(() => localStorage.getItem('motai:focus:console:v1') === 'true');
  const [showProjects, setShowProjects] = useState(() => localStorage.getItem('motai:focus:projects:v1') === 'true');
  const [showFiles, setShowFiles] = useState(() => localStorage.getItem('motai:focus:files:v1') === 'true');
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [layoutMenu, setLayoutMenu] = useState(false);
  const [aiOpen, setAiOpen] = useState(initialSession.aiOpen);
  const [aiStarted, setAiStarted] = useState(false);
  const [editorPercent, setEditorPercent] = useState(initialSession.editorPercent);
  const [helpOpen, setHelpOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [conferenceOpen,setConferenceOpen]=useState(false);
  useEffect(()=>setConferenceOpen(false),[projectId]);
  const [lineTarget, setLineTarget] = useState<{line:number;hint?:SyncWordHint;column?:number}>();
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [aiEditSelection, setAiEditSelection] = useState<EditSelection>();
  const [previewBuildId, setPreviewBuildId] = useState('');
  const [syncJump, setSyncJump] = useState<{id:number;buildId:string;locations:PdfSyncForward['locations'];hint?:SyncWordHint}>();
  const [syncNotice,setSyncNotice]=useState('');
  const syncRequest=useRef(0);
  const [references, setReferences] = useState<ReferenceIndex>({entries:[],labels:[],warnings:[]});
  const chatFlush = useRef<(() => Promise<void>) | undefined>(undefined);
  const captureChatFlush = useCallback((flush: (() => Promise<void>) | undefined) => { chatFlush.current = flush; }, []);
  const assistantSend = useRef<{ projectId: string; send: AssistantSend } | undefined>(undefined);
  const pendingAssistantInputs = useRef<{ projectId: string; targetId: string; input: TaskStartInput }[]>([]);
  const upload = useRef<HTMLInputElement>(null);
  const uploadDirectory=useRef('manuscript');
  const [fileDirectory,setFileDirectory]=useState('manuscript'),[fileUploading,setFileUploading]=useState(false),[fileCreation,setFileCreation]=useState<{kind:'file'|'directory';directory:string}>();
  useEffect(()=>{setFileDirectory('manuscript');setFileCreation(undefined);},[projectId]);
  const contentRef = useRef(content); const docRef = useRef(doc); const projectRef = useRef(projectId); const pathRef = useRef(selectedPath); const savingRef = useRef(false); const pendingExternal = useRef(false); const editorRef = useRef<EditorView | null>(null);
  const [editorHistory,setEditorHistory]=useState<EditorHistoryAvailability>({canUndo:false,canRedo:false});
  const captureHistory=useCallback((next:EditorHistoryAvailability)=>setEditorHistory(old=>old.canUndo===next.canUndo&&old.canRedo===next.canRedo?old:next),[]);
  const runEditorHistory=(command:typeof undo)=>{const editor=editorRef.current;if(!editor||editor.state.readOnly||editor.composing||fileLoading)return;command(editor);editor.focus();};
  const captureEditor = useCallback((editor:EditorView)=>{editorRef.current=editor;},[]);
  const resizeCleanup=useRef<(()=>void)|undefined>(undefined);
  useEffect(()=>()=>resizeCleanup.current?.(),[]);
  const currentLoad = useRef(0); const loadedProject = useRef('');
  contentRef.current = content; docRef.current = doc; projectRef.current = projectId; pathRef.current = selectedPath;
  const project = projects.find(p => p.id === projectId);
  const tasks = useProjectTasks(projectId);
  const targetRef = useRef(targetId); targetRef.current = targetId;
  const isDirty = !!doc && content !== doc.content;
  const latest = useMemo(() => builds.filter(b => b.targetId === targetId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0], [builds, targetId]);
  const lastSuccess = useMemo(() => builds.filter(b => b.targetId === targetId && b.status === 'succeeded' && b.pdf).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0], [builds, targetId]);
  const busyBuild = latest && ['queued', 'running'].includes(latest.status);
  const previewBuild = builds.find(b => b.id === previewBuildId && b.targetId === targetId && b.status === 'succeeded' && b.pdf) || lastSuccess;
  const previewIdentity=useRef(''); previewIdentity.current=`${projectId}:${targetId}:${previewBuild?.id||''}`;
  const pdfUrl = previewBuild?.pdf ? `/api/builds/${encodeURIComponent(previewBuild.id)}/artifacts/${encodeURIComponent(previewBuild.pdf)}` : undefined;
  const selectedTarget = project?.targets.find(t => t.id === targetId);
  const relevantDirty = isDirty && !!selectedTarget && selectedPath.startsWith(selectedTarget.main.slice(0, selectedTarget.main.lastIndexOf('/') + 1));
  const stale = !!lastSuccess && (!!lastSuccess.stale || latest?.status !== 'succeeded' || relevantDirty);
  useEffect(()=>setSyncNotice(''),[previewBuild?.id]);
  const diagnostics = latest?.diagnostics || noDiagnostics;
  const diagnosticCounts=useMemo(()=>issueCounts(diagnostics),[diagnostics]);
  const errors=diagnosticCounts.error+diagnosticCounts.reference+diagnosticCounts.placeholder,warnings=diagnosticCounts.warning;
  const sourceDiagnostics=diagnostics;
  const consoleBuild = builds.find(build => build.id === taskBuildId) || latest;
  useEffect(() => setTaskBuildId(''), [projectId]);
  const diagnosticsStale=Boolean(latest?.stale||relevantDirty);
  const previousCompile=useRef<{id?:string;status?:string;project?:string;target?:string}>({});
  useEffect(()=>{const before=previousCompile.current;if(before.project===projectId&&before.target===targetId&&['queued','running'].includes(before.status||'')&&latest?.status==='failed'){setConsoleTab('issues');setConsoleOpen(true);}previousCompile.current={id:latest?.id,status:latest?.status,project:projectId,target:targetId};},[latest?.id,latest?.status,projectId,targetId]);
  const notify = useCallback((message: string, error = false) => { const id = Date.now() + Math.random(); setToasts(old => [...old.slice(-3), { id, message, error }]); setTimeout(() => setToasts(old => old.filter(t => t.id !== id)), error ? 9000 : 4500); }, []);
  const captureAssistantSend = useCallback((send: AssistantSend | undefined) => {
    if (!send) { if (assistantSend.current?.projectId === projectId) assistantSend.current = undefined; return; }
    assistantSend.current = { projectId, send };
    const pending = pendingAssistantInputs.current.filter(item => item.projectId === projectId);
    pendingAssistantInputs.current = pendingAssistantInputs.current.filter(item => item.projectId !== projectId);
    for (const item of pending) {
      if (item.targetId !== targetRef.current) notify('编译目标已切换，请重新发起快捷操作。', true);
      else void send(item.input).catch(error => notify(error.message, true));
    }
  }, [projectId, notify]);

  const refreshReferences = useCallback(async (id: string) => { const value = await api<ReferenceIndex>(`${pathUrl(id)}/references`); if (projectRef.current === id) setReferences(value); }, []);
  useEffect(() => { setReferences({entries:[],labels:[],warnings:[]}); setPreviewBuildId(''); setSyncJump(undefined);setSyncNotice(''); if(projectId) void refreshReferences(projectId).catch(()=>{}); }, [projectId, refreshReferences]);
  useEffect(() => { setPreviewBuildId(pendingTaskPreview.current); pendingTaskPreview.current = ''; setSyncJump(undefined);setSyncNotice(''); }, [targetId]);
  const completionRoot=selectedTarget?.main.slice(0,selectedTarget.main.lastIndexOf('/'));
  const sourceCompletion = useMemo(() => autocompletion({defaultKeymap:false,interactionDelay:0,activateOnTyping:true,activateOnCompletion:completion=>/^\\(?:input|include|includegraphics|bibliography|addbibresource|cite[a-z]*|(?:eq)?ref)$/.test(completion.label),override:[referenceCompletion(references),...(/\.(?:tex|sty|cls)$/i.test(selectedPath)?[latexCompletion(files,selectedPath,completionRoot)]:[])]}), [references,files,selectedPath,completionRoot]);
  const refreshProjects = useCallback(async () => { const result = await api<{ projects: Project[] }>('/api/projects'); setProjects(result.projects); return result.projects; }, []);
  const refreshFiles = useCallback(async (id: string) => { const result = await api<{ files: FileEntry[] }>(`${pathUrl(id)}/files`); if (projectRef.current === id) setFiles(result.files); return result.files; }, []);
  const refreshBuilds = useCallback(async (id: string) => { const result = await api<{ builds: Build[] }>(`${pathUrl(id)}/builds`); if (projectRef.current === id) setBuilds(result.builds); }, []);

  const loadFile = useCallback(async (path: string, line?: number, projectOverride?: string, hint?:SyncWordHint,column?:number) => {
    const id = projectOverride || projectRef.current; if (!id) return;
    const token = ++currentLoad.current;
    setSelectedPath(path); pathRef.current = path; setConflict(null); setLineTarget(line?{line,hint,column}:undefined); setDoc(null); setContent(''); setSavedAt('');
    if (!textual(path)) { loadedProject.current=id;setFileLoading(false);return; }
    setFileLoading(true);
    try {
      const result = await api<FileDocument>(`${pathUrl(id)}/file?path=${queryPath(path)}`);
      if (token !== currentLoad.current || id !== projectRef.current) return;
      setDoc(result); docRef.current = result; loadedProject.current = id;
      let initial = result.content;
      try { const draft = JSON.parse(localStorage.getItem(draftKey(id, path)) || 'null'); if (draft && typeof draft.content === 'string' && draft.content !== result.content) { initial = draft.content; if (draft.baseHash !== result.hash) setConflict(result); notify('已恢复此文件尚未保存的本地草稿'); } } catch { /* invalid browser storage is ignored */ }
      setContent(initial); contentRef.current = initial;
    } catch (error: any) { if (token === currentLoad.current) notify(error.message, true); }
    finally { if (token === currentLoad.current) setFileLoading(false); }
  }, [notify]);

  const inspectExternal = useCallback(async () => {
    const id = projectRef.current, path = pathRef.current;
    if (!id || !path || !textual(path)) return;
    if (savingRef.current) { pendingExternal.current = true; return; }
    try {
      const disk = await api<FileDocument>(`${pathUrl(id)}/file?path=${queryPath(path)}`);
      if (projectRef.current !== id || pathRef.current !== path || !docRef.current || disk.hash === docRef.current.hash) return;
      if (contentRef.current !== docRef.current.content) setConflict(disk);
      else { setDoc(disk); docRef.current = disk; setContent(disk.content); contentRef.current = disk.content; setSavedAt('已同步外部修改'); }
    } catch { /* preserve local draft when disk file disappears */ }
  }, []);

  const save = useCallback(async (expectedOverride?: string): Promise<boolean> => {
    while (savingRef.current) await new Promise(resolve => setTimeout(resolve, 20));
    const base = docRef.current, text = contentRef.current, id = projectRef.current, path = pathRef.current;
    if (!base || !id || !path || text === base.content && expectedOverride === undefined) return true;
    savingRef.current = true; setSaving(true);
    try {
      const result = await api<FileDocument>(`${pathUrl(id)}/file`, json('PUT', { path, content: text, expectedHash: expectedOverride ?? base.hash }));
      if (projectRef.current === id && pathRef.current === path) {
        setDoc(result); docRef.current = result; setConflict(null); setSavedAt('已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
        if (contentRef.current === text) localStorage.removeItem(draftKey(id, path));
      }
      return true;
    } catch (error: any) {
      if (error instanceof ApiError && error.status === 409) { if (error.data.current) setConflict(error.data.current); else notify('文件已在外部改变。请下载草稿后重新载入文件。', true); }
      else notify(error.message, true);
      return false;
    } finally { savingRef.current = false; setSaving(false); if (pendingExternal.current) { pendingExternal.current = false; void inspectExternal(); } }
  }, [notify, inspectExternal]);

  useEffect(() => {
    if (!projectId) return;
    const session = createEditorSession({
      id: crypto.randomUUID(), projectId,
      read: () => ({ projectId: projectRef.current, path: loadedProject.current === projectRef.current && docRef.current?.path === pathRef.current ? pathRef.current : '', dirty: !!docRef.current && contentRef.current !== docRef.current.content, bufferVersion: bufferVersion.current }),
      flush: async () => !conflictRef.current && await save(),
      onLock: locked => { editorBarrierLockedRef.current = locked; setEditorBarrierLocked(locked); if (!locked) void inspectExternal(); }
    });
    editorSession.current = session;
    const unbindPageLifecycle = bindEditorSessionPageLifecycle(session);
    void session.sync().catch(() => {});
    const heartbeat = setInterval(() => void session.sync().catch(() => {}), 10000);
    return () => { unbindPageLifecycle(); clearInterval(heartbeat); if (editorSession.current === session) editorSession.current = undefined; void session.dispose(); };
  }, [projectId, save, inspectExternal]);
  useEffect(() => { void editorSession.current?.sync().catch(() => {}); }, [projectId, selectedPath, content, doc?.hash]);
  const changeEditorContent = useCallback((value: string) => {
    if (editorBarrierLockedRef.current) return;
    contentRef.current = value; bufferVersion.current++; setContent(value);
    void editorSession.current?.sync().catch(() => {});
  }, []);
  const startAgentTask = useCallback(async (input: TaskStartInput) => {
    const id = projectRef.current, target = targetRef.current;
    if (!id || !target) throw new Error('请先选择论文和编译目标。');
    const needsSavedContext = !!(input.scope?.selection || input.diagnostic || input.buildId || input.roleId === 'organizer');
    if (needsSavedContext) {
      if (conflictRef.current) throw new Error('请先处理源码保存冲突，再使用此文件操作。');
      if (editorBarrierLockedRef.current) throw new Error('助手正在同步当前文件，请稍后使用此文件操作。');
      if (!await save()) throw new Error('未保存的编辑内容尚未同步，操作未启动。');
    }
    if (id !== projectRef.current || target !== targetRef.current) throw new Error('论文或编译目标已切换，任务未启动。');
    await editorSession.current?.sync();
    return tasks.create({ ...input, requestId: input.requestId || crypto.randomUUID(), targetId: target });
  }, [save, tasks.create]);
  function launchAgentTask(input: TaskStartInput) {
    setAiOpen(true); setAiStarted(true);
    if (assistantSend.current?.projectId === projectId) void assistantSend.current.send(input).catch(error => notify(error.message, true));
    else pendingAssistantInputs.current.push({ projectId, targetId, input });
  }
  function beginSelectionTask() {
    const editor = editorRef.current;
    if (!editor || !doc || conflict || editor.state.readOnly) return notify('请先打开可编辑正文并处理保存冲突。', true);
    const { from, to } = editor.state.selection.main;
    if (from === to) return notify('请先选择需要助手处理的文本。', true);
    if (to - from > 50000) return notify('单次选区最多 50000 字符，请缩小范围。', true);
    const documentText = editor.state.doc.toString();
    launchAgentTask({ input: '润色所选文本，保留原意、事实、公式、LaTeX 命令及引用键，仅修改所选文字。完成后记录实际修改和检查结果。', roleId: 'polisher', scope: { selection: { path: selectedPath, from, to, documentText, selectedText: documentText.slice(from, to) } } });
  }
  function repairWithAgent(diagnostic: import('../shared/types').Diagnostic, build: Build) {
    launchAgentTask({ input: '修复此编译问题，先核对当前源码，采用最小修改并重新编译验证。不得虚构缺失事实或修改官方模板类文件。问题：' + diagnostic.message, roleId: 'repair', buildId: build.id, diagnostic: { message: diagnostic.message, file: diagnostic.file, line: diagnostic.line } });
  }
  function organizeWithAgent() {
    launchAgentTask({ input: '整理当前项目允许修改的文件，检查重复或失效资源与引用路径。必要时移动文件并同步可确定的引用，保留唯一当前主稿；不确定的路径和事实保留并说明。', roleId: 'organizer' });
  }

  useEffect(() => { refreshProjects().then(data => { if(initialSession.projectId&&!data.some(p=>p.id===initialSession.projectId&&!p.trashed)){setLibraryOpen(true);setView('writing');}setProjectId(old => data.some(p => p.id === old&&!p.trashed) ? old : data.find(p=>!p.trashed)?.id || ''); void migrateBrowserChats(data.map(p=>p.id)).catch(e=>notify(`对话迁移暂未完成：${e.message}`,true)); }).catch(e => notify(e.message, true)).finally(() => setLoading(false)); }, [refreshProjects, notify]);
  useEffect(() => {
    if (!projectId || loading) return;
    projectRef.current = projectId; localStorage.setItem('motai:project', projectId); setFiles([]); setBuilds([]); setDoc(null); setContent(''); setConflict(null); setSelectedPath(''); setLineTarget(undefined); currentLoad.current++;
    loadedProject.current='';
    const p=projects.find(p=>p.id===projectId),saved=readPaperSession(projectId)||(bootSession.current?.projectId===projectId?bootSession.current:undefined);
    const target=p?.targets.find(t=>t.id===saved?.targetId)||p?.targets[0];setTargetId(target?.id||'');
    setAiOpen(saved?.aiOpen??false);setEditorPercent(saved?.editorPercent??initialSession.editorPercent);
    void refreshBuilds(projectId).catch(e=>notify(e.message,true));
    void refreshFiles(projectId).then(entries=>{if(projectRef.current===projectId&&target)void loadFile(resumeFile(entries,saved?.path||'',target.main),undefined,projectId).finally(()=>{if(bootSession.current?.projectId===projectId)bootSession.current=undefined;});}).catch(e=>notify(e.message,true));
  }, [projectId, loading]);
  useEffect(() => { if (project && !project.targets.some(t => t.id === targetId)) setTargetId(project.targets[0]?.id || ''); }, [project, targetId]);

  useEffect(() => {
    const events = new EventSource('/api/events');
    events.onopen = () => { setConnected(true); void refreshProjects().catch(() => {}); const id = projectRef.current; if (id) { void refreshFiles(id).catch(() => {}); void refreshBuilds(id).catch(() => {}); void refreshReferences(id).catch(() => {}); void inspectExternal(); void editorSession.current?.sync().catch(() => {}); } }; events.onerror = () => setConnected(false);
    events.onmessage = event => {
      try {
        const data = JSON.parse(event.data) as WorkspaceEvent;
        if(data.type==='ai.config.changed'){window.dispatchEvent(new Event('echopaper:model-config-changed'));return;}
        if (data.type === 'project.changed') void refreshProjects().catch(() => {});
        if (data.projectId !== projectRef.current) return;
        if (data.type === 'editor.barrier') { if (data.barrier) void editorSession.current?.barrier(data.barrier); return; }
        if (data.type === 'editor.release') { if (data.barrier) editorSession.current?.release(data.barrier.id); return; }
        if (data.type === 'file.changed') { if(data.path && /\.(bib|tex)$/.test(data.path)) void refreshReferences(data.projectId).catch(()=>{}); void refreshFiles(data.projectId).catch(() => {}); if(data.path?.startsWith('manuscript/') || data.path?.startsWith('reviews/') || !data.path) void refreshBuilds(data.projectId).catch(() => {}); if (!data.path || data.path === pathRef.current) void inspectExternal(); }
        if (data.type === 'build.updated') { if (data.build) { const build = data.build; setBuilds(old => [...old.filter(b => b.id !== build.id), build]); } else void refreshBuilds(data.projectId).catch(() => {}); }
        if (data.type === 'review.changed') { void refreshFiles(data.projectId).catch(() => {}); void refreshProjects().catch(() => {}); }
      } catch { /* keep stream alive after malformed event */ }
    };
    return () => events.close();
  }, [refreshProjects, refreshFiles, refreshBuilds, refreshReferences, inspectExternal]);

  useEffect(() => {
    if (!doc || !projectId || !selectedPath || loadedProject.current !== projectId) return;
    if (content !== doc.content) { try { localStorage.setItem(draftKey(projectId, selectedPath), JSON.stringify({ content, baseHash: doc.hash, updatedAt: Date.now() })); } catch { notify('浏览器草稿空间不足，请及时保存文件', true); } }
    if (!isDirty || conflict || saving) return;
    const timer = setTimeout(() => { void save(); }, 1100);
    return () => clearTimeout(timer);
  }, [content, doc, isDirty, conflict, saving, projectId, selectedPath, save, notify]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if(modelSettingsOpen||libraryOpen||e.defaultPrevented)return; if (e.isComposing || e.keyCode===229) return; if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!conflict) keyActions.current.save(); } if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setSearchOpen(true); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [save, conflict, projectId, targetId, libraryOpen, modelSettingsOpen]);
  useEffect(() => { const leave = (e: BeforeUnloadEvent) => { if (contentRef.current !== docRef.current?.content && docRef.current) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave); }, []);
  useEffect(() => {
    if (!searchOpen || !search.trim() || !projectId) { setSearchResults([]); return; }
    let active = true; const timer = setTimeout(() => { api<{ results: { path: string; line: number; text: string }[] }>(`${pathUrl(projectId)}/search?q=${encodeURIComponent(search)}`).then(data => { if (active) setSearchResults(data.results); }).catch(e => { if (active) notify(e.message, true); }); }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [search, searchOpen, projectId, notify]);
  useEffect(() => {
    if(!lineTarget || !doc) return; let frame=0, attempts=0;
    const apply=()=>{const editor=editorRef.current;
      if(!editor || !editor.dom.isConnected || editor.state.doc.toString()!==contentRef.current){if(attempts++<90)frame=requestAnimationFrame(apply);return;}
      const line=editor.state.doc.line(Math.min(Math.max(1,lineTarget.line),editor.state.doc.lines));
      const word=findSourceWord(editor.state.doc.toString(),line.number,lineTarget.hint,lineTarget.column);
      if(lineTarget.hint&&!word)setSyncNotice('未能在附近源码中可靠匹配这个词，已定位到附近行。');
      const anchor=word?.from??line.from;
      editor.dispatch({selection:{anchor},effects:[EditorView.scrollIntoView(anchor,{y:'center'}),sourceLocationEffect.of(word??null)]});editor.focus();setLineTarget(undefined);
    };frame=requestAnimationFrame(apply);return()=>cancelAnimationFrame(frame);
  },[lineTarget,doc]);

  useEffect(()=>{
    if(loading||!projectId||(!libraryOpen&&loadedProject.current!==projectId))return;
    const session:WorkspaceSession={version:1,screen:libraryOpen?'library':'project',projectId,view,path:selectedPath,targetId,aiOpen,editorPercent};
    writeSession(workspaceSessionKey,session);
    if(loadedProject.current===projectId&&selectedPath)writeSession(paperSessionKey(projectId),{...session,screen:'project'});
  },[loading,libraryOpen,projectId,view,selectedPath,targetId,aiOpen,editorPercent,doc]);
  useEffect(() => { if (aiOpen) setAiStarted(true); }, [aiOpen]);
  useEffect(() => { localStorage.setItem('motai:focus:console:v1', String(consoleOpen)); }, [consoleOpen]);
  useEffect(() => { localStorage.setItem('motai:focus:projects:v1', String(showProjects)); }, [showProjects]);
  useEffect(() => { localStorage.setItem('motai:focus:files:v1', String(showFiles)); }, [showFiles]);

  async function beforeBackup() { if (conflict) throw new Error('请先处理源码保存冲突，再备份或恢复。'); if (!await save()) throw new Error('源码尚未保存，已暂停备份。'); await chatFlush.current?.(); await migrateBrowserChats(projects.map(p=>p.id)); }
  async function beginAiEdit() {
    const editor = editorRef.current;
    if (!editor || !doc || conflict || /^reviews\/[^/]+\/response\/responses\.tex$/.test(selectedPath)) return notify('请先打开可编辑正文并处理保存冲突。', true);
    const {from,to} = editor.state.selection.main;
    if (from === to) return notify('请先在源码中选择需要润色的段落。', true);
    if (to-from>50000) return notify('单次选区最多 50000 字符，请缩小范围。', true);
    setAiEditSelection({projectId,path:selectedPath,from,to,text:content.slice(from,to),documentText:content});
  }
  async function applyAiEdit(selection: EditSelection, replacement: string) {
    if(projectRef.current!==selection.projectId||pathRef.current!==selection.path||conflict||editorBarrierLockedRef.current) throw new Error('当前文件已切换或存在冲突，已保留建议。');
    const next = replaceSelectedText(contentRef.current, selection, replacement);
    const assertIdentity=()=>{if(projectRef.current!==selection.projectId || pathRef.current!==selection.path || docRef.current?.path!==selection.path)throw new Error('文件已切换，已保留建议，未应用修改。');replaceSelectedText(contentRef.current,selection,replacement);};
    if(!await save()) throw new Error('保存原文失败，请先处理冲突。');
    assertIdentity();const baselineHash=docRef.current!.hash;
    await api(`${pathUrl(selection.projectId)}/checkpoints`,json('POST',{message:`应用 AI 建议前 · ${selection.path}`}));
    assertIdentity();if(docRef.current?.hash!==baselineHash)throw new Error('文件版本已变化，请重新审阅建议。');
    const result=await api<FileDocument>(`${pathUrl(selection.projectId)}/file`,json('PUT',{path:selection.path,content:next,expectedHash:baselineHash}));
    if(projectRef.current===selection.projectId&&pathRef.current===selection.path){setDoc(result);docRef.current=result;setContent(result.content);contentRef.current=result.content;localStorage.removeItem(draftKey(selection.projectId,selection.path));}
    notify('已保存版本并应用所选 AI 修改；可在版本记录中恢复。');
  }
  function insertReference(value: string) {
    const editor = editorRef.current;
    if(!editor || !doc || conflict || editorBarrierLockedRef.current || /^reviews\/[^/]+\/response\/responses\.tex$/.test(selectedPath)) return notify('请先打开可编辑正文。',true);
    setReferenceOpen(false); const range=editor.state.selection.main;editor.dispatch({changes:{from:range.from,to:range.to,insert:value},selection:{anchor:range.from+value.length}});editor.focus();
  }
  async function locatePdf(requestedLine?:number,clickedHint?:SyncWordHint) {
    const request=++syncRequest.current;
    const id=previewBuild?.id, projectAtStart=projectId, identity=previewIdentity.current, path=selectedPath, editor=editorRef.current;
    if(!id||!editor||!path.endsWith('.tex')) return notify('请选择已编译目标中的 .tex 源码。',true);
    try { const line=requestedLine??editor.state.doc.lineAt(editor.state.selection.main.head).number;const hint=clickedHint??sourceWordAt(editor.state.doc.toString(),editor.state.selection.main.head)?.hint;
      let result:PdfSyncForward;
      try{result=await api<PdfSyncForward>(`/api/builds/${encodeURIComponent(id)}/sync/forward?path=${queryPath(path)}&line=${line}`);}
      catch(error){
        if(!(error instanceof ApiError)||error.status!==404||!hint)throw error;
        const matched=await frozenWordSource(id,hint);
        if(matched.path!==path)throw new Error('这个词没有该源码文件的可靠编译记录。');
        result={locations:[],sourceLine:matched.line,lineDistance:Math.abs(line-matched.line),stale:matched.stale,warning:matched.warning};
      }
      if(request!==syncRequest.current||projectRef.current!==projectAtStart||previewIdentity.current!==identity||pathRef.current!==path)return;
      editor.dispatch({effects:sourceLocationEffect.of(findSourceWord(editor.state.doc.toString(),line,hint)??null)});
      setSyncJump({id:Date.now(),buildId:id,locations:result.locations,hint});setSyncNotice(result.warning||((result.stale||isDirty)?'定位基于该次编译源码，当前编辑可能尚未编译。':''));
    }catch(e:any){notify(e.message,true);}
  }
  async function locateSource(page:number,x:number,y:number,hint?:SyncWordHint) {
    const request=++syncRequest.current;
    const id=previewBuild?.id, projectAtStart=projectId, identity=previewIdentity.current;if(!id)return;
    try {
      let result:PdfSyncInverse|FrozenWordSource;
      try{result=await api<PdfSyncInverse>(`/api/builds/${encodeURIComponent(id)}/sync/inverse?page=${page}&x=${x}&y=${y}`);}
      catch(error){if(!(error instanceof ApiError)||error.status!==404||!hint)throw error;result=await frozenWordSource(id,hint);}
      if(request!==syncRequest.current||projectRef.current!==projectAtStart||previewIdentity.current!==identity)return;
      let chosen:{path:string;line:number;column?:number}=result,matchedHint=hint;
      if(hint){
        const candidates=[{path:result.path,line:result.line,column:result.column},...('alternatives' in result?result.alternatives||[]:[])];
        const documents=new Map(await Promise.all([...new Set(candidates.map(c=>c.path))].map(async path=>{
          if(pathRef.current===path&&docRef.current)return[path,contentRef.current] as const;
          try{const file=await api<FileDocument>(`${pathUrl(projectAtStart)}/file?path=${queryPath(path)}`);return[path,file.content] as const;}catch{return[path,''] as const;}
        })));
        const matches=candidates.flatMap(candidate=>{
          const content=documents.get(candidate.path)||'',word=findSourceWord(content,candidate.line,hint,candidate.column);
          const target=word&&sourceWordAt(content,word.from);return target?.hint?[{...candidate,line:target.line,column:word!.from-content.lastIndexOf('\n',word!.from-1),from:word!.from,score:scoreWordContext(target.hint,hint)}]:[];
        }).sort((a,b)=>b.score-a.score);
        const best=matches[0],other=best&&matches.find(m=>m.path!==best.path||m.from!==best.from);
        const unique=best&&(!other||best.score>other.score);
        if(unique)chosen=best;
        if(!unique||best.score<8){
          if(!unique)matchedHint=undefined;
          try{const fallback=await frozenWordSource(id,hint);chosen=fallback;matchedHint=hint;result=fallback;}catch{/* Geometry remains useful when no stronger frozen-source match exists. */}
        }
      }
      if(request!==syncRequest.current||projectRef.current!==projectAtStart||previewIdentity.current!==identity)return;
      setSyncNotice(result.warning||(result.stale?'当前源码与此 PDF 已不同，定位可能在附近行。':''));
      if(hint&&!matchedHint)setSyncNotice('附近定位记录存在歧义，未高亮不确定的词语。');
      await openFile(chosen.path,chosen.line,matchedHint,matchedHint?chosen.column:undefined);
    }catch(e:any){notify(e.message,true);}
  }
  function viewBuild(id:string) {if(!builds.some(b=>b.id===id&&b.targetId===targetId&&b.status==='succeeded'))return notify('未找到对应的历史编译。',true);setPreviewBuildId(id);}
  async function switchView(next: View) { setWorkspaceMenu(false); setLayoutMenu(false); if (conflict && ['submissions', 'history'].includes(next)) return notify('请先处理源码保存冲突，再创建快照或版本节点', true); if (isDirty && !conflict && !await save()) return; setView(next);hub?.navigate(`/papers/${encodeURIComponent(projectId)}/${next}`); }
  async function switchProject(id: string) { if(conflict)return notify('请先处理源码保存冲突，再切换论文。',true);if (isDirty && !await save()) return; await chatFlush.current?.();setProjectId(id); setView('writing');setLibraryOpen(false);hub?.navigate(`/papers/${encodeURIComponent(id)}/writing`); }
  async function openFile(path: string, line?: number,hint?:SyncWordHint,column?:number) { const id=projectRef.current;if(isDirty && !conflict && !await save())return;if(projectRef.current!==id)return;setView('writing');if(pathRef.current===path&&docRef.current?.path===path&&loadedProject.current===id){if(line)setLineTarget({line,hint,column});return;}await loadFile(path,line,id,hint,column); }
  async function compile() { setTaskBuildId(''); if (!project || !targetId || conflict || editorBarrierLockedRef.current) return; if (!await save()) return; try { const b = await api<Build>(`${pathUrl(project.id)}/builds`, json('POST', { targetId })); setBuilds(old => [...old.filter(x => x.id !== b.id), b]); } catch (e: any) { notify(e.message, true); } }
  async function manualSave(){
    if (editorBarrierLockedRef.current) return;
    setTaskBuildId('');
    const id=projectRef.current,path=pathRef.current,target=selectedTarget;
    if(conflict||!await save())return;
    if(!id||!target||!path.startsWith(target.main.slice(0,target.main.lastIndexOf('/')+1)))return;
    try{const b=await api<Build>(`${pathUrl(id)}/builds`,json('POST',{targetId:target.id}));if(projectRef.current===id)setBuilds(old=>[...old.filter(x=>x.id!==b.id),b]);}catch(e:any){notify(e.message,true);}
  }
  async function cancelBuild() { if (!latest) return; try { const b = await api<Build>(`/api/builds/${encodeURIComponent(latest.id)}/cancel`, json('POST', {})); setBuilds(old => old.map(x => x.id === b.id ? b : x)); } catch (e: any) { notify(e.message, true); } }
  const keyActions=useRef({save:()=>{},compile:()=>{},aiEdit:()=>{},locatePdf:(_line?:number,_hint?:SyncWordHint)=>{}});
  keyActions.current={save:()=>{void manualSave();},compile:()=>{void compile();},aiEdit:()=>{void beginAiEdit();},locatePdf:(line?:number,hint?:SyncWordHint)=>{void locatePdf(line,hint);}};
  const keyboardExtension=useMemo(()=>editorCommands({isTex:()=>/\.tex$/i.test(pathRef.current),save:()=>keyActions.current.save(),compile:()=>keyActions.current.compile(),aiEdit:()=>keyActions.current.aiEdit(),locatePdf:(line,hint)=>keyActions.current.locatePdf(line,hint),help:()=>setKeyboardOpen(true)}),[]);
  async function reloadProjectConfiguration(id: string) {
    const current=await api<Project>(pathUrl(id));
    setProjects(old=>old.map(item=>item.id===current.id?current:item));
    setProjectConfigConflict(old=>old?.projectId===id?{...old,current}:old);
    return current;
  }
  async function patchProject(patch: Partial<Project>) {
    if(!project||projectConfigSaving||projectConfigConflict?.projectId===project.id)return;
    const baseline=project;setProjectConfigSaving(true);
    try {
      const next=await api<Project>(pathUrl(baseline.id),json('PATCH',{...patch,expectedUpdatedAt:baseline.updatedAt}));
      setProjects(old=>old.map(item=>item.id===next.id?next:item));
    } catch(error:unknown) {
      if(error instanceof ApiError&&error.status===409){
        setProjectConfigConflict({projectId:baseline.id,attempted:patch});
        try{await reloadProjectConfiguration(baseline.id);}catch{/* Keep the attempted update visible until a fresh read succeeds. */}
        notify('项目设置已在其他窗口修改。已保留你刚选择的阶段，请比较最新设置后再编辑。',true);
      } else notify(error instanceof Error?error.message:'项目设置保存失败。',true);
    } finally{setProjectConfigSaving(false);}
  }
  async function createFileEntry(path:string) {
    if(!project||!fileCreation)return;const id=project.id,kind=fileCreation.kind;
    if(kind==='directory'){await api(`${pathUrl(id)}/directories`,json('POST',{path,expectedHash:null}));}
    else await api(`${pathUrl(id)}/file`,json('PUT',{path,content:'',expectedHash:null}));
    await refreshFiles(id);if(projectRef.current===id){if(kind==='directory')setFileDirectory(path);else if(textual(path))await openFile(path);notify(kind==='directory'?'目录已创建':'文件已创建');}
  }
  function selectUpload(directory:string){uploadDirectory.current=directory;upload.current?.click();}
  async function renameFile() { if (!project || !doc || !await save()) return; const to = window.prompt('新的文件路径', selectedPath); if (!to || to === selectedPath) return; try { const renamed = await api<FileDocument>(`${pathUrl(project.id)}/files/rename`, json('POST', { from: selectedPath, to, expectedHash: docRef.current?.hash })); await refreshFiles(project.id); await loadFile(renamed.path); notify('文件已重命名，请检查引用路径'); } catch (e: any) { notify(e.message, true); } }
  async function uploadFiles(list:FileList|File[]|null,directory=uploadDirectory.current) {
    if(!project||!list)return;const files=Array.from(list),id=project.id;
    if(!files.length){notify('请拖入文件；整目录请先新建目录，再上传其中的文件。',true);return;}
    setFileUploading(true);let uploaded=0;const failures:string[]=[];
    try{for(const file of files){try{const form=new FormData();form.append('file',file);await api(`${pathUrl(id)}/upload?directory=${queryPath(directory)}`,{method:'POST',body:form});uploaded++;}catch(error:any){failures.push(`${file.name}：${error.message}`);}}
      await refreshFiles(id);if(uploaded)notify(`已上传 ${uploaded} 个文件至 ${directory||'项目根目录'}`);if(failures.length)notify(`${failures.length} 个文件未上传：${failures.join('；')}`,true);
    }catch(error:any){notify(error.message,true);}finally{setFileUploading(false);if(upload.current)upload.current.value='';}
  }
  function startResize(e:React.PointerEvent<HTMLDivElement>){if(e.button!==0)return;e.preventDefault();resizeCleanup.current?.();const rect=e.currentTarget.parentElement!.getBoundingClientRect();resizeCleanup.current=beginPaneResize(window,e.currentTarget,e.pointerId,rect.left,rect.width,setEditorPercent);}
  function acceptDisk() { if (!conflict) return; downloadText(`${selectedPath.split('/').pop()}.draft.txt`, content); setDoc(conflict); docRef.current = conflict; setContent(conflict.content); contentRef.current = conflict.content; localStorage.removeItem(draftKey(projectId, selectedPath)); setConflict(null); notify('已载入磁盘版本，原编辑内容已下载为草稿'); }

  async function goLibrary(){if(conflict)return notify('请先处理源码保存冲突，再返回项目管理。',true);if(isDirty&&!await save())return;await chatFlush.current?.();setLibraryOpen(true);hub?.navigate('/papers');void refreshProjects().catch(e=>notify(e.message,true));}
  const createdProject=(p:Project)=>{setProjects(old=>[...old.filter(x=>x.id!==p.id),p]);setProjectId(p.id);setView('writing');setLibraryOpen(false);setCreateOpen(false);setZipOpen(false);hub?.navigate(`/papers/${encodeURIComponent(p.id)}/writing`);};
  useEffect(()=>{if(!hub)return;hub.registerGuard(async()=>{if(conflictRef.current){notify('请先处理源码保存冲突，草稿已保留。',true);return false;}if(editorBarrierLockedRef.current){notify('正在同步编辑内容，请稍后切换。',true);return false;}if(contentRef.current!==docRef.current?.content&&docRef.current&&!await save())return false;await chatFlush.current?.();return true;});return()=>hub.registerGuard(undefined);},[hub?.registerGuard,save,notify]);
  useEffect(()=>{if(!hub)return;const id=hub.route.paperId;if(!id){setLibraryOpen(true);return;}if(projectRef.current!==id)setProjectId(id);setLibraryOpen(false);setView(hub.route.paperView||'writing');},[hub?.route.paperId,hub?.route.paperView]);
  const projectDialog=createOpen&&<NewProjectModal key={createMode} initialMode={createMode} notify={notify} onClose={()=>setCreateOpen(false)} onCreated={createdProject}/>;
  const modelDialog=modelSettingsOpen&&<ModelSettings initialTab={modelSettingsTab} onClose={()=>setModelSettingsOpen(false)}/>;
  const zipDialog=zipOpen&&<ZipProjectImport onClose={()=>setZipOpen(false)} onCreated={createdProject}/>;
  if(libraryOpen)return <><ProjectLibrary projects={projects} loading={loading} onModelSettings={()=>{setModelSettingsTab('providers');setModelSettingsOpen(true);}} onOpen={id=>void switchProject(id)} onCreate={mode=>{setCreateMode(mode);setCreateOpen(true);}} onUpload={()=>setZipOpen(true)} onRefresh={()=>void refreshProjects().catch(e=>notify(e.message,true))} onPatch={async(p,patch)=>{try{const updated=await api<Project>(pathUrl(p.id),json('PATCH',{...patch,expectedUpdatedAt:p.updatedAt}));setProjects(old=>old.map(x=>x.id===p.id?updated:x));}catch(e:any){notify(e.message,true);void refreshProjects();}}}/>{projectDialog}{zipDialog}{modelDialog}<div className="toast-stack" aria-live="polite">{toasts.map(t=><div className={`toast ${t.error?'error':''}`} key={t.id}>{t.message}<button className="icon-button" aria-label="关闭通知" onClick={()=>setToasts(old=>old.filter(x=>x.id!==t.id))}><X size={13}/></button></div>)}</div></>;
  return <div className={`app-shell ${view === 'writing' ? 'focus-writing' : ''}`}>
    {(view !== 'writing' || showProjects || !project) && <aside className="project-sidebar"><a className="brand" href="#" onClick={e => {e.preventDefault();void goLibrary();}}><div className="brand-mark"><BookOpen size={21} strokeWidth={1.5}/></div><div><strong className="brand-wordmark">EchoPaper</strong><span>PAPER WORKSPACE</span></div></a><div className="sidebar-label"><span>我的论文</span><button className="icon-button" aria-label="新增论文" onClick={() => setCreateOpen(true)}><Plus size={15}/></button></div><div className="stage-filter"><select aria-label="按阶段筛选论文" value={stageFilter} onChange={e => setStageFilter(e.target.value)}><option value="all">所有阶段</option>{STAGES.map(s => <option value={s} key={s}>{STAGE_LABELS[s]}</option>)}</select><ChevronDown size={12}/></div><nav className="project-list">{projects.filter(p => !p.trashed&&!p.archived&&(stageFilter === 'all' || p.stage === stageFilter)).map(p => <button key={p.id} className={`project-card ${projectId === p.id ? 'active' : ''}`} onClick={() => void switchProject(p.id)}><div><span className="project-initial">{p.id.slice(0, 1).toUpperCase()}</span><strong>{p.id}</strong><span className={`stage-dot stage-${p.stage}`}/></div><p title={p.title}>{p.title}</p><span className="project-stage">{STAGE_LABELS[p.stage]}</span></button>)}</nav><button className="new-project-button" onClick={() => setCreateOpen(true)}><Plus size={15}/>新建 / 导入论文</button><div className="sidebar-bottom"><div className="local-workspace"><span className="local-icon"><Files size={18}/></span><div><strong>本地工作空间</strong><span>一篇论文，一份当前主稿</span></div></div><button onClick={() => setHelpOpen(true)} className="help-link"><CircleHelp size={14}/>使用说明<span>↗</span></button></div></aside>}
    <main className="main-workspace">{projectConfigConflict&&project&&projectConfigConflict.projectId===project.id&&<div className="conflict-warning" role="alert"><AlertTriangle size={17}/><div><strong>项目设置发生冲突</strong><span>{projectConfigConflict.attempted.stage?`你刚选择：${STAGE_LABELS[projectConfigConflict.attempted.stage]}。`:''}{projectConfigConflict.current?`磁盘阶段：${STAGE_LABELS[projectConfigConflict.current.stage]}。已载入最新设置，原选择保留在此提示中。`:'最新项目设置尚未读取成功，请重新读取后比较。'}</span></div><button className="button small" disabled={projectConfigSaving} onClick={()=>void reloadProjectConfiguration(projectConfigConflict.projectId).catch(error=>notify(error.message,true))}><RefreshCw size={12}/>重新读取</button><button className="button small" disabled={projectConfigSaving||!projectConfigConflict.current} onClick={()=>setProjectConfigConflict(undefined)}>已比较，继续编辑</button></div>}{view !== 'writing' && <header className="workspace-header"><div className="breadcrumb"><span>EchoPaper</span><ChevronRight size={12}/><strong>{project?.id || '开始写作'}</strong></div><div className="header-right"><span className="local-badge">LOCAL</span><span className={`connection ${connected ? '' : 'offline'}`}>{connected ? <Wifi size={12}/> : <WifiOff size={12}/>} {connected ? '已连接本地文件' : '正在连接'}</span></div></header>}
      {project ? <>{view !== 'writing' && <><div className="paper-heading"><div><div className="paper-kicker"><span>{project.venue || '研究论文'}</span><span className="dot-separator">·</span><select aria-label="论文阶段" className={`stage-select stage-${project.stage}`} disabled={projectConfigSaving||projectConfigConflict?.projectId===project.id} value={project.stage} onChange={e => void patchProject({ stage: e.target.value as Stage })}>{STAGES.map(s => <option value={s} key={s}>{STAGE_LABELS[s]}</option>)}</select>{project.deadline && <span className="deadline">截止 {project.deadline}</span>}</div><h1 title={project.title}>{project.title}</h1></div><button className="icon-button settings-shortcut" title="项目设置" aria-label="项目设置" onClick={() => void switchView('settings')}><Settings2 size={18}/></button></div>
        <nav className="workspace-tabs" aria-label="工作区导航">{([{ id: 'writing', label: '写作与编译', icon: Pencil }, { id: 'reviews', label: '审稿与回复', icon: MessageSquareText }, { id: 'submissions', label: '投稿快照', icon: Archive }, { id: 'history', label: '版本记录', icon: History }, { id: 'settings', label: '项目设置', icon: Settings2 }, {id:'backups',label:'备份与恢复',icon:Archive}] as const).map(tab => <button className={view === tab.id ? 'active' : ''} onClick={() => void switchView(tab.id)} key={tab.id}><tab.icon size={15}/>{tab.label}</button>)}<div className="tab-spacer"/><span className="project-code"><GitBranch size={12}/>{project.id}</span></nav>
        <div className="build-bar"><div className="build-target"><span>编译目标</span><select aria-label="编译目标" value={targetId} onChange={e => { setTargetId(e.target.value); void refreshBuilds(projectId).catch(() => {}); }}>{project.targets.map(t => <option value={t.id} key={t.id}>{t.label}</option>)}</select></div><span className={`build-status ${latest?.status || ''} ${errors?'has-errors':warnings?'has-issues':''}`}>{busyBuild && latest ? <BuildProgress build={latest}/> : latest?.status === 'succeeded' ? (errors||warnings?<AlertTriangle size={13}/>:<CheckCircle2 size={13}/>) : latest?.status === 'failed' ? <AlertCircle size={13}/> : <Circle size={11}/>} {!busyBuild && statusLabel(latest)}{latest?.status === 'succeeded' && (latest.stale || relevantDirty) && <span className="unbuilt-badge">源码已变化</span>}</span><div className="toolbar-spacer"/><span className="compile-policy" title="自动保存不编译；主动保存源码或点击编译时才构建">保存时编译</span>{busyBuild ? <button className="button danger-button small" onClick={cancelBuild}><Square size={12}/>取消编译</button> : <button className="button primary compile-button" disabled={!targetId || !!conflict || editorBarrierLocked} onClick={compile}><Play size={13} fill="currentColor"/>编译</button>}</div></>}
        {view === 'writing' && <div className="focus-toolbar"><button className="focus-tool" aria-label="返回项目管理" title="返回项目管理" onClick={()=>void goLibrary()}><Home size={16}/></button><button className={`focus-project ${showProjects ? 'active' : ''}`} aria-label="切换论文" title="切换论文" aria-expanded={showProjects} onClick={() => setShowProjects(!showProjects)}><BookOpen size={17}/><strong>{project.id}</strong><ChevronDown size={11}/></button><span className="focus-divider"/><button className={`focus-tool ${showFiles ? 'active' : ''}`} aria-label="切换项目文件" title="项目文件与搜索" aria-expanded={showFiles} onClick={() => setShowFiles(!showFiles)}><Files size={15}/><span>文件</span></button><select className="focus-target" aria-label="编译目标" value={targetId} onChange={e => { setTargetId(e.target.value); void refreshBuilds(projectId).catch(() => {}); }}>{project.targets.map(t => <option value={t.id} key={t.id}>{t.label}</option>)}</select><span className={`focus-status ${latest?.status || ''} ${errors ? 'has-errors' : warnings ? 'has-issues' : ''}`} title={`${statusLabel(latest)}${latest?.stale || relevantDirty ? ' · 源码已变化' : ''}`}>{busyBuild && latest ? <BuildProgress build={latest}/> : latest?.status === 'failed' ? <AlertCircle size={13}/> : latest?.status === 'succeeded' ? (errors?<AlertCircle size={13}/>:warnings?<AlertTriangle size={13}/>:<CheckCircle2 size={13}/>) : <Circle size={11}/>}{!busyBuild && <span>{statusLabel(latest)}{latest?.status === 'succeeded' && (latest.stale || relevantDirty) ? ' · 待更新' : ''}</span>}</span><div className="conference-deadline-anchor"><DeadlineCountdown project={project} expanded={conferenceOpen} onConfigure={()=>setConferenceOpen(!conferenceOpen)}/>{conferenceOpen&&<ConferenceDropdown project={project} onClose={()=>setConferenceOpen(false)} onError={message=>notify(message,true)} onSaved={p=>{setProjects(old=>old.map(x=>x.id===p.id?p:x));notify('会议与截止时间已更新');}}/>}</div><span className={`focus-connection ${connected ? '' : 'offline'}`} title={connected ? '已连接本地文件' : '正在连接本地服务'}>{connected ? <Wifi size={13}/> : <WifiOff size={13}/>}</span><button className="focus-tool save-tool" aria-label="保存文件" title={conflict ? '请先处理保存冲突' : saving ? '正在保存' : isDirty ? '保存文件 (⌘S)' : savedAt || '已与磁盘同步'} disabled={!doc || !isDirty || !!conflict} onClick={() => void manualSave()}>{saving ? <LoaderCircle size={14} className="spin"/> : <Save size={14}/>}<span>{saving ? '保存中' : isDirty ? '保存' : '已保存'}</span></button><span className="compile-policy" title="自动保存不编译；主动保存源码或点击编译时才构建">保存时编译</span>{busyBuild ? <button className="button danger-button small" aria-label="取消编译" onClick={cancelBuild}><Square size={12}/>取消</button> : <button className="button primary compile-button" disabled={!targetId || !!conflict || editorBarrierLocked} onClick={compile}><Play size={12} fill="currentColor"/>编译</button>}<span className="focus-divider"/><button className={`focus-tool issues-tool ${errors ? 'has-errors' : warnings ? 'has-warnings' : ''} ${consoleOpen ? 'active' : ''}`} aria-label="切换编译提示" title="错误、引用检查与编译日志" aria-expanded={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)}>{errors ? <AlertCircle size={14}/> : <Terminal size={14}/>}<span>{diagnostics.length || '日志'}</span></button><span className="focus-divider"/><button className="focus-tool focus-shortcut" title="审稿与回复" aria-label="审稿与回复" onClick={() => void switchView('reviews')}><MessageSquareText size={15}/><span>审稿</span></button><button className="focus-tool focus-shortcut" title="版本记录" aria-label="版本记录" onClick={() => void switchView('history')}><History size={15}/><span>历史</span></button><button className="focus-tool settings-top" title="项目设置" aria-label="项目设置" onClick={() => void switchView('settings')}><Settings2 size={15}/></button><div className="workspace-menu-wrap"><button className={`focus-tool layout-button ${layoutMenu ? 'active' : ''}`} aria-label="布局选项" aria-expanded={layoutMenu} onClick={() => { setLayoutMenu(!layoutMenu); setWorkspaceMenu(false); }}><Columns2 size={15}/><span>布局</span><ChevronDown size={10}/></button>{layoutMenu && <div className="workspace-menu layout-menu" role="menu"><div className="workspace-menu-label">工作区布局</div><button role="menuitemcheckbox" aria-checked={showProjects} onClick={() => setShowProjects(!showProjects)}><BookOpen size={15}/>论文列表{showProjects && <Check size={14}/>}</button><button role="menuitemcheckbox" aria-checked={showFiles} onClick={() => setShowFiles(!showFiles)}><Files size={15}/>项目文件{showFiles && <Check size={14}/>}</button><button role="menuitemcheckbox" aria-checked={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)}><Terminal size={15}/>编译日志{consoleOpen && <Check size={14}/>}</button><div className="menu-separator"/><button role="menuitem" onClick={() => { setEditorPercent(50); setLayoutMenu(false); }}><Columns2 size={15}/>均分源码与预览</button><button role="menuitem" onClick={() => { setShowProjects(false); setShowFiles(false); setConsoleOpen(false); setAiOpen(false); setLayoutMenu(false); }}><FileCode2 size={15}/>专注写作</button></div>}</div><button className="focus-tool translation-toolbar-button" aria-label="翻译所选文字" aria-haspopup="dialog" title="按住 Ctrl（Mac 上为 ⌃，不是 ⌘）拖选文字翻译；未固定时点击外部关闭，或点击此按钮保持打开" onMouseDown={event=>event.preventDefault()} onClick={()=>window.dispatchEvent(new Event('echopaper:translate-selection'))}><Languages size={15}/><span>翻译</span></button><button className={`focus-tool ai-toolbar-button ${aiOpen ? 'active' : ''}`} aria-label="AI 助手" aria-expanded={aiOpen} title="AI 助手 · 可配置模型服务" onClick={() => setAiOpen(!aiOpen)}><Sparkles size={15}/><span>AI</span></button><div className="workspace-menu-wrap"><button className={`focus-tool workspace-menu-button ${workspaceMenu ? 'active' : ''}`} aria-label="工作区菜单" title="工作区：审稿、投稿与版本" aria-expanded={workspaceMenu} onClick={() => { setWorkspaceMenu(!workspaceMenu); setLayoutMenu(false); }}><MoreHorizontal size={18}/></button>{workspaceMenu && <div className="workspace-menu" role="menu"><div className="workspace-menu-label">论文工作区</div>{([{ id: 'reviews', label: '审稿与回复', icon: MessageSquareText }, { id: 'submissions', label: '投稿快照', icon: Archive }, { id: 'history', label: '版本记录', icon: History }, { id: 'settings', label: '项目设置', icon: Settings2 }, {id:'backups',label:'备份与恢复',icon:Archive}] as const).map(item => <button role="menuitem" key={item.id} onClick={() => void switchView(item.id)}><item.icon size={15}/>{item.label}<ChevronRight size={12}/></button>)}<div className="menu-separator"/><button role="menuitem" onClick={() => {setWorkspaceMenu(false);setReferenceOpen(true);}}><BookOpen size={15}/>文献与引用</button><button role="menuitem" onClick={() => {setWorkspaceMenu(false);setCompareOpen(true);}}><Columns2 size={15}/>版本对照</button><button role="menuitem" onClick={() => { setCreateOpen(true); setWorkspaceMenu(false); }}><FolderPlus size={15}/>新建 / 导入论文</button><button role="menuitem" onClick={() => {setKeyboardOpen(true);setWorkspaceMenu(false);}}><CircleHelp size={15}/>快捷键与补全</button><button role="menuitem" onClick={() => { setHelpOpen(true); setWorkspaceMenu(false); }}><CircleHelp size={15}/>使用说明</button></div>}</div></div>}
        {view === 'writing' ? <div className="writing-area"><div className="panels">{showFiles && <FileTree key={projectId} files={files} selected={selectedPath} directory={fileDirectory} uploading={fileUploading} onFolderSelect={setFileDirectory} onSelect={path => void openFile(path)} onNew={(kind,directory)=>setFileCreation({kind,directory})} onUpload={selectUpload} onDrop={(files,directory)=>void uploadFiles(files,directory)} onSearch={() => setSearchOpen(true)} onOrganize={organizeWithAgent}/>}<div className="editor-preview"><div className="editor-panel" style={{ flexBasis: `${editorPercent}%` }}><div className="panel-title editor-title"><div><div className="editor-history-buttons" role="group" aria-label="编辑历史"><button className="icon-button" aria-label="撤销" title="撤销（⌘Z / Ctrl+Z）" disabled={!doc||fileLoading||!editorHistory.canUndo} onMouseDown={event=>event.preventDefault()} onClick={()=>runEditorHistory(undo)}><Undo2 size={15}/></button><button className="icon-button" aria-label="重做" title="重做（⌘⇧Z / Ctrl+Shift+Z）" disabled={!doc||fileLoading||!editorHistory.canRedo} onMouseDown={event=>event.preventDefault()} onClick={()=>runEditorHistory(redo)}><Redo2 size={15}/></button></div><FileCode2 size={14}/><span title={selectedPath}>{selectedPath || '选择文件'}</span>{isDirty && <span className="unsaved-dot" title="尚未保存"/>}</div><div>{doc && <><button className="icon-button" aria-label="定位到 PDF" title="把光标所在源行定位到 PDF" disabled={!previewBuild} onClick={()=>void locatePdf()}><Crosshair size={14}/></button><button className="icon-button" aria-label="AI 选区润色" title="选中段落后生成并审阅 AI 修改" onClick={()=>void beginAiEdit()}><Sparkles size={14}/></button><button className="icon-button" aria-label="交给助手处理选区" title="把所选文字交给助手修改并记录结果" disabled={editorBarrierLocked} onMouseDown={event => event.preventDefault()} onClick={beginSelectionTask}><MessageSquareText size={14}/></button><button className="icon-button" title="重命名文件" aria-label="重命名文件" onClick={renameFile}><Pencil size={13}/></button></>}<button className="icon-button" title="重新载入文件" aria-label="重新载入文件" disabled={!selectedPath || isDirty} onClick={() => void loadFile(selectedPath)}><RefreshCw size={13}/></button></div></div>
          {conflict && <div className="conflict-warning"><AlertTriangle size={17}/><div><strong>检测到同时修改</strong><span>磁盘版本与当前编辑不同，已暂停自动保存。</span></div><button className="button small" onClick={() => { const el = document.getElementById('conflict-review'); el?.showPopover(); }}>比较并处理</button></div>}
          {editorBarrierLocked && <div className="editor-barrier-banner" role="status"><LoaderCircle size={12} className="spin"/>助手正在同步文件 · 暂停编辑</div>}
          <div className="editor-body">{fileLoading ? <div className="empty-state"><LoaderCircle size={24} className="spin"/><p>正在读取文件</p></div> : selectedPath && !textual(selectedPath) ? <div className="binary-preview">{/\.(png|jpe?g|gif|webp|svg)$/i.test(selectedPath) ? <img src={`${pathUrl(projectId)}/raw?path=${queryPath(selectedPath)}`} alt={selectedPath}/> : <div className="empty-state compact"><FileText size={40}/><h3>{selectedPath.split('/').pop()}</h3><p>此文件可下载后使用对应应用打开。</p></div>}<a className="button small" href={`${pathUrl(projectId)}/raw?path=${queryPath(selectedPath)}`} download><Download size={14}/>下载文件</a></div> : doc ? <SourceEditor workspaceId={projectId} restorePosition={!lineTarget} key={`${projectId}:${selectedPath}`} path={selectedPath} value={content} readOnly={editorBarrierLocked || /^reviews\/[^/]+\/response\/responses\.tex$/.test(selectedPath)} completion={sourceCompletion} keyboard={keyboardExtension} onReady={captureEditor} onHistoryChange={captureHistory} onChange={changeEditorContent} diagnostics={sourceDiagnostics} diagnosticsStale={diagnosticsStale} diagnosticBuildId={latest?.id}/> : <div className="empty-state"><FileCode2 size={32}/><h3>选择一份文件</h3><p>在左侧文件树中打开当前主稿或写作笔记。</p></div>}</div>
          <div className="editor-footer"><span>{editorBarrierLocked ? <span className="editor-barrier-status"><LoaderCircle size={11} className="spin"/>助手同步中</span> : conflict ? <><AlertTriangle size={11}/>保存冲突</> : saving ? <><LoaderCircle size={11} className="spin"/>正在保存</> : isDirty ? <><Circle size={10}/>编辑中 · 即将自动保存</> : <><Check size={12}/>{savedAt || '已与磁盘同步'}</>}{diagnosticsStale&&sourceDiagnostics.some(d=>d.file===selectedPath)&&<span className="editor-issues-stale" title="提示来自上次编译；编辑后的标记仅供参考，请保存或编译后核对"> · 编译提示待更新</span>}</span><span>{doc ? `${content.split('\n').length} 行 · UTF-8` : '本地文件'}</span></div></div><div className="pane-resizer" role="separator" aria-label="调整编辑和预览宽度" aria-orientation="vertical" onPointerDown={startResize}/><div className="pdf-panel-container" style={{ flexBasis: `${100 - editorPercent}%` }}><PdfPreview key={`${projectId}:${targetId}`} projectId={projectId} targetId={targetId} buildId={previewBuild?.id} historical={!!previewBuild && previewBuild.id!==lastSuccess?.id} issuesBuild={latest} pdfDiagnostics={previewBuild?.diagnostics} onShowIssues={()=>{setConsoleTab('issues');setConsoleOpen(true);}} onReturnLatest={()=>setPreviewBuildId('')} onNavigateSource={(path,line)=>void openFile(path,line)} onViewBuild={viewBuild} onSourceLocate={locateSource} syncJump={syncJump} syncNotice={syncNotice} url={pdfUrl} stale={stale} status={latest?.status} buildDate={prettyDate(previewBuild?.finishedAt)}/></div></div>{aiStarted && <div className="ai-panel-host" hidden={!aiOpen}><AiPanel key={project.id} projectId={project.id} currentPath={loadedProject.current === projectId ? doc?.path || '' : ''} currentContent={loadedProject.current === projectId && doc ? content : ''} tasks={tasks} builds={builds} onStartTask={startAgentTask} onOpenFile={path => void openFile(path)} onViewBuild={id => { const build = builds.find(value => value.id === id); if (!build) { notify('该编译记录尚未载入，已重新读取记录。', true); void refreshBuilds(projectId).catch(() => {}); return; } setTaskBuildId(id); if (build) { if (build.targetId !== targetId) { pendingTaskPreview.current = build.status === 'succeeded' ? id : ''; setTargetId(build.targetId); } else if (build.status === 'succeeded') setPreviewBuildId(id); } setConsoleTab('issues'); setConsoleOpen(true); }} onClose={() => setAiOpen(false)} onFlushReady={captureChatFlush} onSendReady={captureAssistantSend}/></div>}</div>
          <div className={`build-console ${consoleOpen ? 'expanded' : ''}`}><div className="console-heading"><button className={`console-tab ${consoleTab === 'issues' ? 'active' : ''}`} onClick={() => { setConsoleTab('issues'); setConsoleOpen(true); }}><AlertCircle size={13}/>检查提示 <span className="count">{diagnostics.length}</span></button><button className={`console-tab ${consoleTab === 'log' ? 'active' : ''}`} onClick={() => { setConsoleTab('log'); setConsoleOpen(true); }}><Terminal size={13}/>编译日志</button><div className="toolbar-spacer"/>{consoleBuild && consoleBuild.status !== 'queued' && <a className="console-log-link" href={`/api/builds/${encodeURIComponent(consoleBuild.id)}/artifacts/compile.log`} download>下载完整日志</a>}{consoleBuild && <span className="build-id">{consoleBuild.id.slice(-12)}</span>}<button className="icon-button" aria-label={consoleOpen ? '收起编译面板' : '展开编译面板'} onClick={() => setConsoleOpen(!consoleOpen)}><ChevronDown size={14} style={{ transform: consoleOpen ? 'none' : 'rotate(180deg)' }}/></button></div>{consoleOpen && <div className="console-body">{consoleTab === 'log' ? <pre className="build-log">{consoleBuild?.log || '编译日志将在任务启动后实时显示。'}</pre> : <BuildIssuesPanel build={consoleBuild} references={references} sourceRoot={completionRoot} onRepair={repairWithAgent} onOpen={(path,line)=>void openFile(path,line)}/>}</div>}</div>
        </div> : view === 'reviews' ? <Reviews key={project.id} project={project} notify={notify} onOpen={path => void openFile(path)} onRefresh={() => { void refreshProjects(); void refreshFiles(projectId); }}/> : view === 'submissions' ? <Submissions key={project.id} project={project} targetId={targetId} notify={notify}/> : view === 'history' ? <Versions key={project.id} project={project} selectedPath={selectedPath} notify={notify} onRestored={() => { void loadFile(selectedPath); void refreshFiles(projectId); }}/> : view === 'backups' ? <Backups beforeBackup={beforeBackup} beforeRestore={beforeBackup}/> : <ProjectSettings project={project} notify={notify} onSaved={p => setProjects(old => old.map(x => x.id === p.id ? p : x))}/>}
      </> : <div className="welcome-page"><div className="welcome-rule"/><span className="eyebrow">A PLACE FOR YOUR NEXT PAPER</span><h1>从一个想法，<br/>到一篇完整的论文。</h1><p>源码、文献、投稿与审稿回复，<br/>都在同一个清晰的本地工作空间。</p><button className="button primary" onClick={() => setCreateOpen(true)}><Plus size={16}/>{loading ? '正在读取工作空间…' : '建立第一篇论文'}<ArrowRight size={16}/></button></div>}
      {view !== 'writing' && <footer className="workspace-footer"><span><span className={`live-dot ${connected ? '' : 'muted'}`}/>{connected ? '本地服务运行中' : '连接本地服务中'}</span><span>{project ? `${project.id} / ${STAGE_LABELS[project.stage]}` : 'EchoPaper · 论文工作台'}</span><span>文件保存在本机<span className="footer-divider">|</span>⌘ S 保存</span></footer>}
    </main>
    {view==='writing'&&project&&<SelectionTranslation key={`${project.id}:${targetId}`} projectId={project.id}/>}
    <input ref={upload} type="file" multiple hidden onChange={e => void uploadFiles(e.target.files)}/>
    {fileCreation&&<FileCreateDialog key={fileCreation.kind+fileCreation.directory} kind={fileCreation.kind} directory={fileCreation.directory} onCreate={createFileEntry} onClose={()=>setFileCreation(undefined)}/>}
    <div className="toast-stack" aria-live="polite">{toasts.map(t => <div className={`toast ${t.error ? 'error' : ''}`} key={t.id}>{t.error ? <AlertCircle size={16}/> : <CheckCircle2 size={16}/>}<span>{t.message}</span><button className="icon-button" onClick={() => setToasts(old => old.filter(x => x.id !== t.id))} aria-label="关闭通知"><X size={13}/></button></div>)}</div>
    {aiEditSelection && <AiEditDialog selection={aiEditSelection} onClose={()=>setAiEditSelection(undefined)} onApply={applyAiEdit}/>}
    {referenceOpen && project && <ReferencePanel key={project.id} projectId={project.id} onClose={()=>setReferenceOpen(false)} onNavigate={(path,line)=>{setReferenceOpen(false);void openFile(path,line);}} onInsert={insertReference} onChanged={()=>{void refreshReferences(projectId);void refreshFiles(projectId);}}/>}
    {compareOpen && project && <VersionCompare key={`${project.id}:${targetId}`} project={project} builds={builds} targetId={targetId} onClose={()=>setCompareOpen(false)}/>}
    {projectDialog}{zipDialog}{modelDialog}
    {searchOpen && <Modal title="在项目中搜索" onClose={() => setSearchOpen(false)} wide><div className="search-box"><Search size={18}/><input autoFocus placeholder="搜索源码、参考文献和笔记" aria-label="搜索关键词" value={search} onChange={e => setSearch(e.target.value)}/><kbd>⌘ ⇧ F</kbd></div><div className="search-results">{searchResults.map((r, i) => <button key={i} onClick={() => { setSearchOpen(false); void openFile(r.path, r.line); }}><div><FileText size={13}/><strong>{r.path}</strong><span>第 {r.line} 行</span></div><p>{r.text}</p></button>)}{!searchResults.length && <p className="search-empty">{search.trim() ? '没有找到匹配内容' : '输入关键词，查找当前论文的文件内容。'}</p>}</div></Modal>}
    {keyboardOpen && <KeyboardHelp onClose={()=>setKeyboardOpen(false)}/>}
    {helpOpen && <Modal title="EchoPaper 使用说明" onClose={() => setHelpOpen(false)}><div className="help-content"><p>默认聚焦源码和 PDF。左上角切换论文；点击「文件」展开目录；右上角「···」打开审稿、投稿、版本与项目设置。</p><ol><li><strong>写作：</strong>打开源码直接编辑，停顿后自动保存；⌘S 立即保存。</li><li><strong>编译：</strong>点击编译，或主动保存当前目标源码后编译。自动保存与文件监听不触发构建；首次编译可能下载依赖。</li><li><strong>配合 Codex：</strong>在聊天中要求修改同一份主稿；网页自动检测变化，同时修改时会保留双方内容供你处理。</li><li><strong>版本：</strong>在关键节点保存说明。投稿快照固定保存当时材料，后续修改不影响快照。</li><li><strong>审稿：</strong>按轮次整理原始意见、回复与正文修改位置，回复文档独立编译。</li></ol><p className="quiet">详细操作和验证边界见工作空间根目录的 README.md。</p></div></Modal>}
    {conflict && <div id="conflict-review" popover="auto" className="conflict-popover"><div className="modal-heading"><div><span className="eyebrow">CONFLICT RESOLUTION</span><h2>保留两份修改，再决定如何合并</h2></div><button className="icon-button" aria-label="关闭冲突比较" onClick={() => document.getElementById('conflict-review')?.hidePopover()}><X size={18}/></button></div><p className="quiet">{selectedPath} · 自动保存已暂停。你可以关闭此面板，在编辑器中手动合并后再次打开。</p><div className="conflict-columns"><div><h3>当前编辑草稿</h3><pre>{content}</pre></div><div><h3>磁盘上的最新内容</h3><pre>{conflict.content}</pre></div></div><div className="conflict-actions"><button className="button" onClick={() => downloadText(`${selectedPath.split('/').pop()}.draft.txt`, content)}><Download size={14}/>下载当前草稿</button><div className="toolbar-spacer"/><button className="button" onClick={acceptDisk}>载入磁盘版本并下载草稿</button><button className="button primary" onClick={async () => { const ok = await save(conflict.hash); if (ok) notify('已按你的选择保存当前编辑内容'); }}>以当前编辑内容保存</button></div></div>}
  </div>;
}
