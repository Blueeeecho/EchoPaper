import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,ArrowUpRight,BookOpen,ChevronRight,Files,FolderKanban,Home,LoaderCircle,Presentation,Search,Settings2,ShieldCheck,Sparkles,X,Archive,RefreshCw,FlaskConical,ChartNoAxesCombined,NotebookPen,PanelLeftClose,PanelLeftOpen} from 'lucide-react';
import PaperWorkspace from '../App';
import ModelSettings from '../components/ModelSettings';
import Backups from '../components/Backups';
import type {Project} from '../../shared/types';
import {STAGE_LABELS} from '../../shared/types';
import type {WorkspaceOverview,HubSection} from '../../shared/workspace-types';
import type {PresentationSummary} from '../../shared/presentation-types';
import {api,prettyDate} from '../api';
import {useToasts} from '../useToasts';
import {academicPath,academicRoute,type AcademicRoute} from './navigation';
import Topics from './Topics';
import Library from './Library';
import Presentations from './Presentations';
import HubDialog from './HubDialog';
import ConferenceCountdown from './ConferenceCountdown';
import ResearchLaunch from './ResearchLaunch';
import ResearchNotebook from './ResearchNotebook';
import {readSession,writeSession} from '../workspaceSession';
import {researchContextKey,currentResearchTopic,hasResearchScope,withResearchScope} from './researchContext';
import './academic.css';
import './workflow-shell.css';

