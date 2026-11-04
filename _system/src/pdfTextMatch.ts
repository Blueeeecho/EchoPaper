import {pdfRunBoundary} from './pdfWordTarget';

interface PdfTextItem {str:string;transform:number[];width:number;height:number}
/** Reconstruct horizontal PDF prose without rendering a canvas or a text layer. */
export function pdfTextForMatching(items:readonly PdfTextItem[]):string {
 let text='',previous:{text:string;left:number;right:number;top:number;bottom:number}|undefined;
 for(const item of items){
  if(!item.str||item.transform.length<6)continue;
  const left=item.transform[4],baseline=-item.transform[5],height=Math.max(1,Math.abs(item.height));
  const run={text:item.str,left,right:left+Math.abs(item.width),top:baseline-height,bottom:baseline};
  if(previous){const boundary=pdfRunBoundary(previous,run);if(boundary.dehyphenate)text=text.slice(0,-1);text+=boundary.separator;}
  text+=item.str;previous=run;
 }
 return text;
}
