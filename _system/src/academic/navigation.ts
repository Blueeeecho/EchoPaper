import type { HubSection } from '../../shared/workspace-types';
import type { WorkspaceView } from '../workspaceSession';

export interface AcademicRoute { section:HubSection; paperId?:string; paperView?:WorkspaceView; presentationId?:string; sourcePaperId?:string; styleId?:string; styleVersion?:string; search?:string; topicId?:string }
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
      return {section:'papers',paperId:parts[1],paperView:paperViews.includes(parts[2])?parts[2] as WorkspaceView:'writing'};
    }
    if(parts[0]==='presentations') {
      const params=new URLSearchParams(query),paper=params.get('paper')||'',style=params.get('style')||'',version=params.get('version')||'';
      if(parts.length>2||parts[1]&&!idPattern.test(parts[1]))return {section:'home'};
      return {section:'presentations',...(parts[1]?{presentationId:parts[1]}:{}),...(idPattern.test(paper)?{sourcePaperId:paper}:{}),...(!parts[1]&&idPattern.test(style)&&idPattern.test(version)?{styleId:style,styleVersion:version}:{})};
    }
    if(parts.length===1&&['home','topics','library'].includes(parts[0])){const params=new URLSearchParams(query);return {section:parts[0] as HubSection,...(params.get('q')?{search:params.get('q')!.slice(0,200)}:{}),...(idPattern.test(params.get('topic')||'')?{topicId:params.get('topic')!}:{})};}
  } catch {/* A malformed URL cannot grant access to a filesystem path. */}
  return {section:'home'};
}
export function academicPath(route:AcademicRoute):string {
 if(route.section==='papers'&&route.paperId)return `/papers/${encodeURIComponent(route.paperId)}/${route.paperView||'writing'}`;
 if(route.section==='presentations'){
  if(route.presentationId)return `/presentations/${encodeURIComponent(route.presentationId)}`;
  const params=new URLSearchParams();if(route.sourcePaperId)params.set('paper',route.sourcePaperId);if(route.styleId&&route.styleVersion){params.set('style',route.styleId);params.set('version',route.styleVersion);}
  return `/presentations${params.size?`?${params}`:''}`;
 }
 return `/${route.section}${route.search?`?q=${encodeURIComponent(route.search)}`:route.topicId?`?topic=${encodeURIComponent(route.topicId)}`:''}`;
}
