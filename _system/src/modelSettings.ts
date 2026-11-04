import{api,json}from'./api';
import type{PublicRegistry,TranslationSource,ModelConfigPurpose}from'../shared/model-providers';
export const MODEL_CONFIG_EVENT='echopaper:model-config-changed';
export function openModelSettings(tab:'assistant'|'providers'|'translations'='assistant'){window.dispatchEvent(new CustomEvent('echopaper:open-model-settings',{detail:{tab}}));}
export const readModelRegistry=(signal?:AbortSignal)=>api<PublicRegistry>('/api/ai/providers',{signal});
export function modelSettingsChanged(purpose:ModelConfigPurpose='connections'){window.dispatchEvent(new CustomEvent(MODEL_CONFIG_EVENT,{detail:{purpose}}));}
export async function saveTranslationSources(config:PublicRegistry,sources:TranslationSource[],layout=config.translationLayout){const result=await api<PublicRegistry>('/api/ai/translations',json('PUT',{expectedRevision:config.revision,sources,layout}));modelSettingsChanged('translation');return result;}
export function moveTranslationSource<T>(sources:T[],from:number,to:number):T[]{if(from<0||to<0||from>=sources.length||to>=sources.length||from===to)return sources;const result=[...sources],item=result.splice(from,1)[0];result.splice(to,0,item);return result;}

export async function saveAssistantSettings(config:PublicRegistry,assistant:PublicRegistry['assistant']){const result=await api<PublicRegistry>('/api/ai/assistant',json('PUT',{expectedRevision:config.revision,assistant}));modelSettingsChanged('assistant');return result;}
