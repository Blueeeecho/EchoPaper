import {ArrowUpRight,BookOpen} from 'lucide-react';
import type {ServiceSetup} from '../serviceSetup';

export default function ServiceSetupGuide({guide}:{guide:ServiceSetup}){
 return <div className="service-setup-guide">
  <div className="service-setup-guide-heading"><BookOpen size={15}/><strong>注册与获取凭据</strong>{guide.badge&&<span>{guide.badge}</span>}</div>
  <ol>{guide.steps.map(step=><li key={step}>{step}</li>)}</ol>
  <div className="service-setup-links">
   {guide.account&&<a href={guide.account} target="_blank" rel="noopener noreferrer">注册 / 登录官方平台 <ArrowUpRight size={13}/></a>}
   {guide.docs&&<a href={guide.docs} target="_blank" rel="noopener noreferrer">官方接入指引 <ArrowUpRight size={13}/></a>}
  </div>
 </div>;
}
