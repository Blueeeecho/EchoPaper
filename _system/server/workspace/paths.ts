import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {HttpError,relativePath} from '../security.ts';
import type {SourceRoot} from '../../shared/workspace-types.ts';

export const trashName='.echopaper-trash';
const NOFOLLOW=constants.O_NOFOLLOW??0;
const isoMtime=(stat:{mtimeNs:bigint})=>new Date(Number(stat.mtimeNs/1_000_000n)+(stat.mtimeNs%1_000_000n>=500_000n?1:0)).toISOString();
const normFsPath=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
export const sameFsPath=(a:string,b:string)=>normFsPath(a)===normFsPath(b);
export const contains=(parent:string,child:string)=>{
  const p=normFsPath(parent),c=normFsPath(child);
  if(c===p)return true;
  const prefix=p.endsWith(path.sep)?p:p+path.sep;
  return c.startsWith(prefix);
};
export const overlaps=(a:string,b:string)=>contains(a,b)||contains(b,a);
export function resourcePath(value:unknown){
  const relative=relativePath(value),parts=relative.split('/');
  if(parts.some(part=>part.startsWith('.')))throw new HttpError(403,'隐藏目录和回收区不通过文件管理器直接访问。');
  if(process.platform==='win32'){
    const reserved=/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³]) *(?:\.|$)/i;
    for(const part of parts){
      if(part.length>255)throw new HttpError(400,'Windows 文件或文件夹名过长，请缩短名称。');
      if(/[<>:"|?*\x00-\x1f]/.test(part)||/[ .]$/.test(part)||reserved.test(part))throw new HttpError(400,'Windows 不支持此文件或文件夹名称。请避开保留名称、特殊字符以及末尾的空格或句点。');
    }
  }
  return relative;
}
export function protectedPath(workspaceRoot:string,candidate:string){
  const noteParts=path.relative(path.join(workspaceRoot,'workspace','research-notes'),candidate).split(path.sep);
  const managedNotes=noteParts.length>=2&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(noteParts[0])&&['课题笔记','方案与实验','结果与证据'].includes(noteParts[1])&&noteParts.slice(2).every(part=>!!part&&!part.startsWith('.'));
  if(managedNotes)return false;
  return ['papers','_system','shared','workspace','build','submissions','backups','archive'].some(name=>overlaps(path.join(workspaceRoot,name),candidate));
}
export async function canonicalRoot(workspaceRoot:string,value:unknown){
  if(typeof value!=='string'||!path.isAbsolute(value)||value.includes('\0')||value.length>4096)throw new HttpError(400,'来源目录必须是有效的绝对路径。');
  const resolved=path.resolve(value);if(protectedPath(workspaceRoot,resolved))throw new HttpError(403,'来源目录与工作台管理目录重叠；请选择独立的原始资料目录。');
  function connectionError(error:NodeJS.ErrnoException):never {
    if(error.code==='ENOENT')throw new HttpError(404,'来源目录不存在，请确认文件夹位置。');
    if(error.code==='ENOTDIR')throw new HttpError(400,'路径中的一部分是文件，请选择实际的文件夹。');
    return fileError(error);
  }
  const stat=await fs.lstat(resolved).catch(connectionError);
  if(stat.isSymbolicLink())throw new HttpError(403,'来源目录不能是符号链接，请选择原文件夹。');
  if(!stat.isDirectory())throw new HttpError(400,'连接位置需要选择文件夹。要导入单篇 PDF，请将文件拖入资料库。');
  const canonical=await fs.realpath(resolved).catch(connectionError);
  if(!sameFsPath(canonical,resolved))throw new HttpError(403,'来源路径不能经过符号链接。');
  if(protectedPath(workspaceRoot,canonical))throw new HttpError(403,'来源目录与工作台管理目录重叠。');return canonical;
}
export async function rootFile(workspaceRoot:string,root:SourceRoot,relative:string,options:{missing?:boolean;internal?:boolean}={}){
  if(protectedPath(workspaceRoot,root.path))throw new HttpError(403,'来源目录与工作台管理目录重叠。');
  const rel=relative?(options.internal?relativePath(relative):resourcePath(relative)):'';
  const stat=await fs.lstat(root.path).catch(error=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')throw new HttpError(503,'来源目录离线，文件和索引仍保留。',undefined,true);return fileError(error);});
  if(stat.isSymbolicLink())throw new HttpError(403,'来源目录不能经过符号链接。');
  if(!stat.isDirectory())throw new HttpError(503,'原资料目录已被文件替代，请恢复文件夹或重新定位资料。',undefined,true);
  if(!sameFsPath(await fs.realpath(root.path).catch(fileError),root.path))throw new HttpError(403,'来源目录不能经过符号链接。');
  let cursor=root.path;for(const part of rel.split('/').filter(Boolean)){
    cursor=path.join(cursor,part);const item=await fs.lstat(cursor).catch(error=>{if(error.code==='ENOENT'&&options.missing)return null;if(error.code==='ENOENT')throw new HttpError(404,'资源文件不存在。');if(error.code==='ENOTDIR')throw new HttpError(400,'路径中的一部分是文件，请选择实际的文件夹。');return fileError(error);});
    if(item?.isSymbolicLink())throw new HttpError(403,'不允许通过符号链接访问资源。');
  }return cursor;
}
export interface Tree {kind:'file'|'directory';hash:string;size:number;modifiedAt:string;mode:number;children?:Map<string,Tree>}
interface FileStatHash {dev:bigint;ino:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint;hash:string;modifiedAt:string;mode:number}
const statHashCache=new Map<string,FileStatHash>();
function rememberStatHash(filename:string,entry:FileStatHash){
  statHashCache.delete(filename);
  statHashCache.set(filename,entry);
  if(statHashCache.size>10000)statHashCache.delete(statHashCache.keys().next().value!);
}
const sameSignature=(a:Pick<FileStatHash,'dev'|'ino'|'size'|'mtimeNs'|'ctimeNs'>,b:Pick<FileStatHash,'dev'|'ino'|'size'|'mtimeNs'|'ctimeNs'>)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
export async function fastFileSnapshot(filename:string):Promise<Tree>{
  const stat=await fs.lstat(filename,{bigint:true});
  if(stat.isSymbolicLink())throw new HttpError(403,'操作范围包含符号链接，未执行文件操作。');
  if(!stat.isFile())return snapshot(filename);
  const cached=statHashCache.get(filename);
  if(cached&&sameSignature(cached,stat)){
    return {kind:'file',hash:cached.hash,size:Number(stat.size),modifiedAt:cached.modifiedAt,mode:cached.mode};
  }
  return snapshot(filename);
}
export async function snapshot(filename:string):Promise<Tree>{
  const stat=await fs.lstat(filename);if(stat.isSymbolicLink())throw new HttpError(403,'操作范围包含符号链接，未执行文件操作。');
  if(stat.isFile()){
    const handle=await fs.open(filename,constants.O_RDONLY|NOFOLLOW);try{
      const before=await handle.stat({bigint:true});if(!before.isFile())throw new HttpError(403,'仅支持普通文件和目录。');const digest=createHash('sha256');for await(const bytes of handle.createReadStream({autoClose:false}))digest.update(bytes);const after=await handle.stat({bigint:true});const current=await fs.lstat(filename,{bigint:true});if(!sameSignature(before,after)||!sameSignature(after,current))throw new HttpError(409,'读取期间原始文件发生变化，请重新读取后比较。');
      const fileHash=digest.digest('hex'),modifiedAt=isoMtime(after),mode=Number(after.mode&0o777n);
      rememberStatHash(filename,{dev:after.dev,ino:after.ino,size:after.size,mtimeNs:after.mtimeNs,ctimeNs:after.ctimeNs,hash:fileHash,modifiedAt,mode});
      return{kind:'file',hash:fileHash,size:Number(after.size),modifiedAt,mode};
    }finally{await handle.close();}
  }
  if(!stat.isDirectory())throw new HttpError(403,'仅支持普通文件和目录。');
  const children=new Map<string,Tree>();for(const name of (await fs.readdir(filename)).sort())children.set(name,await snapshot(path.join(filename,name)));
  const digest=createHash('sha256');let size=0;for(const[name,item]of children){digest.update(JSON.stringify([name,item.kind,item.hash]));size+=item.size;}
  return{kind:'directory',hash:digest.digest('hex'),size,modifiedAt:stat.mtime.toISOString(),mode:stat.mode&0o777,children};
}
export async function absent(filename:string){try{await fs.lstat(filename);throw new HttpError(409,'目标位置已有内容，双方文件均已保留。');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
export async function copyExclusive(source:string,destination:string,tree:Tree):Promise<void>{
  if(tree.kind==='directory'){
    await fs.mkdir(destination,{mode:tree.mode|0o700});for(const[name,child]of tree.children!)await copyExclusive(path.join(source,name),path.join(destination,name),child);await fs.utimes(destination,new Date(tree.modifiedAt),new Date(tree.modifiedAt));return;
  }
  const input=await fs.open(source,constants.O_RDONLY|NOFOLLOW);let output:Awaited<ReturnType<typeof fs.open>>|undefined;
  try{output=await fs.open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|NOFOLLOW,tree.mode);for await(const chunk of input.createReadStream({autoClose:false})){const bytes=chunk as Buffer;let offset=0;while(offset<bytes.length){const result=await output.write(bytes,offset,bytes.length-offset);offset+=result.bytesWritten;}}await output.sync();await output.utimes(new Date(tree.modifiedAt),new Date(tree.modifiedAt));}
  finally{await Promise.allSettled([input.close(),...(output?[output.close()]:[])]);}
}
/** No recursive rm: unexpected new files keep the source directory recoverable. */
export async function removeVerified(filename:string,tree:Tree):Promise<void>{
  if((await snapshot(filename)).hash!==tree.hash)throw new HttpError(409,'复制后原始内容已变化；两处内容均保留，请比较后处理。');
  async function remove(cursor:string,item:Tree):Promise<void>{
    if(item.kind==='file'){if((await snapshot(cursor)).hash!==item.hash)throw new HttpError(409,'删除原位置前文件发生变化；副本已保留。');await fs.unlink(cursor);return;}
    for(const[name,child]of item.children!)await remove(path.join(cursor,name),child);await fs.rmdir(cursor);
  }await remove(filename,tree);
}
export function fileError(error:unknown):never{
  if(error instanceof HttpError)throw error;const code=(error as NodeJS.ErrnoException).code;
  if(code==='ENAMETOOLONG')throw new HttpError(400,'路径过长，请缩短文件名或选择层级较浅的目录。');
  if(code==='EINVAL')throw new HttpError(400,'系统无法使用此路径，请检查驱动器、目录和文件名。');
  if(code==='EEXIST'||code==='ENOTEMPTY')throw new HttpError(409,'目标位置已存在或发生变化；现有内容均已保留。');
  if(code==='ENOENT'||code==='ENOTDIR')throw new HttpError(409,'操作期间文件或目录发生变化；请重新读取后比较。');
  if(code==='ELOOP')throw new HttpError(403,'不允许通过符号链接操作资源。');
  if(code==='EACCES'||code==='EPERM')throw new HttpError(403,'系统未授予此目录的访问权限。');throw error;
}
