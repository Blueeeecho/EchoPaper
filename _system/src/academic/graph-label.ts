// Keep English words together; Chinese labels may wrap between characters.
// The node title, accessible name and selected label retain the full text.
export function graphLabelLines(label:string):string[]{
 const tokens=label.trim().match(/\s+|\p{Script=Han}|[^\s\p{Script=Han}]+/gu)||[];
 const lines:string[]=[];
 let index=0;
 while(index<tokens.length&&lines.length<2){
  const row:string[]=[];
  while(index<tokens.length){
   const token=tokens[index],candidate=(row.join('')+token).trim();
   if(Array.from(candidate).length>20)break;
   row.push(token);index++;
  }
  if(!row.length){lines.push(Array.from(tokens[index].trim()).slice(0,19).join('')+'…');return lines;}
  if(lines.length===1&&index<tokens.length){
   while(row.length&&Array.from(row.join('').trimEnd()).length>19)row.pop();
   lines.push(row.join('').trim()+'…');return lines;
  }
  lines.push(row.join('').trim());
 }
 return lines.filter(Boolean);
}
