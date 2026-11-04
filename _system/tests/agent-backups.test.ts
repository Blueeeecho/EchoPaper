import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/index';
import { registryPath } from '../server/model-providers';
import { DEFAULT_AGENT_LIMITS, defaultAgentDefinitions, type AgentRunDetail } from '../shared/agent-types';
import type { BuildService } from '../shared/types';
import { workspaceMaintenance } from '../server/agents/maintenance';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const fakeBuilds:BuildService={async request(){throw Error('No compilation expected');},async cancel(){throw Error('No compilation expected');},async list(){return[];},async get(){throw Error('No compilation expected');},async artifact(){throw Error('No compilation expected');},async createSubmission(){throw Error('No submissions expected');},async listSubmissions(){return[];},async submissionArtifact(){throw Error('No submissions expected');},async close(){}};
const deferred=()=>{let resolve!:()=>void;return{promise:new Promise<void>(done=>resolve=done),resolve:()=>resolve()};};
async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean){const started=Date.now();for(;;){const value=await read();if(accept(value))return value;if(Date.now()-started>5000)throw Error('Timed out waiting for agent backup fixture: '+JSON.stringify(value));await new Promise(resolve=>setTimeout(resolve,5));}}
const response=()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'只读检查完成，未修改正文。'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
const listFiles=()=>new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'list-project-files',type:'function',function:{name:'list_files',arguments:'{}'}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});

