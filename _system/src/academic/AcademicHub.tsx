import {lazy,Suspense,useCallback,useEffect,useRef,useState,type MouseEvent} from 'react';
import {ArrowUpRight,BookOpen,ChevronRight,Files,FolderKanban,Home,LoaderCircle,Presentation,Search,Settings2,ShieldCheck,X,Archive,RefreshCw,FlaskConical,ChartNoAxesCombined,NotebookPen,PanelLeftClose,PanelLeftOpen} from 'lucide-react';
import {modelSettingsTarget,type ModelSettingsTarget} from '../modelSettings';
import type {Project} from '../../shared/types';
import type {WorkspaceOverview} from '../../shared/workspace-types';
import type {PresentationSummary} from '../../shared/presentation-types';
import {api,ApiError} from '../api';
import {useToasts} from '../useToasts';
import {academicPath,academicRoute,type AcademicRoute} from './navigation';
import HubDialog from './HubDialog';
import ResearchLaunch from './ResearchLaunch';
import ViewBoundary from './ViewBoundary';
import {readSession,writeSession} from '../workspaceSession';
import {researchContextKey,currentResearchTopic,hasResearchScope,hubDataSources,withResearchScope} from './researchContext';
import './academic.css';
import './workflow-shell.css';

const PaperWorkspace=lazy(()=>import('../App'));
const Topics=lazy(()=>import('./Topics'));
const Library=lazy(()=>import('./Library'));
const Presentations=lazy(()=>import('./Presentations'));
const ResearchNotebook=lazy(()=>import('./ResearchNotebook'));
const ModelSettings=lazy(()=>import('../components/ModelSettings'));
const Backups=lazy(()=>import('../components/Backups'));
const compactNavigationQuery='(max-width: 1120px)';
const overlayNavigationQuery='(max-width: 720px)';

const items=[['home','研究总览',Home],['topics','问题与选题',FolderKanban],['experiments','方案与实验',FlaskConical],['results','结果与证据',ChartNoAxesCombined],['papers','论文写作',BookOpen],['library','资料库',Files],['progress','工作日历',NotebookPen],['presentations','汇报演示',Presentation]] as const;
const sourceLabels = { overview: '课题与资料', papers: '论文列表', presentations: '汇报列表' };
type HubSource = keyof typeof sourceLabels;

