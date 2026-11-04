import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {assertNoSymlinks,HttpError} from '../security';
import {withLock,writeJson} from '../storage';

export interface CompactionUsage {modelCalls:number;tokens:number;estimated:boolean;startedAt:string}
interface CompactionReceipt extends CompactionUsage {modelId:string;configRevision:string;consumed:boolean}
export async function saveCompaction(root:string,usage:CompactionUsage,binding:{modelId:string;configRevision:string}) {
 const id=randomUUID(),directory=await assertNoSymlinks(root,'.workbench/agent-compactions',true);
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const filename=await assertNoSymlinks(root,`.workbench/agent-compactions/${id}.json`,true);
 await writeJson(filename,{...usage,...binding,consumed:false} satisfies CompactionReceipt);
 return id;
}
/** The client cannot supply or reset paid compression usage. A receipt belongs to one run. */
export async function consumeCompaction(root:string,id:string,binding:{modelId:string;configRevision:string}):Promise<CompactionUsage> {
 if(!/^[a-f0-9-]{36}$/.test(id))throw new HttpError(400,'对话压缩记录编号无效。');
 return withLock(`conversation-compaction:${root}:${id}`,async()=>{
  const filename=await assertNoSymlinks(root,`.workbench/agent-compactions/${id}.json`,true);
  let receipt:CompactionReceipt;
  try{if((await fs.stat(filename)).size>8192)throw Error('oversize');receipt=JSON.parse(await fs.readFile(filename,'utf8'));}catch{throw new HttpError(409,'对话压缩记录不可用，请保留历史后重新压缩。');}
  if(receipt.consumed||receipt.modelId!==binding.modelId||receipt.configRevision!==binding.configRevision||!Number.isSafeInteger(receipt.modelCalls)||receipt.modelCalls<0||!Number.isSafeInteger(receipt.tokens)||receipt.tokens<0||typeof receipt.estimated!=='boolean'||!Number.isFinite(Date.parse(receipt.startedAt)))throw new HttpError(409,'对话压缩记录已使用或模型配置已变化，请重新压缩。');
  await writeJson(filename,{...receipt,consumed:true});
  return {modelCalls:receipt.modelCalls,tokens:receipt.tokens,estimated:receipt.estimated,startedAt:receipt.startedAt};
 });
}
