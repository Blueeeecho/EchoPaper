"use strict";

const root = document.documentElement;
root.classList.add("has-js");

const localizedText = Array.from(document.querySelectorAll("[data-en]"), node => ({
  node, zh: node.textContent, en: node.dataset.en,
}));
const localizedLabels = Array.from(document.querySelectorAll("[data-i18n-aria]"), node => ({
  node, zh: node.getAttribute("aria-label"), en: node.dataset.i18nAria,
}));
const title = { zh: document.title, en: root.dataset.titleEn };
const description = {
  zh: document.querySelector('meta[name="description"]').content,
  en: root.dataset.descriptionEn,
};
const languageButtons = [...document.querySelectorAll("[data-language]")];
const languageKey = "echopaper-site-language";
let language = "zh";

function phrase(zh, en) {
  return language === "en" ? en : zh;
}

function updateLanguage(next) {
  language = next;
  root.lang = phrase("zh-CN", "en");
  localizedText.forEach(entry => { entry.node.textContent = entry[language]; });
  localizedLabels.forEach(entry => { entry.node.setAttribute("aria-label", entry[language]); });
  languageButtons.forEach(button => {
    button.setAttribute("aria-pressed", button.dataset.language === language);
  });
  document.title = title[language];
  document.querySelectorAll('meta[property="og:title"], meta[name="twitter:title"]')
    .forEach(node => { node.content = title[language]; });
  document.querySelectorAll('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]')
    .forEach(node => { node.content = description[language]; });
  document.querySelector('meta[property="og:locale"]').content = phrase("zh_CN", "en_US");
  document.querySelector('meta[property="og:locale:alternate"]').content = phrase("en_US", "zh_CN");
  document.querySelectorAll('meta[property="og:image:alt"], meta[name="twitter:image:alt"]')
    .forEach(node => { node.content = phrase("EchoPaper 本地科研工作台", "EchoPaper, a local workspace for research"); });
  updateMenuLabel();
  copyButtons.forEach(updateCopyLabel);
  if (dialog.open) updateLightboxLabels();
}

const header = document.querySelector(".site-header");
const menu = header.querySelector(".menu-toggle");
const nav = header.querySelector("nav");
function updateMenuLabel() {
  const open = menu.getAttribute("aria-expanded") === "true";
  menu.setAttribute("aria-label", open ? phrase("关闭导航", "Close navigation") : phrase("打开导航", "Open navigation"));
}
function toggleMenu(open) {
  menu.setAttribute("aria-expanded", open);
  header.classList.toggle("is-open", open);
  updateMenuLabel();
}
menu.addEventListener("click", () => toggleMenu(!header.classList.contains("is-open")));
nav.addEventListener("click", event => {
  if (event.target.closest("a")) toggleMenu(false);
});
document.addEventListener("click", event => {
  if (header.classList.contains("is-open") && !header.contains(event.target)) toggleMenu(false);
});
header.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !header.classList.contains("is-open")) return;
  toggleMenu(false);
  menu.focus();
});
matchMedia("(max-width: 960px)").addEventListener("change", () => toggleMenu(false));

const heroImages = ["overview", "reading-original-bilingual", "latex-writing"];
const galleryGroups = {
  hero: heroImages,
  reader: ["reading-original-bilingual", "reading-side-by-side", "reading-stacked", "reading-selection-translate"],
  loop: ["topic-graph", "evidence-ledger", "latex-writing", "presentation"],
};
const heroZoom = document.querySelector(".hero-zoom");
const tabGroups = new Map();

document.querySelectorAll("[data-tabs]").forEach(list => {
  const name = list.dataset.tabs;
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const panels = tabs.map(tab => document.getElementById(tab.getAttribute("aria-controls")));
  let current = 0;
  let slider;

  function positionSlider(animate = false) {
    if (!slider) return;
    const tab = tabs[current];
    slider.classList.toggle("instant", !animate);
    slider.style.setProperty("--slider-x", tab.offsetLeft + "px");
    slider.style.setProperty("--slider-y", tab.offsetTop + "px");
    slider.style.setProperty("--slider-width", tab.offsetWidth + "px");
    slider.style.setProperty("--slider-height", tab.offsetHeight + "px");
  }

  function select(index, focus = false) {
    current = index;
    tabs.forEach((tab, i) => {
      const active = i === current;
      tab.setAttribute("aria-selected", active);
      tab.tabIndex = active ? 0 : -1;
      panels[i].inert = !active;
    });
    positionSlider(true);
    if (name === "hero") heroZoom.dataset.showImage = heroImages[current];
    if (focus) tabs[current].focus({ preventScroll: true });
  }

  if (list.classList.contains("segments")) {
    slider = document.createElement("span");
    slider.className = "slider";
    slider.setAttribute("aria-hidden", "true");
    list.prepend(slider);
    positionSlider();
    list.classList.add("has-slider");
    const observer = new ResizeObserver(() => positionSlider());
    tabs.forEach(tab => observer.observe(tab));
  }
  tabGroups.set(name, select);
  tabs.forEach((tab, i) => tab.addEventListener("click", () => select(i)));
  list.addEventListener("keydown", event => {
    if (!tabs.includes(event.target)) return;
    const rowSize = tabs.filter(tab => tab.offsetTop === tabs[0].offsetTop).length;
    const shift = { ArrowRight: 1, ArrowLeft: -1 };
    if (rowSize < tabs.length) {
      shift.ArrowDown = rowSize;
      shift.ArrowUp = -rowSize;
    }
    let next;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else if (event.key in shift) next = (current + shift[event.key] + tabs.length) % tabs.length;
    else return;
    event.preventDefault();
    select(next, true);
  });
});
document.querySelectorAll("[data-step]").forEach(button => {
  button.addEventListener("click", () => {
    tabGroups.get("loop")(Number(button.dataset.step), true);
    document.querySelector('[data-tabs="loop"]').scrollIntoView({ block: "nearest" });
  });
});
const excerpt = document.getElementById("pair-37-excerpt");
const excerptHash = "#" + excerpt.id;
function showExcerpt(focus = false) {
  tabGroups.get("reader")(1);
  if (focus) excerpt.focus({ preventScroll: true });
  excerpt.scrollIntoView({ block: "start" });
}
document.querySelector("[data-return-to-reading]").addEventListener("click", event => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (location.hash !== excerptHash) history.pushState(null, "", excerptHash);
  showExcerpt(true);
});
window.addEventListener("hashchange", () => {
  if (location.hash === excerptHash) showExcerpt();
});
if (location.hash === excerptHash) showExcerpt();

