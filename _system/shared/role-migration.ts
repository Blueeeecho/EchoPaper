import type {AssistantSettings,AgentDefinition} from './agent-types';
import {defaultAgentDefinitions} from './agent-types';
import legacyDefaults from './legacy-agent-defaults.json';
const stable=(x:unknown):string=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export function migrateRoles(current:AssistantSettings):{assistant:AssistantSettings;changed:boolean;warnings:string[]}{
 const assistant=structuredClone(current),defaults=defaultAgentDefinitions(),warnings:string[]=[];
 assistant.roles=assistant.roles.map(role=>{
  if(legacyDefaults.some(prior=>stable(prior)===stable(role)))return structuredClone(defaults.find(d=>d.id===role.id)??role);
  if(role.id==='reviewer'&&stable(role)!==stable(defaults.find(d=>d.id==='reviewer')))warnings.push('reviewer 为定制角色，已保留原定义；未覆盖其审稿协议。');
  return role;
 });
 if(!assistant.roles.some(r=>r.id==='reviewer')){
  if(assistant.roles.length>=32)throw Error('角色已达32项，未修改；请先明确整理自定义角色。');
  assistant.roles.push(structuredClone(defaults.find(d=>d.id==='reviewer') as AgentDefinition));
 }
 return{assistant,changed:stable(current)!==stable(assistant),warnings};
}
export async function planRoleMigration(base:string,workspace:string,request:typeof fetch=fetch){
 const health=await request(base+'/api/health');if(!health.ok)throw Error('工作区状态读取失败');const info=await health.json();if(info.workspaceRoot!==workspace||!info.ok)throw Error('服务不属于当前工作区，拒绝迁移。');
 const response=await request(base+'/api/ai/providers');if(!response.ok)throw Error('公开配置读取失败');const before=await response.json();
 return{base,workspace,before,...migrateRoles(before.assistant)};
}
export async function applyRoleMigration(base:string,plan:Awaited<ReturnType<typeof planRoleMigration>>,request:typeof fetch=fetch){
 if(base!==plan.base)throw Error('迁移目标已变化，拒绝写入。');
 const health=await request(base+'/api/health');if(!health.ok)throw Error('迁移前状态核验失败');const info=await health.json();if(!info.ok||info.workspaceRoot!==plan.workspace)throw Error('迁移目标工作区已变化，拒绝写入。');
 if(!plan.changed)return{unchanged:true};
 const response=await request(base+'/api/ai/assistant',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:plan.before.revision,assistant:plan.assistant})});
 if(!response.ok)throw Error(`迁移未应用 HTTP ${response.status}；409 须重读比较，不自动覆盖重试。`);return response.json();
}
