import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import JSZip from 'jszip';
import {PDFDocument} from 'pdf-lib';
import {saveAgentAttachment,readAgentAttachment} from '../server/agents/attachments';
import {registerAgentRoutes} from '../server/agents/routes';
import {createProviderRegistry,registryPath} from '../server/model-providers';
import {DEFAULT_AGENT_LIMITS,defaultAgentDefinitions} from '../shared/agent-types';
import {estimateModelTokens,createAgentModelGateway} from '../server/agents/model-gateway';
import {validateChatData} from '../server/chats';
import {openTaskStore} from '../server/agents/task-store';
import type {BuildService} from '../shared/types';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=','base64');
async function temporary(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-attachment-'));return{root,async close(){await fs.rm(root,{recursive:true,force:true});}};}
const answer=()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'已检查附件。'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});

test('attachment originals and extracted PDF/Office/text stay separate from manuscripts and survive reads',async()=>{
 const f=await temporary();try{
  const text=await saveAgentAttachment(f.root,'材料.md',Buffer.from('# Source\nEvidence 42'));assert.equal((await readAgentAttachment(f.root,text.id)).text,'# Source\nEvidence 42');
  const image=await saveAgentAttachment(f.root,'example.png',png);assert.equal(image.kind,'image');assert.deepEqual(await fs.readFile((await readAgentAttachment(f.root,image.id)).filename),png);
  const doc=new JSZip();doc.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Editable evidence 77</w:t></w:r></w:p></w:body></w:document>');const word=await saveAgentAttachment(f.root,'notes.docx',await doc.generateAsync({type:'nodebuffer'}));assert.match((await readAgentAttachment(f.root,word.id)).text!,/Editable evidence 77/);
  const deck=new JSZip();deck.file('ppt/slides/slide1.xml','<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Slide evidence</a:t></a:r></a:p></p:sld>');const ppt=await saveAgentAttachment(f.root,'slides.pptx',await deck.generateAsync({type:'nodebuffer'}));assert.match((await readAgentAttachment(f.root,ppt.id)).text!,/Slide evidence/);
  const workbook=new JSZip();workbook.file('xl/sharedStrings.xml','<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Measured</t></si></sst>');workbook.file('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>');const sheet=await saveAgentAttachment(f.root,'data.xlsx',await workbook.generateAsync({type:'nodebuffer'}));assert.match((await readAgentAttachment(f.root,sheet.id)).text!,/A1: Measured\tB1: 42/);
  const pdf=await PDFDocument.create();pdf.addPage().drawText('PDF evidence 314');const paper=await saveAgentAttachment(f.root,'paper.pdf',Buffer.from(await pdf.save()));assert.match((await readAgentAttachment(f.root,paper.id)).text!,/PDF evidence 314/);
  await assert.rejects(saveAgentAttachment(f.root,'legacy.doc',Buffer.from('binary')),/暂不支持/);await assert.rejects(readAgentAttachment(f.root,'../other'),/编号/);
  await fs.writeFile((await readAgentAttachment(f.root,image.id)).filename,Buffer.from('changed'));await assert.rejects(readAgentAttachment(f.root,image.id),/外部修改/);
  assert.equal(await fs.stat(path.join(f.root,'manuscript')).catch(()=>null),null);
 }finally{await f.close();}
});

test('chat normalization retains attachment metadata and pending drafts without accepting raw data',async()=>{
 const f=await temporary();try{const attachment=await saveAgentAttachment(f.root,'source.txt',Buffer.from('Evidence'));const now=new Date().toISOString(),value={version:1,selectedId:'chat',conversations:[{id:'chat',title:'Test',createdAt:now,updatedAt:now,input:'',model:'test',effort:'medium',pendingAttachments:[attachment],messages:[{id:'u',role:'user',content:'Read',createdAt:now,status:'complete',attachments:[attachment]}]}]};const saved=validateChatData(value);assert.deepEqual(saved.conversations[0].pendingAttachments,[attachment]);assert.deepEqual(saved.conversations[0].messages[0].attachments,[attachment]);assert.throws(()=>validateChatData({...value,conversations:[{...value.conversations[0],pendingAttachments:[{...attachment,id:'data:image/png;base64,secret'}]}]}),/附件/);}finally{await f.close();}
});

