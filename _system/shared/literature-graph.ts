import type {ArticleAnalysis,LiteratureFact,AnalysisField} from './literature-analysis';

export interface LiteratureEntity {
 id:string;
 field:AnalysisField;
 label:string;
 references:{article:ArticleAnalysis;fact:LiteratureFact}[];
}

export const KNOWLEDGE_RELATIONS={
 proposes:'提出方法',
 addresses:'针对问题',
 builds_on:'基于/改进',
 outperforms:'优于',
 evaluates_on:'评测于',
 evaluates_with_model:'在模型上评测',
 measures_with:'报告指标',
 compares_with:'对照',
} as const;

export const KNOWLEDGE_ENTITIES={
 paper:'论文',
 method:'方法或系统',
 problem:'研究问题',
 model:'模型',
 dataset:'数据集或基准',
 metric:'指标',
} as const;

export type KnowledgePredicate=keyof typeof KNOWLEDGE_RELATIONS;
export type KnowledgeEntityKind=keyof typeof KNOWLEDGE_ENTITIES;
export type KnowledgeRelationSource='local'|'analysis'|'ai';

export interface KnowledgeEntity {
 kind:Exclude<KnowledgeEntityKind,'paper'>;
 label:string;
}

export interface KnowledgeRelation {
 predicate:KnowledgePredicate;
 subject?:KnowledgeEntity;
 object:KnowledgeEntity;
 page:number;
 quote:string;
 translation?:string;
 source?:KnowledgeRelationSource;
}

export interface KnowledgePaper {
 resourceId:string;
 title:string;
 sourceHash:string;
 textSource?:'ocr'|'pdf';
 textError?:boolean;
 analysisFused?:boolean;
 aiExtracted?:boolean;
 aiModel?:string;
 relations:KnowledgeRelation[];
}

export interface KnowledgeGraphData {
 papers:KnowledgePaper[];
 aiConfigured?:boolean;
 aiUpdatedAt?:string;
}

export const knowledgeName=(value:string)=>value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');

