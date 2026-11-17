import test from 'node:test';
import assert from 'node:assert/strict';
import { writingRequest } from '../src/writingRequest';

const context = { projectId: 'P', path: 'main.tex', content: 'before old after', selection: { projectId: 'P', path: 'main.tex', from: 7, to: 10, text: 'old', documentText: 'before old after' } };

test('ordinary prose editing keeps project access while its quote remains task context', () => {
  const request = writingRequest('请润色这段，不要修改公式和数据。', context);
  assert.deepEqual(request.scope, {});
  assert.deepEqual(request.writingTask, { kind: 'project', outputMode: 'suggest', verification: 'none' });
  assert.equal(writingRequest('只解释这段', context).scope.readOnly, true);
  assert.equal(writingRequest('只给建议，不要修改文件', context).scope.readOnly, true);
});

test('whole-document, direct application and compile requests follow the current words', () => {
  const whole = writingRequest('修改全文，最后编译一下', context);
  assert.deepEqual(whole.scope, {});
  assert.deepEqual(whole.writingTask, { kind: 'project', outputMode: 'suggest', verification: 'compile' });
  assert.equal(writingRequest('直接改这段，不用确认', context).writingTask.outputMode, 'apply');
  assert.equal(writingRequest('不要直接修改，只给建议', context).writingTask.outputMode, 'suggest');
  assert.equal(writingRequest('这次不要修改全文，只润色这一段，不要编译', context).editContext.selection?.selectedText, 'old');
  assert.equal(writingRequest('为什么编译报错？', context).writingTask.verification, 'none');
  assert.equal(writingRequest('请修复编译错误', context).writingTask.kind, 'repair');
  assert.equal(writingRequest('请修复编译错误', context).writingTask.verification, 'compile');
  assert.equal(writingRequest('同时调整 introduction.tex 和 main.tex', context).writingTask.kind, 'project');
});

test('PDF references support source discovery for editing and stay read-only for questions', () => {
  const pdf = { ...context, selection: undefined, pdfReference: true };
  assert.deepEqual(writingRequest('改这一段', pdf).scope, {});
  assert.equal(writingRequest('请解释这段', pdf).scope.readOnly, true);
  assert.deepEqual(writingRequest('根据参考修改当前源码', pdf).scope, {});
  assert.equal(writingRequest('你好', { projectId: 'P', path: '', content: '' }).scope.readOnly, true);
  assert.equal(writingRequest('你在吗？', { ...context, content: 'Later unsaved edits' }).scope.readOnly, true);
});

test('the reported figure request may locate source and a follow-up why-question cannot resume editing', () => {
  const pdf = writingRequest('帮我把这个图片改为占据双栏 而不是单栏', { ...context, selection: undefined, pdfReference: true });
  assert.deepEqual(pdf.scope, {});
  assert.deepEqual(pdf.writingTask, { kind: 'project', outputMode: 'suggest', verification: 'compile' });
  const why = writingRequest('为什么报错', { ...context, content: 'New source after the previous quote' });
  assert.equal(why.scope.readOnly, true);
  assert.equal(why.scope.selection, undefined);
  assert.equal(why.writingTask.verification, 'none');
  const layout = writingRequest('把这个图片改为双栏', context);
  assert.deepEqual(layout.scope, {});
  assert.equal(writingRequest('你不能看到我们整篇文章吗？', context).scope.readOnly, true);
});

test('PDF size and placement commands can propose source changes without the keyword 修改', () => {
  const pdf = { projectId: 'P', path: 'manuscript/tex/0_Abstract.tex', content: 'abstract', pdfReference: true };
  for (const input of [
    '讲这个图片放大为占两栏  并且将其放在第二页',
    '将这个图片放大为占两栏，并且将其放在第二页',
    '这张图放大一点', '把图片缩小', '图放到第二页', '将其移至第2页',
    'Enlarge this figure and place it on page 2',
  ]) {
    const request = writingRequest(input, pdf);
    assert.deepEqual(request.scope, {}, input);
    assert.deepEqual(request.writingTask, { kind: 'project', outputMode: 'suggest', verification: 'compile' }, input);
  }
  assert.deepEqual(writingRequest('只修改当前文件，把图片放大为占两栏', pdf).scope, {});
  assert.equal(writingRequest('放大这张图，不要编译', pdf).writingTask.verification, 'none');
  for (const input of ['只分析图片放大为两栏的效果', '只给建议，图片放大并放在第二页，不要修改文件', '请解释这张图', '不要放大图片']) {
    const request = writingRequest(input, pdf);
    assert.equal(request.scope.readOnly, true, input);
    assert.equal(request.writingTask.verification, 'none', input);
    assert.equal(request.writingTask.outputMode, 'suggest', input);
  }
  const selected = writingRequest('把图片放大为占两栏', context);
  assert.deepEqual(selected.scope, {});
});