export default function AcademicHub(){
 const [route,setRoute]=useState<AcademicRoute>(()=>academicRoute(location.hash)),[overview,setOverview]=useState<WorkspaceOverview>(),[papers,setPapers]=useState<Project[]>([]),[decks,setDecks]=useState<PresentationSummary[]>([]),[settings,setSettings]=useState(false),[settingsTarget,setSettingsTarget]=useState<ModelSettingsTarget>({tab:'assistant'}),[backups,setBackups]=useState(false),[search,setSearch]=useState(''),[navigationExpanded,setNavigationExpanded]=useState(false);
 const [loadErrors, setLoadErrors] = useState<Partial<Record<HubSource, string>>>({});
 const [refreshing,setRefreshing]=useState(false);
 const refreshController=useRef<AbortController|undefined>(undefined);
 const [backupBusy,setBackupBusy]=useState(false),[backupGuardPending,setBackupGuardPending]=useState(false);
 const [narrowViewport,setNarrowViewport]=useState(()=>window.matchMedia(compactNavigationQuery).matches);
 const [overlayViewport,setOverlayViewport]=useState(()=>window.matchMedia(overlayNavigationQuery).matches);
 const navigationOverlay=navigationExpanded&&overlayViewport;
 const navigationToggle=useRef<HTMLButtonElement>(null);
 const navigationSidebar=useRef<HTMLElement>(null);
 useEffect(()=>{
  const compact=window.matchMedia(compactNavigationQuery),overlay=window.matchMedia(overlayNavigationQuery);
  const update=()=>{setNarrowViewport(compact.matches);setOverlayViewport(overlay.matches);};
  compact.addEventListener('change',update);overlay.addEventListener('change',update);
  return()=>{compact.removeEventListener('change',update);overlay.removeEventListener('change',update);};
 },[]);
 useEffect(()=>{
  if(!navigationOverlay)return;
  navigationSidebar.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
 },[navigationOverlay]);
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
 const paperNavigate=useCallback((path:string,replace=false)=>commitRoute(academicRoute(path),replace),[commitRoute]);
 const sources=hubDataSources(route);
 const refresh = useCallback(async (requireOverview = false) => {
  const sources=hubDataSources(routeRef.current);
  refreshController.current?.abort();
  if(!Object.values(sources).some(Boolean)){setRefreshing(false);return;}
  const controller=new AbortController();
  refreshController.current=controller;
  setRefreshing(true);
  const load = async <T,>(source: HubSource, url: string, apply: (value: T) => void) => {
   if(!sources[source])return;
   try {
    const value=await api<T>(url,{signal:controller.signal,timeoutMs:12000});
    if(!controller.signal.aborted) {
     apply(value);
     setLoadErrors(errors => ({ ...errors, [source]: undefined }));
    }
   } catch (cause) {
    if(controller.signal.aborted)return;
    const error = cause instanceof ApiError&&cause.status===408 ? new Error('读取超时，请重试。')
     : cause instanceof Error ? cause : new Error(String(cause));
    setLoadErrors(errors => ({ ...errors, [source]: error.message }));
    return error;
   }
  };

  const overviewRequest=load<WorkspaceOverview>('overview','/api/workspace/overview',setOverview);
  void Promise.all([
   overviewRequest,
   load<{projects:Project[]}>('papers','/api/projects',result=>setPapers(result.projects)),
   load<{presentations:PresentationSummary[]}>('presentations','/api/presentations',result=>setDecks(result.presentations)),
  ]).then(()=>{if(!controller.signal.aborted)setRefreshing(false);});
  const overviewError=await overviewRequest;
  if(requireOverview&&overviewError)throw overviewError;
 }, []);
 const refreshAfterEdit=useCallback(()=>refresh(true),[refresh]);
 useEffect(()=>{const open=(event:Event)=>{setSettingsTarget(modelSettingsTarget(event));setSettings(true);};window.addEventListener('echopaper:open-model-settings',open);return()=>window.removeEventListener('echopaper:open-model-settings',open);},[]);
 useEffect(()=>{void refresh();return()=>refreshController.current?.abort();},[sources.overview,sources.papers,sources.presentations,refresh]);
 useEffect(()=>{historyIndex.current=Number.isInteger(history.state?.echopaperIndex)?history.state.echopaperIndex:0;history.replaceState({...history.state,echopaperIndex:historyIndex.current},'');const restore=(previous:AcademicRoute)=>{const incoming=history.state?.echopaperIndex;if(Number.isInteger(incoming)&&incoming!==historyIndex.current)history.go(historyIndex.current-incoming);else history.replaceState({...history.state,echopaperIndex:historyIndex.current},'',`#${academicPath(previous)}`);};const changed=()=>{const next=academicRoute(location.hash),previous=routeRef.current;if(academicPath(next)===academicPath(previous)||navigationPending.current)return;navigationPending.current=true;void(async()=>{try{if(guard.current&&!await guard.current()){restore(previous);return;}historyIndex.current=Number.isInteger(history.state?.echopaperIndex)?history.state.echopaperIndex:historyIndex.current+1;history.replaceState({...history.state,echopaperIndex:historyIndex.current},'');routeRef.current=next;setRoute(next);}catch(e:any){restore(previous);report(e.message);}finally{navigationPending.current=false;}})();};window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[report]);
 const scopedPath=(path:string)=>academicPath(withResearchScope(academicRoute(path),activeTopic?.id));
 const navigateTo=(path:string)=>{void navigate(scopedPath(path));};
 const homeNavigate=(path:string)=>{const next=academicRoute(path);if(next.section==='topics'&&!next.topicId){void navigate(academicPath(next));return;}if(next.section==='progress'&&!next.topicId){void navigate(academicPath(next),()=>{setRememberedTopicId(undefined);writeSession(researchContextKey,{});});}else navigateTo(path);};
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
 const activePapers=papers.filter(p=>!p.trashed&&!p.archived);
 const focus=route.section==='papers'&&!!route.paperId||route.section==='presentations'&&!!route.presentationId;
 const compactNavigation=(focus||narrowViewport)&&!navigationExpanded;
 const title=items.find(([id])=>id===route.section)?.[1]||'研究总览';
 const loadError = (Object.keys(sources) as HubSource[]).filter(source => sources[source]&&loadErrors[source])
  .map(source => `${sourceLabels[source]}：${loadErrors[source]}`).join('；');
 const needsTopicData=!overview&&sources.overview&&route.section!=='home'&&route.section!=='library';
 const scopeControl=hasResearchScope(route)&&overview&&<div className="research-scope-control"><label>当前课题<select aria-label="切换研究课题范围" value={(route.section==='topics'?route.topicId:['experiments','results'].includes(route.section)?scopedTopicId:effectiveTopicId)||''} onChange={e=>void chooseTopic(e.target.value)}><option value="">全部课题</option>{route.topicId&&!activeTopic&&<option value={route.topicId}>当前课题不可用</option>}{overview.topics.filter(t=>!t.archived).map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label>{activeTopic&&route.section!=='topics'&&<button type="button" className="academic-icon" aria-label="查看当前课题" title="查看当前课题" onClick={()=>navigateTo(`/topics?topic=${activeTopic.id}`)}><ArrowUpRight size={16}/></button>}</div>;

 function closeNavigation(){
  setNavigationExpanded(false);
  requestAnimationFrame(()=>navigationToggle.current?.focus());
 }
 function navigateFromSidebar(event:MouseEvent<HTMLAnchorElement>,path:string){
  if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  event.preventDefault();
  void navigate(scopedPath(path),()=>{
   if(navigationOverlay)closeNavigation();
  });
 }
 async function reloadPage(){
  try{if(!guard.current||await guard.current())location.reload();}
  catch(error){report(error instanceof Error?error.message:'页面暂时无法刷新。',true);}
 }
 const pageLoading=<p className="academic-page academic-route-loading" role="status"><LoaderCircle className="spin" size={17}/>正在打开{title}…</p>;

 return <div className={`academic-app ${focus?'academic-focus':''} ${compactNavigation?'academic-compact-nav':''}`} onKeyDown={event=>{
  if(event.key==='Escape'&&navigationOverlay&&!settings&&!backups){
   event.stopPropagation();
   closeNavigation();
  }
 }}>
 {navigationOverlay&&<button type="button" className="academic-nav-backdrop" tabIndex={-1} aria-hidden="true" onClick={closeNavigation}/>}
 <aside className="academic-sidebar" id="academic-navigation" ref={navigationSidebar}>
  <a href="#/home" className="academic-brand" aria-label="EchoPaper 研究总览" onClick={event=>navigateFromSidebar(event,'/home')}>
   <span className="academic-brand-symbol"><BookOpen size={22}/></span><span><strong>EchoPaper</strong><small>个人学术工作台</small></span>
  </a>
  <div className="academic-nav-label">研究工作空间{navigationOverlay&&<button type="button" className="academic-icon" aria-label="收起研究导航" onClick={closeNavigation}><PanelLeftClose size={17}/></button>}</div>
  <nav aria-label="学术工作台导航">{items.map(([id,name,Icon])=>{
   const count=id==='papers'?activePapers.length:id==='topics'?soleTopic.length:0;
   return <a href={`#${scopedPath('/'+id)}`} key={id} title={name} aria-label={name} aria-current={route.section===id?'page':undefined}
    className={route.section===id?'active':''} onClick={event=>navigateFromSidebar(event,'/'+id)}>
    <Icon size={18}/><span>{name}</span>{count>0&&<small>{count}</small>}
   </a>;
  })}</nav>
  <footer>
   <button type="button" disabled={backupGuardPending} onClick={()=>void openBackups()} aria-label="备份与恢复" title="备份与恢复"><Archive size={17}/><span>备份与恢复</span></button>
   <button type="button" onClick={()=>setSettings(true)} aria-label="设置与模型" title="设置与模型"><Settings2 size={17}/><span>设置与模型</span></button>
   <div><i className={loadError?'offline':''}/>{loadError?'部分数据读取失败':'本地工作空间'}<ShieldCheck size={13}/></div>
  </footer>
 </aside>
 <main className="academic-main" inert={navigationOverlay}>
 <header className={`academic-global-header ${focus?'academic-editor-header':''}`}>
 <div className="academic-location">
 {(focus||narrowViewport)&&<button ref={navigationToggle} type="button" className="academic-icon" aria-label={compactNavigation?'展开研究导航':'收起研究导航'} aria-controls="academic-navigation" aria-expanded={!compactNavigation} onClick={()=>setNavigationExpanded(value=>!value)}>{compactNavigation?<PanelLeftOpen size={17}/>:<PanelLeftClose size={17}/>}</button>}
 <div className="academic-breadcrumb"><button onClick={()=>navigateTo('/home')}>研究工作空间</button><ChevronRight size={12}/>{focus?<><button onClick={()=>navigateTo(route.section==='papers'?'/papers':'/presentations')}>{title}</button><ChevronRight size={12}/><strong>{route.section==='papers'?(papers.find(p=>p.id===route.paperId)?.title||route.paperId):'编辑演示'}</strong></>:<strong>{title}</strong>}</div>
 </div>
 {!focus&&scopeControl}
 {focus?<><span className="academic-editor-context">{route.section==='papers'?'论文工作区':'演示编辑'}</span>{route.section==='papers'&&route.paperId&&<button className="academic-paper-to-ppt" onClick={()=>navigateTo(`/presentations?paper=${encodeURIComponent(route.paperId!)}`)}><Presentation size={14}/>制作汇报<ArrowUpRight size={13}/></button>}</>:<><form onSubmit={e=>{e.preventDefault();if(search.trim())navigateTo(`/library?q=${encodeURIComponent(search.trim())}`);}}><Search size={15}/><input aria-label="全局资料搜索" placeholder="查找你的研究资料…" value={search} onChange={e=>setSearch(e.target.value)}/><kbd>↵</kbd></form><button className="academic-icon" aria-label="刷新工作台" title="刷新工作台" disabled={refreshing} onClick={()=>void (Object.values(sources).some(Boolean)?refresh():reloadPage())}>{refreshing?<LoaderCircle className="spin" size={15}/>:<RefreshCw size={15}/>}</button></>}
 </header>
 {loadError&&<div className="academic-service-error" role="alert">{loadError}<button disabled={refreshing} onClick={()=>void refresh()}>{refreshing?'读取中…':'重试读取'}</button></div>}
 <ViewBoundary viewKey={academicPath(route)} fallback={<div className="academic-service-error" role="alert">页面未能打开。<button onClick={()=>void reloadPage()}>重新加载页面</button></div>}>
 <Suspense fallback={pageLoading}>
 {needsTopicData?(refreshing||!loadErrors.overview?pageLoading:null):<>
 {route.section==='home'&&<ResearchLaunch overview={overview} papers={papers} loading={!overview&&!loadErrors.overview} onNavigate={homeNavigate} registerGuard={registerGuard}/>}
 {(['experiments','results','progress'] as const).includes(route.section as 'experiments'|'results'|'progress')&&<ResearchNotebook key={route.section} section={route.section as 'experiments'|'results'|'progress'} topicId={route.section==='progress'?effectiveTopicId:scopedTopicId} day={route.day} entryId={route.researchEntryId} entryRevision={route.entryRevision} overview={overview} onNavigate={navigateTo} onRefresh={refreshAfterEdit} onError={report} registerGuard={registerGuard}/>}
 {route.section==='topics'&&<Topics initialTopicId={route.topicId} onClearTopic={()=>void chooseTopic('')} overview={overview} papers={papers} decks={decks} onRefresh={refresh} onNavigate={navigateTo} onError={report} registerGuard={registerGuard}/>}
 {route.section==='library'&&<Library registerGuard={registerGuard} overview={overview} initialQuery={route.search} initialResourceId={route.resourceId} topicId={effectiveTopicId} onRefresh={refresh} onError={report}/>}
 {route.section==='papers'&&<div className="academic-paper-host"><PaperWorkspace hub={{route:{paperId:route.paperId,paperView:route.paperView,paperFile:route.paperFile,reviewId:route.reviewId},navigate:paperNavigate,registerGuard}}/></div>}
 {route.section==='presentations'&&<Presentations presentationId={route.presentationId} paperId={route.sourcePaperId} initialStyleId={route.styleId} initialStyleVersion={route.styleVersion} onNavigate={navigateTo} onDirtyGuard={registerGuard} onError={report}/>}
 </>}
 </Suspense>
 </ViewBoundary>
 </main>
 {settings&&<ViewBoundary fallback={<HubDialog title="设置与模型" onClose={()=>setSettings(false)}><p className="academic-form" role="alert">设置暂时无法打开，请刷新工作台后重试。</p></HubDialog>}>
  <Suspense fallback={<HubDialog title="设置与模型" onClose={()=>setSettings(false)}><p className="academic-form" role="status">正在打开设置…</p></HubDialog>}>
   <ModelSettings initialTab={settingsTarget.tab} initialOcrEngine={settingsTarget.ocrEngine} onClose={()=>setSettings(false)}/>
  </Suspense>
 </ViewBoundary>}
 {backups&&<HubDialog title="备份与恢复" onClose={()=>{if(!backupBusy)setBackups(false);}} closeDisabled={backupBusy} suspended={backupGuardPending} wide><div className="academic-backups">
  <ViewBoundary fallback={<p role="alert">备份页面暂时无法打开，请刷新工作台后重试。</p>}>
   <Suspense fallback={<p role="status">正在打开备份…</p>}><Backups showHeading={false} onBusyChange={setBackupBusy} beforeBackup={guardBackup} beforeRestore={guardBackup}/></Suspense>
  </ViewBoundary>
 </div></HubDialog>}
 <div className="academic-toast-stack" aria-live="polite">{messages.map(m=><div key={m.id} role="alert"><span>{m.message}</span><button aria-label="关闭通知" onClick={()=>dismissToast(m.id)}><X size={16}/></button></div>)}</div>
 </div>;
}
