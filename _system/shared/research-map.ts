import {z} from 'zod';
export const RESEARCH_MAP_PATH='notes/research-map.json';
export const MAX_RESEARCH_MAP_BYTES=512*1024;
const text=z.string().max(12000),id=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),optional=text.optional().default('');
// Paper IDs share the existing project registry contract; graph node IDs are separate.
export const researchProjectId=/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const paper=z.object({id,short:text,title:text,year:optional,role:optional,url:optional,anchor:optional,accomplishment:text,boundary:text,proposedDifference:text,relation:optional,input:optional,comparisonStatus:text});
const edge=z.object({source:id,target:id,kind:z.enum(['问题承接','评估继承','机制重合','待证差异','反例','邻接支撑']),assertion:text,evidence:optional,anchor:text,assessment:text,checkedAt:optional,status:optional});
const schema=z.object({schemaVersion:z.literal(1),projectId:z.string().regex(researchProjectId),title:text,asOf:text,sourceNote:optional,sourceNoteSha256:z.string().regex(/^[a-f0-9]{64}$/),scope:text,ours:z.object({id,short:text,question:text,approach:text,status:text,proposedDifference:text,falsifier:text}),papers:z.array(paper).max(200),edges:z.array(edge).max(600),evidence:z.array(z.object({id,title:text,status:text,detail:text,scope:text,source:text})).max(200)});
export type ResearchMap=z.infer<typeof schema>;
export function parseResearchMap(content:string,projectId:string):ResearchMap{
 if(new TextEncoder().encode(content).length>MAX_RESEARCH_MAP_BYTES)throw Error('研究对照数据过大（上限512KB），文字依据仍可用。');
 let raw:unknown;try{raw=JSON.parse(content);}catch{throw Error('研究对照JSON损坏，文字依据仍可用。');}
 const result=schema.safeParse(raw);if(!result.success)throw Error('研究对照结构无效或版本不支持，文字依据仍可用。');const data=result.data;
 if(data.projectId!==projectId)throw Error('研究对照不属于当前论文，已拒绝显示。');
 const ids=new Set([data.ours.id,...data.papers.map(p=>p.id)]);
 if(ids.size!==data.papers.length+1||new Set(data.evidence.map(e=>e.id)).size!==data.evidence.length||data.edges.some(e=>!ids.has(e.source)||!ids.has(e.target)))throw Error('研究对照存在重复标识或无效关系。');
 return data;
}
// Only project-local sources or explicit HTTP(S) URLs become links. Other text remains visible.
export function researchSourceHref(source:string,projectId:string):string|undefined{
 if(!researchProjectId.test(projectId))return;
 try{const u=new URL(source);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)return u.href;return;}catch{/* project relative path */}
 if(!/\.(md|json|pdf|txt|tex|bib|csv)$/i.test(source)||!source||source.startsWith('/')||/[\\?#%\u0000-\u001f]/.test(source)||source.split('/').some(p=>!p||p==='.'||p==='..')||!source.startsWith('notes/')&&!source.startsWith('literature/')&&!source.startsWith('manuscript/'))return;
 return `/api/projects/${encodeURIComponent(projectId)}/raw?path=${encodeURIComponent(source)}`;
}
export function researchBasisStale(data:ResearchMap,currentHash:string|undefined){return !currentHash||currentHash!==data.sourceNoteSha256;}

export function researchMapSelection(data:ResearchMap,query:string,selected:string){
 const search=query.trim().toLocaleLowerCase();
 const papers=data.papers.filter(p=>!search||JSON.stringify(p).toLocaleLowerCase().includes(search));
 const matches=new Set(papers.map(p=>p.id));
 const edges=data.edges.filter(e=>(selected?e.source===selected||e.target===selected:e.source===data.ours.id||e.target===data.ours.id)&&(!search||matches.has(e.source)||matches.has(e.target)));
 return{papers,edges:edges.slice(0,selected?600:8),total:edges.length};
}
