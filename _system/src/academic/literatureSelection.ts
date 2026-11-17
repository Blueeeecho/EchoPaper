import type {Resource} from '../../shared/workspace-types';
import type {ArticleAnalysis} from '../../shared/literature-analysis';

/** Scope model actions to current, available PDFs, never a stale selection from another topic. */
export function literatureSelection(files:readonly Resource[],articles:readonly ArticleAnalysis[],selected:readonly string[]){
 const available=files.filter(f=>!f.missing&&f.kind==='file'&&/\.pdf$/i.test(f.name));
 const ids=new Set(available.map(f=>f.id));
 const selectedIds=[...new Set(selected)].filter(id=>ids.has(id));
 const pendingIds=selectedIds.filter(id=>{
  const file=available.find(f=>f.id===id)!;
  const article=articles.find(a=>a.resourceId===id);
  return !article||!file.hash||article.sourceHash!==file.hash;
 });
 return{selectedIds,pendingIds};
}
