import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {researchCalendar,researchDay,researchDayReport,researchMonthDays,shiftResearchDay,progressNextSteps} from '../shared/research-calendar.ts';
import {registerWorkspaceRoutes} from '../server/workspace/index.ts';
import {openCatalog} from '../server/workspace/catalog.ts';
import type {ResearchTopic} from '../shared/workspace-types.ts';

const topic:ResearchTopic={id:'topic',title:'研究A',description:'',paperIds:[],presentationIds:[],resourceIds:[],archived:false,revision:1,createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z',progressEntries:[
 {id:'original',createdAt:'2026-11-01T17:00:00Z',content:'保留但已被更正',nextStep:'旧计划',supersededBy:'amended'},
 {id:'amended',createdAt:'2026-11-05T01:00:00Z',content:'已核对图表。\n\n原始说明保留。',nextStep:'- 补充对照\n2. 检查图注',amendsId:'original'}]};

test('Beijing day boundaries, leap/month/year rollover and Monday-first calendar',()=>{
 assert.equal(researchDay('2026-11-01T15:59:59Z'),'2026-11-01');assert.equal(researchDay('2026-11-01T16:00:00Z'),'2026-11-02');
 assert.equal(shiftResearchDay('2026-12-31',1),'2027-01-01');assert.equal(shiftResearchDay('2028-02-28',1),'2028-02-29');
 const days=researchMonthDays('2026-11');assert.equal(days.length,42);assert.equal(days[0],'2026-10-26');assert.ok(days.includes('2026-11-30'));
});
test('daily reports keep amendment lineage, separate plans and confirmed checkbox state, and preserve sources',()=>{
 const snapshot=JSON.stringify(topic),result=researchCalendar([topic]);
 assert.equal(result.records.length,1);assert.equal(result.records[0].day,'2026-11-02');assert.equal(result.records[0].amended,true);
 assert.deepEqual(result.tasks.map(t=>[t.day,t.text,t.done]),[['2026-11-03','补充对照',false],['2026-11-03','检查图注',false]]);
 const done=researchCalendar([{...topic,dailyTaskStates:{'amended:0':{done:true,updatedAt:''}}}]);assert.equal(done.tasks[0].done,true);assert.equal(done.tasks[1].done,false);
 const report=researchDayReport('2026-11-02',[topic]);assert.ok(report.includes('原始说明保留'));assert.ok(report.includes('2026-11-03 待办'));assert.ok(report.includes('来源记录：amended'));assert.ok(!report.includes('旧计划'));
 assert.equal(JSON.stringify(topic),snapshot);assert.deepEqual(progressNextSteps('- [x] 做对照\n\n• 查来源\n3、改图'),['做对照','查来源','改图']);
 assert.equal(researchCalendar([]).records.length,0);
});
test('task completion is persisted, revision-protected, and rejects superseded or unrelated sources; resources sort numerically before pagination',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'calendar-'));
 const resources=Array.from({length:20},(_,i)=>({id:`r${i+1}`,rootId:'root',path:`${i+1}_Paper.pdf`,name:`${i+1}_Paper.pdf`,kind:'file' as const,size:0,modifiedAt:'',tags:[],missing:false,revision:1})).reverse();
 const catalog=await openCatalog(root);catalog.state.topics=[structuredClone(topic)];catalog.state.resources=resources;await catalog.save();catalog.close();
 const start=async()=>{const app=Fastify();app.setErrorHandler((e,_r,reply)=>reply.code((e as Error&{statusCode?:number}).statusCode||500).send({error:(e as Error).message}));const service=await registerWorkspaceRoutes(app,root,{watch:false});await app.ready();return {app,async close(){await service.close();await app.close();}};};
 let runtime=await start();
 try{
  const url='/api/workspace/topics/topic/daily-tasks/';
  for(const [suffix,status] of [['original/0',409],['unknown/0',404],['amended/9',404],['amended/-1',400]] as const)assert.equal((await runtime.app.inject({method:'PATCH',url:url+suffix,payload:{expectedRevision:1,done:true}})).statusCode,status);
  assert.equal((await runtime.app.inject({method:'PATCH',url:url+'amended/0',payload:{expectedRevision:1,done:'yes'}})).statusCode,400);
  const changed=await runtime.app.inject({method:'PATCH',url:url+'amended/0',payload:{expectedRevision:1,done:true}});assert.equal(changed.statusCode,200);assert.equal(changed.json().revision,2);assert.deepEqual(changed.json().progressEntries,topic.progressEntries);
  assert.equal((await runtime.app.inject({method:'PATCH',url:url+'amended/1',payload:{expectedRevision:1,done:true}})).statusCode,409);
  const first=(await runtime.app.inject('/api/workspace/resources?limit=10')).json();const second=(await runtime.app.inject('/api/workspace/resources?offset=10&limit=10')).json();assert.deepEqual([...first.resources,...second.resources].map((r:{name:string})=>Number(r.name.split('_')[0])),Array.from({length:20},(_,i)=>i+1));
  await runtime.close();runtime=await start();
  const saved=(await runtime.app.inject('/api/workspace/topics')).json().topics[0];assert.equal(saved.dailyTaskStates['amended:0'].done,true);assert.deepEqual(saved.progressEntries,topic.progressEntries);
 }finally{await runtime.close();await fs.rm(root,{recursive:true,force:true});}
});
