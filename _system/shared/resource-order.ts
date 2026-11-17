import type {Resource} from './workspace-types';
const names=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});

/** Display and sort papers by their confirmed titles, with legacy filename fallback. */
export function paperTitle(resource:Pick<Resource,'title'|'name'>):string {
 return resource.title?.trim()||resource.name.replace(/\.pdf$/i,'').replace(/^\d+_/,'').replace(/^(?:CV|N\d+)[_-]\d+[_-]*/i,'');
}

/** Apply the same title order before server pagination and in local lists. */
export function compareResourceNames(a:Pick<Resource,'kind'|'name'|'title'|'path'|'rootId'|'id'>,b:Pick<Resource,'kind'|'name'|'title'|'path'|'rootId'|'id'>):number {
 const first=a.kind==='file'&&/\.pdf$/i.test(a.name)?paperTitle(a):a.name;
 const second=b.kind==='file'&&/\.pdf$/i.test(b.name)?paperTitle(b):b.name;
 return Number(a.kind!=='directory')-Number(b.kind!=='directory')||names.compare(first,second)||names.compare(a.path,b.path)||a.rootId.localeCompare(b.rootId)||a.id.localeCompare(b.id);
}

/** Collapse byte-identical PDFs and retain the representative marked as a priority. */
export function uniquePaperResources<T extends Resource>(resources:T[],priority:ReadonlySet<string>=new Set()):T[]{
 const groups=new Map<string,T>();
 const generic=(name:string)=>/^(?:\d+_official|(?:CV|N\d+)-[\d.v-]+|arxiv-[\d.v-]+|\d+)\.pdf$/i.test(name);
 for(const resource of resources){
  const key=resource.kind==='file'&&!resource.missing&&resource.hash&&/\.pdf$/i.test(resource.name)?`pdf:${resource.hash}`:`id:${resource.id}`;
  const previous=groups.get(key);
  const priorityDifference=Number(priority.has(resource.id))-Number(!!previous&&priority.has(previous.id));
  if(!previous||priorityDifference>0||priorityDifference===0&&generic(previous.name)&&!generic(resource.name))groups.set(key,resource);
 }
 return [...groups.values()];
}
