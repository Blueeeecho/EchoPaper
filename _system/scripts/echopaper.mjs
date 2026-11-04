#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {randomUUID} from 'node:crypto';

const defaultWorkspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const help = `EchoPaper 本地接口命令行（默认输出 JSON）

用法：node _system/scripts/echopaper.mjs [全局选项] <命令>
或：  npm --prefix _system run cli -- <命令>

命令：
  help                                      查看用法
  status                                    检查当前工作区的本机服务
  projects                                  列出文章
  project <项目ID>                          读取单篇文章与配置版本 updatedAt
  conferences <搜索词> [--refresh]           搜索会议年份与轮次，不自动选择
  conferences selection <会议ID> <轮次ID>    读取可保存的标准 selection JSON
  deadline get <项目ID>                     读取截止时间、时区、来源与版本
  deadline set <项目ID> --selection <JSON文件>
                [--expected-updated-at <ISO时间>]
  deadline clear <项目ID> [--expected-updated-at <ISO时间>]
  file read <项目ID> <项目内相对路径>         读取 content 与 hash
  file write <项目ID> <路径> --input <UTF8文件> --expected-hash <SHA256|null>
  compile <项目ID> <目标ID> [--wait]          编译已保存的冻结源码；可等待结果
  ai config                                 读取助手用途配置（无密钥）
  chat list <项目ID>                         读取对话、归档、回收站及 hash
  chat archive|delete|restore <项目ID> <对话ID> --expected-hash <SHA256>
  task list <项目ID>                         列出持久任务
  task get <项目ID> <任务ID>                  读取步骤、工具与变更集
  task start <项目ID> --input <JSON文件> [--wait]
  task cancel|resume|undo <项目ID> <任务ID>   停止、恢复或安全撤销
  task decide <项目ID> <任务ID> --input <JSON文件>

  workspace overview                       读取学术工作区总览
  topics list | create --input <JSON文件> | update <ID> --input <JSON文件>
  roots list | connect --input <JSON文件> | update <ID> --input <JSON文件> | scan <ID>
  resources search [搜索词] | get <ID> | tag <ID> --input <JSON文件>
  resources relink <ID> --input <JSON文件>   重新关联缺失资料，保留原 ID
  organize list | apply --input <JSON文件> | undo <操作ID>
  presentations list | create --input <JSON文件> | get <ID>
  presentations save <ID> --input <JSON文件> [--expected-hash <SHA256>]
  presentations sources <ID> [--input <JSON文件>]
  presentations remove-source <ID> <材料ID> --input <JSON文件>
  presentations outline|export <ID> --input <JSON文件> [--wait]
  presentations rewrite <ID> <页面ID> --input <JSON文件> [--wait]
  presentations jobs <ID> | job <ID> <任务ID> | cancel <ID> <任务ID>
  styles list                              读取可用版本化演示样式

全局选项：
  --workspace <完整工作区路径>               默认使用此脚本所属工作区
  --port <1024..65535>                        指定本机端口，仍核验工作区身份
  --timeout <毫秒>                           单次请求超时，默认 15000，最大 300000
  --wait-timeout <秒>                        --wait 总时限，默认 960，最大 3600

安全约定：只连接 127.0.0.1；不读取或输出钥匙串密钥。
文件写入必须显式携带 hash，新文件使用 null。配置写入携带项目 updatedAt，409 不自动覆盖。
学术接口写入使用 UTF-8 JSON 对象；元数据修改携带 expectedRevision，演示修改携带 expectedHash。
错误为 stderr JSON 且退出非零；等待中的编译或演示任务失败、取消亦为非零。`;
class CliError extends Error { constructor(message, code = 'ECLI', status, details) { super(message); this.code=code; this.status=status; this.details=details; } }
const usage = message => { throw new CliError(`${message}；使用 help 查看用法。`,'EUSAGE'); };
const optionsWithValue = new Set(['workspace','port','timeout','wait-timeout','selection','expected-updated-at','input','expected-hash']);
const flags = new Set(['refresh','wait','help']);
const academicShapes={
  workspace:{overview:{count:1}},
  topics:{list:{count:1},create:{count:1,input:'required'},update:{count:2,input:'required'}},
  roots:{list:{count:1},connect:{count:1,input:'required'},update:{count:2,input:'required'},scan:{count:2}},
  resources:{search:{count:[1,2]},get:{count:2},tag:{count:2,input:'required'},relink:{count:2,input:'required'}},
  organize:{list:{count:1},apply:{count:1,input:'required',hash:true},undo:{count:2}},
  presentations:{list:{count:1},create:{count:1,input:'required'},get:{count:2},save:{count:2,input:'required',hash:true},sources:{count:2,input:'optional',hash:true},'remove-source':{count:3,input:'hash',hash:true},outline:{count:2,input:'hash',hash:true,wait:true},export:{count:2,input:'hash',hash:true,wait:true},jobs:{count:2},job:{count:3},cancel:{count:3},rewrite:{count:3,input:'required',hash:true,wait:true}},
  styles:{list:{count:1}}
};
function academicShape(command,rest,options){
  if(!Object.hasOwn(academicShapes[command],rest[0]))usage(`未知 ${command} 子命令`);const shape=academicShapes[command][rest[0]],counts=Array.isArray(shape.count)?shape.count:[shape.count];if(!counts.includes(rest.length))usage(`${command} 的参数数量不正确`);
  if(options.input&&!shape.input)usage('此子命令不接受 --input');if(options['expected-hash']!==undefined&&!shape.hash)usage('此子命令不接受 --expected-hash');if(options.wait&&!shape.wait)usage('此子命令不支持 --wait');
  if(shape.input==='required'&&!options.input)usage('此写入需要 --input JSON文件');if(shape.input==='hash'&&!options.input&&!options['expected-hash'])usage('此操作需要 --input JSON文件或 --expected-hash');if(shape.input==='optional'&&!options.input&&options['expected-hash'])usage('添加材料需要 --input JSON文件');
  if(command==='resources'&&rest[0]==='search'){if((rest[1]||'').length>1000)usage('资源搜索词最多 1000 字符');}else for(const value of rest.slice(1))id(value);
  return shape;
}
function parse(args) {
  const positionals=[], options={};
  for(let i=0;i<args.length;i++) {
    const value=args[i];
    if(value==='-h'){options.help=true;continue;}
    if(value.startsWith('--')) {
      const name=value.slice(2);if(options[name]!==undefined)usage(`选项 --${name} 重复`);
      if(flags.has(name)){options[name]=true;continue;}
      if(!optionsWithValue.has(name))usage(`未知选项 --${name}`);
      const next=args[++i];if(next===undefined||next.startsWith('--'))usage(`--${name} 缺少参数`);options[name]=next;
    }else positionals.push(value);
  }
  const command=positionals[0]||'help', rest=positionals.slice(1);
  const allowed=new Set(['help','status','projects','project','conferences','deadline','file','compile','ai','chat','task',...Object.keys(academicShapes)]);if(!allowed.has(command))usage(`未知命令 ${command}`);
  const permitted=new Set(['workspace','port','timeout','wait-timeout','help']);
  if(command==='conferences')permitted.add('refresh');
  if(command==='deadline'){permitted.add('selection');permitted.add('expected-updated-at');}
  if(command==='file'){permitted.add('input');permitted.add('expected-hash');}
  if(command==='compile')permitted.add('wait');
  if(command==='task'){permitted.add('input');permitted.add('wait');}
  if(command==='chat')permitted.add('expected-hash');
  if(Object.hasOwn(academicShapes,command)){permitted.add('input');permitted.add('expected-hash');permitted.add('wait');}
  for(const name of Object.keys(options))if(!permitted.has(name))usage(`此命令不支持 --${name}`);
  function count(n){if(rest.length!==n)usage(`${command} 的参数数量不正确`);}
  if(!options.help) {
    if(['help','status','projects'].includes(command))count(0);
    if(command==='project')count(1);
    if(command==='conferences'){if(rest[0]==='selection'){count(3);if(options.refresh)usage('selection 不接受 --refresh，请先刷新会议查询');}else count(1);}
    if(command==='deadline'){count(2);if(!['get','set','clear'].includes(rest[0]))usage('deadline 子命令应为 get/set/clear');if(rest[0]==='set'&&!options.selection)usage('deadline set 必须提供 --selection');if(rest[0]!=='set'&&options.selection)usage('此 deadline 子命令不接受 --selection');if(rest[0]==='get'&&options['expected-updated-at'])usage('deadline get 不接受写入版本参数');}
    if(command==='file'){count(3);if(!['read','write'].includes(rest[0]))usage('file 子命令应为 read/write');if(rest[0]==='write'&&(!options.input||options['expected-hash']===undefined))usage('file write 必须提供 --input 和 --expected-hash（新文件用 null）');if(rest[0]==='read'&&(options.input||options['expected-hash']))usage('file read 不接受写入选项');}
    if(command==='compile')count(2);
    if(command==='ai'){count(1);if(rest[0]!=='config')usage('ai 子命令应为 config');}
    if(command==='chat'){if(!['list','archive','delete','restore'].includes(rest[0]))usage('chat 子命令应为 list/archive/delete/restore');count(rest[0]==='list'?2:3);if(rest[0]==='list'&&options['expected-hash']!==undefined)usage('chat list 不接受写入版本参数');if(rest[0]!=='list'&&!/^[a-f0-9]{64}$/.test(options['expected-hash']||''))usage('修改对话需要 chat list 返回的 --expected-hash');}
    if(command==='task'){if(!['list','get','start','cancel','resume','decide','undo'].includes(rest[0]))usage('未知 task 子命令');count(['list','start'].includes(rest[0])?2:3);if(['start','decide'].includes(rest[0])&&!options.input)usage('task start/decide 需要 --input JSON文件');if(!['start','decide'].includes(rest[0])&&options.input)usage('此 task 子命令不接受 --input');if(rest[0]!=='start'&&options.wait)usage('只有 task start 支持 --wait');}
    if(Object.hasOwn(academicShapes,command))academicShape(command,rest,options);
  }
  function integer(name,fallback,min,max){const raw=options[name];if(raw===undefined)return fallback;if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||+raw<min||+raw>max)usage(`--${name} 应为 ${min}..${max} 的整数`);return +raw;}
  return {command,rest,options,workspace:path.resolve(options.workspace||defaultWorkspace),port:integer('port',undefined,1024,65535),timeout:integer('timeout',15000,100,300000),waitTimeout:integer('wait-timeout',960,1,3600)};
}
function id(value){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value))usage('项目或目标 ID 格式无效');return encodeURIComponent(value);}
function relative(value){if(typeof value!=='string'||!value||value.startsWith('/')||/^[A-Za-z]:/.test(value)||value.includes('\\')||/[\x00-\x1f]/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'))usage('文件路径必须是项目内相对路径');return value;}
async function inputFile(filename,maximum){let bytes;try{const stat=await fs.stat(filename);if(!stat.isFile()||stat.size>maximum)throw new Error('not a bounded regular file');bytes=await fs.readFile(filename);}catch{throw new CliError('无法读取输入文件，或文件超过大小上限。','EINPUT');}try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new CliError('输入文件不是有效 UTF-8，未发送任何写入。','EINPUT');}}
async function request(base,endpoint,timeout,{method='GET',data}={}) {
  let response;
  try { response=await fetch(`${base}${endpoint}`,{method,headers:data!==undefined?{'content-type':'application/json'}:undefined,body:data!==undefined?JSON.stringify(data):undefined,signal:AbortSignal.timeout(timeout)}); }
  catch(e){throw new CliError(e?.name==='TimeoutError'?'本机接口请求超时。':'无法连接本机工作台服务。','ENETWORK');}
  const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>24*1024*1024)throw new CliError('接口响应超过 CLI 大小上限。','ERESPONSE');
  let raw;try{raw=await response.text();}catch{throw new CliError('读取接口响应时连接中断或超时。','ENETWORK');}if(raw.length>24*1024*1024)throw new CliError('接口响应超过 CLI 大小上限。','ERESPONSE');let result;try{result=JSON.parse(raw);}catch{throw new CliError('本机接口未返回有效 JSON。','ERESPONSE',response.status);}
  if(!response.ok)throw new CliError(typeof result.error==='string'?result.error:`接口返回 ${response.status}` ,response.status===409?'ECONFLICT':'EHTTP',response.status,result);
  return result;
}
async function connect(config) {
  const candidates=[];
  if(config.port)candidates.push(config.port);
  else {try{const state=JSON.parse(await fs.readFile(path.join(config.workspace,'_system/runtime/instance.json'),'utf8'));if(Number.isSafeInteger(state.port)&&state.port>=1024&&state.port<=65535)candidates.push(state.port);}catch{}}
  const probe=async port=>{try{const base=`http://127.0.0.1:${port}`,health=await request(base,'/api/health',Math.min(config.timeout,1200));if(health.ok&&health.workspaceRoot===config.workspace)return {base,health};if(config.port&&health.ok)throw new CliError('此端口属于其他工作区，已拒绝操作。','EWORKSPACE');}catch(error){if(error.code==='EWORKSPACE')throw error;}return null;};
  for(const port of candidates){const found=await probe(port);if(found)return found;}
  if(!config.port){const ports=Array.from({length:31},(_,i)=>4173+i).filter(p=>!candidates.includes(p));const found=(await Promise.all(ports.map(probe))).find(Boolean);if(found)return found;}
  throw new CliError('未找到此工作区的 EchoPaper 服务，请先启动工作台。','EOFFLINE');
}
function selectionPayload(value) {
  const raw=value?.selection??value;
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.venue!=='string'||!raw.venue.trim()||typeof raw.deadlineAt!=='string'||typeof raw.deadlineTimezone!=='string'||!raw.deadlineSource||typeof raw.deadlineSource!=='object'||Array.isArray(raw.deadlineSource))throw new CliError('selection 需要 venue、UTC deadlineAt、IANA deadlineTimezone 和 deadlineSource。请采用会议 selection 接口返回的数据。','EINPUT');
  return {venue:raw.venue,deadlineAt:raw.deadlineAt,deadlineTimezone:raw.deadlineTimezone,deadlineSource:raw.deadlineSource};
}
async function academicInput(config){
  const {command,rest,options}=config,action=rest[0];let data;
  if(options.input){try{data=JSON.parse(await inputFile(options.input,12*1024*1024));}catch(error){if(error instanceof CliError)throw error;throw new CliError('学术接口输入不是有效 JSON。','EINPUT');}if(!data||typeof data!=='object'||Array.isArray(data))throw new CliError('学术接口输入必须是 JSON 对象。','EINPUT');}
  const invalid=message=>{throw new CliError(message,'EINPUT');},requiredString=(key,value=data?.[key])=>{if(typeof value!=='string'||!value.trim())invalid(`输入需要有效 ${key}。`);return value;},requiredRevision=()=>{if(!Number.isSafeInteger(data?.expectedRevision)||data.expectedRevision<1)invalid('输入需要读取时的 expectedRevision。');},requiredHash=()=>{if(!/^[a-f0-9]{64}$/.test(data?.expectedHash||''))invalid('输入需要读取时的 SHA256 expectedHash。');};
  if(options['expected-hash']!==undefined){const flag=options['expected-hash'],expected=command==='organize'&&action==='apply'&&data?.kind==='create-file'&&flag==='null'?null:flag;if(expected!==null&&!/^[a-f0-9]{64}$/.test(expected))usage('--expected-hash 应为 SHA256；新建文件使用 null');if(data?.expectedHash!==undefined&&data.expectedHash!==expected)invalid('JSON expectedHash 与 --expected-hash 不一致，未发送写入。');data={...data,expectedHash:expected};}
  if(command==='topics'&&action==='create')requiredString('title');
  if((command==='topics'||command==='roots')&&action==='update')requiredRevision();
  if(command==='roots'&&action==='connect'){const directory=requiredString('path');if(!path.isAbsolute(directory)||directory.includes('\0'))invalid('来源 path 必须是完整的本地目录路径。');}
  if(command==='roots'&&data?.permission!==undefined&&!['read','write'].includes(data.permission))invalid('来源 permission 应为 read 或 write。');
  if(command==='resources'&&['tag','relink'].includes(action)){requiredRevision();if(action==='tag'&&(!Array.isArray(data.tags)||data.tags.some(tag=>typeof tag!=='string'||!tag.trim())))invalid('标签输入需要 tags 字符串列表。');if(action==='relink'){id(requiredString('rootId'));relative(requiredString('path'));}}
  if(command==='organize'&&action==='apply'){
    if(!['mkdir','create-file','move','trash'].includes(data.kind))invalid('文件操作 kind 应为 mkdir/create-file/move/trash。');id(requiredString('rootId'));
    if(data.kind==='mkdir'||data.kind==='create-file'){relative(requiredString('path'));if(data.kind==='mkdir'&&options['expected-hash']!==undefined)usage('mkdir 不接受 --expected-hash');if(data.kind==='create-file'){if(data.expectedHash!==null)invalid('新建文件需要明确 expectedHash:null。');if(typeof data.content!=='string'||data.content.includes('\0')||Buffer.from(data.content,'utf8').toString('utf8')!==data.content||Buffer.byteLength(data.content,'utf8')>3*1024*1024)invalid('新建文件需要 3 MB 以内的有效 UTF-8 content，可为空。');}}
    else{requiredRevision();requiredHash();id(requiredString('resourceId'));if(data.kind==='move'){relative(requiredString('destinationPath'));if(data.destinationRootId!==undefined)id(requiredString('destinationRootId'));}}
  }
  if(command==='presentations'){
    if(action==='create')requiredString('title');
    if(['save','remove-source','outline','export','rewrite'].includes(action)||action==='sources'&&data)requiredHash();
    if(action==='save'&&(!data.document||typeof data.document!=='object'||Array.isArray(data.document)))invalid('保存演示文稿需要完整 document 对象。');
    if(action==='sources'&&data){const kinds=['text','paperId','resourceId'].filter(key=>data[key]!==undefined);if(kinds.length!==1)invalid('材料应明确提供 text、paperId、resourceId 中的一项。');requiredString(kinds[0]);if(kinds[0]!=='text')id(data[kinds[0]]);}
    if(action==='rewrite'){const instruction=requiredString('instruction');if(instruction.length>10000)invalid('页面修改要求不能超过 10000 字符。');}
  }
  return data;
}
async function academicCommand(config,api,data){
  const {command,rest,options}=config,action=rest[0],workspace='/api/workspace',presentation=command==='presentations'&&rest[1]?`/api/presentations/${id(rest[1])}`:'/api/presentations';let endpoint,method='GET';
  if(command==='workspace')endpoint=`${workspace}/overview`;
  if(command==='topics'){endpoint=`${workspace}/topics${action==='update'?'/'+id(rest[1]):''}`;if(action!=='list')method=action==='create'?'POST':'PATCH';}
  if(command==='roots'){endpoint=`${workspace}/roots${['update','scan'].includes(action)?'/'+id(rest[1]):''}${action==='scan'?'/scan':''}`;if(action!=='list')method=action==='update'?'PATCH':'POST';}
  if(command==='resources'){endpoint=`${workspace}/resources${action==='search'?(rest[1]?'?'+new URLSearchParams({q:rest[1]}):''):'/'+id(rest[1])}${action==='relink'?'/relink':''}`;if(action==='tag')method='PATCH';if(action==='relink')method='POST';}
  if(command==='organize'){endpoint=`${workspace}/operations${action==='undo'?'/'+id(rest[1])+'/undo':''}`;if(action!=='list')method='POST';}
  if(command==='styles')endpoint='/api/presentation-styles';
  if(command==='presentations'){
    endpoint=presentation;
    if(action==='create')method='POST';if(action==='save')method='PUT';
    if(action==='sources'){if(!data){const file=await api(presentation);return{sources:file.document.sources,hash:file.hash};}endpoint+='/sources';method='POST';}
    if(action==='remove-source'){endpoint+='/sources/'+id(rest[2]);method='DELETE';}
    if(['outline','export'].includes(action)){endpoint+='/'+action;method='POST';}
    if(action==='rewrite'){endpoint+='/slides/'+id(rest[2])+'/regenerate';method='POST';}
    if(action==='jobs')endpoint+='/jobs';if(['job','cancel'].includes(action))endpoint+='/jobs/'+id(rest[2])+(action==='cancel'?'/cancel':'');if(action==='cancel')method='POST';
  }
  let result=await api(endpoint,{method,...(method!=='GET'?{data:data||{}}:{})});
  if(command==='presentations'&&options.wait){
    if(typeof result.id!=='string')throw new CliError('演示任务接口没有返回任务 ID。','ERESPONSE');const jobId=result.id,presentationId=rest[1],until=Date.now()+config.waitTimeout*1000;
    while(['queued','running'].includes(result.status)){
      if(Date.now()>=until)throw new CliError('等待演示任务超时；任务仍保留在后台，可继续查询或取消。','EWAIT',undefined,{presentationId,jobId,status:result.status});
      await new Promise(resolve=>setTimeout(resolve,750));try{result=await api(`${presentation}/jobs/${id(jobId)}`);}catch(error){if(error instanceof CliError)error.details={...error.details,presentationId,jobId};throw error;}
    }
    if(result.status!=='succeeded')throw new CliError('演示任务未成功完成，请检查保留的任务与诊断。','EPRESENTATION',undefined,{presentationId,jobId,job:result});
  }
  return result;
}
async function main(args) {
  const config=parse(args),{command,rest,options}=config;
  if(command==='help'||options.help){process.stdout.write(help+'\n');return;}
  // Validate local input before contacting any service.
  let fileContent,selection,taskInput,academicPayload;
  if(Object.hasOwn(academicShapes,command))academicPayload=await academicInput(config);
  if(command==='chat'){id(rest[1]);if(rest[0]!=='list'&&(!rest[2].length||rest[2].length>100||/[\x00-\x1f]/.test(rest[2])))usage('对话 ID 格式无效');}
  if(command==='task'){id(rest[1]);if(rest[2])id(rest[2]);if(options.input){try{taskInput=JSON.parse(await inputFile(options.input,4*1024*1024));}catch(e){if(e instanceof CliError)throw e;throw new CliError('任务输入不是有效 JSON。','EINPUT');}if(!taskInput||typeof taskInput!=='object'||Array.isArray(taskInput))throw new CliError('任务输入必须是 JSON 对象。','EINPUT');if(rest[0]==='start'){if(typeof taskInput.input!=='string'||!taskInput.input.trim()||typeof taskInput.targetId!=='string')throw new CliError('任务需要 input 和 targetId。','EINPUT');taskInput={...taskInput,requestId:taskInput.requestId||randomUUID()};}}}
  if(command==='file'){id(rest[1]);relative(rest[2]);if(rest[0]==='write'){if(options['expected-hash']!=='null'&&!/^[a-f0-9]{64}$/.test(options['expected-hash']))usage('--expected-hash 应为 SHA256 或 null');fileContent=await inputFile(options.input,3*1024*1024);if(fileContent.includes('\0'))throw new CliError('文本写入不接受二进制 NUL；请使用文件上传接口。','EINPUT');}}
  if(command==='deadline'){id(rest[1]);if(options['expected-updated-at']&&(!Number.isFinite(Date.parse(options['expected-updated-at']))))usage('--expected-updated-at 应为项目返回的 ISO 时间');if(rest[0]==='set'){let value;try{value=JSON.parse(await inputFile(options.selection,1024*1024));}catch(error){if(error instanceof CliError)throw error;throw new CliError('selection 文件不是有效 JSON。','EINPUT');}selection=selectionPayload(value);}}
  if(command==='project')id(rest[0]);if(command==='compile'){id(rest[0]);id(rest[1]);}
  if(command==='conferences'&&rest[0]!=='selection'&&rest[0].length>100)usage('会议搜索词最多 100 字符');
  const {base,health}=await connect(config),api=(endpoint,opts)=>request(base,endpoint,config.timeout,opts);
  let result;
  if(Object.hasOwn(academicShapes,command))result=await academicCommand(config,api,academicPayload);
  if(command==='status')result={...health,url:base};
  if(command==='projects')result=await api('/api/projects');
  if(command==='ai')result=await api('/api/ai/config');
  if(command==='chat'){const root=`/api/projects/${id(rest[1])}/chats`;result=rest[0]==='list'?await api(root):await api(`${root}/${encodeURIComponent(rest[2])}`,{method:'PATCH',data:{action:rest[0],expectedHash:options['expected-hash']}});}
  if(command==='task'){
    const root=`/api/projects/${id(rest[1])}/agent-runs`;
    if(rest[0]==='list')result=await api(root);
    else if(rest[0]==='get')result=await api(`${root}/${id(rest[2])}`);
    else if(rest[0]==='start'){
      result=await api(root,{method:'POST',data:taskInput});
      if(options.wait){let run=result.run||result;const until=Date.now()+config.waitTimeout*1000;while(['queued','running','cancelling'].includes(run.status)){if(Date.now()>=until)throw new CliError('等待任务超时；任务仍在后台执行。','EWAIT',undefined,{runId:run.id});await new Promise(r=>setTimeout(r,750));result=await api(`${root}/${encodeURIComponent(run.id)}`);run=result.run||result;}if(run.status!=='completed')throw new CliError('任务尚未完成，请查看状态和保留的修改。','EAGENT',undefined,{run});}
    }else result=await api(`${root}/${id(rest[2])}/${rest[0]==='decide'?'decisions':rest[0]}`,{method:'POST',data:rest[0]==='decide'?taskInput:{}});
  }
  if(command==='project')result=await api(`/api/projects/${id(rest[0])}`);
  if(command==='conferences')result=rest[0]==='selection'?await api(`/api/conferences/selection?${new URLSearchParams({conferenceId:rest[1],roundId:rest[2]})}`):await api(`/api/conferences?${new URLSearchParams({q:rest[0],...(options.refresh?{refresh:'1'}:{})})}`);
  if(command==='deadline') {
    const project=await api(`/api/projects/${id(rest[1])}`);
    if(rest[0]==='get')result={projectId:project.id,venue:project.venue,deadline:project.deadline,deadlineAt:project.deadlineAt??null,deadlineTimezone:project.deadlineTimezone??null,deadlineSource:project.deadlineSource??null,updatedAt:project.updatedAt};
    else {
      const expectedUpdatedAt=options['expected-updated-at']||project.updatedAt;
      if(typeof expectedUpdatedAt!=='string')throw new CliError('项目接口没有提供配置版本，已拒绝写入。','ERESPONSE');
      result=await api(`/api/projects/${id(rest[1])}`,{method:'PATCH',data:{...(rest[0]==='set'?selection:{deadlineAt:'',deadlineTimezone:'',deadlineSource:null}),expectedUpdatedAt}});
    }
  }
  if(command==='file')result=rest[0]==='read'?await api(`/api/projects/${id(rest[1])}/file?${new URLSearchParams({path:rest[2]})}`):await api(`/api/projects/${id(rest[1])}/file`,{method:'PUT',data:{path:rest[2],content:fileContent,expectedHash:options['expected-hash']==='null'?null:options['expected-hash']}});
  if(command==='compile') {
    result=await api(`/api/projects/${id(rest[0])}/builds`,{method:'POST',data:{targetId:rest[1]}});
    if(options.wait) {
      const until=Date.now()+config.waitTimeout*1000;
      while(['queued','running'].includes(result.status)) {
        if(Date.now()>=until)throw new CliError('等待编译超时；后台任务仍可继续，未取消构建。','EWAIT',undefined,{buildId:result.id,status:result.status});
        await new Promise(resolve=>setTimeout(resolve,750));result=await api(`/api/builds/${encodeURIComponent(result.id)}`);
      }
      if(result.status!=='succeeded')throw new CliError(`编译${result.status==='cancelled'?'已取消':'失败'}，请查看返回的诊断。`,'EBUILD',undefined,{build:result});
    }
  }
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
main(process.argv.slice(2)).catch(error=>{const known=error instanceof CliError;process.stderr.write(JSON.stringify({error:known?error.message:'CLI 操作失败。',code:known?error.code:'ECLI',...(known&&error.status?{status:error.status}:{}),...(known&&error.details?{details:error.details}:{})})+'\n');process.exitCode=known&&error.code==='EUSAGE'?2:1;});
