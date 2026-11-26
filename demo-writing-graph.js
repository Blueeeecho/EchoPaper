(() => {
  'use strict';

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const raw = String.raw;
  let lang = 'zh';
  const t = (zh, en) => lang === 'en' ? en : zh;
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  const check = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const arrow = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const photo = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5.5" cy="6" r="1" fill="currentColor"/><path d="m3 12 3-3 2 1.5 2.5-3 3 3.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  const gallery = () => `<button class="epwg-button epwg-subtle" type="button" data-action="gallery">${photo}${t('查看真实软件实景', 'View app screenshots')}</button>`;

  function highlight(line) {
    return line.split(/(\\[a-zA-Z]+|[{}&]|\b\d+\b)/g).map((token, index) => {
      const value = escape(token);
      if (index % 2 === 0) return value;
      const style = token.startsWith('\\') ? 'command' : /^\d/.test(token) ? 'number' : 'punctuation';
      return `<span class="epwg-${style}">${value}</span>`;
    }).join('');
  }

  function tableSource(format, style) {
    const low = style ? raw`72\,\%` : raw`72\%`;
    const high = style ? raw`66\,\%` : raw`66\%`;
    const anchorLow = style ? raw`84\,\%` : raw`84\%`;
    const anchorHigh = style ? raw`63\,\%` : raw`63\%`;
    const lines = [['table', raw`\begin{table}`], ['center', raw`  \centering`]];
    const caption = ['caption', raw`  \caption{Support recall}`];
    if (style) lines.push(caption, ['label', raw`  \label{tab:recall}`]);
    lines.push(['tabular', format ? raw`  \begin{tabular}{lrr}` : raw`  \begin{tabular}{lll}`]);
    if (format) lines.push(['top', raw`    \toprule`]);
    lines.push(['header', format ? raw`    Noise & Local & Anchors \\` : raw`    Noise&Local&Anchors\\`]);
    if (format) lines.push(['mid', raw`    \midrule`]);
    lines.push(
      ['low', format ? raw`    Low   & ${low} & ${anchorLow} \\` : raw`    Low&${low}&${anchorLow}\\`],
      ['high', format ? raw`    High  & ${high} & ${anchorHigh} \\` : raw`    High&${high}&${anchorHigh}\\`]
    );
    if (format) lines.push(['bottom', raw`    \bottomrule`]);
    lines.push(['end-tabular', raw`  \end{tabular}`]);
    if (!style) lines.push(caption, ['label', raw`  \label{tab:recall}`]);
    lines.push(['end-table', raw`\end{table}`]);
    return lines;
  }

  const syncLines = [
    { code: raw`\subsection{Matched observations}`, label: ['配对观察', 'Matched observations'] },
    { code: 'We hold the block budget fixed.', label: ['固定分块预算。', 'We hold the block budget fixed.'] },
    { code: raw`See Table~\ref{tab:recall}.`, label: ['参见表 1。', 'See Table 1.'] }
  ];

  const scenes = [
    ['AI 选区调格式', 'AI format review'],
    ['助手修复编译', 'Repair a reference'],
    ['SyncTeX 与投稿校验', 'SyncTeX & submission']
  ];

  function sourceRows(lines, current = '') {
    return lines.map(([id, code], index) => `
      <div class="epwg-source-row" data-line="${id}">
        <span class="epwg-ln" aria-hidden="true">${index + 1}</span>
        <code>${highlight(code)}</code>
        ${id === 'ref' ? `<span class="epwg-dot ${current}" aria-hidden="true"></span>` : ''}
      </div>`).join('');
  }

  function initWriting(host) {
    host.classList.add('epwg-writing', 'epwg');
    const state = {
      scene: 0, selected: [true, true], accepted: null, repair: 'error',
      sync: 0, reviewed: false, pack: 0
    };
    let autoplay = !motion.matches;
    let hovering = false;
    let visible = !('IntersectionObserver' in window);
    let autoTimer;
    let workTimers = [];
    let syncPreview = null;
    let opening = true;

    function head(label, meta = '') {
      return `<div class="epwg-pane-head"><span>${label}</span>${meta ? `<small>${meta}</small>` : ''}</div>`;
    }

    function button(action, label, kind = 'subtle', disabled = false) {
      return `<button type="button" class="epwg-button epwg-${kind}" data-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;
    }

    function tableDiff() {
      const groups = [
        {
          label: t('表格线与列对齐', 'Table rules and alignment'),
          before: [raw`\begin{tabular}{lll}`, raw`Noise&Local&Anchors\\`],
          after: [raw`\begin{tabular}{lrr}`, raw`\toprule`, raw`Noise & Local & Anchors \\`, raw`\midrule`, raw`\bottomrule`]
        },
        {
          label: t('数字间距与表题位置', 'Number spacing and caption'),
          before: [raw`72\%`, raw`\caption{Support recall}`],
          after: [raw`72\,\%`, raw`\caption{Support recall}`],
          note: t('表题和标签移至 tabular 前', 'Move the caption and label above tabular')
        }
      ];
      return groups.map(({ label, before, after, note }, i) => `
        <section class="epwg-diff-group">
          <label class="epwg-check">
            <input type="checkbox" data-group="${i}" ${state.selected[i] ? 'checked' : ''} ${state.accepted ? 'disabled' : ''}>
            <span>${i + 1}. ${label}</span>
          </label>
          <div class="epwg-diff-lines">
            ${before.map((line) => diffLine('del', line)).join('')}
            ${after.map((line) => diffLine('ins', line)).join('')}
          </div>
          ${note ? `<p class="epwg-diff-note">${note}</p>` : ''}
        </section>`).join('');
    }

    function diffLine(kind, line) {
      return `<${kind} class="epwg-diff-line"><span aria-hidden="true">${kind === 'del' ? '−' : '+'}</span><code>${escape(line)}</code></${kind}>`;
    }

    function formatScene() {
      const [format, style] = state.accepted || [false, false];
      return `<div class="epwg-columns">
        <section class="epwg-pane">${head('02-results.tex', 'LaTeX')}
          <div class="epwg-code">${sourceRows(tableSource(format, style))}</div>
        </section>
        <section class="epwg-pane">${head(t('AI 修改差异审阅', 'Review AI changes'))}
          ${tableDiff()}
          <div class="epwg-pane-actions">
            ${button('accept', t('接受所选修改', 'Accept selected changes'), 'primary', Boolean(state.accepted) || !state.selected.some(Boolean))}
            ${button('reset', t('重置演示', 'Reset demo'))}
          </div>
        </section>
      </div>`;
    }

    function pdfPage(content) {
      return `<article class="epwg-pdf">
        <span class="epwg-running">Research Lab <span>2</span></span>
        ${content}
      </article>`;
    }

    function repairScene() {
      const fixed = state.repair === 'fixed';
      const compiling = state.repair === 'compiling';
      const ref = fixed ? raw`\ref{tab:recall}` : raw`\ref{tab:recal}`;
      const lines = [
        ['section', raw`\section{Results}`],
        ['budget', 'We hold the block budget fixed.'],
        ['report', 'We report support recall below.'],
        ['ref', `See ${ref}.`]
      ];
      const diagnostic = fixed ? `<span class="epwg-status epwg-success">${check}${t('Tectonic 编译通过', 'Tectonic build passed')}</span>`
        : `<code>Undefined reference 'tab:recal'</code><span>${t('修复线索', 'Found label at')} <code>02-results.tex L9 ${escape(raw`\label{tab:recall}`)}</code></span>`;
      return `<div class="epwg-columns">
        <section class="epwg-pane">${head('02-results.tex', 'LaTeX')}
          <div class="epwg-code">${sourceRows(lines, fixed ? 'epwg-is-fixed' : 'epwg-is-error')}</div>
          <div class="epwg-diagnostic" aria-live="polite">${diagnostic}</div>
          ${state.repair === 'error' ? `<div class="epwg-pane-actions">${button('assistant', t('交给助手修复', 'Ask assistant to fix'), 'primary')}</div>` : ''}
          ${state.repair === 'patch' || compiling ? `<div class="epwg-patch ${compiling ? '' : 'epwg-enter'}">
            <div class="epwg-patch-title"><strong>${t('助手建议的最小补丁', 'Suggested minimal patch')}</strong>
            <span>${t('已锁定保护 .cls / .sty 官方模板文件', 'Official .cls / .sty template files are locked')}</span></div>
            <div class="epwg-diff-lines">
              ${diffLine('del', raw`\ref{tab:recal}`)}
              ${diffLine('ins', raw`\ref{tab:recall}`)}
            </div>
            <div class="epwg-pane-actions">${button('compile', compiling ? t('正在重编 PDF', 'Rebuilding PDF') : t('应用并重编 PDF', 'Apply and rebuild PDF'), 'primary', compiling)}</div>
          </div>` : ''}
          ${fixed ? `<div class="epwg-pane-actions">${button('replay', t('重播报错', 'Replay error'))}</div>` : ''}
        </section>
        <section class="epwg-pane epwg-preview">${head('PDF', 'p.2')}
          ${pdfPage(`<h4>${t('配对观察', 'Matched observations')}</h4>
            <p>${t('固定分块预算后，逐对比较局部路由与锚点路由的证据召回。', 'At a fixed block budget, compare support recall for local and anchored routing on matched pairs.')}</p>
            <p>${t('参见', 'See')} <span class="epwg-ref ${fixed ? 'epwg-ref-fixed' : 'epwg-ref-error'}">${fixed ? 'Table 1' : '??'}</span>${t('。', '.')}</p>
            <table class="epwg-pdf-table"><caption>${t('表 1 · 证据召回（合成样例）', 'Table 1 · Support recall (synthetic example)')}</caption>
            <thead><tr><th scope="col">${t('干扰', 'Noise')}</th><th scope="col">${t('局部', 'Local')}</th><th scope="col">${t('锚点', 'Anchors')}</th></tr></thead>
            <tbody><tr><th scope="row">${t('低', 'Low')}</th><td>72%</td><td>84%</td></tr><tr><th scope="row">${t('高', 'High')}</th><td>66%</td><td>63%</td></tr></tbody></table>`)}
        </section>
      </div>`;
    }

    function syncScene() {
      return `<div class="epwg-columns">
        <section class="epwg-pane">${head('02-results.tex', 'LaTeX')}
          <div class="epwg-code epwg-sync-code">
            ${syncLines.map(({ code }, i) => `<button type="button" class="epwg-source-row epwg-sync-target" data-sync="${i}" aria-pressed="false">
                <span class="epwg-ln" aria-hidden="true">${i + 1}</span><code>${highlight(code)}</code>
              </button>`).join('')}
          </div>
        </section>
        <section class="epwg-pane epwg-preview">${head('PDF', 'p.2')}
          ${pdfPage(`<div class="epwg-sync-pdf">
            ${syncLines.map(({ label }, i) => `<button type="button" class="epwg-sync-target" data-sync="${i}" aria-pressed="false">${t(...label)}</button>`).join('')}
            </div>
            <div class="epwg-annotation"><span>${t('PDF 批注', 'PDF annotation')} <strong class="${state.reviewed ? 'epwg-success' : ''}">${state.reviewed ? t('已核验', 'Verified') : t('待处理', 'To review')}</strong></span>
            ${button('review', state.reviewed ? t('标为待处理', 'Mark to review') : t('标为已核验', 'Mark verified'))}</div>`)}
        </section>
      </div>
      <div class="epwg-package">
        <div class="epwg-package-head"><strong>${t('投稿 ZIP 独立校验', 'Standalone submission ZIP check')}</strong>
          ${button('package', t('模拟打包并校验', 'Simulate packaging & check'), 'primary', state.pack > 0 && state.pack < 4)}
        </div>
        <ol class="epwg-steps" aria-label="${t('校验步骤', 'Validation steps')}">
          ${[
            t('剥离笔记与构建缓存', 'Exclude notes and build cache'),
            t('解压到独立临时目录并重跑 Tectonic', 'Unpack in a temporary folder and rerun Tectonic'),
            t('投稿包独立编译通过，SHA-256 已封存', 'Standalone build passed · SHA-256 archived')
          ].map((label, i) => `<li class="${state.pack > i + 1 ? 'is-done' : ''}" ${state.pack === i + 1 ? 'aria-current="step"' : ''}>
            <span class="epwg-step-index" aria-hidden="true">${state.pack > i + 1 ? check : i + 1}</span><span>${label}</span>
          </li>`).join('')}
        </ol>
        <div class="epwg-sr-only" role="status">${state.pack === 4 ? t('投稿包模拟校验完成', 'Simulated submission check complete') : ''}</div>
      </div>`;
    }

    function updateSync() {
      const active = syncPreview ?? state.sync;
      host.querySelectorAll('[data-sync]').forEach((element) => {
        element.classList.toggle('is-synced', Number(element.dataset.sync) === active);
        element.setAttribute('aria-pressed', String(Number(element.dataset.sync) === state.sync));
      });
    }

    function render() {
      const focused = host.contains(document.activeElement) ? document.activeElement : null;
      const focusSelector = focused && ['tab', 'action', 'sync'].flatMap((key) =>
        focused.dataset[key] != null ? [`[data-${key}="${focused.dataset[key]}"]`] : []
      )[0];
      host.innerHTML = `
        <div class="epwg-toolbar">
          <span class="epwg-demo-label">${t('交互模拟', 'Interactive simulation')}</span>
          <div class="epwg-controls">
            ${button('auto', autoplay ? t('暂停', 'Pause') : t('自动演示', 'Play demo'))}
            ${gallery()}
          </div>
        </div>
        <div class="epwg-window">
          <div class="epwg-tabs" role="tablist" aria-label="${t('写稿演示场景', 'Writing demo scenes')}">
            ${scenes.map((label, i) => `<button type="button" role="tab" data-tab="${i}" id="epwg-tab-${i}" aria-controls="epwg-writing-panel" aria-selected="${state.scene === i}" tabindex="${state.scene === i ? '0' : '-1'}">${t(...label)}</button>`).join('')}
          </div>
          <div class="epwg-progress ${state.scene === 1 && state.repair === 'compiling' ? 'is-running' : ''}" aria-hidden="true"><span></span></div>
          ${state.scene === 0 && state.accepted ? `<div class="epwg-checkpoint" role="status">
            <span class="epwg-status">${check}${t('已自动建立 Git 版本检查点并写入主稿', 'Git checkpoint created and manuscript updated')}</span>
          </div>` : ''}
          <div id="epwg-writing-panel" role="tabpanel" aria-labelledby="epwg-tab-${state.scene}">
            ${[formatScene, repairScene, syncScene][state.scene]()}
          </div>
        </div>`;
      updateSync();
      if (focusSelector) {
        const next = host.querySelector(focusSelector);
        if (next && !next.disabled) next.focus({ preventScroll: true });
        else {
          const fallback = focused.dataset.action && {
            accept: 'reset', assistant: 'compile', compile: 'replay'
          }[focused.dataset.action];
          const action = fallback && host.querySelector(`[data-action="${fallback}"]:not(:disabled)`);
          (action || host.querySelector('[aria-selected="true"]')).focus({ preventScroll: true });
        }
      }
    }

    function runAfter(callback, time) {
      workTimers.push(window.setTimeout(callback, motion.matches ? 0 : time));
    }

    function accept() {
      if (state.accepted || !state.selected.some(Boolean)) return;
      const relativeRows = new Map(Array.from(host.querySelectorAll('[data-line]'), (line) =>
        [line.dataset.line, line.offsetTop]
      ));
      state.accepted = state.selected.slice();
      render();
      if (motion.matches || !Element.prototype.animate) return;
      host.querySelectorAll('[data-line]').forEach((line) => {
        const oldTop = relativeRows.get(line.dataset.line);
        const frames = oldTop === undefined ? [{ opacity: 0 }, { opacity: 1 }] : [
          { transform: `translateY(${oldTop - line.offsetTop}px)`, opacity: .65 },
          { transform: 'translateY(0)', opacity: 1 }
        ];
        line.animate(frames, { duration: 360, easing: 'cubic-bezier(.2,.75,.25,1)' });
      });
    }

    function compile() {
      state.repair = 'compiling';
      render();
      runAfter(() => {
        state.repair = 'fixed';
        render();
        schedule();
      }, 980);
    }

    function packageCheck() {
      workTimers.forEach(clearTimeout);
      workTimers = [];
      state.pack = 1;
      render();
      [2, 3, 4].forEach((step) => runAfter(() => {
        state.pack = step;
        render();
        schedule();
      }, (step - 1) * 610));
    }

    function goTo(index) {
      workTimers.forEach(clearTimeout);
      workTimers = [];
      if (state.repair === 'compiling') state.repair = 'patch';
      if (state.pack < 4) state.pack = 0;
      state.scene = index;
      syncPreview = null;
      render();
      host.querySelector('#epwg-writing-panel').classList.add('epwg-enter');
      schedule();
    }

    function schedule() {
      clearTimeout(autoTimer);
      const active = document.activeElement;
      const usingDemo = host.contains(active) && active.dataset.action !== 'auto';
      if (!autoplay || hovering || !visible || document.hidden || usingDemo) return;
      const advance = (time, callback) => {
        autoTimer = window.setTimeout(() => {
          callback();
          schedule();
        }, time);
      };

      if (state.scene === 0) {
        if (state.accepted) advance(3300, () => goTo(1));
        else advance(4400, accept);
      } else if (state.scene === 1) {
        if (state.repair === 'error') advance(3800, () => { state.repair = 'patch'; render(); });
        if (state.repair === 'patch') advance(2800, compile);
        if (state.repair === 'fixed') advance(3300, () => goTo(2));
      } else {
        if (state.sync < 2) advance(1800, () => { state.sync += 1; updateSync(); });
        else if (!state.reviewed) advance(1200, () => { state.reviewed = true; render(); });
        else if (state.pack === 0) advance(1000, packageCheck);
        else if (state.pack === 4) advance(4000, () => {
          Object.assign(state, { selected: [true, true], accepted: null, repair: 'error', sync: 0, reviewed: false, pack: 0 });
          goTo(0);
        });
      }
    }

    function stopAuto() {
      autoplay = false;
      clearTimeout(autoTimer);
      const toggle = host.querySelector('[data-action="auto"]');
      if (toggle) toggle.textContent = t('自动演示', 'Play demo');
    }

    host.addEventListener('click', (event) => {
      const target = event.target.closest('button');
      if (!target) return;
      const { action, tab, sync } = target.dataset;
      if (action === 'gallery') {
        stopAuto();
        window.EchoPaperSite?.openGallery?.(['ai-latex-diff', 'ai-error-fix', 'submission-review'][state.scene]);
        return;
      }
      if (action === 'auto') {
        autoplay = !autoplay;
        if (autoplay && state.scene === 0 && !state.selected.some(Boolean)) state.selected = [true, true];
        render();
        schedule();
        return;
      }
      stopAuto();
      if (tab !== undefined) {
        goTo(Number(tab));
        host.querySelector(`[data-tab="${tab}"]`).focus({ preventScroll: true });
      } else if (sync !== undefined) {
        state.sync = Number(sync);
        updateSync();
      } else if (action === 'accept') accept();
      else if (action === 'reset') {
        state.accepted = null;
        state.selected = [true, true];
        render();
      } else if (action === 'assistant') {
        state.repair = 'patch';
        render();
      } else if (action === 'compile') compile();
      else if (action === 'replay') {
        state.repair = 'error';
        render();
      } else if (action === 'review') {
        state.reviewed = !state.reviewed;
        render();
      } else if (action === 'package') packageCheck();
    });

    host.addEventListener('change', (event) => {
      const input = event.target;
      if (!input.matches('[data-group]')) return;
      stopAuto();
      state.selected[Number(input.dataset.group)] = input.checked;
      host.querySelector('[data-action="accept"]').disabled = !state.selected.some(Boolean);
    });

    host.addEventListener('keydown', (event) => {
      const target = event.target;
      if (!target.matches('[data-tab]')) return;
      const index = Number(target.dataset.tab);
      const next = { ArrowLeft: (index + 2) % 3, ArrowRight: (index + 1) % 3, Home: 0, End: 2 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      stopAuto();
      goTo(next);
      host.querySelector(`[data-tab="${next}"]`).focus({ preventScroll: true });
    });

    host.addEventListener('pointerover', (event) => {
      if (event.pointerType === 'touch') return;
      if (!hovering && event.target.closest('.epwg-window')) {
        hovering = true;
        schedule();
      }
      const target = event.target.closest('[data-sync]');
      if (!target) return;
      syncPreview = Number(target.dataset.sync);
      updateSync();
    });
    host.addEventListener('pointerout', (event) => {
      if (event.pointerType === 'touch') return;
      const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
      if (hovering && !next?.closest('.epwg-window')) {
        hovering = false;
        schedule();
      }
      const target = event.target.closest('[data-sync]');
      if (!target || target.contains(next)) return;
      syncPreview = null;
      updateSync();
    });
    host.addEventListener('focusin', schedule);
    host.addEventListener('focusout', () => window.setTimeout(schedule, 0));
    document.addEventListener('visibilitychange', schedule);
    motion.addEventListener('change', () => {
      if (motion.matches) stopAuto();
      schedule();
    });

    return () => {
      render();
      if (opening && 'IntersectionObserver' in window) {
        const observer = new IntersectionObserver(([entry]) => {
          visible = entry.isIntersecting;
          schedule();
        });
        observer.observe(host.querySelector('.epwg-window').parentElement);
      }
      opening = false;
      schedule();
    };
  }

  // Evidence transcribed from the site's synthetic demonstration manuscripts.
  const evidence = {
    anchor: ['Anchor Slots', 1, 'We reserve two anchor slots to isolate one source of retrieval error in block-sparse attention.', '我们预留两个锚点槽位，以隔离块稀疏注意力中一种检索错误的来源。'],
    distant: ['Anchor Slots', 1, 'Two reserved slots preserve distant evidence.', '两个预留槽位保存远距证据。'],
    paired: ['Block Routing', 2, 'At low interference the anchor rule recovers support in twelve more pairs. At high interference it gives up three successes relative to local routing.', '低干扰下，锚点规则多找回 12 对样本中的证据。高干扰下，与局部路由相比少找回 3 对。'],
    displaced: ['Block Routing', 1, 'Similar distractors displace the support block.', '相似的干扰块会把支持证据块挤出候选集。'],
    audit: ['Position Audit', 1, 'Position bins expose errors hidden by the mean.', '按位置分组可以揭示平均值掩盖的错误。'],
    benchmark: ['Block Routing', 1, 'The RouteBench fixture indexes every query by distance and distractor count.', 'RouteBench 测试数据按距离和干扰项数量为每条查询建立索引。'],
    dense: ['Block Routing', 1, 'The Dense Reader provides an upper bound on candidate coverage.', 'Dense Reader 为候选集覆盖率提供上界。'],
    comparison: ['Anchor Slots', 3, 'Our method outperforms LocalScan under low interference.', '在低干扰下，我们的方法优于 LocalScan。'],
    local: ['Block Routing', 3, 'LocalScan keeps eight local candidates and retains it.', 'LocalScan 保留八个局部候选，因此保留了该证据块。']
  };

  const graphLayers = [
    ['论文', 'Papers'],
    ['方法与问题', 'Methods & problems'],
    ['模型与基准', 'Models & benchmarks']
  ];

  const nodes = {
    anchor: { label: ['Anchor Slots', 'Anchor Slots'], edge: 'propose' },
    routing: { label: ['Block Routing', 'Block Routing'], edge: 'compare', evidence: 'paired' },
    audit: { label: ['Position Audit', 'Position Audit'], edge: 'audit' },
    slots: { label: ['预留锚点槽位', 'Reserved anchor|slots'], edge: 'propose' },
    missed: { label: ['远距证据遗漏', 'Missed distant|evidence'], edge: 'distract', evidence: 'paired' },
    local: { label: ['局部滑窗路由', 'Local window|routing'], edge: 'local' },
    bench: { label: ['RouteBench', 'RouteBench'], edge: 'benchmark' },
    dense: { label: ['Dense Reader', 'Dense Reader'], edge: 'dense' },
    scan: { label: ['LocalScan', 'LocalScan'], edge: 'local' }
  };

  const graphRows = [
    ['anchor', 'routing', 'audit'],
    ['slots', 'missed', 'local'],
    ['bench', 'dense', 'scan']
  ];

  const graphEdges = {
    propose: ['anchor', 'slots', ['提出方法', 'Proposes'], 'anchor', 0],
    scope: ['anchor', 'missed', ['针对问题', 'Targets'], 'distant', 3],
    distract: ['routing', 'missed', ['分析问题', 'Analyzes'], 'displaced', 1],
    compare: ['routing', 'local', ['比较方法', 'Compares'], 'paired', 4],
    audit: ['audit', 'missed', ['分层审计', 'Audits'], 'audit', 2],
    benchmark: ['slots', 'bench', ['评测于', 'Evaluated on'], 'benchmark', 0],
    outperform: ['slots', 'scan', ['优于', 'Outperforms'], 'comparison', 4],
    measure: ['missed', 'bench', ['评测于', 'Evaluated on'], 'benchmark', 3],
    dense: ['missed', 'dense', ['覆盖对照', 'Controls for'], 'dense', 1],
    window: ['slots', 'dense', ['对照基线', 'Benchmark vs.'], 'dense', 2],
    local: ['local', 'scan', ['实现于', 'Implemented by'], 'local', 5]
  };

  function nodeName(id) {
    return t(...nodes[id].label).replace('|', ' ');
  }

  function relationName([from, to, predicate]) {
    return `${nodeName(from)} → ${t(...predicate)} → ${nodeName(to)}`;
  }

  function initGraph(host) {
    host.classList.add('epwg-graph', 'epwg');
    let pinned = { node: 'routing' };
    let hovered = null;
    let focused = null;
    let width = 0;
    let renderedEvidence = '';
    let canvas;

    function graphMarkup() {
      const inset = width > 520 ? 24 : 8;
      const cell = (width - 2 * inset) / 3;
      const point = (col) => inset + cell * (col + .5);
      const pos = {};
      const y = [64, 242, 420];
      const layers = graphRows.map((row, layer) => {
        const title = t(...graphLayers[layer]);
        const glyph = [
          '<path d="M1.5 1.5h5l3 3v7H1.5zm5 0v3h3"/>',
          '<path d="m5.5 1 5 5-5 5-5-5z"/>',
          '<circle cx="5.5" cy="6" r="4"/>'
        ][layer];
        const controls = row.map((id, col) => {
          const x = point(col);
          const box = Math.min(164, cell - 9);
          pos[id] = { x, y: y[layer] };
          const lines = t(...nodes[id].label).split('|');
          return `<g class="epwg-node epwg-layer-${layer}" data-node="${id}" role="button" tabindex="0" aria-pressed="false" aria-label="${escape(nodeName(id))}">
            <rect x="${x - box / 2}" y="${y[layer] - 23}" width="${box}" height="46" rx="7"/>
            <text x="${x}" y="${y[layer] + (lines.length === 1 ? 4.5 : -3)}">${lines.length === 1 ? escape(lines[0]) : lines.map((line, i) => `<tspan x="${x}" dy="${i ? 15 : 0}">${escape(line)}</tspan>`).join('')}</text>
          </g>`;
        }).join('');
        return `<g aria-hidden="true" class="epwg-layer-name">
          <g transform="translate(${inset + 4} ${y[layer] - 49})">${glyph}</g>
          <text x="${inset + 22}" y="${y[layer] - 39}">${title}</text>
        </g>${controls}`;
      }).join('');

      const edges = Object.entries(graphEdges).map(([id, edge]) => {
        const [from, to, predicate, , slot] = edge;
        const a = pos[from];
        const b = pos[to];
        const xLabel = point(slot % 3);
        const yLabel = a.y + (slot < 3 ? 57 : 105);
        const source = a.y + 23;
        const target = b.y - 23;
        const arc = (x, start, labelX, labelY) =>
          `C ${x} ${(start + labelY) / 2}, ${labelX} ${(start + labelY) / 2}, ${labelX} ${labelY}`;
        const path = `M ${a.x} ${source} ${arc(a.x, source, xLabel, yLabel)} ${arc(xLabel, yLabel, b.x, target)}`;
        const hitWidth = Math.min(cell - 4, 106);
        return {
          trace: `<g class="epwg-trace" data-trace="${id}" aria-hidden="true">
            <path class="epwg-wire" d="${path}"/><path class="epwg-flow" d="${path}"/><path class="epwg-wire-hit" data-edge-hit="${id}" d="${path}"/></g>`,
          control: `<g class="epwg-edge" data-edge="${id}" role="button" tabindex="0" aria-pressed="false" aria-label="${escape(relationName(edge))}">
            <rect class="epwg-edge-hit" x="${xLabel - hitWidth / 2}" y="${yLabel - 22}" width="${hitWidth}" height="44"/>
            <rect class="epwg-edge-label" x="${xLabel - hitWidth / 2}" y="${yLabel - 12}" width="${hitWidth}" height="24" rx="5"/>
            <text x="${xLabel}" y="${yLabel + 4}">${t(...predicate)}</text>
          </g>`
        };
      });

      return `<svg viewBox="0 0 ${width} 461" width="${width}" height="461" role="group" aria-label="${t('课题知识关系图', 'Research knowledge graph')}">
        ${edges.map(({ trace }) => trace).join('')}
        ${layers}
        ${edges.map(({ control }) => control).join('')}
      </svg>`;
    }

    function updateGraph() {
      const active = hovered || focused || pinned;
      const edges = active.edge ? [active.edge] : Object.keys(graphEdges).filter((id) => graphEdges[id].slice(0, 2).includes(active.node));
      const relatedNodes = new Set(edges.flatMap((id) => graphEdges[id].slice(0, 2)));

      canvas.querySelectorAll('[data-node], [data-edge], [data-trace]').forEach((element) => {
        const { node, edge, trace } = element.dataset;
        const related = node ? relatedNodes.has(node) : edges.includes(edge || trace);
        element.classList.toggle('is-related', related);
        element.classList.toggle('is-muted', !related);
        if (node !== undefined || edge !== undefined) {
          const current = node ? node === active.node : edge === active.edge;
          element.classList.toggle('is-current', current);
          element.setAttribute('aria-pressed', String(node ? node === pinned.node : edge === pinned.edge));
        }
      });

      const key = active.edge || active.node;
      if (key === renderedEvidence) return;
      renderedEvidence = key;
      const edge = active.edge ? graphEdges[active.edge] : graphEdges[nodes[active.node].edge];
      const [paper, page, quote, translation] = evidence[nodes[active.node]?.evidence || edge[3]];
      const compare = ['routing', 'missed'].includes(active.node) || edge[3] === 'paired';
      const reading = host.querySelector('[data-action="reading"]');
      reading.dataset.excerpt = compare ? 'observations' : '';
      reading.querySelector('span').textContent = compare
        ? t('跳去阅读区看这句双语原文', 'Open this excerpt in the bilingual reader')
        : t('打开双语阅读区', 'Open bilingual reader');
      const panel = host.querySelector('.epwg-evidence-body');
      panel.innerHTML = `
        <div class="epwg-evidence-content epwg-enter">
          <p class="epwg-relation">${relationName(edge)}</p>
          <div class="epwg-citation"><cite>${paper}</cite><span>p.${page}</span></div>
          <blockquote lang="${lang}">${lang === 'zh' ? translation : quote}</blockquote>
          ${lang === 'zh' ? `<p class="epwg-original" lang="en">${quote}</p>` : ''}
          ${compare ? `<div class="epwg-ablation">
            <div class="epwg-ablation-heading"><strong>${t('配对消融', 'Paired ablation')}</strong><span>${t('合成样例', 'Synthetic example')}</span></div>
            <dl><div><dt>${t('低干扰', 'Low interference')}</dt><dd>72 → 84</dd></div>
                <div><dt>${t('高干扰', 'High interference')}</dt><dd>66 → 63</dd></div></dl>
            <span>${t('局部路由 → 预留锚点', 'Local routing → reserved anchors')}</span>
            <div class="epwg-hash">${t('SHA-256 前 8 位', 'SHA-256 prefix')} <code>a5234c22</code></div>
          </div>` : ''}
        </div>`;
    }

    function renderCanvas() {
      const measured = Math.floor(canvas.clientWidth);
      if (!measured || measured === width) return;
      const selector = document.activeElement?.closest('[data-node], [data-edge]');
      const focusKey = canvas.contains(selector) ? Object.entries(selector.dataset)[0] : null;
      width = measured;
      canvas.innerHTML = graphMarkup();
      if (focusKey) canvas.querySelector(`[data-${focusKey[0]}="${focusKey[1]}"]`)?.focus({ preventScroll: true });
      updateGraph();
    }

    function pick(target) {
      const item = target?.closest('[data-node], [data-edge], [data-edge-hit]');
      if (!item) return null;
      return item.dataset.node ? { node: item.dataset.node } : { edge: item.dataset.edge || item.dataset.edgeHit };
    }

    host.addEventListener('pointerover', (event) => {
      if (event.pointerType === 'touch') return;
      hovered = pick(event.target);
      updateGraph();
    });
    host.addEventListener('pointerout', (event) => {
      if (event.pointerType === 'touch') return;
      hovered = pick(event.relatedTarget instanceof Element ? event.relatedTarget : null);
      updateGraph();
    });
    host.addEventListener('focusin', (event) => {
      focused = pick(event.target);
      updateGraph();
    });
    host.addEventListener('focusout', (event) => {
      focused = pick(event.relatedTarget instanceof Element ? event.relatedTarget : null);
      updateGraph();
    });
    host.addEventListener('keydown', (event) => {
      const item = pick(event.target);
      if (item && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        hovered = null;
        pinned = item;
        updateGraph();
      }
    });
    host.addEventListener('click', (event) => {
      const { action, excerpt } = event.target.closest('button')?.dataset || {};
      if (action === 'gallery') window.EchoPaperSite?.openGallery?.('graph');
      if (action === 'reading') {
        window.EchoPaperSite?.jumpToReading?.('side', excerpt || null);
      }
      const item = pick(event.target);
      if (item) {
        pinned = item;
        updateGraph();
      }
    });

    const observer = window.ResizeObserver ? new ResizeObserver(renderCanvas) : null;
    if (!observer) window.addEventListener('resize', renderCanvas);

    return () => {
      if (canvas) observer?.unobserve(canvas);
      const active = document.activeElement;
      const key = host.contains(active) && Object.entries(active.dataset).find(([name]) => ['action', 'node', 'edge'].includes(name));
      width = 0;
      renderedEvidence = '';
      hovered = null;
      host.innerHTML = `
        <div class="epwg-toolbar">
          <span class="epwg-demo-label">${t('合成课题 · 稀疏路由', 'Synthetic topic · Sparse routing')}</span>
          ${gallery()}
        </div>
        <div class="epwg-graph-layout">
          <div class="epwg-canvas"></div>
          <aside class="epwg-evidence">
            <h3>${t('原文证据与实验对照', 'Source evidence & experiments')}</h3>
            <div class="epwg-evidence-body" aria-live="polite"></div>
            <button type="button" class="epwg-button epwg-reading" data-action="reading"><span>${t('打开双语阅读区', 'Open bilingual reader')}</span>${arrow}</button>
          </aside>
        </div>`;
      canvas = host.querySelector('.epwg-canvas');
      renderCanvas();
      observer?.observe(canvas);
      if (key) host.querySelector(`[data-${key[0]}="${key[1]}"]`)?.focus({ preventScroll: true });
    };
  }

  function mount() {
    const writing = document.querySelector('#demo-writing');
    const graph = document.querySelector('#demo-graph');
    const site = window.EchoPaperSite;
    lang = site?.getLang?.() || 'zh';
    const renderers = [];
    if (writing && !writing.classList.contains('epwg')) renderers.push(initWriting(writing));
    if (graph && !graph.classList.contains('epwg')) renderers.push(initGraph(graph));
    const render = () => renderers.forEach((update) => update());
    render();
    if (renderers.length) site?.onLangChange?.((next) => {
      lang = typeof next === 'string' ? next : site?.getLang?.() || 'zh';
      render();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
