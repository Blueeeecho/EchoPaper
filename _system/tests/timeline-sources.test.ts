import test from 'node:test';
import assert from 'node:assert/strict';
import type {ConferenceEdition,ConferenceResponse} from '../shared/conference-types.ts';
import {createTimelineSourceService,parseOfficialTimeline} from '../server/workspace/timeline-sources.ts';
const round={id:'www2027:round-1',label:'第 1 轮',rawDeadline:'2026-07-27 23:59:59',deadlineAt:'2026-07-28T11:59:59.000Z',sourceTimezone:'AoE',notes:[]};
const edition:ConferenceEdition={id:'www2027',title:'WWW',description:'The Web Conference',year:2027,officialUrl:'https://www2027.example.org/',rounds:[round]};
const html=`<h1>WWW 2027 Research Track</h1><table><tr><td>Initial reviews released</td><td>November 30, 2026</td></tr><tr><td>Author response period</td><td>December 1–7, 2026</td></tr><tr><td>Acceptance notification</td><td>January 12, 2027</td></tr><tr><td>Camera-ready deadline</td><td>February 8, 2027</td></tr></table>`;
function response(conferences:ConferenceEdition[]):ConferenceResponse{return{conferences,sourceUrl:'https://ccfddl.top/',datasetUrl:'https://ccfddl.com/conference/allconf.yml',fetchedAt:'2026-10-25T00:00:00Z',stale:false,total:conferences.length};}
const publicLookup=async()=>[{address:'93.184.216.34',family:4}];

test('official date rows produce source-linked calendar nodes without inventing hours',()=>{
 const nodes=parseOfficialTimeline(html,edition.officialUrl!,edition,round);
 assert.deepEqual(nodes.map(node=>[node.id,node.date,node.at]),[['reviews','2026-11-30',''],['rebuttal_start','2026-12-01',''],['rebuttal_end','2026-12-07',''],['decision','2027-01-12',''],['camera_ready','2027-02-08','']]);
 assert.ok(nodes.every(node=>node.sourceUrl===edition.officialUrl));
 assert.deepEqual(parseOfficialTimeline(html.replace(/2027/g,'2025').replace(/2026/g,'2024'),'https://old.example.org/',edition,round),[]);
});

test('WWW full-paper calendar distinguishes day-first ranges and other tracks',()=>{
 const page='<h1>WWW 2027</h1><h3>Research &amp; Industry Track Papers</h3><table><tr><td>Result Release</td><td>15 December 2026</td></tr><tr><td>Rebuttal Period</td><td>15-20 December 2026</td></tr><tr><td>Notification</td><td>4 January 2027</td></tr><tr><td>Final Version Deadline</td><td>31 January 2027</td></tr></table><h3>Short Papers</h3><table><tr><td>Notification</td><td>5 January 2027</td></tr></table>';
 assert.deepEqual(parseOfficialTimeline(page,edition.officialUrl!,edition,round).map(node=>[node.id,node.date]),[['reviews','2026-12-15'],['rebuttal_start','2026-12-15'],['rebuttal_end','2026-12-20'],['decision','2027-01-04'],['camera_ready','2027-01-31']]);
});

test('AAAI updated feedback dates replace struck dates while the live camera-ready date survives nested markup',()=>{
 const aaai={...edition,id:'aaai27',title:'AAAI',officialUrl:'https://aaai.org/conference/aaai/aaai-27/'},page='<h1>AAAI 2027</h1><h2>Important Dates</h2><p><strong>September 24, 2026<br></strong>Notification of Phase 1 rejections</p><p><strong><s>October 19-25, 2026</s></strong><br><strong>October 24-31, 2026<br></strong>Author feedback window</p><p><span style="text-decoration: line-through">November 16, 2026</span><strong>November 30, 2026<br></strong>Notification of final acceptance or rejection (Main Technical Track)</p><p><strong><strong>December 14, 2026</strong><s><br></s></strong>Submission of camera-ready files (Main Technical Track)</p>';
 const nodes=parseOfficialTimeline(page,aaai.officialUrl,aaai,round);
 assert.deepEqual(nodes.map(node=>[node.id,node.date]),[['rebuttal_start','2026-10-24'],['rebuttal_end','2026-10-31'],['decision','2026-11-30'],['camera_ready','2026-12-14']]);assert.ok(!JSON.stringify(nodes).includes('October 19'));assert.ok(!JSON.stringify(nodes).includes('November 16'));
});

test('resolver follows bounded official date links, caches results, and refreshes explicitly',async()=>{
 let requests=0;const service=createTimelineSourceService('/unused',{lookup:publicLookup,conferences:{query:async()=>response([edition])},fetcher:async url=>{requests++;if(String(url).endsWith('/dates'))return new Response(html);return new Response('<h1>WWW 2027</h1><a href="/dates">Important dates</a><a href="http://127.0.0.1/secret">Research track</a>');}});
 const resolved=await service.resolve({conferenceId:'www2027'});assert.equal(resolved.sourceStatus,'ready');assert.equal(resolved.roundId,round.id);assert.equal(resolved.milestones.length,5);assert.equal(requests,2);assert.deepEqual(resolved.sourceUrls,[edition.officialUrl,'https://www2027.example.org/dates']);
 assert.deepEqual(await service.resolve({conferenceId:'www2027'}),resolved);assert.equal(requests,2);await service.resolve({conferenceId:'www2027',refresh:true});assert.equal(requests,4);
});

test('multiple rounds require explicit identity and another cycle never supplies its dates',async()=>{
 const multi={...edition,rounds:[round,{...round,id:'www2027:round-2',deadlineAt:'2026-10-27T11:59:59Z'}]},page='<h1>WWW 2027</h1><h2>October cycle</h2><p>Initial reviews released November 30, 2026</p><h2>July cycle</h2><p>Initial reviews released September 1, 2026</p>';
 const service=createTimelineSourceService('/unused',{lookup:publicLookup,conferences:{query:async()=>response([multi])},fetcher:async()=>new Response(page)});
 await assert.rejects(service.resolve({conferenceId:'www2027'}),/多个投稿轮次/);await assert.rejects(service.resolve({conferenceId:'www2027',roundId:'wrong'}),/轮次/);
 const result=await service.resolve({conferenceId:'www2027',roundId:round.id});assert.equal(result.sourceStatus,'partial');assert.equal(result.milestones[0].date,'2026-09-01');
});

test('unpublished dates and nonpublic origins remain unavailable without unsafe fetches',async()=>{
 let requests=0;for(const officialUrl of ['http://127.0.0.1/private','https://conference.example.org/']){
  const service=createTimelineSourceService('/unused',{lookup:async()=>[{address:'192.168.1.2',family:4}],conferences:{query:async()=>response([{...edition,officialUrl}])},fetcher:async()=>{requests++;return new Response(html);}});
  const result=await service.resolve({conferenceId:'www2027'});assert.equal(result.sourceStatus,'unavailable');assert.deepEqual(result.milestones,[]);
 }
 assert.equal(requests,0);const service=createTimelineSourceService('/unused',{lookup:publicLookup,conferences:{query:async()=>response([edition])},fetcher:async()=>new Response('<h1>WWW 2027</h1><p>Reviews release: TBD</p>')});assert.deepEqual((await service.resolve({conferenceId:'www2027'})).milestones,[]);
 await assert.rejects(service.resolve({conferenceId:'unknown'}),/会议年份/);
});
