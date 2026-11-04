export interface ConferenceMilestone {id:string;label:string;at:string;date?:string;note?:string;sourceUrl?:string}
export type TimelineSourceStatus='ready'|'partial'|'unavailable';
export interface ResolvedConferenceTimeline {conferenceId:string;title:string;year:number;roundId?:string;roundLabel?:string;officialUrl?:string;milestones:ConferenceMilestone[];sourceStatus:TimelineSourceStatus;sourceUrls:string[];warning?:string;fetchedAt:string}
export interface TrackedConference {id:string;conferenceId?:string;title:string;year:number;roundId?:string;roundLabel?:string;officialUrl?:string;color:string;enabled:boolean;paperIds:string[];milestones:ConferenceMilestone[];sourceStatus?:TimelineSourceStatus;sourceUrls?:string[];warning?:string;fetchedAt?:string}
export interface ConferenceTimeline {revision:number;conferences:TrackedConference[]}
