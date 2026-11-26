import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import AiMarkdown from '../src/components/AiMarkdown';
import {markdownDecorations,liveMarkdown,liveMarkdownExtensions,markdownFocus} from '../src/academic/markdownLivePreview';
import {researchMarkdownLanguage} from '../src/academic/researchMarkdownLanguage';

const stateFor=(doc:string,anchor=0)=>EditorState.create({doc,selection:{anchor},extensions:[researchMarkdownLanguage,...liveMarkdownExtensions]});
function decorations(state:EditorState,focused=false){
 const result:{from:number;to:number;spec:any}[]=[];
 markdownDecorations(state,focused).between(0,state.doc.length,(from,to,value)=>{result.push({from,to,spec:value.spec});});
 return result;
}

test('live Markdown formats headings and inline text while preserving exact source bytes',()=>{
 const content='# 标题\n\n这是 **重要结论** 与 *待验证判断*。\n\n- 第一项\n- 第二项\n';
 const state=stateFor(content);
 const rendered=decorations(state);
 assert.equal(state.doc.toString(),content);
 assert.ok(rendered.some(item=>item.spec.class==='markdown-live-heading h1'));
 assert.ok(rendered.some(item=>item.spec.class==='markdown-live-strong'));
 assert.ok(rendered.some(item=>item.from===0&&item.to===2));
 assert.equal(rendered.filter(item=>item.spec.widget?.label==='•').length,2);
});

test('the active paragraph exposes its own Markdown syntax in the same editable document',()=>{
 const content='# 标题\n\n原始 **表达**。';
 const state=stateFor(content,content.indexOf('表达'));
 const rendered=decorations(state,true);
 assert.ok(rendered.some(item=>item.from===0&&item.to===2));
 assert.ok(!rendered.some(item=>item.from===content.indexOf('**')&&item.to===content.indexOf('**')+2));
 assert.equal(state.doc.toString(),content);
});

test('Chinese headings with no space render while typing and keep the first title character',()=>{
 const content='正文\n##主要**创新**是\n\n下一段。';
 const start=content.indexOf('##');
 const state=stateFor(content,content.indexOf('是')+1);
 const live=decorations(state,true);
 assert.ok(live.some(item=>item.from===start&&item.spec.class==='markdown-live-heading h2'));
 assert.ok(live.some(item=>item.from===start&&item.to===start+2&&!item.spec.class));
 assert.ok(live.some(item=>item.spec.class==='markdown-live-strong'));
 assert.ok(!live.some(item=>item.from===start&&item.to>start+2&&!item.spec.class));
 assert.ok(!decorations(stateFor(content,start+1),true).some(item=>item.from===start&&item.to===start+2));
 assert.equal(state.doc.toString(),content);
});

test('compact heading compatibility stays outside fenced and indented code and leaves hash tags legible',()=>{
 const content='##issue42\n\n```md\n##代码示例\n```\n\n    ##缩进代码\n\n## 标题 ##';
 const rendered=decorations(stateFor(content));
 assert.equal(rendered.filter(item=>item.spec.class==='markdown-live-heading h2').length,1);
 assert.ok(!rendered.some(item=>item.from===0));
 assert.ok(rendered.some(item=>item.to===content.length&&item.from===content.lastIndexOf(' ##')));
});

test('tables and formulas render as blocks and become editable in place when selected',()=>{
 const table='| 方法 | 结果 |\n| --- | --- |\n| 原方法 | 待验证 |';
 const content=table+'\n\n$$\nE=mc^2\n$$';
 const state=stateFor(content);
 assert.equal(decorations(state).filter(item=>item.spec.block&&item.spec.widget).length,2);
 const active=stateFor(content,table.indexOf('原方法'));
 const tables=decorations(active,true).filter(item=>item.spec.widget?.text===table);
 assert.equal(tables.length,0);
 assert.equal(active.doc.toString(),content);
});

test('code and images stay safe and are never treated as formula input',()=>{
 const content='```txt\n$x$\n```\n\n![原图](https://example.test/tracker.png)\n\n真正的公式 $x^2$';
 const state=stateFor(content);
 const widgets=decorations(state).filter(item=>item.spec.widget).map(item=>item.spec.widget.text);
 assert.ok(widgets.includes('```txt\n$x$\n```'));
 assert.ok(widgets.includes('![原图](https://example.test/tracker.png)'));
 assert.ok(widgets.includes('$x^2$'));
 assert.ok(!widgets.includes('$x$'));
 assert.equal(state.doc.toString(),content);
});

