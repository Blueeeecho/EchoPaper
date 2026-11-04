import test from 'node:test';import assert from 'node:assert/strict';
import {clampTranslationPlacement,defaultTranslationPlacement,translationGesture,translationKeyboardGesture,dismissSelectionTranslation} from '../src/translationWindow';
import {runTranslationAdapters,type TranslationAdapter,type TranslationCard} from '../src/translationAdapters';
const context={projectId:'translation-window-test',text:'fixture',source:'pdf' as const,target:'zh-CN' as const};
test('translation requires Control and a left-button selection in a writing surface',()=>{
 assert.ok(translationGesture({button:0,ctrlKey:true},true));
 for(const [button,ctrlKey,surface]of[[0,false,true],[2,true,true],[0,true,false]] as const)assert.equal(translationGesture({button,ctrlKey},surface),false);
 assert.equal(translationGesture({button:0,ctrlKey:false,metaKey:true},true),false,'Command is not Control');
 assert.equal(translationGesture({button:0,ctrlKey:true,metaKey:true},true),false,'Mixed shortcuts do not request translation');
 assert.equal(translationGesture({button:0,ctrlKey:true,altKey:true},true),false);
});
test('keyboard translation also requires physical Control, not Command',()=>{
 const event={ctrlKey:true,shiftKey:true,key:'ArrowRight'};
 assert.equal(translationKeyboardGesture(event,true),true);
 for(const patch of [{ctrlKey:false,metaKey:true},{metaKey:true},{shiftKey:false},{key:'a'},{altKey:true}])assert.equal(translationKeyboardGesture({...event,...patch},true),false);
 assert.equal(translationKeyboardGesture(event,false),false);
});
test('only transient unpinned selection popups dismiss on an outside pointer press',()=>{
 const state={open:true,pinned:false,manual:false,inside:false,settings:false};
 assert.equal(dismissSelectionTranslation(state),true);
 for(const patch of [{open:false},{pinned:true},{manual:true},{inside:true},{settings:true}])assert.equal(dismissSelectionTranslation({...state,...patch}),false);
});
test('stored window geometry stays on screen and preserves the pin across resize',()=>{
 const result=clampTranslationPlacement({...defaultTranslationPlacement,x:5000,y:-30,width:900,height:900,pinned:true},{width:640,height:500});
 assert.deepEqual(result,{x:10,y:10,width:620,height:480,pinned:true});
 const tiny=clampTranslationPlacement({...defaultTranslationPlacement,x:NaN,width:NaN},{width:220,height:180});
 assert.ok(tiny.x>=0&&tiny.width+tiny.x<=220&&tiny.height+tiny.y<=180);
});
test('different API queues stream independently and one failed provider does not hide another',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const calls:string[]=[];const cards:TranslationCard[]=[];
 const adapters:TranslationAdapter[]=[{id:'independent-a',queueKey:'a',label:'A',model:'a',translate:async(_c,_s,onText)=>{calls.push('a');onText('partial');await gate;return 'complete';}},{id:'independent-b',queueKey:'b',label:'B',model:'b',translate:async()=>{calls.push('b');throw Error('Provider B unavailable');}}];
 const pending=runTranslationAdapters(adapters,context,new AbortController().signal,card=>cards.push(card));
 await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(calls,['a','b']);release();await pending;
 assert.equal([...cards].reverse().find(x=>x.id==='independent-a')?.text,'complete');assert.equal([...cards].reverse().find(x=>x.id==='independent-b')?.status,'error');
});
test('same-backend adapters are serialized and only complete translations enter cache',async()=>{
 const order:string[]=[];let active=0,max=0;
 const adapter=(id:string):TranslationAdapter=>({id,queueKey:'same-provider',label:id,model:id,translate:async()=>{order.push(id);active++;max=Math.max(max,active);await Promise.resolve();active--;return id+' result';}});
 const adapters=[adapter('serial-a'),adapter('serial-b')],cards:TranslationCard[]=[];
 await runTranslationAdapters(adapters,context,new AbortController().signal,card=>cards.push(card));assert.equal(max,1);assert.deepEqual(order,['serial-a','serial-b']);
 order.length=0;await runTranslationAdapters(adapters,context,new AbortController().signal,()=>{});assert.equal(order.length,0);
 const abort=new AbortController();abort.abort();await runTranslationAdapters(adapters,{...context,text:'cancelled'},abort.signal,()=>{});assert.equal(order.length,0);
});
