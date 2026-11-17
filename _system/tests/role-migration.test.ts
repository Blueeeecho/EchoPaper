import {test} from 'node:test';import assert from 'node:assert/strict';
import {migrateRoles,planRoleMigration,applyRoleMigration} from '../shared/role-migration';
import legacy from '../shared/legacy-agent-defaults.json';
import {defaultAgentDefinitions,DEFAULT_AGENT_LIMITS,type AssistantSettings} from '../shared/agent-types';
const settings=():AssistantSettings=>({modelIds:['existing'],defaultModelId:'existing',roles:structuredClone(legacy.slice(0,7)) as AssistantSettings['roles'],limits:{...DEFAULT_AGENT_LIMITS}});
test('defaults migrate idempotently and all per-field customizations survive',()=>{
 const before=settings(),p=migrateRoles(before);assert.equal(p.assistant.roles.filter(r=>r.enabled).length,4);assert.deepEqual(p.assistant.modelIds,before.modelIds);assert.equal(p.assistant.defaultModelId,before.defaultModelId);assert.deepEqual(p.assistant.limits,before.limits);assert.equal(migrateRoles(p.assistant).changed,false);
 const variants={name:'custom',description:'custom',instructions:'custom',modelId:'custom',tools:['read_file'],enabled:false,maxSteps:3};
 for(const [key,value] of Object.entries(variants)){const s=settings();Object.assign(s.roles[1],{[key]:value});assert.deepEqual(migrateRoles(s).assistant.roles[1],s.roles[1],key);}
 const collision=settings();collision.roles.push({...defaultAgentDefinitions().find(r=>r.id==='reviewer')!,instructions:'My own reviewer'});const c=migrateRoles(collision);assert.equal(c.assistant.roles.at(-1)?.instructions,'My own reviewer');assert.equal(c.warnings.length,1);
 const full=settings();while(full.roles.length<32)full.roles.push({...full.roles[1],id:'custom-'+full.roles.length});assert.throws(()=>migrateRoles(full),/32/);
});
test('workspace validation precedes config reads and a conflict never retries or changes other purposes',async()=>{
 const calls:{url:string;body?:any}[]=[],publicConfig={revision:'before',assistant:settings(),defaultModel:'keep',translations:[{id:'keep'}],providers:[{id:'keep'}]};
 const fake:typeof fetch=async(url,init)=>{calls.push({url:String(url),body:init?.body?JSON.parse(String(init.body)):undefined});return String(url).endsWith('/api/health')?Response.json({ok:true,workspaceRoot:'/workspace'}):String(url).endsWith('/api/ai/providers')?Response.json(publicConfig):new Response('{}',{status:409});};
 await assert.rejects(planRoleMigration('http://127.0.0.1:1','/wrong',fake),/不属于/);assert.equal(calls.length,1);calls.length=0;
 const plan=await planRoleMigration('http://127.0.0.1:1','/workspace',fake);await assert.rejects(applyRoleMigration('http://127.0.0.1:1',plan,fake),/409/);assert.equal(calls.filter(c=>c.body).length,1);assert.deepEqual(Object.keys(calls.at(-1)!.body).sort(),['assistant','expectedRevision']);assert.equal(calls.at(-1)!.body.expectedRevision,'before');assert.deepEqual(plan.before,publicConfig);
});
