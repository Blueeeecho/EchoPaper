import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile),script=path.resolve('scripts/echopaper.mjs'),baseline='a'.repeat(64);
async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'academic-cli-')),requests:{method:string;url:string;body:any}[]=[],state={healthRoot:root,conflict:false,jobStatus:'succeeded'};let inputNumber=0;
  const server=http.createServer(async(request,response)=>{let raw='';for await(const chunk of request)raw+=chunk;const body=raw?JSON.parse(raw):undefined,url=new URL(request.url!,'http://127.0.0.1');requests.push({method:request.method!,url:request.url!,body});const send=(value:unknown,status=200)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
    if(url.pathname==='/api/health')return send({ok:true,workspaceRoot:state.healthRoot});
    if(state.conflict&&request.method!=='GET')return send({error:'PPT changed',currentHash:'b'.repeat(64)},409);
    if(request.method==='POST'&&(/\/outline$|\/export$|\/regenerate$/).test(url.pathname))return send({id:'job-fixture',presentationId:'ppt-one',status:'queued',kind:url.pathname.endsWith('export')?'export':'outline',checks:[]},202);
    if(request.method==='GET'&&url.pathname==='/api/presentations/ppt-one/jobs/job-fixture')return send({id:'job-fixture',presentationId:'ppt-one',status:state.jobStatus,kind:'export',checks:[],...(state.jobStatus==='failed'?{error:'Fixture export failed'}:{})});
    if(request.method==='GET'&&url.pathname==='/api/presentations/ppt-one')return send({document:{id:'ppt-one',sources:[{id:'src-one',text:'Frozen evidence',hash:baseline}]},hash:baseline});
    return send({method:request.method,path:url.pathname,query:Object.fromEntries(url.searchParams),body});
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;await fs.mkdir(path.join(root,'_system/runtime'),{recursive:true});await fs.writeFile(path.join(root,'_system/runtime/instance.json'),JSON.stringify({port}));
  async function command(args:string[]){try{const result=await execute(process.execPath,[script,'--workspace',root,...args],{timeout:10000,maxBuffer:16*1024*1024});return{code:0,stdout:result.stdout,stderr:result.stderr};}catch(error:any){return{code:error.code,stdout:error.stdout||'',stderr:error.stderr||''};}}
  async function input(value:unknown){const filename=path.join(root,`input-${++inputNumber}.json`);await fs.writeFile(filename,JSON.stringify(value));return filename;}
  return{root,port,state,requests,command,input,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}};
}

test('academic CLI help is offline and malformed command shapes fail before a connection',async()=>{
  const f=await fixture();try{
    const help=await f.command(['help']);assert.equal(help.code,0);assert.match(help.stdout,/workspace overview/);assert.match(help.stdout,/presentations/);
    const invalid=[['workspace'],['topics','update'],['roots','connect'],['resources','get','../escape'],['organize','apply'],['presentations','rewrite','ppt-one','slide-one'],['styles','list','extra'],['presentations','get','ppt-one','--wait'],['resources','search','query','extra'],['topics','list','--expected-hash',baseline]];
    for(const args of invalid){const result=await f.command(args);assert.equal(result.code,2,JSON.stringify({args,...result}));assert.equal(JSON.parse(result.stderr).code,'EUSAGE');}assert.equal(f.requests.length,0);
  }finally{await f.close();}
});

test('academic read commands and empty-body actions route to their canonical endpoints',async()=>{
  const f=await fixture();try{
    const cases:[string[],string,string][]=[
      [['workspace','overview'],'GET','/api/workspace/overview'],[['topics','list'],'GET','/api/workspace/topics'],[['roots','list'],'GET','/api/workspace/roots'],[['roots','scan','root-one'],'POST','/api/workspace/roots/root-one/scan'],
      [['resources','search'],'GET','/api/workspace/resources'],[['resources','search','中文 & baseline'],'GET','/api/workspace/resources?q=%E4%B8%AD%E6%96%87+%26+baseline'],[['resources','get','resource-one'],'GET','/api/workspace/resources/resource-one'],
      [['organize','list'],'GET','/api/workspace/operations'],[['organize','undo','operation-one'],'POST','/api/workspace/operations/operation-one/undo'],[['presentations','list'],'GET','/api/presentations'],[['presentations','get','ppt-one'],'GET','/api/presentations/ppt-one'],
      [['presentations','jobs','ppt-one'],'GET','/api/presentations/ppt-one/jobs'],[['presentations','job','ppt-one','job-fixture'],'GET','/api/presentations/ppt-one/jobs/job-fixture'],[['presentations','cancel','ppt-one','job-fixture'],'POST','/api/presentations/ppt-one/jobs/job-fixture/cancel'],[['styles','list'],'GET','/api/presentation-styles']
    ];for(const[args,method,url]of cases){const result=await f.command(args);assert.equal(result.code,0,JSON.stringify({args,...result}));const request=f.requests.at(-1)!;assert.equal(request.method,method);assert.equal(request.url,url);}
    const sources=await f.command(['presentations','sources','ppt-one']);assert.equal(sources.code,0,sources.stderr);assert.equal(JSON.parse(sources.stdout).sources[0].id,'src-one');assert.equal(JSON.parse(sources.stdout).hash,baseline);
  }finally{await f.close();}
});

