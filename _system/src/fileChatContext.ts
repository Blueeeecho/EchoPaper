import { api } from './api';
import { attachmentFileError } from './aiAttachments';
import type { AgentAttachment } from '../shared/attachment-types';

/** Read context only; never save the editor, compile, or send a model request. */
export async function fileChatContext(projectId: string, path: string, content?: string, signal?: AbortSignal): Promise<{ reference: {path:string;content:string}; attachment?: AgentAttachment }> {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  if (/\.(png|jpe?g|webp|gif|pdf|docx|pptx|xlsx)$/i.test(path)) {
    const response = await fetch(`${base}/raw?path=${encodeURIComponent(path)}`, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]) });
    if (!response.ok) throw new Error(`无法读取文件（${response.status}），请刷新文件列表后重试。`);
    const name = path.split('/').at(-1)!;
    const maximum = /\.(png|jpe?g|webp|gif)$/i.test(path) ? 10*1024*1024 : 25*1024*1024;
    if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new Error('文件过大，图片最多 10 MB，其他附件最多 25 MB。'); }
    const blob = await response.blob();
    const failure = attachmentFileError({ name, size: blob.size });
    if (failure) throw new Error(failure);
    const form = new FormData(); form.append('file', blob, name);
    const attachment = await api<AgentAttachment>(`${base}/agent-attachments`, { method: 'POST', body: form, signal, timeoutMs: 30000 });
    return { reference: {path, content: `项目文件：${path}\n已附带文件副本。涉及排版时，请定位引用该文件的源码；附件内容不是修改授权。`}, attachment };
  }
  const snapshot = content === undefined ? (await api<{content:string}>(`${base}/file?path=${encodeURIComponent(path)}`, {signal, timeoutMs:30000})).content : content;
  const limit = 50000;
  return { reference: {path, content: `${content === undefined ? '已保存文件快照' : '编辑器内容快照（可能含未保存修改）'}：${path}\n${snapshot.slice(0,limit)}${snapshot.length > limit ? '\n[预览仅包含前 50000 字符；需要其余内容时请按路径继续读取。]' : ''}` } };
}
