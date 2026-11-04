import { memo, useMemo, useCallback, useEffect, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {undoDepth,redoDepth} from '@codemirror/commands';
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { markdown } from '@codemirror/lang-markdown';
import {sourceLocationHighlight}from'../sourceLocation';
import {editorSearch}from'../editorSearch';
import type { Diagnostic } from '../../shared/types';
import { editorDiagnostics, updateEditorDiagnostics } from '../editorDiagnostics';
import '../editor-diagnostics.css';
import{editorPositionKey,normalizeEditorPosition,readSession,writeSession}from'../workspaceSession';
const noDiagnostics: Diagnostic[] = [];
const tex=StreamLanguage.define(stex),md=markdown();
const highlight=syntaxHighlighting(HighlightStyle.define([{tag:tags.comment,color:'#68758b',fontStyle:'italic'},{tag:tags.keyword,color:'#3f639e'},{tag:tags.string,color:'#286d78'},{tag:tags.number,color:'#975250'},{tag:tags.atom,color:'#405d9a'},{tag:tags.heading,color:'#1c2b47',fontWeight:'600'}]));
// Ctrl is reserved for selection translation; it must not add another editor cursor.
const translationMouse=EditorView.clickAddsSelectionRange.of(event=>event.metaKey&&!event.ctrlKey);
const setup={foldGutter:true,highlightActiveLine:false,highlightSelectionMatches:true,lineNumbers:true};
const comment=EditorState.languageData.of(()=>[{commentTokens:{line:'%'}}]);
const theme=EditorView.theme({'&':{fontSize:'12px',height:'100%'},'.cm-scroller':{fontFamily:"'Times New Roman', 'PingFang SC', serif",lineHeight:'1.8',overflow:'auto'},'.cm-content':{padding:'16px 0 60px',userSelect:'text','-webkit-user-select':'text'},'.cm-gutters':{backgroundColor:'#f8fafc',color:'#8994a7',border:'none',paddingRight:'8px'},'.cm-activeLineGutter':{backgroundColor:'#e9eff7'},'.cm-activeLine':{backgroundColor:'#c8ddf52e'},'.cm-selectionBackground':{backgroundColor:'#bdd4f6'},'&.cm-focused .cm-selectionBackground':{backgroundColor:'#a9c9fa'},'&.cm-focused':{outline:'none'}});
export interface EditorHistoryAvailability{canUndo:boolean;canRedo:boolean}
interface Props{workspaceId?:string;restorePosition?:boolean;path:string;value:string;readOnly:boolean;completion:Extension;keyboard:Extension;onChange:(value:string)=>void;onReady:(editor:EditorView)=>void;onHistoryChange?:(availability:EditorHistoryAvailability)=>void;diagnostics?:Diagnostic[];diagnosticsStale?:boolean;diagnosticBuildId?:string}
/** Stable language/theme extensions keep unrelated toolbar/SSE renders out of the editor. */
export default memo(function SourceEditor({workspaceId='',restorePosition=true,path,value,readOnly,completion,keyboard,onChange,onReady,onHistoryChange,diagnostics=noDiagnostics,diagnosticsStale=false,diagnosticBuildId}:Props){
 const positionCleanup=useRef<(()=>void)|undefined>(undefined);
 const positionKey=editorPositionKey(workspaceId,path),restoring=useRef(true),frame=useRef(0);
 const remember=useCallback((editor:EditorView)=>{if(restoring.current||!workspaceId)return;const{anchor,head}=editor.state.selection.main;writeSession(positionKey,{anchor,head,top:editor.scrollDOM.scrollTop,left:editor.scrollDOM.scrollLeft});},[positionKey,workspaceId]);
 const positionListener=useMemo(()=>EditorView.updateListener.of(update=>{if(update.selectionSet||update.docChanged)remember(update.view);}),[remember]);
 const reportHistory=useCallback((editor:EditorView)=>onHistoryChange?.({canUndo:!editor.state.readOnly&&undoDepth(editor.state)>0,canRedo:!editor.state.readOnly&&redoDepth(editor.state)>0}),[onHistoryChange]);
 const historyListener=useMemo(()=>EditorView.updateListener.of(update=>reportHistory(update.view)),[reportHistory]);
 const extensions=useMemo(()=>[keyboard,historyListener,positionListener,translationMouse,editorSearch,sourceLocationHighlight,editorDiagnostics,completion,path.endsWith('.tex')?comment:[],path.endsWith('.md')?md:tex,highlight,EditorView.lineWrapping,theme],[keyboard,historyListener,positionListener,completion,path]);
 const view=useRef<EditorView|null>(null);
 const input=useRef({path,diagnostics,stale:diagnosticsStale,buildId:diagnosticBuildId});
 input.current={path,diagnostics,stale:diagnosticsStale,buildId:diagnosticBuildId};
 const ready=useCallback((editor:EditorView)=>{restoring.current=true;const position=restorePosition?normalizeEditorPosition(readSession(positionKey),editor.state.doc.length):undefined;positionCleanup.current?.();view.current=editor;const persist=()=>remember(editor);editor.scrollDOM.addEventListener('scroll',persist);window.addEventListener('pagehide',persist);positionCleanup.current=()=>{editor.scrollDOM.removeEventListener('scroll',persist);window.removeEventListener('pagehide',persist);};updateEditorDiagnostics(editor,input.current);onReady(editor);reportHistory(editor);
  if(position)editor.dispatch({selection:{anchor:position.anchor,head:position.head}});
  cancelAnimationFrame(frame.current);frame.current=requestAnimationFrame(()=>{if(view.current!==editor||!editor.dom.isConnected)return;if(position){editor.scrollDOM.scrollTop=position.top;editor.scrollDOM.scrollLeft=position.left;}restoring.current=false;});
 },[onReady,reportHistory,positionKey,restorePosition,remember]);
 useEffect(()=>{if(view.current)updateEditorDiagnostics(view.current,input.current);},[path,diagnostics,diagnosticsStale,diagnosticBuildId]);
 useEffect(()=>()=>{positionCleanup.current?.();cancelAnimationFrame(frame.current);view.current=null;onHistoryChange?.({canUndo:false,canRedo:false});},[onHistoryChange]);
 return <CodeMirror className="source-editor" readOnly={readOnly} value={value} height="100%" theme="light" extensions={extensions} onCreateEditor={ready} onChange={onChange} basicSetup={setup} aria-label="论文源码编辑器"/>;
});