test('workspace writes preserve structured JSON, revision baselines and explicit file hashes',async()=>{
  const f=await fixture();try{
    const cases:[string[],unknown,string,string][]=[
      [['topics','create'],{title:'概率树',description:'原始证据'},'POST','/api/workspace/topics'],[['topics','update','topic-one'],{title:'Incremental',expectedRevision:3},'PATCH','/api/workspace/topics/topic-one'],
      [['roots','connect'],{path:'/tmp/explicit-originals',label:'Originals',permission:'read'},'POST','/api/workspace/roots'],[['roots','update','root-one'],{permission:'write',expectedRevision:5},'PATCH','/api/workspace/roots/root-one'],
      [['resources','tag','resource-one'],{tags:['baseline','中文'],expectedRevision:2},'PATCH','/api/workspace/resources/resource-one'],[['resources','relink','resource-one'],{rootId:'root-one',path:'folder/paper.pdf',expectedRevision:4},'POST','/api/workspace/resources/resource-one/relink'],
      [['organize','apply'],{kind:'move',rootId:'root-one',resourceId:'resource-one',destinationRootId:'root-two',destinationPath:'renamed.pdf',expectedRevision:7,expectedHash:baseline},'POST','/api/workspace/operations']
    ];for(const[args,payload,method,url]of cases){const result=await f.command([...args,'--input',await f.input(payload)]);assert.equal(result.code,0,JSON.stringify({args,...result}));const request=f.requests.at(-1)!;assert.equal(request.method,method);assert.equal(request.url,url);assert.deepEqual(request.body,payload);}
    const trash={kind:'trash',rootId:'root-one',resourceId:'resource-one',expectedRevision:8},result=await f.command(['organize','apply','--input',await f.input(trash),'--expected-hash',baseline]);assert.equal(result.code,0,result.stderr);assert.deepEqual(f.requests.at(-1)!.body,{...trash,expectedHash:baseline});
  }finally{await f.close();}
});

test('presentation writes send document CAS and use the actual material and slide routes',async()=>{
  const f=await fixture();try{
    const cases:[string[],unknown,string,string][]=[
      [['presentations','create'],{title:'Evidence talk',language:'zh-en'},'POST','/api/presentations'],[['presentations','save','ppt-one'],{document:{id:'ppt-one',slides:[]},expectedHash:baseline},'PUT','/api/presentations/ppt-one'],
      [['presentations','sources','ppt-one'],{resourceId:'resource-one',name:'Snapshot',expectedHash:baseline},'POST','/api/presentations/ppt-one/sources'],[['presentations','remove-source','ppt-one','src-one'],{expectedHash:baseline},'DELETE','/api/presentations/ppt-one/sources/src-one'],
      [['presentations','outline','ppt-one'],{manual:true,expectedHash:baseline},'POST','/api/presentations/ppt-one/outline'],[['presentations','export','ppt-one'],{expectedHash:baseline,approvedOutlineHash:baseline},'POST','/api/presentations/ppt-one/export'],
      [['presentations','rewrite','ppt-one','slide-one'],{instruction:'保留英文案例，压缩解释',expectedHash:baseline},'POST','/api/presentations/ppt-one/slides/slide-one/regenerate']
    ];for(const[args,payload,method,url]of cases){const result=await f.command([...args,'--input',await f.input(payload)]);assert.equal(result.code,0,JSON.stringify({args,...result}));const request=f.requests.at(-1)!;assert.equal(request.method,method);assert.equal(request.url,url);assert.deepEqual(request.body,payload);}
    const result=await f.command(['presentations','save','ppt-one','--input',await f.input({document:{id:'ppt-one',slides:[]}}),'--expected-hash',baseline]);assert.equal(result.code,0,result.stderr);assert.equal(f.requests.at(-1)!.body.expectedHash,baseline);
  }finally{await f.close();}
});

