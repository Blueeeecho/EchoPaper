import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath}from'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type{FastifyInstance}from'fastify';
import type{EmitEvent,Project}from'../shared/types';
import {assertNoSymlinks,HttpError,relativePath}from'./security';
import {createProject}from'./projects';
import {withLock,writeJson}from'./storage';
const run=promisify(execFile),TTL=30*60*1000;
interface Manifest{root:string;files:{path:string;size:number;sha256:string}[];ignored:number}
interface Upload{directory:string;source:string;filename:string;zipSha256:string;createdAt:number;manifest:Manifest;project?:Project;committing?:boolean}
export async function registerProjectImportRoutes(app:FastifyInstance,workspaceRoot:string,emit:EmitEvent){
 const imports=new Map<string,Upload>();let uploads=0;
 const parent=path.join(workspaceRoot,'_system/runtime/project-imports');
 await assertNoSymlinks(workspaceRoot,'_system/runtime',true);await fs.mkdir(parent,{recursive:true,mode:0o700});await assertNoSymlinks(workspaceRoot,'_system/runtime/project-imports');
 for(const name of await fs.readdir(parent))if(/^i-[a-f0-9-]{36}$/.test(name)){const file=path.join(parent,name);if((await fs.lstat(file)).isDirectory())await fs.rm(file,{recursive:true,force:true});}
 async function cleanup(){for(const[token,item]of imports)if(!item.committing&&Date.now()-item.createdAt>TTL){imports.delete(token);await fs.rm(item.directory,{recursive:true,force:true});}}
 const timer=setInterval(()=>void cleanup().catch(error=>app.log.error(error)),60_000);timer.unref();app.addHook('onClose',async()=>{clearInterval(timer);});
 const get=(token:string)=>{const item=imports.get(token);if(!item||Date.now()-item.createdAt>TTL)throw new HttpError(404,'ZIP 暂存已过期，请重新上传。');return item;};
 app.post('/api/project-imports/zip',async(request,reply)=>{
  await cleanup();if(uploads>=2||[...imports.values()].filter(item=>!item.project).length>=10)throw new HttpError(429,'待导入项目较多，请先完成或关闭现有导入。');uploads++;
  let directory:string|undefined;
  try{
   const part=await request.file();if(!part||!part.filename.toLowerCase().endsWith('.zip'))throw new HttpError(400,'请选择 ZIP 格式的 LaTeX 工程。');
   const bytes=await part.toBuffer();if(part.file.truncated)throw new HttpError(413,'ZIP 超过 50 MB 上传限制。');
   const token=randomUUID();directory=path.join(parent,`i-${token}`);await fs.mkdir(directory,{mode:0o700});await fs.writeFile(path.join(directory,'project.zip'),bytes,{flag:'wx',mode:0o600});
   let manifest:Manifest;
   try{const result=await run('/usr/bin/python3',[fileURLToPath(new URL('../scripts/import-project-zip.py',import.meta.url)),path.join(directory,'project.zip'),path.join(directory,'content')],{timeout:120_000,maxBuffer:8*1024*1024});manifest=JSON.parse(result.stdout);}catch(error){throw new HttpError(400,(error as {stderr?:string}).stderr?.trim().slice(0,400)||'ZIP 损坏或无法安全解压，请检查压缩包。');}
   const source=manifest.root?path.join(directory,'content',relativePath(manifest.root)):path.join(directory,'content');
   const candidates=[];
   for(const file of manifest.files.filter(file=>file.path.toLowerCase().endsWith('.tex'))){const buffer=Buffer.alloc(Math.min(file.size,256*1024));const handle=await fs.open(path.join(source,file.path),'r');try{await handle.read(buffer,0,buffer.length,0);}finally{await handle.close();}const text=buffer.toString('utf8').replace(/(?<!\\)%.*/g,'');candidates.push({path:file.path,documentClass:/\\documentclass\b/.test(text)});}
   if(!candidates.length)throw new HttpError(400,'ZIP 中没有可导入的 .tex 文件。');
   const documents=candidates.filter(file=>file.documentClass);const preferred=candidates.find(file=>file.path==='main.tex');const suggestedMain=preferred?.documentClass?preferred.path:documents.length===1?documents[0].path:candidates.length===1?candidates[0].path:undefined;
   if(reply.raw.destroyed)throw new HttpError(400,'上传已取消。');
   imports.set(token,{directory,source,filename:part.filename,zipSha256:createHash('sha256').update(bytes).digest('hex'),createdAt:Date.now(),manifest});
   return reply.code(201).send({token,filename:part.filename,candidates,suggestedMain,fileCount:manifest.files.length,totalBytes:manifest.files.reduce((sum,file)=>sum+file.size,0),ignored:manifest.ignored});
  }catch(error){if(directory)await fs.rm(directory,{recursive:true,force:true});throw error;}finally{uploads--;}
 });
 app.post<{Params:{token:string};Body:{id:string;title:string;main:string}}>('/api/project-imports/:token/create',async(request,reply)=>withLock(`zip-import:${request.params.token}`,async()=>{
  const item=get(request.params.token);if(item.project){if(item.project.id!==request.body?.id)throw new HttpError(409,'此 ZIP 已导入其他项目，请重新上传。');return item.project;}
  const main=relativePath(request.body?.main);if(!main.toLowerCase().endsWith('.tex')||!item.manifest.files.some(file=>file.path===main))throw new HttpError(400,'请选择 ZIP 内实际存在的 TeX 主文件。');
  item.createdAt=Date.now();item.committing=true;
  try{const project=await createProject(workspaceRoot,{id:request.body?.id,title:request.body?.title},{source:item.source,main,beforePublish:async(root)=>{
   const expected=new Set(item.manifest.files.map(file=>file.path));
   async function verifyEntries(directory:string,prefix=''){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const relative=prefix+entry.name;if(entry.isDirectory())await verifyEntries(path.join(directory,entry.name),relative+'/');else if(!entry.isFile()||!expected.has(relative))throw new HttpError(409,'ZIP 暂存内容已变化，请重新上传。');}}
   await verifyEntries(path.join(root,'manuscript'));
   for(const file of item.manifest.files){const content=await fs.readFile(path.join(root,'manuscript',file.path)).catch(()=>{throw new HttpError(409,'ZIP 暂存内容已变化，请重新上传。');});if(content.length!==file.size||createHash('sha256').update(content).digest('hex')!==file.sha256)throw new HttpError(409,'ZIP 暂存内容已变化，请重新上传。');}
   const bytes=await fs.readFile(path.join(item.directory,'project.zip'));if(createHash('sha256').update(bytes).digest('hex')!==item.zipSha256)throw new HttpError(409,'ZIP 原始文件已变化，请重新上传。');
   await assertNoSymlinks(workspaceRoot,'archive',true);await fs.mkdir(path.join(workspaceRoot,'archive'),{recursive:true});const backup=await fs.mkdtemp(path.join(workspaceRoot,'archive',`zip-${request.body.id}-`));
   await fs.writeFile(path.join(backup,'original.zip'),bytes,{flag:'wx',mode:0o600});
   await writeJson(path.join(backup,'SHA256SUMS.json'),{filename:item.filename,zipSha256:item.zipSha256,strippedWrapper:item.manifest.root,main,files:item.manifest.files});
  }});
  item.project=project;await fs.rm(item.directory,{recursive:true,force:true});emit({type:'project.changed',projectId:project.id});return reply.code(201).send(project);
  }finally{item.committing=false;}
 }));
 app.delete<{Params:{token:string}}>('/api/project-imports/:token',async request=>withLock(`zip-import:${request.params.token}`,async()=>{const item=imports.get(request.params.token);if(item){imports.delete(request.params.token);await fs.rm(item.directory,{recursive:true,force:true});}return{ok:true};}));
}
