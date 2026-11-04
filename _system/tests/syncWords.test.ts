import test from 'node:test';import assert from 'node:assert/strict';
import{sourceWordAt,findSourceWord,normalizeSyncText,scoreWordContext,syncWordRanges,contextWordCandidates}from'../src/syncWords.ts';
test('global context candidates retain repeated positions and score actual prose',()=>{
 const text='\\begin{abstract}\nThe first preference changes. The explicit preference remains valid today.\n\\end{abstract}';
 const matches=contextWordCandidates(text,{word:'preference',before:'The explicit ',after:' remains valid today.'});
 assert.equal(matches.length,2);assert.ok(matches[1].score>=8);assert.ok(matches[1].score>matches[0].score);
 assert.equal(matches[1].from,text.lastIndexOf('preference'));assert.equal(matches[1].line,2);
 assert.equal(contextWordCandidates(text,{word:'nonexistent',before:'',after:''}).length,0);
 assert.equal(contextWordCandidates('same word same word',{word:'word',before:'',after:''}).length,2);
});
test('clicked position identifies one word in the latter half of a long logical source line',()=>{
 const text='\\section{Intro}\n'+('earlier words '.repeat(40))+'specific target afterwards.';const pos=text.indexOf('specific')+3;const word=sourceWordAt(text,pos)!;
 assert.equal(text.slice(word.from,word.to),'specific');assert.equal(word.line,2);assert.equal(word.hint?.word,'specific');assert.ok(word.to-word.from<10);
});
test('plain PDF text preserves percent signs in surrounding prose and uses UTF-16 ranges for Chinese',()=>{
 const text='95% accuracy 这是中文定位功能。';const hit=sourceWordAt(text,text.indexOf('accuracy')+2)!;assert.equal(hit.hint?.word,'accuracy');
 const chinese=sourceWordAt(text,text.indexOf('定位'))!;assert.equal(text.slice(chinese.from,chinese.to),'定位');assert.ok(chinese.to-chinese.from<5);
 assert.deepEqual(syncWordRanges("identity-based isn't 2027").map(r=>"identity-based isn't 2027".slice(r.from,r.to)),['identity-based',"isn't",'2027']);
});
test('TeX markup and citation keys are excluded, while formatted and escaped prose remains matchable',()=>{
 const text='\\section{Intro}\nPreserve \\textbf{useful help} with 95\\% accuracy~\\cite{secret2027}. % hiddenword\n';
 assert.equal(sourceWordAt(text,text.indexOf('useful')+2)?.hint?.word,'useful');assert.equal(sourceWordAt(text,text.indexOf('secret2027')+3),undefined);assert.equal(sourceWordAt(text,text.indexOf('hiddenword')+3),undefined);
 const r=findSourceWord(text,2,{word:'accuracy',before:'useful help with 95%',after:''})!;assert.equal(text.slice(r.from,r.to),'accuracy');
});
test('normalization handles ligatures, line-break hyphenation, apostrophes and TeX spacing',()=>{
 assert.equal(normalizeSyncText('ﬁnal prefer-\nences'), 'final preferences');
 assert.equal(normalizeSyncText('\\textbf{Identity-Flip}~isn’t'),"identityflip isn't");
});
test('repeated source words use adjacent context rather than always selecting the first occurrence',()=>{
 const text='\\section{Test}\nThe first preference changes. The explicit preference remains valid.';
 const hit=findSourceWord(text,2,{word:'preference',before:'The explicit ',after:' remains valid.'})!;
 assert.equal(hit.from,text.lastIndexOf('preference'));assert.equal(text.slice(hit.from,hit.to),'preference');
 assert.equal(findSourceWord('the word and the word',1,{word:'word',before:'',after:''}),undefined);
});
test('nearby matching does not guess a distant source occurrence or a missing term',()=>{
 const text='\\section{Test}\nnearby help\n\n\n\nfaraway target';assert.equal(findSourceWord(text,2,{word:'target',before:'',after:''}),undefined);
 assert.equal(findSourceWord(text,2,{word:'nonexistent',before:'',after:''}),undefined);
 assert.equal(sourceWordAt('word       ',10),undefined);
 assert.equal(findSourceWord('some text',1),undefined);
});
test('nearby line context and explicit columns resolve only trustworthy candidates',()=>{
 const text='first line\nA useful recommendation follows.\nlast line';const r=findSourceWord(text,1,{word:'recommendation',before:'A useful ',after:' follows.'})!;assert.equal(text.slice(r.from,r.to),'recommendation');
 const col=findSourceWord('one two three',1,undefined,6)!;assert.equal('one two three'.slice(col.from,col.to),'two');
 assert.ok(scoreWordContext({word:'help',before:'preserve useful ',after:' today'},{word:'help',before:'preserve useful ',after:' today'})>=6);
 assert.equal(scoreWordContext({word:'help',before:'',after:''},{word:'other',before:'',after:''}),-Infinity);
});
