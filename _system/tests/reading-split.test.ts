import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type ReadingSplit from '../src/academic/ReadingSplit';
import type {readSplitSizes,readingSplitLimits} from '../src/academic/ReadingSplit';

const compiled=await build({entryPoints:[fileURLToPath(new URL('../src/academic/ReadingSplit.tsx',import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',plugins:[{name:'styles',setup(builder){builder.onLoad({filter:/\.css$/},()=>({contents:'',loader:'js'}));}}]});
const module={exports:{} as {default:typeof ReadingSplit;readSplitSizes:typeof readSplitSizes;readingSplitLimits:typeof readingSplitLimits}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const split=module.exports;

test('saved reading proportions validate each axis and recover corrupt preferences',()=>{
 const defaults={width:70,height:60};
 for(const raw of [null,'null','{broken','[]','"old"'])assert.deepEqual(split.readSplitSizes(raw,defaults),defaults);
 assert.deepEqual(split.readSplitSizes('{"width":47,"height":76}',defaults),{width:47,height:76});
 assert.deepEqual(split.readSplitSizes('{"width":0,"height":100}',defaults),{width:5,height:95});
 assert.deepEqual(split.readSplitSizes('{"width":"invalid","height":63}',defaults),{width:70,height:63});
});

test('reading limits preserve useful pane sizes and adapt to small containers',()=>{
 const wide=split.readingSplitLimits(1008,320,260);assert.equal(wide.minimum,32);assert.equal(wide.maximum,74);
 const small=split.readingSplitLimits(320,320,260);assert.equal(small.minimum,45);assert.equal(small.maximum,55);
 const stacked=split.readingSplitLimits(808,180,140);assert.equal(stacked.minimum,22.5);assert.equal(stacked.maximum,82.5);
});

test('hiding a reading split retains both child panes and removes its separator from keyboard navigation',()=>{
 const children=[createElement('article',{key:'source'},'Source state'),createElement('aside',{key:'note',hidden:true},'Retained note state')] as const;
 const html=renderToStaticMarkup(createElement(split.default,{className:'reader-body',storageKey:'test',enabled:false,label:'调整阅读与笔记比例',children:[...children]}));
 assert.match(html,/Source state/);assert.match(html,/Retained note state/);assert.match(html,/role="separator" tabindex="-1" hidden=""/);
 const shown=renderToStaticMarkup(createElement(split.default,{className:'reader-body',storageKey:'test',enabled:true,label:'调整阅读与笔记比例',children:[...children]}));
 assert.match(shown,/role="separator" tabindex="0"/);assert.match(shown,/aria-orientation="vertical"/);
});
