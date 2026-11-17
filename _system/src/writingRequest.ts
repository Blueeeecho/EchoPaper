import type { AgentEditContext, AgentScope, WritingTask } from '../shared/agent-types';
import type { EditSelection } from './editReview';
import {writingObjective} from '../shared/writing-objective';

/** Keep locating material structured. The model declares its edit target in the proposal. */
export function writingRequest(input: string, context: {
  projectId: string; path: string; content: string;
  selection?: EditSelection; pdfReference?: boolean; fileReference?: boolean;
}): { scope: AgentScope; writingTask: WritingTask; editContext:AgentEditContext } {
  const selected=context.selection;
  const editContext:AgentEditContext={...(context.path?{path:context.path}:{}),...(selected?{selection:{path:selected.path,from:selected.from,to:selected.to,documentText:selected.documentText,selectedText:selected.text}}:{})};
  if (/^\s*(?:你在吗|在吗|你好|您好|hi|hello|hey|谢谢)[\s。！？.!?]*$/iu.test(input)) {
    return { scope: { readOnly: true }, writingTask: { kind: 'focused', outputMode: 'suggest', verification: 'none' },editContext };
  }
  const positive = input.replace(/(?:不要|不用|无需|别|不必|不需要)[^，。；;!?\n]*/gu, '');
  const objective=writingObjective(input);
  // Size and placement commands are edits too, even without the word “修改”.
  // Inspect the user's request, never the attached PDF's quoted contents.
  const layoutEdit = /放大|缩小|加宽|缩窄|(?:双|两|二|单|一)栏|跨栏|(?:放在|放到|移到|移至|移动到|移动至).{0,12}(?:第[一二三四五六七八九十百\d]+页|页首|页尾|页顶|页底)|\b(?:enlarge|resize|widen|shrink)\b|\b(?:move|place)\b.{0,40}\bpage\s*\d/iu.test(positive);
  // An explicit action verb. A layout noun on its own ('是单栏吗') is not one.
  const editVerb = /修改|改写|改成|改为|^改[这那]|调整|整理|编辑|润色|修复|替换|删除|插入|添加|加上|换成|换为|换个|作为|变(?:为|成)|设(?:为|置)|标[红蓝黄绿粗亮]|加粗|统一|重新组织|\b(?:edit|rewrite|change|fix|format|replace|insert)\b/iu.test(positive);
  const editing = !!objective || layoutEdit || editVerb;
  const requestedEdit = /(?:请|帮我|顺便|然后|同时|并且|并).{0,8}(?:修改|改写|改成|改为|调整|编辑|润色|修复|替换|删除|添加)/u.test(positive);
  const question = /(?:为什么|为何|为啥|怎么会).{0,40}(?:报错|错误|失败)|哪里(?:出|报)错|出了什么(?:错|问题)|怎么回事|什么原因|(?:能|可以).{0,8}(?:看到|看见|访问|读取)|^(?:请(?:你)?|帮我)?(?:解释|说明|分析|翻译)(?:一下)?|\b(?:why.{0,30}(?:error|fail)|what can you see)\b/iu.test(input) && !requestedEdit;
  const compile = /(?:重新|再次|运行|进行|执行|然后|最后|改完后|修改后|帮我|请|确保)\s*(?:编译|构建)|编译(?:一下|一遍|验证|当前|主稿|全文|稿件|这篇|PDF)|^(?:编译|compile)[。.!！\s]*$|\b(?:please compile|recompile|compile (?:it|the|this|after))\b/iu.test(positive);
  const repair = /(?:修复|解决|排查).{0,12}(?:编译|引用|报错)|(?:编译|引用).{0,8}(?:错误|报错).{0,8}(?:修复|解决)|\bfix.{0,15}(?:compil|error)/iu.test(positive);
  // A question is recognised by how it is asked, not by the absence of an edit keyword:
  // defaulting to read-only silently refused edits phrased with unlisted verbs ("整理为双栏", "变为红色").
  const questionLike = /[？?]\s*$|(?:吗|呢|吧)[\s。.!！?？]*$|^(?:什么|哪|谁|几|多少|如何|怎[么样]|为什么|为何|是否|有没有|能不能|可不可以)|(?:是什么|有多少|有几|是谁|怎么样|如何|什么意思|多少页|多少字)[\s。.!！?？]*$|^你(?:是|能|会|可以|知道|看|有|在)|\b(?:what|which|who|how many|how much|can you|do you|is there)\b/iu.test(input.trim());
  const editSignal = editVerb || requestedEdit || !!objective || compile || repair;
  const readOnly = !positive.trim() || question || (questionLike && !editSignal) || /(?:只|仅)(?:给(?:出)?建议|解释|分析|讨论|回答|翻译)|不要(?:修改|改动|写入|保存)(?:文件|源码|原文|正文|文档|任何内容|任何文件)?(?:[，。；;!?\s]|$)|不改文件|\b(?:explain only|suggestions? only|do not (?:edit|modify|write) (?:files?|the source|the document))\b/iu.test(input);
  // A quote or an open file locates the task; it does not restrict project access.
  const figureAsset = objective?.kind==='replace_figure' || editing && /上传|附件|刚才.{0,12}(?:图片|图像)|(?:图|figure)\s*\d|作为.{0,8}图/iu.test(positive);
  const layout = layoutEdit || (editing && figureAsset) || editing && /双栏|两栏|单栏|跨栏|图片宽|图像宽|页边距|版式|\b(?:two.column|single.column|figure\*|table\*)\b/iu.test(positive);
  const apply = /直接(?:修改|改写|改动|应用|保存|写入|改)|\b(?:apply directly|save directly)\b/iu.test(positive) || /不用(?:再)?(?:确认|审阅)/u.test(input);
  const noCompile = /(?:不要|不用|无需|不必|不需要|别)(?:再|自动|运行|进行)?(?:编译|构建)|\b(?:do not compile|don't compile|no compilation|skip compilation)\b/iu.test(input);
  const writingTask: WritingTask = {
    kind: repair ? 'repair' : 'project',
    outputMode: apply && !readOnly ? 'apply' : 'suggest',
    verification: (compile || repair || layout) && !noCompile && !readOnly ? 'compile' : 'none',
  };
  return {scope:readOnly?{readOnly:true}:{},writingTask,editContext};
}
