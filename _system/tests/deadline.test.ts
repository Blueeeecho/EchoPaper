import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { localDeadlineToUtc, formatDeadlineLocal, validateDeadlineConfiguration, deadlineCountdown, countdownText, validLegacyDeadline } from '../shared/deadline.ts';
import { createApp } from '../server/index.ts';
import type { BuildService, Project } from '../shared/types.ts';

test('deadline conversion honors explicit Beijing, UTC, AoE and regional zones independent of host timezone',()=>{
  assert.equal(localDeadlineToUtc('2026-10-31T23:59','Asia/Shanghai'),'2026-10-31T15:59:00.000Z');
  assert.equal(localDeadlineToUtc('2026-10-31T23:59','UTC'),'2026-10-31T23:59:00.000Z');
  assert.equal(localDeadlineToUtc('2026-10-31T23:59','Etc/GMT+12'),'2026-11-01T11:59:00.000Z');
  assert.equal(formatDeadlineLocal('2026-11-01T11:59:00.000Z','Asia/Shanghai'),'2026-11-01T19:59');
  assert.equal(localDeadlineToUtc('2026-07-01T23:59','America/Los_Angeles'),'2026-07-02T06:59:00.000Z');
  assert.equal(localDeadlineToUtc('2026-12-01T23:59','America/Los_Angeles'),'2026-12-02T07:59:00.000Z');
});

test('CCFDDL real second precision survives AoE, UTC, and Pacific roundtrips',()=>{
  for(const [local,zone,utc] of [
    ['2026-10-31T23:59:59','Etc/GMT+12','2026-11-01T11:59:59.000Z'],
    ['2026-10-31T23:59:59','UTC','2026-10-31T23:59:59.000Z'],
    ['2026-07-01T23:59:59','America/Los_Angeles','2026-07-02T06:59:59.000Z'],
    ['2026-12-01T23:59:59','America/Los_Angeles','2026-12-02T07:59:59.000Z']
  ]){assert.equal(localDeadlineToUtc(local,zone),utc);assert.equal(formatDeadlineLocal(utc,zone),local);assert.equal(validateDeadlineConfiguration(utc,zone).deadlineAt,utc);}
  assert.equal(deadlineCountdown('2026-11-01T11:59:59.000Z',Date.parse('2026-11-01T11:59:00Z')).totalMinutes,0);
});
test('DST gaps and repeated local times are rejected rather than silently choosing an instant',()=>{
  assert.throws(()=>localDeadlineToUtc('2026-03-08T02:30','America/Los_Angeles'),/不存在/);
  assert.throws(()=>localDeadlineToUtc('2026-11-01T01:30','America/Los_Angeles'),/出现两次/);
  assert.throws(()=>validateDeadlineConfiguration('2026-11-01T08:30:00Z','America/Los_Angeles'),/出现两次/);
  assert.equal(localDeadlineToUtc('2026-11-01T08:30','UTC'),'2026-11-01T08:30:00.000Z');
});
test('invalid civil dates, implicit offsets and incomplete precision are rejected',()=>{
  for(const value of ['2026-02-30T12:00','2026-13-01T12:00','2026-12-01T24:00','2026-12-01','2026-12-01T12:00Z','2026-12-01T12:00:60']) assert.throws(()=>localDeadlineToUtc(value,'UTC'));
  for(const zone of ['','AoE','local','Mars/Olympus','+08:00']) assert.throws(()=>localDeadlineToUtc('2026-12-01T12:00',zone));
  assert.throws(()=>validateDeadlineConfiguration('2026-02-30T12:00:00Z','UTC'));
  assert.equal(validateDeadlineConfiguration('2026-12-01T12:00:30Z','UTC').deadlineAt,'2026-12-01T12:00:30.000Z');
  assert.equal(validLegacyDeadline('2026-12-01'),'2026-12-01');assert.throws(()=>validLegacyDeadline('2026-02-30'));
});
test('countdown uses minute precision, treats exact deadline as expired, and handles long spans',()=>{
  const at='2026-12-01T12:00:00.000Z',epoch=Date.parse(at);
  assert.deepEqual(deadlineCountdown(at,epoch-((2*1440+3*60+4)*60000)),{expired:false,totalMinutes:3064,days:2,hours:3,minutes:4});
  assert.equal(deadlineCountdown(at,epoch-1).totalMinutes,0);assert.equal(countdownText(deadlineCountdown(at,epoch-1)),'正文截止剩余不足1分');assert.equal(countdownText(deadlineCountdown(at,epoch)),'已截止');
  assert.equal(countdownText(deadlineCountdown(at,epoch+60001)),'已截止 1分');assert.equal(countdownText(deadlineCountdown(at,epoch-60001)),'正文截止剩余 1分');
});
const fakeBuilds:BuildService={async request(){throw Error('unused');},async cancel(){throw Error('unused');},async list(){return [];},async get(){throw Error('unused');},async artifact(){throw Error('unused');},async createSubmission(){throw Error('unused');},async listSubmissions(){return [];},async submissionArtifact(){throw Error('unused');},async close(){}};
test('project API persists precise deadlines, preserves unknown legacy times, validates DST and clears explicitly',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-deadline-'));const folder=path.join(root,'papers','Deadline');await fs.mkdir(path.join(folder,'manuscript'),{recursive:true});await fs.writeFile(path.join(folder,'manuscript','main.tex'),'Source remains unchanged.');
  const project:Project={schemaVersion:1,id:'Deadline',title:'Deadline fixture',stage:'writing',venue:'',deadline:'2026-12-01',targets:[{id:'main',label:'Main',main:'manuscript/main.tex'}],autoCompile:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await fs.writeFile(path.join(folder,'project.json'),JSON.stringify(project));
  const app=await createApp({workspaceRoot:root,buildService:fakeBuilds,watch:false});
  try{
    let response=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{venue:'Example conference'}});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().deadline,'2026-12-01');assert.equal(response.json().deadlineAt,undefined);
    response=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{deadlineAt:'2026-11-01T11:59:00Z',deadlineTimezone:'Etc/GMT+12'}});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().deadline,'2026-10-31');assert.equal(response.json().deadlineAt,'2026-11-01T11:59:00.000Z');
    response=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{deadlineAt:'2026-11-01T08:30:00Z',deadlineTimezone:'America/Los_Angeles'}});assert.equal(response.statusCode,400,response.body);
    const disk=JSON.parse(await fs.readFile(path.join(folder,'project.json'),'utf8'));assert.equal(disk.deadlineAt,'2026-11-01T11:59:00.000Z');
    response=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{deadlineAt:'',deadlineTimezone:''}});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().deadline,'');assert.equal(response.json().deadlineAt,undefined);assert.equal(response.json().deadlineTimezone,undefined);
    response=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{deadlineAt:'2026-12-01T12:00:00Z'}});assert.equal(response.statusCode,400,response.body);
    response=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{deadline:'2026-02-30'}});assert.equal(response.statusCode,400,response.body);assert.equal(await fs.readFile(path.join(folder,'manuscript','main.tex'),'utf8'),'Source remains unchanged.');
  }finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});

