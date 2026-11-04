import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import type { FileEntry } from '../shared/types';
const environments = ['document','abstract','figure','figure*','table','table*','tabular','equation','equation*','align','align*','aligned','gather','itemize','enumerate','description','proof','theorem','lemma','verbatim','quote','center'];
const commands: Completion[] = [
  ['section','\\section{${1:标题}}${0}','章节'], ['subsection','\\subsection{${1:标题}}${0}','小节'], ['subsubsection','\\subsubsection{${1:标题}}${0}','三级标题'],
  ['paragraph','\\paragraph{${1:标题}} ${0}','段落标题'], ['textbf','\\textbf{${1:文字}}${0}','加粗'], ['textit','\\textit{${1:文字}}${0}','斜体'], ['emph','\\emph{${1:文字}}${0}','强调'],
  ['input','\\input{${1}}${0}','插入 .tex'], ['include','\\include{${1}}${0}','插入章节 .tex'], ['includegraphics','\\includegraphics[width=0.9\\textwidth]{${1}}${0}','插入图片'],
  ['bibliography','\\bibliography{${1}}${0}','BibTeX 文献库'], ['addbibresource','\\addbibresource{${1}}${0}','biblatex 文献库'],
  ['cite','\\cite{${1}}${0}','引用文献'], ['citep','\\citep{${1}}${0}','括号引用（需 natbib）'], ['citet','\\citet{${1}}${0}','作者引用（需 natbib）'], ['ref','\\ref{${1}}${0}','交叉引用'], ['eqref','\\eqref{${1}}${0}','公式引用（需 amsmath）'], ['label','\\label{${1:标签}}${0}','设置标签'],
  ['caption','\\caption{${1:图表说明}}${0}','图表标题'], ['footnote','\\footnote{${1:注释}}${0}','脚注'], ['item','\\item ${0}','列表条目'], ['url','\\url{${1:地址}}${0}','网址'], ['href','\\href{${1:地址}}{${2:文字}}${0}','超链接'],
  ['frac','\\frac{${1:分子}}{${2:分母}}${0}','分式'], ['sqrt','\\sqrt{${1:表达式}}${0}','平方根'], ['sum','\\sum_{${1:i=1}}^{${2:n}} ${0}','求和'], ['prod','\\prod_{${1:i=1}}^{${2:n}} ${0}','连乘'], ['int','\\int_{${1:a}}^{${2:b}} ${0}','积分'], ['mathbf','\\mathbf{${1:x}}${0}','数学粗体'], ['mathbb','\\mathbb{${1:R}}${0}','黑板体（需 amssymb）'], ['mathrm','\\mathrm{${1:text}}${0}','数学正体'], ['operatorname','\\operatorname{${1:name}}${0}','运算符（需 amsmath）'],
].map(([name,template,detail])=>snippetCompletion(template,{label:`\\${name}`,type:'function',detail}));
for (const name of ['alpha','beta','gamma','delta','epsilon','theta','lambda','mu','pi','sigma','tau','phi','omega','Gamma','Delta','Theta','Lambda','Sigma','Phi','Omega','times','cdot','leq','geq','neq','infty','in','subseteq','rightarrow','Rightarrow','partial','nabla','textwidth','linewidth','centering','toprule','midrule','bottomrule','hline','newpage','clearpage','appendix']) commands.push({label:`\\${name}`,apply:`\\${name}`,type:'keyword',detail:'LaTeX 命令（部分需相应宏包）'});
for (const env of ['figure','figure*','table','table*','equation','equation*','align','align*','itemize','enumerate','abstract']) {
  const template = env.startsWith('figure') ? `\\begin{${env}}[${'${1:htbp}'}]\n\t\\centering\n\t\\includegraphics[width=${'${2:0.9}'}\\textwidth]{${'${3}'}}\n\t\\caption{${'${4:图注}'}}\n\t\\label{${'${5:fig:label}'}}\n\\end{${env}}\n${'${0}'}`
    : env.startsWith('table') ? `\\begin{${env}}[${'${1:htbp}'}]\n\t\\centering\n\t\\caption{${'${2:表注}'}}\n\t\\label{${'${3:tab:label}'}}\n\t\\begin{tabular}{${'${4:lcc}'}}\n\t\t${'${5:内容}'}\n\t\\end{tabular}\n\\end{${env}}\n${'${0}'}`
    : `\\begin{${env}}\n\t${env==='itemize'||env==='enumerate'?'\\item ':''}${'${1:内容}'}\n\\end{${env}}\n${'${0}'}`;
  commands.push(snippetCompletion(template,{label:`\\begin{${env}}`,type:'keyword',detail:`成对插入 ${env} 环境`}));
}
commands.push(snippetCompletion('\\begin{${1}}\n\t${2:内容}\n\\end{${1}}\n${0}',{label:'\\begin',type:'keyword',detail:'自定义 begin/end 环境'}));
commands.push(snippetCompletion('\\end{${1}}${0}',{label:'\\end',type:'keyword',detail:'结束环境'}));
const safePath = (value: string): boolean => !!value && value.length <= 2000 && !value.startsWith('/') && !/[\\\x00-\x1f{}%#]/.test(value) && !value.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.'));
function inferRoot(selectedPath: string): string {
  if(selectedPath.startsWith('manuscript/'))return 'manuscript';
  const response=/^(reviews\/[^/]+\/response)\//.exec(selectedPath);if(response)return response[1];
  return selectedPath.slice(0,selectedPath.lastIndexOf('/'));
}
function protectedContext(text: string): boolean {
  for(let i=0;i<text.length;i++){
    if(text[i]==='%')return true;
    if(text[i]!=='\\')continue;
    if(text[i+1]==='%'||text[i+1]==='\\'){i++;continue;}
    const verb=/^\\verb\*?([^a-zA-Z\s])/.exec(text.slice(i));
    if(verb){const end=text.indexOf(verb[1],i+verb[0].length);if(end<0)return true;i=end;}
  }
  return false;
}
/** Paths resolve against the target main file's directory, matching Tectonic's cwd, not a nested .tex file's directory. */
export function latexCompletion(projectFileList: readonly (FileEntry | string)[], selectedPath: string, targetRoot = inferRoot(selectedPath)): CompletionSource {
  const root=targetRoot.replace(/\/$/,'');
  const allowedRoot=safePath(root)&&!['notes','literature','build','submissions','archive','_system'].includes(root.split('/')[0]);
  const files=[...new Set(projectFileList.flatMap(item=>typeof item==='string'?[item]:item.type==='file'?[item.path]:[]))].filter(file=>safePath(file)&&allowedRoot&&file.startsWith(root+'/')&&file!==selectedPath).sort();
  return (context: CompletionContext): CompletionResult | null => {
    if(context.view?.composing)return null;
    const line=context.state.doc.lineAt(context.pos), before=context.state.doc.sliceString(line.from,context.pos);
    if(protectedContext(before))return null;
    const escaped=(from:number)=>{let n=0;for(let i=from-1;i>=line.from&&context.state.doc.sliceString(i,i+1)==='\\';i--)n++;return n%2===1;};
    const pathToken=context.matchBefore(/\\(?:input|include|includegraphics\*?|bibliography|addbibresource|includepdf)(?:\[[^\]]*\])*\{[^{}]*$/);
    if(pathToken&&!escaped(pathToken.from)){
      const match=/^\\(\w+\*?)/.exec(pathToken.text)!; const command=match[1].replace(/\*$/,''),brace=pathToken.text.indexOf('{'),fragment=pathToken.text.slice(brace+1);
      const comma=command==='bibliography'?fragment.lastIndexOf(','):-1,tail=fragment.slice(comma+1),leading=tail.match(/^\s*/)?.[0].length??0;
      const from=pathToken.from+brace+1+comma+1+leading;
      const allowed=command==='input'||command==='include'?/\.tex$/i:command==='bibliography'||command==='addbibresource'?/\.bib$/i:command==='includepdf'?/\.pdf$/i:/\.(?:pdf|png|jpe?g)$/i;
      const options=files.filter(file=>allowed.test(file)).map(file=>{let relative=file.slice(root.length+1);if(['input','include','bibliography'].includes(command))relative=relative.replace(/\.(?:tex|bib)$/i,'');return{label:relative,apply:relative,type:'text'};});
      return {from,options,validFor:/^[^{}\n,]*$/};
    }
    const environment=context.matchBefore(/\\(?:begin|end)\{[a-zA-Z*]*$/);
    if(environment&&!escaped(environment.from))return {from:environment.from+environment.text.indexOf('{')+1,options:environments.map(label=>({label,type:'keyword',detail:'LaTeX 环境名称'})),validFor:/^[a-zA-Z*]*$/};
    const token=context.matchBefore(/\\[a-zA-Z]*\*?$/);if(!token)return null;
    if(escaped(token.from))return null;
    return {from:token.from,options:commands,validFor:/^\\[a-zA-Z]*\*?$/};
  };
}
