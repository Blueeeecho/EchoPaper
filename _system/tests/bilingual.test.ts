import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {buildBilingualDocument,bilingualStats,isAppendixHeading,isReferencesHeading,type LayoutPage} from '../shared/bilingual';
import {registerBilingualRoutes} from '../server/workspace/bilingual';
import {aiStudioPages} from '../server/workspace/document-layout';

const L=(id:string,type:string,text:string,extra:Record<string,unknown>={})=>({layout_id:id,type,text,...extra});

test('分区标题识别：参考文献与附录，不误伤正文章节',()=>{
 for(const value of ['References','REFERENCES','7 References','VII. REFERENCES','Bibliography:','参考文献','References and Notes'])assert.ok(isReferencesHeading(value),value);
 for(const value of ['Reference implementation details','Related Work','A study of references in long documents'])assert.ok(!isReferencesHeading(value),value);
 for(const value of ['Appendix','Appendix A: Proofs','APPENDIX','Supplementary Material','附录 A 证明'])assert.ok(isAppendixHeading(value),value);
 for(const value of ['Approach','Applications of attention','A Proof of Theorem 1'])assert.ok(!isAppendixHeading(value),value);
});

test('只翻正文：作者信息、图表公式、参考文献与附录保留原文',()=>{
 const pages:LayoutPage[]=[
  {page_num:0,layouts:[
   L('x0','aside_text','arXiv:2611.01234v1 [cs.CL]'),
   L('t','title','Layout-Aware Translation of Scientific PDFs',{sub_type:'title_1'}),
   L('a','text','Lin Chen, Mei Zhou, Arjun Rao'),
   L('ab','title','Abstract',{sub_type:'title_2'}),
   L('ab1','text','We present a layout-aware pipeline that translates only body text.'),
   L('i','title','1 Introduction',{sub_type:'title_2'}),
   L('i1','text','Existing tools redraw translated text into the original boxes, which forces smaller fonts',{merge_text:'begin'}),
   L('pn','page_number','1'),
  ],tables:[],images:[]},
  {page_num:1,layouts:[
   L('h','header','Layout-Aware Translation'),
   L('i2','text','and also translate axis labels inside charts.',{merge_text:'end'}),
   L('fig','image',''),
   L('cap','image_caption','Figure 1: Labels inside the chart are kept in English on purpose.'),
   L('eq','equation','\\[ E = mc^2 \\]'),
   L('tb','table',''),
   L('fn','page_footnote','Code is available at https://example.com/echopaper.'),
  ],tables:[{layout_id:'tb',table_html:'<table><tr><td>1</td></tr></table>'}],images:[{layout_id:'fig',data_url:'data:image/png;base64,AAAA'}]},
  {page_num:2,layouts:[
   L('c','title','3 Conclusion',{sub_type:'title_2'}),
   L('c1','text','Separating layout parsing from translation keeps figures faithful.'),
   L('r','title','References',{sub_type:'title_2'}),
   L('r1','ref_text','[1] A. Author. A study of document layout analysis, 2024.'),
   L('ap','title','A Proof of Proposition 1',{sub_type:'title_2'}),
   L('ap1','text','Proposition 1 follows directly from the eligibility function.'),
  ],tables:[],images:[]},
 ];
 const doc=buildBilingualDocument({pages});
 const by=new Map(doc.blocks.map(b=>[b.id,b]));
 assert.equal(doc.title,'Layout-Aware Translation of Scientific PDFs');
 // 页眉、页脚、页码、arXiv 侧栏不进入阅读视图
 for(const dropped of ['x0','pn','h'])assert.ok(!by.has(dropped),dropped);
 // 作者信息展示但不翻译；标题和摘要翻译
 assert.equal(by.get('a')!.role,'meta');assert.equal(by.get('a')!.translate,false);
 assert.ok(by.get('t')!.translate&&by.get('ab')!.translate&&by.get('ab1')!.translate);
 // 跨页段落拼回一段再翻译
 assert.ok(!by.has('i2'));
 assert.match(by.get('i1')!.text,/smaller fonts and also translate axis labels/);
 assert.deepEqual(by.get('i1')!.mergedIds,['i1','i2']);
 assert.ok(by.get('i1')!.translate);
 // 图片、公式、表格永不翻译；图注翻译
 for(const [id,reason] of [['fig','图片'],['eq','公式'],['tb','表格']] as const){assert.equal(by.get(id)!.translate,false,id);assert.equal(by.get(id)!.skipReason,reason);}
 assert.equal(by.get('fig')!.imageUrl,'data:image/png;base64,AAAA');
 assert.match(by.get('tb')!.tableHtml||'',/^<table/);
 assert.ok(by.get('cap')!.translate&&by.get('fn')!.translate);
 // 参考文献与附录保留原文，正文结论仍翻译
 assert.ok(by.get('c1')!.translate);
 for(const id of ['r','r1'])assert.equal(by.get(id)!.section,'references');
 for(const id of ['ap','ap1'])assert.equal(by.get(id)!.section,'appendix');
 for(const id of ['r','r1','ap','ap1'])assert.equal(by.get(id)!.translate,false,id);
 const stats=bilingualStats(doc);
 assert.equal(stats.figures,1);assert.equal(stats.equations,1);assert.equal(stats.tables,1);
 assert.ok(stats.translate>=6);
 // 附录可按需开启，参考文献始终不翻
 const withAppendix=buildBilingualDocument({pages},{translateAppendix:true});
 const appendix=withAppendix.blocks.filter(b=>b.section==='appendix');
 assert.ok(appendix.length&&appendix.every(b=>b.translate));
 assert.ok(withAppendix.blocks.filter(b=>b.section==='references').every(b=>!b.translate));
});

