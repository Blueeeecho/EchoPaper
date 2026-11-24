import type {ResearchTopic} from '../../shared/workspace-types';
import type {Project} from '../../shared/types';
import type {AcademicRoute} from './navigation';

export const researchContextKey='echopaper:research-context:v1';
export const hasResearchScope=(route:AcademicRoute)=>['topics','experiments','results','progress','library'].includes(route.section);

export function hubDataSources(route:AcademicRoute){
 const section=route.section;
 return {
  overview:section==='home'||hasResearchScope(route),
  papers:section==='home'||section==='topics'||(section==='papers'&&!!route.paperId),
  presentations:section==='topics',
 };
}

/** An invalid explicit deep link must not silently open a different project. */
export function currentResearchTopic(route:AcademicRoute,rememberedId:string|undefined,topics:readonly ResearchTopic[]){
 const id=route.topicId||rememberedId;
 return topics.find(topic=>topic.id===id&&!topic.archived);
}

export function withResearchScope(route:AcademicRoute,topicId:string|undefined):AcademicRoute {
 return hasResearchScope(route)&&!route.topicId&&topicId?{...route,topicId}:route;
}

/** Research and publication stages remain independent; continue to a real linked object. */
export function continueResearch(topic:ResearchTopic,papers:readonly Project[]):{path:string;label:string}{
 if(topic.stage==='writing'){
  const linked=papers.filter(p=>topic.paperIds.includes(p.id)&&!p.archived&&!p.trashed);
  if(linked.length===1)return{path:`/papers/${encodeURIComponent(linked[0].id)}/writing`,label:'继续写作'};
  return{path:`/topics?topic=${encodeURIComponent(topic.id)}`,label:linked.length?'选择关联论文':'关联论文'};
 }
 const section=topic.stage==='experiments'?'experiments':topic.stage==='results'?'results':'topics';
 return{path:`/${section}?topic=${encodeURIComponent(topic.id)}`,label:'继续研究'};
}
