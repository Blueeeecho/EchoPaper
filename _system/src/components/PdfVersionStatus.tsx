export default function PdfVersionStatus({hasPdf,stale,status,historical,notice}:{hasPdf:boolean;stale:boolean;status?:string;historical?:boolean;notice?:string}) {
  if(!hasPdf||historical||!stale&&!notice)return null;
  const failed=stale&&status==='failed';
  const label=stale?(failed?'编译失败 · 旧版':'待更新'):'定位说明';
  const description=stale?(failed?'当前源码编译失败，PDF 保留上次成功版本。':'源码已有修改，PDF 仍为上次成功编译版本。'):'';
  return <span className={`pdf-version-status ${failed?'failed':''}`} aria-label={`PDF 状态：${label}`} title={[description,notice].filter(Boolean).join('\n')}>{label}</span>;
}