test('invalid academic JSON, baselines and paths are rejected locally without any request',async()=>{
  const f=await fixture();try{
    const invalid:[string[],unknown][]=[
      [['topics','create'],[]],[['topics','update','topic-one'],{title:'Missing revision'}],[['resources','relink','resource-one'],{rootId:'root-one',path:'../escape',expectedRevision:1}],
      [['organize','apply'],{kind:'trash',rootId:'root-one',resourceId:'resource-one',expectedRevision:1}],[['presentations','save','ppt-one'],{document:{id:'ppt-one'}}],[['presentations','rewrite','ppt-one','slide-one'],{expectedHash:baseline}],
      [['presentations','save','ppt-one','--expected-hash','b'.repeat(64)],{document:{id:'ppt-one'},expectedHash:baseline}]
    ];for(const[args,payload]of invalid){const result=await f.command([...args,'--input',await f.input(payload)]);assert.notEqual(result.code,0,JSON.stringify({args,...result}));assert.ok(['EINPUT','EUSAGE'].includes(JSON.parse(result.stderr).code));}
    const bad=path.join(f.root,'bad.json');await fs.writeFile(bad,'{broken');assert.equal(JSON.parse((await f.command(['topics','create','--input',bad])).stderr).code,'EINPUT');await fs.writeFile(bad,Buffer.from([0xff,0xfe]));assert.equal(JSON.parse((await f.command(['topics','create','--input',bad])).stderr).code,'EINPUT');assert.equal(f.requests.length,0);
  }finally{await f.close();}
});

test('presentation conflicts expose 409 once and wrong-workspace ports never receive writes',async()=>{
  const f=await fixture();try{
    const input=await f.input({document:{id:'ppt-one'},expectedHash:baseline});f.state.conflict=true;const conflict=await f.command(['presentations','save','ppt-one','--input',input]);assert.equal(conflict.code,1);assert.equal(JSON.parse(conflict.stderr).code,'ECONFLICT');assert.equal(JSON.parse(conflict.stderr).status,409);assert.equal(f.requests.filter(r=>r.method==='PUT').length,1);
    f.state.healthRoot=f.root+'-another';const wrong=await f.command(['--port',String(f.port),'presentations','save','ppt-one','--input',input]);assert.equal(wrong.code,1);assert.equal(JSON.parse(wrong.stderr).code,'EWORKSPACE');assert.equal(f.requests.filter(r=>r.method==='PUT').length,1);
  }finally{await f.close();}
});

test('presentation wait reports completed jobs and preserves IDs on failures and timeouts',async()=>{
  const f=await fixture();try{
    const input=await f.input({expectedHash:baseline}),success=await f.command(['presentations','outline','ppt-one','--input',input,'--wait']);assert.equal(success.code,0,success.stderr);assert.equal(JSON.parse(success.stdout).status,'succeeded');
    f.state.jobStatus='failed';const failed=await f.command(['presentations','export','ppt-one','--input',input,'--wait']);assert.equal(failed.code,1);const failure=JSON.parse(failed.stderr);assert.equal(failure.code,'EPRESENTATION');assert.equal(failure.details.jobId,'job-fixture');assert.equal(failure.details.job.error,'Fixture export failed');
    f.state.jobStatus='running';const timed=await f.command(['presentations','export','ppt-one','--input',input,'--wait','--wait-timeout','1']);assert.equal(timed.code,1);const timeout=JSON.parse(timed.stderr);assert.equal(timeout.code,'EWAIT');assert.equal(timeout.details.jobId,'job-fixture');assert.equal(timeout.details.presentationId,'ppt-one');
  }finally{await f.close();}
});

test('create-file CLI accepts exact UTF-8 and explicit null CAS, including the null flag',async()=>{
  const f=await fixture();try{
    const payload={kind:'create-file',rootId:'root-one',path:'new.md',content:'中文\nEnglish\n',expectedHash:null},result=await f.command(['organize','apply','--input',await f.input(payload)]);assert.equal(result.code,0,result.stderr);assert.deepEqual(f.requests.at(-1)!.body,payload);
    const empty={kind:'create-file',rootId:'root-one',path:'empty.txt',content:''},flag=await f.command(['organize','apply','--input',await f.input(empty),'--expected-hash','null']);assert.equal(flag.code,0,flag.stderr);assert.deepEqual(f.requests.at(-1)!.body,{...empty,expectedHash:null});
    const count=f.requests.length;for(const bad of [{...empty},{...empty,expectedHash:'a'.repeat(64)},{...empty,expectedHash:null,content:'\ud800'}]){const failed=await f.command(['organize','apply','--input',await f.input(bad)]);assert.notEqual(failed.code,0);}assert.equal(f.requests.length,count);
  }finally{await f.close();}
});
