export interface SyncWordHint { word:string; before:string; after:string }
export interface SourceWordTarget { line:number; from:number; to:number; hint?:SyncWordHint }
interface VisibleText { text:string; offsets:number[] }
const segmenter=new Intl.Segmenter('zh-CN',{granularity:'word'});
const cjk=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Plain-text words with original UTF-16 offsets, suitable for PDF text ranges. */
export function syncWordRanges(text:string):{from:number;to:number}[] {
 const ranges:{from:number;to:number}[]=[];
 for(const match of text.matchAll(/[\p{L}\p{N}\p{M}]+(?:['’\-‐‑][\p{L}\p{N}\p{M}]+)*/gu)) {
  if(!cjk.test(match[0]))ranges.push({from:match.index!,to:match.index!+match[0].length});
  else for(const word of segmenter.segment(match[0]))if(word.isWordLike)ranges.push({from:match.index!+word.index,to:match.index!+word.index+word.segment.length});
 }
 return ranges;
}

/** Project prose is compared to displayed text, without command names or citation keys. */
function visibleSource(source:string):VisibleText {
 const tex=/\\[a-zA-Z@]+|\\[%&#_$]/.test(source),offsets:number[]=[];let text='';
 const append=(value:string,index:number)=>{text+=value;for(let n=0;n<value.length;n++)offsets.push(index+n);};
 for(let i=0;i<source.length;) {
  const char=source[i];
  if(tex&&char==='%'){while(i<source.length&&source[i]!=='\n')i++;continue;}
  if(tex&&char==='\\') {
   const command=/^\\([a-zA-Z@]+)\*?/.exec(source.slice(i));
   if(command) {
    i+=command[0].length;
    if(/^(?:cite\w*|(?:eq|auto|page|name|cref|Cref)?ref|label|input|include|bibliography|bibliographystyle|addbibresource|includegraphics|url|begin|end)$/.test(command[1])) {
     for(let groups=0;groups<3;groups++) {
      let start=i;while(/[ \t]/.test(source[start]||'')&&start<source.length)start++;
      const opening=source[start];if(opening!=='{'&&opening!=='[')break;
      const closing=opening==='{'?'}':']';let depth=1;i=start+1;
      while(i<source.length&&depth){if(source[i]==='\\'){i+=2;continue;}if(source[i]===opening)depth++;if(source[i]===closing)depth--;i++;}
     }
     append(' ',Math.max(0,i-1));
    } else if(!/^(?:textbf|textit|textrm|textsf|texttt|emph|mathrm|mathbf|mathit|operatorname|mbox|hbox)$/.test(command[1]))append(' ',Math.max(0,i-1));
    continue;
   }
   if(i+1<source.length){const next=source[i+1];if(next==='-'){i+=2;continue;}append(next==='\\'?' ':next,i+1);i+=2;continue;}
  }
  if(tex&&(char==='{'||char==='}')){i++;continue;}
  append(tex&&char==='~'?' ':char,i);i++;
 }
 return{text,offsets};
}

export function normalizeSyncText(text:string):string {
 return visibleSource(text).text.normalize('NFKC').toLowerCase().replace(/[\u00ad]/g,'').replace(/[’‘]/g,"'")
  .replace(/([\p{L}\p{N}])[-‐‑]\s*(?=[\p{L}\p{N}])/gu,'$1')
  .replace(/[^\p{L}\p{N}\p{M}']+/gu,' ').trim().replace(/\s+/g,' ');
}
function contextWords(value:string):string[]{const normalized=normalizeSyncText(value);return syncWordRanges(normalized).map(r=>normalized.slice(r.from,r.to));}
/** Matching word starts at 0; each immediately matching context word adds 2. */
export function scoreWordContext(candidate:SyncWordHint,wanted:SyncWordHint):number {
 const word=normalizeSyncText(candidate.word);if(!word||word!==normalizeSyncText(wanted.word))return -Infinity;
 const left=contextWords(candidate.before).slice(-8).reverse(),wantedLeft=contextWords(wanted.before).slice(-8).reverse();
 const right=contextWords(candidate.after).slice(0,8),wantedRight=contextWords(wanted.after).slice(0,8);
 let score=0;for(let i=0;i<Math.min(left.length,wantedLeft.length)&&left[i]===wantedLeft[i];i++)score+=2;
 for(let i=0;i<Math.min(right.length,wantedRight.length)&&right[i]===wantedRight[i];i++)score+=2;
 return score;
}
function targets(source:string):SourceWordTarget[]{
 const visible=visibleSource(source);let line=1,cursor=0;
 return syncWordRanges(visible.text).map(r=>{
  const from=visible.offsets[r.from],to=visible.offsets[r.to-1]+1;
  for(;cursor<from;cursor++)if(source[cursor]==='\n')line++;
  return{line,from,to,hint:{word:visible.text.slice(r.from,r.to),before:visible.text.slice(Math.max(0,r.from-120),r.from),after:visible.text.slice(r.to,r.to+120)}};
 });
}
/** All literal matches, retaining ambiguity for the caller to resolve globally. */
export function contextWordCandidates(text:string,hint:SyncWordHint):(SourceWordTarget&{hint:SyncWordHint;score:number})[]{
 const wanted=normalizeSyncText(hint.word);if(!wanted)return[];
 return targets(text).flatMap(target=>target.hint&&normalizeSyncText(target.hint.word)===wanted?[{...target,hint:target.hint,score:scoreWordContext(target.hint,hint)}]:[]);
}
export function sourceWordAt(text:string,position:number):SourceWordTarget|undefined {
 if(!Number.isFinite(position)||position<0||position>text.length)return;
 const words=targets(text),hit=words.find(r=>r.from<=position&&position<r.to);
 if(hit)return hit;
 const nearby=words.map(word=>({word,distance:Math.min(Math.abs(word.from-position),Math.abs(word.to-position))})).filter(r=>r.distance<=2&&!/[\n\r\\{}%]/.test(text.slice(Math.min(r.word.to,position),Math.max(r.word.from,position)))).sort((a,b)=>a.distance-b.distance)[0];
 return nearby?.word;
}
/** Restrict lexical disambiguation to the SyncTeX source neighbourhood, never the whole manuscript. */
export function findSourceWord(text:string,line:number,hint?:SyncWordHint,column?:number):{from:number;to:number}|undefined {
 if(!Number.isFinite(line)||line<1)return;
 if(!hint?.word){
  if(!column||column<1)return;const starts=[0];for(let i=0;i<text.length;i++)if(text[i]==='\n')starts.push(i+1);
  const start=starts[line-1];if(start===undefined)return;const word=sourceWordAt(text,start+column-1);
  return word?.line===line?{from:word.from,to:word.to}:undefined;
 }
 const wanted=normalizeSyncText(hint.word);
 const candidates=targets(text).filter(word=>Math.abs(word.line-line)<=2&&normalizeSyncText(word.hint!.word)===wanted);
 const ranked=candidates.map(word=>({word,context:scoreWordContext(word.hint!,hint),distance:Math.abs(word.line-line)})).sort((a,b)=>b.context-a.context||a.distance-b.distance);
 const best=ranked[0];if(!best)return;
 const second=ranked[1];
 if(second&&best.context===second.context){
  const exact=ranked.filter(r=>r.context===best.context&&r.word.line===line);
  if(exact.length===1)return{from:exact[0].word.from,to:exact[0].word.to};
  if(column&&column>0&&exact.length){const start=text.lastIndexOf('\n',exact[0].word.from-1)+1;const position=start+column-1;const near=exact.filter(r=>position>=r.word.from-2&&position<=r.word.to+2);if(near.length===1)return{from:near[0].word.from,to:near[0].word.to};}
  return;
 }
 if(best.distance>0&&best.context<2)return;
 return{from:best.word.from,to:best.word.to};
}
