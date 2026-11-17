import type {AgentRun,ToolCall} from '../../shared/agent-types';
import type {ProjectSnapshot} from './project-snapshot';
export interface ReviewDependency {path:string;hash:string|null;from:number;to:number;totalLines:number;binary:boolean;reason:string}
export interface ReadReceipt {path:string;hash:string;startLine:number;endLine:number;totalLines:number;truncated:boolean;binary:boolean}
export interface ReviewPacket {dependencies:ReviewDependency[];diff:string;diffTruncated:boolean;blocked:string[]}
export function reviewPacket(run:AgentRun,snapshot:ProjectSnapshot,targetMain?:string):ReviewPacket {
 const paths=new Map<string,string>(),blocked:string[]=[];const selection=run.scope.selection;
 for(const c of run.changesets.filter(c=>['proposed','applied','applying'].includes(c.status)))for(const image of c.images)paths.set(image.path,'候选差异');
 if(selection)paths.set(selection.path,'明确选区');
 for(const scope of run.scope.paths||[])for(const p of Object.keys(snapshot.files))if(p===scope||p.startsWith(scope.replace(/\/$/,'')+'/'))paths.set(p,'明确文件范围');
 if(!paths.size){if(targetMain)paths.set(targetMain,'当前目标');else blocked.push('未确定审阅目标');
  if(run.writingTask?.kind!=='focused')for(const p of Object.keys(snapshot.files))if(/^manuscript\/.*\.(tex|bib)$/.test(p))paths.set(p,'目标正文依赖');
 }
 if(/全文|全稿|整篇|whole paper/i.test(run.input)){if(targetMain)paths.set(targetMain,'全稿目标');for(const p of Object.keys(snapshot.files))if(/^manuscript\/.*\.(tex|bib)$/.test(p))paths.set(p,'全稿正文依赖');}
 if(snapshot.files['notes/research-basis.md']&&((!selection&&run.writingTask?.kind!=='focused')||/研究|方法|贡献|文献|主张|全文|全稿/.test(run.input)))paths.set('notes/research-basis.md','研究依据');
 if(run.requiredRoles?.includes('references'))for(const p of Object.keys(snapshot.files))if(/\.bib$/.test(p)||/^literature\/.*\.(md|txt|tex)$/.test(p))paths.set(p,'必要文献证据');
 const dependencies=[...paths].sort(([a],[b])=>a.localeCompare(b)).map(([path,reason])=>{
  const file=snapshot.files[path],lines=file?.text?.split('\n').length??0;let from=1,to=lines;
  // A file changed by a candidate must be reviewed in full; explicit local
  // selection without a candidate can require just its actual line interval.
  if(selection?.path===path&&reason==='明确选区'&&!run.changesets.some(c=>c.images.some(i=>i.path===path))){from=selection.documentText.slice(0,selection.from).split('\n').length;to=selection.documentText.slice(0,selection.to).split('\n').length;}
  if(!file)blocked.push(path+'：无当前可读内容（删除/缺失须人工核对）');
  if(file?.binary)blocked.push(path+'：二进制元数据不能代替内容核验');
  return{path,hash:file?.hash??null,from,to,totalLines:lines,binary:!file||file.binary,reason};
 });
 let diff='',diffTruncated=false;
 for(const c of run.changesets.filter(c=>['proposed','applied','applying'].includes(c.status)))for(const image of c.images){
  if((image.beforeHash&&image.beforeBase64===undefined)||(image.afterHash&&image.afterBase64===undefined)){blocked.push(image.path+'：缺少冻结差异原字节，不能核验差异');continue;}
  const decode=(raw?:string)=>raw===undefined?'':new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(raw,'base64'));
  try{const before=decode(image.beforeBase64).split('\n'),after=decode(image.afterBase64).split('\n');let start=0,endA=before.length,endB=after.length;
   while(start<endA&&start<endB&&before[start]===after[start])start++;
   while(endA>start&&endB>start&&before[endA-1]===after[endB-1]){endA--;endB--;}
   const block=`\n${image.path} ${image.beforeHash??'new'} -> ${image.afterHash??'deleted'}\n@@ before ${start+1}:${endA}; after ${start+1}:${endB} @@\n${before.slice(start,endA).map(l=>'- '+l).join('\n')}\n${after.slice(start,endB).map(l=>'+ '+l).join('\n')}\n`;
   const remaining=40000-diff.length;if(block.length>remaining){diff+=block.slice(0,Math.max(0,remaining));diffTruncated=true;}else diff+=block;
  }catch{diff+=`\n${image.path}：非 UTF-8 差异，未核验内容\n`;blocked.push(image.path+'：无可读差异');}
 }
 if(diffTruncated)blocked.push('可读差异超过 40000 字符，截断部分未核验');
 return{dependencies,diff,diffTruncated,blocked};
}
export function readReceipts(tools:ToolCall[],agentId:string):ReadReceipt[]{
 return tools.filter(t=>t.agentId===agentId&&t.name==='read_file'&&t.status==='completed').flatMap(t=>{
  const r=t.result as Partial<ReadReceipt>&{content?:unknown}|undefined;
  if(!r||typeof r.path!=='string'||typeof r.hash!=='string')return[];
  return[{path:r.path,hash:r.hash,startLine:r.startLine??0,endLine:r.endLine??0,totalLines:r.totalLines??0,truncated:!!r.truncated,binary:!!r.binary||typeof r.content!=='string'}];
 });
}
export function coverageGaps(packet:ReviewPacket,receipts:ReadReceipt[]):string[]{
 const gaps=[...packet.blocked];for(const d of packet.dependencies){
  let next=d.from;
  for(const r of receipts.filter(r=>r.path===d.path&&r.hash===d.hash&&!r.binary&&r.totalLines===d.totalLines&&r.startLine>=1&&r.endLine>=r.startLine&&r.endLine<=r.totalLines).sort((a,b)=>a.startLine-b.startLine)){
   if(r.startLine>next)break;if(r.endLine>=next)next=r.endLine+1;
  }
  if(d.binary||next<=d.to)gaps.push(`${d.path}：缺少实际读取 ${next}-${d.to} 行`);
 }
 if(!packet.dependencies.length)gaps.push('未冻结任何必要材料');return gaps;
}
