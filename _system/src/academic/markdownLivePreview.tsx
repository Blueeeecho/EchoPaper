import {useLayoutEffect} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {EditorSelection,StateEffect,StateField,type EditorState,type Range} from '@codemirror/state';
import {syntaxTree} from '@codemirror/language';
import {Decoration,EditorView,WidgetType,type DecorationSet} from '@codemirror/view';
import katex from 'katex';
import AiMarkdown from '../components/AiMarkdown';

export const markdownFocus=StateEffect.define<boolean>();
const roots=new WeakMap<HTMLElement,Root>();
const inlineStyles:Record<string,string>={StrongEmphasis:'markdown-live-strong',Emphasis:'markdown-live-em',Strikethrough:'markdown-live-strike',InlineCode:'markdown-live-code'};

function RenderedBlock({text,view}:{text:string;view:EditorView}){
 useLayoutEffect(()=>{view.requestMeasure();},[text,view]);
 return <AiMarkdown text={text}/>;
}

function renderFastDom(dom:HTMLElement,text:string,block:boolean):boolean{
 const trim=text.trim();
 if(block&&trim.startsWith('$$')&&trim.endsWith('$$')&&trim.length>=4){
  const body=trim.slice(2,-2).trim();
  try{dom.innerHTML=katex.renderToString(body,{displayMode:true,throwOnError:false,output:'html'});return true;}catch{return false;}
 }
 if(!block&&trim.startsWith('$')&&trim.endsWith('$')&&!trim.startsWith('$$')&&trim.length>=3){
  const body=trim.slice(1,-1).trim();
  try{dom.innerHTML=katex.renderToString(body,{displayMode:false,throwOnError:false,output:'html'});return true;}catch{return false;}
 }
 if(!block){
  const link=trim.match(/^\[([^\][\n*$!`\\]+)\]\(([^)\s]+)\)$/);
  if(link&&/^(?:https?:\/\/|\/|#)/i.test(link[2])){
   const a=document.createElement('a');
   a.href=link[2];a.target='_blank';a.rel='noopener noreferrer';a.textContent=link[1];
   dom.append(a);return true;
  }
 }
 return false;
}

class MarkdownWidget extends WidgetType{
 constructor(readonly text:string,readonly from:number,readonly block:boolean){super();}
 // Ignore `from` so typing above a widget reuses its DOM node instead of remounting React/KaTeX on every keystroke.
 eq(other:MarkdownWidget){return this.text===other.text&&this.block===other.block;}
 toDOM(view:EditorView){
  const dom=document.createElement(this.block?'div':'span');
  dom.className=`markdown-live-widget research-note-markdown ${this.block?'block':'inline'}`;
  dom.addEventListener('mousedown',event=>{
   if((event.target as Element).closest('a'))return;
   event.preventDefault();
   const pos=view.posAtDOM(dom);
   view.dispatch({selection:EditorSelection.cursor(pos),scrollIntoView:true});
   view.focus();
  });
  if(!renderFastDom(dom,this.text,this.block)){
   const root=createRoot(dom);roots.set(dom,root);
   root.render(<RenderedBlock text={this.text} view={view}/>);
  }
  return dom;
 }
 destroy(dom:HTMLElement){const root=roots.get(dom);roots.delete(dom);if(root)queueMicrotask(()=>root.unmount());}
}

class BulletWidget extends WidgetType{
 constructor(readonly label:string){super();}
 eq(other:BulletWidget){return this.label===other.label;}
 toDOM(){const dom=document.createElement('span');dom.className='markdown-live-bullet';dom.textContent=this.label;return dom;}
}

/** Decorations change presentation only. Markdown remains the exact persisted document. */
type SwitchingRange={from:number;to:number;inactive:Range<Decoration>[];active:Range<Decoration>[]};
type MarkdownPlan={baseline:DecorationSet;switches:SwitchingRange[];maxEnd:number[]};
function markdownPlan(state:EditorState):MarkdownPlan{
 const ranges:Range<Decoration>[]=[];
 const switches:SwitchingRange[]=[];
 function change(from:number,to:number,inactive:Range<Decoration>[],active:Range<Decoration>[]=[]){
  switches.push({from,to,inactive,active});ranges.push(...inactive);
 }
 const lineBounds=(from:number,to=from)=>({from:state.doc.lineAt(from).from,to:state.doc.lineAt(to).to});
 const replace=(from:number,to:number,widget?:WidgetType,block=false)=>Decoration.replace({widget,block}).range(from,to);
 const hide=(from:number,to:number,line=false)=>{
  if(from>=to)return;
  const bounds=line?lineBounds(from):{from,to};
  change(bounds.from,bounds.to,[replace(from,to)]);
 };
 const protectedRanges:{from:number;to:number}[]=[];
 const protectedAt=(from:number,to:number)=>protectedRanges.some(range=>from<range.to&&to>range.from);
 syntaxTree(state).iterate({enter(node){
  const name=node.name;
  if(['Table','FencedCode','CodeBlock','HorizontalRule','SetextHeading1','SetextHeading2'].includes(name)){
   protectedRanges.push({from:node.from,to:node.to});
   const active:Range<Decoration>[]=[];
   if(name==='FencedCode'||name==='CodeBlock'){
    for(let line=state.doc.lineAt(node.from);line.from<=node.to;){
     active.push(Decoration.line({class:'markdown-live-code-line'}).range(line.from));
     if(line.number===state.doc.lines)break;line=state.doc.line(line.number+1);
    }
   }
   change(node.from,node.to,[replace(node.from,node.to,new MarkdownWidget(state.sliceDoc(node.from,node.to),node.from,true),true)],active);
   return false;
  }
  if(name==='Link'){
   protectedRanges.push({from:node.from,to:node.to});
   const bounds=lineBounds(node.from,node.to);
   change(bounds.from,bounds.to,[replace(node.from,node.to,new MarkdownWidget(state.sliceDoc(node.from,node.to),node.from,false))],[Decoration.mark({class:'markdown-live-link'}).range(node.from,node.to)]);
   return false;
  }
  if(name==='Image'){
   protectedRanges.push({from:node.from,to:node.to});
   const bounds=lineBounds(node.from);
   change(bounds.from,bounds.to,[replace(node.from,node.to,new MarkdownWidget(state.sliceDoc(node.from,node.to),node.from,false))]);
   return false;
  }
  if(/^ATXHeading[1-6]$/.test(name))ranges.push(Decoration.line({class:`markdown-live-heading h${name.slice(-1)}`}).range(state.doc.lineAt(node.from).from));
  if(name==='HeaderMark'){
   const line=state.doc.lineAt(node.from);
   const opening=node.from===node.node.parent?.from;
   const before=opening?0:line.text.slice(0,node.from-line.from).match(/[ \t]+$/)?.[0].length??0;
   const after=opening?line.text.slice(node.to-line.from).match(/^[ \t]+/)?.[0].length??0:0;
   const from=node.from-before,to=node.to+after;
   hide(from,to);
  }
  if(inlineStyles[name])ranges.push(Decoration.mark({class:inlineStyles[name]}).range(node.from,node.to));
  if(name==='InlineCode')protectedRanges.push({from:node.from,to:node.to});
  if(['EmphasisMark','StrikethroughMark','CodeMark','LinkMark'].includes(name))hide(node.from,node.to,true);
  if(name==='ListMark'&&/^[-+*]$/.test(state.sliceDoc(node.from,node.to))){
   const bounds=lineBounds(node.from);change(bounds.from,bounds.to,[replace(node.from,node.to,new BulletWidget('•'))]);
  }
  if(name==='TaskMarker'){
   const bounds=lineBounds(node.from);change(bounds.from,bounds.to,[replace(node.from,node.to,new BulletWidget(state.sliceDoc(node.from,node.to).toLowerCase()==='[x]'?'☑':'☐'))]);
  }
  if(name==='QuoteMark'){
   ranges.push(Decoration.line({class:'markdown-live-quote'}).range(state.doc.lineAt(node.from).from));
   hide(node.from,Math.min(node.to+1,state.doc.lineAt(node.from).to),true);
  }
 }});
 const text=state.doc.toString();
 if(text.includes('$')){
  // Formula widgets share the existing safe Markdown/KaTeX renderer.
  for(const match of text.matchAll(/^\$\$[^\S\n]*\n[\s\S]*?\n\$\$[^\S\n]*$|^\$\$[^\n]+\$\$[^\S\n]*$/gm)){
   const from=match.index,to=from+match[0].length;
   if(protectedAt(from,to))continue;
   protectedRanges.push({from,to});
   change(from,to,[replace(from,to,new MarkdownWidget(match[0],from,true),true)]);
  }
  for(const match of text.matchAll(/(?<![\\$])\$(?!\$)([^\n$]+?)(?<!\\)\$(?!\$)/g)){
   const from=match.index,to=from+match[0].length;
   if(!protectedAt(from,to)){const bounds=lineBounds(from);change(bounds.from,bounds.to,[replace(from,to,new MarkdownWidget(match[0],from,false))]);}
  }
 }
 switches.sort((a,b)=>a.from-b.from);
 let furthest=-1;
 return {baseline:Decoration.set(ranges,true),switches,maxEnd:switches.map(part=>furthest=Math.max(furthest,part.to))};
}
type MarkdownRender={plan:MarkdownPlan;active:Set<SwitchingRange>;decorations:DecorationSet};
function withSelection(render:MarkdownRender,state:EditorState,focused:boolean):MarkdownRender{
 const {plan}=render;
 const active=new Set<SwitchingRange>();
 if(focused)for(const range of state.selection.ranges){
  let lo=0,hi=plan.maxEnd.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(plan.maxEnd[mid]<range.from)lo=mid+1;else hi=mid;}
  for(let i=lo;i<plan.switches.length&&plan.switches[i].from<=range.to;i++){
   const part=plan.switches[i];if(part.to>=range.from)active.add(part);
  }
 }
 const add:Range<Decoration>[]=[];
 const remove=new Set<Decoration>();
 let from=Infinity,to=-Infinity;
 const swap=(old:Range<Decoration>[],next:Range<Decoration>[])=>{
  for(const item of old){remove.add(item.value);from=Math.min(from,item.from);to=Math.max(to,item.to);}
  for(const item of next)add.push(item);
 };
 for(const part of render.active)if(!active.has(part))swap(part.active,part.inactive);
 for(const part of active)if(!render.active.has(part))swap(part.inactive,part.active);
 if(!add.length&&!remove.size)return render;
 const decorations=render.decorations.update({add,sort:true,...(remove.size?{filter:(_from:number,_to:number,value:Decoration)=>!remove.has(value),filterFrom:from,filterTo:to}:{})});
 return {plan,active,decorations};
}
function markdownRender(state:EditorState,focused:boolean):MarkdownRender{
 const plan=markdownPlan(state);
 return withSelection({plan,active:new Set(),decorations:plan.baseline},state,focused);
}
export function markdownDecorations(state:EditorState,focused:boolean):DecorationSet{
 return markdownRender(state,focused).decorations;
}

const focusState=StateField.define({
 create:()=>false,
 update:(value,transaction)=>{for(const effect of transaction.effects)if(effect.is(markdownFocus))value=effect.value;return value;},
});
const liveMarkdownState=StateField.define<MarkdownRender>({
 create:state=>markdownRender(state,false),
 update:(value,transaction)=>{
  const focused=transaction.state.field(focusState);
  if(transaction.docChanged||syntaxTree(transaction.startState)!==syntaxTree(transaction.state))return markdownRender(transaction.state,focused);
  if(transaction.selection||transaction.effects.some(effect=>effect.is(markdownFocus)))return withSelection(value,transaction.state,focused);
  return value;
 },
});
export const liveMarkdown=StateField.define<DecorationSet>({
 create:state=>state.field(liveMarkdownState).decorations,
 update:(_value,transaction)=>transaction.state.field(liveMarkdownState).decorations,
 provide:field=>EditorView.decorations.from(field),
});
export const liveMarkdownExtensions=[focusState,liveMarkdownState,liveMarkdown,EditorView.domEventHandlers({
 focus:(_event,view)=>{view.dispatch({effects:markdownFocus.of(true)});return false;},
 blur:(_event,view)=>{view.dispatch({effects:markdownFocus.of(false)});return false;},
})];
