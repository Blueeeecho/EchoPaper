import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ReadingTranslation from '../src/academic/ReadingTranslation';

const actions={onDrag(){},onPin(){},onClose(){},onTranslate(){},onRetry(){}};
test('reader translation displays independent source results with copy and failed-source retry',()=>{
 const html=renderToStaticMarkup(createElement(ReadingTranslation,{...actions,error:'',selected:true,hasSources:true,busy:false,pinned:false,cards:[
  {id:'glm',label:'智谱',model:'GLM',text:'数字世界',status:'done'},
  {id:'other',label:'另一来源',model:'Other',text:'',status:'error',error:'来源暂不可用'},
 ]}));
 assert.match(html,/数字世界/);assert.match(html,/来源暂不可用/);
 assert.match(html,/aria-label="复制智谱译文"/);assert.match(html,/aria-label="重试另一来源翻译"/);
 assert.doesNotMatch(html,/存为摘录|写入课题笔记|显示原文|digital world/);
 assert.match(html,/disabled="" aria-label="复制另一来源译文"/);
});
test('an empty reader translation window explains the next action',()=>{
 const html=renderToStaticMarkup(createElement(ReadingTranslation,{...actions,error:'',selected:false,hasSources:true,busy:false,pinned:false,cards:[]}));
 assert.match(html,/选中文字后显示译文/);assert.match(html,/aria-label="关闭翻译"/);
});
