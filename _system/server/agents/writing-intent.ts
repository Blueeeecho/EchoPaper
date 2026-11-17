// Only complete, standalone social messages use the deterministic reply.
// Additional instructions keep the request on the normal writing path.
export function greetingReply(input: string): string | undefined {
  const prompt = input.split('\n\n[此轮由用户附带的文件快照：')[0].trim();
  const normalized = prompt.replace(/[\s，。！？、,.!?~～]/gu, '').toLowerCase();
  if (['你在吗', '在吗', '在不在', '你在不在', '有人吗'].includes(normalized)) return '在的。有什么需要我帮忙？';
  if (['你好', '您好', '嗨', '哈喽', 'hello', 'hi', 'hey', '早上好', '下午好', '晚上好'].includes(normalized)) return '你好。';
  if (['谢谢', '谢谢你', '多谢', 'thanks', 'thankyou'].includes(normalized)) return '不客气。';
}

export function isIndependentConversation(input: string): boolean {
  return /^(?:请)?(?:给我讲个笑话|讲个笑话|说个笑话|给我一句鼓励|鼓励我一下|陪我聊聊天)[。！？.!?\s]*$/u.test(input.trim());
}
