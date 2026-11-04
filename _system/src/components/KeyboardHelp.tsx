import { useEffect, useRef } from 'react';
import { Keyboard, X } from 'lucide-react';
import '../keyboard-help.css';

type Shortcut = { action: string; mac: string; windows?: string; note?: string };
const groups: { title: string; rows: Shortcut[] }[] = [
  { title: '文件与查找', rows: [
    { action: '保存当前文件', mac: '⌘ S', windows: 'Ctrl S' },
    { action: '编译当前目标', mac: '⌘ Enter', windows: 'Ctrl Enter' },
    { action: '搜索当前文件', mac: '⌘ F', windows: 'Ctrl F' },
    { action: '搜索整个项目', mac: '⌘ Shift F', windows: 'Ctrl Shift F' },
    { action: '撤销', mac: '⌘ Z', windows: 'Ctrl Z' },
    { action: '重做', mac: '⌘ Shift Z', windows: 'Ctrl Shift Z' },
  ] },
  { title: 'TeX 编辑', rows: [
    { action: '加粗选中文字', mac: '⌘ B', windows: 'Ctrl B', note: '插入 \\textbf{…}' },
    { action: '斜体选中文字', mac: '⌘ I', windows: 'Ctrl I', note: '插入 \\textit{…}' },
    { action: '切换行注释', mac: '⌘ /', windows: 'Ctrl /', note: '添加或移除行首 %' },
  ] },
  { title: '补全与占位', rows: [
    { action: '打开补全候选', mac: 'Ctrl Space / Alt /', note: 'Ctrl Space 被输入法占用时，可使用 Alt /' },
    { action: '选择候选', mac: '↑ / ↓' },
    { action: '接受当前候选', mac: 'Enter' },
    { action: '接受候选 / 下一占位', mac: 'Tab' },
    { action: '上一个占位', mac: 'Shift Tab' },
    { action: '收起候选或面板', mac: 'Esc' },
  ] },
  { title: '审阅与定位', rows: [
    { action: '划词翻译', mac: 'Ctrl + 拖选文字', note: '普通选中不弹窗；也可选中文字后点击顶栏翻译。浮窗标题栏可拖动，图钉固定位置。' },
    { action: 'AI 审阅所选源码', mac: '⌘ Alt E', windows: 'Ctrl Alt E', note: '先选择需要审阅的文字' },
    { action: '将源码定位到 PDF', mac: '⌘ Alt L', windows: 'Ctrl Alt L', note: '需要当前目标已生成可定位的 PDF' },
  ] },
];

export default function KeyboardHelp({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="keyboard-help-dialog" aria-labelledby="keyboard-help-title" aria-describedby="keyboard-help-scope" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><span className="keyboard-help-eyebrow"><Keyboard size={14}/> ECHOPAPER</span><h2 id="keyboard-help-title">键盘快捷键</h2></div><button type="button" className="icon-button" aria-label="关闭快捷键帮助" onClick={onClose} autoFocus><X size={18}/></button></header>
    <div className="keyboard-help-scroll"><p id="keyboard-help-scope" className="keyboard-help-scope">编辑快捷键作用于源码编辑器。候选列表展开时，Enter 或 Tab 接受当前候选；没有候选时 Enter 正常换行。中文输入法正在组词时不会接受补全候选。AI 聊天输入框保留自己的输入行为。</p>
      <table><thead><tr><th scope="col">操作</th><th scope="col">macOS</th><th scope="col">Windows / Linux</th></tr></thead>{groups.map(group => <tbody key={group.title}><tr className="keyboard-help-group"><th colSpan={3} scope="colgroup">{group.title}</th></tr>{group.rows.map(row => <tr key={row.action}><th scope="row"><span>{row.action}</span>{row.note && <small>{row.note}</small>}</th><td><kbd>{row.mac}</kbd></td><td><kbd>{row.windows || row.mac}</kbd></td></tr>)}</tbody>)}</table>
      <p className="keyboard-help-footnote">⌘ 表示 Command，macOS 的 Alt 表示 Option。系统或浏览器保留的组合键可能优先响应；此时也可使用编辑器工具栏。</p>
    </div><footer><span>先将光标放入源码编辑器</span><button type="button" className="button primary small" onClick={onClose}>知道了 <kbd>Esc</kbd></button></footer>
  </dialog>;
}