async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-agent-backups-'));await fs.mkdir(path.join(root,'shared/templates/english'),{recursive:true});await fs.writeFile(path.join(root,'shared/templates/english/main.tex'),'Original manuscript\n');await fs.mkdir(path.join(root,'archive'));await fs.writeFile(path.join(root,'archive/original.txt'),'Original import');await fs.mkdir(path.join(root,'_system/runtime'),{recursive:true});
 const config={version:2,providers:[{id:'fixture',label:'Injected test provider',kind:'openai-compatible',baseUrl:'https://provider.invalid/v1',auth:'none',plan:'test',enabled:true,includeUsage:false,passReasoning:false}],models:[{id:'fixture-model',providerId:'fixture',model:'fixture',label:'Fixture',contextWindow:1000000,reasoning:'none',enabled:true,toolCalling:'supported'}],assistant:{modelIds:['fixture-model'],defaultModelId:'fixture-model',roles:defaultAgentDefinitions(),limits:{...DEFAULT_AGENT_LIMITS}},translations:[],translationLayout:'stack'};await fs.writeFile(path.join(root,registryPath),JSON.stringify(config));
 let holdModel=false,modelCalls=0,upstreamSignal:AbortSignal|undefined,finishModel:(()=>void)|undefined;const createGate={armed:false,entered:deferred(),release:deferred()};
 const options={workspaceRoot:root,buildService:fakeBuilds,watch:false,ai:{getKey:async()=>{throw Error('No real credential access is allowed in this test');},fetch:(async(_url:unknown,init?:RequestInit)=>{modelCalls++;if(!holdModel){const body=JSON.parse(String(init?.body));return body.messages.some((message:{role:string})=>message.role==='tool')?response():listFiles();}upstreamSignal=init!.signal!;return new Response(new ReadableStream<Uint8Array>({start(controller){finishModel=()=>{controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'Finished'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'));controller.close();};upstreamSignal!.addEventListener('abort',()=>controller.error(new DOMException('Stopped','AbortError')),{once:true});}}),{headers:{'Content-Type':'text/event-stream'}});})as typeof fetch,timeoutMs:60000}};
 let app=await createApp(options);app.addHook('preHandler',async request=>{if(createGate.armed&&request.method==='POST'&&request.url==='/api/projects/Alpha/agent-runs'){createGate.entered.resolve();await createGate.release.promise;}});
 const created=await app.inject({method:'POST',url:'/api/projects',payload:{id:'Alpha',title:'Alpha',template:'english'}});assert.equal(created.statusCode,201,created.body);
 const input=()=>({requestId:crypto.randomUUID(),input:'读取论文文件列表，进行只读检查；不修改正文，也不需要编译。',targetId:'main',scope:{readOnly:true}});
 const task=async()=>{const result=await app.inject({method:'POST',url:'/api/projects/Alpha/agent-runs',payload:input()});assert.equal(result.statusCode,201,result.body);return result.json();};
 const complete=async(id:string)=>until(async()=>{const result=await app.inject(`/api/projects/Alpha/agent-runs/${id}`);assert.equal(result.statusCode,200,result.body);return result.json<AgentRunDetail>();},value=>value.run.status==='completed'&&value.events.some(event=>event.type==='report.saved'));
 return{root,options,get app(){return app;},input,task,complete,createGate,get modelCalls(){return modelCalls;},get upstreamSignal(){return upstreamSignal;},get finishModel(){return finishModel;},setHold(value:boolean){holdModel=value;},async backup(){const result=await app.inject({method:'POST',url:'/api/backups',payload:{label:'Agent state fixture'}});assert.equal(result.statusCode,201,result.body);return result.json();},async restart(){await app.close();app=await createApp(options);},async cleanup(){createGate.release.resolve();await app.close();await fs.rm(root,{recursive:true,force:true});}};
}

test('task creation and active runs block backup/restore, while maintenance blocks task create/resume',async()=>{
 const f=await fixture();let pending:Promise<unknown>|undefined;try{
  const backup=await f.backup(),preview=await f.app.inject({method:'POST',url:`/api/backups/${backup.id}/preview`,payload:{}});assert.equal(preview.statusCode,200,preview.body);const restorePayload={expectedFingerprint:preview.json().expectedFingerprint,confirmed:true};
  f.setHold(true);f.createGate.armed=true;const creating=Promise.resolve(f.app.inject({method:'POST',url:'/api/projects/Alpha/agent-runs',payload:f.input()}));pending=creating;await f.createGate.entered.promise;
  const pendingBackup=await f.app.inject({method:'POST',url:'/api/backups',payload:{label:'Must fail during task creation'}});assert.equal(pendingBackup.statusCode,409,pendingBackup.body);assert.match(pendingBackup.json().error,/保存|创建请求/);
  const pendingRestore=await f.app.inject({method:'POST',url:`/api/backups/${backup.id}/restore`,payload:restorePayload});assert.equal(pendingRestore.statusCode,409,pendingRestore.body);assert.match(pendingRestore.json().error,/保存/);assert.equal(f.modelCalls,0,'no model request started while create is held');
  f.createGate.armed=false;f.createGate.release.resolve();const created=await creating;assert.equal(created.statusCode,201,created.body);const run=created.json();await until(async()=>!!f.upstreamSignal,value=>value);
  for(const url of ['/api/backups',`/api/backups/${backup.id}/restore`]){const result=await f.app.inject({method:'POST',url,payload:url==='/api/backups'?{label:'Must fail for background task'}:restorePayload});assert.equal(result.statusCode,409,result.body);assert.match(result.json().error,/AI 任务/);}
  const cancel=await f.app.inject({method:'POST',url:`/api/projects/Alpha/agent-runs/${run.id}/cancel`,payload:{}});assert.equal(cancel.statusCode,200,cancel.body);assert.equal(cancel.json().run.status,'cancelled');assert.equal(f.upstreamSignal?.aborted,true);
  const before=f.modelCalls;await workspaceMaintenance(f.root).withMaintenance(async()=>{for(const[url,payload]of [['/api/projects/Alpha/agent-runs',f.input()],[`/api/projects/Alpha/agent-runs/${run.id}/resume`,{}]]as const){const result=await f.app.inject({method:'POST',url,payload});assert.equal(result.statusCode,503,result.body);assert.match(result.json().error,/恢复|备份|重启/);}assert.equal((await f.app.inject('/api/health')).statusCode,200);});assert.equal(f.modelCalls,before);
  f.setHold(false);const next=await f.task();await f.complete(next.id);const finalBackup=await f.backup();assert.ok(finalBackup.id,'the rejected maintenance attempts release their barriers');
 }finally{f.createGate.release.resolve();await pending?.catch(()=>{});await f.cleanup();}
});

test('a completed SQLite task and version-1 chat survive full backup and restore after newer task activity',async()=>{
 const f=await fixture();try{
  const first=await f.task(),saved=await f.complete(first.id),createdAt=new Date().toISOString();const chat={version:1,selectedId:'old-chat',conversations:[{id:'old-chat',title:'Existing chat',createdAt,updatedAt:createdAt,input:'Unsaved chat draft',model:'fixture-model',effort:'medium',messages:[{id:'old-user',role:'user',content:'Original question',createdAt,status:'complete',attachment:{path:'manuscript/main.tex',content:'Explicit original attachment'}},{id:'old-assistant',role:'assistant',content:'Original answer',createdAt,status:'complete',taskId:first.id}]}]};
  const chatSaved=await f.app.inject({method:'PUT',url:'/api/projects/Alpha/chats',payload:{data:chat,expectedHash:null}});assert.equal(chatSaved.statusCode,200,chatSaved.body);const backup=await f.backup();
  // Exercise compatibility with an earlier verified archive containing SQLite's
  // transient files. New snapshots exclude them; old valid snapshots still restore.
  await promisify(execFile)('/usr/bin/python3',['-c',`import hashlib,json,os,sys,zipfile
p=sys.argv[1]
with zipfile.ZipFile(p) as z:
 items=[(i,z.read(i)) for i in z.infolist() if i.filename!='manifest.json']
 m=json.loads(z.read('manifest.json'))
assert not any(f['path'].endswith(('agent-state.sqlite-shm','agent-state.sqlite-wal')) for f in m['files'])
extra=[('papers/Alpha/.workbench/agent-state.sqlite-shm',b'Legacy disposable WAL index'),('papers/Alpha/.workbench/agent-state.sqlite-wal',b'')]
for name,data in extra:
 m['files'].append({'path':name,'size':len(data),'mode':384,'sha256':hashlib.sha256(data).hexdigest()})
m['files'].sort(key=lambda f:f['path'])
m['sourceFingerprint']=hashlib.sha256(json.dumps({'files':m['files'],'directories':m['directories']},ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
with zipfile.ZipFile(p+'.legacy','w') as z:
 for item,data in items:z.writestr(item,data)
 for name,data in extra:z.writestr(name,data)
 z.writestr('manifest.json',json.dumps(m,ensure_ascii=False))
os.replace(p+'.legacy',p)
`,path.join(f.root,'backups',backup.id+'.zip')]);
  const second=await f.task();await f.complete(second.id);const modified=structuredClone(chat);modified.conversations[0].messages[0].content='Changed after the backup';const chatChanged=await f.app.inject({method:'PUT',url:'/api/projects/Alpha/chats',payload:{data:modified,expectedHash:chatSaved.json().hash}});assert.equal(chatChanged.statusCode,200,chatChanged.body);
  const preview=await f.app.inject({method:'POST',url:`/api/backups/${backup.id}/preview`,payload:{}});assert.equal(preview.statusCode,200,preview.body);
  const external=path.join(f.root,'papers/Alpha/notes/external-after-preview.md');await fs.writeFile(external,'Actual author edit after reviewing the restore.');const stale=await f.app.inject({method:'POST',url:`/api/backups/${backup.id}/restore`,payload:{expectedFingerprint:preview.json().expectedFingerprint,confirmed:true}});assert.equal(stale.statusCode,409,stale.body);assert.match(stale.json().error,/预检查后工作区已变化/);assert.equal(await fs.readFile(external,'utf8'),'Actual author edit after reviewing the restore.');
  const fresh=await f.app.inject({method:'POST',url:`/api/backups/${backup.id}/preview`,payload:{}});assert.equal(fresh.statusCode,200,fresh.body);const restored=await f.app.inject({method:'POST',url:`/api/backups/${backup.id}/restore`,payload:{expectedFingerprint:fresh.json().expectedFingerprint,confirmed:true}});assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().restartRequired,true);
  assert.equal((await f.app.inject({method:'POST',url:'/api/projects/Alpha/agent-runs',payload:f.input()})).statusCode,503,'restore maintenance persists until restart');await f.restart();
  const read=await f.app.inject(`/api/projects/Alpha/agent-runs/${first.id}`);assert.equal(read.statusCode,200,read.body);const detail=read.json<AgentRunDetail>();assert.equal(detail.run.status,'completed');assert.equal(detail.run.id,saved.run.id);assert.deepEqual(detail.tools,saved.tools);assert.deepEqual(detail.events,saved.events);assert.equal((await f.app.inject(`/api/projects/Alpha/agent-runs/${second.id}`)).statusCode,404,'newer run is absent from the restored SQLite snapshot');
  const chats=await f.app.inject('/api/projects/Alpha/chats');assert.equal(chats.statusCode,200,chats.body);assert.deepEqual(chats.json().data,chat);assert.ok(await fs.stat(path.join(f.root,`papers/Alpha/.workbench/agent-reports/${first.id}.md`)));assert.equal(await fs.stat(path.join(f.root,'papers/Alpha/notes/agent-runs')).catch(()=>null),null);assert.equal(f.modelCalls,4,'two tool-using tasks make two calls each; backup, restore and restart never invoke the model');
 }finally{await f.cleanup();}
});
