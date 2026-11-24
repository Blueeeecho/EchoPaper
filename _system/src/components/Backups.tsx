import { useEffect, useRef, useState } from 'react';
import './Backups.css';
import { Archive, Download, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import type { BackupSummary, RestorePreview, RestoreResult } from '../../shared/backup-types';
import { api, json, prettyDate } from '../api';

interface Props { showHeading?:boolean; beforeBackup?: () => Promise<boolean | void>; beforeRestore?: () => Promise<boolean | void>; onBusyChange?: (busy:boolean) => void }
const bytes = (n: number) => n > 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n > 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
export default function Backups({ showHeading=true, beforeBackup, beforeRestore, onBusyChange }: Props) {
  const importFile = useRef<HTMLInputElement>(null);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [label, setLabel] = useState('');
  const [preview, setPreview] = useState<RestorePreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [restored, setRestored] = useState<RestoreResult>();
  const [maintenance, setMaintenance] = useState(false);
  const [loading, setLoading] = useState(true), [listError, setListError] = useState('');
  const loadId = useRef(0);
  useEffect(() => { onBusyChange?.(!!busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  async function refresh() {
    const request=++loadId.current;setLoading(true);setListError('');
    try {
      const result=await api<{ backups: BackupSummary[]; maintenance: boolean }>('/api/backups');
      if(request===loadId.current){setBackups(result.backups);setMaintenance(result.maintenance);}
    } catch(error:any){if(request===loadId.current)setListError(error.message);throw error;}
    finally{if(request===loadId.current)setLoading(false);}
  }
  useEffect(() => { void refresh().catch(()=>{}); return()=>{loadId.current++;}; }, []);
  async function create() {
    setBusy('正在冻结文件、校验并压缩完整备份…'); setError(''); setMessage('');
    try {
      if (beforeBackup && await beforeBackup() === false) return;
      const saved = await api<BackupSummary>('/api/backups', json('POST', { label: label.trim() || '手动完整备份' }));
      setLabel(''); setPreview(undefined); await refresh(); setMessage(`已创建备份 ${saved.id}，${saved.fileCount} 个文件。可下载到外部磁盘保存。`);
    } catch (e: any) { setError(e.message); } finally { setBusy(''); }
  }
  async function importZip(file?: File) {
    if(!file)return;setBusy('正在验证并导入完整备份 ZIP…');setError('');setMessage('');
    try { const body=new FormData();body.append('file',file);const saved=await api<BackupSummary>('/api/backups/import',{method:'POST',body});await refresh();setMessage(`备份已导入并通过 SHA256 校验：${saved.label}。点击“检查并恢复”查看差异。`); }
    catch(e:any){setError(e.message);}finally{setBusy('');if(importFile.current)importFile.current.value='';}
  }
  async function inspect(id: string) {
    setBusy('正在逐个验证备份文件 SHA256，并比较当前工作区…'); setError(''); setMessage('');
    try { if(beforeRestore && await beforeRestore() === false)return; setPreview(await api<RestorePreview>(`/api/backups/${encodeURIComponent(id)}/preview`, json('POST', {}))); setConfirmed(false); }
    catch(e:any) { setError(e.message); } finally {setBusy('');}
  }
  async function restart() {
    setBusy('正在重启后台并重新载入恢复后的工作区…'); setError('');
    try {
      const {pid} = await api<{pid:number}>('/api/workspace/restart',json('POST',{}));
      for(let attempt=0;attempt<90;attempt++) {
        await new Promise(resolve=>setTimeout(resolve,1000));
        try { const result=await api<{pid:number;ok:boolean}>('/api/health',{signal:AbortSignal.timeout(1500)});if(result.ok&&result.pid!==pid){window.location.reload();return;} }catch{}
      }
      throw new Error('后台重启尚未完成。可稍后点击“重试重启”，或从桌面 EchoPaper 启动台重新打开。');
    } catch(e:any){setError(e.message);}finally{setBusy('');}
  }
  async function restore() {
    if(!preview||!confirmed)return;setBusy('正在自动备份当前状态并恢复所选版本…');setError('');setMessage('');
    try {
      if(beforeRestore&&await beforeRestore()===false)return;
      const result=await api<RestoreResult>(`/api/backups/${encodeURIComponent(preview.backup.id)}/restore`,json('POST',{expectedFingerprint:preview.expectedFingerprint,confirmed:true}));
      setRestored(result);setMaintenance(true);setPreview(undefined);setMessage(`已恢复。恢复前安全备份：${result.safetyBackupId}。原目录另保留于 ${result.previousDirectory}。`);await restart();
    }catch(e:any){setError(e.message);}finally{setBusy('');}
  }
  return <section className="backups-view" aria-label="工作区备份与恢复" aria-busy={!!busy}>{showHeading&&<h2 className="backups-heading">备份与恢复</h2>}
    <details className="backups-scope"><summary>备份范围</summary><p>包括正文、Git 历史、批注、已保存的 AI 对话、审稿材料、投稿包、编译记录、共享模板、工作区内的研究材料原件和原始导入档案。密钥、运行日志和系统程序不入包。</p></details><p className="backups-boundary">备份包含已经保存到本机的内容。请先保存网页草稿并等待 AI 回复、编译结束；下载 ZIP 到外部磁盘可防止本机磁盘损坏造成丢失。</p><input type="file" ref={importFile} accept=".zip,application/zip" aria-label="导入完整备份 ZIP" hidden onChange={e=>void importZip(e.target.files?.[0])}/><div className="backups-actions"><input aria-label="备份说明" maxLength={200} placeholder="备份说明，例如：完成方法章节修改" value={label} disabled={!!busy||maintenance} onChange={e=>setLabel(e.target.value)}/><button className="button primary" disabled={!!busy||maintenance} onClick={()=>void create()}><Archive size={14}/>创建完整备份</button><button className="button" disabled={!!busy||maintenance} onClick={()=>importFile.current?.click()}>导入 ZIP</button><button className="button" aria-label="刷新备份列表" disabled={!!busy} onClick={()=>void refresh().catch(e=>setError(e.message))}><RefreshCw size={14}/></button></div>{busy&&<p className="backups-progress" role="status"><LoaderCircle size={15} className="spin"/>{busy}</p>}{error&&<p className="backups-error" role="alert">{error}</p>}{message&&<p className="backups-message" role="status"><ShieldCheck size={15}/>{message}</p>}{maintenance&&!busy&&<div className="backups-maintenance"><p>恢复完成后需重启后台，当前稿件读写已暂时锁定，避免旧页面覆盖恢复结果。</p><button className="button primary" onClick={()=>void restart()}>重试重启</button>{restored&&<small>恢复前安全备份 {restored.safetyBackupId} 可在重启后恢复。</small>}</div>}{preview&&<div className="backups-preview" aria-label="恢复差异预检查"><h3>恢复前确认</h3><p>{preview.warning}</p><dl><div><dt>所选备份</dt><dd>{preview.backup.label} · {prettyDate(preview.backup.createdAt)}</dd></div><div><dt>差异</dt><dd>新增 {preview.counts.added} · 替换 {preview.counts.changed} · 移除 {preview.counts.removed} · 不变 {preview.unchanged}</dd></div></dl>{([{label:'将新增的文件',items:preview.added},{label:'将替换的文件',items:preview.changed},{label:'将从当前目录移出的文件',items:preview.removed}] as const).map(group=>group.items.length>0&&<details key={group.label}><summary>{group.label}（{group.items.length}{preview.truncation?'，最多显示 300 项':''}）</summary><ul>{group.items.map(file=><li key={file}><code>{file}</code></li>)}</ul></details>)}<label className="backups-confirm"><input type="checkbox" aria-label="确认恢复以上差异" checked={confirmed} disabled={!!busy} onChange={e=>setConfirmed(e.target.checked)}/>我已检查以上差异，确认替换当前工作区；恢复前会自动保存完整安全备份。</label><div className="backups-preview-actions"><button className="button" disabled={!!busy} onClick={()=>setPreview(undefined)}>取消</button><button className="button primary" disabled={!confirmed||!!busy} onClick={()=>void restore()}>确认恢复并重启</button></div></div>}<div className="backups-list" aria-busy={loading}>{loading?<p className="backups-list-status" role="status"><LoaderCircle size={15} className="spin"/>正在读取完整备份…</p>:listError?<p className="backups-error" role="alert">备份列表读取失败，{listError}<button className="button small" disabled={!!busy} onClick={()=>void refresh().catch(()=>{})}>重试</button></p>:!backups.length&&!busy?<p>尚无完整备份。</p>:backups.map(item=><article key={item.id}><div><strong>{item.label}</strong><p>{prettyDate(item.createdAt)} · {item.fileCount} 文件 · ZIP {bytes(item.size)}</p><details className="backup-identifier"><summary>备份编号</summary><small>{item.id}</small></details></div><div><a className="button small" href={`/api/backups/${encodeURIComponent(item.id)}/download`} download><Download size={13}/>下载 ZIP</a><button className="button small" disabled={!!busy||maintenance} onClick={()=>void inspect(item.id)}>检查并恢复</button></div></article>)}</div></section>;
}
