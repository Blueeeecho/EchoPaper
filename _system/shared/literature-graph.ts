import type {ArticleAnalysis,LiteratureFact,AnalysisField} from './literature-analysis';
export interface LiteratureEntity {id:string;field:AnalysisField;label:string;references:{article:ArticleAnalysis;fact:LiteratureFact}[]}
export function entityName(fact:LiteratureFact){
 if(fact.entity?.trim())return fact.entity.trim();
 // Legacy analyses may combine a name and its explanation. Only split an explicit
 // leading name; preserve versions and ambiguous prose instead of fuzzy merging.
 const value=fact.value.trim(),prefix=value.split(/[：:]/)[0].trim();
 if(prefix!==value&&prefix.length<=80)return prefix;
 const lead=value.match(/^([A-Za-z0-9][A-Za-z0-9 ._+\/-]{0,79})(?=[\u3400-\u9fff（(，,；;]|$)/)?.[1]?.trim();
 return lead?.replace(/\s+(?:is|are|was|were|用于|用于评估)\b.*$/i,'').trim()||value;
}
export function literatureEntities(articles:ArticleAnalysis[],field:'all'|'model'|'dataset'|'method'='all'){
 const groups=new Map<string,LiteratureEntity>();
 for(const article of articles)for(const fact of article.facts){if(!fact.verified||!['model','dataset','method'].includes(fact.field)||field!=='all'&&fact.field!==field)continue;const label=entityName(fact);const id=`${fact.field}:${label.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()}`;const item=groups.get(id)||{id,field:fact.field,label,references:[]};item.references.push({article,fact});groups.set(id,item);}
 return[...groups.values()].sort((a,b)=>new Set(b.references.map(r=>r.article.resourceId)).size-new Set(a.references.map(r=>r.article.resourceId)).size||a.field.localeCompare(b.field)||a.label.localeCompare(b.label));
}
export interface NetworkPoint {id:string;x:number;y:number}
/** Deterministic spring layout: shared entities pull related papers into clusters. */
export function layoutLiteratureNetwork(ids:string[],links:{source:string;target:string}[]):NetworkPoint[]{
 const points=ids.map((id,i)=>({id,x:Math.cos(i*2.39996)*Math.sqrt(i+1)*30,y:Math.sin(i*2.39996)*Math.sqrt(i+1)*30})),byId=new Map(points.map(p=>[p.id,p]));
 for(let step=0;step<240;step++){
  const force=points.map(p=>({x:-p.x*.009,y:-p.y*.009}));
  for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){const dx=points[i].x-points[j].x,dy=points[i].y-points[j].y,d2=Math.max(36,dx*dx+dy*dy),f=1600/d2;force[i].x+=dx*f;force[i].y+=dy*f;force[j].x-=dx*f;force[j].y-=dy*f;}
  for(const link of links){const a=byId.get(link.source),b=byId.get(link.target);if(!a||!b)continue;const dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),f=(d-85)*.025;const i=points.indexOf(a),j=points.indexOf(b);force[i].x+=dx/d*f;force[i].y+=dy/d*f;force[j].x-=dx/d*f;force[j].y-=dy/d*f;}
  const cool=1-step/300;points.forEach((p,i)=>{p.x+=Math.max(-12,Math.min(12,force[i].x))*cool;p.y+=Math.max(-12,Math.min(12,force[i].y))*cool;});
 }
 return points;
}
