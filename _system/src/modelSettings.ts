import{api,json}from'./api';
import type{PublicRegistry,TranslationSource,ModelConfigPurpose}from'../shared/model-providers';
import {isOcrEngineId,type OcrEngineId} from './serviceSetup';
export const MODEL_CONFIG_EVENT='echopaper:model-config-changed';
export const OCR_CONFIG_EVENT='echopaper:ocr-config-changed';
export type ModelSettingsTab='assistant'|'translations'|'ocr';
export interface ModelSettingsTarget{tab:ModelSettingsTab;ocrEngine?:OcrEngineId}
export interface OcrCredentialStatus{engine:OcrEngineId;engines:Record<OcrEngineId,boolean>}
export function modelSettingsTarget(event:Event):ModelSettingsTarget{
 const requested=(event as CustomEvent).detail;
 const tab=requested?.tab==='translations'||requested?.tab==='ocr'?requested.tab:'assistant';
 return {tab,ocrEngine:tab==='ocr'&&isOcrEngineId(requested?.ocrEngine)?requested.ocrEngine:undefined};
}
export function openModelSettings(tab:ModelSettingsTab='assistant',ocrEngine?:string){window.dispatchEvent(new CustomEvent('echopaper:open-model-settings',{detail:{tab,ocrEngine}}));}
export const readOcrCredentials=(signal?:AbortSignal)=>api<OcrCredentialStatus>('/api/workspace/bilingual/credential',{signal});
export async function saveOcrCredential(engine:OcrEngineId,key:string){
 await api('/api/workspace/bilingual/credential',json('PUT',{engine,key}));
 window.dispatchEvent(new CustomEvent(OCR_CONFIG_EVENT,{detail:{engine}}));
}
export const testOcrCredential=(engine:OcrEngineId)=>api<{ok:boolean;message:string}>('/api/workspace/bilingual/credential/test',json('POST',{engine}));
export const readModelRegistry=(signal?:AbortSignal)=>api<PublicRegistry>('/api/ai/providers',{signal});
export function modelSettingsChanged(purpose:ModelConfigPurpose='connections'){window.dispatchEvent(new CustomEvent(MODEL_CONFIG_EVENT,{detail:{purpose}}));}
export async function saveTranslationSources(config:PublicRegistry,sources:TranslationSource[],layout=config.translationLayout){const result=await api<PublicRegistry>('/api/ai/translations',json('PUT',{expectedRevision:config.revision,sources,layout}));modelSettingsChanged('translation');return result;}
export function moveTranslationSource<T>(sources:T[],from:number,to:number):T[]{if(from<0||to<0||from>=sources.length||to>=sources.length||from===to)return sources;const result=[...sources],item=result.splice(from,1)[0];result.splice(to,0,item);return result;}

export async function saveAssistantSettings(config:PublicRegistry,assistant:PublicRegistry['assistant']){const result=await api<PublicRegistry>('/api/ai/assistant',json('PUT',{expectedRevision:config.revision,assistant}));modelSettingsChanged('assistant');return result;}
