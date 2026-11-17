import test from 'node:test';
import assert from 'node:assert/strict';
import { readWritingDraft, storeWritingDraft, clearWritingDraft, sameSelection, selectionScope } from '../src/writingDraft';
import { applyAcceptedChanges, reviewChanges, replaceSelectedText } from '../src/editReview';
const selection = {projectId:'fixture',path:'manuscript/main.tex',from:7,to:10,text:'old',documentText:'before old after'};
function storageFixture() {
  const data = new Map<string,string>();
  return {getItem:(key:string)=>data.get(key) ?? null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};
}
test('writing draft restores a reviewed suggestion and selected changes without a model call',()=>{
  const storage=storageFixture();
  const draft={selection,instruction:'only wording',reply:'new',result:{text:'new',model:'mock',finishReason:'stop'},accepted:[0]};
  assert.equal(storeWritingDraft(storage,draft),true);
  assert.deepEqual(readWritingDraft(storage,'fixture'),{...draft,reviewVersion:2});
  assert.equal(readWritingDraft(storage,'other'),undefined);
  assert.equal(sameSelection(selection,{...selection,documentText:'changed'}),false);
  clearWritingDraft(storage,'fixture');
  assert.equal(readWritingDraft(storage,'fixture'),undefined);
});
test('incomplete restored output is available but cannot be applied as finished',()=>{
  const storage=storageFixture();
  storeWritingDraft(storage,{selection,instruction:'format',reply:'partial',result:{text:'partial',model:'mock',finishReason:'length'},accepted:[0]});
  const restored=readWritingDraft(storage,'fixture');
  assert.equal(restored?.reply,'partial');assert.equal(restored?.result,undefined);assert.deepEqual(restored?.accepted,[]);
});
test('frozen chat selection rejects changes outside selection and changes of file or project',()=>{
  assert.equal(selectionScope(selection,'fixture',selection.path,selection.documentText).selection.selectedText,'old');
  for(const [project,path,content] of [['other',selection.path,selection.documentText],['fixture','other.tex',selection.documentText],['fixture',selection.path,'before old changed']]) assert.throws(()=>selectionScope(selection,project,path,content),/过期/);
  assert.equal(replaceSelectedText(selection.documentText,selection,'new'),'before new after');
});
test('long review separates distant modifications and preserves the unmodified middle',()=>{
  const middle=Array.from({length:200},(_,i)=>`Untouched paragraph ${i}.\\cite{key}`).join('\n');
  const before=`Old start.\n${middle}\nOld end.`,after=`New start.\n${middle}\nNew end.`;
  const changes=reviewChanges(before,after);assert.ok(changes.length>=2);
  for(const change of changes) assert.equal(before.slice(change.fromA,change.toA).includes('Untouched paragraph 100'),false);
  assert.equal(applyAcceptedChanges(before,after,changes,new Set(changes.map((_,i)=>i))),after);
  assert.equal(applyAcceptedChanges(before,after,changes,new Set()),before);
});
test('storage errors and malformed drafts do not break the open editor',()=>{
  assert.equal(storeWritingDraft({setItem(){throw Error('full');}},{selection,instruction:'',reply:'',accepted:[]}),false);
  assert.equal(readWritingDraft({getItem(){return '{broken';}},'fixture'),undefined);
});

test('legacy character-level accept decisions require fresh review after sentence regrouping', () => {
  const legacy = { selection, instruction: 'polish', reply: 'new', result: { text: 'new', model: 'mock', finishReason: 'stop' }, accepted: [0, 2, 5] };
  const restored = readWritingDraft({ getItem: () => JSON.stringify(legacy) }, 'fixture');
  assert.equal(restored?.result?.text, 'new');
  assert.deepEqual(restored?.accepted, []);
});
