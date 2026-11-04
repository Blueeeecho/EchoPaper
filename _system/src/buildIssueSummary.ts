import type {Build,Diagnostic} from '../shared/types';
import {submissionSeverity} from '../shared/diagnostic-policy';
export type IssueKind='error'|'reference'|'warning'|'placeholder'|'info';
export const issueLabels:Record<IssueKind,string>={error:'严重错误',reference:'引用问题',warning:'一般警告',placeholder:'待补内容',info:'其他提示'};
const referenceSummary=(d:Diagnostic)=>d.category==='reference'&&!d.line&&!d.page&&/There were undefined|undefined (?:references|citations)\.?$|Rerun to get cross-references/i.test(d.message);
export function issueGroups(diagnostics:readonly Diagnostic[]):Record<IssueKind,Diagnostic[]>{
 const groups:Record<IssueKind,Diagnostic[]>={error:[],reference:[],warning:[],placeholder:[],info:[]};
 const detailedReferences=diagnostics.some(d=>d.category==='reference'&&!referenceSummary(d));
 const seen=new Set<string>();
 for(const diagnostic of diagnostics){const identity=JSON.stringify(diagnostic);if(seen.has(identity))continue;seen.add(identity);
  const kind:IssueKind=diagnostic.category==='placeholder'?'placeholder':diagnostic.category==='reference'?(detailedReferences&&referenceSummary(diagnostic)?'info':'reference'):submissionSeverity(diagnostic)==='error'?'error':diagnostic.severity==='warning'?'warning':'info';
  groups[kind].push(diagnostic);
 }
 return groups;
}
export function issueCounts(diagnostics:readonly Diagnostic[]){const groups=issueGroups(diagnostics);return{error:groups.error.length,reference:groups.reference.length,warning:groups.warning.length,placeholder:groups.placeholder.length,info:groups.info.length};}
export function buildStatusLabel(build?:Build):string{
 if(!build)return'尚未编译';
 if(build.status!=='succeeded')return({queued:'等待编译',running:'正在编译',failed:'编译失败',cancelled:'编译已取消'})[build.status];
 const count=issueCounts(build.diagnostics);
 const serious=count.error+count.reference+count.placeholder;
 return serious?`已生成 PDF · ${serious} 项严重问题`:count.warning?'已生成 PDF · 有警告':'编译成功';
}