test('conference provenance is validated, retained with seconds, and removed after unmarked manual changes',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-conference-settings-'));const folder=path.join(root,'papers','Deadline');await fs.mkdir(path.join(folder,'manuscript'),{recursive:true});
  const project:Project={schemaVersion:1,id:'Deadline',title:'Fixture',stage:'writing',venue:'',deadline:'',targets:[{id:'main',label:'Main',main:'manuscript/main.tex'}],autoCompile:false,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'};
  await fs.writeFile(path.join(folder,'project.json'),JSON.stringify(project));const app=await createApp({workspaceRoot:root,buildService:fakeBuilds,watch:false});
  const source={sourceUrl:'https://ccfddl.top/',conferenceId:'iclr',year:2027,roundId:'iclr27-paper',fetchedAt:'2026-10-22T08:00:00.000Z',officialUrl:'https://iclr.cc/',notes:'CCFDDL 日期按 23:59:59 解释。'};
  const payload={venue:'ICLR 2027',deadlineAt:'2026-11-01T11:59:59.000Z',deadlineTimezone:'Etc/GMT+12',deadlineSource:source};
  try{
    let r=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload});assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().deadlineSource,source);assert.equal(r.json().deadlineAt,payload.deadlineAt);
    for(const invalid of [{...source,apiKey:'not-supported'},{...source,sourceUrl:'https://example.com/'},{...source,year:'2027'},{...source,fetchedAt:'yesterday'},{...source,officialUrl:'javascript:alert(1)'},{...source,conferenceId:''}]){r=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{deadlineSource:invalid}});assert.equal(r.statusCode,400,r.body);}
    r=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{autoCompile:true}});assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().deadlineSource,source);
    r=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{deadlineAt:'2026-11-01T12:00:59.000Z'}});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().deadlineSource,undefined);
    r=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload});assert.equal(r.statusCode,200,r.body);
    r=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{deadlineAt:'',deadlineTimezone:'',deadlineSource:null}});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().deadlineSource,undefined);assert.equal(r.json().venue,'ICLR 2027');
    r=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{deadlineSource:source}});assert.equal(r.statusCode,400,r.body);
  }finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});
test('project optimistic writes reject competing stale settings inside the project lock',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-settings-conflict-'));const folder=path.join(root,'papers','Deadline');await fs.mkdir(folder,{recursive:true});
  const project:Project={schemaVersion:1,id:'Deadline',title:'Baseline',stage:'writing',venue:'',deadline:'',targets:[{id:'main',label:'Main',main:'manuscript/main.tex'}],autoCompile:false,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'};await fs.writeFile(path.join(folder,'project.json'),JSON.stringify(project));const app=await createApp({workspaceRoot:root,buildService:fakeBuilds,watch:false});
  try{
    const results=await Promise.all(['First editor','Second editor'].map(title=>app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{title,expectedUpdatedAt:project.updatedAt}})));
    assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);const success=results.find(r=>r.statusCode===200)!.json(),conflict=results.find(r=>r.statusCode===409)!.json();assert.equal(conflict.current.title,success.title);assert.equal(conflict.current.updatedAt,success.updatedAt);
    let response=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{stage:'polishing'}});assert.equal(response.statusCode,200,response.body);
    response=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{title:'Stale cannot win',expectedUpdatedAt:success.updatedAt}});assert.equal(response.statusCode,409,response.body);assert.equal(response.json().current.stage,'polishing');
    response=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{title:'Resolved',expectedUpdatedAt:response.json().current.updatedAt}});assert.equal(response.statusCode,200,response.body);
    response=await app.inject({method:'PATCH',url:'/api/projects/Deadline',payload:{expectedUpdatedAt:13}});assert.equal(response.statusCode,400,response.body);
  }finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});