const sectionLinks = [...nav.querySelectorAll('.nav-link[href^="#"]')];
const sections = sectionLinks.map(link => document.querySelector(link.hash));
let sectionObserver;
function observeCurrentSection() {
  sectionObserver?.disconnect();
  const height = Math.max(1, window.innerHeight);
  const headerHeight = Math.min(header.offsetHeight, height - 1);
  const probe = Math.round(headerHeight + (height - headerHeight - 1) * .22);
  sectionObserver = new IntersectionObserver(() => {
    const current = sections.findIndex(section => {
      const { top, bottom } = section.getBoundingClientRect();
      return top <= probe && bottom > probe;
    });
    sectionLinks.forEach((link, index) => {
      if (index === current) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }, { rootMargin: `${-probe}px 0px ${probe + 1 - height}px 0px` });
  sections.forEach(section => sectionObserver.observe(section));
}
observeCurrentSection();
window.addEventListener("resize", observeCurrentSection);
const demoDetails = document.getElementById("demo-note");
document.querySelector("[data-demo-note]").addEventListener("click", () => { demoDetails.open = true; });
if (location.hash === "#demo-note") demoDetails.open = true;

// If screenshots are installed separately, the frames retain their dimensions.
const mediaFrames = new Map();
document.querySelectorAll("[data-media-frame]").forEach(frame => {
  const image = frame.querySelector("img");
  const fallback = frame.querySelector(".image-missing");
  function showMissing() {
    image.hidden = true;
    fallback.hidden = false;
  }
  image.addEventListener("error", showMissing);
  if (image.complete && !image.naturalWidth) showMissing();
  const enlarge = frame.parentElement.querySelector("[data-show-image]");
  if (enlarge) frame.addEventListener("click", () => enlarge.click());
  mediaFrames.set(frame.dataset.mediaFrame, frame);
});

const copyButtons = [...document.querySelectorAll("[data-copy]")];
const copyTimers = new WeakMap();
function updateCopyLabel(button) {
  const copied = button.dataset.copyState === "copied";
  const failed = button.dataset.copyState === "failed";
  const label = copied ? phrase("已复制", "Copied") : failed ? phrase("重试复制", "Retry copy") : phrase("复制", "Copy");
  button.querySelector("span").textContent = label;
  button.querySelector("use").setAttribute("href", copied ? "#i-check" : "#i-copy");
  const status = button.parentElement.querySelector('[role="status"]');
  status.classList.toggle("sr-only", !failed);
  status.textContent = failed ? phrase("无法自动复制。已选中文本，可手动复制。", "Automatic copying failed. The text is selected for manual copying.") : copied ? label : "";
}
copyButtons.forEach(button => {
  button.addEventListener("click", async () => {
    const source = document.getElementById(button.dataset.copy);
    clearTimeout(copyTimers.get(button));
    try {
      await navigator.clipboard.writeText(source.textContent.trim());
      button.dataset.copyState = "copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.dataset.copyState = "failed";
    }
    updateCopyLabel(button);
    if (button.dataset.copyState === "copied") {
      copyTimers.set(button, setTimeout(() => {
        delete button.dataset.copyState;
        updateCopyLabel(button);
      }, 2800));
    }
  });
});

const dialog = document.getElementById("lightbox");
const viewport = dialog.querySelector(".lightbox-viewport");
const large = new Image();
large.id = "large";
large.alt = "";
large.hidden = true;
viewport.prepend(large);
const message = document.getElementById("lightbox-message");
const previous = document.getElementById("previous-image");
const next = document.getElementById("next-image");
const zoom = document.getElementById("zoom-image");
const close = document.getElementById("close-lightbox");
let gallery = [];
let imageIndex = 0;
let zoomLevel = 0;
let request = 0;
let imageState = "loading";
let openedFrom;

function currentMedia() {
  const key = gallery[imageIndex];
  if (key === "presentation") {
    return {
      title: phrase("汇报工作区", "Presentation workspace"),
      caption: phrase("用论文与笔记编排大纲、图表和演讲备注。", "Assemble outlines, figures and speaker notes from papers and notes."),
    };
  }
  const frame = mediaFrames.get(key);
  return {
    title: frame.getAttribute("aria-label"),
    caption: frame.parentElement.querySelector(".media-caption > span").textContent,
  };
}

function updateLightboxLabels() {
  const media = currentMedia();
  dialog.querySelector("h2").textContent = media.title;
  dialog.querySelector("#lightbox-caption").textContent = media.caption;
  dialog.querySelector("#lightbox-counter").textContent = (imageIndex + 1) + " / " + gallery.length;
  large.alt = media.title;
  previous.setAttribute("aria-label", phrase("上一张截图", "Previous screenshot"));
  next.setAttribute("aria-label", phrase("下一张截图", "Next screenshot"));
  close.setAttribute("aria-label", phrase("关闭原图", "Close full-size image"));
  zoom.textContent = [
    phrase("放大细节", "Zoom in"),
    phrase("实际像素", "Actual size"),
    phrase("适合窗口", "Fit to window"),
  ][zoomLevel];
  message.hidden = imageState === "ready";
  if (imageState !== "ready") {
    message.textContent = imageState === "loading"
      ? phrase("正在加载截图…", "Loading screenshot…")
      : phrase("截图暂不可用。你可以切换到另一张。", "This screenshot is unavailable. You can switch to another image.");
  }
}

function resetZoom() {
  zoomLevel = 0;
  viewport.classList.remove("is-zoomed");
  viewport.scrollTop = 0;
  viewport.scrollLeft = 0;
}

async function loadImage(index) {
  const pending = ++request;
  imageIndex = (index + gallery.length) % gallery.length;
  const name = gallery[imageIndex];
  imageState = "loading";
  resetZoom();
  zoom.disabled = true;
  large.hidden = true;
  large.removeAttribute("src");
  updateLightboxLabels();
  const image = new Image();
  for (const file of [name + "-full.webp", name + ".webp"]) {
    image.src = "./assets/" + file;
    try {
      await image.decode();
      if (pending !== request) return;
      large.src = image.src;
      large.hidden = false;
      imageState = "ready";
      zoom.disabled = false;
      updateLightboxLabels();
      return;
    } catch {
      if (pending !== request) return;
    }
  }
  imageState = "missing";
  updateLightboxLabels();
}

document.querySelectorAll("[data-show-image]").forEach(button => {
  button.addEventListener("click", () => {
    const key = button.dataset.showImage;
    const group = button.closest(".hero") ? "hero" : button.closest(".reading") ? "reader" : "loop";
    gallery = galleryGroups[group];
    openedFrom = button;
    loadImage(gallery.indexOf(key));
    dialog.showModal();
  });
});
previous.addEventListener("click", () => loadImage(imageIndex - 1));
next.addEventListener("click", () => loadImage(imageIndex + 1));
close.addEventListener("click", () => dialog.close());
zoom.addEventListener("click", () => {
  const fitWidth = Math.min(viewport.clientWidth, (viewport.clientHeight || 120) * large.naturalWidth / large.naturalHeight);
  const detailWidth = Math.round(Math.min(large.naturalWidth * .85, Math.max(780, fitWidth * 2)));
  if (zoomLevel === 2) {
    resetZoom();
  } else {
    zoomLevel += 1;
    viewport.style.setProperty("--zoomed-width", (zoomLevel === 1 ? detailWidth : large.naturalWidth) + "px");
    viewport.classList.add("is-zoomed");
  }
  updateLightboxLabels();
});
dialog.addEventListener("keydown", event => {
  if (event.target === viewport && zoomLevel !== 0) return; // Keep arrow-key scrolling for the zoomed image.
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    loadImage(imageIndex + (event.key === "ArrowLeft" ? -1 : 1));
  }
});
let pressedBackdrop = false;
function onBackdrop(event) {
  const bounds = dialog.getBoundingClientRect();
  return event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right ||
    event.clientY < bounds.top || event.clientY > bounds.bottom);
}
dialog.addEventListener("pointerdown", event => { pressedBackdrop = onBackdrop(event); });
dialog.addEventListener("click", event => { if (pressedBackdrop && onBackdrop(event)) dialog.close(); });
dialog.addEventListener("close", () => {
  request += 1;
  resetZoom();
  openedFrom?.focus({ preventScroll: true });
});

languageButtons.forEach(button => {
  button.addEventListener("click", () => {
    updateLanguage(button.dataset.language);
    try { localStorage.setItem(languageKey, language); } catch { /* Storage is optional. */ }
  });
});
try { language = localStorage.getItem(languageKey) === "en" ? "en" : "zh"; } catch { /* Keep the default. */ }
updateLanguage(language);
