import { createHash } from 'node:crypto';
import type { AgentConversationMessage, AgentCreateInput, AgentDefinition, AgentScope } from '../../shared/agent-types';

export interface ContextFragment {
 id:'base_chat'|'role_profile'|'role_catalog'|'tool_policy'|'project_context'|'provided_materials';
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
  scope:{...scope,...(selection?{selection:{path:selection.path,from:selection.from,to:selection.to}}:{})},
 });
 add('project_context','data',['project.json'],{project:options.project,target:options.target,files:'项目工具按需读取已保存文件；编辑器未保存内容以用户提供的文本为准。'});
 const preferred=input.roleId&&options.roles.find(role=>role.enabled&&role.id===input.roleId&&role.id!=='coordinator');
 add('provided_materials','data',['currentInput.scope.selection','currentInput.diagnostic','currentInput.buildId','currentInput.roleId','currentInput.attachments'],{
  ...(selection?{selection}:{}),...(input.diagnostic?{diagnostic:input.diagnostic}:{}),...(input.buildId?{buildId:input.buildId}:{}),...(preferred?{preferredRole:preferred.id}:{}),...(input.attachments?.length?{attachmentIds:input.attachments}:{}),
 });
 const history=options.history??input.history??[];
 return{version:1,sha256:digest(JSON.stringify(fragments)),fragments,history:{messages:history.length,characters:history.reduce((sum,message)=>sum+message.content.length,0)},...(options.conversation?{conversation:options.conversation}:{})};
}
export function renderContextManifest(manifest:AgentContextManifest):string {
 return manifest.fragments.map(fragment=>`<${fragment.id}>\n${fragment.content}\n</${fragment.id}>`).join('\n\n');
}
export function contextManifestSummary(manifest:AgentContextManifest){
 return{version:manifest.version,sha256:manifest.sha256,history:manifest.history,...(manifest.conversation?{conversation:manifest.conversation}:{}),fragments:manifest.fragments.map(({id,kind,sources,sha256,content})=>({id,kind,sources,sha256,characters:content.length}))};
}
