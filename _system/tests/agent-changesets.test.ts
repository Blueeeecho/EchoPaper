import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createChangeSet,applyChangeSet,undoChangeSet,recoverChangeSets} from '../server/agents/changesets';
import {registerEditorSessionRoutes,prepareEditorCommit} from '../server/agents/editor-barrier';
import {checkpoint} from '../server/history';
import {hash} from '../server/storage';
import {DEFAULT_AGENT_LIMITS,type AgentRun} from '../shared/agent-types';
const run=promisify(execFile);
async function gitLog(root:string){
 const out=(await run('/usr/bin/git',['--no-pager','-C',root,'log','--format=%H%x1f%s%x1e'],{encoding:'utf8'})).stdout;
 const entries=[];
 for(const block of out.split('\x1e').map(s=>s.trim()).filter(Boolean)){
  const [hash,message]=block.split('\x1f');
  const files=(await run('/usr/bin/git',['--no-pager','-C',root,'diff-tree','--root','--no-commit-id','--name-only','-r',hash],{encoding:'utf8'})).stdout.split('\n').map(s=>s.trim()).filter(Boolean);
  entries.push({hash,message,files});
 }
 return entries;
}
async function fixture(){const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'echopaper-agent-changes-')),root=path.join(workspace,'papers/Test');await fs.mkdir(path.join(root,'manuscript'),{recursive:true});await fs.writeFile(path.join(root,'project.json'),JSON.stringify({schemaVersion:1,id:'Test',title:'Test',stage:'writing',venue:'',deadline:'',targets:[{id:'main',label:'Main',main:'manuscript/main.tex'}],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),autoCompile:false}));const run:AgentRun={id:'run-test',projectId:'Test',requestId:'req-test',input:'修复问题',targetId:'main',modelId:'mock',status:'running',phase:'修改',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),configRevision:'test',summary:'',scope:{},changesets:[],children:[],buildIds:[],usage:{modelCalls:0,tokens:0,estimated:false},limits:DEFAULT_AGENT_LIMITS,lastEventSeq:0,version:1};return{workspace,root,run,async close(){await fs.rm(workspace,{recursive:true,force:true});}};}
test('agent changes apply with complete baselines and undo preserves later non-overlapping edits',async()=>{const f=await fixture();try{const before=Array.from({length:20},(_,i)=>`line ${i}`).join('\n')+'\n',after=before.replace('line 1\n','AI edit\n');await fs.writeFile(path.join(f.root,'manuscript/main.tex'),before);const change=await createChangeSet(f.root,f.run,'修复',[{kind:'write',path:'manuscript/main.tex',content:after,expectedHash:hash(before)}],{});await applyChangeSet(f.root,f.run,change);assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),after);await fs.writeFile(path.join(f.root,'manuscript/main.tex'),after.replace('line 18\n','human edit\n'));await undoChangeSet(f.root,f.run,change);assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),before.replace('line 18\n','human edit\n'));assert.equal(change.status,'undone');}finally{await f.close();}});
test('stale multi-file preflight never partially changes another file',async()=>{const f=await fixture();try{for(const file of ['main.tex','part.tex'])await fs.writeFile(path.join(f.root,'manuscript',file),'before');const change=await createChangeSet(f.root,f.run,'两文件',[{kind:'write',path:'manuscript/main.tex',content:'after',expectedHash:hash('before')},{kind:'write',path:'manuscript/part.tex',content:'after',expectedHash:hash('before')}],{});await fs.writeFile(path.join(f.root,'manuscript/part.tex'),'human');await assert.rejects(applyChangeSet(f.root,f.run,change),/基线已变化/);assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),'before');assert.equal(await fs.readFile(path.join(f.root,'manuscript/part.tex'),'utf8'),'human');}finally{await f.close();}});
test('selection only edits its baseline range and polishing preserves math and citations',async()=>{const f=await fixture();try{const before='PREFIX\nText $x=1$ \\cite{real}.\nSUFFIX',selected='Text $x=1$ \\cite{real}.';await fs.writeFile(path.join(f.root,'manuscript/main.tex'),before);f.run.input='润色选区';f.run.scope={selection:{path:'manuscript/main.tex',from:7,to:7+selected.length,documentText:before,selectedText:selected}};await assert.rejects(createChangeSet(f.root,f.run,'越界',[{kind:'write',path:'manuscript/main.tex',content:before.replace('PREFIX','CHANGED'),expectedHash:hash(before)}],{}),/选区/);await assert.rejects(createChangeSet(f.root,f.run,'改公式',[{kind:'write',path:'manuscript/main.tex',content:before.replace('x=1','x=2'),expectedHash:hash(before)}],{}),/公式或引用/);const change=await createChangeSet(f.root,f.run,'润色',[{kind:'write',path:'manuscript/main.tex',content:before.replace('Text','Better text'),expectedHash:hash(before)}],{});await applyChangeSet(f.root,f.run,change);assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),before.replace('Text','Better text'));}finally{await f.close();}});
test('binary moves preserve bytes and update proven TeX resource paths together',async()=>{const f=await fixture();try{const source='\\includegraphics{figure}\n',bytes=Buffer.from([137,80,78,71,0,1,2]);await fs.writeFile(path.join(f.root,'manuscript/main.tex'),source);await fs.writeFile(path.join(f.root,'manuscript/figure.png'),bytes);const change=await createChangeSet(f.root,f.run,'整理图片',[{kind:'move',from:'manuscript/figure.png',to:'manuscript/figures/result.png',expectedHash:hash(bytes)}],{});await applyChangeSet(f.root,f.run,change);assert.equal(hash(await fs.readFile(path.join(f.root,'manuscript/figures/result.png'))),hash(bytes));assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),'\\includegraphics{figures/result}\n');await undoChangeSet(f.root,f.run,change);assert.deepEqual(await fs.readFile(path.join(f.root,'manuscript/figure.png')),bytes);assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),source);}finally{await f.close();}});
test('protected templates and scope escalation cannot become a changeset; delete needs explicit decision',async()=>{const f=await fixture();try{await fs.writeFile(path.join(f.root,'manuscript/main.tex'),'text');await assert.rejects(createChangeSet(f.root,f.run,'模板',[{kind:'write',path:'manuscript/acmart.cls',content:'fake',expectedHash:null}],{}),/受保护/);f.run.scope.paths=['manuscript/main.tex'];await assert.rejects(createChangeSet(f.root,f.run,'越界',[{kind:'write',path:'notes/unasked.md',content:'fake',expectedHash:null}],{}),/范围/);const change=await createChangeSet(f.root,f.run,'删除',[{kind:'delete',path:'manuscript/main.tex',expectedHash:hash('text')}],{});await assert.rejects(applyChangeSet(f.root,f.run,change),/确认/);assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),'text');}finally{await f.close();}});
test('legacy audit records remain protected while author notes stay writable',async()=>{const f=await fixture();try{
 const audit='notes/agent-runs/old-run.md';await fs.mkdir(path.join(f.root,'notes/agent-runs'),{recursive:true});await fs.writeFile(path.join(f.root,audit),'Preserved conversation evidence');
 for(const operation of [{kind:'write' as const,path:audit,content:'replace',expectedHash:hash('Preserved conversation evidence')},{kind:'delete' as const,path:audit,expectedHash:hash('Preserved conversation evidence')},{kind:'move' as const,from:audit,to:'notes/evidence.md',expectedHash:hash('Preserved conversation evidence')}])await assert.rejects(createChangeSet(f.root,f.run,'Cannot rewrite a transcript',[operation],{}),/受保护/);
 const note=await createChangeSet(f.root,f.run,'Author-requested conclusion',[{kind:'write',path:'notes/conclusion.md',content:'A checked result.',expectedHash:null}],{});await applyChangeSet(f.root,f.run,note);assert.equal(await fs.readFile(path.join(f.root,'notes/conclusion.md'),'utf8'),'A checked result.');assert.equal(await fs.readFile(path.join(f.root,audit),'utf8'),'Preserved conversation evidence');
}finally{await f.close();}});
test('interrupted journal compensates own writes and never overwrites an external change',async()=>{const f=await fixture();try{await fs.writeFile(path.join(f.root,'manuscript/main.tex'),'before');const change=await createChangeSet(f.root,f.run,'中断',[{kind:'write',path:'manuscript/main.tex',content:'after',expectedHash:hash('before')}],{});change.status='applying';await fs.writeFile(path.join(f.root,'.workbench/agent-changes',change.id+'.json'),JSON.stringify(change));await fs.writeFile(path.join(f.root,'manuscript/main.tex'),'after');assert.equal((await recoverChangeSets(f.root))[0].status,'failed');assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),'before');change.status='applying';await fs.writeFile(path.join(f.root,'.workbench/agent-changes',change.id+'.json'),JSON.stringify(change));await fs.writeFile(path.join(f.root,'manuscript/main.tex'),'human');assert.equal((await recoverChangeSets(f.root))[0].status,'conflicted');assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),'human');}finally{await f.close();}});
test('live editor must acknowledge a clean buffer before a commit can proceed',async()=>{const f=await fixture(),app=Fastify();try{let barrier:any;registerEditorSessionRoutes(app,f.workspace,event=>{if(event.type==='editor.barrier')barrier=event.barrier;});await app.inject({method:'POST',url:'/api/projects/Test/editor-sessions',payload:{id:'editor-one',path:'manuscript/main.tex',dirty:true,bufferVersion:1}});const waiting=prepareEditorCommit(f.root,['manuscript/main.tex']);while(!barrier)await new Promise(r=>setTimeout(r,1));const reply=await app.inject({method:'POST',url:'/api/projects/Test/editor-sessions/editor-one/ack',payload:{barrierId:barrier.id,bufferVersion:2,clean:true}});assert.equal(reply.statusCode,200,reply.body);const release=await waiting;release();}finally{await app.close();await f.close();}});
test('undo journals reconcile their original and can never be recovered as a new applied change',async()=>{const f=await fixture();try{await fs.writeFile(path.join(f.root,'manuscript/main.tex'),'before');const change=await createChangeSet(f.root,f.run,'原修改',[{kind:'write',path:'manuscript/main.tex',content:'after',expectedHash:hash('before')}],{});await applyChangeSet(f.root,f.run,change);await undoChangeSet(f.root,f.run,change);const all=await recoverChangeSets(f.root);assert.equal(all.length,1);assert.equal(all[0].id,change.id);assert.equal(all[0].status,'undone');change.status='applied';await fs.writeFile(path.join(f.root,'.workbench/agent-changes',change.id+'.json'),JSON.stringify(change));const crashRecovered=await recoverChangeSets(f.root);assert.equal(crashRecovered.length,1);assert.equal(crashRecovered[0].status,'undone');assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),'before');}finally{await f.close();}});
test('move expansion never substitutes a new disk hash for an old model-written manuscript',async()=>{const f=await fixture();try{const old='Old text\n\\includegraphics{figure}\n',human='Human updated text\n\\includegraphics{figure}\n',bytes=Buffer.from([0,1,2]);await fs.writeFile(path.join(f.root,'manuscript/main.tex'),human);await fs.writeFile(path.join(f.root,'manuscript/figure.png'),bytes);await assert.rejects(createChangeSet(f.root,f.run,'移动并修改',[{kind:'write',path:'manuscript/main.tex',content:old.replace('Old','AI'),expectedHash:hash(old)},{kind:'move',from:'manuscript/figure.png',to:'manuscript/figures/result.png',expectedHash:hash(bytes)}],{'manuscript/main.tex':hash(old)}),/已变化/);assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),human);assert.deepEqual(await fs.readFile(path.join(f.root,'manuscript/figure.png')),bytes);}finally{await f.close();}});
test('an external save during replacement preparation is preserved instead of being renamed over',async()=>{const f=await fixture(),write=fs.writeFile;let injected=false;try{await write(path.join(f.root,'manuscript/main.tex'),'before');const change=await createChangeSet(f.root,f.run,'准备时外部保存',[{kind:'write',path:'manuscript/main.tex',content:'after',expectedHash:hash('before')}],{});fs.writeFile=(async(...args:Parameters<typeof fs.writeFile>)=>{if(!injected&&path.basename(String(args[0])).startsWith('.main.tex.')&&String(args[0]).endsWith('.tmp')){injected=true;await write(path.join(f.root,'manuscript/main.tex'),'human saved during temp preparation');}return write(...args);}) as typeof fs.writeFile;await assert.rejects(applyChangeSet(f.root,f.run,change),/文件变化/);assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),'human saved during temp preparation');}finally{fs.writeFile=write;await f.close();}});
test('an external save while preserving a deletion recovery copy prevents deletion',async()=>{const f=await fixture(),write=fs.writeFile;let injected=false;try{await write(path.join(f.root,'manuscript/main.tex'),'before');const change=await createChangeSet(f.root,f.run,'删除前外部保存',[{kind:'delete',path:'manuscript/main.tex',expectedHash:hash('before')}],{});fs.writeFile=(async(...args:Parameters<typeof fs.writeFile>)=>{if(!injected&&String(args[0]).includes('/.workbench/recovery/')&&String(args[0]).endsWith('.tmp')){injected=true;await write(path.join(f.root,'manuscript/main.tex'),'human saved before delete');}return write(...args);}) as typeof fs.writeFile;await assert.rejects(applyChangeSet(f.root,f.run,change,{decisionConfirmed:true}),/文件变化/);assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),'human saved before delete');}finally{fs.writeFile=write;await f.close();}});