const ALIAS_RULES:[RegExp,string|((match:string,...args:string[])=>string)][]=[
 [/^gpt[\s-]*4o(?:[\s-]+(mini|latest|audio|realtime))?$/i,(_m,s)=>s?`GPT-4o-${s.toLowerCase()}`:'GPT-4o'],
 [/^gpt[\s-]*4\.5$/i,'GPT-4.5'],
 [/^gpt[\s-]*4\.1(?:[\s-]+(mini|nano))?$/i,(_m,s)=>s?`GPT-4.1-${s.toLowerCase()}`:'GPT-4.1'],
 [/^gpt[\s-]*4(?:[\s-]+(turbo|vision|v))?$/i,(_m,s)=>s?`GPT-4-${s.toLowerCase()}`:'GPT-4'],
 [/^gpt[\s-]*3\.5(?:[\s-]+(turbo))?$/i,(_m,s)=>s?`GPT-3.5-${s.toLowerCase()}`:'GPT-3.5'],
 [/^gpt[\s-]*5(?:[\s-]+(mini|nano|pro))?$/i,(_m,s)=>s?`GPT-5-${s.toLowerCase()}`:'GPT-5'],
 [/^llama[\s-]*([234](?:\.\d+)?)(?:[\s-]+([A-Za-z0-9.+-]+(?:[\s-]+[A-Za-z0-9.+-]+)?))?$/i,(_m,v,rest)=>rest?`Llama-${v}-${rest.replace(/\s+/g,'-')}`:`Llama-${v}`],
 [/^qwen[\s-]*(\d+(?:\.\d+)?)(?:[\s-]+([A-Za-z0-9.+-]+(?:[\s-]+[A-Za-z0-9.+-]+)?))?$/i,(_m,v,rest)=>rest?`Qwen${v}-${rest.replace(/\s+/g,'-')}`:`Qwen${v}`],
 [/^deepseek[\s-]+(r1|v[23](?:\.\d+)?|coder|math|vl)(?:[\s-]+([A-Za-z0-9.+-]+))?$/i,(_m,v,rest)=>rest?`DeepSeek-${v.toUpperCase()}-${rest}`:`DeepSeek-${v.toUpperCase()}`],
 [/^claude[\s-]+([234](?:\.\d+)?)(?:[\s-]+([A-Za-z0-9.+-]+))?$/i,(_m,v,rest)=>rest?`Claude-${v}-${rest.replace(/\s+/g,'-')}`:`Claude-${v}`],
 [/^gemini[\s-]+(\d+(?:\.\d+)?)(?:[\s-]+([A-Za-z0-9.+-]+))?$/i,(_m,v,rest)=>rest?`Gemini-${v}-${rest.replace(/\s+/g,'-')}`:`Gemini-${v}`],
 [/^gemma\s+(\d+(?:\.\d+)?)(?:[\s-]+([A-Za-z0-9.+-]+))?$/i,(_m,v,rest)=>rest?`Gemma-${v}-${rest.replace(/\s+/g,'-')}`:`Gemma-${v}`],
 [/^phi[\s-]+(\d+(?:\.\d+)?)(?:[\s-]+([A-Za-z0-9.+-]+))?$/i,(_m,v,rest)=>rest?`Phi-${v}-${rest.replace(/\s+/g,'-')}`:`Phi-${v}`],
 [/^mistral[\s-]+(\d+b|large|medium|small|nemo)(?:[\s-]+([A-Za-z0-9.+-]+))?$/i,(_m,v,rest)=>rest?`Mistral-${v}-${rest.replace(/\s+/g,'-')}`:`Mistral-${v}`],
 [/^mixtral[\s-]+(8x\d+b)(?:[\s-]+([A-Za-z0-9.+-]+))?$/i,(_m,v,rest)=>rest?`Mixtral-${v.toUpperCase()}-${rest.replace(/\s+/g,'-')}`:`Mixtral-${v.toUpperCase()}`],
 [/^glm[\s-]+(\d+(?:\.\d+)?)(?:[\s-]+([A-Za-z0-9.+-]+))?$/i,(_m,v,rest)=>rest?`GLM-${v}-${rest.replace(/\s+/g,'-')}`:`GLM-${v}`],
 [/^gsm[\s-]*8k$/i,'GSM8K'],
 [/^mmlu[\s-]+pro$/i,'MMLU-Pro'],
 [/^human[\s-]*eval(?:\+|[\s-]*plus)?$/i,(m)=>/(\+|plus)$/i.test(m)?'HumanEval+':'HumanEval'],
 [/^swe[\s-]*bench(?:[\s-]+(verified|lite|multimodal))?$/i,(_m,s)=>s?`SWE-bench-${s.charAt(0).toUpperCase()+s.slice(1).toLowerCase()}`:'SWE-bench'],
 [/^math[\s-]*500$/i,'MATH-500'],
 [/^gpqa(?:[\s-]+(diamond|main|extended))?$/i,(_m,s)=>s?`GPQA-${s.charAt(0).toUpperCase()+s.slice(1).toLowerCase()}`:'GPQA'],
 [/^hotpot[\s-]*qa$/i,'HotpotQA'],
 [/^truthful[\s-]*qa$/i,'TruthfulQA'],
 [/^squad[\s-]*([12](?:\.\d+)?)?$/i,(_m,v)=>v?`SQuAD-${v}`:'SQuAD'],
 [/^cifar[\s-]*(\d+)$/i,(_m,n)=>`CIFAR-${n}`],
 [/^image[\s-]*net(?:[\s-]*(1k|21k|22k))?$/i,(_m,v)=>v?`ImageNet-${v.toUpperCase()}`:'ImageNet'],
 [/^livecodebench$/i,'LiveCodeBench'],
 [/^big[\s-]*bench(?:[\s-]+hard)?$/i,(m)=>/hard$/i.test(m)?'BIG-Bench Hard':'BIG-Bench'],
 [/^bbh$/i,'BBH'],
 [/^arc[\s-]+(challenge|easy)$/i,(_m,s)=>`ARC-${s.charAt(0).toUpperCase()+s.slice(1).toLowerCase()}`],
 [/^hella[\s-]*swag$/i,'HellaSwag'],
 [/^wino[\s-]*grande$/i,'WinoGrande'],
 [/^mbpp(\+|[\s-]*plus)?$/i,(m)=>/(\+|plus)$/i.test(m)?'MBPP+':'MBPP'],
];

