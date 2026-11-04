import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
export const sourceLocationEffect = StateEffect.define<{from:number;to:number} | null>();
export const sourceLocationHighlight = StateField.define<DecorationSet>({
 create:()=>Decoration.none,
 update(value, transaction){value=value.map(transaction.changes);for(const effect of transaction.effects)if(effect.is(sourceLocationEffect)){const from=Math.max(0,Math.min(effect.value?.from??0,transaction.newDoc.length)),to=Math.max(from,Math.min(effect.value?.to??0,transaction.newDoc.length));value=to>from?Decoration.set([Decoration.mark({class:'editor-source-match editor-source-word-match'}).range(from,to)]):Decoration.none;}return value;},
 provide:field=>EditorView.decorations.from(field),
});
