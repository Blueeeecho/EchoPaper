import type {ResearchSourceStatus} from '../../shared/research-entries';
export default function SourceChain({status}:{status?:ResearchSourceStatus}){
 if(!status?.children?.length)return null;
 return <details className="source-chain"><summary>展开上游来源 · {status.children.length}</summary><ul>{status.children.map(({source,status},i)=><li key={i}><strong>{source.label}</strong><small>{source.version?`引用版本 ${source.version} · `:''}SHA256 {source.fingerprint.slice(0,12)}</small><span className={`entry-source-status ${status.state}`}>{status.message}</span><SourceChain status={status}/></li>)}</ul></details>;
}
