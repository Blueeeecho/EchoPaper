import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentEditContext,ChangeOperation} from '../shared/agent-types';
import {resolveEditTarget,validateEditTarget} from '../server/agents/edit-targets';
import type {ProjectSnapshot} from '../server/agents/project-snapshot';
import {HttpError} from '../server/security';
import {hash} from '../server/storage';

const path='manuscript/main.tex',text='Before.\nOriginal sentence.\nAfter.';
const selected='Original sentence.';
function snapshot(content=text):ProjectSnapshot{return {capturedAt:'2026-11-13',entries:[],files:{[path]:{path,text:content,hash:hash(content),size:Buffer.byteLength(content),binary:false}}};}
function context(content=text,from=content.indexOf(selected)):AgentEditContext{return {path,selection:{path,from,to:from+selected.length,documentText:content,selectedText:selected}};}
const write=(content:string,expectedHash:string|null=hash(text)):ChangeOperation=>({kind:'write',path,content,expectedHash});
function recoverable(status:number,code:string){return (error:unknown)=>{
 assert.ok(error instanceof HttpError);assert.equal(error.statusCode,status);assert.equal(error.extra?.editTargetError,code);assert.equal(error.extra?.scopeViolation,undefined);return true;
};}

test('file targets cover exact paths including new files and both sides of a move',()=>{
 const move:ChangeOperation={kind:'move',from:path,to:'manuscript/renamed.tex',expectedHash:hash(text)};
 const create:ChangeOperation={kind:'write',path:'notes/new.md',content:'New note',expectedHash:null};
 const verified=resolveEditTarget({kind:'files',paths:[path,'manuscript/renamed.tex','notes/new.md',path]},undefined,snapshot(),[move,create]);
 assert.deepEqual(verified,{kind:'files',paths:[path,'manuscript/renamed.tex','notes/new.md']});
 assert.throws(()=>resolveEditTarget({kind:'files',paths:[path]},undefined,snapshot(),[move]),recoverable(400,'operationOutsideTarget'));
 assert.throws(()=>resolveEditTarget({kind:'files',paths:['manuscript']},undefined,snapshot(),[write('Changed')]),recoverable(400,'operationOutsideTarget'));
 assert.throws(()=>resolveEditTarget({kind:'files',paths:['../outside']},undefined,snapshot(),[]),HttpError);
});

test('project declarations leave authority checks with the existing changeset layer',()=>{
 const project:ChangeOperation={kind:'project',patch:{targets:[{id:'main',label:'Main',main:'manuscript/renamed.tex'}]},expectedUpdatedAt:'now'};
 assert.deepEqual(resolveEditTarget({kind:'project'},undefined,snapshot(),[write('Changed'),project]),{kind:'project'});
 assert.deepEqual(resolveEditTarget({kind:'files',paths:[path]},undefined,snapshot(),[write('Changed'),project]),{kind:'files',paths:[path]});
 assert.throws(()=>resolveEditTarget({kind:'project'},undefined,snapshot(),[{kind:'write',path:'build/output.tex',content:'x',expectedHash:null}]),HttpError);
});

test('author selection binds exact offsets even when the selected text repeats elsewhere',()=>{
 const content=`${text}\n${selected}`,source=snapshot(content),author=context(content);
 const operation=write(content.replace(selected,'Revised sentence.'),hash(content));
 const target=resolveEditTarget({kind:'selection',path},author,source,[operation]);
 assert.deepEqual(target,{kind:'selection',path,from:author.selection!.from,to:author.selection!.to,expectedHash:hash(content)});
 assert.throws(()=>resolveEditTarget({kind:'selection',path,selectedText:`Before.\n${selected}`},author,source,[operation]),recoverable(400,'selectionOutsideContext'));
 assert.throws(()=>resolveEditTarget({kind:'selection',path:'notes/other.md'},author,{...source,files:{...source.files,'notes/other.md':{path:'notes/other.md',text:selected,hash:hash(selected),size:selected.length,binary:false}}},[]),recoverable(400,'selectionFileMismatch'));
});

test('a model can narrow an author selection to its unique substring',()=>{
 const operation=write(text.replace('sentence','paragraph'));
 const target=resolveEditTarget({kind:'selection',path,selectedText:'sentence'},context(),snapshot(),[operation]);
 assert.deepEqual(target,{kind:'selection',path,from:text.indexOf('sentence'),to:text.indexOf('sentence')+'sentence'.length,expectedHash:hash(text)});
 assert.throws(()=>resolveEditTarget({kind:'selection',path,selectedText:'sentence'},context(),snapshot(),[write(text.replace('Original','Revised'))]),recoverable(400,'selectionBoundsExceeded'));
});

test('stale outside edits allow unique relocation while changed or ambiguous selected text conflicts',()=>{
 const current='New introduction.\n'+text,source=snapshot(current);
 const operation=write(current.replace(selected,'Revised sentence.'),hash(current));
 const target=resolveEditTarget({kind:'selection',path},context(),source,[operation]);
  assert.ok(target.kind==='selection');assert.equal(target.from,current.indexOf(selected));
 assert.throws(()=>resolveEditTarget({kind:'selection',path},context(),snapshot(text.replace(selected,'Human-edited sentence.')),[]),recoverable(409,'selectionChanged'));
 assert.throws(()=>resolveEditTarget({kind:'selection',path},context(),snapshot(current+'\n'+selected),[]),recoverable(409,'selectionAmbiguous'));
});

test('selection declarations without an author quote require exact unique snapshot text',()=>{
 const operation=write(text.replace(selected,'Revised sentence.'));
 assert.equal(resolveEditTarget({kind:'selection',path,selectedText:selected},undefined,snapshot(),[operation]).kind,'selection');
 assert.throws(()=>resolveEditTarget({kind:'selection',path},undefined,snapshot(),[operation]),recoverable(400,'selectionTextRequired'));
 assert.throws(()=>resolveEditTarget({kind:'selection',path,selectedText:selected},undefined,snapshot(text+'\n'+selected),[]),recoverable(409,'selectionAmbiguous'));
});

test('selection target validation rejects wrong files, non-text operations, stale hashes and edits outside its range',()=>{
 const operation=write(text.replace(selected,'Revised sentence.'));
 const target=resolveEditTarget({kind:'selection',path},context(),snapshot(),[operation]);
 validateEditTarget(target,[operation],snapshot());
 assert.throws(()=>validateEditTarget(target,[{kind:'write',path:'notes/unasked.md',content:'x',expectedHash:null}],snapshot()),recoverable(400,'operationOutsideSelection'));
 assert.throws(()=>validateEditTarget(target,[{kind:'delete',path,expectedHash:hash(text)}],snapshot()),recoverable(400,'operationOutsideSelection'));
 assert.throws(()=>validateEditTarget(target,[write(text.replace('Before','Changed'))],snapshot()),recoverable(400,'selectionBoundsExceeded'));
 assert.throws(()=>validateEditTarget(target,[write('')],snapshot()),recoverable(400,'selectionBoundsExceeded'));
 assert.throws(()=>validateEditTarget(target,[write(operation.kind==='write'?operation.content:'',hash('wrong'))],snapshot()),recoverable(409,'selectionOperationBaselineChanged'));
 assert.throws(()=>validateEditTarget(target,[operation],snapshot('Human update')),recoverable(409,'selectionBaselineChanged'));
});

test('damaged author offsets fail before any automatic relocation',()=>{
 const invalid=context();invalid.selection!.to++;
 assert.throws(()=>resolveEditTarget({kind:'selection',path},invalid,snapshot(),[]),recoverable(400,'invalidSelectionContext'));
});
