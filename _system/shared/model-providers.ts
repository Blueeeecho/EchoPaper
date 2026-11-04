import type {AssistantSettings} from './agent-types';
export type ModelConfigPurpose='assistant'|'translation'|'connections';
export type TranslationServiceKind='niutrans'|'baidu-translate'|'deepl'|'microsoft-translator'|'qwen-mt'|'siliconflow-translate'|'zhipu-translate';
export interface ModelProvider {id:string;label:string;kind:'minimax'|'openai-compatible'|TranslationServiceKind;baseUrl:string;plan:string;auth:'bearer'|'none';enabled:boolean;includeUsage:boolean;passReasoning:boolean;appId?:string;region?:string;rateLimitGroup?:string;updatedAt?:string}
export function isTranslationService(provider:Pick<ModelProvider,'kind'>):boolean{return !['minimax','openai-compatible'].includes(provider.kind);}
/** Dedicated translation engines use contextWindow=0: they cannot enter a chat session. */
export interface ProviderModel {id:string;providerId:string;model:string;label:string;contextWindow:number;reasoning:'none'|'standard'|'extended';enabled:boolean;toolCalling?:'unknown'|'supported'|'unsupported'}
export interface TranslationSource {id:string;label:string;modelId:string;enabled:boolean;color:string}
export interface ModelRegistry {version:2;providers:ModelProvider[];models:ProviderModel[];assistant:AssistantSettings;translations:TranslationSource[];translationLayout:'stack'|'columns'}
export interface PublicModel extends ProviderModel {configured:boolean;providerLabel:string;plan:string;efforts:string[];cacheVersion:string}
export interface PublicRegistry extends Omit<ModelRegistry,'providers'|'models'> {revision:string;translationFingerprint:string;assistantFingerprint:string;providers:(ModelProvider&{configured:boolean})[];models:PublicModel[]}
export function modelEfforts(model:ProviderModel):string[]{return model.reasoning==='extended'?['low','medium','high','xhigh','max']:model.reasoning==='standard'?['low','medium','high']:[];}
export const DEFAULT_PROVIDER:ModelProvider={id:'minimax',label:'MiniMax',kind:'minimax',baseUrl:'https://api.minimax.cn/v1',plan:'Token Plan',auth:'bearer',enabled:true,includeUsage:true,passReasoning:true};
export const DEFAULT_MODELS:ProviderModel[]=[{id:'MiniMax-M3.1-Flash',providerId:'minimax',model:'MiniMax-M3.1-Flash',label:'MiniMax-M3.1-Flash',contextWindow:1_000_000,reasoning:'extended',enabled:true,toolCalling:'supported'},{id:'MiniMax-M3',providerId:'minimax',model:'MiniMax-M3',label:'MiniMax-M3',contextWindow:1_000_000,reasoning:'none',enabled:true,toolCalling:'unknown'}];