test('attachment and TeX form one reviewable change with exact bytes, CAS and undo',async()=>{
 const {saveAgentAttachment,readAgentAttachment}=await import('../server/agents/attachments');
 const f=await fixture();try{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=','base64');
  const attachment=await saveAgentAttachment(f.root,'image.png',png);f.run.attachments=[attachment];
  const before='original figure\n',after='\\includegraphics{figures/figure-1.png}\n';await fs.writeFile(path.join(f.root,'manuscript/main.tex'),before);
  const operations=[{kind:'attachment' as const,path:'manuscript/figures/figure-1.png',attachmentId:attachment.id,expectedHash:null},{kind:'write' as const,path:'manuscript/main.tex',content:after,expectedHash:hash(before)}];
  const change=await createChangeSet(f.root,f.run,'替换图1',operations,{});
  await assert.rejects(fs.stat(path.join(f.root,operations[0].path)),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),before);
  assert.equal(change.images[0].afterHash,hash(png));await applyChangeSet(f.root,f.run,change);
  assert.deepEqual(await fs.readFile(path.join(f.root,operations[0].path)),png);assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),after);
  await undoChangeSet(f.root,f.run,change);assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),before);await assert.rejects(fs.stat(path.join(f.root,operations[0].path)),{code:'ENOENT'});
  const stale=await createChangeSet(f.root,f.run,'CAS',operations,{});await fs.mkdir(path.join(f.root,'manuscript/figures'),{recursive:true});await fs.writeFile(path.join(f.root,operations[0].path),'author image');await assert.rejects(applyChangeSet(f.root,f.run,stale),/基线已变化/);assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),before);
  await assert.rejects(createChangeSet(f.root,f.run,'foreign',[{...operations[0],path:'manuscript/other.png'}],{},[]),/当前会话/);
  await assert.rejects(createChangeSet(f.root,f.run,'format',[{...operations[0],path:'manuscript/other.jpg'}],{}),/格式一致/);
  f.run.scope={paths:['manuscript/main.tex']};await assert.rejects(createChangeSet(f.root,f.run,'scope',[operations[0]],{}),/范围/);f.run.scope={};
  const item=await readAgentAttachment(f.root,attachment.id);await fs.writeFile(item.filename,'corrupted');await assert.rejects(createChangeSet(f.root,f.run,'tampered',[{...operations[0],path:'manuscript/other.png'}],{}),/外部修改/);
 }finally{await f.close();}
});

