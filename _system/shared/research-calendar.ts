import type {ResearchWorkTarget} from './research-targets';
import type {ResearchTopic} from './workspace-types';

export const RESEARCH_DAY_ZONE='Asia/Shanghai';
export function validResearchDay(value:unknown):value is string {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const date=new Date(value+'T12:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
export function researchDay(value:string|Date):string {
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
 const parts=new Intl.DateTimeFormat('en',{timeZone:RESEARCH_DAY_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
 const get=(type:string)=>parts.find(p=>p.type===type)?.value||'';
 return `${get('year')}-${get('month')}-${get('day')}`;
}
export function shiftResearchDay(day:string,amount:number):string {
 const date=new Date(`${day}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+amount);return date.toISOString().slice(0,10);
}
export function progressNextSteps(value:string):string[] {
 // Strip list markers, retaining the actual text and order; no model inference.
 return value.split(/\r?\n/).map(v=>v.trim().replace(/^(?:[-*•]\s+(?:\[[ xX]\]\s*)?|\d+[.、)）]\s*)/,'').trim()).filter(Boolean);
}
export interface ResearchDayRecord {topicId:string;topicTitle:string;entryId:string;day:string;content:string;headline:string;createdAt:string;amended:boolean}
export interface ResearchDayTask {id:string;topicId:string;topicTitle:string;entryId:string;index:number;day:string;text:string;done:boolean;target?:ResearchWorkTarget}
export function researchCalendar(topics:ResearchTopic[]):{records:ResearchDayRecord[];tasks:ResearchDayTask[]} {
 const records:ResearchDayRecord[]=[],tasks:ResearchDayTask[]=[];
 for(const topic of topics){
  const entries=topic.progressEntries||[],byId=new Map(entries.map(e=>[e.id,e]));
  const amendedIds=new Set(entries.flatMap(e=>e.amendsId?[e.amendsId]:[]));
  for(const entry of entries){
   if(entry.supersededBy||amendedIds.has(entry.id))continue;
   let original=entry;const visited=new Set([entry.id]);
   while(original.amendsId){const parent=byId.get(original.amendsId);if(!parent||visited.has(parent.id))break;visited.add(parent.id);original=parent;}
   const day=entry.day||original.day||researchDay(original.createdAt);if(!day)continue;
   if(entry.kind==='task'){
    const id=`${entry.id}:0`;
    tasks.push({id,topicId:topic.id,topicTitle:topic.title,entryId:entry.id,index:0,day,text:entry.content,done:topic.dailyTaskStates?.[id]?.done===true,...(topic.dailyTaskStates?.[id]?.target?{target:topic.dailyTaskStates[id].target}:{})});
    continue;
   }
   const clean=entry.content.replace(/^[#\s]+/,'').split(/\n\s*\n/)[0].replace(/\s+/g,' ').trim();
   records.push({topicId:topic.id,topicTitle:topic.title,entryId:entry.id,day,content:entry.content,headline:clean.length>160?clean.slice(0,160)+'…':clean,createdAt:entry.createdAt,amended:entry.id!==original.id});
   progressNextSteps(entry.nextStep).forEach((text,index)=>{
    const id=`${entry.id}:${index}`;
    tasks.push({id,topicId:topic.id,topicTitle:topic.title,entryId:entry.id,index,day:shiftResearchDay(day,1),text,done:topic.dailyTaskStates?.[id]?.done===true,...(topic.dailyTaskStates?.[id]?.target?{target:topic.dailyTaskStates[id].target}:{})});
   });
  }
 }
 records.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.entryId.localeCompare(b.entryId));
 return {records,tasks};
}
export function researchMonthDays(month:string):string[]{
 const first=`${month}-01`,date=new Date(first+'T12:00:00Z');
 const mondayOffset=(date.getUTCDay()+6)%7;
 return Array.from({length:42},(_,i)=>shiftResearchDay(first,i-mondayOffset));
}
export function researchDayReport(day:string,topics:ResearchTopic[]):string {
 const {records,tasks}=researchCalendar(topics),next=shiftResearchDay(day,1);
 const work=records.filter(r=>r.day===day),today=tasks.filter(t=>t.day===day),tomorrow=tasks.filter(t=>t.day===next);
 const taskLines=(list:ResearchDayTask[])=>list.length?list.map(t=>`- [${t.done?'x':' '}] ${t.text}（${t.topicTitle}）`).join('\n'):'暂无已记录待办。';
 return `# ${day} 日报\n\n按北京时间归集，依据已保存的进展记录；摘要为原文摘录。\n\n## 当日进展\n\n${work.length?work.map(r=>`### ${r.topicTitle}\n\n${r.content}\n\n来源记录：${r.entryId}${r.amended?'（已更正，按原日期归集）':''}`).join('\n\n'):'当天没有已保存进展。'}\n\n## 当日待办\n\n${taskLines(today)}\n\n## ${next} 待办\n\n${taskLines(tomorrow)}\n`;
}
