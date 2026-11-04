import type {ConferenceMilestone,TrackedConference} from '../../shared/conference-timeline.ts';
import {HttpError} from '../security.ts';

function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'时间线记录必须是对象。');return value as Record<string,unknown>;}
function text(value:unknown,label:string,max:number,required=false):string{if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw new HttpError(400,`${label}无效。`);return value.trim();}
function id(value:unknown,label:string):string{const result=text(value,label,200,true);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result))throw new HttpError(400,`${label}无效。`);return result;}
function url(value:unknown,label:string):string|undefined{if(value===undefined||value==='')return undefined;const result=text(value,label,2000);try{const parsed=new URL(result);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw Error();}catch{throw new HttpError(400,`${label}必须为 HTTP(S) 地址。`);}return result;}
function optional(value:unknown,label:string,max:number):string|undefined{return value===undefined?undefined:text(value,label,max)||undefined;}
function date(value:unknown):string|undefined{if(value===undefined)return;const result=text(value,'节点日期',10,true),parsed=new Date(result+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(result)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==result)throw new HttpError(400,'节点日期无效。');return result;}
function at(value:unknown):string{
  if(value==='')return '';
  const result=text(value,'节点时间',80,true),match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(result);
  if(!match)throw new HttpError(400,'节点时间须包含明确时区；未知时间请留空。');
  const [,year,month,day,hour,minute,second='0',offset]=match,calendar=new Date(Date.UTC(+year,+month-1,+day)),time=new Date(result);
  if(calendar.getUTCFullYear()!==+year||calendar.getUTCMonth()!==+month-1||calendar.getUTCDate()!==+day||+hour>23||+minute>59||+second>59||!Number.isFinite(time.getTime())||(offset!=='Z'&&(+offset.slice(1,3)>23||+offset.slice(4)>59)))throw new HttpError(400,'节点时间无效。');
  return time.toISOString();
}

/** Dates are author-maintained facts, never inferred from the submission deadline. */
export function parseTimelineConferences(value:unknown):TrackedConference[]{
  if(!Array.isArray(value)||value.length>100)throw new HttpError(400,'时间线会议列表无效，最多 100 场。');
  const conferenceIds=new Set<string>();
  return value.map(raw=>{
    const input=object(raw),identity=id(input.id,'会议记录编号');if(conferenceIds.has(identity))throw new HttpError(400,'会议记录编号重复。');conferenceIds.add(identity);
    if(!Number.isInteger(input.year)||Number(input.year)<1900||Number(input.year)>2200)throw new HttpError(400,'会议年份无效。');
    if(typeof input.enabled!=='boolean')throw new HttpError(400,'会议展示状态无效。');
    if(typeof input.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(input.color))throw new HttpError(400,'会议颜色须为六位十六进制颜色。');
    if(!Array.isArray(input.paperIds)||input.paperIds.length>100)throw new HttpError(400,'关联论文列表无效。');const paperIds=[...new Set(input.paperIds.map(item=>id(item,'关联论文编号')))];
    if(!Array.isArray(input.milestones)||input.milestones.length>100)throw new HttpError(400,'会议节点列表无效，最多 100 个。');
    const milestoneIds=new Set<string>(),milestones:ConferenceMilestone[]=input.milestones.map(rawMilestone=>{const milestone=object(rawMilestone),identity=id(milestone.id,'节点编号');if(milestoneIds.has(identity))throw new HttpError(400,'会议内节点编号重复。');milestoneIds.add(identity);return{id:identity,label:text(milestone.label,'节点名称',120,true),at:at(milestone.at),date:date(milestone.date),note:optional(milestone.note,'节点说明',4000),sourceUrl:url(milestone.sourceUrl,'节点来源')};});
    if(input.sourceStatus!==undefined&&!['ready','partial','unavailable'].includes(String(input.sourceStatus)))throw new HttpError(400,'时间线来源状态无效。');
    if(input.sourceUrls!==undefined&&(!Array.isArray(input.sourceUrls)||input.sourceUrls.length>20))throw new HttpError(400,'时间线来源列表无效。');
    const sourceUrls=input.sourceUrls===undefined?undefined:(input.sourceUrls as unknown[]).map(value=>url(value,'时间线来源')).filter((value):value is string=>!!value),fetchedAt=input.fetchedAt===undefined?undefined:at(input.fetchedAt);
    return{id:identity,conferenceId:input.conferenceId===undefined?undefined:id(input.conferenceId,'来源会议编号'),title:text(input.title,'会议名称',200,true),year:input.year as number,roundId:input.roundId===undefined?undefined:id(input.roundId,'来源轮次编号'),roundLabel:optional(input.roundLabel,'会议轮次',160),officialUrl:url(input.officialUrl,'会议官网'),color:input.color.toLowerCase(),enabled:input.enabled,paperIds,milestones,sourceStatus:input.sourceStatus as TrackedConference['sourceStatus'],sourceUrls,warning:optional(input.warning,'来源说明',4000),fetchedAt};
  });
}
