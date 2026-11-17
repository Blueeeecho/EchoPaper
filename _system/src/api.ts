export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any) { super(message); }
}
export async function api<T = any>(url: string, options: RequestInit & {timeoutMs?:number} = {}): Promise<T> {
  const bounded=/\/chats(?:\/|$)|\/agent-runs(?:\/|$)|\/editor-sessions(?:\/|$)|\/ai\/config(?:\?|$)/.test(url);
  const {timeoutMs=bounded?30000:undefined,signal,...request}=options,controller=new AbortController();
  let expired=false;
  const abort=()=>controller.abort(signal?.reason),timer=timeoutMs===undefined?undefined:setTimeout(()=>{expired=true;controller.abort();},timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{
    const response = await fetch(url, { ...request,signal:controller.signal,headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    let data:any;try{data=await response.json();}catch(error){if(controller.signal.aborted)throw error;data={};}
    if (!response.ok) throw new ApiError(data.error || `请求失败 (${response.status})`, response.status, data);
    return data as T;
  }catch(error){if(expired)throw new ApiError('请求等待超时，尚未确认是否完成；草稿仍保留，请先核对任务记录。',408,{uncertain:true});throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export const json = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) });
export const queryPath = (path: string) => encodeURIComponent(path);
export const prettyDate = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
export function downloadText(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
