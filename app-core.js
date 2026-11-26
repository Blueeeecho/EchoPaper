(() => {
  "use strict";

  const root = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const languageButtons = [...document.querySelectorAll(".site-lang [data-language]")];
  const languageListeners = new Set();
  const languageKey = "echopaper-site-language";
  let language = "zh";
  try {
    if (localStorage.getItem(languageKey) === "en") language = "en";
  } catch {
    // Language switching also works when storage is unavailable.
  }

  // Capture the static bilingual dictionary before deferred demos inject their own copy.
  const translations = [
    ...[...document.querySelectorAll("[data-en]")].map(node => ({
      zh: node.textContent, en: node.dataset.en, apply: value => { node.textContent = value; },
    })),
    ...[["aria-label", "aria"], ["content", "content"]].flatMap(([attribute, key]) =>
      [...document.querySelectorAll(`[data-en-${key}]`)].map(node => ({
        zh: node.getAttribute(attribute),
        en: node.getAttribute(`data-en-${key}`),
        apply: value => node.setAttribute(attribute, value),
      })),
    ),
  ];

  function updateLanguage(next, persist = false) {
    const changed = next !== language;
    language = next;
    root.lang = next === "en" ? "en" : "zh-CN";
    for (const entry of translations) entry.apply(entry[next]);
    for (const button of languageButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.language === next));
    }
    if (persist) {
      try {
        localStorage.setItem(languageKey, next);
      } catch {
        // A blocked store only affects persistence across reloads.
      }
    }
    if (changed) {
      for (const listener of [...languageListeners]) {
        try {
          listener(next);
        } catch (error) {
          console.error("EchoPaper language listener failed", error);
        }
      }
    }
  }

  function onLangChange(callback) {
    if (typeof callback !== "function") throw new TypeError("Expected a language callback");
    languageListeners.add(callback);
    return () => languageListeners.delete(callback);
  }

  function jumpToReading(modeKey, targetId) {
    const section = document.getElementById("reading");
    if (!section) return;
    if (location.hash !== "#reading") history.pushState(null, "", "#reading");
    section.focus({ preventScroll: true });
    section.scrollIntoView({ behavior: reduceMotion.matches ? "instant" : "smooth", block: "start" });
    (document.getElementById("demo-reading") || section).dispatchEvent(new CustomEvent("echopaper:reading-mode", {
      bubbles: true,
      detail: { mode: modeKey, targetId, focusExcerpt: targetId !== null, sectionScrolled: true },
    }));
  }

  // The modules can call the shared API as soon as their deferred scripts execute.
  window.EchoPaperSite = Object.freeze({ getLang: () => language, onLangChange, jumpToReading, openGallery });
  for (const button of languageButtons) {
    button.addEventListener("click", () => updateLanguage(button.dataset.language, true));
  }
  updateLanguage(language);

  const ui = {
    pause: { zh: "暂停", en: "Pause" },
    play: { zh: "播放", en: "Play" },
    pauseDemo: { zh: "暂停演示", en: "Pause demo" },
    playDemo: { zh: "播放演示", en: "Play demo" },
    copied: { zh: "已复制到剪贴板", en: "Copied to clipboard" },
    copyFailed: { zh: "无法自动复制，请手动选择并复制。", en: "Automatic copy failed. Select the text and copy it manually." },
    loading: { zh: "正在加载原图…", en: "Loading full-size image…" },
    imageFailed: { zh: "原图加载失败。可切换图片，或关闭后重试。", en: "The image failed to load. Switch images, or close and try again." },
    actualSize: { zh: "按原尺寸查看", en: "Actual size" },
    fitImage: { zh: "适应窗口", en: "Fit to window" },
  };
  const phrase = key => ui[key][language];

  const navLinks = [...document.querySelectorAll(".site-nav a[href^='#']")];
  const navSections = navLinks.map(link => document.querySelector(link.hash));
  const header = document.querySelector(".site-header");

  function updateNavigation() {
    const readingLine = Math.max(header.getBoundingClientRect().bottom + 1, window.innerHeight * .35);
    const active = navSections.findLastIndex(section => section.getBoundingClientRect().top <= readingLine);
    navLinks.forEach((link, index) => {
      if (index === active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }

  let sectionObserver;
  function observeNavigation() {
    sectionObserver?.disconnect();
    if ("IntersectionObserver" in window) {
      const bottom = Math.round(window.innerHeight * .65);
      const top = Math.min(Math.ceil(header.getBoundingClientRect().bottom), window.innerHeight - bottom - 1);
      sectionObserver = new IntersectionObserver(updateNavigation, { rootMargin: `-${Math.max(0, top)}px 0px -${bottom}px 0px` });
      navSections.forEach(section => sectionObserver.observe(section));
    }
    updateNavigation();
  }
  observeNavigation();
  window.addEventListener("resize", observeNavigation);
  if (!("IntersectionObserver" in window)) window.addEventListener("scroll", updateNavigation, { passive: true });

  const stage = document.getElementById("hero-stage");
  const playButton = document.getElementById("hero-play");
  const scenes = [...stage.querySelectorAll("[data-scene]")];
  const stepButtons = [...stage.querySelectorAll("[data-step]")];
  const sceneDuration = 4650;
  let sceneIndex = 0;
  let wantsPlayback = !reduceMotion.matches;
  let stageVisible = true;
  let galleryVisible = false;
  let stageHovered = false;
  let timer = null;
  let until = 0;
  let remaining = sceneDuration;

  function updateStagePlayback() {
    const playing = wantsPlayback && !reduceMotion.matches && stageVisible && !document.hidden && !galleryVisible && !stageHovered;
    stage.classList.toggle("is-paused", !playing);
    playButton.hidden = reduceMotion.matches;
    playButton.setAttribute("aria-label", phrase(wantsPlayback ? "pauseDemo" : "playDemo"));
    playButton.querySelector("[data-play-label]").textContent = phrase(wantsPlayback ? "pause" : "play");
    playButton.querySelector("use").setAttribute("href", wantsPlayback ? "#ep-pause" : "#ep-play");
    if (playing && timer === null) {
      stage.classList.add("is-animated");
      until = performance.now() + remaining;
      timer = window.setTimeout(() => {
        timer = null;
        selectScene((sceneIndex + 1) % scenes.length);
      }, remaining);
    } else if (!playing && timer !== null) {
      window.clearTimeout(timer);
      remaining = Math.max(0, until - performance.now());
      timer = null;
    }
  }

  function selectScene(index) {
    window.clearTimeout(timer);
    timer = null;
    remaining = sceneDuration;
    sceneIndex = index;
    stage.classList.remove("is-animated");
    scenes.forEach((scene, current) => {
      scene.hidden = current !== index;
      stepButtons[current].setAttribute("aria-pressed", String(current === index));
    });
    // Commit the visible scene so selecting the current step can replay its animation.
    stage.getBoundingClientRect();
    updateStagePlayback();
  }

  for (const button of stepButtons) {
    button.addEventListener("click", () => {
      wantsPlayback = false;
      selectScene(Number(button.dataset.step));
    });
  }
  stage.addEventListener("pointerenter", event => {
    if (event.pointerType !== "mouse") return;
    stageHovered = true;
    updateStagePlayback();
  });
  stage.addEventListener("pointerleave", () => {
    stageHovered = false;
    updateStagePlayback();
  });
  playButton.addEventListener("click", () => {
    wantsPlayback = !wantsPlayback;
    if (wantsPlayback) stageHovered = false;
    updateStagePlayback();
  });
  document.addEventListener("visibilitychange", updateStagePlayback);
  reduceMotion.addEventListener("change", () => {
    wantsPlayback = !reduceMotion.matches;
    if (reduceMotion.matches) stage.classList.remove("is-animated");
    updateStagePlayback();
  });
  onLangChange(updateStagePlayback);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => {
      stageVisible = entry.isIntersecting;
      updateStagePlayback();
    }, { threshold: .08 }).observe(stage);
  }
  updateStagePlayback();

  const startupTabs = [...document.querySelectorAll(".site-startup-tabs [role='tab']")];
  function selectStartupTab(selected) {
    for (const tab of startupTabs) {
      const active = tab === selected;
      tab.tabIndex = active ? 0 : -1;
      tab.setAttribute("aria-selected", String(active));
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
    }
  }

  for (const [index, tab] of startupTabs.entries()) {
    tab.addEventListener("click", () => selectStartupTab(tab));
    tab.addEventListener("keydown", event => {
      const other = 1 - index;
      const keys = { ArrowLeft: other, ArrowRight: other, Home: 0, End: startupTabs.length - 1 };
      if (!Object.hasOwn(keys, event.key)) return;
      event.preventDefault();
      const next = startupTabs[keys[event.key]];
      selectStartupTab(next);
      next.focus();
    });
  }

  const copyStatus = document.querySelector(".site-copy-status");
  let copyTimer;
  let copyKey;
  function showCopyStatus(key) {
    window.clearTimeout(copyTimer);
    copyKey = key;
    copyStatus.textContent = phrase(key);
    copyTimer = window.setTimeout(() => {
      copyKey = null;
      copyStatus.textContent = "";
    }, 2500);
  }
  onLangChange(() => {
    if (copyKey) copyStatus.textContent = phrase(copyKey);
  });

  function legacyCopy(source) {
    const selection = window.getSelection();
    if (!selection) return false;
    const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
    const target = document.createRange();
    target.selectNodeContents(source);
    selection.removeAllRanges();
    selection.addRange(target);
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }

  document.querySelectorAll("[data-copy]").forEach(button => {
    button.addEventListener("click", async () => {
      const source = document.getElementById(button.dataset.copy);
      if (!source) return;
      try {
        await navigator.clipboard.writeText(source.textContent);
        showCopyStatus("copied");
      } catch {
        showCopyStatus(legacyCopy(source) ? "copied" : "copyFailed");
      }
    });
  });

  const gallery = document.getElementById("site-gallery");
  const galleryFrame = gallery.querySelector(".site-gallery-frame");
  const galleryStatus = gallery.querySelector("[data-gallery-status]");
  const galleryCaption = gallery.querySelector(".site-gallery-caption");
  const galleryCount = gallery.querySelector("[data-gallery-count]");
  const galleryZoom = gallery.querySelector("[data-gallery-zoom]");
  const galleryImages = [
    { key: "overview", zh: "研究总览", en: "Research overview" },
    { key: "reading-original-bilingual", zh: "原文双语阅读", en: "Original PDF with bilingual text" },
    { key: "reading-selection-translate", zh: "多源划词翻译", en: "Selection translation from multiple providers" },
    { key: "topic-graph", zh: "课题知识图谱", en: "Topic knowledge graph" },
    { key: "evidence-ledger", zh: "实验与证据台账", en: "Experiment and evidence ledger" },
    { key: "latex-writing", zh: "LaTeX 写作与 PDF 预览", en: "LaTeX editor and PDF preview" },
    { key: "presentation", zh: "论文汇报", en: "Paper presentation" },
    { key: "ai-latex-diff", zh: "AI 表格差异审阅", en: "AI table diff review" },
    { key: "ai-error-fix", zh: "编译红点与未解析引用", en: "Compile error and unresolved reference" },
    { key: "ocr-setup", zh: "OCR 配置向导", en: "OCR setup wizard" },
    { key: "submission-review", zh: "投稿包独立编译校验", en: "Standalone submission ZIP check" },
  ];
  const galleryAliases = {
    reading: "reading-original-bilingual",
    translation: "reading-selection-translate",
    graph: "topic-graph",
    evidence: "evidence-ledger",
    writing: "latex-writing",
  };
  let galleryIndex = 0;
  let galleryImage;
  let galleryStatusKey;
  let galleryTrigger;
  let galleryActivation;

  const screenCaptions = {
    overview: { zh: "一屏查看当前课题、上次停笔处、今日待办和继续阅读入口。", en: "Find your current topic, last edit, tasks for today and reading queue on one screen." },
    "ai-latex-diff": { zh: "选中表格后打开差异审阅，逐组勾选要写入的增删。", en: "Select a table and review its diff. Choose which groups of additions and deletions to save." },
    "ai-error-fix": { zh: "Tectonic 报错红点、70% PDF 预览中的红色 ??、修复线索与助手入口同屏。", en: "See the Tectonic error dot, red ?? in the PDF at 70%, a repair hint and the assistant action together." },
    "ocr-setup": { zh: "在内置向导中选择 OCR 服务并检测配置。", en: "Choose an OCR provider and check its configuration in the setup wizard." },
    "submission-review": { zh: "在投稿审阅中查看 ZIP 的独立编译结果和文件校验值。", en: "Inspect the submission ZIP’s standalone build result and checksum." },
  };
  const screenTabs = [...document.querySelectorAll("[data-screen]")];
  const screenPanel = document.getElementById("screen-panel");
  const screenPreview = screenPanel.querySelector("img");
  const screenCaption = screenPanel.querySelector("[data-screen-caption]");
  const screenExpand = screenPanel.querySelector("[data-gallery]");
  let activeScreen = screenTabs[0];

  function updateScreenText() {
    const key = activeScreen.dataset.screen;
    screenPreview.alt = galleryImages.find(image => image.key === key)[language];
    screenCaption.textContent = screenCaptions[key][language];
  }

  function selectScreen(tab) {
    if (tab === activeScreen) return;
    activeScreen.setAttribute("aria-selected", "false");
    activeScreen.tabIndex = -1;
    activeScreen = tab;
    tab.setAttribute("aria-selected", "true");
    tab.tabIndex = 0;
    screenPanel.setAttribute("aria-labelledby", tab.id);
    screenExpand.dataset.gallery = tab.dataset.screen;
    screenPreview.classList.remove("is-changing");
    screenPreview.src = `./assets/${tab.dataset.screen}.webp`;
    updateScreenText();
  }

  screenPreview.addEventListener("load", () => screenPreview.classList.add("is-changing"));
  for (const [index, tab] of screenTabs.entries()) {
    tab.addEventListener("click", () => selectScreen(tab));
    tab.addEventListener("keydown", event => {
      const last = screenTabs.length - 1;
      const keys = { ArrowLeft: index === 0 ? last : index - 1, ArrowRight: index === last ? 0 : index + 1, Home: 0, End: last };
      if (!Object.hasOwn(keys, event.key)) return;
      event.preventDefault();
      const next = screenTabs[keys[event.key]];
      selectScreen(next);
      next.focus();
    });
  }
  updateScreenText();
  onLangChange(updateScreenText);

  document.addEventListener("click", event => {
    galleryActivation = event;
  }, { capture: true });

  function updateGalleryText() {
    const label = galleryImages[galleryIndex][language];
    galleryCaption.textContent = label;
    galleryCount.textContent = `${galleryIndex + 1} / ${galleryImages.length}`;
    if (galleryImage) galleryImage.alt = label;
    galleryStatus.textContent = galleryStatusKey ? phrase(galleryStatusKey) : "";
    galleryZoom.textContent = phrase(galleryFrame.classList.contains("is-full-size") ? "fitImage" : "actualSize");
  }

  function setGalleryImage(index) {
    galleryFrame.classList.remove("is-full-size");
    galleryFrame.removeAttribute("tabindex");
    galleryFrame.scrollTo(0, 0);
    galleryZoom.hidden = true;
    galleryZoom.setAttribute("aria-pressed", "false");
    galleryIndex = (index + galleryImages.length) % galleryImages.length;
    galleryImage?.remove();
    const image = new Image(2880, 1800);
    image.decoding = "async";
    image.hidden = true;
    galleryImage = image;
    galleryStatusKey = "loading";
    updateGalleryText();
    image.addEventListener("load", () => {
      if (galleryImage !== image) return;
      image.hidden = false;
      galleryZoom.hidden = false;
      galleryStatusKey = null;
      updateGalleryText();
    }, { once: true });
    image.addEventListener("error", () => {
      if (galleryImage !== image) return;
      galleryStatusKey = "imageFailed";
      updateGalleryText();
    }, { once: true });
    galleryFrame.append(image);
    image.src = `./assets/${galleryImages[galleryIndex].key}-full.webp`;
  }

  // Supports zero-based indices, screenshot stems and the aliases used by the demos.
  function openGallery(indexOrKey = 0) {
    const key = typeof indexOrKey === "string" ? indexOrKey.replace(/(?:-full)?\.webp$|-full$/, "") : "";
    const found = typeof indexOrKey === "number"
      ? indexOrKey
      : galleryImages.findIndex(entry => entry.key === (galleryAliases[key] ?? key));
    const index = Number.isInteger(found) && found >= 0 && found < galleryImages.length ? found : 0;
    if (!gallery.open) {
      // Safari does not focus buttons on pointer activation. Use the dispatch in progress.
      const clicked = galleryActivation?.eventPhase && galleryActivation.target instanceof Element
        ? galleryActivation.target.closest("button, a, [role='button']")
        : null;
      galleryTrigger = clicked || document.activeElement;
      galleryActivation = null;
      gallery.showModal();
      galleryVisible = true;
      updateStagePlayback();
    }
    setGalleryImage(index);
  }

  document.querySelectorAll("[data-gallery]").forEach(button => {
    button.addEventListener("click", () => openGallery(button.dataset.gallery));
  });
  gallery.querySelector("[data-gallery-close]").addEventListener("click", () => gallery.close());
  gallery.querySelector("[data-gallery-prev]").addEventListener("click", () => setGalleryImage(galleryIndex - 1));
  gallery.querySelector("[data-gallery-next]").addEventListener("click", () => setGalleryImage(galleryIndex + 1));
  galleryZoom.addEventListener("click", () => {
    const zoomed = galleryFrame.classList.toggle("is-full-size");
    galleryZoom.setAttribute("aria-pressed", String(zoomed));
    if (zoomed) {
      galleryFrame.tabIndex = 0;
      galleryFrame.scrollTo((galleryFrame.scrollWidth - galleryFrame.clientWidth) / 2, 0);
      galleryFrame.focus({ preventScroll: true });
    } else {
      galleryFrame.removeAttribute("tabindex");
    }
    updateGalleryText();
  });
  gallery.addEventListener("click", event => {
    if (event.target !== gallery) return;
    const bounds = gallery.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) gallery.close();
  });
  gallery.addEventListener("keydown", event => {
    if (galleryFrame.classList.contains("is-full-size") || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    setGalleryImage(galleryIndex + (event.key === "ArrowLeft" ? -1 : 1));
  });
  gallery.addEventListener("close", () => {
    if (gallery.open) return;
    galleryImage?.remove();
    galleryImage = null;
    galleryStatusKey = null;
    galleryStatus.textContent = "";
    galleryVisible = false;
    updateStagePlayback();
    if (galleryTrigger?.isConnected) galleryTrigger.focus({ preventScroll: true });
  });
  onLangChange(() => {
    if (gallery.open) updateGalleryText();
  });
})();
