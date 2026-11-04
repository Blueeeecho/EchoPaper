import test from 'node:test';
import assert from 'node:assert/strict';
import type {TrackedConference} from '../shared/conference-timeline';
import {beijingToday,milestoneInput,milestoneTime,nextTimelineColor,timelineAxis,timelineEvents} from '../src/academic/conferenceTimelineData';

const conference=(id:string,label:string,at:string,enabled=true):TrackedConference=>({id,title:id,year:2027,color:'#365c98',enabled,paperIds:[],milestones:[{id:'node',label,at}]});
test('timeline starts at the Beijing calendar day and date-only events retain day precision',()=>{
 const now=Date.parse('2026-10-25T02:00:00Z');
 assert.equal(new Date(beijingToday(now)).toISOString(),'2026-10-24T16:00:00.000Z');
 assert.equal(milestoneInput('2026-11-01T01:30:00.000Z'),'2026-11-01T09:30');
 assert.equal(milestoneTime({id:'r',label:'出分',date:'2026-11-01',at:''}),Date.parse('2026-10-31T16:00:00Z'));
});
test('axis positions reflect actual dates from today through the last conference result',()=>{
 const now=Date.parse('2026-10-25T02:00:00Z'),conferences=[conference('A','Rebuttal 结束','2026-10-26T16:00:00Z'),conference('B','最终决定','2026-11-03T16:00:00Z'),conference('past','出分','2026-10-20T00:00:00Z'),conference('hidden','出分','2026-10-28T00:00:00Z',false),conference('after-result','终稿','2026-12-01T00:00:00Z')];
 const axis=timelineAxis({revision:1,conferences},now);
 assert.equal(axis.provisional,false);assert.equal(axis.end,Date.parse('2026-11-03T16:00:00Z'));
 assert.deepEqual(axis.events.map(event=>event.conference.id),['A','B']);
 assert.ok(Math.abs(axis.events[0].position-.2)<.001);assert.equal(axis.events[1].position,1);
 assert.deepEqual(timelineEvents({revision:1,conferences},now).map(event=>event.conference.id),['A','B','after-result']);
});
test('unannounced results stay provisional and automatically assigned conference colors differ',()=>{
 const tracked=conference('A','Rebuttal 结束','2026-11-01T00:00:00Z');const axis=timelineAxis({revision:1,conferences:[tracked]},Date.parse('2026-10-25T00:00:00Z'));
 assert.equal(axis.provisional,true);assert.equal(axis.pending.length,1);assert.notEqual(nextTimelineColor([tracked]),tracked.color);
});

test('three clustered WWW dates remain three visible labels with all four milestones on a narrow axis',()=>{
 const www=conference('WWW','出分','2026-12-15T00:00:00Z');www.milestones.push({id:'start',label:'Rebuttal 开始',at:'2026-12-15T00:00:00Z'},{id:'end',label:'Rebuttal 结束',at:'2026-12-20T00:00:00Z'},{id:'decision',label:'最终决定',at:'2027-01-04T00:00:00Z'});
 const axis=timelineAxis({revision:1,conferences:[www]},Date.parse('2026-10-25T00:00:00Z'),455);
 assert.equal(axis.labels.length,3);assert.equal(axis.labels.flatMap(label=>label.events).length,4);
 assert.deepEqual(axis.labels.map(label=>label.events.map(event=>event.milestone.id)),[['node','start'],['end'],['decision']]);
 for(const lane of [0,1]){const labels=axis.labels.filter(label=>label.lane===lane);for(let i=0;i<labels.length;i++){const label=labels[i];assert.ok(label.position*455-label.width/2>=0);assert.ok(label.position*455+label.width/2<=455);if(i)assert.ok((label.position-labels[i-1].position)*455>=label.width);}}
});
