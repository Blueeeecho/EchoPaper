import type {AgentAttachment} from '../shared/attachment-types';

export const ATTACHMENT_ACCEPT='.png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.markdown,.tex,.bib,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.r,.sh,.sql,.log,.rst,.docx,.pptx,.xlsx';
export const MAX_MESSAGE_ATTACHMENTS=20;
const imageExtensions=new Set(['png','jpg','jpeg','webp','gif']);
const supported=new Set(ATTACHMENT_ACCEPT.split(',').map(extension=>extension.slice(1)));
export function imageAttachment(file:{name:string;type?:string}):boolean{return imageExtensions.has(file.name.split('.').at(-1)?.toLowerCase()||'');}
export function attachmentFileError(file:{name:string;size:number;type?:string}):string {
 const extension=file.name.split('.').at(-1)?.toLowerCase()||'';
 if(!supported.has(extension))return '暂不支持此格式。可上传图片、PDF、文本、DOCX、PPTX 或 XLSX。';
 const maximum=imageAttachment(file)?10*1024*1024:25*1024*1024;
 if(file.size>maximum)return `文件过大，${imageAttachment(file)?'图片最多 10 MB':'单个文件最多 25 MB'}。`;
 if(file.size===0)return '文件为空，请选择有内容的文件。';
 return '';
}
export function attachmentPrompt(input:string,attachments:Pick<AgentAttachment,'kind'>[]):string {
 const prompt=input.trim();if(prompt||!attachments.length)return prompt;
 return attachments.every(attachment=>attachment.kind==='image')?'请查看并分析所附图片。':'请阅读并分析所附文件。';
}
export function attachmentRawUrl(projectId:string,id:string):string{return `/api/projects/${encodeURIComponent(projectId)}/agent-attachments/${encodeURIComponent(id)}/raw`;}
export function attachmentSize(size:number):string{return size<1024?`${size} B`:size<1024*1024?`${(size/1024).toFixed(size<10240?1:0)} KB`:`${(size/1024/1024).toFixed(1)} MB`;}
export function uniqueAttachments(attachments:AgentAttachment[]):AgentAttachment[]{return [...new Map(attachments.map(attachment=>[attachment.id,attachment])).values()];}
export interface PendingAttachmentUpload {clientId:string;file:File;status:'uploading'|'error';error?:string;previewUrl?:string}
