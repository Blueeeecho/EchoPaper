import {safeWorkFile,safeWorkId} from '../../shared/research-targets';
import {validResearchDay} from '../../shared/research-calendar';
import type { HubSection } from '../../shared/workspace-types';
import type { WorkspaceView } from '../workspaceSession';

export interface AcademicRoute { section:HubSection; paperId?:string; paperView?:WorkspaceView; presentationId?:string; sourcePaperId?:string; styleId?:string; styleVersion?:string; search?:string; topicId?:string; day?:string; paperFile?:string; reviewId?:string; resourceId?:string; researchEntryId?:string; entryRevision?:number }
const idPattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const paperViews=['writing','reviews','submissions','history','settings','backups'];
export function academicRoute(value:string):AcademicRoute {
  try {
    const raw=value.replace(/^#/,'')||'/';
    const [pathname,query]=raw.split('?');
    const parts=pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if(parts[0]==='papers') {
      if(parts.length===1)return {section:'papers'};
      if(!idPattern.test(parts[1])||parts.length>3)return {section:'home'};
      const params=new URLSearchParams(query),view=paperViews.includes(parts[2])?parts[2] as WorkspaceView:'writing',file=params.get('file'),review=params.get('review');
      return {section:'papers',paperId:parts[1],paperView:view,...(view==='writing'&&safeWorkFile(file)?{paperFile:file}:{}),...(view==='reviews'&&safeWorkId(review)?{reviewId:review}:{})};
    }
    if(parts[0]==='presentations') {
      const params=new URLSearchParams(query),paper=params.get('paper')||'',style=params.get('style')||'',version=params.get('version')||'';
      if(parts.length>2||parts[1]&&!idPattern.test(parts[1]))return {section:'home'};
      return {section:'presentations',...(parts[1]?{presentationId:parts[1]}:{}),...(idPattern.test(paper)?{sourcePaperId:paper}:{}),...(!parts[1]&&idPattern.test(style)&&idPattern.test(version)?{styleId:style,styleVersion:version}:{})};
    }
    if(parts.length===1&&['home','topics','experiments','results','progress','library'].includes(parts[0])){const params=new URLSearchParams(query);return {section:parts[0] as HubSection,...(params.get('q')?{search:params.get('q')!.slice(0,200)}:{}),...(idPattern.test(params.get('topic')||'')?{topicId:params.get('topic')!}:{}),...(parts[0]==='progress'&&validResearchDay(params.get('day'))?{day:params.get('day')!}:{}),...(parts[0]==='library'&&safeWorkId(params.get('resource'))?{resourceId:params.get('resource')!}:{}),...(['experiments','results'].includes(parts[0])&&safeWorkId(params.get('entry'))?{researchEntryId:params.get('entry')!,...(/^[1-9]\d{0,5}$/.test(params.get('revision')||'')?{entryRevision:Number(params.get('revision'))}:{})}:{})};}
  } catch {/* A malformed URL cannot grant access to a filesystem path. */}
  return {section:'home'};
}
export function academicPath(route:AcademicRoute):string {
 if(route.section==='papers'&&route.paperId){const view=route.paperView||'writing',params=new URLSearchParams();if(view==='writing'&&safeWorkFile(route.paperFile))params.set('file',route.paperFile);if(view==='reviews'&&safeWorkId(route.reviewId))params.set('review',route.reviewId);return `/papers/${encodeURIComponent(route.paperId)}/${view}${params.size?'?'+params:''}`;}
 if(route.section==='presentations'){
  if(route.presentationId)return `/presentations/${encodeURIComponent(route.presentationId)}`;
  const params=new URLSearchParams();if(route.sourcePaperId)params.set('paper',route.sourcePaperId);if(route.styleId&&route.styleVersion){params.set('style',route.styleId);params.set('version',route.styleVersion);}
  return `/presentations${params.size?`?${params}`:''}`;
 }
 const params=new URLSearchParams();
 if(route.search)params.set('q',route.search);
 if(route.topicId)params.set('topic',route.topicId);
 if(route.section==='library'&&safeWorkId(route.resourceId))params.set('resource',route.resourceId);
 if(['experiments','results'].includes(route.section)&&safeWorkId(route.researchEntryId)){params.set('entry',route.researchEntryId);if(Number.isSafeInteger(route.entryRevision)&&route.entryRevision!>0&&route.entryRevision!<=999999)params.set('revision',String(route.entryRevision));}
 if(route.section==='progress'&&validResearchDay(route.day))params.set('day',route.day);
 return `/${route.section}${params.size?`?${params}`:''}`;
}
