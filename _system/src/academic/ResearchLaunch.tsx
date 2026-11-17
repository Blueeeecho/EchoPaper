import {ArrowRight,ArrowUpRight,BookOpen,FlaskConical,FolderKanban,Files,NotebookPen,Presentation,ChartNoAxesCombined} from 'lucide-react';
import {RESEARCH_STAGES,type WorkspaceOverview} from '../../shared/workspace-types';
import type {Project} from '../../shared/types';
import type {PresentationSummary} from '../../shared/presentation-types';
import {STAGE_LABELS} from '../../shared/types';
import {prettyDate} from '../api';
import ConferenceCountdown from './ConferenceCountdown';
import ContinueReading from './ContinueReading';
import {continueResearch} from './researchContext';
import {readSession,workspaceSessionKey} from '../workspaceSession';
import {calendarWorkPath,resumeWork,todayWork,upcomingPaperDeadlines} from './todayWork';

const steps=[
 {id:'ideation',title:'问题与选题',hint:'研究问题 · 文献脉络 · 可行性',output:'明确要解决的问题',path:'/topics',icon:FolderKanban},
 {id:'experiments',title:'方案与实验',hint:'假设 · 对照方案 · 实验记录',output:'可执行、可复查的验证',path:'/experiments',icon:FlaskConical},
 {id:'results',title:'结果与证据',hint:'数据与图表 · 异常 · 结论边界',output:'证据能够支持的结论',path:'/results',icon:ChartNoAxesCombined},
 {id:'writing',title:'论文写作',hint:'论证结构 · 正文 · 引用与排版',output:'持续维护的论文主稿',path:'/papers',icon:BookOpen},
] as const;

