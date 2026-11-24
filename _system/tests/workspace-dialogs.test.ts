import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import * as React from 'react';
import {DEFAULT_AGENT_LIMITS,defaultAgentDefinitions} from '../shared/agent-types';
import type ModelSettings from '../src/components/ModelSettings';
import type Backups from '../src/components/Backups';
import type HubDialog from '../src/academic/HubDialog';
import type Presentations from '../src/academic/Presentations';
import type NoteAssistant from '../src/academic/NoteAssistant';

type Element=React.ReactElement<any>;
// Initialise the real editor module before installing the minimal dialog-only DOM stub.
createRequire(import.meta.url)('@uiw/react-codemirror');
const presentationFile={hash:'saved-hash',document:{schemaVersion:1,id:'presentation-test',title:'演示流程测试',language:'zh',notesLanguage:'zh',preserveExamples:true,styleId:'hzau-clean',styleVersion:'1.0.0',presenter:'',advisor:'',durationMinutes:10,targetSlides:8,sources:[],slides:[],createdAt:'2026-11-13T00:00:00Z',updatedAt:'2026-11-13T00:00:00Z'}};
const modules=await Promise.all(['components/ModelSettings','components/Backups','academic/HubDialog','academic/Presentations','academic/NoteAssistant'].map(async name=>{
 const result=await build({entryPoints:[fileURLToPath(new URL(`../src/${name}.tsx`,import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'},jsx:'automatic'});
 return result.outputFiles[0].text;
}));

function harness<P>(compiled:string,props:P) {
 const slots:any[]=[],dependencies:(unknown[]|undefined)[]=[],cleanups:(void|(()=>void))[]=[];
 let cursor=0,effects:(()=>void)[]=[];
 const hooks={...React,
  useState(initial:any){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],(value:any)=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},
  useRef(initial:any){const index=cursor++;return slots[index]??={current:initial};},
  useMemo(compute:()=>unknown,next:unknown[]){const index=cursor++,previous=dependencies[index];if(!previous||next.some((value,position)=>!Object.is(value,previous[position]))){slots[index]=compute();dependencies[index]=next;}return slots[index];},
  useCallback(callback:unknown,next:unknown[]){return hooks.useMemo(()=>callback,next);},
  useId(){return hooks.useMemo(()=>'note-assistant-test',[]);},
  useEffect(effect:()=>void|(()=>void),next?:unknown[]){const index=cursor++,previous=dependencies[index];if(!next||!previous||next.some((value,position)=>!Object.is(value,previous[position]))){dependencies[index]=next;effects.push(()=>{cleanups[index]?.();cleanups[index]=effect();});}},
 };
 const loaded={exports:{} as {default:(props:P)=>Element}},require=createRequire(import.meta.url);
 new Function('require','module','exports',compiled)((name:string)=>name==='react'?hooks:require(name),loaded,loaded.exports);
 return {render(){cursor=0;const tree=loaded.exports.default(props),pending=effects;effects=[];pending.forEach(effect=>effect());return tree;},dispose(){cleanups.forEach(cleanup=>cleanup?.());}};
}
function all(node:React.ReactNode,predicate:(element:Element)=>boolean):Element[] {
 if(Array.isArray(node))return node.flatMap(child=>all(child,predicate));
 if(!React.isValidElement(node))return [];
 const element=node as Element;return [...(predicate(element)?[element]:[]),...all(element.props.children,predicate)];
}
const text=(node:React.ReactNode):string=>Array.isArray(node)?node.map(text).join(''):React.isValidElement(node)?text((node as Element).props.children):typeof node==='string'||typeof node==='number'?String(node):'';
function button(tree:Element,label:string){const found=all(tree,element=>element.type==='button'&&(element.props['aria-label']===label||text(element)===label))[0];assert.ok(found,`button ${label} exists`);return found;}
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
function browser() {
 const listeners=new Map<string,Set<(event:any)=>void>>();
 const events={addEventListener(name:string,handler:(event:any)=>void){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name)!.add(handler);},removeEventListener(name:string,handler:(event:any)=>void){listeners.get(name)?.delete(handler);},dispatchEvent(){return true;}};
 const storage=new Map<string,string>();
 const document={...events,activeElement:null,body:{},querySelector(){return null;}};
 const window={...events,document,setTimeout,clearTimeout};
 const previous={window:globalThis.window,document:globalThis.document,localStorage:globalThis.localStorage};
 Object.assign(globalThis,{window,document,localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)}});
 return {storage,listeners,restore(){Object.assign(globalThis,previous);}};
}

test('model settings keep dirty edits on close and discard only through the explicit action',async context=>{
 const environment=browser();
 const config={version:2,revision:'initial',translationFingerprint:'t',assistantFingerprint:'a',providers:[{id:'minimax',label:'示例连接',kind:'openai-compatible',baseUrl:'http://localhost/v1',plan:'',auth:'none',enabled:true,configured:true}],models:[],translations:[],translationLayout:'stack',assistant:{modelIds:[],defaultModelId:null,roles:defaultAgentDefinitions(),limits:DEFAULT_AGENT_LIMITS}};
 context.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(config)));
 let closed=0;
 const view=harness<Parameters<typeof ModelSettings>[0]>(modules[0],{initialTab:'assistant',onClose(){closed++;}});context.after(()=>{view.dispose();environment.restore();});
 view.render();await settle();let tree=view.render();
 const name=all(tree,element=>element.props['aria-label']==='服务名称')[0];assert.ok(name);name.props.onChange({target:{value:'未保存的新名称'}});tree=view.render();
 button(tree,'关闭模型设置').props.onClick();tree=view.render();
 assert.equal(closed,0);assert.match(text(tree),/设置有未保存修改/);
 button(tree,'继续编辑').props.onClick();tree=view.render();assert.equal(all(tree,element=>element.props['aria-label']==='服务名称')[0].props.value,'未保存的新名称');
 button(tree,'关闭模型设置').props.onClick();tree=view.render();button(tree,'放弃修改并关闭').props.onClick();assert.equal(closed,1);
});

