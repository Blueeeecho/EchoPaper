import {requiredCollaboration} from './collaboration-policy';
import { z } from 'zod';
import type { AgentDefinition, AgentEditTarget, AgentRun, AgentToolId, ChangeOperation, ChangeSet } from '../../shared/agent-types';
import type { Build, BuildService } from '../../shared/types';
import type { ProjectSnapshot } from './project-snapshot';
import { agentPath, snapshotReferences } from './project-snapshot';
import type { ModelTool } from './model-gateway';
import { checkAbort } from './model-gateway';
import { verifyReference, inspectBuildPdf } from './evidence-tools';
import { HttpError } from '../security';
import {writingObjective} from '../../shared/writing-objective';
import {locateFigure,replacementOperations,patchOperations,assetInventory} from './object-edits';

const empty=z.object({}).strict(),hash=z.string().regex(/^[a-f0-9]{64}$/),path=z.string().min(1).max(1000);
const editTarget=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('project')}).strict(),
 z.object({kind:z.literal('files'),paths:z.array(path).min(1).max(200)}).strict(),
 z.object({kind:z.literal('selection'),path,selectedText:z.string().min(1).max(50000).optional()}).strict(),
]);
const operation=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('write'),path,content:z.string().max(3*1024*1024),expectedHash:hash.nullable()}).strict(),
 z.object({kind:z.literal('attachment'),path,attachmentId:z.string().uuid(),expectedHash:hash.nullable()}).strict(),
 z.object({kind:z.literal('move'),from:path,to:path,expectedHash:hash.optional()}).strict(),
 z.object({kind:z.literal('patch'),path,oldText:z.string().min(1).max(100000),newText:z.string().max(100000)}).strict(),
 z.object({kind:z.literal('replace_figure'),figure:z.union([z.number().int().min(1).max(1000),z.string().regex(/^[1-9]\d{0,2}$/)]),attachmentId:z.string().uuid()}).strict(),
 z.object({kind:z.literal('delete'),path,expectedHash:hash}).strict(),
 z.object({kind:z.literal('project'),patch:z.object({targets:z.array(z.object({id:z.string(),label:z.string(),main:path}).strict()).min(1).max(30)}).strict(),expectedUpdatedAt:z.string().max(100)}).strict(),
]);
const schemas={
 accept_review:z.object({childId:z.string().min(1).max(100),disposition:z.string().min(1).max(10000),unresolved:z.array(z.string().min(1).max(2000)).max(100)}).strict(),
 list_files:empty,
 read_file:z.object({path,startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional()}).strict(),
 search_files:z.object({query:z.string().min(1).max(200)}).strict(),
 read_diagnostics:z.object({buildId:z.string().max(100).optional(),includeLog:z.boolean().optional()}).strict(),
 reference_index:empty,
 verify_reference:z.object({doi:z.string().max(600).optional(),arxivId:z.string().max(200).optional(),title:z.string().max(500).optional()}).strict(),
 inspect_pdf:z.object({buildId:z.string().max(100).optional()}).strict(),
 propose_changes:z.object({description:z.string().min(1).max(2000),target:editTarget.optional(),operations:z.array(operation).min(1).max(100)}).strict(),
 apply_changes:z.object({changesetId:z.string().min(1).max(100)}).strict(),
 compile:empty,
 delegate:z.object({roleId:z.string().min(1).max(100),task:z.string().min(1).max(30000),rework:z.boolean().optional()}).strict(),
};
const descriptions:Record<AgentToolId,string>={accept_review:'主助手核对已返回的真实审阅，逐项记录采纳或拒绝理由和未解项。必须实际读取当前文件；版本不符拒绝验收。',list_files:'读取当前项目快照的文件树和哈希。',read_file:'读取快照中的 UTF-8 文本或二进制元数据。必须使用返回的 hash 提出修改。',search_files:'在当前项目只读快照中搜索文本；最多 100 条结果。',read_diagnostics:'读取当前目标的构建状态和诊断；需要具体日志时显式设 includeLog:true。旧诊断仅作线索。',reference_index:'从当前只读快照解析引用条目与标签，不能证明目标已引入。',verify_reference:'向 Crossref 或 arXiv 核实 DOI/编号/标题；网络失败仅表示未核实。',inspect_pdf:'检查已成功构建 PDF 的页数尺寸元数据，不等于视觉验收。',propose_changes:'提出可审阅增量建议，不修改主稿。局部文字优先 kind=patch,path,oldText,newText（唯一原文，程序绑定冻结快照哈希）；换图优先单条 kind=replace_figure,figure（编号）,attachmentId，程序保留原环境、图注、标签和其他正文。素材重命名只需 kind=move,from,to，不必手写hash，程序从本轮冻结快照绑定并同步引用；不能通过改后缀转换编码。插图用 kind=attachment、attachmentId、path、expectedHash（新文件为 null）复制本会话附件原件；与图环境和图注的 write 操作同批提交。移动支持二进制；删除须后续明确确认。',apply_changes:'由主助手单写入者应用已有 ChangeSet；服务端执行哈希、范围与编辑器检查。',compile:'显式编译当前目标，并校验冻结源码指纹与 PDF；最多配置的修复轮数。',delegate:'将独立工作交给已配置专业角色。子角色只读同一快照并提出 ChangeSet，不可写入或再次委派。'};
export interface AgentToolContext {
 run:AgentRun;role:AgentDefinition;agentId:string;isCoordinator:boolean;snapshot:ProjectSnapshot;readSet:Record<string,string|null>;signal:AbortSignal;builds:BuildService;referenceFetch?:typeof fetch;targetMain?:string;attachmentIds?:readonly string[];attachmentMetadata?:{id:string;mimeType:string}[];
 propose(description:string,operations:ChangeOperation[],readSet:Record<string,string|null>,target?:AgentEditTarget):Promise<ChangeSet>;
 acceptReview?(childId:string,disposition:string,unresolved:string[]):Promise<unknown>;
 apply(id:string):Promise<unknown>;compile():Promise<Build>;delegate(roleId:string,task:string,rework?:boolean):Promise<unknown>;
}
function toolSchema(run:AgentRun,id:AgentToolId){return id==='propose_changes'&&run.targeting==='structured'?schemas.propose_changes.extend({target:editTarget}):schemas[id];}
export function availableTools(context:Pick<AgentToolContext,'role'|'isCoordinator'|'run'>):ModelTool[] {
 const contract=context.run.writingTask;
 const focused=new Set<AgentToolId>(['list_files','read_file','search_files','read_diagnostics','propose_changes','apply_changes','compile','inspect_pdf']);
 if(requiredCollaboration(context.run.input ?? '').length){focused.add('delegate');focused.add('accept_review');}
 const writeOnly=new Set<AgentToolId>(['apply_changes','compile','delegate','accept_review']);
 return context.role.tools.filter(id =>
  id in schemas &&
  (!contract || contract.kind !== 'focused' || focused.has(id)) &&
  (!contract || contract.verification === 'compile' || !['compile', 'inspect_pdf'].includes(id)) &&
  (!contract || !context.run.scope.skipCompile || !['compile', 'inspect_pdf'].includes(id)) &&
  (!contract || contract.outputMode !== 'suggest' || id !== 'apply_changes') &&
  (context.isCoordinator || !writeOnly.has(id)) &&
  (!context.run.scope.readOnly || !['propose_changes', 'apply_changes', 'compile'].includes(id))
 ).map(id => ({type:'function',function:{name:id,description:descriptions[id],parameters:z.toJSONSchema(toolSchema(context.run,id)) as Record<string,unknown>}}));
}
export async function executeAgentTool(context:AgentToolContext,name:string,input:unknown):Promise<unknown> {
 checkAbort(context.signal);if(!availableTools(context).some(tool=>tool.function.name===name))throw new HttpError(403,'该角色或任务没有此工具权限。');
 const parsed=toolSchema(context.run,name as AgentToolId).safeParse(input);if(!parsed.success)throw new HttpError(400,'工具参数不符合结构：'+parsed.error.issues.slice(0,3).map(issue=>issue.path.join('.')+' '+issue.message).join('；'));
 const args=parsed.data as Record<string,any>;
 // Write boundaries are enforced by createChangeSet. Context reads may inspect
 // other files in this project's already-filtered snapshot to understand TeX.
 const snapshot=context.snapshot;
 switch(name as AgentToolId){
  case'list_files':return{capturedAt:snapshot.capturedAt,files:snapshot.entries.map(entry=>({...entry,...(snapshot.files[entry.path]?{hash:snapshot.files[entry.path].hash,binary:snapshot.files[entry.path].binary}:{})})),...(writingObjective(context.run.input)?.kind==='rename_assets'&&context.targetMain?{assetInventory:assetInventory(snapshot,context.targetMain)}:{}),boundary:'这是本轮读取快照，写入前会再次校验磁盘。'};
  case'read_file':{const path=agentPath(args.path),file=snapshot.files[path];if(!file)throw new HttpError(404,'此路径未包含在当前快照，请使用文件树中的准确相对路径。',{requestedPath:path,availablePaths:Object.keys(snapshot.files).slice(0,80)});context.readSet[path]=file.hash;if(file.text===undefined)return{path,hash:file.hash,binary:true,size:file.size};const lines=file.text.split('\n'),from=args.startLine??1,to=Math.min(lines.length,args.endLine??Math.min(lines.length,from+1199));if(from>lines.length||to<from)throw new HttpError(400,'文件行范围无效。');return{path,hash:file.hash,content:lines.slice(from-1,to).join('\n'),startLine:from,endLine:to,totalLines:lines.length,truncated:from>1||to<lines.length};}
  case'search_files':{const results=[];for(const file of Object.values(snapshot.files)){if(file.text===undefined||writingObjective(context.run.input)&&/\.(?:cls|sty|bst|bbx|cbx|def|cfg|clo|fd|ltx)$/i.test(file.path))continue;context.readSet[file.path]=file.hash;for(const[index,line]of file.text.split('\n').entries())if(line.toLowerCase().includes(args.query.toLowerCase())){results.push({path:file.path,line:index+1,text:line.slice(0,500)});if(results.length>=100)return{results,truncated:true};}}return{results,truncated:false};}
  case'reference_index':{for(const file of Object.values(snapshot.files))if(/\.(bib|tex)$/i.test(file.path))context.readSet[file.path]=file.hash;return snapshotReferences(snapshot);}
  case'read_diagnostics':{const id=args.buildId||context.run.buildIds.at(-1);
   const latest=async()=>(await context.builds.list(context.run.projectId)).filter(value=>value.targetId===context.run.targetId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
   // A build id from an earlier session may be gone. Fall back to the current target's latest build
   // and say which one this is, instead of failing the whole task on a stale reference.
   let build=id?await context.builds.get(id).catch(()=>undefined):await latest();
   let replaced='';
   if(id&&(!build||build.projectId!==context.run.projectId||build.targetId!==context.run.targetId)){replaced=id;build=await latest();}
   if(!build||build.projectId!==context.run.projectId||build.targetId!==context.run.targetId)throw new HttpError(404,'当前目标还没有可读取的构建记录；请先编译，或不要依赖构建诊断继续。');
   const {log,...summary}=build;
   if(replaced)return{...summary,requestedBuildUnavailable:replaced,note:`构建 ${replaced} 已不存在，以下是当前目标最近一次构建；不要再用该编号重试。`,...(args.includeLog?{log:log.slice(-12000),logTruncated:log.length>12000}:{logAvailable:!!log})};
return{...summary,...(args.includeLog?{log:log.slice(-12000),logTruncated:log.length>12000}:{logAvailable:!!log,logHint:'需要具体编译日志时，使用 includeLog:true。'})};}
  case'verify_reference':return verifyReference(args,context.signal,context.referenceFetch);
  case'inspect_pdf':return inspectBuildPdf(context.run.projectId,context.run.targetId,context.builds,args.buildId,context.signal);
  case'propose_changes':{
   const replacement=args.operations.find((op:any)=>op.kind==='replace_figure'),objective=writingObjective(context.run.input);
   if(replacement){
    replacement.figure=Number(replacement.figure);
    if(args.operations.length!==1||!context.targetMain)throw new HttpError(400,'replace_figure 需要当前编译目标且必须单独提交。');
    if(objective?.kind!=='replace_figure'||replacement.figure!==objective.number)throw new HttpError(400,'换图编号与本次用户目标不一致。');
    const attachment=context.attachmentMetadata?.find(item=>item.id===replacement.attachmentId);
    if(!attachment||!context.attachmentIds?.includes(attachment.id))throw new HttpError(403,'换图附件不属于本次会话已提供的材料。');
    args.operations=replacementOperations(snapshot,context.targetMain,locateFigure(snapshot,context.targetMain,replacement.figure,context.readSet),attachment,context.readSet);
   }else args.operations=patchOperations(snapshot,args.operations);
   if(objective?.kind==='rename_assets'&&args.operations.some((op:ChangeOperation)=>!['move','write'].includes(op.kind)))throw new HttpError(400,'素材重命名只提交 move 映射；引用由程序同步，不能另行改写正文。');
   if(context.run.writingTask?.kind==='focused'&&args.operations.some((op:ChangeOperation)=>!['write','attachment'].includes(op.kind)))throw new HttpError(403,'局部写作只允许修改指定文本或导入插图。');for(const op of args.operations as ChangeOperation[]){if(op.kind==='project')continue;const source=agentPath(op.kind==='move'?op.from:op.path);const expected=snapshot.files[source]?.hash??null;if(expected!==op.expectedHash)throw new HttpError(409,'修改基线与本轮只读快照不一致，请先读取目标文件。');context.readSet[source]=expected;if(op.kind==='move'){const to=agentPath(op.to);context.readSet[to]=snapshot.files[to]?.hash??null;}}
   const change=await context.propose(args.description,args.operations,{...context.readSet},args.target);return{id:change.id,status:change.status,description:change.description,...(change.target?{target:change.target}:{}),files:change.images.map(image=>({path:image.path,beforeHash:image.beforeHash,afterHash:image.afterHash}))};}
  case'apply_changes':return context.apply(args.changesetId);
  case'compile':return context.compile();
  case'accept_review':if(!context.isCoordinator||!context.acceptReview)throw new HttpError(403,'仅主助手可以验收。');return context.acceptReview(args.childId,args.disposition,args.unresolved);
  case'delegate':return context.delegate(args.roleId,args.task,args.rework);
 }
}