export default function ResearchLaunch({overview,papers,decks,loading,onNavigate}:{overview?:WorkspaceOverview;papers:Project[];decks:PresentationSummary[];loading:boolean;onNavigate:(path:string)=>void}){
 const topics=(overview?.topics||[]).filter(t=>!t.archived).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 const active=papers.filter(p=>!p.archived&&!p.trashed),recent=[...active].sort((a,b)=>(b.lastEditedAt||b.updatedAt).localeCompare(a.lastEditedAt||a.updatedAt)).slice(0,3);
 const work=todayWork(topics),logs=work.records.slice(0,2),resume=resumeWork(papers,readSession(workspaceSessionKey)),deadlines=upcomingPaperDeadlines(papers);
 const resumePath=resume?.path||(topics[0]?continueResearch(topics[0],papers).path:'/topics');
 return <section className="academic-page academic-home research-launch"><div className="academic-home-intro"><div><h1>研究总览</h1><p>先处理今天的工作，再继续研究、实验与写作。</p></div><button className="academic-primary" disabled={loading} onClick={()=>onNavigate(resumePath)}>{resume?(resume.restored?'继续上次工作':'继续最近论文'):topics.length?'继续研究':'建立研究课题'}<ArrowRight size={15}/></button></div>
 <section className="research-today" aria-label="今日工作">
  <header className="academic-section-title"><h2>今日工作 <time dateTime={work.day}>{work.day} · 北京时间</time></h2><button onClick={()=>onNavigate(`/progress?day=${work.day}`)}>打开工作日历<ArrowUpRight size={14}/></button></header>
  {loading?<p role="status">正在读取今日工作…</p>:<div className="research-today-grid">
   <div className="today-tasks"><h3>今日待办 <span>{work.tasks.length}</span></h3>{work.tasks.length?<ul>{work.tasks.slice(0,3).map(task=><li key={`${task.topicId}:${task.id}`}><button onClick={()=>onNavigate(calendarWorkPath(task.topicId,task.day))}><span className="today-task-dot" aria-hidden="true"/><span><strong>{task.text}</strong><small>{task.topicTitle}</small></span><ArrowUpRight size={15}/></button></li>)}</ul>:<p className="research-quiet-message">今天没有未完成的已记录待办。</p>}{work.tasks.length>3&&<button className="today-more" onClick={()=>onNavigate(`/progress?day=${work.day}`)}>查看全部 {work.tasks.length} 项待办<ArrowRight size={14}/></button>}</div>
   <div className="today-resume"><h3>{resume?.restored?'上次工作':'最近工作'}</h3>{resume?<><strong>{resume.paper.title}</strong><p>{({writing:'论文写作',reviews:'审稿与回复',submissions:'投稿快照',history:'修改历史',settings:'论文设置',backups:'备份与恢复'})[resume.view]}</p>{resume.file&&<small title={resume.file}>{resume.file}</small>}<button className="academic-secondary" onClick={()=>onNavigate(resume.path)}>继续工作<ArrowRight size={14}/></button></>:<><p className="research-quiet-message">{topics.length?'从已保存的研究课题继续。':'建立课题，开始记录问题、材料与计划。'}</p><button className="academic-secondary" onClick={()=>onNavigate(resumePath)}>{topics.length?'继续研究':'建立课题'}<ArrowRight size={14}/></button></>}</div>
   <div className="today-deadlines"><h3>最近投稿截止</h3>{deadlines.length?<ul>{deadlines.map(item=><li key={item.paper.id}><button onClick={()=>onNavigate(`/papers/${encodeURIComponent(item.paper.id)}/settings`)}><strong>{item.paper.title}</strong><time dateTime={item.at}>{item.label} · 北京时间</time></button><a href={item.sourceUrl} target="_blank" rel="noreferrer">已记录来源<ArrowUpRight size={12}/></a></li>)}</ul>:<p className="research-quiet-message">暂无带来源的未来截止。可在论文中设置投稿目标。</p>}</div>
  </div>}
 </section>
 <nav className="research-pipeline" aria-label="研究主流程">{steps.map(step=>{const Icon=step.icon;return <button key={step.id} onClick={()=>onNavigate(step.path)}><strong><Icon size={17}/>{step.title}<ArrowUpRight size={14}/></strong><small>{step.hint}</small></button>;})}</nav>
 <div className="research-shared-tools"><span>贯穿全程</span><button onClick={()=>onNavigate('/library')}><Files size={15}/>资料库<small>检索与关联研究材料</small></button><button onClick={()=>onNavigate('/progress')}><NotebookPen size={15}/>工作日历<small>完成、阻碍与下一步</small></button><button onClick={()=>onNavigate('/presentations')}><Presentation size={15}/>汇报演示<small>{loading?'—':decks.length} 份汇报</small></button></div>
 <div className="research-overview-grid"><section className="research-projects"><ContinueReading onNavigate={onNavigate}/><div className="academic-section-title"><h2>当前课题<span>{loading?'—':topics.length}</span></h2><button onClick={()=>onNavigate('/topics')}>全部课题<ArrowUpRight size={13}/></button></div>
 {loading?<p role="status">正在读取课题…</p>:topics.length?<div className="research-project-list">{topics.slice(0,4).map(t=>{const latest=t.progressEntries?.filter(e=>!e.supersededBy&&e.kind!=='task').at(-1),next=continueResearch(t,papers);return <article key={t.id}><header><button onClick={()=>onNavigate(`/topics?topic=${t.id}`)}>{t.title}</button><span className="research-stage">{t.stage?RESEARCH_STAGES[t.stage]:'尚未标注阶段'}</span></header><p>{latest?.nextStep||t.description||'补充研究问题、目标与当前计划。'}</p><footer><small>{t.paperIds.length} 篇论文 · {t.resourceIds.length} 份资料</small><button onClick={()=>onNavigate(next.path)}>{next.label}<ArrowRight size={13}/></button></footer></article>;})}</div>:<div className="research-start"><FolderKanban size={24}/><div><h3>先建立研究课题</h3><p>一个课题可以先有问题和实验，再逐步关联论文与汇报。</p></div><button className="academic-secondary" onClick={()=>onNavigate('/topics')}>建立课题<ArrowRight size={14}/></button></div>}
 <div className="academic-section-title"><h2>近期进展</h2><button onClick={()=>onNavigate('/progress')}>查看日历<ArrowUpRight size={13}/></button></div>{logs.length?<div className="research-recent-logs">{logs.map(entry=><button key={entry.entryId} onClick={()=>onNavigate(calendarWorkPath(entry.topicId,entry.day))}><span>{entry.topicTitle}<time>{entry.day}</time></span><p>{entry.headline.length>90?entry.headline.slice(0,90)+'…':entry.headline}</p></button>)}</div>:<p className="research-quiet-message">尚无进度记录。课题建立后，可以随时记录完成的工作和下一步。</p>}
 </section><aside className="research-writing-recent"><div className="academic-section-title"><h2>最近论文<span>{active.length}</span></h2><button onClick={()=>onNavigate('/papers')}>全部<ArrowUpRight size={13}/></button></div>{recent.length?recent.map(p=><button className="academic-recent-item" key={p.id} onClick={()=>onNavigate(`/papers/${encodeURIComponent(p.id)}/writing`)}><BookOpen size={17}/><span><strong>{p.title}</strong><small>{STAGE_LABELS[p.stage]} · {prettyDate(p.lastEditedAt||p.updatedAt)}</small></span><ArrowUpRight size={14}/></button>):<p className="research-quiet-message">已有研究方案后，可在这里建立或导入论文。</p>}<p className="research-context-note">课题与论文可以独立建立，再按需要关联。</p></aside></div>
 <details className="research-conferences"><summary>会议与投稿时间线<span>查看会议节点与截止时间</span></summary><ConferenceCountdown papers={papers}/></details>
 </section>;
}
