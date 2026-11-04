import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {HttpError,relativePath} from '../security.ts';
import type {SourceRoot} from '../../shared/workspace-types.ts';

export const trashName='.echopaper-trash';
export const contains=(parent:string,child:string)=>child===parent||child.startsWith(parent+path.sep);
export const overlaps=(a:string,b:string)=>contains(a,b)||contains(b,a);
export function resourcePath(value:unknown){const relative=relativePath(value);if(relative.split('/').some(part=>part.startsWith('.')))throw new HttpError(403,'隐藏目录和回收区不通过文件管理器直接访问。');return relative;}
export function protectedPath(workspaceRoot:string,candidate:string){return ['papers','_system','shared','workspace','build','submissions','backups','archive'].some(name=>overlaps(path.join(workspaceRoot,name),candidate));}
export async function canonicalRoot(workspaceRoot:string,value:unknown){
  if(typeof value!=='string'||!path.isAbsolute(value)||value.includes('\0')||value.length>4096)throw new HttpError(400,'来源目录必须是有效的绝对路径。');
  const resolved=path.resolve(value);if(protectedPath(workspaceRoot,resolved))throw new HttpError(403,'来源目录与工作台管理目录重叠；请选择独立的原始资料目录。');
  const stat=await fs.lstat(resolved).catch(error=>{if(error.code==='ENOENT')throw new HttpError(404,'来源目录不存在。');throw error;});
  if(stat.isSymbolicLink()||!stat.isDirectory())throw new HttpError(403,'来源必须是实际目录，不能是符号链接。');
  const canonical=await fs.realpath(resolved);if(canonical!==resolved)throw new HttpError(403,'来源路径不能经过符号链接。');
  if(protectedPath(workspaceRoot,canonical))throw new HttpError(403,'来源目录与工作台管理目录重叠。');return canonical;
}
export async function rootFile(workspaceRoot:string,root:SourceRoot,relative:string,options:{missing?:boolean;internal?:boolean}={}){
  if(protectedPath(workspaceRoot,root.path))throw new HttpError(403,'来源目录与工作台管理目录重叠。');
  const rel=relative?(options.internal?relativePath(relative):resourcePath(relative)):'';
  const stat=await fs.lstat(root.path).catch(error=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')throw new HttpError(503,'来源目录离线，文件和索引仍保留。');throw error;});
  if(stat.isSymbolicLink()||!stat.isDirectory()||await fs.realpath(root.path)!==root.path)throw new HttpError(403,'来源目录不能经过符号链接。');
  let cursor=root.path;for(const part of rel.split('/').filter(Boolean)){
    cursor=path.join(cursor,part);const item=await fs.lstat(cursor).catch(error=>{if(error.code==='ENOENT'&&options.missing)return null;if(error.code==='ENOENT')throw new HttpError(404,'资源文件不存在。');throw error;});
    if(item?.isSymbolicLink())throw new HttpError(403,'不允许通过符号链接访问资源。');
  }return cursor;
}
export interface Tree {kind:'file'|'directory';hash:string;size:number;modifiedAt:string;mode:number;children?:Map<string,Tree>}
export async function snapshot(filename:string):Promise<Tree>{
  const stat=await fs.lstat(filename);if(stat.isSymbolicLink())throw new HttpError(403,'操作范围包含符号链接，未执行文件操作。');
  if(stat.isFile()){
    const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{
      const before=await handle.stat();if(!before.isFile())throw new HttpError(403,'仅支持普通文件和目录。');const digest=createHash('sha256');for await(const bytes of handle.createReadStream({autoClose:false}))digest.update(bytes);const after=await handle.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new HttpError(409,'读取期间原始文件发生变化，请重新读取后比较。');
      return{kind:'file',hash:digest.digest('hex'),size:after.size,modifiedAt:after.mtime.toISOString(),mode:after.mode&0o777};
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
  const input=await fs.open(source,constants.O_RDONLY|constants.O_NOFOLLOW);let output:Awaited<ReturnType<typeof fs.open>>|undefined;
  try{output=await fs.open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,tree.mode);for await(const chunk of input.createReadStream({autoClose:false})){const bytes=chunk as Buffer;let offset=0;while(offset<bytes.length){const result=await output.write(bytes,offset,bytes.length-offset);offset+=result.bytesWritten;}}await output.sync();await output.utimes(new Date(tree.modifiedAt),new Date(tree.modifiedAt));}
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
  if(code==='EEXIST'||code==='ENOTEMPTY')throw new HttpError(409,'目标位置已存在或发生变化；现有内容均已保留。');
  if(code==='ENOENT'||code==='ENOTDIR')throw new HttpError(409,'操作期间文件或目录发生变化；请重新读取后比较。');
  if(code==='ELOOP')throw new HttpError(403,'不允许通过符号链接操作资源。');
  if(code==='EACCES'||code==='EPERM')throw new HttpError(403,'系统未授予此目录的访问权限。');throw error;
}
