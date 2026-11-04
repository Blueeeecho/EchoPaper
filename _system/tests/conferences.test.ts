import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { conferenceTimezone, parseConferenceData, registerConferenceRoutes, createConferenceService, CONFERENCE_DATASET } from '../server/conferences.ts';
const fixtureYaml = `- title: WWW
  description: Web Conference
  rank: {ccf: A}
  confs:
    - year: 2027
      id: www27
      link: https://www2027.thewebconf.org/
      timezone: AoE
      timeline:
        - deadline: '2026-10-25 23:59:59'
          abstract_deadline: '2026-10-18 23:59:59'
          comment: Research track
        - deadline: TBD
          comment: Second round
    - year: 2026
      id: www26
      timeline:
        - deadline: '2025-10-07'
- title: PTCONF
  description: Pacific time
  confs:
    - year: 2026
      id: pt26
      timezone: PT
      timeline:
        - deadline: '2026-07-01 12:00:59'
        - deadline: '2026-01-01 12:00:00'
        - deadline: '2026-03-08 02:30:00'
        - deadline: '2026-11-01 01:30:00'
`;
const fake = (yaml = fixtureYaml): typeof fetch => async () => new Response(yaml,{status:200});
async function fixture(fetcher: typeof fetch = fake()) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-conferences-')); const app=Fastify();
  app.setErrorHandler((e:any,_q,r)=>r.code(e.statusCode||500).send({error:e.message})); await registerConferenceRoutes(app,root,{fetcher,now:()=>Date.parse('2026-10-22T00:00:00Z')});
  return{app,root,close:async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});}};
}
test('conference parser keeps original seconds, AoE conventions and individual rounds',()=>{
  const data=parseConferenceData(fixtureYaml), www=data.find(c=>c.id==='www27')!;
  assert.equal(www.rounds[0].deadlineAt,'2026-10-26T11:59:59.000Z'); assert.equal(www.rounds[0].abstractDeadlineAt,'2026-10-19T11:59:59.000Z');
  assert.equal(www.rounds[1].deadlineAt,undefined);assert.match(www.rounds[1].unavailableReason!,/TBD/);
  const legacy=data.find(c=>c.id==='www26')!.rounds[0];assert.equal(legacy.deadlineAt,'2025-10-08T11:59:59.000Z');assert.equal(legacy.notes.length,2);assert.ok(legacy.notes.every(n=>n.includes('未经会议官网确认')));
  assert.equal(conferenceTimezone('UTC-12'),'Etc/GMT+12');assert.equal(conferenceTimezone('UTC+8'),'Etc/GMT-8');assert.equal(conferenceTimezone('UTC+0'),'UTC');assert.throws(()=>conferenceTimezone('UTC+15'));
});
test('PT adjusts summer/winter and refuses nonexistent or ambiguous wall times',()=>{
  const rounds=parseConferenceData(fixtureYaml).find(c=>c.id==='pt26')!.rounds;
  assert.equal(rounds[0].deadlineAt,'2026-07-01T19:00:59.000Z');assert.equal(rounds[1].deadlineAt,'2026-01-01T20:00:00.000Z');
  assert.equal(rounds[2].deadlineAt,undefined);assert.equal(rounds[3].deadlineAt,undefined);
});
test('HTTP returns explicit yearly/round selection metadata without writing a project',async()=>{
  const{app,root,close}=await fixture();try{
    const res=await app.inject('/api/conferences?q=WWW');assert.equal(res.statusCode,200,res.body);const body=res.json();assert.deepEqual(body.conferences.map((c:any)=>c.id),['www27','www26']);assert.equal(body.datasetUrl,CONFERENCE_DATASET);assert.equal(body.stale,false);
    const selection=body.conferences[0].rounds[0].selection;assert.equal(selection.venue,'WWW 2027');assert.equal(selection.deadlineSource.conferenceId,'www27');assert.equal(selection.deadlineSource.roundId,'www27:round-1');assert.equal(selection.deadlineSource.year,2027);assert.match(selection.deadlineSource.notes,/未独立核对/);
    const direct=await app.inject('/api/conferences/selection?conferenceId=www27&roundId=www27%3Around-1');assert.deepEqual(direct.json().selection,selection);
    assert.equal((await app.inject('/api/conferences/selection?conferenceId=www27&roundId=www27%3Around-2')).statusCode,409);
    assert.equal((await app.inject('/api/conferences/selection?conferenceId=missing&roundId=missing')).statusCode,404);
    for(const url of ['/api/conferences?refresh=bad','/api/conferences?q='+ 'x'.repeat(101),'/api/conferences/selection?conferenceId=www27'])assert.equal((await app.inject(url)).statusCode,400);
    assert.deepEqual((await app.inject('/api/conferences?q=absent')).json().conferences,[]);await assert.rejects(fs.stat(path.join(root,'papers')));
  }finally{await close();}
});
test('conference title plus year matches separate fields with all whitespace-separated keywords',async()=>{
  const {app,close}=await fixture(fake(fixtureYaml.replace('title: WWW','title: TEST')));
  try {
    for(const query of ['TEST 2027','  test   2027  ','2027\tTEST','TEST Web 2027']) {
      const response=await app.inject(`/api/conferences?q=${encodeURIComponent(query)}`);
      assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json().conferences.map((c:any)=>c.id),['www27'],query);
    }
    assert.deepEqual((await app.inject('/api/conferences?q=TEST%20absent%202027')).json().conferences,[]);
    assert.deepEqual((await app.inject('/api/conferences?q=www27')).json().conferences.map((c:any)=>c.id),['www27']);
    const selection=await app.inject('/api/conferences/selection?conferenceId=www27&roundId=www27%3Around-1');assert.equal(selection.statusCode,200,selection.body);assert.equal(selection.json().selection.venue,'TEST 2027');
  } finally { await close(); }
});
test('upcoming filters full-paper deadlines at the exact instant and sorts rounds/editions chronologically',async()=>{
  const rankedYaml=fixtureYaml+'\n'+`- title: BNEAR
  rank: {ccf: B}
  confs:
    - year: 2027
      id: bnear27
      timezone: UTC+8
      timeline:
        - deadline: '2026-10-22 08:00:01'
          abstract_deadline: '2026-10-20 08:00:00'
- title: ASERIES
  rank: {ccf: A}
  confs:
    - year: 2027
      id: aseries27
      timezone: UTC+0
      timeline:
        - deadline: '2026-10-21 23:59:59'
        - deadline: '2026-11-03 00:00:00'
        - deadline: '2026-10-25 00:00:00'
        - deadline: '2026-10-22 00:00:00'
        - deadline: TBD
- title: CFAR
  rank: {ccf: C}
  confs:
    - year: 2027
      id: cfar27
      timezone: UTC+0
      timeline:
        - deadline: '2026-12-10 00:00:00'
    - year: 2028
      id: ctbd28
      timeline:
        - deadline: TBD
    - year: 2025
      id: cold25
      timeline:
        - deadline: TBD
`;
  const{app,close}=await fixture(fake(rankedYaml));try{
    const url='/api/conferences?upcoming=1&sort=deadline',future=(await app.inject(url)).json();
    assert.deepEqual(future.conferences.map((c:any)=>c.id),['bnear27','aseries27','www27','cfar27']);assert.equal(future.total,4);assert.equal(future.pendingCount,3);
    assert.deepEqual(future.filters,{rank:'all',upcoming:true,sort:'deadline'});assert.deepEqual(future.pagination,{offset:0,limit:80,hasMore:false});
    assert.deepEqual(future.conferences[1].rounds.map((r:any)=>r.id),['aseries27:round-3','aseries27:round-2']);
    assert.equal(future.conferences[0].rounds[0].abstractDeadlineAt,'2026-10-20T00:00:00.000Z','past abstract does not hide future full-paper deadline');
    assert.ok(future.conferences.flatMap((c:any)=>c.rounds).every((r:any)=>Date.parse(r.deadlineAt)>Date.parse(future.evaluatedAt)&&r.selection));
    assert.deepEqual((await app.inject(url+'&rank=A')).json().conferences.map((c:any)=>c.id),['aseries27','www27']);
    assert.deepEqual((await app.inject(url+'&rank=B')).json().conferences.map((c:any)=>c.id),['bnear27']);
    assert.deepEqual((await app.inject(url+'&rank=C')).json().conferences.map((c:any)=>c.id),['cfar27']);
    assert.deepEqual((await app.inject(url+'&q=ASERIES%202027')).json().conferences.map((c:any)=>c.id),['aseries27']);
    const first=(await app.inject(url+'&limit=2')).json(),second=(await app.inject(url+'&limit=2&offset=2')).json();assert.equal(first.pagination.hasMore,true);assert.equal(first.total,4);assert.equal(second.pagination.hasMore,false);assert.deepEqual([...first.conferences,...second.conferences].map((c:any)=>c.id),future.conferences.map((c:any)=>c.id));
    const history=(await app.inject('/api/conferences?q=ASERIES')).json();assert.equal(history.conferences[0].rounds.length,5,'filtering must not mutate the cached original');
    const exact=await app.inject('/api/conferences/selection?conferenceId=aseries27&roundId=aseries27%3Around-1');assert.equal(exact.statusCode,200,exact.body);assert.equal(exact.json().selection.deadlineAt,'2026-10-21T23:59:59.000Z');
    for(const query of ['rank=D','rank=a','upcoming=true','sort=unknown','limit=201','limit=0','offset=-1','offset=1.5'])assert.equal((await app.inject('/api/conferences?'+query)).statusCode,400,query);
  }finally{await close();}
});
test('exact historical selection is independent of the result page limit and upcoming filters',async()=>{
  const editions=Array.from({length:85},(_,i)=>({year:2027,id:`overlap-${i}`,timezone:'UTC+0',timeline:[{deadline:'2026-01-01 00:00:00'}]}));
  const {app,close}=await fixture(fake(JSON.stringify([{title:'Overlap',confs:[...editions,{year:2020,id:'overlap',timezone:'UTC+0',timeline:[{deadline:'2019-10-01 00:00:00'}]}]}])));try{
    const list=(await app.inject('/api/conferences?q=overlap')).json();assert.equal(list.total,86);assert.equal(list.conferences.length,80);assert.ok(!list.conferences.some((c:any)=>c.id==='overlap'));assert.equal(list.pagination.hasMore,true);
    assert.equal((await app.inject('/api/conferences?q=overlap&upcoming=1&sort=deadline')).json().total,0);
    const selected=await app.inject('/api/conferences/selection?conferenceId=overlap&roundId=overlap%3Around-1');assert.equal(selected.statusCode,200,selected.body);assert.equal(selected.json().selection.venue,'Overlap 2020');
  }finally{await close();}
});
test('source fetch is bounded and refresh failure retains timestamped cache across restart',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-conferences-cache-'));let now=Date.parse('2026-10-22T00:00:00Z'),calls=0,fail=false;
  const fetcher:typeof fetch=async(url,options)=>{calls++;assert.equal(url,CONFERENCE_DATASET);assert.ok(options?.signal);if(fail)throw new Error('private upstream detail');return new Response(fixtureYaml);};
  try{
    const service=createConferenceService(root,{fetcher,now:()=>now});const first=await service.query('WWW');assert.equal(calls,1);await service.query('PTCONF');assert.equal(calls,1);fail=true;now+=7*3600000;
    const stale=await service.query('WWW');assert.equal(stale.stale,true);assert.equal(stale.fetchedAt,first.fetchedAt);assert.match(stale.warning!,/上次成功缓存/);assert.ok(!JSON.stringify(stale).includes('private upstream'));
    const restart=createConferenceService(root,{fetcher,now:()=>now});assert.equal((await restart.query('WWW')).fetchedAt,first.fetchedAt);
    const uncachedRoot=path.join(root,'uncached'),oversize=createConferenceService(uncachedRoot,{fetcher:async()=>new Response('bad',{headers:{'content-length':String(5*1024*1024)}})});await assert.rejects(oversize.query('WWW'),(e:any)=>e.statusCode===503);
    const deadline=createConferenceService(path.join(root,'timeout'),{timeoutMs:10,fetcher:async(_u,options)=>new Promise((_r,reject)=>options!.signal!.addEventListener('abort',()=>reject(new Error('aborted'))))});await assert.rejects(deadline.query('WWW'),(e:any)=>e.statusCode===503);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('invalid YAML/alias expansion and invalid date do not become fabricated deadlines',()=>{
  for(const value of ['garbage','null','- title: [broken','- &x {title: X, confs: [*x]}'])assert.throws(()=>parseConferenceData(value));
  const broken=parseConferenceData(fixtureYaml.replace('2026-10-25 23:59:59','2026-02-30 23:59:59'));assert.equal(broken[0].rounds[0].deadlineAt,undefined);
});
