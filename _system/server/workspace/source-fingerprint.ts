import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {HttpError} from '../security';
/** Refuse a mixed read or a path replacement instead of recording an ambiguous fingerprint. */
export async function fingerprintFile(filename:string,validate?:()=>Promise<unknown>){
 await validate?.();const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await handle.stat({bigint:true});if(!before.isFile())throw new HttpError(400,'请选择文件。');
  const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
  await validate?.();const after=await handle.stat({bigint:true}),current=await fs.lstat(filename,{bigint:true});
  const same=(a:typeof before,b:typeof before)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
  if(!same(before,after)||!same(after,current)||current.isSymbolicLink())throw new HttpError(409,'来源在读取期间变化，请等待文件写入完成后重新核对。');
  return hash.digest('hex');
 }finally{await handle.close();}
}
