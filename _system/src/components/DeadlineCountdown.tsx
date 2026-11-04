import { useEffect, useMemo, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import type { Project } from '../../shared/types';
import { countdownText, deadlineCountdown, formatDeadlineLocal, validateDeadlineConfiguration } from '../../shared/deadline';
import '../deadline.css';
export default function DeadlineCountdown({project,onConfigure,expanded}:{project:Project;onConfigure:()=>void;expanded?:boolean}) {
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const update=()=>setNow(Date.now());const timer=setInterval(update,1000);window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);return()=>{clearInterval(timer);window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);};},[]);
  const configuration=useMemo(()=>{try{return project.deadlineAt || project.deadlineTimezone ? {value:validateDeadlineConfiguration(project.deadlineAt,project.deadlineTimezone)} : {};}catch(error){return {error:(error as Error).message};}},[project.deadlineAt,project.deadlineTimezone]);
  const value=configuration.value, parts=value ? deadlineCountdown(value.deadlineAt,now) : undefined;
  const text=parts ? countdownText(parts) : configuration.error ? '截止配置有误，请检查' : project.deadline ? '请补准确时间 / 时区' : '选择会议与正文截止';
  const compactText=parts ? !parts.totalMinutes ? parts.expired ? '已截止' : '正文剩余不足1分' : `${parts.expired ? '已截止' : '正文剩余'} ${parts.days ? `${parts.days}天` : ''}${parts.days || parts.hours ? `${parts.hours}时` : ''}${parts.minutes}分` : text;
  const visibleDeadline=useMemo(()=>value ? `${formatDeadlineLocal(value.deadlineAt,'Asia/Shanghai').slice(5,16).replace('-','/').replace('T',' ')} 北京时间` : project.deadline ? `${project.deadline} · 时间待补` : '',[value,project.deadline]);
  const tooltip=useMemo(()=>value ? `${project.venue || '投稿目标待填写'}\n截止当地时间：${formatDeadlineLocal(value.deadlineAt,value.deadlineTimezone).replace('T',' ')}（${value.deadlineTimezone}）\n北京时间：${formatDeadlineLocal(value.deadlineAt,'Asia/Shanghai').replace('T',' ')}\nUTC：${value.deadlineAt}\n倒计时按同一实际截止时刻计算；点击选择会议与轮次。` : configuration.error || '从 CCFDDL 选择会议、年份与投稿轮次；顶部截止时间统一显示北京时间。',[value,project.venue,configuration.error]);
  return <button type="button" className={`deadline-countdown ${parts?.expired ? 'expired' : parts && parts.totalMinutes <= 1440 ? 'urgent' : ''}`} onClick={onConfigure} aria-haspopup="dialog" aria-expanded={expanded} title={tooltip} aria-label={`投稿计划：${project.venue || '未设置投稿目标'}，${visibleDeadline}，${text}`}><CalendarClock size={13}/><span className="deadline-countdown-content"><span className="deadline-meta"><span className="deadline-venue">{project.venue || '设置投稿目标'}</span>{visibleDeadline && <><span className="deadline-countdown-divider">·</span><span className="deadline-date"><small>正文截止 </small>{visibleDeadline}</span></>}</span><span className="deadline-time" aria-live="off">{compactText}</span></span></button>;
}
