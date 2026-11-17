import type {Project} from '../../shared/types';
import type {ResearchTopic} from '../../shared/workspace-types';
import {formatDeadlineLocal} from '../../shared/deadline';
import {researchCalendar,researchDay,validResearchDay} from '../../shared/research-calendar';
import {normalizeWorkspaceSession} from '../workspaceSession';
import {academicPath} from './navigation';
import {safeConferenceUrl} from './conferenceWatch';
/** Read-only projections of saved data, without inferred dates or research status. */
export function todayWork(topics:ResearchTopic[],now=new Date()){
 const day=researchDay(now),calendar=researchCalendar(topics.filter(t=>!t.archived));
 return {day,tasks:calendar.tasks.filter(t=>t.day===day&&!t.done),records:calendar.records.filter(r=>validResearchDay(r.day)).sort((a,b)=>b.day.localeCompare(a.day)||b.createdAt.localeCompare(a.createdAt))};
}
export const calendarWorkPath=(topicId:string,day:string)=>academicPath({section:'progress',topicId,...(validResearchDay(day)?{day}:{})});
export function resumeWork(papers:Project[],rawSession:unknown){
 const active=papers.filter(p=>!p.archived&&!p.trashed),session=normalizeWorkspaceSession(rawSession);
 const saved=session&&active.find(p=>p.id===session.projectId);
 const paper=saved||[...active].sort((a,b)=>(b.lastEditedAt||b.updatedAt).localeCompare(a.lastEditedAt||a.updatedAt))[0];
 if(!paper)return;
 const view=saved?session!.view:'writing';
 return {paper,path:academicPath({section:'papers',paperId:paper.id,paperView:view}),file:saved?session!.path:'',restored:!!saved,view};
}
export function upcomingPaperDeadlines(papers:Project[],now=Date.now()){
 return papers.filter(p=>!p.archived&&!p.trashed).flatMap(p=>{
  // A recorded source never implies live official verification.
  const source=p.deadlineSource,url=safeConferenceUrl(source?.sourceUrl);
  if(!source||!url||!p.deadlineAt||Date.parse(p.deadlineAt)<now)return [];
  try{return [{paper:p,at:p.deadlineAt,label:formatDeadlineLocal(p.deadlineAt,'Asia/Shanghai').replace('T',' '),sourceUrl:url}];}catch{return [];}
 }).sort((a,b)=>a.at.localeCompare(b.at)).slice(0,3);
}