test('backup loading and read failures never report an empty successful backup list',async context=>{
 const environment=browser();let resolve!:(value:Response)=>void;
 context.mock.method(globalThis,'fetch',()=>new Promise<Response>(done=>{resolve=done;}));
 const view=harness<Parameters<typeof Backups>[0]>(modules[1],{});context.after(()=>{view.dispose();environment.restore();});
 let tree=view.render();assert.match(text(tree),/正在读取完整备份/);assert.doesNotMatch(text(tree),/尚无完整备份/);
 resolve(new Response(JSON.stringify({error:'目录暂不可读'}),{status:500}));await settle();tree=view.render();
 assert.match(text(tree),/备份列表读取失败，目录暂不可读/);assert.doesNotMatch(text(tree),/尚无完整备份/);assert.ok(button(tree,'重试'));
});

test('backup actions publish busy state while waiting for the save guard',async context=>{
 const environment=browser();context.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({backups:[],maintenance:false})));
 let resolve!:(value:boolean)=>void;const busy:boolean[]=[];
 const view=harness<Parameters<typeof Backups>[0]>(modules[1],{beforeBackup:()=>new Promise<boolean>(done=>{resolve=done;}),onBusyChange:value=>busy.push(value)});context.after(()=>{view.dispose();environment.restore();});
 view.render();await settle();let tree=view.render();button(tree,'创建完整备份').props.onClick();tree=view.render();
 assert.equal(busy.at(-1),true);assert.equal(tree.props['aria-busy'],true);
 resolve(false);await settle();view.render();assert.equal(busy.at(-1),false);
});

test('disabled and suspended dialogs do not close through Escape or the backdrop',context=>{
 const environment=browser(),{listeners}=environment;let closed=0;
 const props:Parameters<typeof HubDialog>[0]={title:'备份与恢复',children:null,onClose(){closed++;},closeDisabled:true};
 const view=harness(modules[2],props);context.after(()=>{view.dispose();environment.restore();});let tree=view.render();
 assert.equal(button(tree,'关闭').props.disabled,true);
 for(const key of listeners.get('keydown')||[])key({key:'Escape'});
 tree.props.onMouseDown({target:tree,currentTarget:tree});assert.equal(closed,0);
 props.suspended=true;tree=view.render();assert.equal(tree.props.style.display,'none');assert.equal(listeners.get('keydown')?.size,0);
 props.suspended=false;props.closeDisabled=false;view.render();for(const key of listeners.get('keydown')||[])key({key:'Escape'});assert.equal(closed,1);
});

