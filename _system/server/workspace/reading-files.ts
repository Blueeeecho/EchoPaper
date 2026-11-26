import fs from 'node:fs/promises';
import path from 'node:path';
import {assertNoSymlinks,HttpError} from '../security';

export const validReadingId=/^[a-zA-Z0-9_-]{1,100}$/;

async function checkedStat(filename:string){
  const stat=await fs.lstat(filename).catch(error=>{
    if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;
    throw error;
  });
  if(stat?.isSymbolicLink())throw new HttpError(403,'不允许通过符号链接访问文件。');
  return stat;
}

export async function readingFileStamp(filename:string){
  const stat=await checkedStat(filename);
  return stat?`${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`:'';
}

/** Validate common ancestors once per lookup but every leaf independently. */
export async function readingFolders(root:string,...names:('reading-layout'|'reading-search')[]){
  const workspace=await assertNoSymlinks(root,'workspace',true);
  return Promise.all(names.map(async name=>{
    const folder=path.join(workspace,name);
    await checkedStat(folder);
    return folder;
  }));
}