test('focus, selection and content changes update decoration state without changing stored Markdown',()=>{
 let state=stateFor('# 标题\n\n正文');
 assert.ok(state.field(liveMarkdown).size);
 state=state.update({effects:markdownFocus.of(true)}).state;
 const rendered:any[]=[];
 state.field(liveMarkdown).between(0,state.doc.length,(from,to,value)=>{rendered.push({from,to,spec:value.spec});});
 assert.ok(!rendered.some(item=>item.from===0&&item.to===2));
 state=state.update({changes:{from:state.doc.length,insert:'补充'}}).state;
 assert.equal(state.doc.toString(),'# 标题\n\n正文补充');
 state=state.update({effects:markdownFocus.of(false)}).state;
 assert.ok(state.field(liveMarkdown).size);
});


test('inactive source links render as real anchors and expose editable Markdown when active',()=>{
 const link='[Evidence and Reasoning](/api/workspace/resources/paper-a/raw#page=3)';
 const content='引用 '+link+'，用于验证。';
 const from=content.indexOf('['),to=from+link.length;
 const state=stateFor(content),rendered=decorations(state);
 const widget=rendered.find(item=>item.from===from&&item.to===to&&item.spec.widget);
 assert.ok(widget);assert.equal(widget.spec.widget.text,link);
 const html=renderToStaticMarkup(createElement(AiMarkdown,{text:widget.spec.widget.text}));
 assert.match(html,/<a[^>]+href="\/api\/workspace\/resources\/paper-a\/raw#page=3"/);
 assert.match(html,/>Evidence and Reasoning<\/a>/);
 assert.equal(rendered.filter(item=>item.from>=from&&item.to<=to&&item.spec.widget).length,1);
 const editing=decorations(stateFor(content,content.indexOf('Reasoning')),true);
 assert.ok(!editing.some(item=>item.spec.widget?.text===link));
 assert.ok(!editing.some(item=>item.from>=from&&item.to<=to&&item.from!==item.to&&!item.spec.class));
 assert.equal(state.doc.toString(),content);
});

test('rendered links own their nested emphasis, images and formulas without overlapping replacements',()=>{
 const link='[**Evidence $x^2$**](/api/workspace/resources/paper-a/raw#page=2)';
 const content=link+'\n\n后续正文。';
 const rendered=decorations(stateFor(content)),inside=rendered.filter(item=>item.from<link.length&&item.to>0);
 assert.equal(inside.length,1);assert.equal(inside[0].spec.widget.text,link);
 const html=renderToStaticMarkup(createElement(AiMarkdown,{text:inside[0].spec.widget.text}));
 assert.match(html,/<a[^>]+href="\/api\/workspace\/resources\/paper-a\/raw#page=2"/);
 assert.match(html,/<strong>/);assert.match(html,/class="katex"/);
 const imageLink='[![原图](https://example.test/paper.png)](/api/workspace/resources/paper-a/raw)';
 const imageWidgets=decorations(stateFor(imageLink)).filter(item=>item.spec.widget);
 assert.equal(imageWidgets.length,1);assert.equal(imageWidgets[0].spec.widget.text,imageLink);
});


test('selecting any line of a wrapped link exposes the entire source without hidden link marks',()=>{
 const link='[Evidence and\nReasoning](/api/workspace/resources/paper-a/raw#page=4)';
 const state=stateFor(link,link.indexOf('Reasoning'));
 const active=decorations(state,true);
 assert.ok(active.some(item=>item.spec.class==='markdown-live-link'));
 assert.ok(!active.some(item=>item.spec.widget||item.from!==item.to&&!item.spec.class));
 assert.equal(state.doc.toString(),link);
});

test('cursor-only updates reuse decorations inside an active region and restore replaced widgets across regions',()=>{
 const link='[Evidence](/local)',code='```txt\nraw\n```',content=link+'\n\n'+code+'\n\nPlan $x^2$';
 let state=stateFor(content,1).update({effects:markdownFocus.of(true)}).state;
 const linkActive=state.field(liveMarkdown);
 state=state.update({selection:{anchor:3}}).state;
 assert.equal(state.field(liveMarkdown),linkActive);
 const summarize=(state:EditorState)=>{
  const rows:string[]=[];
  state.field(liveMarkdown).between(0,state.doc.length,(from,to,value)=>{
   rows.push(JSON.stringify([from,to,value.spec.class,value.spec.widget?.text,value.spec.block]));
  });
  return rows.sort();
 };
 for(const anchor of [content.indexOf('raw'),content.indexOf('Plan'),3,content.length,0]){
  state=state.update({selection:{anchor}}).state;
  const fresh=stateFor(content,anchor).update({effects:markdownFocus.of(true)}).state;
  assert.deepEqual(summarize(state),summarize(fresh));
 }
 state=state.update({effects:markdownFocus.of(false)}).state;
 assert.deepEqual(summarize(state),summarize(stateFor(content)));
});
