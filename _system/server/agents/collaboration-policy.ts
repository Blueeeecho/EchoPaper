/** Only the current direct instruction is considered. Quoted material is data.
 * This conservative recognizer deliberately leaves ambiguous requests single-agent.
 */
export function directInstruction(input:string):string {
 return (input ?? '').replace(/```[\s\S]*?(?:```|$)/g,' ').replace(/`[^`]*`/g,' ')
  .replace(/[“「『‘][\s\S]*?[”」』’]/g,' ').replace(/"[^"\n]*"|'[^'\n]*'/g,' ')
  .replace(/<(?:attachment|history|quoted)[^>]*>[\s\S]*?<\/(?:attachment|history|quoted)>/gi,' ')
  .replace(/^\s*>.*$/gm,' ').replace(/^\s*(?:历史(?:记录|消息)?|附件(?:内容)?|原文|引用|代码|history|attachment)[：:].*$/gmi,' ');
}
export function requiredCollaboration(input:string):string[]{
 let text=directInstruction(input).replace(/不是(?:说)?(?:不要|不需要|无需)(协作|委派|复核|独立复核)/g,'需要$1');
 if(/^(?:请|帮我|麻烦)?(?:翻译|translate|解释|介绍|说明|问一下|请问)/i.test(text.trim())||/(?:是否|要不要|需不需要).{0,16}(?:协作|复核|审阅)/.test(text))return[];
 if(/^(?:what|how|why|explain|translate)\b/i.test(text.trim())||/^(?:能否|能|可以)(?:请你)?(?:解释|说明|介绍)/.test(text.trim()))return[];
 // A question about a word, translated text or quoted instructions is not an order.
 if(/(?:什么意思|是什么含义|是什么意思|如何理解|解释.{0,12}(?:协作|复核)|what does|what is meant)/i.test(text))return[];
 if(/(?:不要|无需|不需要|禁止|别).{0,10}(?:协作|委派|多角色|独立|复核|一起|另一位)|(?:do not|without|no)\s+(?:collaborat\w*|delegat\w*|review)/i.test(text))return[];
 const command=/(?:请|帮我|帮忙|麻烦|需要|安排|让|找|进行|一起|协作修改|协作检查|独立审阅|独立复核|独立审查|please|review|verify|collaborate)/i.test(text);
 if(!command)return[];
 const roles:string[]=[];
 if(/独立(?:审阅|复核|审查)|(?:让|找|安排).{0,10}(?:另一位|其他人|审稿人|专家).{0,10}(?:复核|审阅|审查|检查)|一起(?:检查|复核|审阅)|多角色.{0,8}(?:检查|修改|审阅)|协作(?:复核|修改|检查|审阅)|independent review|collaborat/i.test(text))roles.push('reviewer');
 if(/(?:全文|全稿|整篇|whole paper)/i.test(text)&&/(?:文献|引用|参考文献).{0,10}(?:核查|核验|检查|复核)|(?:核查|核验|检查|复核).{0,10}(?:文献|引用|参考文献)|verify references/i.test(text))roles.push('references');
 return roles;
}
