import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { keymap, EditorView } from '@codemirror/view';
import { indentMore, indentLess, toggleLineComment } from '@codemirror/commands';
import { acceptCompletion, closeCompletion, completionStatus, hasNextSnippetField, hasPrevSnippetField, moveCompletionSelection, nextSnippetField, prevSnippetField, startCompletion } from '@codemirror/autocomplete';
import { sourceWordAt, type SyncWordHint } from './syncWords';

export function texWrapChange(state: EditorState, command: 'textbf'|'textit') {
 const prefix=`\\${command}{`;
 return state.changeByRange(range=>({changes:{from:range.from,to:range.to,insert:`${prefix}${state.sliceDoc(range.from,range.to)}}`},range:EditorSelection.range(range.from+prefix.length,range.to+prefix.length)}));
}
export function sourceDoubleClickLine(view: {state:EditorState;composing:boolean;posAtCoords:(coords:{x:number;y:number})=>number|null}, event: Pick<MouseEvent,'clientX'|'clientY'|'button'>) {
 if(view.composing||event.button!==0)return;
 const pos=view.posAtCoords({x:event.clientX,y:event.clientY});
 return pos===null?undefined:view.state.doc.lineAt(pos).number;
}
interface EditorActions { isTex:()=>boolean;save:()=>void;compile:()=>void;aiEdit:()=>void;locatePdf:(line?:number,hint?:SyncWordHint)=>void;help:()=>void }
export function editorCommands(actions: EditorActions) {
 const wrap=(command:'textbf'|'textit')=>(view:EditorView)=>{
  if(!actions.isTex()||view.composing||view.state.readOnly)return false;
  view.dispatch({...texWrapChange(view.state,command),userEvent:'input'});return true;
 };
 const action=(run:()=>void)=>(view:EditorView)=>{if(view.composing)return false;run();return true;};
 return [Prec.highest(keymap.of([
  {key:'Mod-s',run:action(actions.save)},
  {key:'Mod-Enter',run:action(actions.compile)},
  {key:'Mod-b',run:wrap('textbf')},{key:'Mod-i',run:wrap('textit')},
  {key:'Mod-/',run:view=>actions.isTex()&&!view.composing&&!view.state.readOnly?toggleLineComment(view):false},
  {key:'Ctrl-Space',run:view=>!view.composing&&startCompletion(view)},
  {key:'Alt-/',run:view=>!view.composing&&startCompletion(view)},
  {key:'ArrowDown',run:view=>!view.composing&&moveCompletionSelection(true)(view)},
  {key:'ArrowUp',run:view=>!view.composing&&moveCompletionSelection(false)(view)},
  {key:'Escape',run:view=>!view.composing&&closeCompletion(view)},
  {key:'Enter',run:view=>!view.composing&&!view.state.readOnly&&acceptCompletion(view)},
  {key:'Tab',run:view=>{if(view.composing||view.state.readOnly)return false;if(completionStatus(view.state)==='active'&&acceptCompletion(view))return true;if(hasNextSnippetField(view.state)){const moved=nextSnippetField(view);if(moved&&actions.isTex())startCompletion(view);return moved;}return indentMore(view);},shift:view=>{if(view.composing||view.state.readOnly)return false;return hasPrevSnippetField(view.state)?prevSnippetField(view):indentLess(view);}},
  {key:'Mod-Alt-e',run:action(actions.aiEdit)},
  {key:'Mod-Alt-l',run:action(actions.locatePdf)},
  {key:'F1',run:action(actions.help)},
 ])),EditorView.domEventHandlers({dblclick(event,view){
  if(actions.isTex()&&!view.composing&&event.button===0){const pos=view.posAtCoords({x:event.clientX,y:event.clientY});if(pos!==null){const target=sourceWordAt(view.state.doc.toString(),pos);actions.locatePdf(view.state.doc.lineAt(pos).number,target?.hint);}}
  // Keep the editor's native word selection and leave the manuscript unchanged.
  return false;
 }})];
}