test('multipart upload reaches native image provider input, preserves tool exchanges and canonical later turns without base64 archives',async()=>{
 const f=await temporary(),project=path.join(f.root,'papers/Alpha'),captured:any[]=[];let app=Fastify(),service:Awaited<ReturnType<typeof registerAgentRoutes>>|undefined;
 try{
  await fs.mkdir(path.join(project,'manuscript'),{recursive:true});await fs.mkdir(path.join(f.root,'_system/runtime'),{recursive:true});await fs.writeFile(path.join(project,'manuscript/main.tex'),'Original source');await fs.writeFile(path.join(project,'project.json'),JSON.stringify({schemaVersion:1,id:'Alpha',title:'Fixture',stage:'writing',venue:'',deadline:'',targets:[{id:'main',label:'主稿',main:'manuscript/main.tex'}],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
  await fs.writeFile(path.join(f.root,registryPath),JSON.stringify({version:2,providers:[{id:'test',label:'Test',plan:'test',kind:'openai-compatible',baseUrl:'https://provider.invalid/v1',auth:'none',enabled:true,includeUsage:true,passReasoning:true}],models:[{id:'test-model',providerId:'test',model:'fixture',label:'Fixture',contextWindow:20000,reasoning:'none',enabled:true,toolCalling:'supported'}],assistant:{modelIds:['test-model'],defaultModelId:'test-model',roles:defaultAgentDefinitions(),limits:DEFAULT_AGENT_LIMITS},translations:[],translationLayout:'stack'}));
  await app.register(multipart);app.setErrorHandler((error,_request,reply)=>reply.code((error as {statusCode?:number}).statusCode||500).send({error:error instanceof Error?error.message:String(error)}));
  const registry=createProviderRegistry(f.root,{getKey:async()=>{throw Error('No credentials may be read');}}),builds={request:async()=>{throw Error('No compile expected');}} as unknown as BuildService;
  service=await registerAgentRoutes(app,f.root,{registry,builds,emit:()=>{},ai:{fetch:async(_url,init)=>{const body=JSON.parse(String(init?.body));captured.push(body);if(captured.length===1)return new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'files',type:'function',function:{name:'list_files',arguments:'{}'}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});return answer();}}});
  const boundary='test-boundary',bytes=Buffer.concat([png,Buffer.alloc(300000,77)]),upload=await app.inject({method:'POST',url:'/api/projects/Alpha/agent-attachments',headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)])});assert.equal(upload.statusCode,201,upload.body);const image=upload.json();const text=await saveAgentAttachment(project,'evidence.txt',Buffer.from('Evidence from uploaded file 2718'));
  const raw=await app.inject({method:'GET',url:`/api/projects/Alpha/agent-attachments/${image.id}/raw`});assert.equal(raw.statusCode,200);assert.deepEqual(raw.rawPayload,bytes);assert.equal(raw.headers['x-content-type-options'],'nosniff');
  async function run(conversationId:string,attachments?:string[],last?:string){const request=await app.inject({method:'POST',url:'/api/projects/Alpha/agent-runs',payload:{requestId:crypto.randomUUID(),conversationId,...(last?{expectedLastRunId:last}:{}),input:'Read uploaded material',attachments,targetId:'main',scope:{readOnly:true,skipCompile:true}}});assert.equal(request.statusCode,201,request.body);const created=request.json();for(let i=0;i<400;i++){const detail=await service!.detail('Alpha',created.id);if(!['queued','running','cancelling'].includes(detail.run.status)){assert.equal(detail.run.status,'completed',detail.run.error);while(service!.busy())await new Promise(resolve=>setTimeout(resolve,5));return detail;}await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Runtime did not finish');}
  const first=await run('with-images',[image.id,text.id]);assert.equal(first.run.attachments?.length,2);const user=captured[0].messages.at(-1);assert.equal(user.content[0].type,'text');assert.match(user.content[0].text,/Evidence from uploaded file 2718/);assert.equal(user.content[1].type,'image_url');assert.equal(user.content[1].image_url.url,`data:image/png;base64,${bytes.toString('base64')}`);assert.ok(captured[1].messages.some((m:any)=>m.role==='tool'&&m.tool_call_id==='files'&&typeof m.content==='string'));
  const store=await openTaskStore(project);try{const runtime=store.runtime(first.run.id) as any;assert.ok(estimateModelTokens(runtime.messages,[])<14000);assert.ok(!JSON.stringify(runtime).includes('data:image'));const records=store.saver.db.prepare('SELECT data FROM agent_model_turns WHERE run_id = ?').all(first.run.id);assert.ok(!JSON.stringify(records).includes(bytes.toString('base64')));}finally{store.close();}
  await run('with-images',undefined,first.run.id);assert.ok(captured.at(-1).messages.some((message:any)=>Array.isArray(message.content)&&message.content.some((part:any)=>part.type==='image_url')));await run('isolated');assert.ok(captured.at(-1).messages.every((message:any)=>typeof message.content==='string'||message.content===null));assert.equal(await fs.readFile(path.join(project,'manuscript/main.tex'),'utf8'),'Original source');
  const {data}=await registry.read(),gateway=createAgentModelGateway(registry,{fetch:async()=>new Response(JSON.stringify({error:{message:'image_url is unsupported'}}),{status:400,headers:{'content-type':'application/json'}})},async()=>({mimeType:'image/png',base64:png.toString('base64')}));await assert.rejects(gateway({projectId:'Alpha',provider:data.providers[0],model:{...data.models[0],contextWindow:20000},messages:[{role:'user',content:'Read image',images:[image]}],tools:[],signal:new AbortController().signal,onReserve:()=>{},onSettled:()=>{}}),/支持视觉/);
 }finally{await service?.close();await app.close();await f.close();}
});
