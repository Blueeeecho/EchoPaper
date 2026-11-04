import type {Build} from '../shared/types';
export function buildPhase(build:Pick<Build,'status'|'log'|'sourceHash'>):string {
  if(build.status==='queued')return '等待编译';
  let phase=build.sourceHash?'启动引擎':'准备源码';
  for(const line of build.log.slice(-16000).split(/\r?\n/)) {
    if(/download(?:ing)?|fetching|HTTP.*retry/i.test(line))phase='下载依赖';
    else if(/running bibtex|rerunning bibtex/i.test(line))phase='处理文献';
    else if(/xdvipdfmx/i.test(line))phase='生成 PDF';
    else if(/running tex|rerunning tex/i.test(line))phase='排版中';
    else if(/writing.*\.pdf|wrote.*\.pdf/i.test(line))phase='检查产物';
  }
  return phase;
}
export function buildElapsed(build:Pick<Build,'startedAt'|'createdAt'>,now:number):string {
  const start=Date.parse(build.startedAt||build.createdAt),seconds=Number.isFinite(start)?Math.max(0,Math.floor((now-start)/1000)):0;
  return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
}
