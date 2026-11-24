import {useEffect,useState} from 'react';
import {Check,Cloud,KeyRound,LoaderCircle,ScanText} from 'lucide-react';
import {readOcrCredentials,saveOcrCredential,testOcrCredential,type OcrCredentialStatus} from '../modelSettings';
import {ocrSetups,type OcrEngineId} from '../serviceSetup';
import ServiceSetupGuide from './ServiceSetupGuide';

export default function OcrSettings({initialEngine,onDirty,onBusy}:{initialEngine?:OcrEngineId;onDirty:(value:boolean)=>void;onBusy:(value:boolean)=>void}){
 const [engine,setEngine]=useState<OcrEngineId>(initialEngine??'unlimited-ocr');
 const [status,setStatus]=useState<OcrCredentialStatus>();
 const [key,setKey]=useState(''),[busy,setBusy]=useState<'save'|'test'>(),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [loadAttempt,setLoadAttempt]=useState(0);
 const guide=ocrSetups[engine],configured=status?.engines[engine];
 useEffect(()=>{
  const controller=new AbortController();
  setError('');
  void readOcrCredentials(controller.signal).then(setStatus).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
  return ()=>controller.abort();
 },[loadAttempt]);
 function edit(value:string){setKey(value);onDirty(!!value);setError('');setNotice('');}
 async function run(action:'save'|'test'){
  if(busy||!status||(action==='save'?!key.trim():!configured||!!key))return;
  setBusy(action);onBusy(true);setError('');setNotice('');
  try{
   if(action==='save'){
    await saveOcrCredential(engine,key.trim());
    setStatus({...status,engines:{...status.engines,[engine]:true}});
    edit('');setNotice('凭据已保存，尚未测试。可先测试，再回阅读器选择此引擎。');
   }else{
    const result=await testOcrCredential(engine);
    if(result.ok)setNotice(result.message);else setError(result.message);
   }
  }catch(error){setError(error instanceof Error?error.message:'OCR 设置操作失败，请重试。');}
  finally{setBusy(undefined);onBusy(false);}
 }
 return <section className="ocr-settings-panel" aria-label="OCR 凭据设置">
  <div className="settings-section-heading"><h3>选择文档解析引擎</h3><p>OCR 识别 PDF 的文字与版面，译文由翻译 API 生成。</p></div>
  <div className="ocr-engine-choices" aria-label="OCR 引擎">
   {(Object.keys(ocrSetups) as OcrEngineId[]).map(id=><button key={id} type="button" aria-pressed={engine===id} disabled={!!busy||!!key} onClick={()=>{setEngine(id);setError('');setNotice('');}}>
    <ScanText size={17}/><span><strong>{ocrSetups[id].label}</strong><small>{ocrSetups[id].summary}</small></span>
    <span className={status?.engines[id]?'configured':''}>{!status?'未读取':status.engines[id]?'已保存':'未配置'}</span>
   </button>)}
  </div>
  <ServiceSetupGuide guide={guide}/>
  {error&&<p className="ocr-feedback error" role="alert">{error}{!status&&<button className="button" onClick={()=>setLoadAttempt(value=>value+1)}>重试读取</button>}</p>}
  {notice&&<p className="ocr-feedback success" role="status"><Check size={14}/>{notice}</p>}
  {!status&&!error&&<p className="ocr-feedback" role="status">正在读取凭据状态…</p>}
  <form id="ocr-credential-form" onSubmit={event=>{event.preventDefault();void run('save');}}>
   <label className="ocr-key-field"><span><KeyRound size={13}/>{guide.keyLabel}</span><input type="password" autoComplete="new-password" spellCheck={false} value={key} disabled={!status||!!busy} placeholder={configured?'已配置；仅在更换时填写':guide.placeholder} onChange={event=>edit(event.target.value)}/></label>
   <footer className="provider-actions">
    <span>保存和测试均不提交 PDF。自动预处理仍按阅读库设置运行。</span>
    <button type="button" className="button" disabled={!!busy||!key} onClick={()=>edit('')}>取消更改</button>
    <button type="button" className="button" disabled={!!busy||!configured||!!key} onClick={()=>void run('test')}>{busy==='test'?<LoaderCircle size={14} className="spin"/>:<Cloud size={14}/>}测试凭据</button>
    <button type="submit" className="button primary" disabled={!status||!!busy||!key.trim()}>{busy==='save'?'正在保存…':'保存 OCR 凭据'}</button>
   </footer>
  </form>
 </section>;
}
