import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createReadStream} from 'node:fs';
import type {FastifyInstance} from 'fastify';
import JSZip from 'jszip';
import {DOMParser,type Element,type Document} from '@xmldom/xmldom';
import {AGENT_ATTACHMENT_MAX_BYTES,AGENT_IMAGE_MAX_BYTES,attachmentMetadata,validAgentAttachment,type AgentAttachment} from '../../shared/attachment-types.ts';
import {HttpError,assertNoSymlinks,registeredRoot} from '../security.ts';
import {withLock} from '../storage.ts';
import {workspaceMaintenance} from './maintenance.ts';
const MAX_TEXT=2*1024*1024;
const textExtensions=new Set(['.txt','.md','.markdown','.tex','.bib','.csv','.tsv','.json','.yaml','.yml','.xml','.html','.htm','.css','.js','.jsx','.ts','.tsx','.py','.r','.sh','.sql','.log','.rst']);
const imageTypes:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
const officeTypes:Record<string,string>={'.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
interface StoredAttachment extends AgentAttachment {sha256:string;textSha256?:string}
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function nameOf(value:string){const name=value.split(/[\/\\]/).at(-1)?.normalize('NFC').replace(/[\x00-\x1f]/g,'').trim();if(!name||name.length>255)throw new HttpError(400,'附件文件名无效。');return name;}
function xml(value:string){if(/<!DOCTYPE|<!ENTITY/i.test(value))throw new HttpError(415,'附件包含不支持的 XML 声明。');return new DOMParser().parseFromString(value,'text/xml');}
const textNodes=(element:Element|Document)=>Array.from(element.getElementsByTagNameNS('*','t')).map(item=>item.textContent||'').join('');
async function officeText(bytes:Buffer,extension:string){
 let zip:JSZip;try{zip=await JSZip.loadAsync(bytes);}catch{throw new HttpError(415,'Office 附件不是有效的 DOCX/PPTX/XLSX 文件，或已加密。');}
 const entries=Object.values(zip.files);if(entries.length>5000)throw new HttpError(413,'Office 附件包含过多资源，请拆分后上传。');
 const selected=entries.filter(entry=>!entry.dir&&(extension==='.docx'?/^word\/(?:document|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(entry.name):extension==='.pptx'?/^ppt\/(?:slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(entry.name):/^xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml$/.test(entry.name))).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
 if(selected.reduce((sum,entry)=>sum+Number((entry as unknown as {_data?:{uncompressedSize?:number}})._data?.uncompressedSize||0),0)>8*1024*1024)throw new HttpError(413,'Office 附件展开后过大，请拆分后上传。');
 const contents=new Map<string,string>();let total=0;for(const entry of selected){const value=await entry.async('string');total+=value.length;if(total>8*1024*1024)throw new HttpError(413,'附件文字过多，请拆分后上传。');contents.set(entry.name,value);}
 const shared=contents.get('xl/sharedStrings.xml'),strings=shared?Array.from(xml(shared).getElementsByTagNameNS('*','si')).map(textNodes):[];
 const pieces:string[]=[];for(const [name,value]of contents){if(name==='xl/sharedStrings.xml')continue;const doc=xml(value);if(extension==='.xlsx'){const rows=Array.from(doc.getElementsByTagNameNS('*','row')).map(row=>Array.from(row.getElementsByTagNameNS('*','c')).map(cell=>{const raw=cell.getElementsByTagNameNS('*','v')[0]?.textContent||'',text=cell.getAttribute('t')==='s'?strings[Number(raw)]||'':cell.getAttribute('t')==='inlineStr'?textNodes(cell):raw;return`${cell.getAttribute('r')||''}: ${text}`;}).join('\t'));pieces.push(`[${name}]\n${rows.join('\n')}`);}else{const paragraphs=Array.from(doc.getElementsByTagNameNS('*','p')).map(textNodes).filter(Boolean);pieces.push(`[${name}]\n${paragraphs.join('\n')}`);}}
 return pieces.join('\n\n');
}
async function extract(bytes:Buffer,name:string):Promise<{kind:AgentAttachment['kind'];mimeType:string;text?:string}>{
 const extension=path.extname(name).toLowerCase();if(imageTypes[extension]){if(bytes.length>AGENT_IMAGE_MAX_BYTES)throw new HttpError(413,'图片不能超过 10 MB。');const valid=extension==='.png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):/^\.jpe?g$/.test(extension)?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:extension==='.gif'?/^GIF8[79]a/.test(bytes.subarray(0,6).toString('ascii')):bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP';if(!valid)throw new HttpError(415,'图片内容与扩展名不符，请上传 PNG、JPEG、WEBP 或 GIF 原图。');return{kind:'image',mimeType:imageTypes[extension]};}
 let text='',kind:AgentAttachment['kind']='text',mimeType='text/plain; charset=utf-8';
 if(extension==='.pdf'){kind='pdf';mimeType='application/pdf';if(bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new HttpError(415,'附件不是有效 PDF。');try{const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),fonts=path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),'standard_fonts')+path.sep,loading=getDocument({data:new Uint8Array(bytes),disableFontFace:true,useSystemFonts:false,standardFontDataUrl:fonts});try{const pdf=await loading.promise;if(pdf.numPages>300)throw new HttpError(413,'PDF 超过 300 页，请拆分后上传。');for(let page=1;page<=pdf.numPages;page++){const result=await(await pdf.getPage(page)).getTextContent();text+=`[PDF 第 ${page} 页]\n`+result.items.map(item=>'str'in item?item.str:'').join(' ')+'\n';if(text.length>MAX_TEXT)throw new HttpError(413,'PDF 文字过多，请拆分后上传。');}}finally{await loading.destroy();}}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(415,'无法读取 PDF 文字，可能已加密；请解密后上传或提供页面图片。');}if(!text.replace(/\[PDF 第 \d+ 页\]/g,'').trim())throw new HttpError(415,'此 PDF 没有可提取文字；请上传页面图片供视觉模型读取。');}
 else if(officeTypes[extension]){kind='document';mimeType=officeTypes[extension];text=await officeText(bytes,extension);}
 else if(textExtensions.has(extension)){try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new HttpError(415,'文字附件须使用 UTF-8 编码，请转换后上传。');}if(text.includes('\0'))throw new HttpError(415,'附件包含二进制数据，无法作为文字读取。');}
 else throw new HttpError(415,'暂不支持此附件格式；请使用图片、PDF、UTF-8 文本、DOCX、PPTX 或 XLSX。');
 if(!text.trim())throw new HttpError(415,'附件没有可读取的文字；可改为上传页面图片。');if(text.length>MAX_TEXT)throw new HttpError(413,'附件提取文字超过 2 MB，请拆分后上传。');return{kind,mimeType,text};
}
export async function saveAgentAttachment(root:string,filename:string,bytes:Buffer):Promise<AgentAttachment>{
 if(!bytes.length||bytes.length>AGENT_ATTACHMENT_MAX_BYTES)throw new HttpError(413,'附件不能为空，且单个文件不能超过 25 MB。');const name=nameOf(filename),content=await extract(bytes,name),id=randomUUID(),metadata:StoredAttachment={id,name,mimeType:content.mimeType,size:bytes.length,kind:content.kind,createdAt:new Date().toISOString(),sha256:digest(bytes),...(content.text!==undefined?{textSha256:digest(Buffer.from(content.text))}:{})};
 return withLock(`agent-attachments:${root}`,async()=>{const folder=await assertNoSymlinks(root,'.workbench/attachments',true);await fs.mkdir(folder,{recursive:true,mode:0o700});await assertNoSymlinks(root,'.workbench/attachments');const directory=path.join(folder,id);await fs.mkdir(directory,{mode:0o700});try{await fs.writeFile(path.join(directory,'original'),bytes,{flag:'wx',mode:0o600});if(content.text!==undefined)await fs.writeFile(path.join(directory,'text.txt'),content.text,{flag:'wx',mode:0o600});await fs.writeFile(path.join(directory,'metadata.json'),JSON.stringify(metadata)+'\n',{flag:'wx',mode:0o600});return attachmentMetadata(metadata);}catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}});
}
export async function readAgentAttachment(root:string,id:string):Promise<{metadata:AgentAttachment;filename:string;text?:string}>{
 if(!/^[a-f0-9-]{36}$/.test(id))throw new HttpError(400,'附件编号无效。');let stored:StoredAttachment;try{stored=JSON.parse(await fs.readFile(await assertNoSymlinks(root,`.workbench/attachments/${id}/metadata.json`),'utf8'));}catch(error){if(error instanceof HttpError&&error.statusCode!==404)throw error;throw new HttpError(404,'附件不存在或已离线，请重新上传。');}if(!validAgentAttachment(stored)||stored.id!==id||!/^[a-f0-9]{64}$/.test(stored.sha256))throw new HttpError(409,'附件记录变化，原件已保留，请重新上传。');
 const filename=await assertNoSymlinks(root,`.workbench/attachments/${id}/original`),bytes=await fs.readFile(filename);if(bytes.length!==stored.size||digest(bytes)!==stored.sha256)throw new HttpError(409,'附件原件已被外部修改，请重新上传以保留版本。');let text:string|undefined;if(stored.kind!=='image'){text=await fs.readFile(await assertNoSymlinks(root,`.workbench/attachments/${id}/text.txt`),'utf8');if(text.length>MAX_TEXT||digest(Buffer.from(text))!==stored.textSha256)throw new HttpError(409,'附件提取文字已变化，请重新上传。');}return{metadata:attachmentMetadata(stored),filename,text};
}
export async function registerAgentAttachmentRoutes(app:FastifyInstance,workspaceRoot:string){
 const maintenance=workspaceMaintenance(workspaceRoot);
 app.post<{Params:{id:string}}>('/api/projects/:id/agent-attachments',{bodyLimit:AGENT_ATTACHMENT_MAX_BYTES+1024*1024},async(request,reply)=>{maintenance.assertAvailable();const root=await registeredRoot(workspaceRoot,request.params.id),part=await request.file({limits:{fileSize:AGENT_ATTACHMENT_MAX_BYTES,files:1}});if(!part)throw new HttpError(400,'请选择附件文件。');const bytes=await part.toBuffer();maintenance.assertAvailable();return reply.code(201).send(await saveAgentAttachment(root,part.filename,bytes));});
 app.get<{Params:{id:string;attachmentId:string}}>('/api/projects/:id/agent-attachments/:attachmentId/raw',async(request,reply)=>{const root=await registeredRoot(workspaceRoot,request.params.id),item=await readAgentAttachment(root,request.params.attachmentId);return reply.header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; sandbox").header('Content-Disposition',`${item.metadata.kind==='image'||item.metadata.kind==='pdf'?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(item.metadata.name)}`).type(item.metadata.mimeType).send(createReadStream(item.filename));});
}
