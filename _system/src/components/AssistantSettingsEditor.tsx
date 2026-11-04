import {useState} from 'react';
import {Plus,Trash2} from 'lucide-react';
import {AGENT_TOOL_IDS,defaultAgentDefinitions,type AgentDefinition,type AgentLimits,type AgentToolId,type AssistantSettings} from '../../shared/agent-types';
import {isTranslationService,type PublicRegistry} from '../../shared/model-providers';
import '../assistant-settings.css';

const toolLabels:Record<AgentToolId,string>={list_files:'列出文件',read_file:'读取文件',search_files:'搜索正文',read_diagnostics:'读取诊断',reference_index:'引用索引',verify_reference:'核验文献',inspect_pdf:'检查 PDF',propose_changes:'提出修改',apply_changes:'应用修改',compile:'编译验证',delegate:'委派角色'};
const limitFields:{key:keyof Pick<AgentLimits,'minutes'|'parallelAgents'>;label:string;min:number;max:number}[]=[{key:'minutes',label:'最长运行 · 分钟',min:1,max:1440},{key:'parallelAgents',label:'同时运行角色',min:1,max:8}];
export default function AssistantSettingsEditor({config,value,onChange,onError}:{config:PublicRegistry;value:AssistantSettings;onChange:(value:AssistantSettings)=>void;onError:(message:string)=>void}){
 const[templateId,setTemplateId]=useState('');
 const models=config.models.filter(model=>!isTranslationService(config.providers.find(provider=>provider.id===model.providerId)!));
 const main=value.roles.find(role=>role.id==='coordinator'),templates=defaultAgentDefinitions().filter(role=>role.id!=='coordinator'&&!value.roles.some(item=>item.id===role.id)),template=templates.find(role=>role.id===templateId)||templates[0];
 const mainOnlyTools=new Set<AgentToolId>(['apply_changes','compile','delegate']);
 const patchRole=(id:string,patch:Partial<AgentDefinition>)=>onChange({...value,roles:value.roles.map(role=>role.id===id?{...role,...patch}:role)});
 function toggleModel(modelId:string,enabled:boolean){
  const references=value.roles.filter(role=>role.modelId===modelId);if(!enabled&&references.length){onError('请先调整引用此模型的角色：'+references.map(role=>role.name).join('、'));return;}
  onChange({...value,modelIds:enabled?[...value.modelIds,modelId]:value.modelIds.filter(id=>id!==modelId),defaultModelId:!enabled&&value.defaultModelId===modelId?null:value.defaultModelId});
 }
 return <div className="assistant-settings-content">
  <div className="assistant-settings-intro"><h3>AI 助手</h3><p>直接与主助手对话。它按需要调用工具，或选择已启用的专业角色协作。划词翻译单独配置。</p><p>不限制调用次数或累计 tokens，按需继续，可手动停止。</p></div>
  <section className="assistant-settings-section"><h4>可用模型</h4><p>连接可以复用，也可以在「连接与模型」为助手单独添加账户和密钥。</p>
   <div className="assistant-model-choices">{models.map(model=><label key={model.id}><input type="checkbox" aria-label={`助手允许模型 ${model.label}`} checked={value.modelIds.includes(model.id)} onChange={event=>toggleModel(model.id,event.target.checked)}/><span><strong>{model.providerLabel} · {model.label}</strong><small>{model.configured?'已配置':!model.enabled?'模型未启用':'待配置 / 连接未启用'} · 工具调用{model.toolCalling==='supported'?'已支持':model.toolCalling==='unsupported'?'不支持':'待检测'}</small></span></label>)}</div>
   {!models.length&&<p>先在「连接与模型」添加聊天模型。</p>}
   <label className="assistant-default-model"><span>默认模型</span><select aria-label="助手默认模型" value={value.defaultModelId||''} onChange={event=>onChange({...value,defaultModelId:event.target.value||null})}><option value="">尚未选择</option>{models.filter(model=>value.modelIds.includes(model.id)).map(model=><option key={model.id} value={model.id}>{model.providerLabel} · {model.label}</option>)}</select></label>
   <small>未选择默认模型时，开始对话前需明确选择；专业角色可以跟随主助手使用同一模型。</small>
  </section>
  <section className="assistant-settings-section"><div className="assistant-role-heading"><div><h4>主助手与可选专业角色</h4><p>只需保留主助手。其余角色都可以停用或删除，无须逐一配置才能使用。</p></div><button className="button" disabled={value.roles.length>=32} onClick={()=>onChange({...value,roles:[...value.roles,{id:'role-'+crypto.randomUUID(),name:'新角色',description:'',instructions:'',modelId:null,tools:['list_files','read_file','search_files','propose_changes'],enabled:true,maxSteps:0}]})}><Plus size={13}/>添加角色</button></div>
   <p>专业角色只读取材料并提出修改，由主助手决定应用与验证。角色权限不会扩大本次任务的论文、文件或选区范围。</p>
   {!main&&<div className="assistant-role-template"><span>当前缺少主助手。</span><button className="button" disabled={value.roles.length>=32} onClick={()=>onChange({...value,roles:[defaultAgentDefinitions()[0],...value.roles]})}>恢复主助手</button></div>}
   <div className="assistant-role-template"><label><span>可选专业角色模板</span><select aria-label="专业角色模板" disabled={!template} value={template?.id||''} onChange={event=>setTemplateId(event.target.value)}>{templates.length?templates.map(role=><option key={role.id} value={role.id}>{role.name} · {role.description}</option>):<option value="">内置模板均已添加，可停用或删除</option>}</select></label><button className="button" disabled={!template||value.roles.length>=32} onClick={()=>{if(template)onChange({...value,roles:[...value.roles,{...template,enabled:true}]});}}><Plus size={13}/>添加模板</button><button className="button" disabled={!value.roles.some(role=>role.id!=='coordinator'&&role.enabled)} onClick={()=>onChange({...value,roles:value.roles.map(role=>role.id==='coordinator'?role:{...role,enabled:false})})}>停用全部专业角色</button></div>
   <div className="assistant-role-list">{value.roles.map(role=><details className="assistant-role" key={role.id}><summary><strong>{role.name}</strong><span>{role.description||'自定义角色'}</span><small>{role.id==='coordinator'?'主助手 · 必需':role.enabled?'可选 · 启用':'可选 · 停用'}</small></summary><div className="assistant-role-fields">
    <label><span>名称</span><input aria-label={`角色名称 ${role.id}`} value={role.name} maxLength={80} onChange={event=>patchRole(role.id,{name:event.target.value})}/></label>
    <label><span>说明</span><input aria-label={`角色说明 ${role.id}`} value={role.description} maxLength={500} onChange={event=>patchRole(role.id,{description:event.target.value})}/></label>
    <label><span>{role.id==='coordinator'?'主助手模型':'角色模型（可跟随主助手）'}</span><select aria-label={`角色模型 ${role.id}`} value={role.modelId||''} onChange={event=>patchRole(role.id,{modelId:event.target.value||null})}><option value="">{role.id==='coordinator'?'使用助手默认模型':'跟随主助手本轮模型'}</option>{models.filter(model=>value.modelIds.includes(model.id)).map(model=><option key={model.id} value={model.id}>{model.providerLabel} · {model.label}</option>)}</select></label>
    <label className="assistant-role-prompt"><span>角色提示词</span><textarea aria-label={`角色提示词 ${role.id}`} value={role.instructions} rows={4} maxLength={20000} onChange={event=>patchRole(role.id,{instructions:event.target.value})}/></label>
    <div className="assistant-tool-choices">{AGENT_TOOL_IDS.map(tool=><label key={tool} title={role.id!=='coordinator'&&mainOnlyTools.has(tool)?'此工具仅由主助手执行':''}><input type="checkbox" aria-label={`${role.name} 工具 ${toolLabels[tool]}`} disabled={role.id!=='coordinator'&&mainOnlyTools.has(tool)} checked={role.tools.includes(tool)&&!(role.id!=='coordinator'&&mainOnlyTools.has(tool))} onChange={event=>patchRole(role.id,{tools:event.target.checked?[...role.tools,tool]:role.tools.filter(value=>value!==tool)})}/>{toolLabels[tool]}</label>)}</div>
    <div className="assistant-role-footer"><label><input type="checkbox" aria-label={`启用角色 ${role.id}`} disabled={role.id==='coordinator'&&role.enabled} checked={role.enabled} onChange={event=>patchRole(role.id,{enabled:event.target.checked})}/>{role.id==='coordinator'?'主助手保持启用':'允许主助手按需委派'}</label><button className="button" disabled={role.id==='coordinator'} title={role.id==='coordinator'?'主助手必须保留；专业角色均可删除':'删除此可选角色'} onClick={()=>onChange({...value,roles:value.roles.filter(item=>item.id!==role.id)})}><Trash2 size={13}/>删除角色</button></div>
   </div></details>)}</div>
  </section>
  <section className="assistant-settings-section"><h4>运行设置</h4><p>运行时长和并行角色沿用请求启动时的设置。</p><div className="assistant-limits">{limitFields.map(field=><label key={field.key}><span>{field.label}</span><input aria-label={field.label} type="number" min={field.min} max={field.max} value={value.limits[field.key]} onChange={event=>onChange({...value,limits:{...value.limits,[field.key]:Number(event.target.value)}})}/></label>)}</div></section>
 </div>;
}
