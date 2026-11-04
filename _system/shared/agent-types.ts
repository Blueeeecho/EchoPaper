import type {AgentAttachment} from './attachment-types';
export type AgentToolId = 'list_files' | 'read_file' | 'search_files' | 'read_diagnostics' | 'reference_index' | 'verify_reference' | 'inspect_pdf' | 'propose_changes' | 'apply_changes' | 'compile' | 'delegate';
export const AGENT_TOOL_IDS: AgentToolId[] = ['list_files','read_file','search_files','read_diagnostics','reference_index','verify_reference','inspect_pdf','propose_changes','apply_changes','compile','delegate'];
export interface AgentDefinition { id:string; name:string; description:string; instructions:string; modelId:string|null; tools:AgentToolId[]; enabled:boolean; maxSteps:number }
// modelCalls/tokens and role maxSteps are retained as zero-valued legacy fields; execution is unmetered.
export interface AgentLimits { modelCalls:number; tokens:number; minutes:number; parallelAgents:number; repairRounds:number }
export const DEFAULT_AGENT_LIMITS:AgentLimits={modelCalls:0,tokens:0,minutes:60,parallelAgents:3,repairRounds:0};
const reader:AgentToolId[]=['list_files','read_file','search_files','read_diagnostics','reference_index','verify_reference','inspect_pdf','propose_changes'];
export function defaultAgentDefinitions():AgentDefinition[]{
 const roles=[['coordinator','主助手','统筹任务、委派和验证','按用户限定范围完成任务，按需委派。只根据工具实际返回报告修改与验证结果。'],['writer','学术写作','结构与论证','保留作者事实和证据边界，不捏造结果，只提出范围内的增量修改。'],['polisher','文本润色','指定文本语言修改','保留语义、公式、命令、引用键及选区外文本，返回可审阅的修改。'],['formatter','格式检查','源码和 PDF 格式','检查源码、编译诊断及 PDF 信息，区分确定问题与无法验证的投稿要求。'],['references','文献核验','文献元数据与引用','通过实际检索核对文献，保留来源；无匹配或网络失败只能标为未核实。'],['repair','LaTeX 修复','编译与引用问题','定位当前版本问题，使用最小补丁，不修改官方模板或类文件，不虚构缺失事实。'],['organizer','文件整理','项目内文件与引用路径','整理项目内文件，移动须更新可确定的资源引用；动态路径不确定时停止该操作。']];
 return roles.map(([id,name,description,instructions])=>({id,name,description,instructions,modelId:null,tools:id==='coordinator'?[...reader,'apply_changes','compile','delegate']:[...reader],enabled:true,maxSteps:0}));
}
export interface AssistantSettings { modelIds:string[]; defaultModelId:string|null; roles:AgentDefinition[]; limits:AgentLimits }
export type AgentRunStatus='queued'|'running'|'waiting_confirmation'|'conflicted'|'cancelling'|'completed'|'failed'|'cancelled'|'interrupted'|'budget_exceeded';
export interface AgentScope { paths?:string[]; selection?:{path:string;from:number;to:number;documentText:string;selectedText:string}; readOnly?:boolean;skipCompile?:boolean }
export interface AgentConversationMessage {role:'user'|'assistant';content:string;attachments?:AgentAttachment[]}
export interface AgentCreateInput { requestId:string; conversationId?:string; expectedLastRunId?:string|null; input:string; attachments?:string[]; history?:AgentConversationMessage[]; compactionId?:string; targetId:string; modelId?:string; effort?:string; roleId?:string; scope?:AgentScope; buildId?:string; diagnostic?:{message:string;file?:string;line?:number} }
export interface ToolCall { id:string; runId:string; agentId:string; name:string; arguments:Record<string,unknown>; status:'running'|'completed'|'failed'; result?:unknown; error?:string; createdAt:string; finishedAt?:string }
export type ChangeOperation={kind:'write';path:string;content:string;expectedHash:string|null}|{kind:'move';from:string;to:string;expectedHash:string}|{kind:'delete';path:string;expectedHash:string}|{kind:'project';patch:{targets:{id:string;label:string;main:string}[]};expectedUpdatedAt:string};
export interface ChangeImage {path:string;beforeHash:string|null;afterHash:string|null;beforeBase64?:string;afterBase64?:string}
export interface ChangeSet {id:string;runId:string;description:string;operations:ChangeOperation[];readSet:Record<string,string|null>;status:'proposed'|'applying'|'applied'|'undone'|'conflicted'|'failed';images:ChangeImage[];createdAt:string;appliedAt?:string;checkpoint?:string;error?:string;projectBefore?:unknown;projectAfter?:unknown;undoOf?:string}
export interface RunEvent {seq:number;runId:string;type:string;createdAt:string;agentId?:string;data:unknown}
export interface AgentChild {id:string;roleId:string;name:string;status:'running'|'completed'|'failed'|'cancelled';task:string;result?:string;error?:string}
export interface AgentRun {id:string;projectId:string;conversationId?:string;requestId:string;input:string;attachments?:AgentAttachment[];targetId:string;modelId:string;status:AgentRunStatus;phase:string;createdAt:string;updatedAt:string;finishedAt?:string;configRevision:string;summary:string;reply?:string;error?:string;outcome?:'resolved'|'partial';scope:AgentScope;changesets:ChangeSet[];children:AgentChild[];buildIds:string[];verifiedSourceHash?:string;verifiedBuildId?:string;currentSourceVerified?:boolean;usage:{modelCalls:number;tokens:number;estimated:boolean};limits:AgentLimits;lastEventSeq:number;pendingDecision?:{id:string;message:string;changesetId?:string};version:number}
export interface AgentRunDetail {run:AgentRun;events:RunEvent[];tools:ToolCall[]}
export interface EditorBarrier {id:string;paths:string[];expiresAt:number}
export const ACTIVE_RUN_STATUSES:AgentRunStatus[]=['queued','running','cancelling'];
