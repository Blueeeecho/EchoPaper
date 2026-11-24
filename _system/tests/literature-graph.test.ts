import test from 'node:test';import assert from 'node:assert/strict';import {literatureEntities} from '../shared/literature-graph';import type {ArticleAnalysis} from '../shared/literature-analysis';
import {graphViewport,keepGraphInView} from '../src/academic/graph-viewport';

test('zoom and pan keep a node visible even when all projected nodes would leave the canvas',()=>{
 const nodes=[{x:-320,y:-230},{x:340,y:220}];
 const fits={x:480,y:260,k:1};
 assert.equal(keepGraphInView(fits,nodes),fits);
 assert.equal(keepGraphInView(fits,[]),fits);
 for(const transform of [{x:480,y:260,k:8},{x:-4000,y:5000,k:4},{x:6500,y:-5000,k:.25}]){
  const adjusted=keepGraphInView(transform,nodes);
  assert.equal(adjusted.k,transform.k);
  assert.ok(nodes.some(node=>{
   const x=adjusted.x+node.x*adjusted.k,y=adjusted.y+node.y*adjusted.k;
   return x>0&&x<graphViewport.width&&y>0&&y<graphViewport.height;
  }));
 }
});
const article=(id:string,value:string,verified=true):ArticleAnalysis=>({resourceId:id,filename:id+'.pdf',sourceHash:'a'.repeat(64),pageCount:1,title:id,model:'test',analyzedAt:'',facts:[{id:id+'-f',field:'model',value,page:1,quote:'Source quotation',verified}],directions:[]});
test('graph merges normalized shared entities, retains evidence links and excludes unverified claims',()=>{const entities=literatureEntities([article('one',' Model A '),article('two','model A'),article('three','Model B',false)]);assert.equal(entities.length,1);assert.equal(entities[0].references.length,2);assert.deepEqual(entities[0].references.map(r=>r.article.resourceId),['one','two']);assert.equal(literatureEntities([article('one','Model A')],'dataset').length,0);});

test('network layout remains finite and deterministic for isolated and connected nodes',async()=>{const {layoutLiteratureNetwork}=await import('../shared/literature-graph');assert.deepEqual(layoutLiteratureNetwork([],[]),[]);const ids=Array.from({length:60},(_,i)=>'node'+i),links=ids.slice(1).map(target=>({source:'node0',target}));const first=layoutLiteratureNetwork(ids,links),second=layoutLiteratureNetwork(ids,links);assert.deepEqual(first,second);assert.equal(first.length,60);assert.ok(first.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));assert.equal(new Set(first.map(p=>`${p.x},${p.y}`)).size,60);assert.equal(layoutLiteratureNetwork(['one'],[]).length,1);});
test('legacy entity descriptions merge by explicit name without collapsing benchmark versions',()=>{const a=article('one','GSM8K：算术推理数据集'),b=article('two','GSM8K 数据集，用于数学问答'),c=article('three','GSM8K');for(const p of [a,b,c])p.facts[0].field='dataset';const entries=literatureEntities([a,b,c]);assert.equal(entries.length,1);assert.equal(entries[0].label,'GSM8K');const version=article('four','GSM8K-Plus');version.facts[0].field='dataset';assert.equal(literatureEntities([a,version]).length,2);});

