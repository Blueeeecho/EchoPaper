import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PresentationDocument, PresentationSource } from '../../shared/presentation-types';
import type { Resource } from '../../shared/workspace-types';
import { HttpError, assertNoSymlinks, registeredRoot } from '../security';
import { document as readPaperDocument } from '../files';
import { getProject } from '../projects';
import { hash } from '../storage';

export type ResourceFile=(id:string)=>Promise<{filename:string;resource:Resource;hash:string}>;
const textExtensions=new Set(['.txt','.md','.tex','.bib','.json','.csv','.tsv','.yaml','.yml']);
export const assetMime=(name:string)=>({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf'}[path.extname(name).toLowerCase()]??'application/octet-stream');
async function decodePdf(buffer:Buffer){const{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');const task=getDocument({data:new Uint8Array(buffer),useSystemFonts:true,stopAtErrors:true});try{const pdf=await task.promise;if(pdf.numPages>1500)throw new HttpError(413,'PDF 超过 1500 页，请选择相关章节。');const pages:string[]=[];let total=0;for(let page=1;page<=pdf.numPages;page++){const p=await pdf.getPage(page),content=await p.getTextContent(),text=content.items.map((item:any)=>item.str??'').join(' ');total+=text.length;if(total>2_000_000)throw new HttpError(413,'PDF 可提取正文超过 200 万字符，请选择相关章节。');pages.push(`[Page ${page}]\n${text}`);p.cleanup();}if(!pages.some(p=>p.replace(/^\[Page \d+\]\n/,'').trim()))throw new HttpError(400,'该 PDF 未提取到文字；请补充文字材料或清晰图片。');return pages.join('\n\n');}finally{await task.destroy();}}
export async function snapshotBuffer(directory:string,name:string,buffer:Buffer,kind?:PresentationSource['kind']):Promise<PresentationSource>{if(buffer.length>50*1024*1024)throw new HttpError(413,'单个材料不能超过 50 MB。');name=path.basename(name).slice(0,500);const extension=path.extname(name).toLowerCase(),source:PresentationSource={id:'src-'+randomUUID(),name,kind:kind??'text',text:'',hash:hash(buffer)};
 if(['.png','.jpg','.jpeg','.webp'].includes(extension)){try{const {loadImage}=await import('@napi-rs/canvas');const image=await loadImage(buffer);if(!image.width||!image.height||image.width*image.height>100_000_000)throw Error('size');}catch{throw new HttpError(400,'图片无法解码，或像素数过大。');}source.kind=kind??'image';}
 else if(extension==='.pdf'){if(!buffer.subarray(0,5).equals(Buffer.from('%PDF-')))throw new HttpError(400,'上传内容不是有效 PDF。');source.kind=kind??'pdf';source.text=await decodePdf(buffer);}
 else {if(!textExtensions.has(extension))throw new HttpError(400,'支持 PDF、TXT/Markdown/TeX/Bib/CSV/JSON 与 PNG/JPEG/WebP 图片。');try{source.text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{throw new HttpError(400,'文字材料需要 UTF-8 编码。');}if(!source.text.trim())throw new HttpError(400,'文字材料为空。');if(source.text.length>2_000_000)throw new HttpError(413,'文字材料超过 200 万字符。');source.hash=hash(source.text);return source;}
 source.assetId='asset-'+randomUUID()+extension;await fs.mkdir(await assertNoSymlinks(directory,'assets',true),{recursive:true});await fs.writeFile(await assertNoSymlinks(directory,'assets/'+source.assetId,true),buffer,{flag:'wx'});return source;
}
// Resolve only explicit TeX includes; never scan unrelated manuscript files.
export async function paperSourceText(root:string,main:string):Promise<string>{
 const files=new Map<string,{content:string;hash:string}>(),active=new Set<string>();let total=0;
 async function visit(file:string):Promise<string>{
  if(active.has(file))throw new HttpError(400,'论文包含循环引用，请先整理主稿引用。');
  if(files.size>=200&&!files.has(file))throw new HttpError(413,'论文引用文件超过 200 个。');
  const doc=await readPaperDocument(root,file);files.set(file,doc);total+=doc.content.length;
  if(total>2_000_000)throw new HttpError(413,'论文材料超过 200 万字符。');active.add(file);
  // Ignore commented-out commands, including comments after ordinary prose.
  const text=doc.content.replace(/(?<!\\)%[^\n]*/g,'');
  const refs=[...text.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)];let out='',last=0;
  for(const ref of refs){const name=ref[1].trim();if(!name||/[\\#$]/.test(name))throw new HttpError(400,'论文存在动态引用，请改用完整 PDF 材料。');
   const base=path.posix.dirname(main);let target=path.posix.normalize(path.posix.join(base,name));if(!path.posix.extname(target))target+='.tex';
   out+=text.slice(last,ref.index)+`\n[Source file: ${target}]\n`+await visit(target)+`\n[End source file: ${target}]\n`;last=ref.index!+ref[0].length;
  }active.delete(file);return out+text.slice(last);
 }
 const text=await visit(main);
 for(const[file,doc]of files)if((await readPaperDocument(root,file)).hash!==doc.hash)throw new HttpError(409,'论文在读取期间变化，请刷新后重新选择。');
 return text;
}
export async function sourceFromInput(workspaceRoot:string,directory:string,input:{text?:unknown;name?:unknown;paperId?:unknown;resourceId?:unknown},resourceFile?:ResourceFile):Promise<PresentationSource>{const name=typeof input.name==='string'?input.name.trim().slice(0,500):'';if(input.resourceId!==undefined){if(typeof input.resourceId!=='string'||!resourceFile)throw new HttpError(400,'当前未连接资源目录。');const result=await resourceFile(input.resourceId),stat=await fs.lstat(result.filename);if(!stat.isFile()||stat.isSymbolicLink())throw new HttpError(403,'请选择资源目录中的普通文件。');if(stat.size>50*1024*1024)throw new HttpError(413,'单个材料不能超过 50 MB。');const bytes=await fs.readFile(result.filename);if(hash(bytes)!==result.hash)throw new HttpError(409,'资源在读取期间已变化，请刷新后重新选择。');const source=await snapshotBuffer(directory,name||result.resource.name,bytes,'resource');source.resourceId=result.resource.id;source.path=result.resource.path;return source;}
 if(input.paperId!==undefined){if(typeof input.paperId!=='string')throw new HttpError(400,'论文编号无效。');const paper=await getProject(workspaceRoot,input.paperId),target=paper.targets[0];if(!target)throw new HttpError(400,'论文未配置主稿入口。');const text=await paperSourceText(await registeredRoot(workspaceRoot,input.paperId),target.main);return{id:'src-'+randomUUID(),name:name||paper.title,kind:'paper',text,hash:hash(text),paperId:paper.id,path:target.main};}
 if(typeof input.text!=='string'||!input.text.trim())throw new HttpError(400,'请添加文字，或明确选择论文、资源文件。');if(input.text.length>2_000_000)throw new HttpError(413,'文字材料超过 200 万字符。');return{id:'src-'+randomUUID(),name:name||'文字材料',kind:'text',text:input.text,hash:hash(input.text)};
}
export async function selectedAssets(directory:string,document:PresentationDocument):Promise<Record<string,string>>{const assets:Record<string,string>={};for(const source of document.sources.filter(s=>s.assetId)){const {filename}=await verifiedSourceAsset(directory,source);if(assetMime(filename).startsWith('image/'))assets[source.assetId!]=filename;}return assets;}


async function verifiedSourceAsset(directory:string,source:PresentationSource){
 const filename=await assertNoSymlinks(directory,'assets/'+source.assetId!);
 const bytes=await fs.readFile(filename);
 if(hash(bytes)!==source.hash)throw new HttpError(409,'已冻结材料资产被外部修改，请恢复后重试。');
 return {filename,bytes};
}

/** Only the images used by the measured slide, served from the exact bytes verified in this read. */
export async function inlinePreviewImages(directory:string,document:PresentationDocument,assetIds:Iterable<string>){
 const assets:Record<string,string>=Object.create(null);
 const selected=new Set(assetIds);
 for(const source of document.sources){
  const id=source.assetId;
  if(!id||!selected.has(id))continue;
  const mime=assetMime(id);
  if(!mime.startsWith('image/'))continue;
  const {bytes}=await verifiedSourceAsset(directory,source);
  assets[id]=`data:${mime};base64,${bytes.toString('base64')}`;
 }
 return assets;
}
