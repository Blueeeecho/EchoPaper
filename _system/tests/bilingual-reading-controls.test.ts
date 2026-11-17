import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {BilingualDivider,BilingualZoom,readBilingualLayout,bilingualZoom,DEFAULT_BILINGUAL_LAYOUT} from '../src/academic/BilingualLayout';

test('bilingual reading preferences recover missing or damaged data',()=>{
 for(const value of [null,'null','{broken','[]','"old"'])assert.deepEqual(readBilingualLayout(value),DEFAULT_BILINGUAL_LAYOUT);
 assert.deepEqual(readBilingualLayout('{"ratio":"70","sourceZoom":null,"translationZoom":false}'),DEFAULT_BILINGUAL_LAYOUT);
 const recovered=readBilingualLayout('{broken');recovered.sourceZoom=200;
 assert.equal(DEFAULT_BILINGUAL_LAYOUT.sourceZoom,100);
});

test('source and translation zooms persist independently of the split proportion',()=>{
 const preferences={ratio:68,sourceZoom:175,translationZoom:90};
 assert.deepEqual(readBilingualLayout(JSON.stringify(preferences)),preferences);
 assert.deepEqual(readBilingualLayout('{"ratio":999,"sourceZoom":20,"translationZoom":500}'),{ratio:85,sourceZoom:50,translationZoom:300});
 assert.equal(bilingualZoom(124.6),125);assert.equal(bilingualZoom(0),50);assert.equal(bilingualZoom(500),300);
});

test('the bilingual divider reports source and translated proportions with keyboard access',()=>{
 const controls={value:68,minimum:20,maximum:80,onChange(){},onCommit(){}};
 const html=renderToStaticMarkup(createElement(BilingualDivider,{controls}));
 assert.match(html,/role="separator" tabindex="0"/);assert.match(html,/aria-valuenow="68"/);
 assert.match(html,/aria-valuetext="原文 68%，译文 32%"/);
 const secondary=renderToStaticMarkup(createElement(BilingualDivider,{controls,focusable:false}));assert.match(secondary,/tabindex="-1"/);
});

test('zoom controls identify each side and enforce the supported range',()=>{
 const source=renderToStaticMarkup(createElement(BilingualZoom,{label:'原文',value:50,onChange(){}}));
 assert.match(source,/aria-label="缩小原文" disabled=""/);assert.match(source,/aria-label="原文缩放比例"/);
 const translated=renderToStaticMarkup(createElement(BilingualZoom,{label:'译文',value:300,onChange(){}}));
 assert.match(translated,/aria-label="放大译文" disabled=""/);assert.match(translated,/min="50" max="300"/);
});
