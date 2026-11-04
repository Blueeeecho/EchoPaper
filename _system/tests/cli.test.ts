import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const run=promisify(execFile),script=path.resolve('scripts/echopaper.mjs');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function command(root:string,args:string[]){try{const r=await run(process.execPath,[script,'--workspace',root,...args],{timeout:10000,maxBuffer:8*1024*1024});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(error:any){return {code:error.code,stdout:error.stdout??'',stderr:error.stderr??''};}}
async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-cli-'));const requests:{method:string;url:string;body:any}[]=[];
  const state:any={project:{id:'Alpha',title:'Alpha',venue:'',deadline:'',updatedAt:'2026-10-22T00:00:00.000Z',targets:[{id:'main',main:'manuscript/main.tex'}]},files:new Map([['manuscript/main.tex',{path:'manuscript/main.tex',content:'Original\n',hash:hash('Original\n')}]]),buildStatus:'succeeded',healthRoot:root};
  const selection={venue:'EXAMPLE 2027',deadlineAt:'2027-01-02T11:59:59.000Z',deadlineTimezone:'Etc/GMT+12',deadlineSource:{sourceUrl:'https://ccfddl.top/',conferenceId:'example27',year:2027,roundId:'example27:round-1',fetchedAt:'2026-10-22T00:00:00.000Z'}};
  const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=raw?JSON.parse(raw):undefined;}catch{res.writeHead(400);res.end('{}');return;}const url=new URL(req.url!,'http://localhost');requests.push({method:req.method!,url:req.url!,body});const send=(value:any,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(url.pathname==='/api/health')return send({ok:true,workspaceRoot:state.healthRoot,pid:1234});
    if(url.pathname==='/api/projects')return send({projects:[state.project]});
    if(url.pathname==='/api/projects/Alpha/chats')return send({data:{version:1,selectedId:'chat-1',conversations:[{id:'chat-1',lifecycle:state.chatLifecycle}]},hash:state.chatHash||'a'.repeat(64)});
    if(url.pathname==='/api/projects/Alpha/chats/chat-1'){
      if(req.method!=='PATCH'||body.expectedHash!==(state.chatHash||'a'.repeat(64)))return send({error:'chat changed'},409);
      state.chatLifecycle={state:body.action==='archive'?'archived':body.action==='delete'?'deleted':'active',revision:(state.chatLifecycle?.revision||0)+1,updatedAt:'2026-10-24T00:00:00Z'};
      state.chatHash=hash(JSON.stringify(state.chatLifecycle));return send({data:{version:1,selectedId:'chat-1',conversations:[{id:'chat-1',lifecycle:state.chatLifecycle}]},hash:state.chatHash});
    }
    if(url.pathname==='/api/projects/Alpha'){
      if(req.method==='GET')return send(state.project);
      if(body.expectedUpdatedAt!==state.project.updatedAt)return send({error:'configuration changed',current:state.project},409);
      Object.assign(state.project,body,{updatedAt:'2026-10-22T00:00:01.000Z'});delete state.project.expectedUpdatedAt;return send(state.project);
    }
    if(url.pathname==='/api/projects/Alpha/file'){
      const filename=req.method==='GET'?url.searchParams.get('path'):body.path,current=state.files.get(filename);
      if(req.method==='GET')return current?send(current):send({error:'not found'},404);
      if((current?.hash??null)!==body.expectedHash)return send({error:'disk changed',current},409);
      const next={path:filename,content:body.content,hash:hash(body.content)};state.files.set(filename,next);return send(next);
    }
    if(url.pathname==='/api/projects/Alpha/builds')return send({id:'build-cli',projectId:'Alpha',targetId:body.targetId,status:'queued'});
    if(url.pathname==='/api/builds/build-cli')return send({id:'build-cli',status:state.buildStatus,sourceHash:'c'.repeat(64),...(state.buildStatus==='succeeded'?{pdf:'main.pdf'}:{diagnostics:[{message:'Fixture syntax error'}]})});
    if(url.pathname==='/api/conferences')return send({conferences:[{id:'example27',rounds:[{id:'example27:round-1',selection}]}],query:url.searchParams.get('q'),stale:false,fetchedAt:'2026-10-22T00:00:00.000Z'});
    if(url.pathname==='/api/conferences/selection')return send({selection,stale:false,fetchedAt:'2026-10-22T00:00:00.000Z'});
    return send({error:'not found'},404);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;
  await fs.mkdir(path.join(root,'_system/runtime'),{recursive:true});await fs.writeFile(path.join(root,'_system/runtime/instance.json'),JSON.stringify({port}));
  return {root,port,state,requests,selection,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}};
}
test('CLI rejects incomplete/unsafe commands before contacting a service and keeps help offline',async()=>{
  const f=await fixture();try{
    const help=await command(f.root,['help']);assert.equal(help.code,0);assert.match(help.stdout,/expected-hash/);
    for(const args of [['file','write','Alpha','manuscript/main.tex','--input','missing.tex'],['file','read','Alpha','../escape.tex'],['status','--port','https://example.com'],['deadline','set','Alpha'],['project','Alpha','--unknown'],['conferences','selection','id','round','--refresh']]){const result=await command(f.root,args);assert.equal(result.code,2,JSON.stringify(result));assert.equal(JSON.parse(result.stderr).code,'EUSAGE');}
    assert.equal(f.requests.length,0);
  }finally{await f.close();}
});
test('CLI identifies the workspace and reads projects/documents as JSON',async()=>{
  const f=await fixture();try{
    const status=await command(f.root,['status']);assert.equal(status.code,0,status.stderr);assert.equal(JSON.parse(status.stdout).workspaceRoot,f.root);
    assert.equal(JSON.parse((await command(f.root,['projects'])).stdout).projects[0].id,'Alpha');assert.equal(JSON.parse((await command(f.root,['project','Alpha'])).stdout).updatedAt,f.state.project.updatedAt);
    const read=JSON.parse((await command(f.root,['file','read','Alpha','manuscript/main.tex'])).stdout);assert.equal(read.content,'Original\n');assert.equal(read.hash,hash('Original\n'));
    f.state.healthRoot=f.root+'-another';const refused=await command(f.root,['--port',String(f.port),'status']);assert.equal(refused.code,1);assert.equal(JSON.parse(refused.stderr).code,'EWORKSPACE');
  }finally{await f.close();}
});
test('CLI file writes preserve exact UTF-8, require hashes and expose 409 without retrying',async()=>{
  const f=await fixture();try{
    const input=path.join(f.root,'edit.tex');await fs.writeFile(input,'中文增量修改\n');const oldHash=f.state.files.get('manuscript/main.tex').hash;
    const saved=await command(f.root,['file','write','Alpha','manuscript/main.tex','--input',input,'--expected-hash',oldHash]);assert.equal(saved.code,0,saved.stderr);assert.equal(JSON.parse(saved.stdout).content,'中文增量修改\n');
    const conflict=await command(f.root,['file','write','Alpha','manuscript/main.tex','--input',input,'--expected-hash',oldHash]);assert.equal(conflict.code,1);assert.equal(JSON.parse(conflict.stderr).status,409);assert.equal(JSON.parse(conflict.stderr).code,'ECONFLICT');assert.equal(f.requests.filter(r=>r.method==='PUT').length,2);
    const created=await command(f.root,['file','write','Alpha','notes/new.md','--input',input,'--expected-hash','null']);assert.equal(created.code,0,created.stderr);assert.ok(f.state.files.has('notes/new.md'));
  }finally{await f.close();}
});
test('invalid UTF-8 and malformed selection JSON fail locally without a write request',async()=>{
  const f=await fixture();try{
    const input=path.join(f.root,'bad.tex');await fs.writeFile(input,Buffer.from([0xff,0xfe,0x00]));let result=await command(f.root,['file','write','Alpha','manuscript/main.tex','--input',input,'--expected-hash','a'.repeat(64)]);assert.equal(JSON.parse(result.stderr).code,'EINPUT');
    const selection=path.join(f.root,'bad.json');await fs.writeFile(selection,'not JSON');result=await command(f.root,['deadline','set','Alpha','--selection',selection]);assert.equal(JSON.parse(result.stderr).code,'EINPUT');assert.equal(f.requests.length,0);
  }finally{await f.close();}
});
test('conference selection and deadline changes retain provenance and optimistic configuration version',async()=>{
  const f=await fixture();try{
    const query=await command(f.root,['conferences','WWW & 中文','--refresh']);assert.equal(query.code,0,query.stderr);assert.equal(JSON.parse(query.stdout).query,'WWW & 中文');assert.ok(f.requests.some(r=>r.url.includes('refresh=1')));
    const selection=await command(f.root,['conferences','selection','example27','example27:round-1']);assert.equal(selection.code,0,selection.stderr);const file=path.join(f.root,'selection.json');await fs.writeFile(file,selection.stdout);
    const saved=await command(f.root,['deadline','set','Alpha','--selection',file]);assert.equal(saved.code,0,saved.stderr);assert.deepEqual(JSON.parse(saved.stdout).deadlineSource,f.selection.deadlineSource);assert.equal(f.requests.find(r=>r.method==='PATCH')!.body.expectedUpdatedAt,'2026-10-22T00:00:00.000Z');
    const stale=await command(f.root,['deadline','clear','Alpha','--expected-updated-at','2000-01-01T00:00:00.000Z']);assert.equal(JSON.parse(stale.stderr).status,409);
    const clear=await command(f.root,['deadline','clear','Alpha']);assert.equal(clear.code,0,clear.stderr);assert.equal(JSON.parse(clear.stdout).deadlineAt,'');assert.equal(JSON.parse(clear.stdout).venue,'EXAMPLE 2027');
  }finally{await f.close();}
});
test('compile wait returns completed source fingerprint and exits nonzero on failure',async()=>{
  const f=await fixture();try{
    const job=await command(f.root,['compile','Alpha','main']);assert.equal(job.code,0,job.stderr);assert.equal(JSON.parse(job.stdout).status,'queued');
    const success=await command(f.root,['compile','Alpha','main','--wait']);assert.equal(success.code,0,success.stderr);assert.equal(JSON.parse(success.stdout).sourceHash,'c'.repeat(64));
    f.state.buildStatus='failed';const failure=await command(f.root,['compile','Alpha','main','--wait']);assert.equal(failure.code,1);assert.equal(JSON.parse(failure.stderr).code,'EBUILD');assert.equal(JSON.parse(failure.stderr).details.build.status,'failed');
  }finally{await f.close();}
});

test('chat lifecycle commands require an observed hash and expose a conflict without retrying',async()=>{
 const f=await fixture();try{
  const missing=await command(f.root,['chat','delete','Alpha','chat-1']);assert.equal(missing.code,2);assert.equal(f.requests.length,0);
  const listed=await command(f.root,['chat','list','Alpha']);assert.equal(listed.code,0,listed.stderr);let expectedHash=JSON.parse(listed.stdout).hash;
  for(const action of['archive','delete','restore']){const result=await command(f.root,['chat',action,'Alpha','chat-1','--expected-hash',expectedHash]);assert.equal(result.code,0,result.stderr);const saved=JSON.parse(result.stdout);assert.equal(saved.data.conversations[0].lifecycle.state,action==='archive'?'archived':action==='delete'?'deleted':'active');expectedHash=saved.hash;}
  const stale=await command(f.root,['chat','delete','Alpha','chat-1','--expected-hash','a'.repeat(64)]);assert.equal(stale.code,1);assert.equal(JSON.parse(stale.stderr).code,'ECONFLICT');assert.equal(f.requests.filter(r=>r.method==='PATCH').length,4);
 }finally{await f.close();}
});
