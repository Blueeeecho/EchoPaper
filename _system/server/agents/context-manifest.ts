import {ASSISTANT_OUTPUT_POLICY} from '../../shared/research-writing-prompts';
import { createHash } from 'node:crypto';
import type { AgentConversationMessage, AgentCreateInput, AgentDefinition, AgentScope } from '../../shared/agent-types';
import {writingObjective} from '../../shared/writing-objective';

export interface ContextFragment {
 id:'base_chat'|'role_profile'|'role_catalog'|'tool_policy'|'project_context'|'provided_materials'|'response_style';
 kind:'instruction'|'data';sources:string[];content:string;sha256:string;
}
export interface AgentContextManifest {
 version:1;sha256:string;fragments:ContextFragment[];
 // Diagnostics for the local record, never rendered into the model's instructions.
 history:{messages:number;characters:number};
 conversation?:{id?:string;source:'empty'|'chat'|'runs'|'stored'|'legacy';lastRunId:string|null};
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function createContextManifest(options:{
 baseInstructions:string;role:AgentDefinition;roles:AgentDefinition[];
 project:{id:string;title:string};target:{id:string;label:string;main:string};
 modelId:string;toolCalling:string;tools:string[];scope:AgentScope;input:AgentCreateInput;
 history?:AgentConversationMessage[];conversation?:AgentContextManifest['conversation'];
}):AgentContextManifest {
 const {scope,input}=options,selection=scope.selection;
 const fragments:ContextFragment[]=[];
 const add=(id:ContextFragment['id'],kind:ContextFragment['kind'],sources:string[],value:unknown)=>{
  const content=typeof value==='string'?value:JSON.stringify(value);
  fragments.push({id,kind,sources,content,sha256:digest(content)});
 };
 add('base_chat','instruction',['runtime.baseInstructions'],options.baseInstructions);
 add('role_profile','instruction',[`registry.assistant.roles.${options.role.id}.instructions`],'项目工作职责（用户交办具体论文工作时适用）：'+options.role.instructions);
 add('role_catalog','data',['registry.assistant.roles'],options.roles.filter(role=>role.enabled&&role.id!=='coordinator').map(({id,name,description})=>({id,name,description})));
 add('tool_policy','data',[`registry.assistant.roles.${options.role.id}.tools`,`registry.models.${options.modelId}.toolCalling`,'currentInput.scope'],{
  roleId:options.role.id,modelId:options.modelId,toolCalling:options.toolCalling,tools:options.tools,
  ...(options.toolCalling==='unsupported'?{capability:'当前模型支持对话和已提供材料分析；项目操作需要支持原生工具的模型，仅在用户请求这类操作时说明。'}:{}),
  writingTask:input.writingTask,
  objective:writingObjective(input.input),
  objectEditing:'换图使用 propose_changes 单条 replace_figure（figure编号、attachmentId）；替换保留原图环境、图注、标签与其他正文，不新增图或顺延编号。重命名仅给 move 的 from/to，程序绑定冻结版本并同步引用。局部改文优先 patch 的唯一 oldText/newText。提交一组完整建议或应用成功后结束，不能自行扩为全稿修复。',
  reading:'可按需读取当前论文写作目录中的相关文件。下方文件或选区限制用于写入，不限制在本项目内查阅上下文。',
  ...(input.editContext?{targetDeclaration:'每次 propose_changes 同批声明结构化 target。作者要求限定文件时使用 {kind:"files",paths:[准确路径]}；限定所选文字时使用 {kind:"selection",path:"选文路径"}，服务端绑定作者提供的选文并验证范围，必要时可用 selectedText 声明其中的子串。其他跨文件任务可使用 {kind:"project"}。先根据用户本轮要求与定位材料确定实际对象，读取相关文件后提交；路径、原文与哈希由服务端核验。'}:{}),
  ...(scope.readOnly?{readOnlyNotice:'本轮只读：没有任何写入或编译工具。用户若要求修改，不要反复检索试图实现；读取定位所需的少量文件后直接回答，并说明本轮未修改文件。'}:{}),
  scope:{...scope,...(selection?{selection:{path:selection.path,from:selection.from,to:selection.to}}:{})},
 });
 add('project_context','data',['project.json'],{project:options.project,target:options.target,files:'可列出、检索并按需读取当前论文的整个写作目录，包括章节、图表源码、参考文献、笔记及可见的自定义子目录。编辑器未保存内容以用户提供的文本为准。'});
 const preferred=input.roleId&&options.roles.find(role=>role.enabled&&role.id===input.roleId&&role.id!=='coordinator');
 add('provided_materials','data',['currentInput.scope.selection','currentInput.editContext','currentInput.diagnostic','currentInput.buildId','currentInput.roleId','currentInput.attachments'],{
  ...(input.editContext?{editContext:{path:input.editContext.path,...(input.editContext.selection?{selection:{path:input.editContext.selection.path,from:input.editContext.selection.from,to:input.editContext.selection.to,selectedText:input.editContext.selection.selectedText}}:{})}}:{}),
  ...(selection?{selection}:{}),...(input.diagnostic?{diagnostic:input.diagnostic}:{}),...(input.buildId?{buildId:input.buildId}:{}),...(preferred?{preferredRole:preferred.id}:{}),...(input.attachments?.length?{attachmentIds:input.attachments}:{}),
 });
 add('response_style','instruction',['shared/research-writing-prompts.ASSISTANT_OUTPUT_POLICY'],ASSISTANT_OUTPUT_POLICY);
 const history=options.history??input.history??[];
 return{version:1,sha256:digest(JSON.stringify(fragments)),fragments,history:{messages:history.length,characters:history.reduce((sum,message)=>sum+message.content.length,0)},...(options.conversation?{conversation:options.conversation}:{})};
}
export function renderContextManifest(manifest:AgentContextManifest):string {
 return manifest.fragments.map(fragment=>`<${fragment.id}>\n${fragment.content}\n</${fragment.id}>`).join('\n\n');
}
export function contextManifestSummary(manifest:AgentContextManifest){
 return{version:manifest.version,sha256:manifest.sha256,history:manifest.history,...(manifest.conversation?{conversation:manifest.conversation}:{}),fragments:manifest.fragments.map(({id,kind,sources,sha256,content})=>({id,kind,sources,sha256,characters:content.length}))};
}