test('binary rename keeps its real encoding and permits JPEG extension aliases',async()=>{
 const f=await fixture();try{
  const bytes=Buffer.from([255,216,255,224,0,1]);await fs.writeFile(path.join(f.root,'manuscript/source.jpg'),bytes);
  await assert.rejects(createChangeSet(f.root,f.run,'wrong extension',[{kind:'move',from:'manuscript/source.jpg',to:'manuscript/fig_1.png',expectedHash:hash(bytes)}],{}),/不会转换|真实格式/);
  const allowed=await createChangeSet(f.root,f.run,'jpeg alias',[{kind:'move',from:'manuscript/source.jpg',to:'manuscript/fig_1.jpeg',expectedHash:hash(bytes)}],{});assert.equal(allowed.images.find(image=>image.path==='manuscript/fig_1.jpeg')!.afterHash,hash(bytes));
 }finally{await f.close();}
});

test('residual dirty files get an honest pre-commit, and the AI follow-up commit only contains this edit',async()=>{
 const f=await fixture();try{
  await fs.mkdir(path.join(f.root,'manuscript/tex'),{recursive:true});
  await fs.mkdir(path.join(f.root,'manuscript/fig_tab'),{recursive:true});
  await fs.writeFile(path.join(f.root,'manuscript/tex/0_Abstract.tex'),'old abstract\n');
  await fs.writeFile(path.join(f.root,'manuscript/fig_tab/tab_1.tex'),'old table\n');
  await checkpoint(f.root,'初始版本');
  await fs.writeFile(path.join(f.root,'manuscript/tex/0_Abstract.tex'),'residual abstract\n');
  const description='Apply seeded synthetic layout demonstration patch to manuscript/fig_tab/tab_1.tex';
  const change=await createChangeSet(f.root,f.run,description,[{kind:'write',path:'manuscript/fig_tab/tab_1.tex',content:'new table\n',expectedHash:hash('old table\n')}],{});
  await applyChangeSet(f.root,f.run,change);
  const log=await gitLog(f.root);
  assert.equal(log[0].message,'AI 修改后：'+description);
  assert.deepEqual(log[0].files,['manuscript/fig_tab/tab_1.tex']);
  assert.equal(log[1].message,'AI 修改前：'+description);
  assert.deepEqual(log[1].files,['manuscript/tex/0_Abstract.tex']);
  assert.equal(log[2].message,'初始版本');
  assert.equal(await fs.readFile(path.join(f.root,'manuscript/tex/0_Abstract.tex'),'utf8'),'residual abstract\n');
  assert.equal(await fs.readFile(path.join(f.root,'manuscript/fig_tab/tab_1.tex'),'utf8'),'new table\n');
 }finally{await f.close();}
});