test('a file-tree reference targets that source, and image layout can discover its referencing source',()=>{
 const file={projectId:'P',path:'manuscript/fig_tab/figure.tex',content:'unrelated current editor',fileReference:true};
 assert.deepEqual(writingRequest('调整这张图为双栏',file).scope,{});
 assert.deepEqual(writingRequest('改写这段',file).scope,{});
 assert.deepEqual(writingRequest('调整全文',file).scope,{});
 assert.deepEqual(writingRequest('把这张图放大为两栏',{...file,path:'manuscript/fig_tab/figure.jpg'}).scope,{});
 assert.equal(writingRequest('只解释这段',file).scope.readOnly,true);
});

test('figure replacement locates its project source even when an unrelated abstract is open', () => {
  const openAbstract = { projectId: 'P', path: 'manuscript/tex/0_Abstract.tex', content: 'abstract' };
  for (const input of ['帮我将这张图片加上标题 作为我们的图 1', '将我们的图 1 替换成刚才我给你的图片', '将上传附件插入论文']) {
    const request = writingRequest(input, openAbstract);
    assert.deepEqual(request.scope, {});
    assert.deepEqual(request.writingTask, { kind: 'project', outputMode: 'suggest', verification: 'compile' });
  }
  assert.deepEqual(writingRequest('润色当前文件', openAbstract).scope, {});
  assert.equal(writingRequest('为什么替换图1报错？', openAbstract).scope.readOnly, true);
  assert.equal(writingRequest('润色论文的表述', openAbstract).writingTask.kind, 'project');
});


test('file-limited requests carry a locating context for model target declaration', () => {
  const request = writingRequest('只修改当前文件中的图1，不要编译', {projectId:'P',path:'manuscript/main.tex',content:'text'});
  assert.deepEqual(request.scope,{});
  assert.equal(request.writingTask.kind,'project');assert.equal(request.writingTask.verification,'none');
  assert.equal(request.editContext.path,'manuscript/main.tex');
});

test('asset task paraphrases do not inherit an unrelated open abstract as the write target',()=>{
 const context={projectId:'P',path:'manuscript/0_Abstract.tex',content:'abstract'};
 for(const input of ['把图1换掉，用刚才那张','图1用刚才那张图片','把所有图片和表格文件重命名为 fig_1、tab_1'])assert.deepEqual(writingRequest(input,context).scope,{});
 assert.equal(writingRequest('图1用刚才那张图片',context).writingTask.verification,'compile');
 assert.equal(writingRequest('为什么把图1换掉失败了？',context).scope.readOnly,true);
 assert.deepEqual(writingRequest('只修改当前文件，图1用刚才那张图片',context).scope,{});
});

test('default task permissions cover the paper even when an unrelated source or quote is open',()=>{
 for(const open of [{projectId:'P',path:'manuscript/main.tex',content:'main'},context,{...context,selection:undefined,pdfReference:true},{...context,selection:undefined,fileReference:true}]){
  for(const input of ['同步修改结果表及正文引用','帮我看一下并改好','tab_main_results.tex 里面也要调整','润色当前文件']){
   const request=writingRequest(input,open);assert.deepEqual(request.scope,{},input);assert.equal(request.writingTask.kind,'project');
  }
 }
 assert.deepEqual(writingRequest('只修改当前文件',context).scope,{});
 assert.equal(writingRequest('只改选区',context).editContext.selection?.selectedText,'old');
 assert.equal(writingRequest('不要修改任何文件，只分析',context).scope.readOnly,true);
});

test('questions without an edit signal are answered read-only; formatting verbs still count as edits', () => {
  const open = { projectId: 'P', path: 'manuscript/tex/1_Introduction.tex', content: 'intro' };
  for (const input of ['你是谁', '当前我们正文有多少页', '你能看到什么？', '这篇论文的主要贡献是什么', '帮忙看看引言写得怎么样']) {
    assert.equal(writingRequest(input, open).scope.readOnly, true, input);
    assert.equal(writingRequest(input, open).writingTask.verification, 'none', input);
  }
  for (const input of ['把我的三点贡献标红', '帮我将三点贡献变红', '把标题加粗', '去掉第二段最后一句', '把这段扩写一下', '将所有图片重命名为 fig_1']) {
    assert.notEqual(writingRequest(input, open).scope.readOnly, true, input);
  }
});

test('imperative edits are never downgraded to read-only just because their verb is unlisted', () => {
  const open = { projectId: 'P', path: 'manuscript/tex/1_Introduction.tex', content: 'intro' };
  for (const input of ['将图 2 整理为双栏 并且将其标题变为红色', '把图1整理为单栏', '将表 1 的字体变为红色', '三点贡献统一用蓝色', '图注换一个更准确的说法', '把这段重新组织一下']) {
    assert.notEqual(writingRequest(input, open).scope.readOnly, true, input);
  }
  assert.equal(writingRequest('将图 2 整理为双栏 并且将其标题变为红色', open).writingTask.verification, 'compile');
  // Questions stay read-only, including ones that mention a layout word.
  for (const input of ['图1现在是单栏吗？', '我们正文有多少页', '你是谁', '这篇论文的主要贡献是什么']) {
    assert.equal(writingRequest(input, open).scope.readOnly, true, input);
  }
  // A question that also asks for the change is an edit.
  assert.notEqual(writingRequest('能帮我把图1改成双栏吗？', open).scope.readOnly, true);
});
