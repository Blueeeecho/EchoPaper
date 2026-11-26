(() => {
  'use strict';

  const strings = {
    zh: {
      workflow: ['拖入 PDF', '自动 OCR 解析', '本地 SHA-256 缓存', '五种版面任切'],
      search: '试搜「支持块排第七」',
      searchLabel: '中文搜英文体验：支持块排第七',
      hit: '中文译文命中 · 第 2 页',
      modes: ['原版对照', '左右逐段', '上下逐段', '仅译文', '仅原文', '多源划词翻译'],
      modeGroup: '阅读与翻译模式',
      play: '自动演示', pause: '暂停',
      gallery: '查看真实软件截图',
      document: '论文阅读区',
      lab: 'RESEARCH LAB', study: '合成示例',
      source: '原文', translation: '译文',
      divider: '调节原文和译文的宽度',
      ratio: (left) => '原文 ' + left + '%，译文 ' + (100 - left) + '%',
      zoomOut: '缩小', zoomIn: '放大',
      returnPage: '回到原版第 2 页',
      selection: '多源划词翻译',
      providerOne: '（硅基流动 · 免费）', providerTwo: '（演示译文）',
      save: '存为摘录 (p.2)', saved: '✓ 已存入阅读笔记 (p.2)',
      notes: '阅读笔记',
      polish: 'NoteAssistant 整理润色', hidePolish: '收起润色对比',
      before: '润色前', after: '润色后',
    },
    en: {
      workflow: ['Drop in a PDF', 'Auto OCR', 'Local SHA-256 cache', 'Switch layouts'],
      search: 'Try “支持块排第七”',
      searchLabel: 'Search English with a Chinese query: 支持块排第七',
      hit: 'Chinese translation match · Page 2',
      modes: ['PDF + translation', 'Side by side', 'Stacked', 'Translation only', 'Original only', 'Selection translation'],
      modeGroup: 'Reading and translation modes',
      play: 'Auto demo', pause: 'Pause',
      gallery: 'View real software screenshots',
      document: 'Paper reader',
      lab: 'RESEARCH LAB', study: 'Synthetic demo',
      source: 'Original', translation: 'Translation',
      divider: 'Resize the original and translation panes',
      ratio: (left) => 'Original ' + left + '%, translation ' + (100 - left) + '%',
      zoomOut: 'Zoom out', zoomIn: 'Zoom in',
      returnPage: 'Return to original page 2',
      selection: 'Selection translation',
      providerOne: '(SiliconFlow · Free)', providerTwo: '(Demo translation)',
      save: 'Save excerpt (p.2)', saved: '✓ Saved to reading notes (p.2)',
      notes: 'Reading notes',
      polish: 'Polish with NoteAssistant', hidePolish: 'Hide comparison',
      before: 'Before', after: 'After',
    },
  };

  const modes = ['page', 'columns', 'stacked', 'zh', 'en', 'selection'];
  const aliases = new Map([
    ['original', 'page'], ['original-bilingual', 'page'], ['pdf', 'page'],
    ['side', 'columns'], ['side-by-side', 'columns'], ['parallel', 'columns'],
    ['translation-only', 'zh'], ['zh-only', 'zh'], ['translation', 'zh'],
    ['original-only', 'en'], ['en-only', 'en'], ['source', 'en'],
    ['selection-translate', 'selection'], ['selection-translation', 'selection'],
    ['multi-source', 'selection'], ['translate', 'selection'],
  ]);

  const selectedText = 'The support ranks seventh in the local list. Recording the selected block identifiers reveals the loss directly.';
  const hunyuan = '在局部排序中，支持证据块位列第七。记录入选块的编号即可直接看出哪一块被漏掉。';
  const deepl = '支持块在局部候选列表中排名第七。记录所选块的标识符，就能直接发现这次遗漏。';
  const polished = '支持证据块在局部候选中位列第七，超出了剩余六个名额。核对入选块编号即可定位这次遗漏。';

  // Adapted from the site's synthetic SparseRoute paper. The formula is
  // repeated beside the worked example so readers can inspect both together.
  const passages = [
    {
      id: 'observations',
      en: ['Matched observations', 'Table 1 gives a worked example with 100 synthetic queries per condition. At low interference the anchor rule recovers support in twelve more pairs. At high interference it gives up three successes relative to local routing.'],
      zh: ['配对观测', '表 1 展示每种条件下 100 组配对的合成查询。干扰较低时，锚点规则多找回 12 组查询的支持块；干扰较高时，相比局部路由少找回 3 组。'],
    },
    {
      id: 'reversal',
      en: ['Inspecting one reversal', 'In pair 37, two remote decoys match the query prefix. Reserving both anchors for those decoys leaves only six local slots.'],
      zh: ['检查一次结果反转', '第 37 组查询中，两个远端干扰块与查询前缀匹配。两者占用了全部锚点，只留下六个局部名额。'],
    },
    {
      id: 'boundary',
      en: ['Boundary and replication', 'The ledger illustrates a budget trade-off. Its counts describe a constructed example. Generalization to natural documents requires a separately labeled support set.'],
      zh: ['适用边界与复现', '这组记录展示了固定预算下的取舍。计数来自构造示例。若要验证能否推广到自然文档，还需一套独立标注的支持证据。'],
    },
  ];

  const formula = `<div class="epr-formula" data-piece="formula">
    <math display="block">
      <msub><mi>R</mi><mi>k</mi></msub><mo>=</mo>
      <mfrac><mn>1</mn><mi>N</mi></mfrac>
      <munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>N</mi></munderover>
      <mn mathvariant="bold">1</mn><mo>{</mo><msub><mi>b</mi><mi>i</mi></msub><mo>∈</mo>
      <msub><mi>S</mi><mi>k</mi></msub><mo>(</mo><msub><mi>q</mi><mi>i</mi></msub><mo>)</mo><mo>}</mo>
    </math>
  </div>`;

  function evidenceTable(language) {
    const zh = language === 'zh';
    return `<figure class="epr-table" data-piece="table-${language}" lang="${zh ? 'zh-CN' : 'en'}">
    <table>
      <caption>${zh ? '<strong>表 1.</strong> 支持块命中数（每种条件 100 组）' : '<strong>Table 1.</strong> Support hits (100 pairs per condition)'}</caption>
      <thead><tr><th scope="col">${zh ? '干扰' : 'Interference'}</th><th scope="col">${zh ? '密集' : 'Dense'}</th><th scope="col">${zh ? '局部' : 'Local'}</th><th scope="col">${zh ? '锚点' : 'Anchored'}</th></tr></thead>
      <tbody><tr><th scope="row">${zh ? '低' : 'Low'}</th><td>100</td><td>72</td><td>84</td></tr>
      <tr><th scope="row">${zh ? '高' : 'High'}</th><td>100</td><td>66</td><td>63</td></tr></tbody>
    </table>
  </figure>`;
  }

  function mount() {
    const root = document.getElementById('demo-reading');
    if (!root || root.classList.contains('epr')) return;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let labels = strings.zh;
    let mode = 'page';
    let split = 50;
    const zoom = { en: 100, zh: 112 };
    let auto = !motion.matches;
    let inView = false;
    let timer;
    let dragPointer = null;
    let saved = false;
    let polishedOpen = false;
    let queryHit = false;
    let jumpFrame;
    let bridgeRegistered = false;

    root.classList.add('epr');
    root.innerHTML = `<div class="epr-flow">
      <ol class="epr-workflow"></ol>
      <div class="epr-search-group">
        <button type="button" class="epr-search" data-act="search"></button>
        <span class="epr-search-result" role="status" hidden></span>
      </div>
    </div>
    <div class="epr-controls">
      <div class="epr-modes" role="group">${modes.map((item) =>
        '<button type="button" data-set-mode="' + item + '" aria-controls="epr-viewport" aria-pressed="false"></button>'
      ).join('')}</div>
      <button type="button" class="epr-auto" data-act="auto" aria-pressed="false"><span></span></button>
    </div>
    <div class="epr-progress" aria-hidden="true"><div></div></div>
    <div class="epr-window">
      <div class="epr-document-bar">
        <div class="epr-imprint"><strong></strong><span></span></div>
        <span class="epr-folio">p. 02</span>
      </div>
      <div class="epr-instruments" hidden>
        <div class="epr-instrument" data-pane="en">
          <button type="button" data-zoom="en" data-step="-12">−</button>
          <span><span class="epr-scale"></span><span class="epr-ratio"></span></span>
          <button type="button" data-zoom="en" data-step="12">+</button>
        </div>
        <div class="epr-divider" role="separator" aria-orientation="vertical" tabindex="0"
             aria-controls="epr-viewport"></div>
        <div class="epr-instrument" data-pane="zh">
          <button type="button" data-zoom="zh" data-step="-12">−</button>
          <span><span class="epr-scale"></span><span class="epr-ratio"></span></span>
          <button type="button" data-zoom="zh" data-step="12">+</button>
        </div>
      </div>
      <div class="epr-viewport" id="epr-viewport" role="region" tabindex="0"></div>
    </div>
    <div class="epr-footer"><button type="button" data-act="gallery"><span></span> <span aria-hidden="true">↗</span></button></div>`;

    const find = (selector) => root.querySelector(selector);
    const viewport = find('.epr-viewport');
    const instruments = find('.epr-instruments');
    const divider = find('.epr-divider');
    const autoButton = find('.epr-auto');
    const progress = find('.epr-progress');
    const result = find('.epr-search-result');
    const modeButtons = [...root.querySelectorAll('[data-set-mode]')];
    const zoomButtons = [...root.querySelectorAll('[data-zoom]')];
    const bounds = () => instruments.clientWidth < 480 ? [41, 59] : [33, 67];

    function passage(item, language, excerpt = false) {
      const [heading, body] = item[language];
      const sentence = language === 'en' ? selectedText : hunyuan;
      const hit = item.id === 'reversal'
        ? `<mark class="epr-sentence" data-sentence="reversal">${sentence}</mark>`
        : '';
      const pageLink = mode === 'en'
        ? `<button class="epr-page-link" type="button" data-return="${item.id}" aria-label="${labels.returnPage}">p.2</button>`
        : '';
      return `<section class="epr-passage epr-${language}" lang="${language === 'en' ? 'en' : 'zh-CN'}"
        data-piece="${item.id}-${language}" data-passage="${item.id}">
        <div class="epr-passage-heading"><h3>${heading}</h3>${pageLink}</div>
        <p>${excerpt ? hit : body + (hit ? ' ' + hit : '')}</p>
      </section>`;
    }

    function renderNote() {
      const container = find('.epr-notes');
      if (!container) return;
      container.hidden = !saved;
      container.innerHTML = saved ? `
        <article class="epr-note">
          <header><strong>${labels.notes}</strong><button type="button" class="epr-page-link" data-return="reversal" aria-label="${labels.returnPage}">p.2</button></header>
          <p lang="en">${selectedText}</p>
          <button type="button" class="epr-polish" data-act="polish" aria-expanded="${polishedOpen}"
                  aria-controls="epr-comparison">${polishedOpen ? labels.hidePolish : labels.polish}</button>
          <div id="epr-comparison" class="epr-comparison" ${polishedOpen ? '' : 'hidden'}>
            <div><span>${labels.before}</span><p lang="zh-CN">${hunyuan}</p></div>
            <div><span>${labels.after}</span><p lang="zh-CN">${polished}</p></div>
          </div>
        </article>` : '';
      const saveButton = find('[data-act="save"]');
      saveButton.textContent = saved ? labels.saved : labels.save;
      saveButton.setAttribute('aria-disabled', String(saved));
    }

    function paperLayout() {
      const [overview, reversal, boundary] = passages;
      if (mode === 'page') return `<div class="epr-page-pair">
        <article class="epr-original-page" lang="en">
          <div class="epr-pdf-columns">
            <div>${passage(overview, 'en')}${formula}${evidenceTable('en')}</div>
            <div>${passage(reversal, 'en')}${passage(boundary, 'en')}</div>
          </div>
        </article>
        <article class="epr-translated-page" lang="zh-CN">
          ${passage(overview, 'zh')}${formula}${evidenceTable('zh')}
          ${passage(reversal, 'zh')}${passage(boundary, 'zh')}
        </article>
      </div>`;
      if (mode === 'selection') return `<div class="epr-selection-layout">
        <article class="epr-selected-original" lang="en">
          ${passage(reversal, 'en', true)}
        </article>
        <aside class="epr-selection-panel" aria-label="${labels.selection}">
          <div class="epr-popup">
            <header><strong>${labels.selection}</strong><span class="epr-folio">p. 02</span></header>
            <article class="epr-provider">
              <h4>Hunyuan-MT-7B <span>${labels.providerOne}</span></h4><p lang="zh-CN">${hunyuan}</p>
            </article>
            <article class="epr-provider">
              <h4>DeepL <span>${labels.providerTwo}</span></h4><p lang="zh-CN">${deepl}</p>
            </article>
            <button type="button" class="epr-save" data-act="save"></button>
          </div>
          <div class="epr-notes" hidden></div>
        </aside>
        <article class="epr-selection-rest" lang="en">
          ${passage(overview, 'en')}${formula}${evidenceTable('en')}${passage(boundary, 'en')}
        </article>
      </div>`;
      return `<article class="epr-reflow">${passages.map((item, index) => `
        <div class="epr-row">
          ${mode === 'zh' ? '' : passage(item, 'en')}
          ${mode === 'en' ? '' : passage(item, 'zh')}
        </div>${index === 0 ? formula + evidenceTable(mode === 'zh' || (mode !== 'en' && labels === strings.zh) ? 'zh' : 'en') : ''}
      `).join('')}</article>`;
    }

    function renderSplit() {
      const [min, max] = bounds();
      const current = Math.max(min, Math.min(max, split));
      root.style.setProperty('--epr-split', current + '%');
      root.style.setProperty('--epr-source-size', zoom.en / 100 + 'em');
      root.style.setProperty('--epr-translation-size', zoom.zh / 100 + 'em');
      divider.setAttribute('aria-valuemin', min);
      divider.setAttribute('aria-valuemax', max);
      divider.setAttribute('aria-valuenow', current);
      divider.setAttribute('aria-valuetext', labels.ratio(current));
      for (const [key, label, ratio] of [['en', labels.source, current], ['zh', labels.translation, 100 - current]]) {
        const instrument = find('[data-pane="' + key + '"]');
        instrument.querySelector('.epr-scale').textContent =
          label + ' ' + (mode === 'page' ? zoom[key] : ratio) + '%';
        const ratioLabel = instrument.querySelector('.epr-ratio');
        ratioLabel.hidden = mode !== 'page';
        ratioLabel.textContent = ratio + '%';
      }
      for (const button of zoomButtons) {
        const key = button.dataset.zoom;
        const decrease = Number(button.dataset.step) < 0;
        const side = key === 'en' ? labels.source : labels.translation;
        button.hidden = mode !== 'page';
        button.setAttribute('aria-label', side + ' · ' + (decrease ? labels.zoomOut : labels.zoomIn));
        button.setAttribute('aria-disabled', String(decrease ? zoom[key] <= 76 : zoom[key] >= 148));
      }
      instruments.dataset.ratio = current + ' / ' + (100 - current);
    }

    function renderHit() {
      result.hidden = !queryHit;
      result.textContent = queryHit ? labels.hit : '';
      viewport.classList.toggle('epr-is-hit', queryHit);
    }

    function renderPaper() {
      root.dataset.readingMode = mode;
      modeButtons.forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.setMode === mode));
      });
      instruments.hidden = mode !== 'page' && mode !== 'columns';
      viewport.innerHTML = paperLayout();
      renderSplit();
      renderHit();
      renderNote();
    }

    function renderAuto() {
      const running = auto && inView && !document.hidden && !motion.matches;
      autoButton.setAttribute('aria-pressed', String(auto && !motion.matches));
      autoButton.querySelector('span').textContent = auto && !motion.matches ? labels.pause : labels.play;
      autoButton.disabled = motion.matches;
      progress.classList.toggle('epr-running', running);
    }

    function renderLang(value = window.EchoPaperSite?.getLang?.() || 'zh') {
      const lang = /^en(?:[-_]|$)/i.test(value) ? 'en' : 'zh';
      labels = strings[lang];
      root.lang = lang === 'en' ? 'en' : 'zh-CN';
      find('.epr-workflow').innerHTML = labels.workflow.map((step) => '<li>' + step + '</li>').join('');
      find('.epr-search').textContent = labels.search;
      find('.epr-search').setAttribute('aria-label', labels.searchLabel);
      find('.epr-modes').setAttribute('aria-label', labels.modeGroup);
      modeButtons.forEach((button, index) => { button.textContent = labels.modes[index]; });
      find('.epr-imprint strong').textContent = labels.lab;
      find('.epr-imprint span').textContent = labels.study;
      find('.epr-footer button span').textContent = labels.gallery;
      viewport.setAttribute('aria-label', labels.document);
      divider.setAttribute('aria-label', labels.divider);
      const previousScroll = viewport.scrollTop;
      renderPaper();
      viewport.scrollTop = previousScroll;
      renderAuto();
    }

    function animatePaper(previous, oldMode, removed) {
      if (motion.matches || typeof viewport.animate !== 'function') return;
      const visible = viewport.getBoundingClientRect();
      for (const [piece, rect] of removed) {
        if (rect.bottom < visible.top || rect.top > visible.bottom) continue;
        const ghost = piece.cloneNode(true);
        ghost.inert = true;
        ghost.setAttribute('aria-hidden', 'true');
        ghost.classList.add('epr-fold');
        Object.assign(ghost.style, {
          left: rect.left - visible.left + 'px',
          top: rect.top - visible.top + 'px',
          width: rect.width + 'px',
        });
        viewport.append(ghost);
        ghost.animate([
          { opacity: .6, clipPath: 'inset(0 0 0 0)', transform: 'none' },
          { opacity: 0, clipPath: 'inset(0 0 92% 0)', transform: 'translateY(-5px)' },
        ], { duration: 190, easing: 'ease-in' }).finished.then(() => ghost.remove(), () => ghost.remove());
      }
      for (const piece of viewport.querySelectorAll('[data-piece]:not(.epr-fold)')) {
        const then = previous.get(piece.dataset.piece);
        const now = piece.getBoundingClientRect();
        if (now.bottom < visible.top || now.top > visible.bottom) continue;
        const canMove = then && then.bottom > visible.top && then.top < visible.bottom;
        const x = canMove ? then.left - now.left : 0;
        const y = canMove ? then.top - now.top : 14;
        piece.animate([
          { opacity: canMove ? 0.75 : 0, transform: 'translate(' + x + 'px,' + y + 'px)' },
          { opacity: 1, transform: 'none' },
        ], { duration: oldMode === 'selection' ? 340 : 420, easing: 'cubic-bezier(.2,.72,.22,1)' });
      }
    }

    function setMode(next, { hit = false, replay = false } = {}) {
      cancelAnimationFrame(jumpFrame);
      const previous = new Map();
      const removed = [];
      const foldedLanguage = next === 'zh' ? 'en' : next === 'en' ? 'zh' : '';
      for (const piece of viewport.querySelectorAll('[data-piece]:not(.epr-fold)')) {
        const rect = piece.getBoundingClientRect();
        if (!previous.has(piece.dataset.piece)) previous.set(piece.dataset.piece, rect);
        if (foldedLanguage && piece.classList.contains('epr-' + foldedLanguage)) removed.push([piece, rect]);
      }
      const oldMode = mode;
      mode = next;
      queryHit = hit;
      if (oldMode === mode && !replay) {
        renderHit();
        return;
      }
      renderPaper();
      viewport.scrollTop = 0;
      animatePaper(previous, oldMode, removed);
    }

    function syncAuto() {
      clearTimeout(timer);
      progress.classList.remove('epr-running');
      // Restart the bar together with the cycle after an explicit resume.
      void progress.offsetWidth;
      renderAuto();
      if (!auto || !inView || document.hidden || motion.matches) return;
      timer = setTimeout(() => {
        setMode(modes[(modes.indexOf(mode) + 1) % modes.length]);
        syncAuto();
      }, 5000);
    }

    function pause() {
      if (!auto) return;
      auto = false;
      syncAuto();
    }

    function jumpToReading(target = 'reversal', returnToSection = false) {
      cancelAnimationFrame(jumpFrame);
      const behavior = motion.matches ? 'instant' : 'smooth';
      if (returnToSection) {
        const box = root.getBoundingClientRect();
        if (box.top < 0 || box.top > window.innerHeight - 200) root.scrollIntoView({ behavior, block: 'start' });
      }
      jumpFrame = requestAnimationFrame(() => {
        const matches = [...viewport.querySelectorAll(`.epr-passage[data-passage="${target}"]:not(.epr-fold)`)];
        if (!matches.length) return;
        let top = -18;
        for (let node = matches[0]; node && node !== viewport; node = node.offsetParent) {
          top += node.offsetTop;
        }
        viewport.scrollTo({ top: Math.max(0, top), behavior });
        for (const piece of matches) {
          const mark = piece.querySelector('[data-sentence]') || piece.querySelector('p') || piece;
          mark.classList.remove('epr-pulse');
          void mark.offsetWidth;
          mark.classList.add('epr-pulse');
        }
      });
    }

    function handleClick(event) {
      const button = event.target.closest('button');
      if (!button || !root.contains(button)) return;
      if (button.dataset.act === 'auto') {
        auto = !auto;
        syncAuto();
        return;
      }
      pause();
      if (button.dataset.setMode) {
        setMode(button.dataset.setMode, { replay: button.dataset.setMode === 'selection' });
      } else if (button.dataset.return) {
        const target = button.dataset.return;
        setMode('page');
        modeButtons[0].focus({ preventScroll: true });
        jumpToReading(target);
      } else if (button.dataset.zoom && button.getAttribute('aria-disabled') !== 'true') {
        const pane = button.dataset.zoom;
        zoom[pane] = Math.min(148, Math.max(76, zoom[pane] + Number(button.dataset.step)));
        renderSplit();
      } else if (button.dataset.act === 'search') {
        setMode('columns', { hit: true });
        jumpToReading();
      } else if (button.dataset.act === 'gallery') {
        window.EchoPaperSite?.openGallery?.(mode === 'selection' ? 'reading-selection-translate' : 'reading-original-bilingual');
      } else if (button.dataset.act === 'save' && !saved) {
        saved = true;
        renderNote();
        find('.epr-notes').scrollIntoView({ block: 'nearest', behavior: motion.matches ? 'instant' : 'smooth' });
      } else if (button.dataset.act === 'polish') {
        polishedOpen = !polishedOpen;
        renderNote();
        find('[data-act="polish"]').focus({ preventScroll: true });
        if (polishedOpen) find('.epr-comparison').scrollIntoView({ block: 'nearest', behavior: motion.matches ? 'instant' : 'smooth' });
      }
    }

    function resizeFromPointer(event) {
      const rect = instruments.getBoundingClientRect();
      const [min, max] = bounds();
      split = Math.max(min, Math.min(max, Math.round(100 * (event.clientX - rect.left) / rect.width)));
      renderSplit();
    }

    divider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || dragPointer !== null) return;
      event.preventDefault();
      pause();
      dragPointer = event.pointerId;
      divider.focus({ preventScroll: true });
      divider.setPointerCapture(dragPointer);
      root.classList.add('epr-dragging');
    });
    divider.addEventListener('pointermove', (event) => {
      if (event.pointerId === dragPointer) resizeFromPointer(event);
    });
    divider.addEventListener('lostpointercapture', () => {
      dragPointer = null;
      root.classList.remove('epr-dragging');
    });
    divider.addEventListener('keydown', (event) => {
      const [min, max] = bounds();
      const current = Math.max(min, Math.min(max, split));
      const positions = { ArrowLeft: current - 3, ArrowRight: current + 3, Home: min, End: max };
      if (!Object.hasOwn(positions, event.key)) return;
      event.preventDefault();
      pause();
      split = Math.max(min, Math.min(max, positions[event.key]));
      renderSplit();
    });

    window.addEventListener('echopaper:reading-mode', (event) => {
      const detail = event.detail;
      const requested = typeof detail === 'string' ? detail : detail?.mode;
      const key = typeof requested === 'string' ? requested.toLowerCase().replace(/^reading-/, '') : '';
      const next = modes.includes(key) ? key : aliases.get(key) || 'columns';
      const wanted = detail?.targetId ?? detail?.target ?? detail?.sentence;
      const target = passages.find((item) => item.id === wanted || item.en[0] === wanted)?.id || 'reversal';
      pause();
      setMode(next);
      if (detail?.focusExcerpt !== false) jumpToReading(target, !detail?.sectionScrolled);
    });

    root.addEventListener('click', handleClick);
    root.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'touch') pause();
    });
    root.addEventListener('pointerdown', (event) => {
      if (!autoButton.contains(event.target)) pause();
    });
    root.addEventListener('focusin', (event) => {
      if (!autoButton.contains(event.target)) pause();
    });
    root.addEventListener('pointerup', () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();
      const anchorNode = selection?.anchorNode;
      const focusNode = selection?.focusNode;
      const anchor = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
      const focus = focusNode instanceof Element ? focusNode : focusNode?.parentElement;
      const sentence = anchor?.closest('.epr-en [data-sentence]');
      if (mode === 'selection' || !text || !sentence || !root.contains(sentence) ||
          !sentence.contains(focus) || !selectedText.includes(text)) return;
      pause();
      selection.removeAllRanges();
      setMode('selection');
    });

    new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting && entry.intersectionRatio >= 0.34;
      if (inView) root.classList.add('epr-in-view');
      syncAuto();
    }, { threshold: [0, 0.34] }).observe(root);
    new ResizeObserver(() => {
      if (!instruments.hidden) renderSplit();
    }).observe(instruments);
    document.addEventListener('visibilitychange', syncAuto);
    motion.addEventListener('change', () => {
      if (motion.matches) auto = false;
      syncAuto();
    });

    function connectSite() {
      if (bridgeRegistered) return;
      renderLang();
      if (typeof window.EchoPaperSite?.onLangChange === 'function') {
        window.EchoPaperSite?.onLangChange?.(renderLang);
        bridgeRegistered = true;
      }
    }
    connectSite();
    if (!bridgeRegistered && document.readyState !== 'complete') {
      window.addEventListener('load', connectSite, { once: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
