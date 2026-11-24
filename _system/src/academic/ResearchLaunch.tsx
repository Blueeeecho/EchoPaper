import {lazy,Suspense,useState} from 'react';
import {ArrowRight,ArrowUpRight,BookOpen,CalendarDays,FileText,FolderKanban} from 'lucide-react';
import {RESEARCH_STAGES,type WorkspaceOverview} from '../../shared/workspace-types';
import {STAGE_LABELS,type Project} from '../../shared/types';
import {prettyDate} from '../api';
import ContinueReading from './ContinueReading';
import ViewBoundary from './ViewBoundary';
import {continueResearch} from './researchContext';
import {readSession,workspaceSessionKey} from '../workspaceSession';
import {calendarWorkPath,resumeWork,todayWork,upcomingPaperDeadlines} from './todayWork';

const workViews={
 writing:'论文写作',reviews:'审稿与回复',submissions:'投稿快照',history:'版本记录',settings:'论文设置',backups:'备份与恢复',
};
const dayLabel=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'short',timeZone:'Asia/Shanghai'});
const ConferenceCountdown=lazy(()=>import('./ConferenceCountdown'));

export default function ResearchLaunch({overview,papers,loading,onNavigate,registerGuard}:{overview?:WorkspaceOverview;papers:Project[];loading:boolean;onNavigate:(path:string)=>void;registerGuard?:(guard:(()=>Promise<boolean>)|undefined)=>void}){
 const [showConferences,setShowConferences]=useState(false);
 const topics=(overview?.topics||[]).filter(topic=>!topic.archived).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 const work=todayWork(topics);
 const resume=resumeWork(papers,readSession(workspaceSessionKey));
 const recentTopic=topics[0];
 const resumePath=resume?.path||(recentTopic?continueResearch(recentTopic,papers).path:'/topics');
 const resumeTitle=resume?.paper.title||recentTopic?.title;
 const calendarPath='/progress?day='+work.day;
 const recent=papers.filter(paper=>!paper.archived&&!paper.trashed&&paper.id!==resume?.paper.id)
  .sort((a,b)=>(b.lastEditedAt||b.updatedAt).localeCompare(a.lastEditedAt||a.updatedAt)).slice(0,3);
 const deadlines=upcomingPaperDeadlines(papers);

 return <section className="academic-page academic-home research-launch">
  <header className="academic-home-intro">
   <h1>研究总览</h1>
   <time dateTime={work.day} title="北京时间">{dayLabel.format(new Date(work.day+'T12:00:00Z'))}</time>
  </header>

  {loading?<p className="research-quiet-message" role="status">正在读取工作台…</p>:<>
   {resumeTitle&&<section className="today-resume" aria-label="继续工作">
    <span className="home-resume-label">{resume?(resume.restored?'上次工作':'最近编辑'):'最近课题'}</span>
    <button className="home-resume-open" onClick={()=>onNavigate(resumePath)}>
     {resume?<FileText size={16}/>:<FolderKanban size={16}/>}
     <span className="today-resume-detail">
      <strong title={resumeTitle}>{resumeTitle}</strong>
      {resume&&<small title={resume.file}>{workViews[resume.view]}{resume.file&&' · '+resume.file.split('/').at(-1)}</small>}
     </span>
     <span className="home-resume-action">继续<ArrowRight size={15}/></span>
    </button>
   </section>}

   <div className="research-overview-grid">
    {overview&&<section className="research-projects" aria-label="当前课题和近期进展">
     <header className="academic-section-title">
      <h2>当前课题 <span>{topics.length}</span></h2>
      <button onClick={()=>onNavigate('/topics')}>全部课题<ArrowUpRight size={13}/></button>
     </header>
     {topics.length?<ul className="research-project-list">
      {topics.slice(0,4).map(topic=>{
       const latest=topic.progressEntries?.filter(entry=>!entry.supersededBy&&entry.kind!=='task').at(-1);
       const nextStep=latest?.nextStep?.trim();
       const topicPath='/topics?topic='+encodeURIComponent(topic.id);
       const next=continueResearch(topic,papers);
       return <li key={topic.id}>
        <article>
         <header>
          <h3><button className="home-topic-title" onClick={()=>onNavigate(topicPath)}>{topic.title}</button></h3>
          {topic.stage&&<span className="research-stage">{RESEARCH_STAGES[topic.stage]}</span>}
         </header>
         {(nextStep||topic.description)&&<p className="home-topic-context">{nextStep&&<strong>下一步</strong>}{nextStep||topic.description}</p>}
         <footer>
          <small>{topic.paperIds.length} 篇论文 · {topic.resourceIds.length} 份资料</small>
          {(next.path!==topicPath||topic.stage==='writing')&&<button onClick={()=>onNavigate(next.path)}>{next.label}<ArrowRight size={13}/></button>}
         </footer>
        </article>
       </li>;
      })}
     </ul>:<div className="research-start">
      <h3>还没有研究课题</h3>
      <button className="academic-primary" onClick={()=>onNavigate('/topics')}>进入课题<ArrowRight size={14}/></button>
     </div>}
     {work.records.length>0&&<section className="home-recent-progress">
      <header className="academic-section-title"><h2>最近进展</h2></header>
      <div className="research-recent-logs">{work.records.slice(0,2).map(entry=><button key={entry.entryId} onClick={()=>onNavigate(calendarWorkPath(entry.topicId,entry.day))}>
       <span>{entry.topicTitle}<time dateTime={entry.day}>{entry.day.slice(5).replace('-','/')}</time></span><p>{entry.headline.length>90?entry.headline.slice(0,90)+'…':entry.headline}</p>
      </button>)}</div>
     </section>}
    </section>}

    <aside className="research-reference-column" aria-label="今日工作与最近文献">
     <section className="research-today">
      <header className="academic-section-title">
       <h2>今日工作</h2>
       <button onClick={()=>onNavigate(calendarPath)}><CalendarDays size={14}/>工作日历</button>
      </header>
      <div className="home-agenda">
       {overview&&(work.tasks.length>0?<section className="today-tasks">
        <h3>待办 <span>{work.tasks.length}</span></h3>
        <ul>{work.tasks.slice(0,3).map(task=><li key={task.topicId+':'+task.id}>
         <button onClick={()=>onNavigate(calendarWorkPath(task.topicId,task.day))}>
          <span className="today-task-dot" aria-hidden="true"/><span><strong>{task.text}</strong><small>{task.topicTitle}</small></span><ArrowUpRight size={14}/>
         </button>
        </li>)}</ul>
        {work.tasks.length>3&&<button className="today-more" onClick={()=>onNavigate(calendarPath)}>查看全部待办<ArrowRight size={14}/></button>}
       </section>:<p className="research-quiet-message">今天没有未完成的待办</p>)}
       {deadlines.length>0&&<section className="today-deadlines">
        <h3>投稿截止</h3>
        <ul>{deadlines.map(item=><li key={item.paper.id}>
         <button onClick={()=>onNavigate('/papers/'+encodeURIComponent(item.paper.id)+'/settings')}>
          <strong>{item.paper.title}</strong><time dateTime={item.at}>{item.label} · 北京时间</time>
         </button>
         <a href={item.sourceUrl} target="_blank" rel="noreferrer">查看来源<ArrowUpRight size={12}/></a>
        </li>)}</ul>
       </section>}
      </div>
     </section>
     <ContinueReading onNavigate={onNavigate} registerGuard={registerGuard}/>
     {recent.length>0&&<section className="research-writing-recent">
      <header className="academic-section-title"><h2>其他近期论文</h2><button onClick={()=>onNavigate('/papers')}>全部论文<ArrowUpRight size={13}/></button></header>
      {recent.map(paper=><button className="academic-recent-item" key={paper.id} onClick={()=>onNavigate('/papers/'+encodeURIComponent(paper.id)+'/writing')}>
       <BookOpen size={16}/><span><strong>{paper.title}</strong><small>{STAGE_LABELS[paper.stage]} · {prettyDate(paper.lastEditedAt||paper.updatedAt)}</small></span><ArrowUpRight size={14}/>
      </button>)}
     </section>}
    </aside>
   </div>
   <details className="research-conferences" onToggle={event=>setShowConferences(event.currentTarget.open)}>
    <summary>会议与投稿时间线</summary>
    {showConferences&&<ViewBoundary fallback={<p className="research-quiet-message" role="alert">会议面板暂时无法打开。请刷新页面后重试。</p>}>
     <Suspense fallback={<p className="research-quiet-message" role="status">正在打开会议面板…</p>}><ConferenceCountdown papers={papers}/></Suspense>
    </ViewBoundary>}
   </details>
  </>}
 </section>;
}
