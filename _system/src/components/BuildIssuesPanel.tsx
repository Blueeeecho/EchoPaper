import {useMemo,useState} from 'react';
import {AlertCircle,AlertTriangle,CheckCircle2,FileCode2,Info,Sparkles} from 'lucide-react';
import type{Build,Diagnostic}from'../../shared/types';
import {issueGroups,issueLabels,type IssueKind}from'../buildIssueSummary';
import type {ReferenceIndex} from '../../shared/reference-types';
import {diagnosticRepair} from '../diagnosticRepair';
import {submissionSeverity} from '../../shared/diagnostic-policy';
import '../build-issues.css';

type Filter='problems'|'all'|IssueKind;
const order:IssueKind[]=['error','reference','warning','placeholder','info'];
const explanation:Record<IssueKind,string>={error:'影响正式提交；请先修复。编译是否中止单独记录。',reference:'严重问题：图、表、章节或文献引用异常，正式提交前必须修复。',warning:'排版、字体等编译警告，通常不会中断编译。',placeholder:'严重问题：尚有待补内容，正式提交前必须完成。',info:'编译汇总及其他信息，完整记录保留在日志中。'};
export default function BuildIssuesPanel({build,onOpen,references,sourceRoot,onRepair}:{build?:Build;onRepair?:(diagnostic:Diagnostic,build:Build)=>void;references?:ReferenceIndex;sourceRoot?:string;onOpen:(path:string,line?:number)=>void}){
 const [filter,setFilter]=useState<Filter>('problems');
 const groups=useMemo(()=>issueGroups(build?.diagnostics||[]),[build?.diagnostics]);
 const count=order.reduce((sum,kind)=>sum+groups[kind].length,0),problems=groups.error.length+groups.reference.length+groups.warning.length;
 const shown=order.filter(kind=>filter==='all'||filter==='problems'&&['error','reference','warning'].includes(kind)||filter===kind);
 const source=(d:Diagnostic)=>d.file?`${d.file}${d.line?`:${d.line}`:''}`:'日志未提供可靠的源码位置';
 return <div className="build-issues-panel"><div className="build-issues-context"><span>{build?`${build.id} · ${build.finishedAt?new Date(build.finishedAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'正在编译'}`:'尚未编译'}</span>{build?.stale&&<strong>基于上次编译 · 源码已变化</strong>}</div><div className="build-issues-filters" role="group" aria-label="筛选编译问题">{([['problems','编译问题',problems],['all','全部',count],...order.map(kind=>[kind,issueLabels[kind],groups[kind].length])] as [Filter,string,number][]).map(([kind,label,total])=><button key={kind} aria-pressed={filter===kind} className={`build-issue-filter ${kind}`} onClick={()=>setFilter(kind)}>{label}<span>{total}</span></button>)}</div><div className="build-issues-groups">{shown.map(kind=>groups[kind].length?<section key={kind} className={`build-issue-group ${kind}`}><header><strong><span className="issue-dot"/>{issueLabels[kind]} <small>{groups[kind].length}</small></strong><span>{explanation[kind]}</span></header>{groups[kind].map((d,index)=>{const level=kind==='info'?'info':submissionSeverity(d);const repair=references&&sourceRoot?diagnosticRepair(d,references,sourceRoot):undefined;return <div key={`${d.file}:${d.line}:${d.page}:${d.message}:${index}`} className="build-issue-entry"><button className={`build-issue-row ${level}`} disabled={!d.file} onClick={()=>{if(d.file)onOpen(d.file,d.line);}} title={d.file?`打开 ${source(d)}`:source(d)}>{level==='error'?<AlertCircle size={14}/>:level==='warning'?<AlertTriangle size={14}/>:<Info size={14}/>}<span><span className="build-issue-message">{d.message}</span><small><FileCode2 size={11}/>{source(d)}{d.page?` · PDF 第 ${d.page} 页`:''}</small></span></button>{onRepair && build && kind !== 'info' && <button className="task-assignment-button" onClick={() => onRepair(d,build)}><Sparkles size={11}/>交给助手修复</button>}{repair&&<details className="build-issue-repair"><summary>修复线索</summary><p>{repair.message}</p>{repair.definitions.map(item=><button key={`${item.file}:${item.line}`} onClick={()=>onOpen(item.file,item.line)}><FileCode2 size={11}/>{item.file}:{item.line}</button>)}</details>}</div>;})}</section>:null)}{!shown.some(kind=>groups[kind].length)&&<div className="build-issues-empty"><CheckCircle2 size={17}/><span>{build?count?'此分类没有问题，可切换查看其他记录。':'本次编译没有检查提示。':'编译后会记录错误、引用问题与警告。'}</span></div>}</div></div>;
}
