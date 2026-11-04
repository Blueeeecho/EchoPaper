export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any) { super(message); }
}
export async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || `请求失败 (${response.status})`, response.status, data);
  return data as T;
}
export const json = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) });
export const queryPath = (path: string) => encodeURIComponent(path);
export const prettyDate = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
export function downloadText(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
