import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../security';
import { createAgentRuntime, type AgentRuntimeOptions } from './runtime';
import type { AgentCreateInput } from '../../shared/agent-types';
import type { ServerResponse } from 'node:http';
import {registerAgentAttachmentRoutes} from './attachments';

const scope=z.object({paths:z.array(z.string().min(1).max(1000)).max(200).optional(),selection:z.object({path:z.string().min(1).max(1000),from:z.number().int().min(0),to:z.number().int().min(0),documentText:z.string().max(3*1024*1024),selectedText:z.string().min(1).max(50000)}).strict().optional(),readOnly:z.boolean().optional(),skipCompile:z.boolean().optional()}).strict();
const history=z.array(z.object({role:z.enum(['user','assistant']),content:z.string().max(200000)}).strict()).max(100).refine(messages=>messages.reduce((sum,message)=>sum+message.content.length,0)<=200000,'历史合计不能超过 200000 字符。');
const createInput=z.object({requestId:z.string().min(1).max(100).regex(/^[\w.:-]+$/),conversationId:z.string().min(1).max(100).optional(),expectedLastRunId:z.string().min(1).max(100).nullable().optional(),input:z.string().min(1).max(200000),attachments:z.array(z.string().regex(/^[a-f0-9-]{36}$/)).max(20).optional(),history:history.optional(),compactionId:z.string().min(1).max(100).optional(),targetId:z.string().min(1).max(100),modelId:z.string().max(100).optional(),effort:z.enum(['low','medium','high','xhigh','max']).optional(),roleId:z.string().max(100).optional(),scope:scope.optional(),buildId:z.string().max(100).optional(),diagnostic:z.object({message:z.string().max(20000),file:z.string().max(1000).optional(),line:z.number().int().min(1).optional()}).strict().optional()}).strict();
function parse<T>(schema:z.ZodType<T>,body:unknown):T {const result=schema.safeParse(body);if(!result.success)throw new HttpError(400,'助手请求格式无效：'+result.error.issues.slice(0,3).map(issue=>issue.path.join('.')+' '+issue.message).join('；'));return result.data;}
export async function registerAgentRoutes(app:FastifyInstance,workspaceRoot:string,options:AgentRuntimeOptions) {
 await registerAgentAttachmentRoutes(app,workspaceRoot);
 const service=await createAgentRuntime(workspaceRoot,options),clients=new Set<ServerResponse>();type Params={id:string;runId:string};
 app.addHook('preClose',async()=>{for(const client of clients)client.end();clients.clear();await service.close();});
 app.get<{Params:{id:string}}>('/api/projects/:id/agent-runs',async request=>({runs:await service.list(request.params.id)}));
 app.post<{Params:{id:string};Body:AgentCreateInput}>('/api/projects/:id/agent-runs',{bodyLimit:8*1024*1024},async(request,reply)=>{const input=parse(createInput,request.body);const selected=input.scope?.selection;if(selected&&(selected.to<=selected.from||selected.to>selected.documentText.length||selected.documentText.slice(selected.from,selected.to)!==selected.selectedText))throw new HttpError(400,'选区范围与文本不一致。');return reply.code(201).send(await service.create(request.params.id,input));});
 app.get<{Params:Params}>('/api/projects/:id/agent-runs/:runId',async request=>service.detail(request.params.id,request.params.runId));
 app.get<{Params:Params;Querystring:{after?:string}}>('/api/projects/:id/agent-runs/:runId/events',async(request,reply)=>{
  await service.detail(request.params.id,request.params.runId);const raw=request.query.after??request.headers['last-event-id']??'0';if(typeof raw!=='string'||!/^\d{1,12}$/.test(raw))throw new HttpError(400,'事件序号无效。');const after=Number(raw);
  reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});reply.raw.write(': connected\n\n');clients.add(reply.raw);let closed=false,unsubscribe:(()=>void)|undefined;
  const heartbeat=setInterval(()=>{if(!reply.raw.destroyed&&!reply.raw.writableEnded)reply.raw.write(': heartbeat\n\n');},15000);heartbeat.unref();
  reply.raw.on('close',()=>{closed=true;clients.delete(reply.raw);clearInterval(heartbeat);unsubscribe?.();});
  try{unsubscribe=await service.subscribe(request.params.id,request.params.runId,after,event=>{if(!closed&&!reply.raw.destroyed&&!reply.raw.writableEnded)reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);});if(closed)unsubscribe();}catch{clearInterval(heartbeat);if(!reply.raw.destroyed&&!reply.raw.writableEnded)reply.raw.end();}
 });
 app.post<{Params:Params}>('/api/projects/:id/agent-runs/:runId/cancel',async request=>({run:await service.cancel(request.params.id,request.params.runId)}));
 app.post<{Params:Params}>('/api/projects/:id/agent-runs/:runId/resume',async request=>({run:await service.resume(request.params.id,request.params.runId)}));
 app.post<{Params:Params;Body:{decisionId:string;approve:boolean}}>('/api/projects/:id/agent-runs/:runId/decisions',async request=>{const body=parse(z.object({decisionId:z.string().min(1).max(100),approve:z.boolean()}).strict(),request.body);return{run:await service.decision(request.params.id,request.params.runId,body.decisionId,body.approve)};});
 app.post<{Params:Params;Body:{changesetId?:string}}>('/api/projects/:id/agent-runs/:runId/undo',async request=>{const body=parse(z.object({changesetId:z.string().max(100).optional()}).strict(),request.body??{});return{run:await service.undo(request.params.id,request.params.runId,body.changesetId)};});
 return service;
}
