import Fastify from 'fastify';
import {registerProjectImportRoutes}from'./project-imports';
import staticPlugin from '@fastify/static';
import multipart from '@fastify/multipart';
import chokidar from 'chokidar';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ServerResponse } from 'node:http';
import type { BuildService, Project, WorkspaceEvent } from '../shared/types.ts';
import { createBuildService } from './builds.ts';
import { HttpError, assertNoSymlinks, relativePath, registeredRoot } from './security.ts';
import { createProject, getProject, listProjects, patchProject } from './projects.ts';
import { createDirectory, document, listFiles, renameDocument, saveDocument, search, upload } from './files.ts';
import { checkpoint, diff, history, restore } from './history.ts';
import { createReview, listReviews, updateReview } from './reviews.ts';
import { registerAiRoutes, type AiOptions } from './ai.ts';
import {registerAgentRoutes} from './agents/routes';
import {registerEditorSessionRoutes} from './agents/editor-barrier';
import {withProjectMutation} from './storage';
import { registerAnnotationRoutes } from './annotations.ts';
import { registerReferenceRoutes } from './references.ts';
import { registerCompareRoutes } from './compare.ts';
import { registerBackupRoutes, recoverPendingRestore } from './backups.ts';
import { registerChatRoutes } from './chats.ts';
import { registerSyncRoutes } from './synctex.ts';
import { registerConferenceRoutes } from './conferences.ts';
import { registerWorkspaceRoutes } from './workspace/index';
import { registerPresentationRoutes } from './presentations/index';