test('a successful AI edit with a clean tree only records an after-commit, never an empty before-commit',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.root,'manuscript/main.tex'),'before\n');
  await checkpoint(f.root,'初始版本');
  const change=await createChangeSet(f.root,f.run,'只改正文',[{kind:'write',path:'manuscript/main.tex',content:'after\n',expectedHash:hash('before\n')}],{});
  await applyChangeSet(f.root,f.run,change);
  const log=await gitLog(f.root);
  assert.equal(log[0].message,'AI 修改后：只改正文');
  assert.deepEqual(log[0].files,['manuscript/main.tex']);
  assert.equal(log[1].message,'初始版本');
  assert.equal(log.some(entry=>entry.message.startsWith('AI 修改前')),false);
 }finally{await f.close();}
});

test('failed, cancelled or no-op AI edits do not create an empty after-commit',async()=>{
 const f=await fixture();try{
  await fs.mkdir(path.join(f.root,'notes'),{recursive:true});
  await fs.writeFile(path.join(f.root,'manuscript/main.tex'),'before\n');
  await fs.writeFile(path.join(f.root,'notes/scratch.md'),'note\n');
  await checkpoint(f.root,'初始版本');
  await fs.writeFile(path.join(f.root,'notes/scratch.md'),'residual note\n');
  const cancelled=await createChangeSet(f.root,f.run,'不会落地',[{kind:'write',path:'manuscript/main.tex',content:'cancelled\n',expectedHash:hash('before\n')}],{});
  await assert.rejects(applyChangeSet(f.root,f.run,cancelled,{signal:AbortSignal.abort()}),/已停止/);
  let log=await gitLog(f.root);
  assert.deepEqual(log.map(entry=>entry.message),['初始版本']);
  assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),'before\n');
  assert.equal(await fs.readFile(path.join(f.root,'notes/scratch.md'),'utf8'),'residual note\n');

  const stale=await createChangeSet(f.root,f.run,'基线失效',[{kind:'write',path:'manuscript/main.tex',content:'stale\n',expectedHash:hash('before\n')}],{});
  await fs.writeFile(path.join(f.root,'manuscript/main.tex'),'human\n');
  await assert.rejects(applyChangeSet(f.root,f.run,stale),/基线已变化/);
  log=await gitLog(f.root);
  assert.deepEqual(log.map(entry=>entry.message),['初始版本']);
  assert.equal(await fs.readFile(path.join(f.root,'notes/scratch.md'),'utf8'),'residual note\n');

  await fs.writeFile(path.join(f.root,'manuscript/main.tex'),'before\n');
  const identical=await createChangeSet(f.root,f.run,'内容未变',[{kind:'write',path:'manuscript/main.tex',content:'before\n',expectedHash:hash('before\n')}],{});
  await applyChangeSet(f.root,f.run,identical);
  log=await gitLog(f.root);
  assert.equal(log[0].message,'AI 修改前：内容未变');
  assert.deepEqual(log[0].files,['notes/scratch.md']);
  assert.equal(log[1].message,'初始版本');
  assert.equal(log.some(entry=>entry.message.startsWith('AI 修改后')),false);
 }finally{await f.close();}
});