test('没有 References 标题时，参考文献条目本身也切换分区',()=>{
 const doc=buildBilingualDocument({pages:[{page_num:0,layouts:[
  L('a','text','The final paragraph of the conclusion section.'),
  L('b','ref_text','[1] An entry without a References heading.'),
  L('c','text','Trailing text after the list is still back matter.'),
 ]}]});
 assert.equal(doc.blocks[0].translate,true);
 assert.equal(doc.blocks[1].translate,false);
 assert.equal(doc.blocks[2].translate,false);
});

test('解析接口：缓存复用、原文更新后失效、译文存储、无密钥时明确报错',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bilingual-'));
 let hash='v1',calls=0;
 const pages=[{page_num:0,layouts:[{layout_id:'a',type:'text',text:'Hello world from the parsed document.'}],images:[{layout_id:'img',data_url:'https://example.invalid/i.png'}],tables:[]}];
 const upstream=(async(input:any,init:any)=>{
  const url=String(input);
  if(url.endsWith('/task')){calls++;return new Response(JSON.stringify({error_code:0,result:{task_id:'t1'}}),{headers:{'content-type':'application/json'}});}
  if(url.endsWith('/task/query'))return new Response(JSON.stringify({error_code:0,result:{status:'success',cost_page_num:1,parse_result_url:'https://example.invalid/r.json'}}),{headers:{'content-type':'application/json'}});
  if(url.endsWith('r.json'))return new Response(JSON.stringify({pages}),{headers:{'content-type':'application/json'}});
  return new Response('',{status:404});
 }) as unknown as typeof fetch;
 const file=path.join(root,'paper.pdf');await fs.writeFile(file,'%PDF-1.4 test');
 let key='bce-v3/ALTAK-test/secret';
 const make=()=>{const app=Fastify();app.setErrorHandler((e:any,_q,reply)=>reply.code(e.statusCode||500).send({error:e.message}));
  registerBilingualRoutes(app,root,{resourceFile:async id=>{if(id!=='a')throw Object.assign(new Error('缺失'),{statusCode:404});return{filename:file,resource:{name:'paper.pdf'} as any,hash};}},{fetch:upstream,readKey:async()=>key,sleep:async()=>{}});
  return app;};
 const app=make();
 try{
  assert.equal((await app.inject('/api/workspace/resources/a/bilingual')).json().parsed,false);
  const first=(await app.inject({method:'POST',url:'/api/workspace/resources/a/bilingual',payload:{}})).json();
  assert.equal(first.reused,false);assert.equal(first.layout.pages.length,1);assert.equal(calls,1);
  // 图片链接下载失败时留空，不阻断解析
  assert.equal(first.layout.pages[0].images[0].data_url,'');
  // 同一份原文不重复解析
  assert.equal((await app.inject({method:'POST',url:'/api/workspace/resources/a/bilingual',payload:{}})).json().reused,true);
  assert.equal(calls,1);
  // 译文存储与读回
  assert.equal((await app.inject({method:'POST',url:'/api/workspace/resources/a/bilingual/translations',payload:{entries:{k1:'译文一'}}})).json().stored,1);
  const loaded=(await app.inject('/api/workspace/resources/a/bilingual')).json();
  assert.equal(loaded.translations.k1,'译文一');assert.equal(loaded.stale,false);
  // 原文变化后标记为过期，并在重新解析时丢弃旧译文
  hash='v2';
  assert.equal((await app.inject('/api/workspace/resources/a/bilingual')).json().stale,true);
  const second=(await app.inject({method:'POST',url:'/api/workspace/resources/a/bilingual',payload:{}})).json();
  assert.equal(second.reused,false);assert.equal(calls,2);
  assert.deepEqual((await app.inject('/api/workspace/resources/a/bilingual')).json().translations,{});
  // 其他资料不受影响；无密钥时给出可操作的提示
  assert.equal((await app.inject('/api/workspace/resources/zz/bilingual')).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:'/api/workspace/resources/a/bilingual/translations',payload:{entries:{k:1}}})).statusCode,400);
  key='';
  const noKey=await app.inject({method:'POST',url:'/api/workspace/resources/a/bilingual',payload:{force:true}});
  assert.equal(noKey.statusCode,503);
  assert.match(noKey.json().error,/密钥/);
  assert.equal((await app.inject('/api/workspace/bilingual/credential')).json().configured,false);
 }finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});