test('unattached presentation materials survive leave and restore as a local draft',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});const environment=browser();
 const saved=presentationFile;
 context.mock.method(globalThis,'fetch',async(url:string)=>new Response(JSON.stringify(url==='/api/ai/config'?{configured:false}:url==='/api/presentation-styles'?{styles:[]}:url.endsWith('/jobs')?{jobs:[]}:saved)));
 let guard:(()=>Promise<boolean>)|undefined;
 const props:Parameters<typeof Presentations>[0]={presentationId:'presentation-test',onNavigate(){},onDirtyGuard:value=>{guard=value;}};
 const view=harness(modules[3],props);let restored:ReturnType<typeof harness>|undefined;
 context.after(()=>{view.dispose();restored?.dispose();environment.restore();});
 view.render();await settle();let tree=view.render();
 const source=all(tree,element=>element.type==='textarea'&&element.props.placeholder?.startsWith('粘贴研究问题'))[0];assert.ok(source);
 source.props.onChange({target:{value:'尚未点击接入的研究材料。'}});tree=view.render();assert.ok(guard);
 const leaving=guard();tree=view.render();assert.match(text(tree),/尚有未接入的文字材料/);
 button(tree,'保留草稿并离开').props.onClick();assert.equal(await leaving,true);
 const draft=JSON.parse(environment.storage.get('echopaper:presentation-draft:presentation-test')!);assert.equal(draft.sourceDraft.text,'尚未点击接入的研究材料。');
 view.dispose();restored=harness(modules[3],props);restored.render();await settle();tree=restored.render();
 button(tree,'恢复草稿').props.onClick();tree=restored.render();
 assert.equal(all(tree,element=>element.type==='textarea'&&element.props.placeholder?.startsWith('粘贴研究问题'))[0].props.value,'尚未点击接入的研究材料。');
});

test('the presentation can be edited during a job-list failure and recovers a valid old job after retry',async context=>{
 const environment=browser();
 let historyUnavailable=true, submitted:unknown;
 const failed={id:'prior-outline',kind:'outline',status:'failed',documentHash:presentationFile.hash,error:'模型大纲未通过结构校验',checks:[]};
 context.mock.method(globalThis,'fetch',async(url:string,options?:RequestInit)=>{
  if(url.endsWith('/outline')){
   submitted=JSON.parse(String(options?.body));
   return new Response(JSON.stringify({...failed,id:'recovered',status:'queued'}));
  }
  if(url.endsWith('/jobs')){
   return historyUnavailable?new Response(JSON.stringify({error:'任务目录暂不可读'}),{status:503}):new Response(JSON.stringify({jobs:[failed]}));
  }
  const data=url==='/api/ai/config'?{configured:false}:url==='/api/presentation-styles'?{styles:[]}:presentationFile;
  return new Response(JSON.stringify(data));
 });
 const view=harness<Parameters<typeof Presentations>[0]>(modules[3],{presentationId:'presentation-test',onNavigate(){}});
 context.after(()=>{view.dispose();environment.restore();});
 view.render();await settle();let tree=view.render();
 assert.match(text(tree),/任务记录读取失败/);
 assert.ok(all(tree,element=>element.type==='textarea'&&element.props.placeholder?.startsWith('粘贴研究问题')).length);
 historyUnavailable=false;
 button(tree,'重试任务记录').props.onClick();await settle();tree=view.render();
 assert.doesNotMatch(text(tree),/任务记录读取失败/);
 button(tree,'恢复上次大纲').props.onClick();await settle();
 assert.deepEqual(submitted,{expectedHash:presentationFile.hash,manual:false,recoverJobId:'prior-outline'});
});

