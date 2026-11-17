import test from 'node:test';
import assert from 'node:assert/strict';
import type {ResearchTopic} from '../shared/workspace-types';
import type {Project} from '../shared/types';
import {currentResearchTopic,withResearchScope,continueResearch} from '../src/academic/researchContext';

const topic=(id:string,extra:Partial<ResearchTopic>={}):ResearchTopic=>({id,title:id,description:'',paperIds:[],resourceIds:[],presentationIds:[],archived:false,revision:1,createdAt:'',updatedAt:'',...extra});
const paper=(id:string,extra:Partial<Project>={})=>({id,...extra}) as Project;

test('explicit research scope wins and missing or archived topics never fall back to another topic',()=>{
 const topics=[topic('a'),topic('b'),topic('old',{archived:true})];
 assert.equal(currentResearchTopic({section:'results',topicId:'b'},'a',topics)?.id,'b');
 assert.equal(currentResearchTopic({section:'results'},'b',topics)?.id,'b');
 assert.equal(currentResearchTopic({section:'results',topicId:'missing'},'a',topics),undefined);
 assert.equal(currentResearchTopic({section:'results'},'old',topics),undefined);
 assert.equal(currentResearchTopic({section:'results'},undefined,topics),undefined);
});

test('scope follows research navigation without changing an explicit target or independent paper',()=>{
 assert.deepEqual(withResearchScope({section:'library',search:'agent'},'b'),{section:'library',search:'agent',topicId:'b'});
 assert.deepEqual(withResearchScope({section:'topics',topicId:'a'},'b'),{section:'topics',topicId:'a'});
 assert.deepEqual(withResearchScope({section:'papers',paperId:'standalone'},'b'),{section:'papers',paperId:'standalone'});
 assert.deepEqual(withResearchScope({section:'home'},'b'),{section:'home'});
});

test('continue writing selects a sole active linked paper and never an unrelated or archived paper',()=>{
 const t=topic('b',{stage:'writing',paperIds:['p','old']});
 assert.deepEqual(continueResearch(t,[paper('unrelated'),paper('old',{archived:true}),paper('p')]),{path:'/papers/p/writing',label:'继续写作'});
 assert.deepEqual(continueResearch(t,[paper('old',{archived:true})]),{path:'/topics?topic=b',label:'关联论文'});
 assert.deepEqual(continueResearch({...t,paperIds:['p','q']},[paper('p'),paper('q')]),{path:'/topics?topic=b',label:'选择关联论文'});
 assert.deepEqual(continueResearch(topic('b',{stage:'experiments'}),[]),{path:'/experiments?topic=b',label:'继续研究'});
});