const items=[['home','研究总览',Home],['topics','问题与选题',FolderKanban],['experiments','方案与实验',FlaskConical],['results','结果与证据',ChartNoAxesCombined],['papers','论文写作',BookOpen],['library','资料库',Files],['progress','工作日历',NotebookPen],['presentations','汇报演示',Presentation]] as const;
export default function AcademicHub(){
 const [route,setRoute]=useState<AcademicRoute>(()=>academicRoute(location.hash)),[overview,setOverview]=useState<WorkspaceOverview>(),[papers,setPapers]=useState<Project[]>([]),[decks,setDecks]=useState<PresentationSummary[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[settings,setSettings]=useState(false),[settingsTab,setSettingsTab]=useState<'assistant'|'translations'|'providers'>('assistant'),[backups,setBackups]=useState(false),[search,setSearch]=useState(''),[navigationExpanded,setNavigationExpanded]=useState(false);
 const [backupBusy,setBackupBusy]=useState(false),[backupGuardPending,setBackupGuardPending]=useState(false);
 const {toasts:messages,notify:report,dismiss:dismissToast}=useToasts();
 const [rememberedTopicId,setRememberedTopicId]=useState<string|undefined>(()=>readSession<{topicId?:string}>(researchContextKey)?.topicId);
 const activeTopic=currentResearchTopic(route,rememberedTopicId,overview?.topics||[]);
 const effectiveTopicId=route.topicId||activeTopic?.id;
 // With a single live topic, topic-scoped pages open it directly instead of asking the user to pick it.
 const soleTopic=(overview?.topics||[]).filter(t=>!t.archived);
 const scopedTopicId=effectiveTopicId||(soleTopic.length===1?soleTopic[0].id:undefined);
 const routeRef=useRef(route),guard=useRef<(()=>Promise<boolean>)|undefined>(undefined),navigationPending=useRef(false),historyIndex=useRef(0);routeRef.current=route;
 const registerGuard=useCallback((fn:(()=>Promise<boolean>)|undefined)=>{guard.current=fn;},[]);
 const commitRoute=useCallback((next:AcademicRoute,replace=false)=>{const path=academicPath(next);if(academicPath(routeRef.current)===path)return;if(!replace)historyIndex.current++;history[replace?'replaceState':'pushState']({...history.state,echopaperIndex:historyIndex.current},'',`#${path}`);routeRef.current=next;setRoute(next);},[]);
 const navigate=useCallback(async(path:string,onApproved?:()=>void)=>{const next=academicRoute(path);if(navigationPending.current)return;const same=academicPath(next)===academicPath(routeRef.current);if(same){onApproved?.();return;}navigationPending.current=true;try{if(guard.current&&!await guard.current())return;onApproved?.();commitRoute(next);}catch(e:any){report(e.message);}finally{navigationPending.current=false;}},[commitRoute,report]);
 const paperNavigate=useCallback((path:string)=>commitRoute(academicRoute(path)),[commitRoute]);
 const refresh=useCallback(async(strict=false)=>{try{const [o,p,d]=await Promise.all([api<WorkspaceOverview>('/api/workspace/overview'),api<{projects:Project[]}>('/api/projects'),api<{presentations:PresentationSummary[]}>('/api/presentations')]);setOverview(o);setPapers(p.projects);setDecks(d.presentations);setLoadError('');}catch(e:any){setLoadError(e.message);if(strict)throw e;}finally{setLoading(false);}},[]);
 const refreshAfterEdit=useCallback(()=>refresh(true),[refresh]);
 useEffect(()=>{const open=(event:Event)=>{const tab=(event as CustomEvent).detail?.tab;setSettingsTab(tab==='translations'?'translations':tab==='providers'?'providers':'assistant');setSettings(true);};window.addEventListener('echopaper:open-model-settings',open);return()=>window.removeEventListener('echopaper:open-model-settings',open);},[]);
 useEffect(()=>{void refresh();},[route.section,refresh]);
 useEffect(()=>{historyIndex.current=Number.isInteger(history.state?.echopaperIndex)?history.state.echopaperIndex:0;history.replaceState({...history.state,echopaperIndex:historyIndex.current},'');const restore=(previous:AcademicRoute)=>{const incoming=history.state?.echopaperIndex;if(Number.isInteger(incoming)&&incoming!==historyIndex.current)history.go(historyIndex.current-incoming);else history.replaceState({...history.state,echopaperIndex:historyIndex.current},'',`#${academicPath(previous)}`);};const changed=()=>{const next=academicRoute(location.hash),previous=routeRef.current;if(academicPath(next)===academicPath(previous)||navigationPending.current)return;navigationPending.current=true;void(async()=>{try{if(guard.current&&!await guard.current()){restore(previous);return;}historyIndex.current=Number.isInteger(history.state?.echopaperIndex)?history.state.echopaperIndex:historyIndex.current+1;history.replaceState({...history.state,echopaperIndex:historyIndex.current},'');routeRef.current=next;setRoute(next);}catch(e:any){restore(previous);report(e.message);}finally{navigationPending.current=false;}})();};window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[report]);
 const scopedPath=(path:string)=>academicPath(withResearchScope(academicRoute(path),activeTopic?.id));
 const navigateTo=(path:string)=>{void navigate(scopedPath(path));};
 const homeNavigate=(path:string)=>{const next=academicRoute(path);if(next.section==='progress'&&!next.topicId){void navigate(academicPath(next),()=>{setRememberedTopicId(undefined);writeSession(researchContextKey,{});});}else navigateTo(path);};
 useEffect(()=>{if(!route.topicId||!activeTopic)return;setRememberedTopicId(activeTopic.id);writeSession(researchContextKey,{topicId:activeTopic.id});},[activeTopic?.id,route.topicId]);
 async function chooseTopic(id:string){
  const next={...routeRef.current,topicId:id||undefined};
  await navigate(academicPath(next),()=>{setRememberedTopicId(id||undefined);writeSession(researchContextKey,{topicId:id||undefined});});
 }
 async function openBackups(){
  if(backupGuardPending)return;
  setBackupGuardPending(true);
  try{if(!guard.current||await guard.current())setBackups(true);}catch(error:any){report(error.message);}finally{setBackupGuardPending(false);}
 }
 const guardBackup=async()=>{
  setBackupGuardPending(true);
  try{return !guard.current||await guard.current();}finally{setBackupGuardPending(false);}
 };
 const activePapers=papers.filter(p=>!p.trashed&&!p.archived),recentPapers=[...activePapers].sort((a,b)=>(b.lastEditedAt||b.updatedAt).localeCompare(a.lastEditedAt||a.updatedAt)).slice(0,3);
 const focus=route.section==='papers'&&!!route.paperId||route.section==='presentations'&&!!route.presentationId;
 const title=items.find(([id])=>id===route.section)?.[1]||'研究总览';
 const scopeControl=hasResearchScope(route)&&overview&&<div className="research-scope-control"><label>当前课题<select aria-label="切换研究课题范围" value={(route.section==='topics'?route.topicId:['experiments','results'].includes(route.section)?scopedTopicId:effectiveTopicId)||''} onChange={e=>void chooseTopic(e.target.value)}><option value="">全部课题</option>{route.topicId&&!activeTopic&&<option value={route.topicId}>当前课题不可用</option>}{overview.topics.filter(t=>!t.archived).map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label>{activeTopic&&route.section!=='topics'&&<button type="button" className="academic-icon" aria-label="查看当前课题" title="查看当前课题" onClick={()=>navigateTo(`/topics?topic=${activeTopic.id}`)}><ArrowUpRight size={16}/></button>}</div>;

 return <div className={`academic-app ${focus?'academic-focus':''} ${focus&&!navigationExpanded?'academic-compact-nav':''}`}>
 {<aside className="academic-sidebar"><a href="#/home" className="academic-brand" onClick={e=>{e.preventDefault();navigateTo('/home');}}><span className="academic-brand-symbol"><BookOpen size={22}/></span><span><strong>EchoPaper</strong><small>个人学术工作台</small></span></a><div className="academic-nav-label">研究工作空间</div><nav aria-label="学术工作台导航">{items.map(([id,name,Icon])=><a href={`#${scopedPath('/'+id)}`} key={id} title={name} aria-label={name} aria-current={route.section===id?'page':undefined} className={route.section===id?'active':''} onClick={e=>{e.preventDefault();navigateTo(`/${id}`);}}><Icon size={18}/><span>{name}</span>{id==='papers'&&activePapers.length>0?<small>{activePapers.length}</small>:id==='topics'&&overview?.topics.filter(t=>!t.archived).length?<small>{overview.topics.filter(t=>!t.archived).length}</small>:null}</a>)}</nav><div className="academic-sidebar-note"><span>从材料到表达</span><p>让每个研究问题，都有迹可循。</p><div className="academic-flow-mark"><span/><span/><span/><span/></div></div><footer><button disabled={backupGuardPending} onClick={()=>void openBackups()}><Archive size={17}/>备份与恢复</button><button onClick={()=>setSettings(true)}><Settings2 size={17}/>设置与模型</button><div><i className={loadError?'offline':''}/>{loadError?'服务连接异常':'本地工作空间'}<ShieldCheck size={13}/></div></footer></aside>}
 <main className="academic-main">
 <header className={`academic-global-header ${focus?'academic-editor-header':''}`}>
 {focus&&<button className="academic-icon" aria-label={navigationExpanded?'收起研究导航':'展开研究导航'} aria-expanded={navigationExpanded} onClick={()=>setNavigationExpanded(v=>!v)}>{navigationExpanded?<PanelLeftClose size={17}/>:<PanelLeftOpen size={17}/>}</button>}
 <div className="academic-breadcrumb"><button onClick={()=>navigateTo('/home')}>研究工作空间</button><ChevronRight size={12}/>{focus?<><button onClick={()=>navigateTo(route.section==='papers'?'/papers':'/presentations')}>{title}</button><ChevronRight size={12}/><strong>{route.section==='papers'?(papers.find(p=>p.id===route.paperId)?.title||route.paperId):'编辑演示'}</strong></>:<strong>{title}</strong>}</div>
 {!focus&&scopeControl}
 {focus?<><span className="academic-editor-context">{route.section==='papers'?'论文工作区':'演示编辑'}</span>{route.section==='papers'&&route.paperId&&<button className="academic-paper-to-ppt" onClick={()=>navigateTo(`/presentations?paper=${encodeURIComponent(route.paperId!)}`)}><Presentation size={14}/>制作汇报<ArrowUpRight size={13}/></button>}</>:<><form onSubmit={e=>{e.preventDefault();if(search.trim())navigateTo(`/library?q=${encodeURIComponent(search.trim())}`);}}><Search size={15}/><input aria-label="全局资料搜索" placeholder="查找你的研究资料…" value={search} onChange={e=>setSearch(e.target.value)}/><kbd>↵</kbd></form><button className="academic-icon" aria-label="刷新工作台" onClick={()=>void refresh()}><RefreshCw size={15}/></button></>}
 </header>
 {loadError&&route.section!=='papers'&&<div className="academic-service-error" role="alert">{loadError}<button onClick={()=>void refresh()}>重新连接</button></div>}
 {route.section==='home'&&<ResearchLaunch overview={overview} papers={papers} decks={decks} loading={loading} onNavigate={homeNavigate}/>}
 {(['experiments','results','progress'] as const).includes(route.section as 'experiments'|'results'|'progress')&&<ResearchNotebook key={route.section} section={route.section as 'experiments'|'results'|'progress'} topicId={route.section==='progress'?effectiveTopicId:scopedTopicId} day={route.day} entryId={route.researchEntryId} entryRevision={route.entryRevision} overview={overview} onNavigate={navigateTo} onRefresh={refreshAfterEdit} onError={report} registerGuard={registerGuard}/>}
 {route.section==='topics'&&<Topics initialTopicId={route.topicId} onClearTopic={()=>void chooseTopic('')} overview={overview} papers={papers} decks={decks} onRefresh={refresh} onNavigate={navigateTo} onError={report} registerGuard={registerGuard}/>}
 {route.section==='library'&&<Library registerGuard={registerGuard} overview={overview} initialQuery={route.search} initialResourceId={route.resourceId} topicId={effectiveTopicId} onRefresh={refresh} onError={report}/>}
 {route.section==='papers'&&<div className="academic-paper-host"><PaperWorkspace hub={{route:{paperId:route.paperId,paperView:route.paperView,paperFile:route.paperFile,reviewId:route.reviewId},navigate:paperNavigate,registerGuard}}/></div>}
 {route.section==='presentations'&&<Presentations presentationId={route.presentationId} paperId={route.sourcePaperId} initialStyleId={route.styleId} initialStyleVersion={route.styleVersion} onNavigate={navigateTo} onDirtyGuard={registerGuard} onError={report}/>}
 </main>
 {settings&&<ModelSettings initialTab={settingsTab} onClose={()=>setSettings(false)}/>}
 {backups&&<HubDialog title="备份与恢复" onClose={()=>{if(!backupBusy)setBackups(false);}} closeDisabled={backupBusy} suspended={backupGuardPending} wide><div className="academic-backups"><Backups onBusyChange={setBackupBusy} beforeBackup={guardBackup} beforeRestore={guardBackup}/></div></HubDialog>}
 <div className="academic-toast-stack" aria-live="polite">{messages.map(m=><div key={m.id} role="alert"><span>{m.message}</span><button aria-label="关闭通知" onClick={()=>dismissToast(m.id)}><X size={16}/></button></div>)}</div>
 </div>;
}
