import type {AgentEditContext,AgentEditTarget,ChangeOperation,VerifiedEditTarget} from '../../shared/agent-types';
import {HttpError} from '../security';
import {agentPath,type ProjectSnapshot} from './project-snapshot';

function operationPaths(operations:ChangeOperation[]):string[]{
 return operations.flatMap(operation=>{
  if(operation.kind==='project')return [];
  return operation.kind==='move'?[agentPath(operation.from),agentPath(operation.to)]:[agentPath(operation.path)];
 });
}

function uniquePosition(text:string,selected:string,path:string):number{
 const from=text.indexOf(selected);
 if(from<0)throw new HttpError(409,'目标选文已变化，请读取当前原文后重新声明。',{editTargetError:'selectionChanged',path});
 if(text.indexOf(selected,from+1)>=0)throw new HttpError(409,'目标选文在当前文件中出现多次，请提供更完整的唯一原文。',{editTargetError:'selectionAmbiguous',path});
 return from;
}

function selectionTarget(target:Extract<AgentEditTarget,{kind:'selection'}>,context:AgentEditContext|undefined,snapshot:ProjectSnapshot):Extract<VerifiedEditTarget,{kind:'selection'}>{
 const path=agentPath(target.path),file=snapshot.files[path];
 if(!file||file.text===undefined)throw new HttpError(400,'声明的选区需要对应当前快照中的文本文件。',{editTargetError:'selectionFileUnavailable',path});
 const author=context?.selection;
 if(author){
  if(agentPath(author.path)!==path)throw new HttpError(400,'声明的选区文件与作者选文所在文件不一致。',{editTargetError:'selectionFileMismatch',path,selectionPath:author.path});
  if(typeof author.documentText!=='string'||typeof author.selectedText!=='string'||!author.selectedText
   ||!Number.isSafeInteger(author.from)||!Number.isSafeInteger(author.to)
   ||author.from<0||author.to<=author.from||author.to>author.documentText.length
   ||author.documentText.slice(author.from,author.to)!==author.selectedText){
   throw new HttpError(400,'作者选文的文本与位置不一致，请重新选择原文。',{editTargetError:'invalidSelectionContext',path});
  }
  const selected=target.selectedText??author.selectedText;
  if(!selected||!author.selectedText.includes(selected))throw new HttpError(400,'声明的目标原文须位于作者选文内。',{editTargetError:'selectionOutsideContext',path});
  const offset=uniquePosition(author.selectedText,selected,path);
  const authorFrom=author.documentText===file.text?author.from:uniquePosition(file.text,author.selectedText,path);
  const from=authorFrom+offset;
  return {kind:'selection',path,from,to:from+selected.length,expectedHash:file.hash};
 }
 if(typeof target.selectedText!=='string'||!target.selectedText)throw new HttpError(400,'请在选区目标中提供当前文件的唯一原文，或使用作者已提供的选文。',{editTargetError:'selectionTextRequired',path});
 const from=uniquePosition(file.text,target.selectedText,path);
 return {kind:'selection',path,from,to:from+target.selectedText.length,expectedHash:file.hash};
}

/** Resolve model intent against frozen source data while preserving the run's separate authority. */
export function resolveEditTarget(target:AgentEditTarget,context:AgentEditContext|undefined,snapshot:ProjectSnapshot,operations:ChangeOperation[]):VerifiedEditTarget{
 let verified:VerifiedEditTarget;
 switch(target.kind){
  case 'project':verified={kind:'project'};break;
  case 'files':{
   if(!Array.isArray(target.paths)||!target.paths.length)throw new HttpError(400,'请声明至少一个目标文件。',{editTargetError:'targetFilesRequired'});
   verified={kind:'files',paths:[...new Set(target.paths.map(agentPath))]};break;
  }
  case 'selection':verified=selectionTarget(target,context,snapshot);break;
  default:throw new HttpError(400,'修改目标类型无效。',{editTargetError:'invalidTargetKind'});
 }
 validateEditTarget(verified,operations,snapshot);
 return verified;
}

/** Recheck persisted targets against proposal-time bytes before applying a changeset. */
export function validateEditTarget(target:VerifiedEditTarget,operations:ChangeOperation[],snapshot:ProjectSnapshot):void{
 if(target.kind==='project'){operationPaths(operations);return;}
 if(target.kind==='files'){
  if(!Array.isArray(target.paths)||!target.paths.length)throw new HttpError(400,'已保存的目标文件列表无效。',{editTargetError:'targetFilesRequired'});
  const allowed=new Set(target.paths.map(agentPath));
  for(const path of operationPaths(operations))if(!allowed.has(path))throw new HttpError(400,'修改涉及已声明目标之外的文件，请核对目标与操作。',{editTargetError:'operationOutsideTarget',path,allowed:[...allowed]});
  return;
 }
 if(target.kind!=='selection')throw new HttpError(400,'修改目标类型无效。',{editTargetError:'invalidTargetKind'});
 const path=agentPath(target.path),file=snapshot.files[path];
 if(!file||file.text===undefined||file.hash!==target.expectedHash)throw new HttpError(409,'目标选文的文件基线已变化，请重新读取并声明。',{editTargetError:'selectionBaselineChanged',path});
 if(!Number.isSafeInteger(target.from)||!Number.isSafeInteger(target.to)||target.from<0||target.to<=target.from||target.to>file.text.length)throw new HttpError(400,'已保存的目标选区范围无效。',{editTargetError:'invalidSelectionBounds',path});
 const prefix=file.text.slice(0,target.from),suffix=file.text.slice(target.to);
 for(const operation of operations){
  if(operation.kind!=='write'||agentPath(operation.path)!==path)throw new HttpError(400,'选区修改仅能写入该选区所在文本文件。',{editTargetError:'operationOutsideSelection',path});
  if(operation.expectedHash!==target.expectedHash)throw new HttpError(409,'选区修改的操作基线与已声明目标不一致。',{editTargetError:'selectionOperationBaselineChanged',path});
  if(!operation.content.startsWith(prefix)||!operation.content.endsWith(suffix)||operation.content.length<prefix.length+suffix.length)throw new HttpError(400,'修改超出已声明选区，请保留选区外原文。',{editTargetError:'selectionBoundsExceeded',path});
 }
}