/** Canonicalize common academic model/benchmark/method spacing and alias variants. */
export function canonicalEntityLabel(raw:string,kind?:KnowledgeEntity['kind']):string{
 const cleaned=raw
  .normalize('NFKC')
  .replace(/[–—−]/g,'-')
  .replace(/\s+/g,' ')
  .replace(/^[\s"'`“”‘’(\[【（]+|[\s"'`“”‘’)\]】）,，。.;；:：]+$/g,'')
  .trim();
 if(!cleaned)return '';
 if(kind==='problem'||kind==='metric')return cleaned;
 for(const [pattern,replacement] of ALIAS_RULES){
  if(pattern.test(cleaned)){
   return typeof replacement==='string'?cleaned.replace(pattern,replacement):cleaned.replace(pattern,replacement);
  }
 }
 return cleaned;
}

export interface KnowledgeReference {paper:KnowledgePaper;relation:KnowledgeRelation}
export interface KnowledgeNode {id:string;kind:KnowledgeEntityKind;label:string}
export interface KnowledgeEdge {
 id:string;
 source:KnowledgeNode;
 target:KnowledgeNode;
 predicate:KnowledgePredicate;
 refs:KnowledgeReference[];
}

function preferLabel(existing:string,candidate:string):string{
 const upper=(s:string)=>(s.match(/[A-Z]/g)||[]).length;
 if(existing===candidate)return existing;
 if(upper(candidate)>upper(existing))return candidate;
 return existing;
}

function knowledgeNode(entity:KnowledgeEntity):KnowledgeNode{
 const label=canonicalEntityLabel(entity.label,entity.kind)||entity.label.trim();
 return {kind:entity.kind,label,id:entity.kind+':'+knowledgeName(label)};
}

export function knowledgeEdges(papers:KnowledgePaper[]):KnowledgeEdge[]{
 const edges=new Map<string,KnowledgeEdge>();
 const nodeLabels=new Map<string,string>();
 for(const paper of papers)for(const relation of paper.relations){
  const source=relation.subject
   ?knowledgeNode(relation.subject)
   :{id:'paper:'+paper.resourceId,kind:'paper' as const,label:paper.title};
  const target=knowledgeNode(relation.object);
  nodeLabels.set(source.id,nodeLabels.has(source.id)?preferLabel(nodeLabels.get(source.id)!,source.label):source.label);
  nodeLabels.set(target.id,nodeLabels.has(target.id)?preferLabel(nodeLabels.get(target.id)!,target.label):target.label);
  const id=JSON.stringify([source.id,relation.predicate,target.id]);
  let edge=edges.get(id);
  if(!edge){
   edge={id,source,target,predicate:relation.predicate,refs:[]};
   edges.set(id,edge);
  }
  edge.refs.push({paper,relation});
 }
 for(const edge of edges.values()){
  edge.source={...edge.source,label:nodeLabels.get(edge.source.id)??edge.source.label};
  edge.target={...edge.target,label:nodeLabels.get(edge.target.id)??edge.target.label};
 }
 return [...edges.values()].sort((a,b)=>b.refs.length-a.refs.length||a.target.label.localeCompare(b.target.label));
}

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
 for(const article of articles)for(const fact of article.facts){
  if(!fact.verified||!['model','dataset','method'].includes(fact.field)||field!=='all'&&fact.field!==field)continue;
  const label=entityName(fact);
  const id=`${fact.field}:${label.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()}`;
  const item=groups.get(id)||{id,field:fact.field,label,references:[]};
  item.references.push({article,fact});
  groups.set(id,item);
 }
 return [...groups.values()].sort((a,b)=>
  new Set(b.references.map(r=>r.article.resourceId)).size-new Set(a.references.map(r=>r.article.resourceId)).size
  ||a.field.localeCompare(b.field)
  ||a.label.localeCompare(b.label)
 );
}

export interface NetworkPoint {id:string;x:number;y:number}

/** Deterministic O(N² + E) spring layout: shared entities pull related papers into clusters. */
export function layoutLiteratureNetwork(ids:string[],links:{source:string;target:string}[]):NetworkPoint[]{
 const n=ids.length;
 if(!n)return [];
 const points:NetworkPoint[]=ids.map((id,i)=>({
  id,
  x:Math.cos(i*2.39996)*Math.sqrt(i+1)*34,
  y:Math.sin(i*2.39996)*Math.sqrt(i+1)*34,
 }));
 const indexById=new Map<string,number>(points.map((p,i)=>[p.id,i]));
 const resolvedLinks:[number,number][]=[];
 for(const link of links){
  const a=indexById.get(link.source),b=indexById.get(link.target);
  if(a!==undefined&&b!==undefined&&a!==b)resolvedLinks.push([a,b]);
 }
 const fx=new Float64Array(n);
 const fy=new Float64Array(n);
 const steps=n>180?140:200;
 for(let step=0;step<steps;step++){
  for(let i=0;i<n;i++){
   fx[i]=-points[i].x*0.009;
   fy[i]=-points[i].y*0.009;
  }
  for(let i=0;i<n;i++){
   const px=points[i].x,py=points[i].y;
   for(let j=i+1;j<n;j++){
    const dx=px-points[j].x,dy=py-points[j].y;
    const d2=Math.max(49,dx*dx+dy*dy);
    const f=1800/d2;
    fx[i]+=dx*f;fy[i]+=dy*f;
    fx[j]-=dx*f;fy[j]-=dy*f;
   }
  }
  for(let k=0;k<resolvedLinks.length;k++){
   const [i,j]=resolvedLinks[k];
   const dx=points[j].x-points[i].x,dy=points[j].y-points[i].y;
   const d=Math.max(1,Math.hypot(dx,dy));
   const f=(d-92)*0.025;
   const ux=(dx/d)*f,uy=(dy/d)*f;
   fx[i]+=ux;fy[i]+=uy;
   fx[j]-=ux;fy[j]-=uy;
  }
  const cool=1-step/(steps+40);
  for(let i=0;i<n;i++){
   points[i].x+=Math.max(-14,Math.min(14,fx[i]))*cool;
   points[i].y+=Math.max(-14,Math.min(14,fy[i]))*cool;
  }
 }
 return points;
}