test('参考文献之后的检查单与附录都归为附录类，不混进参考文献',()=>{
 const doc=buildBilingualDocument({pages:[{page_num:0,layouts:[
  L('c','title','8 Conclusion'),
  L('c1','text','We conclude with a short summary of the findings.'),
  L('r','title','References'),
  L('r1','ref_text','[1] A. Author. Some cited work, 2025.'),
  L('k','title','NeurIPS Paper Checklist'),
  L('k1','text','The answer NA means that the core method development does not apply.'),
  L('a','title','Appendix A. Proofs'),
  L('a1','text','Proposition 1 follows from the eligibility function.'),
 ]}]});
 const by=new Map(doc.blocks.map(b=>[b.id,b]));
 assert.equal(by.get('c1')!.section,'body');
 assert.equal(by.get('c1')!.translate,true);
 for(const id of ['r','r1'])assert.equal(by.get(id)!.section,'references',id);
 for(const id of ['k','k1','a','a1'])assert.equal(by.get(id)!.section,'appendix',id);
 for(const id of ['r','r1','k','k1','a','a1'])assert.equal(by.get(id)!.translate,false,id);
});

test('用量计数与自动换引擎：智能云按月、星河社区按天，额度不足时换引擎',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bilingual-usage-'));
 const file=path.join(root,'p.pdf');await fs.writeFile(file,'%PDF-1.4');
 const hits:string[]=[];
 const pages=[{page_num:0,layouts:[{layout_id:'a',type:'text',text:'A paragraph of the parsed document.'}],images:[],tables:[]}];
 const aiStudioLine=JSON.stringify({errorCode:0,result:{layoutParsingResults:[{prunedResult:{width:1224,height:1584,
  parsing_res_list:[{block_label:'text',block_content:'A paragraph of the parsed document.',block_bbox:[1,2,3,4],block_order:1}]},
  markdown:{text:'',images:{}},outputImages:{}}]}});
 const json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 const upstream=(async(input:any)=>{
  const url=String(input);
  // 智能云：提交 /task、轮询 /task/query、再下载结果
  if(url.endsWith('/task')){hits.push('unlimited-ocr');return json({error_code:0,result:{task_id:'t'}});}
  if(url.endsWith('/task/query'))return json({error_code:0,result:{status:'success',cost_page_num:40,parse_result_url:'https://x.invalid/r.json'}});
  if(url.endsWith('r.json'))return json({pages});
  // 星河社区：另一套地址、另一套包装，结果是 JSONL
  if(url.endsWith('/api/v2/ocr/jobs')){hits.push('aistudio-vl');return json({errorCode:0,data:{jobId:'j1'}});}
  if(url.endsWith('/api/v2/ocr/jobs/j1'))return json({errorCode:0,data:{state:'done',extractProgress:{extractedPages:7},resultUrl:{jsonUrl:'https://x.invalid/j.jsonl'}}});
  if(url.endsWith('j.jsonl'))return new Response(aiStudioLine,{headers:{'content-type':'application/x-ndjson'}});
  return new Response('',{status:404});
 }) as unknown as typeof fetch;
 let hash='h1';
 const app=Fastify();app.setErrorHandler((e:any,_q,reply)=>reply.code(e.statusCode||500).send({error:e.message}));
 registerBilingualRoutes(app,root,{resourceFile:async()=>({filename:file,resource:{name:'p.pdf'} as any,hash})},{fetch:upstream,readKey:async()=>'bce-v3/k',sleep:async()=>{}});
 try{
  // 只有两个渠道，各自的额度周期不同
  const listed=(await app.inject('/api/workspace/bilingual/usage')).json();
  assert.deepEqual(listed.engines.map((e:any)=>[e.id,e.period]),[['unlimited-ocr','month'],['aistudio-vl','day']]);
  assert.equal(listed.engines[1].quota,20000);

  // 设额度：智能云 50 页，剩余不足 20 页就换
  assert.equal((await app.inject({method:'PUT',url:'/api/workspace/bilingual/usage',payload:{quota:{'unlimited-ocr':50},threshold:20,autoSwitch:true}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/workspace/resources/a/bilingual',payload:{}})).json().engine,'unlimited-ocr');
  const first=(await app.inject('/api/workspace/bilingual/usage')).json().engines[0];
  assert.equal(first.used,40);assert.equal(first.remaining,10);

  // 只剩 10 页（低于阈值 20），换文件再解析时自动改用星河社区
  hash='h2';
  const again=(await app.inject({method:'POST',url:'/api/workspace/resources/a/bilingual',payload:{}})).json();
  assert.equal(again.engine,'aistudio-vl');
  assert.match(again.switched,/本月只剩 10 页.*自动改用/);
  assert.deepEqual(hits,['unlimited-ocr','aistudio-vl']);
  // 星河社区按天计数，用的是它自己返回的页数
  const after=(await app.inject('/api/workspace/bilingual/usage')).json();
  assert.equal(after.engines[1].used,7);
  assert.equal(after.engines[1].remaining,20000-7);
  assert.equal(after.day,`${after.month}-${String(new Date().getDate()).padStart(2,'0')}`);

  // 关掉自动切换后不再换
  await app.inject({method:'PUT',url:'/api/workspace/bilingual/usage',payload:{quota:{'unlimited-ocr':50},threshold:20,autoSwitch:false}});
  hash='h3';
  assert.equal((await app.inject({method:'POST',url:'/api/workspace/resources/a/bilingual',payload:{}})).json().engine,'unlimited-ocr');

  // 清空额度是显式「不设额度」，不会被默认额度顶回来
  await app.inject({method:'PUT',url:'/api/workspace/bilingual/usage',payload:{quota:{'aistudio-vl':''},threshold:20,autoSwitch:false}});
  assert.equal((await app.inject('/api/workspace/bilingual/usage')).json().engines[1].remaining,null);
  // 额度必须是合理页数
  assert.equal((await app.inject({method:'PUT',url:'/api/workspace/bilingual/usage',payload:{quota:{'unlimited-ocr':-5}}})).statusCode,400);
 }finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});
test('AI Studio 的 JSONL 按页展开，标签归一化后公式不会被当成正文', ()=>{
 const line=(pages:any[])=>JSON.stringify({logId:'x',errorCode:0,result:{layoutParsingResults:pages}});
 const page=(blocks:any[])=>({prunedResult:{width:1224,height:1584,parsing_res_list:blocks},markdown:{text:'',images:{}},outputImages:{}});
 const jsonl=[
  line([page([
   {block_label:'doc_title',block_content:'A Title',block_bbox:[266,197,956,274],block_order:1},
   {block_label:'abstract',block_content:'Body sentence.',block_bbox:[282,532,940,862],block_order:3},
   {block_label:'paragraph_title',block_content:'1 Introduction',block_bbox:[213,902,384,925],block_order:2},
   // 旧版映射漏了 display_formula，公式会被当正文翻掉，这里把它钉住。
   {block_label:'display_formula',block_content:'$$ y=x $$',block_bbox:[300,1000,900,1040],block_order:4},
   {block_label:'number',block_content:'1',block_bbox:[600,1540,620,1560],block_order:5},
   {block_label:'brand_new_formula_kind',block_content:'$$ z=1 $$',block_bbox:[300,1100,900,1140],block_order:6},
  ])]),
  line([page([{block_label:'table',block_content:'<table><tr><td>1</td></tr></table>',block_bbox:[100,200,500,400],block_order:null}])]),
 ].join('\n');
 const pages=aiStudioPages(jsonl);
 assert.equal(pages.length,2);
 assert.deepEqual(pages[0].meta,{page_width:1224,page_height:1584});
 // block_order 齐全时按阅读顺序排，标题要排在摘要前面
 assert.deepEqual(pages[0].layouts?.map(l=>l.type),['title','title','text','equation','page_number','equation']);
 assert.deepEqual(pages[0].layouts?.[0].position,[266,197,690,77]);
 assert.equal(pages[1].layouts?.[0].type,'table');
 assert.equal(pages[1].tables?.[0].table_html,'<table><tr><td>1</td></tr></table>');
 assert.equal(pages[1].tables?.[0].layout_id,pages[1].layouts?.[0].layout_id);

 const doc=buildBilingualDocument({pages});
 const formulas=doc.blocks.filter(b=>b.role==='equation');
 assert.equal(formulas.length,2);
 assert.ok(formulas.every(b=>!b.translate&&b.skipReason==='公式'));
 assert.ok(!doc.blocks.some(b=>b.type==='page_number'));
});

test('AI Studio：提交遇到 408 与排队限制会重试，鉴权失败则立刻放弃且原因可见',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bilingual-retry-'));
 const file=path.join(root,'p.pdf');await fs.writeFile(file,'%PDF-1.4');
 const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 const line=JSON.stringify({errorCode:0,result:{layoutParsingResults:[
  {prunedResult:{width:1224,height:1584,parsing_res_list:[{block_label:'text',block_content:'First page body.',block_bbox:[1,2,3,4],block_order:1}]},markdown:{text:'',images:{}},outputImages:{}},
  {prunedResult:{width:1224,height:1584,parsing_res_list:[{block_label:'text',block_content:'Second page body.',block_bbox:[1,2,3,4],block_order:1}]},markdown:{text:'',images:{}},outputImages:{}},
 ]}});
 let submits=0,token='t';
 const upstream=(async(input:any)=>{
  const url=String(input);
  if(url.endsWith('/api/v2/ocr/jobs')){
   submits++;
   if(token==='bad')return json({code:403,msg:'token invalid'},403);
   // 大文件上传途中会被掐断（408），提交队列满时是 400 但同样只是暂时的
   if(submits===1)return json({code:408,msg:'Request Timeout'},408);
   if(submits===2)return json({code:400,msg:'任务提交队列已满，请稍后重试'},400);
   return json({errorCode:0,data:{jobId:'j'}});
  }
  if(url.endsWith('/api/v2/ocr/jobs/j'))return json({errorCode:0,data:{state:'done',extractProgress:{extractedPages:2},resultUrl:{jsonUrl:'https://x.invalid/j.jsonl'}}});
  if(url.endsWith('j.jsonl'))return new Response(line,{headers:{'content-type':'application/x-ndjson'}});
  return new Response('',{status:404});
 }) as unknown as typeof fetch;
 const app=Fastify();
 // 真实服务端对 5xx 只回笼统文案，带 expose 的才原样透出，这里照同样规则断言
 app.setErrorHandler((e:any,_q,reply)=>reply.code(e.statusCode||500).send({error:e.statusCode>=500&&!e.expose?'服务器操作失败，请查看运行日志。':e.message}));
 registerBilingualRoutes(app,root,{resourceFile:async()=>({filename:file,resource:{name:'p.pdf'} as any,hash:'h'})},{fetch:upstream,readKey:async()=>token,sleep:async()=>{}});
 try{
  const ok=(await app.inject({method:'POST',url:'/api/workspace/resources/a/bilingual',payload:{engine:'aistudio-vl'}})).json();
  assert.equal(submits,3);
  assert.deepEqual(ok.layout.pages.map((p:any)=>p.page_num),[1,2]);
  assert.equal(ok.layout.costPages,2);
  // 鉴权失败不重试，并且前端能看到真实原因
  token='bad';submits=0;
  const bad=await app.inject({method:'POST',url:'/api/workspace/resources/a/bilingual',payload:{force:true,engine:'aistudio-vl'}});
  assert.equal(submits,1);
  assert.match(bad.json().error,/访问令牌无效/);
 }finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
});
