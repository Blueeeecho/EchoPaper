import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ReferenceEntry, ReferenceIndex } from '../shared/reference-types.ts';
import { HttpError, assertNoSymlinks, registeredRoot } from './security.ts';
import { listFiles } from './files.ts';

const plain = (value: string) => value.replace(/[{}]/g,'').replace(/\\(?:textit|textbf|emph)\b/g,'').replace(/\s+/g,' ').trim();
function whitespace(text:string,start:number):number {
 let i=start;while(i<text.length){if(/\s/.test(text[i])){i++;continue;}if(text[i]==='%'){const next=text.indexOf('\n',i);i=next<0?text.length:next+1;continue;}break;}return i;
}
function fields(body:string):{values:Record<string,string>;error?:string}{
 const values:Record<string,string>=Object.create(null);let i=0;
 while(i<body.length){
  i=whitespace(body,i);while(body[i]===',')i=whitespace(body,i+1);if(i>=body.length)break;
  const match=/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*/.exec(body.slice(i));if(!match)return{values,error:'字段格式无效'};
  const name=match[1].toLowerCase();if(Object.hasOwn(values,name))return{values,error:`字段 ${name} 重复`};i+=match[0].length;
  const parts:string[]=[];
  for(;;){
   i=whitespace(body,i);if(i>=body.length)return{values,error:`字段 ${name} 缺少值`};
   if(body[i]==='{'){
    const start=++i;let depth=1;
    while(i<body.length&&depth){if(body[i]==='\\'){i+=2;continue;}if(body[i]==='{')depth++;else if(body[i]==='}')depth--;i++;}
    if(depth)return{values,error:`字段 ${name} 大括号未闭合`};parts.push(body.slice(start,i-1));
   }else if(body[i]==='"'){
    const start=++i;let braces=0,closed=false;
    while(i<body.length){const c=body[i];if(c==='\\'){i+=2;continue;}if(c==='{')braces++;else if(c==='}')braces--;if(braces<0)return{values,error:`字段 ${name} 大括号不匹配`};if(c==='"'&&!braces){closed=true;break;}i++;}
    if(!closed)return{values,error:`字段 ${name} 引号未闭合`};parts.push(body.slice(start,i));i++;
   }else{
    const start=i;while(i<body.length&&!/[\s,#]/.test(body[i]))i++;
    const bare=body.slice(start,i);if(!bare||/[{}()="\\]/.test(bare))return{values,error:`字段 ${name} 的值无效`};parts.push(bare);
   }
   i=whitespace(body,i);if(body[i]==='#'){i++;continue;}break;
  }
  values[name]=parts.join('');if(i<body.length&&body[i]!==',')return{values,error:`字段 ${name} 后缺少逗号`};
 }
 return{values};
}
export function parseBibTeX(content:string,file:string):{entries:ReferenceEntry[];warnings:string[]}{
 const entries:ReferenceEntry[]=[],warnings:string[]=[];let cursor=0,accounted=0,line=1;
 while(cursor<content.length){
  if(content[cursor]==='%'){const next=content.indexOf('\n',cursor);cursor=next<0?content.length:next+1;continue;}
  if(content[cursor]!=='@'){cursor++;continue;}
  const match=/^@([A-Za-z]+)\s*([{(])/.exec(content.slice(cursor));if(!match){cursor++;continue;}
  const start=cursor,type=match[1].toLowerCase(),curly=match[2]==='{',baseline=curly?1:0;
  line+=(content.slice(accounted,start).match(/\n/g)||[]).length;accounted=start;const entryLine=line;
  let i=cursor+match[0].length,braces=baseline,quoted=false,closed=false;
  const bodyStart=i;
  while(i<content.length){
   const c=content[i];if(c==='\\'){i+=2;continue;}
   if(c==='%'&&type!=='comment'&&!quoted&&braces===baseline){const next=content.indexOf('\n',i);i=next<0?content.length:next+1;continue;}
   if(c==='"'&&type!=='comment'&&braces===baseline)quoted=!quoted;
   if(c==='{')braces++;
   else if(c==='}'){
    if(braces>baseline)braces--;
    else if(curly&&!quoted){closed=true;break;}
    else {warnings.push(`${file}:${entryLine} BibTeX 大括号不匹配`);return{entries,warnings};}
   }else if(c===')'&&!curly&&!quoted&&braces===0){closed=true;break;}
   i++;
  }
  cursor=i+1;
  if(!closed||quoted||braces!==baseline){warnings.push(`${file}:${entryLine} BibTeX 条目未闭合`);break;}
  if(['comment','preamble','string'].includes(type))continue;
  const body=content.slice(bodyStart,i),comma=body.indexOf(',');if(comma<0){warnings.push(`${file}:${entryLine} BibTeX 缺少引用键或字段分隔符`);continue;}
  const key=body.slice(0,comma).trim();if(!key||/[\s{}(),#=%"\\]/.test(key)){warnings.push(`${file}:${entryLine} 存在无效引用键`);continue;}
  const parsed=fields(body.slice(comma+1));if(parsed.error){warnings.push(`${file}:${entryLine} ${parsed.error}`);continue;}
  const f=parsed.values;entries.push({key,type,title:plain(f.title||''),author:plain(f.author||''),year:plain(f.year||f.date||''),doi:plain(f.doi||''),file,line:entryLine});
  if(entries.length>=20000){warnings.push('文献条目达到 20000 上限，请拆分导入。');break;}
 }
 return{entries,warnings};
}
export async function referenceIndex(root: string): Promise<ReferenceIndex> {
 const result:ReferenceIndex={entries:[],labels:[],warnings:[]};
 for(const entry of await listFiles(root)){
  if(entry.type!=='file'||!(/\.(bib|tex)$/i.test(entry.path))||(entry.size||0)>2*1024*1024)continue;
  if(!entry.path.startsWith('manuscript/')&&!/^reviews\/[^/]+\/response\//.test(entry.path)&&!entry.path.startsWith('literature/'))continue;
  const text=await fs.readFile(await assertNoSymlinks(root,entry.path),'utf8');
  if(entry.path.toLowerCase().endsWith('.bib')){const parsed=parseBibTeX(text,entry.path);const remaining=20000-result.entries.length-result.labels.length;result.entries.push(...parsed.entries.slice(0,remaining));result.warnings.push(...parsed.warnings);}
  else {for(const [line,raw]of text.split('\n').entries()){const code=raw.replace(/(?<!\\)%.*/,'');for(const m of code.matchAll(/\\label\s*\{([^{}]+)\}/g)){if(result.entries.length+result.labels.length>=20000)break;result.labels.push({key:m[1],file:entry.path,line:line+1,context:code.trim().slice(0,180)});}}}
  if(result.entries.length+result.labels.length>=20000){result.warnings.push('条目达到 20000，索引已截断。');break;}
 }
 for(const [name,values]of [['引用键',result.entries],['标签',result.labels]] as const){const counts=new Map<string,number>();for(const v of values)counts.set(v.key,(counts.get(v.key)||0)+1);for(const[k,count]of counts)if(count>1)result.warnings.push(`${name} ${k} 重复 ${count} 次，请核对。`);}
 return result;
}
export async function registerReferenceRoutes(app:FastifyInstance,workspaceRoot:string){
 app.post<{Params:{id:string};Body:{content:unknown}}>('/api/projects/:id/references/validate',async request=>{
 const root=await registeredRoot(workspaceRoot,request.params.id);if(typeof request.body?.content!=='string'||Buffer.byteLength(request.body.content,'utf8')>2*1024*1024)throw new HttpError(400,'BibTeX 内容无效或超过 2 MB。');
 const parsed=parseBibTeX(request.body.content,'导入内容');if(parsed.warnings.length||!parsed.entries.length)throw new HttpError(400,parsed.warnings.join('；')||'未识别到文献条目。');
 const existing=await referenceIndex(root),seen=new Set(existing.entries.map(e=>e.key));for(const e of parsed.entries){if(seen.has(e.key))throw new HttpError(409,`引用键 ${e.key} 重复，未写入。`);seen.add(e.key);}return parsed;
 });
 app.get<{Params:{id:string}}>('/api/projects/:id/references',async request=>referenceIndex(await registeredRoot(workspaceRoot,request.params.id)));}
