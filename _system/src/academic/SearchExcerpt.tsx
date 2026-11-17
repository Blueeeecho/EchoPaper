import type {ResourceSearchMatch} from '../../shared/workspace-types';
import './search-excerpt.css';

const sourceLabels:Record<ResourceSearchMatch['source'],string>={
 metadata:'文件信息',text:'原文',ocr:'OCR 原文',translation:'中文译文',
};

export default function SearchExcerpt({match}:{match:ResourceSearchMatch}) {
 const terms=[...new Set(match.terms.map(term=>term.trim()).filter(Boolean))].sort((first,second)=>second.length-first.length);
 const pattern=terms.length?new RegExp(`(${terms.map(term=>term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})`,'giu'):undefined;
 const parts=pattern?match.snippet.split(pattern):[match.snippet];
 return <span className="resource-search-excerpt">
  <span className="resource-search-source">{sourceLabels[match.source]}{Number.isInteger(match.page)&&(match.page??0)>0?` · 第 ${match.page} 页`:''}</span>
  <span className="resource-search-snippet">{parts.map((part,index)=>index%2?<mark key={index}>{part}</mark>:part)}</span>
 </span>;
}
