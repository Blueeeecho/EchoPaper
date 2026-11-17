import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createApp} from '../server/index.ts';
import type {BuildService} from '../shared/types.ts';

// Regression: GET /api/projects ran `git config --local core.quotepath false` every time, rewriting .git/config.
const run=promisify(execFile);
const fakeBuilds:BuildService={async request(projectId,targetId){return {id:'b',projectId,targetId,status:'queued',createdAt:new Date().toISOString(),log:'',diagnostics:[]};},async cancel(id){return {id,projectId:'x',targetId:'main',status:'cancelled',createdAt:new Date().toISOString(),log:'',diagnostics:[]};},async list(){return [];},async get(){throw new Error('n/a');},async artifact(){throw new Error('n/a');},async createSubmission(){throw new Error('n/a');},async listSubmissions(){return [];},async submissionArtifact(){throw new Error('n/a');},async close(){}};
const snapshot=async(file:string)=>({sha:crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'),mtime:(await fs.stat(file)).mtimeMs});

test('listing projects twice leaves .git/config untouched; a wrong quotepath is still corrected',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'git-config-'));
  await fs.mkdir(path.join(root,'shared','templates','english'),{recursive:true});
  await fs.writeFile(path.join(root,'shared','templates','english','main.tex'),'\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n');
  await fs.mkdir(path.join(root,'papers'));
  const app=await createApp({workspaceRoot:root,buildService:fakeBuilds,watch:false});
  try{
    assert.equal((await app.inject({method:'POST',url:'/api/projects',payload:{id:'Alpha',title:'Alpha',template:'english'}})).statusCode,201);
    const config=path.join(root,'papers','Alpha','.git','config');
    assert.equal((await app.inject('/api/projects')).statusCode,200);
    const first=await snapshot(config);
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal((await app.inject('/api/projects')).statusCode,200);
    assert.equal((await app.inject('/api/projects')).statusCode,200);
    assert.deepEqual(await snapshot(config),first,'.git/config hash and mtime must not change on repeated GET /api/projects');
    // Behaviour kept: a different value is still set to false.
    await run('git',['-C',path.join(root,'papers','Alpha'),'config','--local','core.quotepath','true']);
    assert.equal((await app.inject('/api/projects')).statusCode,200);
    assert.equal((await run('git',['-C',path.join(root,'papers','Alpha'),'config','--local','--get','core.quotepath'])).stdout.trim(),'false');
  }finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});
