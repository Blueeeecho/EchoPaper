import test from 'node:test';
import assert from 'node:assert/strict';
import {writingObjective} from '../shared/writing-objective';
import {locateFigure,replacementOperations,checkReplacement,patchOperations,assetInventory,sourceEvidenceKeys} from '../server/agents/object-edits';
import {hash} from '../server/storage';
import type {ProjectSnapshot} from '../server/agents/project-snapshot';
import {taskBuildErrors,submissionSeverity} from '../shared/diagnostic-policy';

function snapshot(files:Record<string,string>):ProjectSnapshot{return{files:Object.fromEntries(Object.entries(files).map(([path,text])=>[path,{path,text,hash:hash(text),size:Buffer.byteLength(text),binary:false}])),entries:[],capturedAt:''};}
const main='manuscript/main.tex',a='manuscript/fig/a.tex',b='manuscript/fig/b.tex';
const figure=(name:string)=>`\\begin{figure}\n\\includegraphics[width=\\linewidth]{${name}.png}\n\\caption{${name}}\\label{fig:${name}}\n\\end{figure}\n`;
const source=snapshot({[main]:'\\documentclass{article}\n\\begin{document}\n% \\input{missing}\n\\input{fig/b}\n\\input{fig/a}\n\\end{document}',[a]:figure('a'),[b]:figure('b')});
const attachment={id:'7b2d8f00-3e49-4e0f-b899-d8b76f389517',mimeType:'image/jpeg'};

test('reported paraphrases share a bounded objective without conflating insertion',()=>{
 for(const input of ['把图1换掉，用刚才那张','图1用刚才那张图片','将这张图片替换为我们的图1','Replace Figure 1 with the uploaded image'])assert.deepEqual(writingObjective(input),{kind:'replace_figure',number:1});
 assert.equal(writingObjective('新增图1，原图顺延'),undefined);
 assert.equal(writingObjective('不要替换图1，只解释这段'),undefined);
 assert.equal(writingObjective('插入附件作为图1'),undefined);
});

test('replacement follows target include order and preserves all text except the bound graphic argument',()=>{
 const readSet:Record<string,string|null>={},object=locateFigure(source,main,1,readSet);assert.equal(object.path,b);assert.equal(readSet[a],undefined);
 const operations=replacementOperations(source,main,object,attachment,readSet);checkReplacement(source,main,1,operations,readSet);
 assert.equal(operations[0].kind,'attachment');assert.match((operations[0]as any).path,/\.jpg$/);
 const write=operations[1]as any;assert.equal(write.content,source.files[b].text!.replace('b.png',`figures/figure-1-${attachment.id}.jpg`));
 assert.equal(readSet[main],source.files[main].hash);assert.equal(readSet[b],source.files[b].hash);
 assert.equal(locateFigure(source,main,2,{}).path,a);
});

test('batch inventory follows literal source dependencies and separates figure/table order',()=>{
 const table='manuscript/t.tex',state=snapshot({[main]:'% \\input{missing}\n\\input{fig/b}\n\\input{t}\n\\input{fig/a}',[a]:figure('a'),[b]:figure('b'),[table]:'\\begin{table}\\caption{data}\\label{tab:data}\\end{table}','manuscript/template.cls':figure('template')});
 const inventory=assetInventory(state,main);assert.deepEqual(inventory.objects.map(({kind,order,path})=>({kind,order,path})),[{kind:'figure',order:1,path:b},{kind:'table',order:1,path:table},{kind:'figure',order:2,path:a}]);assert.equal(inventory.warnings.length,0);assert.equal(inventory.objects[0].graphics[0],'b.png');assert.ok(!inventory.sourceOrder.includes('manuscript/template.cls'));
});

test('new search phrasing or overlapping reads do not manufacture new source evidence',()=>{
 const match={path:main,line:2,text:'Known text'},result={results:[match]};
 assert.deepEqual(sourceEvidenceKeys('search_files',result,source),sourceEvidenceKeys('search_files',{...result,truncated:false},source));
 assert.deepEqual(sourceEvidenceKeys('search_files',{results:[]},source),[]);
 const first=sourceEvidenceKeys('read_file',{path:main,hash:'frozen',startLine:1,content:'one\ntwo'},source),second=sourceEvidenceKeys('read_file',{path:main,hash:'frozen',startLine:2,content:'two\nthree'},source);assert.deepEqual(first[1],second[0]);assert.notDeepEqual(first[0],second[1]);
});

test('replacement rejects inserting a new figure, changing a caption or replacing the wrong numbered object',()=>{
 const operations=replacementOperations(source,main,locateFigure(source,main,1,{}),attachment,{});
 for(const mode of ['insert','caption','other']as const){const bad=structuredClone(operations);const write=bad[1]as any;
  if(mode==='insert')write.content=figure('new')+write.content;
  if(mode==='caption')write.content=write.content.replace('caption{b}','caption{New caption}');
  if(mode==='other')write.path=a;
  assert.throws(()=>checkReplacement(source,main,1,bad,{}),/换图|原图/);
 }
});

test('missing, conditional, cyclic and multi-panel targets fail explicitly instead of inventing figure 1',()=>{
 for(const body of ['\\iftrue\n'+figure('a')+'\\fi','\\input{main}',figure('a').replace('\\caption','\\includegraphics{second.png}\n\\caption'),'No figure']){
  assert.throws(()=>locateFigure(snapshot({[main]:'\\begin{document}\n'+body+'\\end{document}'}),main,1,{}),/无法|未找到|需要|动态/);
 }
});

test('patches and move mappings bind to the frozen snapshot and ambiguous matches are refused',()=>{
 const state=snapshot({[main]:'before old after','manuscript/x.png':'binary metadata'});
 assert.deepEqual(patchOperations(state,[{kind:'patch',path:main,oldText:'old',newText:'new'}]),[{kind:'write',path:main,content:'before new after',expectedHash:hash('before old after')}]);
 assert.equal((patchOperations(state,[{kind:'move',from:'manuscript/x.png',to:'manuscript/y.png'}])[0]as any).expectedHash,state.files['manuscript/x.png'].hash);
 assert.throws(()=>patchOperations(snapshot({[main]:'old old'}),[{kind:'patch',path:main,oldText:'old',newText:'new'}]),/唯一/);
 assert.throws(()=>patchOperations(state,[{kind:'patch',path:main,oldText:'missing',newText:'new'}]),/唯一/);
});

test('submission placeholders stay visible while local build verification handles real errors and newly introduced references',()=>{
 const placeholder={severity:'warning' as const,category:'placeholder' as const,message:'TODO experiment'},reference={severity:'warning' as const,category:'reference' as const,message:'Undefined reference x'},compiler={severity:'error' as const,category:'compile' as const,message:'Undefined control sequence'};
 assert.equal(submissionSeverity(placeholder),'error');assert.deepEqual(taskBuildErrors([placeholder,reference]),[]);
 assert.deepEqual(taskBuildErrors([reference],[reference]),[]);assert.deepEqual(taskBuildErrors([reference],[]),[reference]);assert.deepEqual(taskBuildErrors([placeholder,compiler]),[compiler]);
});
