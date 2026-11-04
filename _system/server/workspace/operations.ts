import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {FileOperation,FileOperationInput,SourceRoot} from '../../shared/workspace-types.ts';
import type {CatalogState,IndexedResource,JournalOperation} from './catalog.ts';
import {HttpError} from '../security.ts';
import {hash} from '../storage.ts';
import {absent,contains,copyExclusive,fileError,removeVerified,resourcePath,rootFile,snapshot,trashName} from './paths.ts';

export function publicOperation(item:JournalOperation):FileOperation {const{id,kind,status,source,destination,recovery,resourceId,createdAt,error,undoable}=item;return structuredClone({id,kind,status,source,destination,recovery,resourceId,createdAt,error,undoable});}
export function createFileOperations(workspaceRoot:string,state:CatalogState,save:()=>Promise<void>){
  function root(id:string,write=true):SourceRoot {const item=state.roots.find(r=>r.id===id);if(!item)throw new HttpError(404,'来源目录不存在。');if(write&&item.permission!=='write')throw new HttpError(403,'此来源仅允许读取，请先明确授予文件管理权限。');return item;}
  function resource(id:unknown){const item=state.resources.find(r=>r.id===id);if(!item)throw new HttpError(404,'资源不存在。');return item;}
  const inside=(candidate:string,base:string)=>candidate===base||candidate.startsWith(base+'/');
  const creates=(operation:Pick<FileOperation,'kind'>)=>operation.kind==='mkdir'||operation.kind==='create-file';
  async function fileIdentity(filename:string){const stat=await fs.lstat(filename,{bigint:true});return{device:stat.dev.toString(),inode:stat.ino.toString()};}
  const sameIdentity=(a:JournalOperation['createdFileIdentity'],b:JournalOperation['createdFileIdentity'])=>!!a&&!!b&&a.device===b.device&&a.inode===b.inode;
  async function trashTarget(sourceRoot:SourceRoot,id:string,name='content'){
    const trash=await rootFile(workspaceRoot,sourceRoot,trashName,{internal:true,missing:true});await fs.mkdir(trash,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});await rootFile(workspaceRoot,sourceRoot,trashName,{internal:true});
    const bin=await rootFile(workspaceRoot,sourceRoot,`${trashName}/${id}`,{internal:true,missing:true});await fs.mkdir(bin,{mode:0o700});const relative=`${trashName}/${id}/${name}`;return{relative,filename:await rootFile(workspaceRoot,sourceRoot,relative,{internal:true,missing:true})};
  }
  function finishApply(operation:JournalOperation){
    if(creates(operation)){
      const record=operation.records![0];if(!state.resources.some(r=>r.id===record.id))state.resources.push(structuredClone(record));
    }else for(const before of operation.records!){
      const item=resource(before.id);if(operation.kind==='trash'){item.missing=true;item.revision++;}
      else{item.rootId=operation.destination!.rootId;item.path=operation.destination!.path+before.path.slice(operation.source!.path.length);item.name=path.posix.basename(item.path);item.missing=false;item.revision++;}
    }
    operation.appliedRevisions=Object.fromEntries(operation.records!.map(item=>[item.id,resource(item.id).revision]));operation.status='applied';operation.phase='applied';operation.undoable=true;delete operation.error;
  }
  function finishUndo(operation:JournalOperation){
    if(creates(operation)){const item=resource(operation.resourceId);item.missing=true;item.revision++;}
    else for(const before of operation.records!){const item=resource(before.id),revision=item.revision+1;Object.assign(item,structuredClone(before),{revision,missing:false});}
    operation.status='undone';operation.phase='applied';operation.undoable=false;delete operation.error;
  }
  async function transfer(source:string,destination:string,expectedHash:string,onCopied:()=>Promise<void>){
    await absent(destination);const before=await snapshot(source);if(before.hash!==expectedHash)throw new HttpError(409,'原始内容与读取版本不同，请重新读取后比较。');
    await copyExclusive(source,destination,before);
    if((await snapshot(destination)).hash!==before.hash)throw new HttpError(409,'目标副本校验失败；原文件与副本均已保留。');
    if((await snapshot(source)).hash!==before.hash)throw new HttpError(409,'复制期间原始内容发生变化，双方内容均已保留。');
    await onCopied();await removeVerified(source,before);
  }
  async function apply(input:FileOperationInput):Promise<FileOperation>{
    if(!input||!['mkdir','create-file','move','trash'].includes(input.kind)||typeof input.rootId!=='string')throw new HttpError(400,'文件操作参数无效。');
    const sourceRoot=root(input.rootId);let item:IndexedResource|undefined,source:string|undefined,destination:string,destinationRoot=sourceRoot,relative:string,records:IndexedResource[];
    const id=randomUUID(),createdAt=new Date().toISOString();let beforeHash:string;
    if(creates(input)){
      if(input.kind==='create-file'){
        if(input.expectedHash!==null)throw new HttpError(400,'新建文件必须明确使用 expectedHash:null，不覆盖已有内容。');
        if(typeof input.content!=='string'||input.content.includes('\0')||Buffer.from(input.content,'utf8').toString('utf8')!==input.content)throw new HttpError(400,'新建文件内容必须是有效 UTF-8 文本，可为空。');
        if(Buffer.byteLength(input.content,'utf8')>3*1024*1024)throw new HttpError(413,'新建文本文件不能超过 3 MB。');
      }
      relative=resourcePath(input.path);destination=await rootFile(workspaceRoot,sourceRoot,relative,{missing:true});await absent(destination);beforeHash=hash(input.kind==='create-file'?input.content!:'');
      item={id:randomUUID(),rootId:sourceRoot.id,path:relative,name:path.posix.basename(relative),kind:input.kind==='create-file'?'file':'directory',size:input.kind==='create-file'?Buffer.byteLength(input.content!,'utf8'):0,modifiedAt:createdAt,tags:[],missing:false,revision:1,hash:beforeHash,...(input.kind==='create-file'?{text:input.content,snippet:input.content!.replace(/\s+/g,' ').slice(0,240)}:{})};records=[structuredClone(item)];
    }else{
      item=resource(input.resourceId);if(item.rootId!==sourceRoot.id||item.missing)throw new HttpError(409,'资源所属来源或可用状态已变化，请重新载入。');
      if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision!==item.revision||typeof input.expectedHash!=='string'||!input.expectedHash)throw new HttpError(409,'请携带当前资源 revision 和 hash，重新读取后比较。');
      source=await rootFile(workspaceRoot,sourceRoot,item.path);beforeHash=(await snapshot(source)).hash;if(beforeHash!==input.expectedHash)throw new HttpError(409,'原始文件已被外部修改，请重新读取后比较。');
      records=state.resources.filter(r=>r.rootId===item!.rootId&&inside(r.path,item!.path)&&!r.missing).map(record=>structuredClone(record));
      if(input.kind==='move'){
        destinationRoot=root(input.destinationRootId||sourceRoot.id);relative=resourcePath(input.destinationPath);destination=await rootFile(workspaceRoot,destinationRoot,relative,{missing:true});if(contains(source,destination))throw new HttpError(400,'不能把目录移动到自身或其子目录。');await absent(destination);
      }else{
        const target=await trashTarget(sourceRoot,id);relative=target.relative;destination=target.filename;
      }
    }
    const operation:JournalOperation={id,kind:input.kind,status:'interrupted',source:creates(input)?undefined:{rootId:sourceRoot.id,path:item!.path},destination:{rootId:destinationRoot.id,path:relative},resourceId:item!.id,createdAt,undoable:false,phase:'prepared',beforeHash,afterHash:beforeHash,records};
    state.operations.push(operation);await save();
    try{
      operation.phase='copying';await save();
      if(input.kind==='mkdir'){await fs.mkdir(destination,{mode:0o755});const actual=await snapshot(destination);operation.records![0].modifiedAt=actual.modifiedAt;}
      else if(input.kind==='create-file'){
        const handle=await fs.open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);try{const stat=await handle.stat({bigint:true});operation.createdFileIdentity={device:stat.dev.toString(),inode:stat.ino.toString()};await save();await handle.writeFile(input.content!,'utf8');await handle.sync();}finally{await handle.close();}
        const actual=await snapshot(destination);if(actual.hash!==beforeHash)throw new HttpError(409,'新建文件写入后内容发生变化，文件已保留。');Object.assign(operation.records![0],{size:actual.size,modifiedAt:actual.modifiedAt});operation.phase='copied';await save();
      }
      else await transfer(source!,destination,beforeHash,async()=>{operation.phase='copied';await save();});
      finishApply(operation);await save();return publicOperation(operation);
    }catch(error){operation.status=operation.phase==='copied'?'interrupted':'failed';operation.error=(error as Error).message;operation.undoable=false;await save();return fileError(error);}
  }
  async function undo(id:string):Promise<FileOperation>{
    const operation=state.operations.find(o=>o.id===id);if(!operation)throw new HttpError(404,'文件操作不存在。');if(operation.status!=='applied'||!operation.undoable)throw new HttpError(409,'此操作目前不能安全撤销。');
    for(const[resourceId,revision]of Object.entries(operation.appliedRevisions||{}))if(resource(resourceId).revision!==revision)throw new HttpError(409,'资源标签、内容或路径在操作后已变化，请比较后处理。');
    const destinationRoot=root(operation.destination!.rootId),current=await rootFile(workspaceRoot,destinationRoot,operation.destination!.path,{internal:operation.kind==='trash'});
    if((await snapshot(current)).hash!==operation.afterHash)throw new HttpError(409,'操作后的内容已被修改，保留当前内容且不撤销。');
    if(operation.kind==='create-file'&&!sameIdentity(operation.createdFileIdentity,await fileIdentity(current)))throw new HttpError(409,'新建文件的原位置已被其他文件占用，未撤销或删除现有内容。');
    let original:string|undefined;if(operation.source){const originalRoot=root(operation.source.rootId);original=await rootFile(workspaceRoot,originalRoot,operation.source.path,{missing:true});await absent(original);}
    if(operation.kind==='create-file'){const target=await trashTarget(destinationRoot,operation.id,'created-file');original=target.filename;operation.recovery={rootId:destinationRoot.id,path:target.relative};}
    operation.phase='undoing';await save();
    try{
      if(operation.kind==='mkdir')await fs.rmdir(current);
      else await transfer(current,original!,operation.afterHash!,async()=>{if(operation.kind==='create-file'){if(!sameIdentity(operation.createdFileIdentity,await fileIdentity(current)))throw new HttpError(409,'撤销期间原位置被其他文件占用，双方内容已保留。');operation.recoveryFileIdentity=await fileIdentity(original!);await save();}});
      finishUndo(operation);await save();return publicOperation(operation);
    }catch(error){operation.status='interrupted';operation.error=`撤销中断，双方内容均保留：${(error as Error).message}`;operation.undoable=false;await save();return fileError(error);}
  }
  async function recoveryDownload(id:string):Promise<{content:Buffer;name:string}>{
    const operation=state.operations.find(o=>o.id===id);if(!operation||operation.kind!=='create-file'||operation.status!=='undone'||!operation.recovery)throw new HttpError(404,'此操作没有可下载的撤销恢复副本。');
    if(operation.recovery.rootId!==operation.destination?.rootId||operation.recovery.path!==`${trashName}/${operation.id}/created-file`)throw new HttpError(403,'恢复副本记录超出此操作的授权路径。');
    if(!operation.recoveryFileIdentity||!operation.afterHash)throw new HttpError(409,'恢复副本缺少可验证的文件身份，请保留现有内容并检查日志。');
    const filename=await rootFile(workspaceRoot,root(operation.recovery.rootId,false),operation.recovery.path,{internal:true}),handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW),maximum=3*1024*1024;
    try{
      const before=await handle.stat({bigint:true}),identity={device:before.dev.toString(),inode:before.ino.toString()};if(!before.isFile()||before.size>BigInt(maximum)||!sameIdentity(operation.recoveryFileIdentity,identity))throw new HttpError(409,'恢复副本已变化或被其他文件替换，未下载当前内容。');
      const chunks:Buffer[]=[];let total=0;while(true){const buffer=Buffer.allocUnsafe(Math.min(65536,maximum-total+1)),{bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>maximum)throw new HttpError(409,'恢复副本已超过原始文本上限，请保留现有内容。');chunks.push(buffer.subarray(0,bytesRead));}
      const content=Buffer.concat(chunks,total),after=await handle.stat({bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||hash(content)!==operation.afterHash||!sameIdentity(operation.recoveryFileIdentity,await fileIdentity(filename)))throw new HttpError(409,'恢复副本内容已修改，未下载未经验证的内容。');
      return{content,name:operation.records?.[0]?.name||path.posix.basename(operation.destination!.path)};
    }finally{await handle.close();}
  }
  async function recover(){
    let changed=false;for(const operation of state.operations){
      if(!operation.phase||operation.phase==='applied'||operation.status==='failed'||operation.status==='undone')continue;
      try{
        const undoing=operation.phase==='undoing',sourceLocation=undoing?operation.destination:operation.source,destinationLocation=undoing?(operation.kind==='create-file'?operation.recovery:operation.source):operation.destination;
        if(!destinationLocation){operation.status='interrupted';operation.undoable=false;operation.error='中断的新建目录撤销请检查原目录，未自动删除内容。';changed=true;continue;}
        const destinationRoot=root(destinationLocation.rootId,false),destination=await rootFile(workspaceRoot,destinationRoot,destinationLocation.path,{internal:undoing&&operation.kind==='create-file'||!undoing&&operation.kind==='trash',missing:true});
        let sourcePresent=false;if(sourceLocation){const sourceRoot=root(sourceLocation.rootId,false),source=await rootFile(workspaceRoot,sourceRoot,sourceLocation.path,{internal:undoing&&operation.kind==='trash',missing:true});sourcePresent=await fs.lstat(source).then(()=>true).catch(()=>false);}
        const target=await snapshot(destination).catch(()=>undefined);
        const creationMatches=undoing||operation.kind!=='create-file'||target?.kind==='file'&&sameIdentity(operation.createdFileIdentity,await fileIdentity(destination).catch(()=>undefined));
        const recoveryMatches=!undoing||operation.kind!=='create-file'||sameIdentity(operation.recoveryFileIdentity,await fileIdentity(destination).catch(()=>undefined));
        if(!sourcePresent&&creationMatches&&recoveryMatches&&target?.hash===(undoing?operation.afterHash:operation.beforeHash)){if(undoing)finishUndo(operation);else finishApply(operation);}
        else{operation.status='interrupted';operation.undoable=false;operation.error='检测到未完成的文件操作；现有两处内容均保留，请比较后处理。';}
      }catch(error){operation.status='interrupted';operation.undoable=false;operation.error=`中断操作尚未恢复：${(error as Error).message}`;}changed=true;
    }if(changed)await save();
  }
  return{apply,undo,recover,recoveryDownload};
}
