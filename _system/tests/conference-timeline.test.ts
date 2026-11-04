import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {registerWorkspaceRoutes} from '../server/workspace/index.ts';
import {openCatalog} from '../server/workspace/catalog.ts';

const conference=()=>({id:'www-2027-tracked',conferenceId:'www-2027',title:'WWW',year:2027,roundLabel:'第 1 轮',officialUrl:'https://www2027.thewebconf.org/',color:'#384b75',enabled:true,paperIds:['WWW'],milestones:[{id:'reviews',label:'出分',at:'2026-11-30T09:00:00+08:00',sourceUrl:'https://example.org/dates'},{id:'decision',label:'最终决定',at:''}]});
async function fixture(legacy=false){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'conference-timeline-'));await fs.mkdir(path.join(root,'papers'));
  if(legacy){const catalog=await openCatalog(root);delete(catalog.state as Partial<typeof catalog.state>).conferenceTimeline;await catalog.save();catalog.close();}
  let app=Fastify(),service=await registerWorkspaceRoutes(app,root,{watch:false});
  function configure(){app.setErrorHandler((error,_request,reply)=>{const value=error as Error&{statusCode?:number};return reply.code(value.statusCode||500).send({error:value.message});});}configure();
  async function call(method:'GET'|'PUT'|'POST',url='/api/workspace/conference-timeline',payload?:unknown,status=200){const response=await app.inject({method,url,payload:payload as any});assert.equal(response.statusCode,status,response.body);return response.json();}
  return{root,call,async restart(){await service.close();await app.close();app=Fastify();service=await registerWorkspaceRoutes(app,root,{watch:false});configure();},async close(){await service.close();await app.close();await fs.rm(root,{recursive:true,force:true});}};
}

test('timeline saves explicit conference dates, preserves unknown dates, and survives restart',async()=>{
  const f=await fixture();try{
    assert.deepEqual(await f.call('GET'),{revision:0,conferences:[]});
    const saved=await f.call('PUT',undefined,{expectedRevision:0,conferences:[conference()]});
    assert.equal(saved.revision,1);assert.equal(saved.conferences[0].milestones[0].at,'2026-11-30T01:00:00.000Z');assert.equal(saved.conferences[0].milestones[1].at,'');
    await f.restart();assert.deepEqual(await f.call('GET'),saved);
    saved.conferences[0].enabled=false;saved.conferences[0].color='#8055a2';
    const changed=await f.call('PUT',undefined,{expectedRevision:saved.revision,conferences:saved.conferences});assert.equal(changed.revision,2);assert.equal(changed.conferences[0].enabled,false);
  }finally{await f.close();}
});

test('stale timeline saves never replace newer records and catalog data stays intact',async()=>{
  const f=await fixture();try{
    const topic=await f.call('POST','/api/workspace/topics',{title:'Existing topic'},201);
    const saved=await f.call('PUT',undefined,{expectedRevision:0,conferences:[conference()]});
    await f.call('PUT',undefined,{expectedRevision:0,conferences:[]},409);assert.deepEqual(await f.call('GET'),saved);
    assert.equal((await f.call('GET','/api/workspace/overview')).topics[0].id,topic.id);
    await f.call('PUT',undefined,{conferences:[]},409);assert.deepEqual(await f.call('GET'),saved);
    await f.call('PUT',undefined,{expectedRevision:1,conferences:[]});await f.restart();assert.deepEqual(await f.call('GET'),{revision:2,conferences:[]});
  }finally{await f.close();}
});

test('timeline rejects invalid or ambiguous dates, unsafe URLs and duplicate identities without writing',async()=>{
  const f=await fixture();try{
    for(const date of ['2026-02-30T09:00:00+08:00','2026-11-30T09:00','2026-11-30T25:00:00Z']){const item=conference();item.milestones[0].at=date;await f.call('PUT',undefined,{expectedRevision:0,conferences:[item]},400);}
    const unsafe=conference();unsafe.officialUrl='javascript:alert(1)';await f.call('PUT',undefined,{expectedRevision:0,conferences:[unsafe]},400);
    const source=conference();source.milestones[0].sourceUrl='https://user:secret@example.org';await f.call('PUT',undefined,{expectedRevision:0,conferences:[source]},400);
    const duplicate=conference();duplicate.milestones[1].id=duplicate.milestones[0].id;await f.call('PUT',undefined,{expectedRevision:0,conferences:[duplicate]},400);
    await f.call('PUT',undefined,{expectedRevision:0,conferences:[conference(),conference()]},400);
    const color=conference();color.color='red;display:none';await f.call('PUT',undefined,{expectedRevision:0,conferences:[color]},400);
    assert.deepEqual(await f.call('GET'),{revision:0,conferences:[]});
  }finally{await f.close();}
});

test('pre-timeline catalogs migrate in place with an empty timeline',async()=>{
  const f=await fixture(true);try{assert.deepEqual(await f.call('GET'),{revision:0,conferences:[]});const saved=await f.call('PUT',undefined,{expectedRevision:0,conferences:[conference()]});await f.restart();assert.deepEqual(await f.call('GET'),saved);}finally{await f.close();}
});
