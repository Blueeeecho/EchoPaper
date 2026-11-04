import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import PdfVersionStatus from '../src/components/PdfVersionStatus.tsx';
const render=(props:Parameters<typeof PdfVersionStatus>[0])=>renderToStaticMarkup(createElement(PdfVersionStatus,props));
test('stale PDF uses a compact status with details only on hover, without an alert or banner',()=>{
 const html=render({hasPdf:true,stale:true,status:'succeeded',notice:'定位基于上次编译。'});
 assert.match(html,/>待更新<\/span>/);assert.match(html,/title="[^"\n]*源码已有修改/);
 assert.ok(html.includes('定位基于上次编译。'));assert.ok(!html.includes('role="alert"')&&!html.includes('pdf-notice'));
});
test('failed compilation remains identifiable and fresh or deliberately historical PDFs avoid stale warnings',()=>{
 assert.match(render({hasPdf:true,stale:true,status:'failed'}),/>编译失败 · 旧版<\/span>/);
 assert.equal(render({hasPdf:true,stale:false}), '');assert.equal(render({hasPdf:false,stale:true}), '');
 assert.equal(render({hasPdf:true,stale:true,historical:true}), '');
 assert.match(render({hasPdf:true,stale:false,notice:'此行对应附近位置。'}),/>定位说明<\/span>/);
});
