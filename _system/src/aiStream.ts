export interface AiReply { text: string; model: string; finishReason?: string; usage?: { prompt_tokens: number; completion_tokens: number } }
export async function streamAiReply(body: unknown, signal: AbortSignal, onText: (text: string) => void): Promise<AiReply> {
  const response = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `AI 请求失败 (${response.status})`); }
  if (!response.body) throw new Error('无法读取流式回复。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', text = '', done = false, result: AiReply = { text: '', model: '' };
  function line(value: string) {
    if (!value.trim()) return;
    const event = JSON.parse(value);
    if (event.type === 'error') throw new Error(event.error || 'AI 生成失败');
    if (event.type === 'delta') { text += event.text; onText(text); }
    if (event.type === 'done') { done = true; result = { text, model: event.model, finishReason: event.finishReason, usage: event.usage }; }
  }
  try {
    while (!done) { const chunk = await reader.read(); buffer += decoder.decode(chunk.value, { stream: !chunk.done }); let n: number; while ((n = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, n)); buffer = buffer.slice(n + 1); if (done) break; } if (chunk.done) { if (buffer.trim() && !done) line(buffer); break; } }
    if (!done) throw new Error('连接提前结束，当前建议不完整，请重试。');
    return result;
  } finally { await reader.cancel().catch(() => {}); }
}
