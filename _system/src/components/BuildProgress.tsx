import {useEffect,useState} from 'react';
import type {Build} from '../../shared/types';
import {buildElapsed,buildPhase} from '../buildProgress';
/** Tectonic does not expose a trustworthy completion percentage. Keep the ring indeterminate. */
export default function BuildProgress({build}:{build:Build}) {
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[build.id]);
  const phase=buildPhase(build),elapsed=buildElapsed(build,now);
  return <span className="compile-progress" role="progressbar" aria-label={`编译进度：${phase}`} aria-valuetext={`已用 ${elapsed}`} title={`${phase} · 已用 ${elapsed}；详细过程见编译日志`}>
    <svg className="compile-progress-ring" viewBox="0 0 24 24" aria-hidden="true"><circle className="track" cx="12" cy="12" r="9"/><circle className="arc" cx="12" cy="12" r="9"/></svg><span>{phase}</span><time>{elapsed}</time>
  </span>;
}
