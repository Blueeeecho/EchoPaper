import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import type {ConferenceEdition,ConferenceRound} from '../../shared/conference-types.ts';
import type {ConferenceMilestone,ResolvedConferenceTimeline} from '../../shared/conference-timeline.ts';
import {localDeadlineToUtc} from '../../shared/deadline.ts';
import {createConferenceService} from '../conferences.ts';
import {HttpError} from '../security.ts';

const labels={reviews:'出分',rebuttal_start:'Rebuttal 开始',rebuttal_end:'Rebuttal 结束',decision:'最终决定',camera_ready:'终稿截止'};
const MAX_BYTES=1024*1024;
const monthNames=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const months='January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
function clean(value:string){return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&(?:nbsp|#160);/gi,' ').replace(/&amp;/gi,'&').replace(/&(?:ndash|#8211);/gi,'–').replace(/&(?:mdash|#8212);/gi,'—').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(Number(n),0x10ffff))).replace(/\s+/g,' ').trim();}
function currentContent(value:string){return value.replace(/<(s|del|strike)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<([a-z][a-z0-9]*)\b(?=[^>]*\bstyle=["'][^"']*text-decoration[^"']*line-through)[^>]*>[\s\S]*?<\/\1>/gi,'');}
function isoDate(year:number,month:number,day:number){const d=new Date(Date.UTC(year,month-1,day));return year>=1970&&year<=2200&&d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day?d.toISOString().slice(0,10):undefined;}
function rowDates(text:string):string[]{
 const explicitYears=[...text.matchAll(/\b(20\d{2})\b/g)].map(m=>Number(m[1])),fallback=explicitYears.at(-1),found:{index:number;date:string}[]=[];
 for(const m of text.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)){const date=isoDate(+m[1],+m[2],+m[3]);if(date)found.push({index:m.index!,date});}
 for(const m of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})\\s+(${months})\\.?\\s*,?\\s*(20\\d{2})`,'gi'))){for(const day of [m[1],m[2]]){const date=isoDate(+m[4],monthNames.indexOf(m[3].slice(0,3).toLowerCase())+1,+day);if(date)found.push({index:m.index!,date});}}
 for(const m of text.matchAll(new RegExp(`\\b(${months})\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:\\s*[,/]?\\s*(20\\d{2}))?`,'gi'))){const year=m[3]?+m[3]:fallback,date=year?isoDate(year,monthNames.indexOf(m[1].slice(0,3).toLowerCase())+1,+m[2]):undefined;if(date)found.push({index:m.index!,date});
  const shortRange=new RegExp(`^\\s*[-–—]\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(20\\d{2}))?`).exec(text.slice(m.index!+m[0].length));if(shortRange&&year){const end=isoDate(shortRange[2]?+shortRange[2]:year,monthNames.indexOf(m[1].slice(0,3).toLowerCase())+1,+shortRange[1]);if(end)found.push({index:m.index!+m[0].length,date:end});}}
 for(const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${months})\\.?(?:\\s*,?\\s*(20\\d{2}))?`,'gi'))){const year=m[3]?+m[3]:fallback,date=year?isoDate(year,monthNames.indexOf(m[2].slice(0,3).toLowerCase())+1,+m[1]):undefined;if(date)found.push({index:m.index!,date});}
 return [...new Set(found.sort((a,b)=>a.index-b.index).map(item=>item.date))];
}
function nodes(html:string){
 const rows:{text:string;heading:string}[]=[],headings:string[]=[];
 // Table rows remain whole; other common date lists retain their preceding heading.
 const pattern=/<(h[1-6]|tr|li|p|dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi;
 for(const match of html.matchAll(pattern)){const text=clean(match[2]);if(!text)continue;if(/^h/.test(match[1])){const level=Number(match[1].slice(1));headings.length=level;headings[level-1]=text;continue;}rows.push({text,heading:headings.filter(Boolean).join(' / ')});}
 return rows;
}
function expectedCycle(round:ConferenceRound|undefined){if(!round?.deadlineAt)return '';const rawMonth=/^\d{4}-(\d{2})-/.exec(round.rawDeadline),month=rawMonth?Number(rawMonth[1])-1:new Date(round.deadlineAt).getUTCMonth();return ['january','february','march','april','may','june','july','august','september','october','november','december'][month];}
function preciseAt(date:string,text:string,html:string):string{
 const time=/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);if(!time)return '';
 let hour=+time[1];if(time[4])hour=hour%12+(time[4].toLowerCase()==='pm'?12:0);
 const scope=text+' '+clean(html).slice(-1600),offset=/\bUTC\s*([+-]\d{1,2})(?::(\d{2}))?/i.exec(scope),utcZone=offset?(!offset[2]||offset[2]==='00')&&Math.abs(+offset[1])<=12?+offset[1]===0?'UTC':`Etc/GMT${+offset[1]>0?'-':'+'}${Math.abs(+offset[1])}`:undefined:/\bUTC\b/i.test(scope)?'UTC':undefined;
 const zone=/\b(?:AoE|anywhere on earth)\b/i.test(scope)?'Etc/GMT+12':/\b(?:PT|PST|PDT|Pacific Time)\b/i.test(scope)?'America/Los_Angeles':utcZone;
 if(!zone)return '';try{return localDeadlineToUtc(`${date}T${String(hour).padStart(2,'0')}:${time[2]}:${time[3]||'00'}`,zone);}catch{return '';}
}
export function parseOfficialTimeline(html:string,sourceUrl:string,edition:ConferenceEdition,round?:ConferenceRound):ConferenceMilestone[]{
 html=currentContent(html);
 const result=new Map<string,ConferenceMilestone>(),cycle=expectedCycle(round),multiple=edition.rounds.length>1,ordinal=edition.rounds.findIndex(item=>item.id===round?.id)+1;
 const page=clean(html);if(!new RegExp(`\\b${edition.year}\\b`).test(page)&&!sourceUrl.includes(String(edition.year)))return [];
 for(const row of nodes(html)){
  const heading=row.heading.toLowerCase(),text=row.text,dateList=rowDates(text).filter(date=>+date.slice(0,4)>=edition.year-1&&+date.slice(0,4)<=edition.year);if(!dateList.length)continue;
  if(/workshop|tutorial|demonstration|demo papers?|doctoral|phd|competition|short papers?|posters?|resource submissions|web4all|journal[ -]track/.test(heading)||/industrial|industry/.test(heading)&&!/research/.test(heading))continue;
  const mentionsCycles=/\b(?:january|february|march|april|may|june|july|august|september|october|november|december|first|second|spring|fall|summer|winter)\b.*\b(?:cycle|round|deadline)\b|\b(?:cycle|round)\b/i.test(heading);
  const selectedOrdinal=ordinal>0&&(new RegExp(`\\bround\\s*${ordinal}\\b`).test(heading)||new RegExp(`\\b(?:${['','first|1st','second|2nd','third|3rd'][ordinal]||'UNMATCHED'})\\b`).test(heading));
  if(multiple&&mentionsCycles&&cycle&&!heading.includes(cycle)&&!selectedOrdinal&&!/all (?:cycles|rounds)|both (?:cycles|rounds)/.test(heading))continue;
  // Ambiguous multi-cycle dates must not silently become one selected round.
  if(multiple&&!mentionsCycles&&/\b(?:cycle|round)\b/i.test(text)&&!text.toLowerCase().includes(cycle))continue;
  const add=(id:keyof typeof labels,date:string)=>{const at=preciseAt(date,text,html),value:ConferenceMilestone={id,label:labels[id],at,...(!at?{date}:{}),sourceUrl,note:text.slice(0,900)+(!at?'；按官网日期展示，未补充未确认的时刻或时区。':'')};if(!result.has(id))result.set(id,value);};
  const review=/initial reviews?|preliminary reviews?|reviews? (?:available|release[ds]?|released to authors)|release of reviews|review release|results? release|出分|评审结果/i.test(text),rebuttal=/rebuttal|author[ -]response|author feedback|作者回复/i.test(text);
  if(review)add('reviews',dateList[0]);
  if(rebuttal){if(dateList.length>1){add('rebuttal_start',dateList[0]);add('rebuttal_end',dateList.at(-1)!);}else if(/deadline|end|close|due|截止|结束/i.test(text))add('rebuttal_end',dateList[0]);else if(/start|begin|open|开始/i.test(text))add('rebuttal_start',dateList[0]);}
  if(!review&&!rebuttal&&/final decision|acceptance notification|notification of (?:final )?(?:acceptance|results)|notification to authors|^notification\b|author notification|paper notification|decision notification|最终决定|录用通知/i.test(text)&&!/(?:phase|stage)\s*1\s*(?:rejections?|notification)/i.test(text))add('decision',dateList.at(-1)!);
  if(/camera[ -]ready|final (?:paper|version).*deadline|终稿/i.test(text))add('camera_ready',dateList.at(-1)!);
 }
 return [...result.values()];
}
function publicAddress(address:string){if(isIP(address)===4){const p=address.split('.').map(Number);return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&(p[1]===168||p[1]===0)||p[0]===100&&p[1]>=64&&p[1]<=127||p[0]===198&&(p[1]===18||p[1]===19));}const s=address.toLowerCase();return isIP(address)===6&&!/^::(?:1|ffff:)|^f[cd]|^fe[89ab]/i.test(s)&&s!=='::';}
async function assertPublicUrl(value:string,lookup=async(host:string)=>dnsLookup(host,{all:true})){const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port&&!['80','443'].includes(url.port)||isIP(url.hostname)||url.hostname==='localhost'||!url.hostname.includes('.')||/\.(?:localhost|local|internal)$/i.test(url.hostname))throw Error('会议官网地址不可公开访问。');const addresses=await lookup(url.hostname);if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw Error('会议官网解析到非公开地址。');return url;}
function linkedSources(html:string,source:string){const urls:string[]=[];for(const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){const label=match[1]+' '+clean(match[2]);if(!/important.?dates|key.?dates|research.?track|call.?for.?papers|technical.?track|\/Dates\b|\/CallForPapers\b/i.test(label)||/chairs?|committee|organisation|journal[ -]track|workshops?|tutorials?/i.test(label))continue;try{const url=new URL(match[1].replace(/&amp;/g,'&'),source),origin=new URL(source);if(url.origin===origin.origin){url.hash='';if(!urls.includes(url.href))urls.push(url.href);}}catch{}}return urls;}
export interface TimelineResolverOptions {fetcher?:typeof fetch;lookup?:(hostname:string)=>Promise<{address:string;family:number}[]>;now?:()=>number;conferences?:{query:ReturnType<typeof createConferenceService>['query']}}
export function createTimelineSourceService(workspaceRoot:string,options:TimelineResolverOptions={}){
 const conferences=options.conferences??createConferenceService(workspaceRoot),now=options.now??Date.now,cache=new Map<string,{at:number;value:ResolvedConferenceTimeline}>();
 async function readPage(value:string){let url=await assertPublicUrl(value,options.lookup);for(let redirect=0;redirect<3;redirect++){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);try{const response=await(options.fetcher??fetch)(url.href,{signal:controller.signal,redirect:'manual',headers:{Accept:'text/html'}});if(response.status>=300&&response.status<400){const location=response.headers.get('location');if(!location)throw Error('官网重定向缺少地址。');const next=new URL(location,url);if(next.hostname.replace(/^www\./,'')!==url.hostname.replace(/^www\./,''))throw Error('官网重定向跨域，未继续读取。');url=await assertPublicUrl(next.href,options.lookup);continue;}if(!response.ok||!response.body)throw Error(`官网响应 ${response.status}`);if(Number(response.headers.get('content-length'))>MAX_BYTES)throw Error('官网内容超过读取上限。');const chunks:Uint8Array[]=[];let size=0;const reader=response.body.getReader();try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>MAX_BYTES)throw Error('官网内容超过读取上限。');chunks.push(item.value);}}finally{await reader.cancel().catch(()=>{});}return{url:url.href,html:new TextDecoder().decode(Buffer.concat(chunks))};}finally{clearTimeout(timer);}}throw Error('官网重定向次数过多。');}
 return{async resolve(input:{conferenceId:string;roundId?:string;refresh?:boolean}):Promise<ResolvedConferenceTimeline>{
  const response=await conferences.query(input.conferenceId,false,{rank:'all',sort:'year',limit:200}),edition=response.conferences.find(item=>item.id===input.conferenceId);if(!edition)throw new HttpError(404,'找不到指定会议年份。');
  if(edition.rounds.length>1&&!input.roundId)throw new HttpError(400,'此会议有多个投稿轮次，请明确选择轮次。');
  const round=input.roundId?edition.rounds.find(item=>item.id===input.roundId):edition.rounds[0];if(input.roundId&&!round)throw new HttpError(404,'找不到指定会议轮次。');
  const key=edition.id+':'+(round?.id||''),previous=cache.get(key);if(!input.refresh&&previous&&now()-previous.at<15*60000)return structuredClone(previous.value);
  const milestones=new Map<string,ConferenceMilestone>(),sourceUrls:string[]=[],failures:string[]=[];let urls=edition.officialUrl?[edition.officialUrl]:[];
  if(/^NeurIPS$/i.test(edition.title))urls=[`https://neurips.cc/Conferences/${edition.year}/Dates`,...urls];
  if(/^(?:CVPR|ICCV)$/i.test(edition.title))urls=[`https://${edition.title.toLowerCase()}.thecvf.com/Conferences/${edition.year}/Dates`,...urls];
  const seen=new Set<string>();for(let index=0;index<urls.length&&seen.size<4;index++){const source=urls[index];if(seen.has(source))continue;seen.add(source);try{const page=await readPage(source);sourceUrls.push(page.url);for(const milestone of parseOfficialTimeline(page.html,page.url,edition,round))if(!milestones.has(milestone.id))milestones.set(milestone.id,milestone);if(index===0)urls.push(...linkedSources(page.html,page.url));}catch(error){failures.push(String((error as Error).message));}}
  const list=[...milestones.values()],core=['reviews','rebuttal_start','rebuttal_end','decision'],missing=core.filter(id=>!milestones.has(id)),sourceStatus=list.length?(missing.length?'partial':'ready'):'unavailable';
  const value:ResolvedConferenceTimeline={conferenceId:edition.id,title:edition.title,year:edition.year,roundId:round?.id,roundLabel:round?.label,officialUrl:edition.officialUrl,milestones:list,sourceStatus,sourceUrls,fetchedAt:new Date(now()).toISOString(),...(missing.length?{warning:list.length?'已自动读取官网公布节点；其余节点尚未找到明确公告。':'官网暂未找到可明确对应本年份与轮次的评审节点，将在刷新时重新获取。'}:{})};if(failures.length&&!list.length)value.warning+=' 部分官网页面暂不可访问。';cache.set(key,{at:now(),value});return structuredClone(value);
 }};
}
