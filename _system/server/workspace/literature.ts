import {DOMParser} from '@xmldom/xmldom';
import {HttpError} from '../security.ts';
export function arxivId(value:unknown){if(typeof value!=='string'||!/^\d{4}\.\d{4,5}(v\d+)?$/.test(value))throw new HttpError(400,'仅支持有效的现代 arXiv 编号。');return value;}
export async function searchLiterature(query:string,upstream:typeof fetch=fetch){
 const response=await upstream(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent('all:'+query.replace(/["\n]/g,' ').trim())}&max_results=8&sortBy=relevance`,{signal:AbortSignal.timeout(30000),redirect:'error'});
 if(!response.ok)throw new HttpError(502,'arXiv 检索暂时不可用，请稍后重试。');
 const xml=await response.text();if(xml.length>2000000)throw new HttpError(502,'检索结果过大。');
 const doc=new DOMParser().parseFromString(xml,'text/xml');
 return Array.from(doc.getElementsByTagName('entry')).flatMap(entry=>{const text=(tag:string)=>entry.getElementsByTagName(tag)[0]?.textContent?.replace(/\s+/g,' ').trim()||'';const id=text('id').split('/abs/')[1];if(!id||!/^\d{4}\.\d{4,5}(v\d+)?$/.test(id))return[];return[{id,title:text('title'),summary:text('summary'),authors:Array.from(entry.getElementsByTagName('author')).map(a=>a.getElementsByTagName('name')[0]?.textContent||''),published:text('published'),url:`https://arxiv.org/abs/${id}`}];});
}
export async function downloadLiterature(id:string,upstream:typeof fetch=fetch){
 arxivId(id);const response=await upstream(`https://arxiv.org/pdf/${id}`,{signal:AbortSignal.timeout(60000),redirect:'error'});if(!response.ok)throw new HttpError(502,'PDF 下载失败，可打开来源页面后手动下载并拖入。');
 const chunks:Uint8Array[]=[];let size=0;const reader=response.body!.getReader();try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>50*1024*1024)throw new HttpError(413,'PDF 超过 50 MB。');chunks.push(value);}}finally{await reader.cancel();}
 const bytes=Buffer.concat(chunks);if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new HttpError(502,'来源没有返回 PDF 文件。');return bytes;
}
