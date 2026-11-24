import {useImperativeHandle,useRef,type ComponentProps,type KeyboardEventHandler} from 'react';
import NoteAssistant,{type NoteTextSelection} from './NoteAssistant';
import MarkdownEditor from './MarkdownEditor';
/** Persistence stays with the owning record, including AI edits and Markdown input. */
export default function ResearchTextEditor({onChange,value,ref,assistantToolbar,...props}:Omit<ComponentProps<'textarea'>,'onChange'|'value'>&{
    value: string;
    onChange: (value: string) => void;
    assistantToolbar?: HTMLElement|null;
}) {
    const editor = useRef<HTMLTextAreaElement>(null);
    const selection=useRef<NoteTextSelection|null>(null);
    const plain=props.rows===1;
    useImperativeHandle(ref,()=>editor.current!,[plain]);
    const label=props['aria-label']||'当前笔记';
    const keyboard:KeyboardEventHandler<HTMLTextAreaElement|HTMLDivElement>|undefined=props.onKeyDown;
    return <div className="research-text-editor" onKeyDown={plain?undefined:keyboard}>
        {plain?<textarea {...props} ref={editor} value={value} onChange={event=>onChange(event.target.value)}/>:<MarkdownEditor value={value} onChange={onChange} selectionRef={selection} label={label} rows={props.rows??12} placeholder={props.placeholder} maxLength={props.maxLength} readOnly={props.disabled||props.readOnly} autoFocus={props.autoFocus}/>}
        <NoteAssistant value={value} onChange={onChange} editorRef={plain?editor:selection} disabled={props.disabled||props.readOnly} maxLength={props.maxLength} label={label} toolbar={assistantToolbar}/>
    </div>;
}
