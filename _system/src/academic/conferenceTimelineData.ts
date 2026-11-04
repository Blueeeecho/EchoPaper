import type {ConferenceMilestone,ConferenceTimeline,TrackedConference} from '../../shared/conference-timeline';

export const TIMELINE_COLORS=['#365c98','#7b4294','#a14d2d','#1e7473','#914865','#655d24','#326a48','#85553c','#4d5a9b','#8e3f53','#396a7c','#74517a'];
const DAY=86400000;
export function milestoneInput(at:string):string {
 if(!at||!Number.isFinite(Date.parse(at)))return '';
 return new Date(Date.parse(at)+8*3600000).toISOString().slice(0,16);
}
export function milestoneTime(milestone:ConferenceMilestone):number {
 return milestone.at?Date.parse(milestone.at):milestone.date?Date.parse(`${milestone.date}T00:00:00+08:00`):NaN;
}
export function milestoneLabel(milestone:ConferenceMilestone):string {
 return milestone.at?milestoneInput(milestone.at).replace('T',' '):milestone.date||'待公布';
}
export function beijingToday(now:number):number{return Math.floor((now+8*3600000)/DAY)*DAY-8*3600000;}
export function timelineEvents(timeline:ConferenceTimeline,now:number){
 const start=beijingToday(now);
 return timeline.conferences.filter(conference=>conference.enabled).flatMap(conference=>conference.milestones.map(milestone=>({conference,milestone,at:milestoneTime(milestone)})).filter(event=>Number.isFinite(event.at)&&event.at>=start)).sort((a,b)=>a.at-b.at||a.conference.title.localeCompare(b.conference.title));
}
export const isResultMilestone=(milestone:ConferenceMilestone)=>/出分|最终决定|录用|审稿结果|结果通知|notification|decision|acceptance/i.test(milestone.label);
export function timelineAxis(timeline:ConferenceTimeline,now:number,width=640){
 const start=beijingToday(now),future=timelineEvents(timeline,now),results=future.filter(event=>isResultMilestone(event.milestone));
 const lastResult=results.at(-1),end=Math.max(start+DAY,lastResult?.at||future.at(-1)?.at||start+30*DAY);
 const enabled=timeline.conferences.filter(conference=>conference.enabled),pending=enabled.filter(conference=>!conference.milestones.some(m=>isResultMilestone(m)&&Number.isFinite(milestoneTime(m))));
 const events=future.filter(event=>event.at<=end).map(event=>({...event,position:(event.at-start)/(end-start)}));
 // Group matching dates, never merely because several dates lie near the end.
 const byDate=new Map<number,typeof events>();
 for(const event of events){const group=byDate.get(event.at)||[];group.push(event);byDate.set(event.at,group);}
 const groups=[...byDate.values()],maxGroups=Math.max(6,Math.floor(width/100)*2);
 while(groups.length>maxGroups){let nearest=0,gap=Infinity;for(let i=0;i<groups.length-1;i++){const distance=groups[i+1][0].at-groups[i].at(-1)!.at;if(distance<gap){gap=distance;nearest=i;}}groups.splice(nearest,2,[...groups[nearest],...groups[nearest+1]]);}
 const perLane=Math.max(1,Math.ceil(groups.length/2)),spacing=6,labelWidth=Math.min(140,(width-spacing*(perLane-1))/perLane);
 const labels=groups.map((items,column)=>{const anchor=items.reduce((sum,event)=>sum+event.position,0)/items.length;return{column,position:anchor,anchor,lane:column%2,events:items,width:labelWidth};});
 // Pack each lane independently. Leader lines retain exact temporal anchors.
 for(const lane of [0,1]){const items=labels.filter(label=>label.lane===lane),half=labelWidth/2;for(let i=0;i<items.length;i++){const wanted=Math.max(half,Math.min(width-half,items[i].anchor*width));items[i].position=Math.max(wanted,i?items[i-1].position+labelWidth+spacing:half);}if(items.at(-1)&&items.at(-1)!.position>width-half){items.at(-1)!.position=width-half;for(let i=items.length-2;i>=0;i--)items[i].position=Math.min(items[i].position,items[i+1].position-labelWidth-spacing);}for(const item of items)item.position/=width;}
 return{start,end,events,labels,lastResult,provisional:!lastResult,pending};
}
export function nextTimelineColor(conferences:TrackedConference[]):string {
 const used=new Set(conferences.map(c=>c.color.toLowerCase()));return TIMELINE_COLORS.find(color=>!used.has(color))||TIMELINE_COLORS[conferences.length%TIMELINE_COLORS.length];
}
