import {useMemo,type RefObject} from 'react';
import CodeMirror from '@uiw/react-codemirror';
import {EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {markdown,markdownLanguage} from '@codemirror/lang-markdown';
import {liveMarkdownExtensions} from './markdownLivePreview';
import type {NoteTextSelection} from './NoteAssistant';
import './markdown-editor.css';

const language=markdown({base:markdownLanguage,completeHTMLTags:false});
const setup={lineNumbers:false,foldGutter:false,highlightActiveLine:false,highlightActiveLineGutter:false,highlightSelectionMatches:false,autocompletion:false};

export default function MarkdownEditor({value,onChange,selectionRef,label,placeholder,rows=5,maxLength,readOnly=false,autoFocus=false}:{value:string;onChange:(value:string)=>void;selectionRef:RefObject<NoteTextSelection|null>;label:string;placeholder?:string;rows?:number;maxLength?:number;readOnly?:boolean;autoFocus?:boolean}){
 const extensions=useMemo(()=>[
  language,EditorView.lineWrapping,...liveMarkdownExtensions,
  EditorView.contentAttributes.of({'aria-label':label,'aria-multiline':'true'}),
  EditorState.transactionFilter.of(transaction=>maxLength!==undefined&&transaction.docChanged&&transaction.isUserEvent('input')&&transaction.newDoc.length>maxLength&&transaction.newDoc.length>transaction.startState.doc.length?[]:transaction),
 ],[label,maxLength]);
 return <CodeMirror className="markdown-editor" value={value} onChange={onChange} extensions={extensions} basicSetup={setup} theme="light" minHeight={`${Math.max(2,rows)*24}px`} editable={!readOnly} readOnly={readOnly} autoFocus={autoFocus} placeholder={placeholder} onCreateEditor={view=>{
  selectionRef.current={get selectionStart(){return view.state.selection.main.from;},get selectionEnd(){return view.state.selection.main.to;}};
 }}/>;
}
