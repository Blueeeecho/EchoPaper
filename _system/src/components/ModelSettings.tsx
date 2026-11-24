import {useEffect,useRef,useState} from 'react';
import {ArrowDown,ArrowRight,ArrowUp,Check,ChevronDown,Cloud,Download,KeyRound,Languages,LoaderCircle,MessageSquare,Plus,Save,ScanText,Server,Settings2,Trash2,X} from 'lucide-react';
import {TRANSLATION_SERVICES,translationServicePreset} from '../../shared/translation-services';
import {DEFAULT_MODELS,DEFAULT_PROVIDER,isDedicatedTranslationSource,isTranslationService,type ModelProvider,type ProviderModel,type PublicRegistry,type TranslationServiceKind,type TranslationSource} from '../../shared/model-providers';
import type {AssistantSettings} from '../../shared/agent-types';
import {assistantSetups,recommendedAssistantPresets,recommendedTranslationPresets,translationSetups,type AssistantPreset,type OcrEngineId,type ServiceSetup} from '../serviceSetup';
import {api,json} from '../api';
import {modelSettingsChanged,moveTranslationSource,readModelRegistry,saveTranslationSources,saveAssistantSettings,type ModelSettingsTab} from '../modelSettings';
import AssistantSettingsEditor from './AssistantSettingsEditor';
import OcrSettings from './OcrSettings';
import ServiceSetupGuide from './ServiceSetupGuide';
import '../model-settings.css';

const uid=(prefix:string)=>prefix+'-'+crypto.randomUUID();
const colors=['#8375cf','#4c86bf','#479a89','#c58a52','#b86e95','#758997'];
const newModel=(providerId:string):ProviderModel=>({id:uid('m'),providerId,model:'',label:'',contextWindow:0,reasoning:'none',enabled:true,toolCalling:'unknown'});
const providerMatches=(provider:ModelProvider,tab:ModelSettingsTab)=>tab!=='ocr'&&isTranslationService(provider)===(tab==='translations');
type AssistantModelPreset=Pick<ProviderModel,'model'|'label'|'contextWindow'|'toolCalling'>&Partial<Pick<ProviderModel,'reasoning'>>;
const knownAssistantModels={
 minimax:{baseUrl:DEFAULT_PROVIDER.baseUrl,models:DEFAULT_MODELS},
 deepseek:{baseUrl:'https://api.deepseek.com',models:[{model:'deepseek-flash',label:'deepseek-flash',contextWindow:1_000_000}]},
 zhipu:{baseUrl:'https://open.bigmodel.cn/api/paas/v4',models:[{model:'glm-4.7-flash',label:'GLM-4.7-Flash',contextWindow:200_000}]},
};
const purposeTabs=[['assistant','AI 助手',MessageSquare],['translations','翻译 API',Languages],['ocr','OCR API',ScanText]] as const;
const assistantPresetFor=(provider:ModelProvider):AssistantPreset=>provider.kind==='minimax'?'minimax':provider.baseUrl===knownAssistantModels.deepseek.baseUrl?'deepseek':provider.baseUrl.startsWith(knownAssistantModels.zhipu.baseUrl)?'zhipu':provider.auth==='none'&&provider.baseUrl==='http://127.0.0.1:11434/v1'?'local':'compatible';

