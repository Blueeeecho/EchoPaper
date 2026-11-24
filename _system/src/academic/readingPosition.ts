// Position storage is optional: malformed values must never break source reading.
export function readingPosition(raw:string|null,hash:string|null|undefined){
 const defaults={page:1,zoom:1,top:0};
 try{
  const p=JSON.parse(raw||'null');
  if(!p||typeof p!=='object'||p.hash!==hash)return defaults;
  return {
   page:Number.isSafeInteger(p.page)&&p.page>0?p.page:1,
   zoom:typeof p.zoom==='number'&&p.zoom>=.5&&p.zoom<=3?p.zoom:1,
   top:typeof p.top==='number'&&Number.isFinite(p.top)&&p.top>=0?p.top:0,
  };
 }catch{return defaults;}
}

// All navigation paths must supply an integer within the loaded PDF bounds.
export function readingPageInput(value:number,total:number){
 const max=Number.isSafeInteger(total)&&total>0?total:1;
 if(!Number.isFinite(value))return 1;
 return Math.max(1,Math.min(max,Math.trunc(value)));
}