test('presentation material search ignores cancelled late query results',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});const environment=browser();
 const requests:{signal:AbortSignal;resolve:(response:Response)=>void}[]=[];
 context.mock.method(globalThis,'fetch',(url:string,options:RequestInit)=>{
  if(url.startsWith('/api/workspace/resources?'))return new Promise<Response>(resolve=>requests.push({signal:options.signal!,resolve}));
  return Promise.resolve(new Response(JSON.stringify(url==='/api/ai/config'?{configured:false}:url==='/api/presentation-styles'?{styles:[]}:url.endsWith('/jobs')?{jobs:[]}:presentationFile)));
 });
 const view=harness<Parameters<typeof Presentations>[0]>(modules[3],{presentationId:'presentation-test',onNavigate(){}});
 context.after(()=>{view.dispose();environment.restore();});view.render();await settle();let tree=view.render();
 button(tree,'从资料库接入').props.onClick();tree=view.render();
 const search=()=>all(tree,element=>element.type==='input'&&element.props.placeholder==='输入论文或材料名称')[0];
 search().props.onChange({target:{value:'first'}});tree=view.render();context.mock.timers.tick(200);assert.equal(requests.length,1);
 search().props.onChange({target:{value:'second'}});tree=view.render();assert.equal(requests[0].signal.aborted,true);context.mock.timers.tick(200);
 requests[1].resolve(new Response(JSON.stringify({resources:[{id:'new',name:'当前查询材料.pdf',path:'new.pdf',kind:'file',missing:false}]})));await settle();
 requests[0].resolve(new Response(JSON.stringify({resources:[{id:'old',name:'过时查询材料.pdf',path:'old.pdf',kind:'file',missing:false}]})));await settle();tree=view.render();
 assert.match(text(tree),/当前查询材料.pdf/);assert.doesNotMatch(text(tree),/过时查询材料.pdf/);
});

test('connecting a library material preserves unconnected pasted text',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});const environment=browser();
 context.mock.method(globalThis,'fetch',async(url:string)=>{
  const result=url.startsWith('/api/workspace/resources?')?{resources:[{id:'library-text',name:'已存材料.txt',path:'notes.txt',kind:'file',missing:false}]}:url.endsWith('/sources')?{...presentationFile,hash:'with-library-source'}:url==='/api/ai/config'?{configured:false}:url==='/api/presentation-styles'?{styles:[]}:url.endsWith('/jobs')?{jobs:[]}:presentationFile;
  return new Response(JSON.stringify(result));
 });
 const view=harness<Parameters<typeof Presentations>[0]>(modules[3],{presentationId:'presentation-test',onNavigate(){}});
 context.after(()=>{view.dispose();environment.restore();});view.render();await settle();let tree=view.render();
 const source=()=>all(tree,element=>element.type==='textarea'&&element.props.placeholder?.startsWith('粘贴研究问题'))[0];
 source().props.onChange({target:{value:'等待接入的手写材料'}});tree=view.render();button(tree,'从资料库接入').props.onClick();tree=view.render();context.mock.timers.tick(200);await settle();tree=view.render();
 const resource=all(tree,element=>element.type==='button'&&text(element).includes('已存材料.txt'))[0];assert.ok(resource);resource.props.onClick();await settle();tree=view.render();
 assert.equal(source().props.value,'等待接入的手写材料');
});

const noteModel={id:'test-model',label:'测试助手',providerLabel:'示例服务',configured:true};
const noteConfig={models:[noteModel],defaultModel:noteModel.id};

