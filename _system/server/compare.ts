import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type{FastifyInstance}from'fastify';
import type{BuildService}from'../shared/types.ts';
import type{BuildComparison}from'../shared/compare-types.ts';
import{HttpError,assertNoSymlinks,relativePath,registeredRoot}from'./security.ts';
const MAX_MANIFEST=8*1024*1024;
async function sourceManifest(root:string,id:string){
 const location=await assertNoSymlinks(root,`build/${id}/source-manifest.json`);
 if((await fs.stat(location)).size>MAX_MANIFEST)throw new HttpError(413,'源码清单过大。');
 let entries:unknown;try{entries=JSON.parse(await fs.readFile(location,'utf8'));}catch(error){if(error instanceof SyntaxError)throw new HttpError(409,'该版本的源码清单损坏。');throw error;}
 if(!Array.isArray(entries)||entries.length>20000)throw new HttpError(409,'该版本的源码清单损坏或超过 20000 个文件。');
 const map=new Map<string,string>();
 for(const entry of entries){
  if(!entry||typeof entry!=='object'||typeof entry.path!=='string'||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256))throw new HttpError(409,'该版本的源码清单损坏。');
  let name:string;try{name=relativePath(entry.path);}catch{throw new HttpError(409,'源码清单包含无效路径。');}
  if(map.has(name)||name.split('/').some(part=>part.startsWith('.')))throw new HttpError(409,'源码清单含重复或隐藏文件路径。');
  map.set(name,entry.sha256);
 }
 return map;
}
export async function registerCompareRoutes(app:FastifyInstance,workspaceRoot:string,builds:BuildService){
 app.get<{Params:{id:string};Querystring:{left?:string;right?:string;file?:string}}>('/api/projects/:id/compare',async request=>{
  const{left,right,file}=request.query;if(!left||!right||![left,right].every(v=>/^[A-Za-z0-9_-]{1,100}$/.test(v)))throw new HttpError(400,'请选择两个编译版本。');
  const root=await registeredRoot(workspaceRoot,request.params.id);const [a,b]=await Promise.all([builds.get(left),builds.get(right)]);
  if([a,b].some(v=>v.projectId!==request.params.id||v.status!=='succeeded'||!v.pdf)||a.targetId!==b.targetId)throw new HttpError(400,'只能比较同一项目、同一目标的成功编译版本。');
  const[am,bm]=await Promise.all([sourceManifest(root,left),sourceManifest(root,right)]);const files:BuildComparison['files']=[];let unchanged=0;
  for(const name of new Set([...am.keys(),...bm.keys()])){const beforeHash=am.get(name),afterHash=bm.get(name);if(beforeHash===afterHash){unchanged++;continue;}files.push({path:name,change:!beforeHash?'added':!afterHash?'removed':'modified',beforeHash,afterHash});}
  const result:BuildComparison={leftId:left,rightId:right,targetId:a.targetId,files:files.sort((x,y)=>x.path.localeCompare(y.path)),unchanged};
  if(file){const name=relativePath(file);if(!am.has(name)&&!bm.has(name))throw new HttpError(404,'该文件不在版本源码清单中。');result.file=name;
   if(!/\.(tex|bib|sty|cls|bst|txt|md|csv|json)$/i.test(name)){result.binary=true;return result;}
   const content=async(id:string,expectedHash:string|undefined)=>{if(!expectedHash)return'';const location=await assertNoSymlinks(root,`build/${id}/source/${name}`);const stat=await fs.stat(location);if(!stat.isFile())throw new HttpError(409,'该版本的源码文件损坏。');if(stat.size>1024*1024)throw new HttpError(413,'文件超过 1 MB，请查看原始快照。');const bytes=await fs.readFile(location);if(createHash('sha256').update(bytes).digest('hex')!==expectedHash)throw new HttpError(409,'快照文件与校验清单不一致，请检查该编译版本。');if(bytes.includes(0))return null;try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}};
   const[before,after]=await Promise.all([content(left,am.get(name)),content(right,bm.get(name))]);if(before===null||after===null){result.binary=true;return result;}result.before=before;result.after=after;
  }
  return result;
 });
}
