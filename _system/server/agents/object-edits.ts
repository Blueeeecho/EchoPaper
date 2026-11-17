import path from 'node:path';
import type {ChangeOperation} from '../../shared/agent-types';
import type {ProjectSnapshot} from './project-snapshot';
import {agentPath} from './project-snapshot';
import {HttpError} from '../security';

// Replacing comments with spaces retains source offsets for exact patches.
function uncomment(text:string){return text.replace(/(?<!\\)%.*/g,match=>' '.repeat(match.length));}

/** Source inventory, not a claim about compiled numbering. Read-only and frozen. */
export function assetInventory(snapshot:ProjectSnapshot,main:string){
 const base=path.posix.dirname(main),visited=new Set<string>(),warnings:string[]=[],objects:{kind:'figure'|'table';order:number;path:string;line:number;labels:string[];graphics:string[]}[]=[],counts={figure:0,table:0};
 function visit(file:string){
  if(visited.has(file))return;visited.add(file);
  const text=snapshot.files[file]?.text;if(text===undefined){warnings.push(`源码不可用：${file}`);return;}
  const clean=uncomment(text),tokens=/\\(?:input|include)\s*\{([^{}]+)\}|\\begin\s*\{(figure\*?|table\*?)\}/g;let match:RegExpExecArray|null;
  while((match=tokens.exec(clean))){
   if(match[1]){
    if(/[\\#$%]/.test(match[1])){warnings.push(`动态引用：${file}`);continue;}
    const name=match[1].trim();visit(path.posix.normalize(path.posix.join(base,name+(path.posix.extname(name)?'':'.tex'))));
   }else{
    const kind=match[2].startsWith('figure')?'figure':'table',end=clean.indexOf('\\end{'+match[2]+'}',tokens.lastIndex),body=end<0?'':clean.slice(tokens.lastIndex,end);
    if(end<0)warnings.push(`图表环境未闭合：${file}`);
    objects.push({kind,order:++counts[kind],path:file,line:clean.slice(0,match.index).split('\n').length,labels:[...body.matchAll(/\\label\s*\{([^{}]+)\}/g)].map(m=>m[1]),graphics:[...body.matchAll(/\\includegraphics\*?(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g)].map(m=>m[1])});
   }
  }
 }
 visit(main);
 return{main,objects,warnings,sourceOrder:[...visited],numbering:'order是字面引用顺序，不是经编译核实的图表编号；条件、动态引用或多个环境共用一个源文件时不能猜测。',naming:'单独的图表源码可按对应order提出fig_N.tex/tab_N.tex映射；关联图片保留真实扩展名。非独立文件中的多个图表不能通过重命名文件分别编号。'};
}

/** Count newly observed source facts, not newly worded tool calls. */
export function sourceEvidenceKeys(name:string,result:any,snapshot:ProjectSnapshot):unknown[]{
 if(name==='read_file'&&typeof result?.content==='string')return result.content.split('\n').map((text:string,index:number)=>[result.path,result.hash,result.startLine+index,text]);
 if(name==='search_files'&&Array.isArray(result?.results))return result.results.map((item:any)=>[item.path,snapshot.files[item.path]?.hash,item.line,item.text]);
 return[[name,result]];
}
export interface FigureObject {number:number;path:string;from:number;to:number;graphics:string}
export function locateFigure(snapshot:ProjectSnapshot,main:string,number:number,readSet:Record<string,string|null>):FigureObject {
 const base=path.posix.dirname(main),figures:FigureObject[]=[],stack=new Set<string>();let active:{number:number;graphics:FigureObject[];captions:number}|undefined,visits=0;
 function visit(file:string){
  if(stack.has(file)||++visits>200)throw new HttpError(409,'图编号依赖循环或过深的源码引用，无法可靠定位。');
  const entry=snapshot.files[agentPath(file)];if(entry?.text===undefined)throw new HttpError(409,`图编号依赖的源码不可用：${file}`);readSet[file]=entry.hash;stack.add(file);
  const clean=uncomment(entry.text),doc=clean.indexOf('\\begin{document}'),start=doc>=0?doc+'\\begin{document}'.length:0;
  const tokens=/\\(?:begin\s*\{(figure\*?|verbatim\*?|lstlisting|minted)\}|end\s*\{(figure\*?|document)\}|(input|include)\s*\{([^{}]*)\}|(includegraphics)\*?(?:\s*\[[^\]]*\])?\s*\{([^{}]*)\}|(if\w*|else|fi|setcounter|addtocounter|newcommand|renewcommand|def|captionof|import|subimport|includeonly|input|include|ContinuedFloat|counterwithin|numberwithin)\b|(caption)(\*)?)/g;
  tokens.lastIndex=start;let match:RegExpExecArray|null;
  while((match=tokens.exec(clean))){
   if(match[7])throw new HttpError(409,`图编号含条件、计数器或动态命令（${match[7]}），请先明确源码对象，不能猜测图${number}。`);
   if(match[1]){
    if(!/^figure/.test(match[1])){const end=clean.indexOf('\\end{'+match[1]+'}',tokens.lastIndex);if(end<0)throw new HttpError(409,'代码环境未闭合，无法定位图。');tokens.lastIndex=end+match[1].length+6;continue;}
    if(active)throw new HttpError(409,'嵌套图环境无法可靠定位。');active={number:figures.length+1,graphics:[],captions:0};
   }else if(match[2]){
    if(match[2]==='document')break;
    if(!active||active.graphics.length!==1||active.captions!==1)throw new HttpError(409,'自动换图需要每个已定位图环境含一条 includegraphics 和一个编号图注；多子图或绘制代码须单独定位。');
    figures.push(active.graphics[0]);active=undefined;
    if(figures.length===number){stack.delete(file);return;}
   }else if(match[3]){
    if(/[\\#$%]/.test(match[4]))throw new HttpError(409,'存在动态源码引用，无法可靠确定图编号。');
    const name=match[4].trim(),resolved=path.posix.normalize(path.posix.join(base,name+(path.posix.extname(name)?'':'.tex')));visit(resolved);
    if(figures.length===number){stack.delete(file);return;}
   }else if(match[5]&&active){
    const argumentOffset=match[0].lastIndexOf('{')+1;
    active.graphics.push({number:active.number,path:file,from:match.index+argumentOffset,to:match.index+argumentOffset+match[6].length,graphics:match[6]});
   }else if(match[8]&&active){
    if(match[9])throw new HttpError(409,'无编号图注不能作为图编号依据。');active.captions++;
   }
  }
  stack.delete(file);
 }
 visit(main);const figure=figures[number-1];if(!figure)throw new HttpError(404,`当前编译目标未找到可可靠定位的图${number}，未新增图片或改动编号。`);return figure;
}

export function replacementOperations(snapshot:ProjectSnapshot,main:string,figure:FigureObject,attachment:{id:string;mimeType:string},readSet:Record<string,string|null>):ChangeOperation[]{
 const extension:Record<string,string>={'image/png':'.png','image/jpeg':'.jpg','application/pdf':'.pdf'},ext=extension[attachment.mimeType];
 if(!ext)throw new HttpError(415,'换图仅支持原格式 PNG、JPEG 或 PDF。');
 const asset=`manuscript/figures/figure-${figure.number}-${attachment.id}${ext}`;
 if(snapshot.files[asset])throw new HttpError(409,'该附件的换图目标文件已存在，请核对已有修改后重新提出任务。');
 const file=snapshot.files[figure.path],mainBase=path.posix.dirname(main);
 const relative=path.posix.relative(mainBase,asset),content=file.text!.slice(0,figure.from)+relative+file.text!.slice(figure.to);
 readSet[asset]=null;
 return[{kind:'attachment',path:asset,attachmentId:attachment.id,expectedHash:null},{kind:'write',path:figure.path,content,expectedHash:file.hash}];
}

/** Prove that the requested figure was replaced and all other text stayed intact. */
export function checkReplacement(snapshot:ProjectSnapshot,main:string,number:number,operations:ChangeOperation[],readSet:Record<string,string|null>){
 const figure=locateFigure(snapshot,main,number,readSet),file=snapshot.files[figure.path];
 const writes=operations.filter((op):op is Extract<ChangeOperation,{kind:'write'}>=>op.kind==='write');
 const assets=operations.filter((op):op is Extract<ChangeOperation,{kind:'attachment'}>=>op.kind==='attachment');
 if(operations.length!==2||writes.length!==1||assets.length!==1||writes[0].path!==figure.path||assets[0].expectedHash!==null)throw new HttpError(400,'换图须替换原图的素材引用；不能新增图环境、顺延编号或修改其他正文。请使用 replace_figure 操作。');
 const prefix=file.text!.slice(0,figure.from),suffix=file.text!.slice(figure.to),next=writes[0].content;
 if(!next.startsWith(prefix)||!next.endsWith(suffix)||next.length<prefix.length+suffix.length)throw new HttpError(400,'换图修改超出了原图素材引用，图注、标签及其他正文必须保留。');
 const arg=next.slice(prefix.length,next.length-suffix.length);
 if(!arg||/[{}\\#$%\n\r]/.test(arg)||arg===figure.graphics||path.posix.normalize(path.posix.join(path.posix.dirname(main),arg))!==assets[0].path)throw new HttpError(400,'原图引用未准确绑定本次附件，尚未生成建议。');
}

export function patchOperations(snapshot:ProjectSnapshot,operations:any[]):ChangeOperation[]{
 const result:ChangeOperation[]=[],patches=new Map<string,Extract<ChangeOperation,{kind:'write'}>>();
 for(const op of operations){
  if(op.kind==='replace_figure')throw new HttpError(400,'replace_figure 必须单独提交。');
  if(op.kind==='patch'){
   const file=agentPath(op.path),entry=snapshot.files[file];if(entry?.text===undefined)throw new HttpError(404,'局部补丁对应的快照文本不存在。');
   const prior=patches.get(file),text=prior?.content??entry.text,index=text.indexOf(op.oldText);
   if(index<0||text.indexOf(op.oldText,index+op.oldText.length)>=0)throw new HttpError(409,'局部补丁必须精确匹配唯一原文；请缩小或补充上下文。');
   const write={kind:'write' as const,path:file,content:text.slice(0,index)+op.newText+text.slice(index+op.oldText.length),expectedHash:entry.hash};
   if(!prior)result.push(write);else result[result.indexOf(prior)]=write;patches.set(file,write);
  }else if(op.kind==='move'){
   const file=agentPath(op.from),entry=snapshot.files[file];if(!entry)throw new HttpError(404,'待重命名素材不在任务快照中。');
   result.push({...op,expectedHash:op.expectedHash??entry.hash});
  }else result.push(op);
 }
 return result;
}