test('note assistant replaces only the captured selection after explicit apply and supports undo',async context=>{
 let requested:any;
 context.mock.method(globalThis,'fetch',async(url:string,input?:RequestInit)=>{
  if(url==='/api/ai/config')return new Response(JSON.stringify(noteConfig));
  requested=JSON.parse(String(input?.body));
  return new Response(JSON.stringify({text:'清晰表达',model:noteModel.label}));
 });
 const props:Parameters<typeof NoteAssistant>[0]={value:'前文\n原始内容\n后文',editorRef:{current:{selectionStart:3,selectionEnd:7} as HTMLTextAreaElement},onChange(value){props.value=value;}};
 const view=harness(modules[4],props);context.after(()=>view.dispose());
 let tree=view.render();button(tree,'AI 助手').props.onClick();view.render();await settle();tree=view.render();
 assert.equal(all(tree,element=>element.props['aria-label']==='笔记修改范围')[0].props.value,'selection');
 button(tree,'生成修改建议').props.onClick();view.render();await settle();tree=view.render();
 assert.equal(props.value,'前文\n原始内容\n后文');
 assert.deepEqual(requested.selection,{from:3,to:7});
 button(tree,'替换选中内容').props.onClick();tree=view.render();
 assert.equal(props.value,'前文\n清晰表达\n后文');
 button(tree,'撤销 AI 修改').props.onClick();tree=view.render();
 assert.equal(props.value,'前文\n原始内容\n后文');
 assert.equal(all(tree,element=>element.type==='form').length,0);
});

test('note assistant keeps concurrent typing and blocks stale whole-note proposals',async context=>{
 let resolve!:(value:Response)=>void;
 context.mock.method(globalThis,'fetch',async(url:string)=>url==='/api/ai/config'?new Response(JSON.stringify(noteConfig)):new Promise<Response>(done=>{resolve=done;}));
 const changes:string[]=[];
 const props:Parameters<typeof NoteAssistant>[0]={value:'开始的笔记',editorRef:{current:null},onChange(value){changes.push(value);}};
 const view=harness(modules[4],props);context.after(()=>view.dispose());
 let tree=view.render();button(tree,'AI 助手').props.onClick();view.render();await settle();tree=view.render();button(tree,'生成修改建议').props.onClick();view.render();
 props.value='开始的笔记\n用户继续输入';view.render();resolve(new Response(JSON.stringify({text:'建议替换',model:noteModel.label})));await settle();tree=view.render();
 assert.equal(button(tree,'应用到全文').props.disabled,true);
 button(tree,'应用到全文').props.onClick();
 assert.deepEqual(changes,[]);
 assert.match(text(tree),/笔记已继续编辑/);
});

test('note assistant cancellation ignores late responses and aborts the request',async context=>{
 let resolve!:(value:Response)=>void,signal:AbortSignal|undefined;
 context.mock.method(globalThis,'fetch',async(url:string,input?:RequestInit)=>{
  if(url==='/api/ai/config')return new Response(JSON.stringify(noteConfig));
  signal=input?.signal as AbortSignal;
  return new Promise<Response>(done=>{resolve=done;});
 });
 const view=harness<Parameters<typeof NoteAssistant>[0]>(modules[4],{value:'笔记内容',editorRef:{current:null},onChange(){assert.fail('cancelled request cannot edit');}});context.after(()=>view.dispose());
 let tree=view.render();button(tree,'AI 助手').props.onClick();view.render();await settle();tree=view.render();button(tree,'生成修改建议').props.onClick();tree=view.render();
 button(tree,'停止生成').props.onClick();assert.equal(signal?.aborted,true);
 resolve(new Response(JSON.stringify({text:'迟到的建议',model:noteModel.label})));await settle();tree=view.render();
 assert.match(text(tree),/生成已停止/);
 assert.equal(all(tree,element=>element.type==='button'&&text(element)==='应用到全文').length,0);
});

test('note assistant honors the owning field length limit and disabled state',async context=>{
 context.mock.method(globalThis,'fetch',async(url:string)=>new Response(JSON.stringify(url==='/api/ai/config'?noteConfig:{text:'超过字段限制的修改建议',model:noteModel.label})));
 const props:Parameters<typeof NoteAssistant>[0]={value:'笔记',maxLength:4,editorRef:{current:null},onChange(){assert.fail('oversized proposal cannot edit');}};
 const view=harness(modules[4],props);context.after(()=>view.dispose());
 let tree=view.render();button(tree,'AI 助手').props.onClick();view.render();await settle();tree=view.render();button(tree,'生成修改建议').props.onClick();view.render();await settle();tree=view.render();
 assert.equal(button(tree,'应用到全文').props.disabled,true);
 button(tree,'应用到全文').props.onClick();
 props.disabled=true;tree=view.render();assert.equal(button(tree,'AI 助手').props.disabled,true);
});
