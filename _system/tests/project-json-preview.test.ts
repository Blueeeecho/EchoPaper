import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.ts';

test('JSON evidence opens inline with exact bytes, without weakening raw-file restrictions',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-json-preview-'));
 await fs.mkdir(path.join(root,'shared/templates/empty'),{recursive:true});
 await fs.writeFile(path.join(root,'shared/templates/empty/main.tex'),'\\documentclass{article}\n\\begin{document}Test\\end{document}');
 const app=await createApp({workspaceRoot:root,watch:false});
 try{
  const created=await app.inject({method:'POST',url:'/api/projects',payload:{id:'Preview',title:'Preview',template:'empty'}});
  assert.equal(created.statusCode,201,created.body);
  const paper=path.join(root,'papers/Preview'),notes=path.join(paper,'notes');
  const content='{"label":"中文 <script>alert(1)</script>","success":24}\n';
  await fs.mkdir(notes,{recursive:true});await fs.writeFile(path.join(notes,'summary.json'),content);
  const url=(relative:string)=>`/api/projects/Preview/raw?path=${encodeURIComponent(relative)}`;
  const response=await app.inject(url('notes/summary.json'));
  assert.equal(response.statusCode,200,response.body);assert.equal(response.body,content);
  assert.match(String(response.headers['content-type']),/^application\/json; charset=utf-8$/);
  assert.equal(response.headers['x-content-type-options'],'nosniff');
  assert.equal(response.headers['content-disposition'],"inline; filename*=UTF-8''summary.json");
  for(const relative of ['project.json','.workbench/secret.json','build/secret.json','submissions/secret.json'])assert.equal((await app.inject(url(relative))).statusCode,403,relative);
  assert.equal((await app.inject(url('../outside.json'))).statusCode,400);
  const outside=path.join(root,'outside.json');await fs.writeFile(outside,'{}');await fs.symlink(outside,path.join(notes,'link.json'));
  assert.equal((await app.inject(url('notes/link.json'))).statusCode,403);
  await fs.writeFile(path.join(notes,'unknown.bin'),'binary');
  assert.equal((await app.inject(url('notes/unknown.bin'))).headers['content-type'],'application/octet-stream');
 }finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});
