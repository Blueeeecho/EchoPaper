import test from 'node:test';
import assert from 'node:assert/strict';
import {todayWork,calendarWorkPath,resumeWork,upcomingPaperDeadlines} from '../src/academic/todayWork';
import {academicPath,academicRoute} from '../src/academic/navigation';
import type {ResearchTopic} from '../shared/workspace-types';
import type {Project} from '../shared/types';
const paper=(id:string,extra:Partial<Project>={}):Project=>({schemaVersion:1,id,title:id,stage:'writing',venue:'',deadline:'',targets:[],autoCompile:false,createdAt:'2026-01-01',updatedAt:'2026-11-01',...extra});
const topic=(id:string,extra:Partial<ResearchTopic>={}):ResearchTopic=>({id,title:id,description:'',paperIds:[],presentationIds:[],resourceIds:[],archived:false,revision:1,createdAt:'',updatedAt:'',...extra});
const session={version:1,screen:'project',projectId:'p',view:'reviews',path:'manuscript/intro.tex',targetId:'main',aiOpen:false,editorPercent:48};

test('home/calendar deep links round trip date and research scope, including leap days',()=>{
 for(const day of ['2026-11-06','2028-02-29']){
  const path=calendarWorkPath('topic-b',day);assert.equal(path,`/progress?topic=topic-b&day=${day}`);
  assert.deepEqual(academicRoute('#'+path),{section:'progress',topicId:'topic-b',day});
  assert.equal(academicPath(academicRoute(path)),path);
 }
 for(const day of ['2026-02-30','2027-02-29','2026-2-01','../../etc','2026-11-06T00:00Z','%E0%A4%A'])assert.equal(academicRoute(`/progress?topic=b&day=${day}`).day,undefined);
 assert.equal(academicRoute('/experiments?day=2026-11-06').day,undefined);
 assert.equal(academicPath({section:'progress',day:'2026-02-30'}),'/progress');
});
test('today work uses Beijing day and real unfinished tasks, excluding historical, done and archived entries',()=>{
 const entries=[{id:'prev',content:'yesterday progress',nextStep:'- Compare baseline',createdAt:'2026-11-05T12:00:00Z',day:'2026-11-05'},
 {id:'task',content:'today task',nextStep:'',createdAt:'2026-11-06T12:00:00Z',day:'2026-11-06',kind:'task' as const},
 {id:'past',content:'past task',nextStep:'',createdAt:'2026-11-05T12:00:00Z',day:'2026-11-05',kind:'task' as const}];
 const t=topic('b',{progressEntries:entries,dailyTaskStates:{'task:0':{done:true,updatedAt:''}}});
 const work=todayWork([t,topic('old',{archived:true,progressEntries:entries})],new Date('2026-11-05T16:00:00Z'));
 assert.equal(work.day,'2026-11-06');assert.deepEqual(work.tasks.map(t=>t.text),['Compare baseline']);assert.equal(work.records.length,1);
});
test('resume restores existing paper view/path and ignores missing, trashed, archived or unsafe saved projects',()=>{
 const papers=[paper('p'),paper('q',{lastEditedAt:'2026-11-05'}),paper('old',{archived:true}),paper('trash',{trashed:true})];
 const resume=resumeWork(papers,session)!;assert.equal(resume.path,'/papers/p/reviews');assert.equal(resume.file,'manuscript/intro.tex');
 for(const projectId of ['missing','old','trash','../etc']){const fallback=resumeWork(papers,{...session,projectId})!;assert.equal(fallback.path,'/papers/q/writing');assert.equal(fallback.file,'');assert.equal(fallback.restored,false);}
 assert.equal(resumeWork([],session),undefined);
 assert.equal(resumeWork(papers,{...session,path:'../private'})?.file,'');
});
test('upcoming deadlines require precise valid dates and safe recorded sources, never infer dates from legacy fields',()=>{
 const source={sourceUrl:'https://example.org/conference',conferenceId:'c',year:2026,roundId:'main',fetchedAt:'2026-11-01'};
 const valid=paper('p',{deadlineAt:'2026-11-07T00:00:00.000Z',deadlineSource:source});
 const result=upcomingPaperDeadlines([valid,paper('legacy',{deadline:'2026-11-08'}),paper('invalid',{deadlineAt:'2026-11-31T00:00:00Z',deadlineSource:source}),paper('unsafe',{...valid,id:'unsafe',deadlineSource:{...source,sourceUrl:'javascript:alert(1)'}}),paper('old',{...valid,id:'old',deadlineAt:'2026-11-01T00:00:00Z'}),paper('archived',{...valid,id:'archived',archived:true})],Date.parse('2026-11-06T00:00:00Z'));
 assert.deepEqual(result.map(r=>r.paper.id),['p']);assert.equal(result[0].label,'2026-11-07 08:00');
});
