import {useLayoutEffect} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {EditorSelection,StateEffect,StateField,type EditorState,type Range} from '@codemirror/state';
import {syntaxTree} from '@codemirror/language';
import {Decoration,EditorView,WidgetType,type DecorationSet} from '@codemirror/view';
import AiMarkdown from '../components/AiMarkdown';

export const markdownFocus=StateEffect.define<boolean>();
const roots=new WeakMap<HTMLElement,Root>();
const inlineStyles:Record<string,string>={StrongEmphasis:'markdown-live-strong',Emphasis:'markdown-live-em',Strikethrough:'markdown-live-strike',InlineCode:'markdown-live-code'};

function RenderedBlock({text,view}:{text:string;view:EditorView}){
 useLayoutEffect(()=>{view.requestMeasure();},[text,view]);
 return <AiMarkdown text={text}/>;
}

class MarkdownWidget extends WidgetType{
 constructor(readonly text:string,readonly from:number,readonly block:boolean){super();}
 eq(other:MarkdownWidget){return this.text===other.text&&this.from===other.from&&this.block===other.block;}
 toDOM(view:EditorView){
  const dom=document.createElement(this.block?'div':'span');
  dom.className=`markdown-live-widget research-note-markdown ${this.block?'block':'inline'}`;
  dom.addEventListener('mousedown',event=>{
   if((event.target as Element).closest('a'))return;
   event.preventDefault();
   view.dispatch({selection:EditorSelection.cursor(this.from),scrollIntoView:true});
   view.focus();
  });
  const root=createRoot(dom);roots.set(dom,root);
  root.render(<RenderedBlock text={this.text} view={view}/>);
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
export function markdownDecorations(state:EditorState,focused:boolean):DecorationSet{
 const ranges:Range<Decoration>[]=[];
 const protectedRanges:{from:number;to:number}[]=[];
 const active=(from:number,to:number)=>focused&&state.selection.ranges.some(range=>range.from<=to&&range.to>=from);
 const activeLine=(position:number)=>{const line=state.doc.lineAt(position);return active(line.from,line.to);};
 const protectedAt=(from:number,to:number)=>protectedRanges.some(range=>from<range.to&&to>range.from);
 const hide=(from:number,to:number)=>{if(from<to)ranges.push(Decoration.replace({}).range(from,to));};
 syntaxTree(state).iterate({enter(node){
  const name=node.name;
  if(['Table','FencedCode','CodeBlock','HorizontalRule','SetextHeading1','SetextHeading2'].includes(name)){
   protectedRanges.push({from:node.from,to:node.to});
   if(!active(node.from,node.to))ranges.push(Decoration.replace({widget:new MarkdownWidget(state.sliceDoc(node.from,node.to),node.from,true),block:true}).range(node.from,node.to));
   else if(name==='FencedCode'||name==='CodeBlock'){
    for(let line=state.doc.lineAt(node.from);line.from<=node.to;){
     ranges.push(Decoration.line({class:'markdown-live-code-line'}).range(line.from));
     if(line.number===state.doc.lines)break;line=state.doc.line(line.number+1);
    }
   }
   return false;
  }
  if(name==='Link'){
   protectedRanges.push({from:node.from,to:node.to});
   if(active(state.doc.lineAt(node.from).from,state.doc.lineAt(node.to).to))ranges.push(Decoration.mark({class:'markdown-live-link'}).range(node.from,node.to));
   else ranges.push(Decoration.replace({widget:new MarkdownWidget(state.sliceDoc(node.from,node.to),node.from,false)}).range(node.from,node.to));
   return false;
  }
  if(name==='Image'){
   protectedRanges.push({from:node.from,to:node.to});
   if(!activeLine(node.from))ranges.push(Decoration.replace({widget:new MarkdownWidget(state.sliceDoc(node.from,node.to),node.from,false)}).range(node.from,node.to));
   return false;
  }
  if(/^ATXHeading[1-6]$/.test(name))ranges.push(Decoration.line({class:`markdown-live-heading h${name.slice(-1)}`}).range(state.doc.lineAt(node.from).from));
  if(name==='HeaderMark'&&!activeLine(node.from))hide(node.from,Math.min(state.doc.lineAt(node.from).to,node.to+1));
  if(inlineStyles[name])ranges.push(Decoration.mark({class:inlineStyles[name]}).range(node.from,node.to));
  if(name==='InlineCode')protectedRanges.push({from:node.from,to:node.to});
  if(['EmphasisMark','StrikethroughMark','CodeMark','LinkMark'].includes(name)&&!activeLine(node.from))hide(node.from,node.to);
  if(name==='ListMark'&&!activeLine(node.from)&&/^[-+*]$/.test(state.sliceDoc(node.from,node.to)))ranges.push(Decoration.replace({widget:new BulletWidget('•')}).range(node.from,node.to));
  if(name==='TaskMarker'&&!activeLine(node.from))ranges.push(Decoration.replace({widget:new BulletWidget(state.sliceDoc(node.from,node.to).toLowerCase()==='[x]'?'☑':'☐')}).range(node.from,node.to));
  if(name==='QuoteMark'){
   ranges.push(Decoration.line({class:'markdown-live-quote'}).range(state.doc.lineAt(node.from).from));
   if(!activeLine(node.from))hide(node.from,Math.min(node.to+1,state.doc.lineAt(node.from).to));
  }
 }});
 const text=state.doc.toString();
 // Formula widgets share the existing safe Markdown/KaTeX renderer.
 for(const match of text.matchAll(/^\$\$[^\S\n]*\n[\s\S]*?\n\$\$[^\S\n]*$|^\$\$[^\n]+\$\$[^\S\n]*$/gm)){
  const from=match.index,to=from+match[0].length;
  if(protectedAt(from,to))continue;
  protectedRanges.push({from,to});
  if(!active(from,to))ranges.push(Decoration.replace({widget:new MarkdownWidget(match[0],from,true),block:true}).range(from,to));
 }
 for(const match of text.matchAll(/(?<![\\$])\$(?!\$)([^\n$]+?)(?<!\\)\$(?!\$)/g)){
  const from=match.index,to=from+match[0].length;
  if(!protectedAt(from,to)&&!activeLine(from))ranges.push(Decoration.replace({widget:new MarkdownWidget(match[0],from,false)}).range(from,to));
 }
 return Decoration.set(ranges,true);
}

const focusState=StateField.define({
 create:()=>false,
 update:(value,transaction)=>{for(const effect of transaction.effects)if(effect.is(markdownFocus))value=effect.value;return value;},
});
export const liveMarkdown=StateField.define<DecorationSet>({
 create:state=>markdownDecorations(state,false),
 update:(value,transaction)=>transaction.docChanged||transaction.selection||syntaxTree(transaction.startState)!==syntaxTree(transaction.state)||transaction.effects.some(effect=>effect.is(markdownFocus))?markdownDecorations(transaction.state,transaction.state.field(focusState)):value,
 provide:field=>EditorView.decorations.from(field),
});
export const liveMarkdownExtensions=[focusState,liveMarkdown,EditorView.domEventHandlers({
 focus:(_event,view)=>{view.dispatch({effects:markdownFocus.of(true)});return false;},
 blur:(_event,view)=>{view.dispatch({effects:markdownFocus.of(false)});return false;},
})];
