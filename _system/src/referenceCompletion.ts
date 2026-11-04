import type{CompletionContext,CompletionResult}from'@codemirror/autocomplete';
import type{ReferenceIndex}from'../shared/reference-types';
export function referenceCompletion(index:ReferenceIndex){return(context:CompletionContext):CompletionResult|null=>{
 const token=context.matchBefore(/\\(?:[Cc]ite[a-zA-Z*]*|(?:eq|auto|page|name|C|c)?ref)(?:\[[^\]]*\])*\{[^{}]*$/);if(!token)return null;
 const brace=token.text.indexOf('{'),cite=token.text.slice(0,brace).toLowerCase().startsWith('\\cite'),fragment=token.text.slice(brace+1),lastComma=fragment.lastIndexOf(',');
 const leading=fragment.slice(lastComma+1).match(/^\s*/)?.[0].length||0;
 const from=token.from+brace+1+lastComma+1+leading;
 return{from,options:cite?index.entries.map(r=>({label:r.key,type:'text',detail:`${r.year} ${r.author}`.slice(0,90),info:r.title,apply:r.key})):index.labels.map(l=>({label:l.key,type:'variable',detail:`${l.file}:${l.line}`,info:l.context,apply:l.key})),validFor:/^[^{}\s,]*$/};
};}