test('a write that fails after the residual commit does not invent an after-commit for the aborted edit',async()=>{
 const f=await fixture(),write=fs.writeFile;let injected=false;try{
  await fs.mkdir(path.join(f.root,'notes'),{recursive:true});
  await write(path.join(f.root,'manuscript/main.tex'),'before\n');
  await write(path.join(f.root,'notes/scratch.md'),'note\n');
  await checkpoint(f.root,'初始版本');
  await write(path.join(f.root,'notes/scratch.md'),'residual note\n');
  const change=await createChangeSet(f.root,f.run,'准备时外部保存',[{kind:'write',path:'manuscript/main.tex',content:'after\n',expectedHash:hash('before\n')}],{});
  fs.writeFile=(async(...args:Parameters<typeof fs.writeFile>)=>{
   if(!injected&&path.basename(String(args[0])).startsWith('.main.tex.')&&String(args[0]).endsWith('.tmp')){
    injected=true;await write(path.join(f.root,'manuscript/main.tex'),'human saved during temp preparation');
   }
   return write(...args);
  }) as typeof fs.writeFile;
  await assert.rejects(applyChangeSet(f.root,f.run,change),/文件变化/);
  const log=await gitLog(f.root);
  assert.equal(log[0].message,'AI 修改前：准备时外部保存');
  assert.deepEqual(log[0].files,['notes/scratch.md']);
  assert.equal(log.some(entry=>entry.message.startsWith('AI 修改后')),false);
  assert.equal(await fs.readFile(path.join(f.root,'manuscript/main.tex'),'utf8'),'human saved during temp preparation');
 }finally{fs.writeFile=write;await f.close();}
});

test('a scope refusal names the boundary, the blocked file and how to widen it',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.root,'manuscript/main.tex'),'text');
  const attempt=async(scope:Record<string,unknown>,file:string)=>{
   const run={...f.run,scope} as typeof f.run;
   try{await createChangeSet(f.root,run,'范围测试',[{kind:'write',path:file,content:'next',expectedHash:null}],{});}
   catch(error){return error as {statusCode?:number;message:string;extra?:Record<string,unknown>};}
   throw new Error('应当被拒绝：'+file);
  };
  const readOnly=await attempt({readOnly:true},'manuscript/main.tex');
  assert.equal(readOnly.statusCode,403);assert.equal(readOnly.extra?.scopeViolation,'readOnly');
  assert.match(readOnly.message,/只读/);assert.match(readOnly.message,/main\.tex/);
  const outside=await attempt({paths:['manuscript/tex/0_Abstract.tex']},'manuscript/main.tex');
  assert.equal(outside.statusCode,403);assert.equal(outside.extra?.scopeViolation,'paths');
  assert.match(outside.message,/0_Abstract\.tex/);assert.match(outside.message,/main\.tex/);assert.match(outside.message,/明确写入范围/);
 }finally{await f.close();}
});
