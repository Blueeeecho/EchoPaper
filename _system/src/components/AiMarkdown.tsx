import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import {memo} from 'react';
const plugins=[remarkGfm,remarkMath];
function AiMarkdown({text}:{text:string}){
 return <Markdown
  remarkPlugins={plugins}
  rehypePlugins={[[rehypeKatex,{throwOnError:false,trust:false,strict:'ignore',maxExpand:1000,maxSize:20}]]}
  skipHtml
  components={{
   p:({node,...props})=><p {...props} className={`markdown-paragraph ${props.className??''}`.trim()}/>,
   li:({node,...props})=><li {...props} className={`markdown-list-item ${props.className??''}`.trim()}/>,
   a:({node,...props})=><a {...props} target="_blank" rel="noopener noreferrer"/>,
   img:({alt})=><span className="ai-image-reference">[图片：{alt||'未加载'}]</span>,
  }}
 >{text}</Markdown>;
}

export default memo(AiMarkdown);
