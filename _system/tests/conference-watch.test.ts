import test from 'node:test';
import assert from 'node:assert/strict';
import {buildConferenceEntries, normaliseWatchPreferences, safeConferenceUrl} from '../src/academic/conferenceWatch.ts';
import type {ConferenceEdition} from '../shared/conference-types.ts';

const now=Date.parse('2026-10-24T00:00:00Z');
function edition(id:string,ccf:string,days:number,abstractDays?:number):ConferenceEdition{return{id,title:id,description:'',year:2027,ccf,officialUrl:'https://example.org/'+id,rounds:[{id:id+':r1',label:'第 1 轮',rawDeadline:'published',deadlineAt:new Date(now+days*86400000).toISOString(),deadlineTimezone:'Etc/GMT+12',sourceTimezone:'AoE',notes:[],...(abstractDays===undefined?{}:{rawAbstractDeadline:'published',abstractDeadlineAt:new Date(now+abstractDays*86400000).toISOString()})}]};}
test('all future body deadlines are shown, including closed abstracts; missing and expired bodies are excluded',()=>{
 const later=edition('later','A',5),early=edition('early','B',1),closed=edition('closed','A',2,-1),tbd=edition('tbd','C',3);
 tbd.rounds[0].deadlineAt=undefined;
 later.rounds.push({...later.rounds[0],id:'later:r2',deadlineAt:new Date(now+8*86400000).toISOString()});
 const result=buildConferenceEntries([later,early,closed,tbd,edition('expired','A',-1)],normaliseWatchPreferences(null),now);
 assert.deepEqual(result.entries.map(x=>x.edition.id),['early','closed','later']);
 assert.equal(buildConferenceEntries([early],normaliseWatchPreferences(null),now+86400000).entries.length,0);
});
test('pins override rank filters, keep deadline order and expose closed abstract status',()=>{
 const preferences=normaliseWatchPreferences({ranks:['A'],pinned:[{id:'C','label':'C 2027'},{id:'closed','label':'closed 2027'},{id:'missing','label':'missing 2027'}]});
 const result=buildConferenceEntries([edition('A','A',1),edition('C','C',4),edition('closed','B',2,-1)],preferences,now);
 assert.deepEqual(result.entries.map(x=>x.edition.id),['closed','C','A']);assert.equal(result.entries[0].prerequisite,'closed');assert.deepEqual(result.hiddenPinned.map(x=>x.id),['missing']);
 assert.equal(buildConferenceEntries([edition('A','A',1)],normaliseWatchPreferences({ranks:[],pinned:[]}),now).entries.length,0);
});
test('nearest future body is used regardless of abstract status and unknown abstracts remain labelled',()=>{
 const item=edition('multi','A',2,-1);item.rounds.push({...item.rounds[0],id:'multi:r2',deadlineAt:new Date(now+8*86400000).toISOString(),abstractDeadlineAt:new Date(now+6*86400000).toISOString()});
 assert.equal(buildConferenceEntries([item],normaliseWatchPreferences(null),now).entries[0].round.id,'multi:r1');
 const unknown=edition('unknown','C',2);unknown.rounds[0].rawAbstractDeadline='TBD';
 assert.equal(buildConferenceEntries([unknown],normaliseWatchPreferences(null),now).entries[0].prerequisite,'unknown');
 assert.equal(buildConferenceEntries([unknown],normaliseWatchPreferences({pinned:[{id:'unknown',label:'unknown'}]}),now).entries[0].prerequisite,'unknown');
});
test('named search matches across rank filters and preserves abstract status',()=>{
 const item=edition('registered','A',2,-1),preferences=normaliseWatchPreferences(null);
 assert.equal(buildConferenceEntries([item],preferences,now).entries.length,1);
 const found=buildConferenceEntries([item],preferences,now,'registered');assert.equal(found.entries[0].prerequisite,'closed');
 assert.equal(buildConferenceEntries([item],{...preferences,ranks:['B']},now,'registered').entries.length,1);
});
test('paper submission targets are deduplicated, highlighted and pinned ahead of manual pins',()=>{
 const www=edition('WWW','A',3,-1),manual=edition('manual','C',1),preferences=normaliseWatchPreferences({ranks:['C'],pinned:[{id:'manual',label:'manual'}]});
 const source={conferenceId:'WWW',roundId:'WWW:r1',sourceUrl:'https://ccfddl.top/',year:2027,fetchedAt:new Date(now).toISOString()};
 const entries=buildConferenceEntries([manual,www],preferences,now,'',[{id:'paper1',venue:'WWW 2027',deadlineSource:source},{id:'paper2',venue:'WWW 2027',deadlineSource:source},{id:'archived',venue:'WWW 2027',archived:true,deadlineSource:source}]).entries;
 assert.deepEqual(entries.map(e=>e.edition.id),['WWW','manual']);assert.deepEqual(entries[0].submissionPaperIds,['paper1','paper2']);assert.equal(entries[0].pinned,true);
});
test('preferences validate persisted input and external links allow only HTTP(S)',()=>{
 assert.deepEqual(normaliseWatchPreferences('bad').ranks,['A','B','C']);
 assert.deepEqual(normaliseWatchPreferences({ranks:['B','B','X'],pinned:[{id:'x',label:'X'},{id:'x',label:'duplicate'},null]}),{ranks:['B'],pinned:[{id:'x',label:'X'}]});
 assert.equal(safeConferenceUrl('javascript:alert(1)'),undefined);assert.equal(safeConferenceUrl('https://name:secret@example.org'),undefined);assert.equal(safeConferenceUrl('https://example.org/2027'),'https://example.org/2027');
});
