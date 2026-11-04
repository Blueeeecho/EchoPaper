import test from'node:test';
import assert from'node:assert/strict';
import{createElement}from'react';
import{renderToStaticMarkup}from'react-dom/server';
import AiMarkdown from'../src/components/AiMarkdown';
test('assistant Markdown renders headings, emphasis, lists, tables, code and math',()=>{const html=renderToStaticMarkup(createElement(AiMarkdown,{text:'# 标题\n\n**加粗**和*斜体*\n\n- 条目\n\n|A|B|\n|-|-|\n|1|2|\n\n`\\input{a}`\n\n$E=mc^2$'}));for(const expected of ['<h1>标题</h1>','<strong>加粗</strong>','<em>斜体</em>','<ul>','<table>','<code>','class="katex"'])assert.ok(html.includes(expected),expected);});
test('untrusted model output cannot execute HTML, JavaScript links, or remote image requests',()=>{const html=renderToStaticMarkup(createElement(AiMarkdown,{text:'<script>evil()</script>\n\n[bad](javascript:alert%281%29)\n\n![private](https://example.test/track.png)\n\n[official](https://example.test/)'}));assert.ok(!html.includes('<script'));assert.ok(!html.includes('href="javascript:'));assert.ok(!html.includes('<img'));assert.ok(html.includes('rel="noopener noreferrer"'));assert.ok(html.includes('[图片：private]'));});