test('canonicalEntityLabel merges common model and benchmark aliases while preserving versions',async()=>{
 const {canonicalEntityLabel,knowledgeEdges}=await import('../shared/literature-graph');
 assert.equal(canonicalEntityLabel('GPT4o','model'),'GPT-4o');
 assert.equal(canonicalEntityLabel('GPT 4o','model'),'GPT-4o');
 assert.equal(canonicalEntityLabel('GPT4o-mini','model'),'GPT-4o-mini');
 assert.equal(canonicalEntityLabel('Llama 3','model'),'Llama-3');
 assert.equal(canonicalEntityLabel('LLaMA-3-8B','model'),'Llama-3-8B');
 assert.equal(canonicalEntityLabel('Qwen-2.5','model'),'Qwen2.5');
 assert.equal(canonicalEntityLabel('GSM-8K','dataset'),'GSM8K');
 assert.equal(canonicalEntityLabel('gsm8k','dataset'),'GSM8K');
 assert.equal(canonicalEntityLabel('MMLU Pro','dataset'),'MMLU-Pro');
 assert.notEqual(canonicalEntityLabel('Llama 3','model'),canonicalEntityLabel('Llama 2','model'));

 const edges=knowledgeEdges([
  {resourceId:'p1',title:'Paper 1',sourceHash:'h1',relations:[
   {predicate:'evaluates_with_model',object:{kind:'model',label:'GPT4o'},page:1,quote:'q1'},
  ]},
  {resourceId:'p2',title:'Paper 2',sourceHash:'h2',relations:[
   {predicate:'evaluates_with_model',object:{kind:'model',label:'GPT-4o'},page:2,quote:'q2'},
  ]},
 ]);
 assert.equal(edges.length,2);
 assert.equal(edges[0].target.id,edges[1].target.id);
 assert.equal(edges[0].target.label,'GPT-4o');
});

test('layered and force graph layouts produce finite zero-overlap coordinates and valid hulls',async()=>{
 const {computeLayeredLayout,computeForceLayout,computeConvexHull}=await import('../src/academic/graphEngine');
 const nodes=[
  {id:'paper:p1',kind:'paper' as const,label:'Paper One',refs:[],degree:3},
  {id:'paper:p2',kind:'paper' as const,label:'Paper Two',refs:[],degree:2},
  {id:'method:m1',kind:'method' as const,label:'GraphVerify',refs:[],degree:3},
  {id:'problem:pr1',kind:'problem' as const,label:'Hallucination',refs:[],degree:2},
  {id:'model:gpt',kind:'model' as const,label:'GPT-4o',refs:[],degree:2},
  {id:'dataset:gsm',kind:'dataset' as const,label:'GSM8K',refs:[],degree:2},
  {id:'metric:f1',kind:'metric' as const,label:'F1',refs:[],degree:2},
 ];
 const edges=[
  {id:'e1',source:nodes[0],target:nodes[2],predicate:'proposes' as const,refs:[]},
  {id:'e2',source:nodes[0],target:nodes[3],predicate:'addresses' as const,refs:[]},
  {id:'e3',source:nodes[2],target:nodes[4],predicate:'evaluates_with_model' as const,refs:[]},
  {id:'e4',source:nodes[2],target:nodes[5],predicate:'evaluates_on' as const,refs:[]},
  {id:'e5',source:nodes[1],target:nodes[5],predicate:'evaluates_on' as const,refs:[]},
  {id:'e6',source:nodes[2],target:nodes[6],predicate:'measures_with' as const,refs:[]},
 ];

 const layered=computeLayeredLayout(nodes,edges);
 assert.equal(layered.positions.size,nodes.length);
 assert.equal(layered.columnHeaders.length,4);
 assert.ok(layered.positions.get('paper:p1')!.x < layered.positions.get('method:m1')!.x);
 assert.ok(layered.positions.get('method:m1')!.x < layered.positions.get('model:gpt')!.x);
 assert.ok(layered.positions.get('model:gpt')!.x < layered.positions.get('metric:f1')!.x);

 const force=computeForceLayout(nodes,edges);
 assert.equal(force.size,nodes.length);
 const pts=[...force.values()];
 for(let i=0;i<pts.length;i++){
  assert.ok(Number.isFinite(pts[i].x)&&Number.isFinite(pts[i].y));
  for(let j=i+1;j<pts.length;j++){
   assert.ok(Math.hypot(pts[i].x-pts[j].x,pts[i].y-pts[j].y)>=24,'force nodes should not overlap');
  }
 }

 const hull=computeConvexHull([{x:0,y:0},{x:10,y:0},{x:5,y:5},{x:10,y:10},{x:0,y:10}]);
 assert.equal(hull.length,4);
});
