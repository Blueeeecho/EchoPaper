import fs from 'node:fs/promises';
import type {FastifyInstance} from 'fastify';
import {assertNoSymlinks,HttpError} from '../security';
import {atomicWrite,hash,withLock} from '../storage';
import {workspaceMaintenance} from '../agents/maintenance';
import {emptyTopicNotebook,validTopicNotebook,type TopicNotebook} from '../../shared/topic-notebook';

export async function readTopicNotebook(root:string,id:string){
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new HttpError(400,'课题ID无效');
 const file=await assertNoSymlinks(root,`workspace/topic-notebooks/${id}.json`,true);
 try{const raw=await fs.readFile(file,'utf8');return {notebook:JSON.parse(raw) as TopicNotebook,hash:hash(raw)};}
 catch(error:any){if(error.code!=='ENOENT')throw error;return {notebook:emptyTopicNotebook(id),hash:null as string|null};}
}

/** Ideas and key references live beside the topic catalog, one hash-checked JSON file per topic. */
export function registerTopicNotebookRoutes(app:FastifyInstance,root:string,topicExists:(id:string)=>Promise<boolean>){
 const filename=async(id:string)=>{if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new HttpError(400,'课题ID无效');if(!await topicExists(id))throw new HttpError(404,'研究主题不存在。');return assertNoSymlinks(root,`workspace/topic-notebooks/${id}.json`,true);};
 async function read(id:string){await filename(id);return readTopicNotebook(root,id);}
 app.get<{Params:{id:string}}>('/api/workspace/topics/:id/notebook',async req=>read(req.params.id));
 app.put<{Params:{id:string};Body:{notebook:TopicNotebook;expectedHash:string|null}}>('/api/workspace/topics/:id/notebook',{bodyLimit:4*1024*1024},async req=>{const id=req.params.id;return withLock(`topic-notebook:${root}:${id}`,async()=>{workspaceMaintenance(root).assertAvailable();const current=await read(id);if(req.body?.expectedHash!==current.hash)throw new HttpError(409,'课题笔记已在其他窗口修改；你的输入已保留，请刷新后合并。');if(!validTopicNotebook(req.body?.notebook,id))throw new HttpError(400,'课题笔记格式无效');const raw=JSON.stringify(req.body.notebook);const file=await filename(id);await fs.mkdir(file.slice(0,file.lastIndexOf('/')),{recursive:true});await atomicWrite(file,raw);return {notebook:req.body.notebook,hash:hash(raw)};});});
}
