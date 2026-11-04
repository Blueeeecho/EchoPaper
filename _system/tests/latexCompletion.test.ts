import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { CompletionContext, hasNextSnippetField, nextSnippetField, type CompletionResult } from '@codemirror/autocomplete';
import { latexCompletion } from '../src/latexCompletion.ts';
import { referenceCompletion } from '../src/referenceCompletion.ts';
const files=['manuscript/main.tex','manuscript/tex/intro.tex','manuscript/fig/results.pdf','manuscript/fig/plot.png','manuscript/fig/photo.jpg','manuscript/fig/unsupported.svg','manuscript/refs/library.bib','notes/private.tex','reviews/round-01/response/main.tex','reviews/round-01/response/parts/reply.tex','manuscript/.git/secret.tex','manuscript/../outside.tex','/etc/hosts','manuscript/fig/bad%name.png'];
function complete(text:string,selectedPath='manuscript/main.tex',targetRoot?:string,explicit=false):CompletionResult|null {
 const state=EditorState.create({doc:text,selection:{anchor:text.length}}),result=latexCompletion(files,selectedPath,targetRoot)(new CompletionContext(state,text.length,explicit));
 assert.ok(!result||!(result instanceof Promise));return result as CompletionResult|null;
}
test('single slash automatically proposes common commands and paired environment snippets',()=>{
 const result=complete('\\')!;assert.equal(result.from,0);for(const label of ['\\section','\\input','\\includegraphics','\\frac','\\begin{figure}','\\begin{table}','\\begin{equation}'])assert.ok(result.options.some(o=>o.label===label),label);
 assert.equal(complete('ordinary text'),null);assert.equal(complete('\\\\'),null);assert.ok(complete('\\\\\\frac'));assert.ok(complete('\\fr',undefined,undefined,true));
});
test('command snippets insert real LaTeX and navigate Tab placeholder fields',()=>{
 const result=complete('\\fr')!,completion=result.options.find(o=>o.label==='\\frac')!;
 let state=EditorState.create({doc:'\\fr',selection:{anchor:3}});const editor={get state(){return state;},dispatch(tr:any){state=tr.state;}};
 assert.equal(typeof completion.apply,'function');(completion.apply as Function)(editor,completion,result.from,3);
 assert.equal(state.doc.toString(),'\\frac{分子}{分母}');assert.equal(state.sliceDoc(state.selection.main.from,state.selection.main.to),'分子');assert.equal(hasNextSnippetField(state),true);assert.equal(nextSnippetField(editor),true);assert.equal(state.sliceDoc(state.selection.main.from,state.selection.main.to),'分母');
 const env=complete('\\beg')!,figure=env.options.find(o=>o.label==='\\begin{figure}')!;state=EditorState.create({doc:'\\beg',selection:{anchor:4}});(figure.apply as Function)(editor,figure,0,4);assert.match(state.doc.toString(),/^\\begin\{figure\}/);assert.match(state.doc.toString(),/\\includegraphics/);assert.match(state.doc.toString(),/\\end\{figure\}/);assert.ok(!state.doc.toString().includes('${'));
});
test('path/reference snippets leave empty searchable fields and immediately provide directory or key candidates',()=>{
 for(const command of ['input','include','includegraphics','bibliography','addbibresource','cite','citep','citet','ref','eqref']){
  const text=`\\${command}`,result=complete(text)!,completion=result.options.find(o=>o.label===text)!;
  let state=EditorState.create({doc:text,selection:{anchor:text.length}});const editor={get state(){return state;},dispatch(tr:any){state=tr.state;}};
  (completion.apply as Function)(editor,completion,result.from,text.length);
  assert.equal(state.selection.main.empty,true,command);const pos=state.selection.main.head;assert.equal(state.doc.sliceString(pos-1,pos),'{',command);assert.equal(state.doc.sliceString(pos,pos+1),'}',command);
  const context=new CompletionContext(state,pos,false);
  const next=['cite','citep','citet','ref','eqref'].includes(command)
   ?referenceCompletion({entries:[{key:'paper2026',type:'article',title:'Paper',author:'A',year:'2026',doi:'',file:'manuscript/refs/library.bib',line:1}],labels:[{key:'fig:results',file:'manuscript/main.tex',line:1,context:'Results'}],warnings:[]})(context)
   :latexCompletion(files,'manuscript/main.tex')(context) as CompletionResult;
  assert.ok(next&&!(next instanceof Promise)&&next.options.length>0,command);assert.equal(next!.from,pos,command);
 }
});
test('input/include paths are relative to the compiler root even from a nested .tex file',()=>{
 const input=complete('\\input{','manuscript/tex/intro.tex')!;assert.deepEqual(input.options.map(o=>o.label),['main']);assert.equal(input.from,7);
 const main=complete('\\input{tex/')!;assert.deepEqual(main.options.map(o=>o.label),['tex/intro']);assert.equal(main.options[0].detail,undefined);assert.equal(main.options[0].info,undefined);
 const custom=complete('\\include{','reviews/round-01/response/main.tex','reviews/round-01/response')!;assert.deepEqual(custom.options.map(o=>o.label),['parts/reply']);
 assert.ok(!JSON.stringify(main.options).includes('notes/private'));assert.ok(!JSON.stringify(main.options).includes('secret'));assert.ok(!JSON.stringify(main.options).includes('outside'));
});
test('image/bibliography path filtering handles options, commas and relative scopes',()=>{
 const images=complete('\\includegraphics[width=0.7\\textwidth]{fig/')!;assert.deepEqual(images.options.map(o=>o.label),['fig/photo.jpg','fig/plot.png','fig/results.pdf']);
 const bib=complete('\\bibliography{first,  refs/')!;assert.deepEqual(bib.options.map(o=>o.label),['refs/library']);assert.equal(bib.from,'\\bibliography{first,  '.length);
 const resource=complete('\\addbibresource{')!;assert.deepEqual(resource.options.map(o=>o.label),['refs/library.bib']);
 const pdf=complete('\\includepdf[pages=-]{')!;assert.deepEqual(pdf.options.map(o=>o.label),['fig/results.pdf']);
});
test('environment names work inside begin/end and comments/IME do not propose replacements',()=>{
 const begin=complete('\\begin{ali')!;assert.equal(begin.from,7);assert.ok(begin.options.some(o=>o.label==='align'));assert.ok(complete('\\end{')!.options.some(o=>o.label==='figure'));
 assert.equal(complete('% \\fr'),null);assert.ok(complete('\\% \\fr'));assert.equal(complete('\\\\% \\fr'),null);
 assert.equal(complete('\\\\input{'),null);assert.equal(complete('\\verb|\\fr'),null);assert.ok(complete('\\verb|code%| \\fr'));
 const state=EditorState.create({doc:'\\fr'});assert.equal(latexCompletion(files,'manuscript/main.tex')(new CompletionContext(state,3,false,{composing:true} as any)),null);
});
