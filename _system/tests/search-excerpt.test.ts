import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type SearchExcerpt from '../src/academic/SearchExcerpt';
import type {ResourceSearchMatch} from '../shared/workspace-types';

const compiled=await build({
 entryPoints:[fileURLToPath(new URL('../src/academic/SearchExcerpt.tsx',import.meta.url))],
 bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},jsx:'automatic',
});
const module={exports:{} as {default:typeof SearchExcerpt}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const render=(match:ResourceSearchMatch)=>renderToStaticMarkup(createElement(module.exports.default,{match}));

test('search excerpts show their source and one-based page with mixed-language highlights',()=>{
 const html=render({source:'translation',snippet:'中文多智能体 Agent collaboration 研究',terms:['多智能体','agent'],page:3});
 assert.match(html,/中文译文 · 第 3 页/);
 assert.match(html,/<mark>多智能体<\/mark>/);
 assert.match(html,/<mark>Agent<\/mark>/);
});

test('search terms are treated literally, including regex metacharacters',()=>{
 const html=render({source:'ocr',snippet:'C++ [a+b] (test) a.b',terms:['C++','[a+b]','(test)','a.b'],page:1});
 for(const term of ['C++','[a+b]','(test)','a.b'])assert.ok(html.includes(`<mark>${term}</mark>`));
 assert.match(html,/OCR 原文 · 第 1 页/);
});

test('HTML in indexed text remains escaped text',()=>{
 const html=render({source:'text',snippet:'<script>alert("paper")</script> <img src=x onerror=alert(1)>',terms:['script','img']});
 assert.doesNotMatch(html,/<script\b|<img\b/);
 assert.match(html,/&lt;<mark>script<\/mark>&gt;/);
 assert.match(html,/&lt;<mark>img<\/mark> src=x/);
});

test('overlapping terms favor the full phrase and empty terms add no markup',()=>{
 const html=render({source:'metadata',snippet:'multi-agent reasoning',terms:['agent','multi-agent','', '  ']});
 assert.match(html,/<mark>multi-agent<\/mark> reasoning/);
 assert.equal((html.match(/<mark>/g)||[]).length,1);
 assert.doesNotMatch(render({source:'text',snippet:'plain text',terms:[],page:0}),/<mark>|第 0 页/);
});