export interface AppOptions { workspaceRoot?: string; buildService?: BuildService; watch?: boolean; ai?: AiOptions }
const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const mimeTypes: Record<string,string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.tex': 'text/plain; charset=utf-8', '.bib': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
export async function createApp(options: AppOptions = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.env.WORKBENCH_ROOT ?? defaultRoot);
  await recoverPendingRestore(workspaceRoot);
  const app = Fastify({ logger: process.env.WORKBENCH_LOG === '1', bodyLimit: 5 * 1024 * 1024, requestTimeout: 0 });
  const clients = new Set<ServerResponse>();
  const emit = (event: WorkspaceEvent) => { const data = `data: ${JSON.stringify(event)}\n\n`; for (const client of clients) { try { client.write(data); } catch { clients.delete(client); } } };
  const builds = options.buildService ?? createBuildService({ workspaceRoot, emit });
  let workspaceLocked = () => false;
  const fileChanged = (id: string, changed: string) => {
    if (workspaceLocked()) return;
    emit({ type: 'file.changed', projectId: id, path: changed });
    if (changed === 'notes/pdf-annotations.json') { emit({ type: 'annotation.changed', projectId: id, path: changed }); return; }
    // File events synchronize editors and let build queries refresh staleness.
    // Even legacy projects with autoCompile=true only compile on explicit requests.
  };
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as Error & { statusCode?: number; extra?: Record<string, unknown>; code?: string };
    const status = failure.statusCode ?? (failure.code === 'ENOENT' ? 404 : 500);
    if (status >= 500) console.error('[workbench]', error);
    reply.code(status >= 400 && status <= 599 ? status : 500).send({ error: status >= 500 ? '服务器操作失败，请查看运行日志。' : failure.message, ...failure.extra });
  });
  app.addHook('onRequest', async (request,reply) => {
    let host: URL; try { host = new URL(`http://${request.headers.host ?? ''}`); } catch { return reply.code(403).send({error:'访问地址无效。'}); }
    if (!['127.0.0.1','localhost','[::1]'].includes(host.hostname)) return reply.code(403).send({error:'工作台仅允许本机地址访问。'});
    if (!['GET','HEAD','OPTIONS'].includes(request.method) && request.headers.origin) {
      let origin: URL; try { origin = new URL(request.headers.origin); } catch { return reply.code(403).send({error:'请求来源无效。'}); }
      if (!['http:','https:'].includes(origin.protocol) || origin.host !== host.host) return reply.code(403).send({error:'不允许其他网页修改本地论文。'});
    }
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','same-origin');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control','no-store');
  });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
  app.get('/api/health', async () => ({ ok: true, workspaceRoot, pid: process.pid,capabilities:{agentTasks:true,agentConversations:true,agentEventPurposes:true,chatLifecycle:true,modelConfigVersion:2,isolatedTranslation:true,academicWorkspace:true,presentations:true} }));
  app.get('/api/settings', async () => ({ compiler: process.env.TECTONIC_PATH ?? '/opt/homebrew/bin/tectonic', workspaceRoot }));
  const registry=await registerAiRoutes(app, workspaceRoot, {...options.ai,onChanged:(purpose)=>{options.ai?.onChanged?.(purpose);emit({type:'ai.config.changed',projectId:'',purpose});}});
  registerEditorSessionRoutes(app,workspaceRoot,emit);
  const agents=await registerAgentRoutes(app,workspaceRoot,{registry,builds,emit,ai:options.ai});
  const workspace=await registerWorkspaceRoutes(app,workspaceRoot,{watch:options.watch});
  const presentations=await registerPresentationRoutes(app,workspaceRoot,{registry,ai:options.ai,resourceFile:workspace.resourceFile});
  app.post<{Params:{id:string}}>('/api/workspace/resources/:id/reveal',async request=>{
    const resource=await workspace.resourceFile(request.params.id);
    if(process.platform!=='darwin')throw new HttpError(501,'当前系统暂不支持在 Finder 显示，请使用文件路径。');
    await promisify(execFile)('/usr/bin/open',['-R',resource.filename]);return {revealed:true};
  });
  await registerAnnotationRoutes(app, workspaceRoot, builds, emit);
  await registerReferenceRoutes(app, workspaceRoot);
  await registerCompareRoutes(app, workspaceRoot, builds);
  await registerChatRoutes(app, workspaceRoot, emit,{conversationBusy:(projectId,conversationId)=>agents.conversationBusy(projectId,conversationId)});
  const backupState = await registerBackupRoutes(app, workspaceRoot, builds, emit,{agentsBusy:()=>agents.busy()||workspace.busy()||presentations.busy(),prepareAgentBackup:async()=>{await agents.checkpointForBackup();await workspace.checkpoint();await presentations.checkpoint();},afterWorkspaceRestore:async()=>{await workspace.close();await presentations.close();}});
  workspaceLocked = backupState.isLocked;
  await registerProjectImportRoutes(app,workspaceRoot,emit);
  await registerSyncRoutes(app, workspaceRoot, builds);
  await registerConferenceRoutes(app, workspaceRoot);
  app.get('/api/projects', async () => ({ projects: await listProjects(workspaceRoot) }));
  app.get<{Params:{id:string}}>('/api/projects/:id', async request => getProject(workspaceRoot,request.params.id));
  app.post<{ Body: {id?:string;title?:string;template?:string;importPath?:string} }>('/api/projects', async (request,reply) => { const project = await createProject(workspaceRoot,request.body ?? {}); emit({type:'project.changed',projectId:project.id}); return reply.code(201).send(project); });
  app.patch<{Params:{id:string};Body:Partial<Project>}>('/api/projects/:id', async request => { const project = await patchProject(workspaceRoot,request.params.id,request.body ?? {}); emit({type:'project.changed',projectId:project.id}); return project; });
  app.get<{Params:{id:string}}>('/api/projects/:id/files', async request => ({ files: await listFiles(await registeredRoot(workspaceRoot,request.params.id)) }));
  app.post<{Params:{id:string};Body:{path:string;expectedHash:null}}>('/api/projects/:id/directories',async request=>{const body=request.body??{};const result=await createDirectory(await registeredRoot(workspaceRoot,request.params.id),body.path,body.expectedHash);fileChanged(request.params.id,result.path);return result;});
  app.get<{Params:{id:string};Querystring:{path:string}}>('/api/projects/:id/file', async request => document(await registeredRoot(workspaceRoot,request.params.id),request.query.path));
  app.put<{Params:{id:string};Body:{path:string;content:string;expectedHash:string|null}}>('/api/projects/:id/file', async request => { const body = request.body ?? {}; const result = await saveDocument(await registeredRoot(workspaceRoot,request.params.id),body.path,body.content,body.expectedHash); fileChanged(request.params.id,result.path); return result; });
  app.post<{Params:{id:string};Body:{from:string;to:string;expectedHash:string}}>('/api/projects/:id/files/rename', async request => { const body=request.body ?? {}; const result=await renameDocument(await registeredRoot(workspaceRoot,request.params.id),body.from,body.to,body.expectedHash); fileChanged(request.params.id,body.from); fileChanged(request.params.id,result.path); return result; });
  app.get<{Params:{id:string};Querystring:{path:string}}>('/api/projects/:id/raw', async (request,reply) => {
    const relative=relativePath(request.query.path); if (relative.split('/').some(part=>part.startsWith('.')) || relative==='project.json' || ['build','submissions'].includes(relative.split('/')[0])) throw new HttpError(403,'此文件不在预览区内。');
    const file = await assertNoSymlinks(await registeredRoot(workspaceRoot,request.params.id),relative); if (!(await fs.stat(file)).isFile()) throw new HttpError(400,'请选择文件。');
    if (path.extname(file).toLowerCase()==='.svg') reply.header('Content-Security-Policy',"sandbox; default-src 'none'; img-src data:");
    return reply.type(mimeTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream').send(createReadStream(file));
  });
  app.post<{Params:{id:string};Querystring:{directory?:string}}>('/api/projects/:id/upload', async request => { const root=await registeredRoot(workspaceRoot,request.params.id); const part=await request.file(); if (!part) throw new HttpError(400,'请选择上传文件。'); const buffer=await part.toBuffer(); const file=await upload(root,request.query.directory ?? 'manuscript',part.filename,buffer); fileChanged(request.params.id,file); return {path:file}; });
  app.get<{Params:{id:string};Querystring:{q?:string}}>('/api/projects/:id/search', async request => ({ results: await search(await registeredRoot(workspaceRoot,request.params.id),request.query.q ?? '') }));
  app.get<{Params:{id:string}}>('/api/projects/:id/builds', async request => { await registeredRoot(workspaceRoot,request.params.id); return {builds:await builds.list(request.params.id)}; });
  app.post<{Params:{id:string};Body:{targetId:string}}>('/api/projects/:id/builds', async request => { await registeredRoot(workspaceRoot,request.params.id); return builds.request(request.params.id,request.body?.targetId); });
  app.get<{Params:{id:string}}>('/api/builds/:id', async request => builds.get(request.params.id));
  app.post<{Params:{id:string}}>('/api/builds/:id/cancel', async request => builds.cancel(request.params.id));
  app.get<{Params:{id:string;name:string}}>('/api/builds/:id/artifacts/:name', async (request,reply) => { const file=await builds.artifact(request.params.id,request.params.name); return reply.type(mimeTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream').send(createReadStream(file)); });
  app.get('/api/events', (request,reply) => {
    reply.hijack(); reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'}); reply.raw.write(': connected\n\n'); clients.add(reply.raw);
    const heartbeat=setInterval(()=>{ if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); },15000); heartbeat.unref();
    reply.raw.on('close',()=>{ clearInterval(heartbeat); clients.delete(reply.raw); });
  });
  app.get<{Params:{id:string}}>('/api/projects/:id/history', async request => ({history:await history(await registeredRoot(workspaceRoot,request.params.id))}));
  app.post<{Params:{id:string};Body:{message?:string}}>('/api/projects/:id/checkpoints', async request => { if (request.body?.message !== undefined && typeof request.body.message !== 'string') throw new HttpError(400,'版本说明无效。'); const entry=await checkpoint(await registeredRoot(workspaceRoot,request.params.id),request.body?.message || '保存版本'); emit({type:'history.changed',projectId:request.params.id}); return entry; });
  app.get<{Params:{id:string};Querystring:{path:string;ref?:string}}>('/api/projects/:id/diff', async request => ({diff:await diff(await registeredRoot(workspaceRoot,request.params.id),request.query.path,request.query.ref)}));
  app.post<{Params:{id:string};Body:{path:string;ref:string}}>('/api/projects/:id/restore', async request => { await restore(await registeredRoot(workspaceRoot,request.params.id),request.body?.path,request.body?.ref); fileChanged(request.params.id,request.body.path); emit({type:'history.changed',projectId:request.params.id}); return document(await registeredRoot(workspaceRoot,request.params.id),request.body.path); });
  app.get<{Params:{id:string}}>('/api/projects/:id/reviews', async request => ({rounds:await listReviews(workspaceRoot,request.params.id)}));
  app.post<{Params:{id:string};Body:{label?:string}}>('/api/projects/:id/reviews', async request => { const result=await createReview(workspaceRoot,request.params.id,request.body?.label); emit({type:'review.changed',projectId:request.params.id}); emit({type:'project.changed',projectId:request.params.id}); return result; });
  app.put<{Params:{id:string;roundId:string};Body:{items:unknown}}>('/api/projects/:id/reviews/:roundId', async request => { const root=await registeredRoot(workspaceRoot,request.params.id);const result=await withProjectMutation(root,()=>updateReview(workspaceRoot,request.params.id,request.params.roundId,request.body?.items)); emit({type:'review.changed',projectId:request.params.id}); fileChanged(request.params.id,`reviews/${request.params.roundId}/response/responses.tex`); return result; });
  app.get<{Params:{id:string}}>('/api/projects/:id/submissions', async request => { await registeredRoot(workspaceRoot,request.params.id); return {submissions:await builds.listSubmissions(request.params.id)}; });
  app.post<{Params:{id:string};Body:{targetId:string}}>('/api/projects/:id/submissions', async request => { await registeredRoot(workspaceRoot,request.params.id); return builds.createSubmission(request.params.id,request.body?.targetId); });
  app.get<{Params:{id:string;submissionId:string}}>('/api/projects/:id/submissions/:submissionId/download', async (request,reply) => { await registeredRoot(workspaceRoot,request.params.id); const file=await builds.submissionArtifact(request.params.id,request.params.submissionId); return reply.type('application/zip').header('Content-Disposition',`attachment; filename="${path.basename(file).replace(/[^A-Za-z0-9._-]/g,'_')}"`).send(createReadStream(file)); });
  app.post('/api/shutdown', async (_request,reply) => { reply.code(202).send({ok:true}); setTimeout(()=>void app.close(),50).unref(); });
  const dist=path.join(workspaceRoot,'_system','dist');
  if (await fs.stat(dist).then(s=>s.isDirectory()).catch(()=>false)) await app.register(staticPlugin,{root:dist});
  app.setNotFoundHandler(async (request,reply) => { if (request.url.startsWith('/api/')) return reply.code(404).send({error:'接口不存在。'}); const index=path.join(dist,'index.html'); if (await fs.stat(index).then(s=>s.isFile()).catch(()=>false)) return reply.type('text/html; charset=utf-8').send(createReadStream(index)); return reply.code(503).type('text/plain; charset=utf-8').send('网页尚未构建。请在 _system 中运行 npm run build。'); });
  await listProjects(workspaceRoot);
  const watcher=options.watch===false ? null : chokidar.watch(path.join(workspaceRoot,'papers'),{ignoreInitial:true,awaitWriteFinish:{stabilityThreshold:300,pollInterval:100},ignored:(file)=>{const relative=path.relative(path.join(workspaceRoot,'papers'),file); const parts=relative.split(path.sep); return parts.slice(1).some(part=>part.startsWith('.') || ['build','submissions'].includes(part));}});
  watcher?.on('all',(event,file)=>{ if (!['add','change','unlink'].includes(event)) return; const relative=path.relative(path.join(workspaceRoot,'papers'),file).split(path.sep); if (relative.length<2) return; const [id,...parts]=relative; if(parts.join('/')==='project.json') emit({type:'project.changed',projectId:id}); else fileChanged(id,parts.join('/')); });
  app.addHook('preClose',async()=>{ for(const client of clients) client.end(); clients.clear(); await watcher?.close(); });
  app.addHook('onClose',async()=>{ await presentations.close();await workspace.close();await agents.close(); await builds.close(); });
  // Do not advertise a ready service while ignoreInitial is still scanning:
  // a project created in that window can otherwise swallow its first edit.
  if (watcher) await new Promise<void>((resolve, reject) => {
    const ready = () => { watcher.off('error', failed); resolve(); };
    const failed = (error: unknown) => { watcher.off('ready', ready); reject(error); };
    watcher.once('ready', ready); watcher.once('error', failed);
  });
  return app;
}
const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const app=await createApp();
  const port=Number(process.env.WORKBENCH_PORT ?? 4173); if (!Number.isInteger(port) || port<1024 || port>65535) throw new Error('WORKBENCH_PORT must be between 1024 and 65535');
  await app.listen({host:'127.0.0.1',port});
  console.log(`Paper Workbench http://127.0.0.1:${port}`);
  for(const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>void app.close().then(()=>process.exit(0)));
}
