import { z } from 'zod';
import type { AgentDefinition, AgentRun, AgentToolId, ChangeOperation, ChangeSet } from '../../shared/agent-types';
import type { Build, BuildService } from '../../shared/types';
import type { ProjectSnapshot } from './project-snapshot';
import { agentPath, snapshotReferences } from './project-snapshot';
import type { ModelTool } from './model-gateway';
import { checkAbort } from './model-gateway';
import { verifyReference, inspectBuildPdf } from './evidence-tools';
import { HttpError } from '../security';

const empty=z.object({}).strict(),hash=z.string().regex(/^[a-f0-9]{64}$/),path=z.string().min(1).max(1000);
const operation=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('write'),path,content:z.string().max(3*1024*1024),expectedHash:hash.nullable()}).strict(),
 z.object({kind:z.literal('move'),from:path,to:path,expectedHash:hash}).strict(),
 z.object({kind:z.literal('delete'),path,expectedHash:hash}).strict(),
 z.object({kind:z.literal('project'),patch:z.object({targets:z.array(z.object({id:z.string(),label:z.string(),main:path}).strict()).min(1).max(30)}).strict(),expectedUpdatedAt:z.string().max(100)}).strict(),
]);
const schemas={
 list_files:empty,
 read_file:z.object({path,startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional()}).strict(),
 search_files:z.object({query:z.string().min(1).max(200)}).strict(),
 read_diagnostics:z.object({buildId:z.string().max(100).optional()}).strict(),
 reference_index:empty,
 verify_reference:z.object({doi:z.string().max(600).optional(),arxivId:z.string().max(200).optional(),title:z.string().max(500).optional()}).strict(),
 inspect_pdf:z.object({buildId:z.string().max(100).optional()}).strict(),
 propose_changes:z.object({description:z.string().min(1).max(2000),operations:z.array(operation).min(1).max(100)}).strict(),
 apply_changes:z.object({changesetId:z.string().min(1).max(100)}).strict(),
 compile:empty,
 delegate:z.object({roleId:z.string().min(1).max(100),task:z.string().min(1).max(30000)}).strict(),
};
const descriptions:Record<AgentToolId,string>={list_files:'读取当前项目快照的文件树和哈希。',read_file:'读取快照中的 UTF-8 文本或二进制元数据。必须使用返回的 hash 提出修改。',search_files:'在当前项目只读快照中搜索文本；最多 100 条结果。',read_diagnostics:'读取当前项目目标指定构建的诊断和日志；旧诊断仅作线索。',reference_index:'从当前只读快照解析引用条目与标签，不能证明目标已引入。',verify_reference:'向 Crossref 或 arXiv 核实 DOI/编号/标题；网络失败仅表示未核实。',inspect_pdf:'检查已成功构建 PDF 的页数尺寸元数据，不等于视觉验收。',propose_changes:'提出结构化增量 ChangeSet；本工具不修改主稿。移动支持二进制；删除须后续明确确认。',apply_changes:'由主助手单写入者应用已有 ChangeSet；服务端执行哈希、范围与编辑器检查。',compile:'显式编译当前目标，并校验冻结源码指纹与 PDF；最多配置的修复轮数。',delegate:'将独立工作交给已配置专业角色。子角色只读同一快照并提出 ChangeSet，不可写入或再次委派。'};
export interface AgentToolContext {
 run:AgentRun;role:AgentDefinition;agentId:string;isCoordinator:boolean;snapshot:ProjectSnapshot;readSet:Record<string,string|null>;signal:AbortSignal;builds:BuildService;referenceFetch?:typeof fetch;
 propose(description:string,operations:ChangeOperation[],readSet:Record<string,string|null>):Promise<ChangeSet>;
 apply(id:string):Promise<unknown>;compile():Promise<Build>;delegate(roleId:string,task:string):Promise<unknown>;
}
export function availableTools(context:Pick<AgentToolContext,'role'|'isCoordinator'|'run'>):ModelTool[] {
 const writeOnly=new Set<AgentToolId>(['apply_changes','compile','delegate']);
 return context.role.tools.filter(id=>id in schemas&&(context.isCoordinator||!writeOnly.has(id))&&(!context.run.scope.readOnly||!['apply_changes','compile'].includes(id))).map(id=>({type:'function',function:{name:id,description:descriptions[id],parameters:z.toJSONSchema(schemas[id]) as Record<string,unknown>}}));
}
export async function executeAgentTool(context:AgentToolContext,name:string,input:unknown):Promise<unknown> {
 checkAbort(context.signal);if(!availableTools(context).some(tool=>tool.function.name===name))throw new HttpError(403,'该角色或任务没有此工具权限。');
 const parsed=schemas[name as AgentToolId].safeParse(input);if(!parsed.success)throw new HttpError(400,'工具参数不符合结构：'+parsed.error.issues.slice(0,3).map(issue=>issue.path.join('.')+' '+issue.message).join('；'));
 const args=parsed.data as Record<string,any>,{snapshot}=context;
 switch(name as AgentToolId){
  case'list_files':return{capturedAt:snapshot.capturedAt,files:snapshot.entries.map(entry=>({...entry,...(snapshot.files[entry.path]?{hash:snapshot.files[entry.path].hash,binary:snapshot.files[entry.path].binary}:{})})),boundary:'这是本轮读取快照，写入前会再次校验磁盘。'};
  case'read_file':{const path=agentPath(args.path),file=snapshot.files[path];context.readSet[path]=file?.hash??null;if(!file)throw new HttpError(404,'快照中不存在此文件。');if(file.text===undefined)return{path,hash:file.hash,binary:true,size:file.size};const lines=file.text.split('\n'),from=args.startLine??1,to=Math.min(lines.length,args.endLine??Math.min(lines.length,from+1199));if(from>lines.length||to<from)throw new HttpError(400,'文件行范围无效。');return{path,hash:file.hash,content:lines.slice(from-1,to).join('\n'),startLine:from,endLine:to,totalLines:lines.length,truncated:from>1||to<lines.length};}
  case'search_files':{const results=[];for(const file of Object.values(snapshot.files)){if(file.text===undefined)continue;context.readSet[file.path]=file.hash;for(const[index,line]of file.text.split('\n').entries())if(line.toLowerCase().includes(args.query.toLowerCase())){results.push({path:file.path,line:index+1,text:line.slice(0,500)});if(results.length>=100)return{results,truncated:true};}}return{results,truncated:false};}
  case'reference_index':{for(const file of Object.values(snapshot.files))if(/\.(bib|tex)$/i.test(file.path))context.readSet[file.path]=file.hash;return snapshotReferences(snapshot);}
  case'read_diagnostics':{const id=args.buildId||context.run.buildIds.at(-1);const build=id?await context.builds.get(id):(await context.builds.list(context.run.projectId)).filter(value=>value.targetId===context.run.targetId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];if(!build||build.projectId!==context.run.projectId||build.targetId!==context.run.targetId)throw new HttpError(404,'未找到当前项目目标的构建。');return{...build,log:build.log.slice(-50000)};}
  case'verify_reference':return verifyReference(args,context.signal,context.referenceFetch);
  case'inspect_pdf':return inspectBuildPdf(context.run.projectId,context.run.targetId,context.builds,args.buildId,context.signal);
  case'propose_changes':{for(const op of args.operations as ChangeOperation[]){if(op.kind==='project')continue;const source=agentPath(op.kind==='move'?op.from:op.path);const expected=snapshot.files[source]?.hash??null;if(expected!==op.expectedHash)throw new HttpError(409,'修改基线与本轮只读快照不一致，请先读取目标文件。');context.readSet[source]=expected;if(op.kind==='move'){const to=agentPath(op.to);context.readSet[to]=snapshot.files[to]?.hash??null;}}
   const change=await context.propose(args.description,args.operations,{...context.readSet});return{id:change.id,status:change.status,description:change.description,files:change.images.map(image=>({path:image.path,beforeHash:image.beforeHash,afterHash:image.afterHash}))};}
  case'apply_changes':return context.apply(args.changesetId);
  case'compile':return context.compile();
  case'delegate':return context.delegate(args.roleId,args.task);
 }
}
