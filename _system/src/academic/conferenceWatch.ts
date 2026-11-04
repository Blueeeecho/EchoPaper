import type {ConferenceEdition,ConferenceRound} from '../../shared/conference-types.ts';
import type {Project} from '../../shared/types.ts';
export type WatchRank='A'|'B'|'C';
export interface WatchPin {id:string;label:string}
export interface WatchPreferences {ranks:WatchRank[];pinned:WatchPin[]}
export const WATCH_STORAGE_KEY='echopaper:conference-watch:v1';
export function normaliseWatchPreferences(value:unknown):WatchPreferences {
 const v=value&&typeof value==='object'?value as Record<string,unknown>:{};
 const ranks:WatchRank[]=Array.isArray(v.ranks)?(['A','B','C'] as WatchRank[]).filter(r=>v.ranks instanceof Array&&v.ranks.includes(r)):['A','B','C'];
 const pinned:WatchPin[]=[],seen=new Set<string>();
 if(Array.isArray(v.pinned))for(const p of v.pinned.slice(0,1000)){if(p&&typeof p.id==='string'&&p.id.length>0&&p.id.length<=200&&typeof p.label==='string'&&!seen.has(p.id)){seen.add(p.id);pinned.push({id:p.id,label:p.label.slice(0,220)});}}
 return{ranks,pinned};
}
export function safeConferenceUrl(value?:string):string|undefined {try{const url=new URL(value||'');if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)return url.href;}catch{} }
export type AbstractStatus='open'|'closed'|'unknown';
function prerequisite(round:ConferenceRound,now:number):AbstractStatus {
 if(round.abstractDeadlineAt){const at=Date.parse(round.abstractDeadlineAt);return Number.isFinite(at)?at>now?'open':'closed':'unknown';}
 return round.rawAbstractDeadline?'unknown':'open';
}
export type SubmissionPaper=Pick<Project,'id'|'venue'|'deadlineSource'|'archived'|'trashed'>;
export interface WatchEntry {edition:ConferenceEdition;round:ConferenceRound;pinned:boolean;prerequisite:AbstractStatus;submissionPaperIds:string[]}
export function buildConferenceEntries(editions:ConferenceEdition[],preferences:WatchPreferences,now:number,query='',papers:SubmissionPaper[]=[]) {
 const pins=new Set(preferences.pinned.map(p=>p.id)),entries:WatchEntry[]=[],available=new Set<string>();
 const tokens=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
 for(const edition of editions){
  const rounds=edition.rounds.filter(r=>r.deadlineAt&&r.deadlineTimezone&&Number.isFinite(Date.parse(r.deadlineAt))&&Date.parse(r.deadlineAt)>now).sort((a,b)=>Date.parse(a.deadlineAt!)-Date.parse(b.deadlineAt!)||a.id.localeCompare(b.id));
  const linked=papers.filter(p=>!p.archived&&!p.trashed&&(p.deadlineSource?.conferenceId===edition.id||!p.deadlineSource?.conferenceId&&p.venue?.trim().toLowerCase()===`${edition.title} ${edition.year}`.toLowerCase()));
  const pinned=pins.has(edition.id)||linked.length>0;
  const round=rounds.find(r=>linked.some(p=>p.deadlineSource?.roundId===r.id))||rounds[0];if(!round)continue;available.add(edition.id);
  // A named search queries the source across grades; grade chips filter the feed.
  if(!pinned&&!tokens.length&&!preferences.ranks.includes(edition.ccf?.toUpperCase() as WatchRank))continue;
  const text=`${edition.title} ${edition.year} ${edition.description} ${edition.id}`.toLowerCase();if(!tokens.every(t=>text.includes(t)))continue;
  entries.push({edition,round,pinned,prerequisite:prerequisite(round,now),submissionPaperIds:linked.map(p=>p.id)});
 }
 entries.sort((a,b)=>Number(b.submissionPaperIds.length>0)-Number(a.submissionPaperIds.length>0)||Number(b.pinned)-Number(a.pinned)||Date.parse(a.round.deadlineAt!)-Date.parse(b.round.deadlineAt!)||a.edition.title.localeCompare(b.edition.title)||a.edition.id.localeCompare(b.edition.id));
 return{entries,hiddenPinned:preferences.pinned.filter(p=>!available.has(p.id))};
}