export default function ModelSettings({initialTab='assistant',initialOcrEngine,onClose}:{initialTab?:ModelSettingsTab;initialOcrEngine?:OcrEngineId;onClose:()=>void}){
 const [tab,setTab]=useState(initialTab),[view,setView]=useState<'api'|'usage'>('api');
 const [config,setConfig]=useState<PublicRegistry>(),[configWarnings,setConfigWarnings]=useState<string[]>([]),[loadAttempt,setLoadAttempt]=useState(0);
 const [provider,setProvider]=useState<ModelProvider>(),[models,setModels]=useState<ProviderModel[]>([]),[key,setKey]=useState('');
 const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[network,setNetwork]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [assistant,setAssistant]=useState<AssistantSettings>(),[assistantDirty,setAssistantDirty]=useState(false);
 const [sources,setSources]=useState<TranslationSource[]>([]),[layout,setLayout]=useState<'stack'|'columns'>('stack'),[sourcesDirty,setSourcesDirty]=useState(false),[dragged,setDragged]=useState<number>();
 const [showCatalog,setShowCatalog]=useState(false),[closeWarning,setCloseWarning]=useState(false),[ocrDirty,setOcrDirty]=useState(false),[ocrBusy,setOcrBusy]=useState(false);
 const [draftPreset,setDraftPreset]=useState<AssistantPreset>();
 const [catalog,setCatalog]=useState<{id:string;contextWindow?:number}[]>([]);
 const networkController=useRef<AbortController|undefined>(undefined),dialog=useRef<HTMLDivElement>(null);
 const unsaved=dirty||sourcesDirty||assistantDirty||ocrDirty,locked=busy||network||ocrBusy;
 const translating=tab==='translations',savedProviders=config?.providers.filter(item=>providerMatches(item,tab))??[];
 const savedProvider=config?.providers.find(item=>item.id===provider?.id);
 const service=translationServicePreset(provider?.kind||'');
 const guide=provider?(service?translationSetups[service.kind]:assistantSetups[draftPreset??assistantPresetFor(provider)]):undefined;
 const translationModels=config?.models.filter(model=>isDedicatedTranslationSource(config,{modelId:model.id}))??[];
 const legacySources=config?.translations.filter(source=>!isDedicatedTranslationSource(config,source))??[];
 const legacyCount=legacySources.length;
 const legacyMiniMaxSources=legacySources.filter(source=>{
  const model=config?.models.find(item=>item.id===source.modelId);
  return !!model&&config?.providers.some(item=>item.id===model.providerId&&item.kind==='minimax');
 });

 function loadProvider(data:PublicRegistry,purpose:ModelSettingsTab,id?:string){
  const eligible=data.providers.filter(item=>providerMatches(item,purpose));
  const selected=eligible.find(item=>item.id===id)??eligible.find(item=>item.enabled&&item.configured)??eligible[0];
  setProvider(selected?{...selected}:undefined);setModels(data.models.filter(model=>model.providerId===selected?.id).map(model=>({...model})));
  setDraftPreset(undefined);setKey('');setDirty(false);setCatalog([]);
 }
 function apply(data:PublicRegistry,id=provider?.id){
  setConfig(data);setConfigWarnings((data as PublicRegistry&{warnings?:string[]}).warnings||[]);
  setAssistant(structuredClone(data.assistant));setAssistantDirty(false);setSources(data.translations);setLayout(data.translationLayout);setSourcesDirty(false);
  loadProvider(data,tab,id);
 }
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement;
  dialog.current?.focus();
  return()=>{networkController.current?.abort();previous?.focus?.();};
 },[]);
 useEffect(()=>{
  if(tab==='ocr'||config)return;
  const controller=new AbortController();
  void readModelRegistry(controller.signal).then(data=>{if(!controller.signal.aborted)apply(data);}).catch(cause=>{if(!controller.signal.aborted)setError(cause.message);});
  return ()=>controller.abort();
 },[tab,config,loadAttempt]);
 useEffect(()=>{
  if(!unsaved){setCloseWarning(false);return;}
  const prevent=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
  window.addEventListener('beforeunload',prevent);
  return()=>window.removeEventListener('beforeunload',prevent);
 },[unsaved]);
 const clearFeedback=()=>{setError('');setNotice('');};
 const requestClose=()=>{if(locked)return;if(unsaved)setCloseWarning(true);else onClose();};
 const canNavigate=()=>{
  if(locked)return false;
  if(!unsaved)return true;
  setError('请先保存或取消当前修改，再切换配置。');return false;
 };
 function switchTab(next:ModelSettingsTab){
  if(next===tab||!canNavigate())return;
  clearFeedback();setTab(next);setView('api');setShowCatalog(false);
  if(config)loadProvider(config,next);
 }
 function switchView(next:typeof view){if(next!==view&&canNavigate()){setView(next);setShowCatalog(false);clearFeedback();}}
 function pick(id:string){if(!config||!canNavigate())return;loadProvider(config,tab,id);setShowCatalog(false);clearFeedback();}
 function addProvider(choice:AssistantPreset|TranslationServiceKind){
  if(!config||!canNavigate())return;
  const id=uid('p'),translation=translationServicePreset(choice),local=choice==='local',mini=choice==='minimax';
  const chat=translation?undefined:knownAssistantModels[choice as keyof typeof knownAssistantModels];
  const label=translation?.label??(choice==='compatible'?'':assistantSetups[choice as AssistantPreset].label);
  setProvider({id,label,kind:translation?translation.kind:mini?'minimax':'openai-compatible',baseUrl:translation?.baseUrl??chat?.baseUrl??(local?'http://127.0.0.1:11434/v1':''),plan:local?'本地':'',auth:local?'none':'bearer',enabled:true,includeUsage:mini,passReasoning:mini||choice==='deepseek',...(choice==='baidu-translate'?{appId:''}:{}),...(choice==='microsoft-translator'?{region:''}:{})});
  if(translation){const model=translation.models[0];setModels([{...newModel(id),model,label:model==='text-translation'?'文本翻译':model}]);}
  else setModels(chat?.models.map((entry:AssistantModelPreset)=>({...newModel(id),model:entry.model,label:entry.label,contextWindow:entry.contextWindow,reasoning:entry.reasoning??'none',toolCalling:entry.toolCalling??'unknown'}))??[]);
  setDraftPreset(translation?undefined:choice as AssistantPreset);setKey('');setDirty(true);setCatalog([]);setShowCatalog(false);clearFeedback();
 }
 function updateProvider(patch:Partial<ModelProvider>){setProvider(old=>old?{...old,...patch}:old);setDirty(true);clearFeedback();}
 function updateModel(id:string,patch:Partial<ProviderModel>){setModels(old=>old.map(model=>model.id===id?{...model,...patch}:model));setDirty(true);clearFeedback();}
 function modelUses(modelId:string){
  if(!config)return [];
  return [...(config.assistant.modelIds.includes(modelId)?['AI 助手']:[]),...config.assistant.roles.filter(role=>role.modelId===modelId).map(role=>'角色：'+role.name),...config.translations.filter(source=>source.modelId===modelId).map(source=>(isDedicatedTranslationSource(config,source)?'翻译：':'旧翻译来源：')+source.label)];
 }
 const providerUses=[...new Set(models.flatMap(model=>modelUses(model.id)))];
 const configuredModel=config?.models.find(model=>model.providerId===provider?.id&&model.configured);
 const sourceBound=!!config?.translations.some(source=>models.some(model=>model.id===source.modelId));
 const legacyMiniMaxSource=service?.kind==='minimax-translate'&&configuredModel?legacyMiniMaxSources.find(source=>config?.models.some(model=>model.id===source.modelId&&model.model===configuredModel.model)):undefined;
 async function saveProvider(){
  if(!provider||!config||locked||!dirty)return;
  setBusy(true);clearFeedback();
  try{
   const data=await api<PublicRegistry>(`/api/ai/providers/${provider.id}`,json('POST',{expectedRevision:config.revision,provider,models,...(key.trim()?{key:key.trim()}:{})}));
   apply(data,provider.id);modelSettingsChanged();setNotice(translating?'翻译服务已保存。可测试后加入翻译来源。':'助手 API 已保存。可测试后到「助手模型与角色」选默认模型。');
  }catch(cause:any){setError(cause.message);}finally{setBusy(false);}
 }
 async function removeProvider(){
  if(!savedProvider||!config||locked||dirty||providerUses.length)return;
  setBusy(true);clearFeedback();
  try{apply(await api<PublicRegistry>(`/api/ai/providers/${savedProvider.id}`,json('DELETE',{expectedRevision:config.revision})));modelSettingsChanged();setNotice('连接已移除。');}
  catch(cause:any){setError(cause.message);}finally{setBusy(false);}
 }
 async function remote(action:'models'|'test'){
  if(!provider||!savedProvider||dirty||locked)return;
  const controller=new AbortController();networkController.current=controller;setNetwork(true);clearFeedback();
  try{
   const result=await api<{models:{id:string;contextWindow?:number}[];message:string}>(`/api/ai/providers/${provider.id}/${action}`,{...json('POST',action==='test'?{modelId:configuredModel?.id}:{}),signal:controller.signal});
   if(action==='models'){setCatalog(result.models);setNotice(result.models.length?`读取到 ${result.models.length} 个模型，选择要添加的模型。`:'该服务没有返回模型列表，请手动填写模型 ID。');}else setNotice(result.message);
  }catch(cause:any){if(!controller.signal.aborted)setError(cause.message);}finally{setNetwork(false);}
 }
 async function saveAssistant(){
  if(!config||!assistant||locked||!assistantDirty)return;
  if(!assistant.roles.some(role=>role.id==='coordinator'&&role.enabled)){setError('请恢复或启用主助手；专业角色均为可选。');return;}
  setBusy(true);clearFeedback();
  try{apply(await saveAssistantSettings(config,assistant));setNotice('助手模型、角色与预算已保存。');}
  catch(cause:any){setError(cause.message);}finally{setBusy(false);}
 }
 function makeSource(modelId:string,label:string,count:number,color?:string):TranslationSource{
  return {id:uid('t'),label,modelId,enabled:true,color:color??colors[count%colors.length]};
 }
 async function useForTranslation(){
  if(!config||!provider||!service||!configuredModel||dirty||locked||sourceBound)return;
  setBusy(true);clearFeedback();
  try{
   const label=provider.label.endsWith('翻译')?provider.label:provider.label+' 翻译';
   const next=legacyMiniMaxSource?config.translations.map(source=>source.id===legacyMiniMaxSource.id?{...source,modelId:configuredModel.id}:source)
    :[...config.translations,makeSource(configuredModel.id,label,config.translations.length,service.color)];
   apply(await saveTranslationSources(config,next));
   setNotice(legacyMiniMaxSource?'已替换旧来源，保留原顺序和启用状态。':'已启用此翻译来源；可在「启用与排序」调整顺序。');
  }catch(cause:any){setError(cause.message);}finally{setBusy(false);}
 }
 async function saveSources(){
  if(!config||locked||!sourcesDirty)return;
  setBusy(true);clearFeedback();
  try{apply(await saveTranslationSources(config,sources,layout));setNotice('翻译来源、顺序与布局已保存。');}
  catch(cause:any){setError(cause.message);}finally{setBusy(false);}
 }
 function addSource(){
  const model=translationModels.find(item=>item.configured&&!sources.some(source=>source.modelId===item.id));
  if(!model)return;
  setSources(old=>[...old,makeSource(model.id,model.providerLabel,old.length)]);setSourcesDirty(true);clearFeedback();
 }
 function patchSource(id:string,patch:Partial<TranslationSource>){setSources(old=>old.map(source=>source.id===id?{...source,...patch}:source));setSourcesDirty(true);clearFeedback();}
 function move(from:number,to:number){setSources(old=>moveTranslationSource(old,from,to));setSourcesDirty(true);clearFeedback();}
 async function reload(){
  if(locked)return;setBusy(true);clearFeedback();
  try{apply(await readModelRegistry());}catch(cause:any){setError(cause.message);}finally{setBusy(false);}
 }
 const existingTranslations=new Map(savedProviders.map(item=>[item.kind,item]));
 const otherTranslation=TRANSLATION_SERVICES.filter(item=>!recommendedTranslationPresets.some(kind=>kind===item.kind)||existingTranslations.has(item.kind));
 const card=(id:AssistantPreset|TranslationServiceKind,details:ServiceSetup,connection?:PublicRegistry['providers'][number])=><button key={id} className="setup-option" aria-label={`${connection?'打开现有连接：':'配置：'}${details.label}`} onClick={()=>connection?pick(connection.id):addProvider(id)}>
  <span><strong>{details.label}</strong>{(connection||details.badge)&&<small>{connection?(connection.configured?'已有连接':'待配置凭据'):details.badge}</small>}</span><p>{details.summary}</p><span className="setup-option-add">{connection?<><ArrowRight size={14}/>打开现有连接</>:<><Plus size={14}/>配置此服务</>}</span>
 </button>;
 const setupCatalog=<section className="setup-catalog">
  <div className="settings-section-heading"><h3>{translating?'推荐翻译服务':'选择助手 API'}</h3><p>{translating?'沿用工作台已有的两款翻译模型。翻译不会自动调用助手。':'选择已有的开发者账户，不需要同时注册多个厂商。'}</p></div>
  <div className="setup-option-grid">{translating?recommendedTranslationPresets.map(kind=>card(kind,translationSetups[kind],existingTranslations.get(kind))):recommendedAssistantPresets.map(id=>card(id,assistantSetups[id]))}</div>
  <details className="setup-more"><summary>{translating?'其他翻译服务与新连接':'自定义与本地服务'}<ChevronDown size={14}/></summary><div className="setup-option-grid">{translating?otherTranslation.map(item=>card(item.kind,translationSetups[item.kind])):(['compatible','local'] as const).map(id=>card(id,assistantSetups[id]))}</div></details>
 </section>;

 return <div className="model-settings-backdrop"><div ref={dialog} className="model-settings-dialog" role="dialog" aria-modal="true" aria-label="服务与 API 设置" tabIndex={-1} onKeyDown={event=>{
  if(event.key==='Tab'){
   const fields=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:enabled,input:enabled,select:enabled,textarea:enabled,a[href],summary,[tabindex="0"]')||[]).filter(field=>field.getClientRects().length>0);
   const first=fields[0],last=fields.at(-1);
   if(first&&(!fields.includes(document.activeElement as HTMLElement)||(!event.shiftKey&&document.activeElement===last)||(event.shiftKey&&document.activeElement===first))){event.preventDefault();(event.shiftKey?last:first)?.focus();}
  }
  if(event.key==='Escape'){event.stopPropagation();if(closeWarning)setCloseWarning(false);else requestClose();}
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){
   event.preventDefault();event.stopPropagation();
   if(tab==='ocr')dialog.current?.querySelector<HTMLFormElement>('#ocr-credential-form')?.requestSubmit();
   else if(!showCatalog)void(view==='api'?saveProvider():translating?saveSources():saveAssistant());
  }
 }}>
  <header><div><span className="model-settings-symbol"><Settings2 size={20}/></span><div><h2>服务与 API</h2><p>按用途接入服务，不跨用途使用凭据</p></div></div><button className="icon-button" aria-label="关闭模型设置" disabled={locked} onClick={requestClose}><X size={19}/></button></header>
  <nav className="model-settings-tabs" aria-label="API 用途">{purposeTabs.map(([id,label,Icon])=><button key={id} className={tab===id?'active':''} aria-pressed={tab===id} disabled={locked} onClick={()=>switchTab(id)}><Icon size={16}/>{label}</button>)}<small><KeyRound size={12}/> 凭据保存在系统凭据库</small></nav>
  {closeWarning&&<div className="model-settings-close-warning" role="alert"><span>设置有未保存修改，关闭会丢弃这些编辑。</span><div><button className="button" onClick={()=>setCloseWarning(false)}>继续编辑</button><button className="button" onClick={onClose}>放弃修改并关闭</button></div></div>}
  {tab==='assistant'&&configWarnings.length>0&&<div className="model-settings-message" role="status">{configWarnings.join('；')}</div>}
  {error&&<div className="model-settings-message error" role="alert">{error}{!config&&tab!=='ocr'?<button onClick={()=>{clearFeedback();setLoadAttempt(value=>value+1);}}>重试读取</button>:error.includes('其他窗口修改')&&<button onClick={()=>void reload()}>放弃当前表单，载入最新配置</button>}</div>}
  {notice&&<div className="model-settings-message success" role="status"><Check size={14}/>{notice}</div>}

  {tab==='ocr'?<OcrSettings initialEngine={initialOcrEngine} onDirty={value=>{setOcrDirty(value);setError('');}} onBusy={setOcrBusy}/>:!config?<div className="model-settings-loading">{error?'无法读取 API 配置':<><LoaderCircle className="spin" size={20}/>正在读取本机配置…</>}</div>:<>
   <div className="purpose-settings-bar">
    <div><strong>{translating?'文本翻译':'对话与研究工具'}</strong><small>{translating?'划词与全文译文只走翻译服务。':'助手模型仅供对话、分析和已启用的工具。'}</small></div>
    <nav aria-label={translating?'翻译设置步骤':'助手设置步骤'}><button aria-pressed={view==='api'} onClick={()=>switchView('api')}>1. 接入 API</button><button aria-pressed={view==='usage'} onClick={()=>switchView('usage')}>{translating?'2. 启用与排序':'2. 助手模型与角色'}</button></nav>
   </div>
   {translating&&legacyCount>0&&view==='api'&&<div className="model-settings-message legacy-translation" role="status">{legacyCount===1&&legacyMiniMaxSources.length===1?<>
    <span>旧 MiniMax 来源使用了助手连接。改接独立翻译 API，即可保留原顺序。</span>
    <button onClick={()=>{const connection=existingTranslations.get('minimax-translate');if(connection)pick(connection.id);else addProvider('minimax-translate');}}>配置 MiniMax 翻译</button>
   </>:<><span>有 {legacyCount} 个旧来源使用助手模型，已停止调用。</span><button onClick={()=>switchView('usage')}>查看并替换旧来源</button></>}</div>}
   {view==='usage'?!translating?<section className="assistant-settings-panel"><fieldset className="model-form-fields" disabled={busy}>
    {assistant&&<AssistantSettingsEditor config={config} value={assistant} onChange={value=>{setAssistant(value);setAssistantDirty(true);clearFeedback();}} onError={setError}/>}
    <footer className="provider-actions"><span>专业角色按需使用，保存后影响新的对话轮次。</span><button className="button" disabled={!assistantDirty} onClick={()=>{setAssistant(structuredClone(config.assistant));setAssistantDirty(false);clearFeedback();}}>取消更改</button><button className="button primary" disabled={!assistantDirty} onClick={()=>void saveAssistant()}><Save size={13}/>保存助手配置</button></footer>
   </fieldset></section>:<section className="translation-source-settings"><fieldset className="model-form-fields" disabled={busy}>
    <div className="translation-settings-intro"><div><h3>启用翻译来源</h3><p>划词时同时调用已启用的来源；拖动或用箭头排序。全文对照使用阅读器中选定的一路。</p></div><button className="button" disabled={!translationModels.some(model=>model.configured&&!sources.some(source=>source.modelId===model.id))} onClick={addSource}><Plus size={14}/>添加来源</button></div>
    {legacyCount>0&&<p className="legacy-translation translation-legacy-note">旧来源保留原配置，但不会调用助手模型。可在原卡片选一个翻译服务，再勾选启用并保存；已保存的译文不会删除。</p>}
    <div className="translation-layout-choice"><span>结果布局</span><button className={layout==='stack'?'active':''} onClick={()=>{setLayout('stack');setSourcesDirty(true);}}>纵向卡片</button><button className={layout==='columns'?'active':''} onClick={()=>{setLayout('columns');setSourcesDirty(true);}}>并排对照</button></div>
    <div className="translation-source-list">{sources.map((source,index)=>{
     const legacy=!isDedicatedTranslationSource(config,source);
     return <article key={source.id} className={`translation-source-config ${legacy||!source.enabled?'disabled':''}`} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();if(dragged!==undefined)move(dragged,index);setDragged(undefined);}}>
      <span className="translation-source-number" draggable={!busy} onDragStart={()=>setDragged(index)} onDragEnd={()=>setDragged(undefined)}>{index+1}</span>
      <label className="model-toggle"><input aria-label={`启用来源 ${source.label}`} type="checkbox" disabled={legacy} checked={!legacy&&source.enabled} onChange={event=>patchSource(source.id,{enabled:event.target.checked})}/></label>
      <label className="translation-source-color" title="来源标识颜色"><input type="color" aria-label={`来源颜色 ${source.id}`} value={source.color} onChange={event=>patchSource(source.id,{color:event.target.value})}/></label>
      <div className="translation-source-edit"><input aria-label={`翻译来源名称 ${source.id}`} value={source.label} onChange={event=>patchSource(source.id,{label:event.target.value})}/><select aria-label={`翻译服务 ${source.label}`} value={source.modelId} onChange={event=>patchSource(source.id,{modelId:event.target.value,...(legacy?{enabled:false}:{})})}>
       {legacy&&<option value={source.modelId} disabled>旧助手来源 · 待替换</option>}{translationModels.map(model=><option key={model.id} value={model.id}>{model.providerLabel} · {model.label}{model.configured?'':'（待配置 / 未启用）'}</option>)}
      </select></div>
      <div className="translation-source-order"><button className="icon-button" aria-label={`上移来源 ${source.label}`} disabled={index===0} onClick={()=>move(index,index-1)}><ArrowUp size={14}/></button><button className="icon-button" aria-label={`下移来源 ${source.label}`} disabled={index===sources.length-1} onClick={()=>move(index,index+1)}><ArrowDown size={14}/></button><button className="icon-button" aria-label={`移除来源 ${source.label}`} onClick={()=>{setSources(old=>old.filter(item=>item.id!==source.id));setSourcesDirty(true);}}><Trash2 size={14}/></button></div>
     </article>;
    })}</div>
    {!translationModels.some(model=>model.configured)&&<div className="model-empty-hint">先在「接入 API」保存翻译服务，再回来启用。<button className="button" onClick={()=>switchView('api')}>去接入 <ArrowRight size={13}/></button></div>}
    <footer className="provider-actions"><span>保存后应用新的来源、顺序和布局。</span><button className="button" disabled={!sourcesDirty} onClick={()=>{setSources(config.translations);setLayout(config.translationLayout);setSourcesDirty(false);clearFeedback();}}>取消更改</button><button className="button primary" disabled={!sourcesDirty} onClick={()=>void saveSources()}><Save size={13}/>保存翻译配置</button></footer>
   </fieldset></section>:<div className="provider-workspace">
    <aside className="provider-sidebar">
     <button className="button provider-new" disabled={locked} onClick={()=>{if(canNavigate()){setShowCatalog(true);clearFeedback();}}}><Plus size={15}/>{translating?'添加翻译 API':'添加助手 API'}</button>
     {savedProviders.map(item=><button key={item.id} className={`provider-list-item ${!showCatalog&&provider?.id===item.id?'active':''}`} disabled={locked} onClick={()=>pick(item.id)}><span className={`provider-avatar ${item.auth==='none'?'local':''}`}>{translationServicePreset(item.kind)?.badge||(item.auth==='none'?<Server size={17}/>:<Cloud size={17}/>)}</span><span><strong>{item.label}</strong><small>{!item.enabled?'已停用':item.auth==='none'?'本地服务':item.configured?'凭据已保存':'待配置凭据'}</small></span><i className={item.enabled&&item.configured?'connected':''}/></button>)}
     {provider&&!savedProvider&&<div className="provider-list-item active"><span className="provider-avatar"><Plus size={17}/></span><span><strong>{provider.label||'新连接'}</strong><small>尚未保存</small></span></div>}
     <p className="provider-sidebar-note">{translating?'这里仅列出专用翻译连接。':'这里仅列出 AI 助手连接。'}</p>
    </aside>
    {showCatalog||!provider?setupCatalog:<section className="provider-editor"><fieldset className="model-form-fields" disabled={busy||network}>
     <div className="provider-editor-title"><div><h3>{provider.label||(translating?'添加翻译 API':'添加助手 API')}</h3><span>{provider.auth==='none'?'无需密钥':savedProvider?.configured&&provider.baseUrl===savedProvider.baseUrl?'密钥已保存':'待配置密钥'}</span></div><label className="model-toggle"><input type="checkbox" checked={provider.enabled} onChange={event=>updateProvider({enabled:event.target.checked})}/><span>启用连接</span></label></div>
     <p className="provider-usage-note">{providerUses.length?'已关联：'+providerUses.join('、'):translating?'保存和测试后，可将此服务加入启用来源。':'保存和测试后，在「助手模型与角色」中选择默认模型。'}</p>
     {guide&&(savedProvider?.configured
      ?<details className="model-settings-setup-help"><summary>注册与接入指引</summary><ServiceSetupGuide guide={guide}/></details>
      :<ServiceSetupGuide guide={guide}/>)}
     <div className="provider-fields">
      {provider.kind==='baidu-translate'&&<label className="full"><span>APP ID</span><input aria-label="百度 APP ID" value={provider.appId||''} inputMode="numeric" placeholder="从百度翻译控制台复制 APP ID" onChange={event=>updateProvider({appId:event.target.value})}/></label>}
      {provider.kind==='microsoft-translator'&&<label className="full"><span>Region · 区域</span><input value={provider.region||''} placeholder="如 eastasia；global 资源可留空" onChange={event=>updateProvider({region:event.target.value})}/></label>}
      {provider.auth==='bearer'&&<label className="full"><span><KeyRound size={13}/> {service?.keyLabel||'API Key'}</span><input aria-label="API Key" type="password" autoComplete="new-password" spellCheck={false} placeholder={savedProvider?.configured&&provider.baseUrl===savedProvider.baseUrl?'留空保留当前密钥':'粘贴此服务的密钥'} value={key} onChange={event=>{setKey(event.target.value);setDirty(true);clearFeedback();}}/></label>}
      <label><span>服务名称</span><input aria-label="服务名称" placeholder="给连接起个名字" value={provider.label} onChange={event=>updateProvider({label:event.target.value})}/></label>
      <label><span>套餐 / 备注（可选）</span><input aria-label="套餐备注" placeholder="按量付费 / 订阅 / 本地" value={provider.plan} onChange={event=>updateProvider({plan:event.target.value})}/></label>
      <label className="full"><span>API Base URL</span><input aria-label="API Base URL" spellCheck={false} placeholder="按供应商文档填写" value={provider.baseUrl} onChange={event=>updateProvider({baseUrl:event.target.value})}/><small>{service?.kind==='qwen-mt'?'填写对应业务空间的兼容模式地址。':service?'预设地址可按账户方案调整。更换地址后需重新填写密钥。':'填写 Chat Completions 的根地址，不含 /chat/completions。更换地址后需重新填写密钥。'}</small></label>
     </div>
     <details className="provider-advanced"><summary>高级连接设置 <ChevronDown size={12}/></summary><div className="provider-fields">
      <label className="full"><span>共享限流组（可选）</span><input aria-label="共享限流组" value={provider.rateLimitGroup||''} placeholder="同一个上游账户可填相同组名" onChange={event=>updateProvider({rateLimitGroup:event.target.value||undefined})}/><small>只共享调用限额，不共享本机保存的密钥。</small></label>
      {!service&&<><label><span>接口适配</span><select value={provider.kind} onChange={event=>updateProvider({kind:event.target.value as ModelProvider['kind'],passReasoning:event.target.value==='minimax'})}><option value="openai-compatible">OpenAI 兼容</option><option value="minimax">MiniMax 兼容</option></select></label><label><span>认证方式</span><select value={provider.auth} onChange={event=>{updateProvider({auth:event.target.value as ModelProvider['auth']});setKey('');}}><option value="bearer">API Key · Bearer</option><option value="none">无需认证（如本地模型）</option></select></label><label className="model-toggle"><input type="checkbox" checked={provider.includeUsage} onChange={event=>updateProvider({includeUsage:event.target.checked})}/>请求返回用量</label><label className="model-toggle"><input type="checkbox" checked={provider.passReasoning} onChange={event=>updateProvider({passReasoning:event.target.checked})}/>多轮传回 reasoning_content</label></>}
     </div></details>
     {!service?<>
      <div className="provider-models-heading"><h4>助手模型 <span>{models.length}</span></h4><div><button disabled={dirty||!savedProvider?.configured} onClick={()=>void remote('models')}><Download size={13}/>读取模型</button><button onClick={()=>{setModels(old=>[...old,newModel(provider.id)]);setDirty(true);clearFeedback();}}><Plus size={13}/>添加模型</button></div></div>
      {!!catalog.length&&<div className="provider-catalog">{catalog.map(item=><button key={item.id} disabled={models.some(model=>model.model===item.id)} onClick={()=>{setModels(old=>[...old,{...newModel(provider.id),model:item.id,label:item.id,contextWindow:item.contextWindow||0}]);setDirty(true);clearFeedback();}}>{item.id}<Plus size={11}/></button>)}</div>}
      <div className="provider-models">{models.map(model=><article className="provider-model-row" key={model.id}>
       <label><span>模型 ID</span><input aria-label={`模型 ID ${model.id}`} value={model.model} placeholder="供应商的模型 ID" onChange={event=>updateModel(model.id,{model:event.target.value,...(!model.label||model.label===model.model?{label:event.target.value}:{})})}/></label>
       <label><span>显示名称</span><input aria-label={`模型名称 ${model.id}`} value={model.label} onChange={event=>updateModel(model.id,{label:event.target.value})}/></label>
       <label><span>上下文 · tokens</span><input type="number" min="1000" max="10000000" aria-label={`上下文窗口 ${model.id}`} placeholder="按官方参数填写" value={model.contextWindow||''} onChange={event=>updateModel(model.id,{contextWindow:Number(event.target.value)})}/></label>
       <label><span>推理强度参数</span><select aria-label={`推理参数 ${model.id}`} value={model.reasoning} onChange={event=>updateModel(model.id,{reasoning:event.target.value as ProviderModel['reasoning']})}><option value="none">不发送 / 模型默认</option><option value="standard">low / medium / high</option><option value="extended">low 至 max</option></select></label>
       <label className="model-toggle"><input aria-label={`启用模型 ${model.id}`} type="checkbox" checked={model.enabled} onChange={event=>updateModel(model.id,{enabled:event.target.checked})}/></label>
       <button className="icon-button" aria-label={`移除模型 ${model.id}`} disabled={modelUses(model.id).length>0} title={modelUses(model.id).length?'先解除用途引用：'+modelUses(model.id).join('、'):'移除此模型'} onClick={()=>{setModels(old=>old.filter(item=>item.id!==model.id));setDirty(true);}}><Trash2 size={14}/></button>
       <label className="provider-model-capability"><span>工具调用</span><select aria-label={`工具调用能力 ${model.id}`} value={model.toolCalling||'unknown'} onChange={event=>updateModel(model.id,{toolCalling:event.target.value as ProviderModel['toolCalling']})}><option value="unknown">待检测（首次任务只读握手）</option><option value="supported">已支持原生工具调用</option><option value="unsupported">仅聊天</option></select><small>{modelUses(model.id).join('、')||'尚未分配用途'}</small></label>
      </article>)}</div>
      {!models.length&&<div className="model-empty-hint">保存连接后可读取模型列表，也可以直接添加模型 ID。</div>}
     </>:<div className="dedicated-engine"><label><span>翻译引擎</span>{service.models[0]==='text-translation'?<strong>文本翻译 · 支持检测原文语种</strong>:<><input aria-label="翻译模型 ID" list="translation-engine-models" value={models[0]?.model||''} onChange={event=>{const id=event.target.value;if(models[0])updateModel(models[0].id,{model:id,label:id});else{setModels([{...newModel(provider.id),model:id,label:id}]);setDirty(true);}}}/><datalist id="translation-engine-models">{service.models.map(id=><option key={id} value={id}/>)}</datalist></>}</label><small>{service.kind==='deepl'?'发送待译文本；开启阅读上下文时也会发送该上下文。不发送对话历史。':'仅发送待译文本和语种，不发送 PDF 文件或对话历史。'}</small></div>}
     <footer className="provider-actions">
      <button className="button" disabled={dirty||providerUses.length>0||!savedProvider} title={providerUses.length?'先解除用途引用：'+providerUses.join('、'):undefined} onClick={()=>void removeProvider()}><Trash2 size={13}/>移除连接</button>
      <button className="button" disabled={dirty||!configuredModel} title="仅发送固定测试样例，不使用工作区内容" onClick={()=>void remote('test')}>{network?<LoaderCircle size={13} className="spin"/>:<Cloud size={13}/>}测试连接</button>
      {service?<button className="button" disabled={dirty||!configuredModel||sourceBound} onClick={()=>void useForTranslation()}><Plus size={13}/>{sourceBound?'已加入翻译来源':legacyMiniMaxSource?'替换旧 MiniMax 来源':'加入翻译来源'}</button>:<button className="button" disabled={dirty||!configuredModel} onClick={()=>switchView('usage')}>配置默认模型 <ArrowRight size={13}/></button>}
      <button className="button" disabled={!dirty} onClick={()=>{loadProvider(config,tab,savedProvider?.id);clearFeedback();}}>取消更改</button><button className="button primary" disabled={!dirty} onClick={()=>void saveProvider()}>{busy?<LoaderCircle size={13} className="spin"/>:<Save size={13}/>}保存 {translating?'翻译':'助手'} API</button>
     </footer>
    </fieldset></section>}
   </div>}
  </>}
 </div></div>;
}
