/** Shared with the reader so background processing reuses existing local translations. */
export function textFingerprint(target:string,text:string):string {
 let first=5381,second=52711;
 for(let index=0;index<text.length;index++) {
  const character=text.charCodeAt(index);
  first=(first*33^character)>>>0;
  second=(second*31^character)>>>0;
 }
 return `${target}|${text.length}|${first.toString(36)}${second.toString(36)}`;
}

export function translationCacheKey(source:{id:string;model:string},target:string,text:string):string {
 return `${source.id}|${source.model}|${textFingerprint(target,text)}`;
}

export function translationIndex(translations:Record<string,string>):Map<string,string> {
 const index=new Map<string,string>();
 for(const [key,value] of Object.entries(translations)) {
  const separator=key.indexOf('|',key.indexOf('|')+1);
  if(separator>0&&value.trim())index.set(key.slice(separator+1),value);
 }
 return index;
}

export function translationKeyIndex(translations:Record<string,string>):Map<string,string> {
 const index=new Map<string,string>();
 for(const [key,value] of Object.entries(translations)) {
  const separator=key.indexOf('|',key.indexOf('|')+1);
  if(separator>0&&value.trim())index.set(key.slice(separator+1),key);
 }
 return index;
}

export function cachedTranslationKey(translations:Record<string,string>,target:string,text:string):string|undefined {
 const suffix=`|${textFingerprint(target,text)}`;
 return Object.keys(translations).find(key=>key.endsWith(suffix)&&translations[key].trim());
}
