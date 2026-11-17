export interface ReviewSourceLocation {path:string;line?:number}

/** Extract only explicit project-relative source anchors; keep all other prose untouched. */
export function reviewLocations(text:string):ReviewSourceLocation[]{
 const result:ReviewSourceLocation[]=[];
 const pattern=/(?:^|[\s;；,，(（`])([^\s:;；,，()（）`<>]+\.(?:tex|md|bib|csv|json|py))(?::([0-9]{1,7}))?/g;
 for(const match of text.matchAll(pattern)){
  const path=match[1];
  if(path.length>2000||path.startsWith('/')||/[\\\x00-\x1f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'))continue;
  const line=match[2]?Number(match[2]):undefined;
  if(line!==undefined&&(line<1||line>1000000))continue;
  if(!result.some(r=>r.path===path&&r.line===line))result.push({path,...(line?{line}:{})});
  if(result.length>=8)break;
 }
 return result;
}
