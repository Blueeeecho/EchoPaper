import { useEffect, useRef, useState } from 'react';
import type { EditSelection } from '../editReview';
import { menuPosition, type WritingQuote } from '../selectionContext';

interface Props {
  projectId: string;
  buildId?: string;
  readSource: () => EditSelection | undefined;
  onAdd: (quote: WritingQuote) => void;
  onEdit: (selection: EditSelection) => void;
}

export default function WritingSelectionMenu({ projectId, buildId, readSource, onAdd, onEdit }: Props) {
  const [menu, setMenu] = useState<{ quote: WritingQuote; left: number; top: number; before: HTMLElement | null }>();
  const panel = useRef<HTMLDivElement>(null);
  const actions = useRef({ projectId, buildId, readSource, onAdd, onEdit });
  actions.current = { projectId, buildId, readSource, onAdd, onEdit };
  const close = (restore: boolean) => {
    if (restore && menu?.before?.isConnected) menu.before.focus();
    setMenu(undefined);
  };
  useEffect(() => { panel.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [menu]);
  useEffect(() => {
    let captured: WritingQuote | undefined;
    function capture(target: EventTarget | null): WritingQuote | undefined {
      const element = target instanceof Element ? target : null;
      if (element?.closest('.source-editor')) {
        const selection = actions.current.readSource();
        if (selection) return { id: Date.now(), projectId: actions.current.projectId, source: 'source', selection };
      }
      const native = window.getSelection();
      if (!native?.rangeCount || !native.toString().trim()) return;
      const parent = (node: Node) => node instanceof Element ? node : node.parentElement;
      const range = native.getRangeAt(0);
      const start = parent(range.startContainer)?.closest('.textLayer');
      const end = parent(range.endContainer)?.closest('.textLayer');
      if (!start || !end || !start.closest('.writing-area') || !end.closest('.writing-area')) return;
      // Same-page PDF actions share the PDF annotation menu. Cross-page quotes
      // keep this fallback because PDF annotations require a single page.
      if (start === end && start.closest('[data-ai-selection-menu="true"]')) return;
      if (element && !element.closest('.textLayer') && element !== document.body) return;
      const firstPage = start.closest<HTMLElement>('[data-page]')?.dataset.page;
      const lastPage = end.closest<HTMLElement>('[data-page]')?.dataset.page;
      const page = firstPage === lastPage && Number(firstPage) > 0 ? Number(firstPage) : undefined;
      return { id: Date.now(), projectId: actions.current.projectId, source: 'pdf', text: native.toString(), buildId: actions.current.buildId, page };
    }
    const down = (event: PointerEvent) => {
      if (panel.current?.contains(event.target as Node)) return;
      setMenu(undefined);
      captured = undefined;
      if (event.button !== 2 || event.ctrlKey) return;
      captured = capture(event.target);
      if (captured) event.preventDefault();
    };
    const open = (event: MouseEvent) => {
      if (event.ctrlKey) return;
      const quote = captured || capture(event.target);
      captured = undefined;
      if (!quote) return;
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new Event('echopaper:selection-menu-open'));
      setMenu({ quote, ...menuPosition(event.clientX, event.clientY, window.innerWidth, window.innerHeight), before: document.activeElement as HTMLElement | null });
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      const quote = capture(event.target);
      if (!quote) return;
      event.preventDefault();
      const rect = (event.target as Element)?.getBoundingClientRect();
      window.dispatchEvent(new Event('echopaper:selection-menu-open'));
      setMenu({ quote, ...menuPosition(rect?.left || 20, rect?.top || 20, window.innerWidth, window.innerHeight), before: document.activeElement as HTMLElement | null });
    };
    const dismiss = () => setMenu(undefined);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('contextmenu', open, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('echopaper:selection-menu-open', dismiss);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('contextmenu', open, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('echopaper:selection-menu-open', dismiss);
    };
  }, []);
  useEffect(() => setMenu(undefined), [projectId, buildId]);
  if (!menu) return null;
  return <div ref={panel} className="writing-selection-menu" role="menu" aria-label="选区操作" style={{ left: menu.left, top: menu.top }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    if (event.key === 'Tab') close(false);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = Array.from(panel.current?.querySelectorAll('button') || []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }
  }}>
    <button role="menuitem" onClick={() => { const quote = menu.quote; close(true); actions.current.onAdd(quote); }}>添加到 AI 对话</button>
    {menu.quote.source === 'source' && <button role="menuitem" onClick={() => { close(true); if (menu.quote.source === 'source') actions.current.onEdit(menu.quote.selection); }}>直接修改选区并审阅</button>}
  </div>;
}
