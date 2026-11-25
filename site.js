"use strict";

const byId = (id) => document.getElementById(id);
const all = (selector) => Array.from(document.querySelectorAll(selector));
const english = () => document.documentElement.lang === "en";
const choose = (zh, en) => (english() ? en : zh);
const translations = all("[data-en]").map((node) => [node, node.textContent]);
const alternateText = all("[data-alt], [data-label]").map((node) => {
  const attribute = node.hasAttribute("data-alt") ? "alt" : "aria-label";
  return [
    node,
    attribute,
    node.getAttribute(attribute),
    node.dataset.alt || node.dataset.label,
  ];
});
const tabList = document.querySelector(".tabs");
const tabs = all("[role=tab]");
const smallScreen = matchMedia("(max-width:660px)");
const gallery = all(".picture img");
const viewer = byId("viewer");
const large = byId("large");
const menu = byId("menu");
const copyTimers = new Map();
let slide = 0;

function showLanguage(useEnglish) {
  document.documentElement.lang = useEnglish ? "en" : "zh-CN";
  document.title = choose(
    "EchoPaper · 本地研究工作台",
    "EchoPaper · Local research workspace",
  );
  document.querySelector('meta[name="description"]').content = choose(
    "EchoPaper 本地研究工作台。围绕课题阅读文献、记录实验、核对证据与编写 LaTeX 论文。",
    "Read papers, log experiments, check evidence and write in LaTeX in one local research workspace.",
  );
  copyTimers.forEach(clearTimeout);
  copyTimers.clear();
  byId("status").textContent = "";
  translations.forEach(([node, zh]) => {
    node.textContent = choose(zh, node.dataset.en);
  });
  alternateText.forEach(([node, attr, zh, en]) =>
    node.setAttribute(attr, choose(zh, en)),
  );
  const targetLanguage = choose("English", "中文");
  byId("lang").setAttribute("aria-label", targetLanguage);
  byId("lang").title = targetLanguage;
  if (viewer.open) displaySlide();
}
const languageKey = "echopaper-site-lang";
try {
  if (localStorage.getItem(languageKey) === "en") showLanguage(true);
} catch {
  // The document already defaults to Chinese when storage is unavailable.
}
byId("lang").addEventListener("click", () => {
  showLanguage(!english());
  try {
    localStorage.setItem(languageKey, document.documentElement.lang);
  } catch {
    // Language switching also works for the current visit without storage.
  }
});

function toggleMenu(open) {
  byId("navigation").classList.toggle("open", open);
  menu.setAttribute("aria-expanded", String(open));
}
menu.addEventListener("click", () =>
  toggleMenu(menu.getAttribute("aria-expanded") === "false"),
);
byId("navigation").addEventListener("click", () => toggleMenu(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menu.getAttribute("aria-expanded") === "true") {
    toggleMenu(false);
    menu.focus();
  }
});

function selectTab(index, focus = false) {
  tabs.forEach((tab, i) => {
    const active = i === index;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    byId(tab.getAttribute("aria-controls")).hidden = !active;
  });
  if (focus) tabs[index].focus({ preventScroll: true });
  if (smallScreen.matches) {
    const tab = tabs[index];
    tabList.scrollLeft +=
      tab.getBoundingClientRect().left - tabList.getBoundingClientRect().left;
  }
}
tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => selectTab(i));
  tab.addEventListener("keydown", (event) => {
    const keys = {
      ArrowDown: 1,
      ArrowRight: 1,
      ArrowUp: -1,
      ArrowLeft: -1,
      Home: -i,
      End: tabs.length - 1 - i,
    };
    if (!(event.key in keys)) return;
    event.preventDefault();
    selectTab((i + keys[event.key] + tabs.length) % tabs.length, true);
  });
});
function updateOrientation() {
  tabList.setAttribute(
    "aria-orientation",
    smallScreen.matches ? "horizontal" : "vertical",
  );
}
smallScreen.addEventListener("change", updateOrientation);
updateOrientation();

function setZoom(actual) {
  viewer.classList.toggle("actual", actual);
  byId("magnify").textContent = actual
    ? choose("适应窗口", "Fit image")
    : choose("原始尺寸", "Actual size");
  byId("magnify").setAttribute("aria-pressed", String(actual));
}
function displaySlide() {
  setZoom(false);
  const image = gallery[slide];
  large.src = image.getAttribute("src").replace(".webp", "-full.webp");
  large.alt = image.alt;
  byId("view-title").textContent = image.alt;
  viewer.querySelector(".viewport").scrollTo(0, 0);
}
function moveSlide(delta) {
  slide = (slide + delta + gallery.length) % gallery.length;
  displaySlide();
}
all("[data-open]").forEach((button) =>
  button.addEventListener("click", () => {
    slide = Number(button.dataset.open);
    displaySlide();
    viewer.showModal();
    byId("close").focus();
  }),
);
byId("prev").onclick = () => moveSlide(-1);
byId("next").onclick = () => moveSlide(1);
byId("magnify").onclick = large.onclick = () =>
  setZoom(!viewer.classList.contains("actual"));
byId("close").onclick = () => viewer.close();
viewer.addEventListener("keydown", (event) => {
  if (!["ArrowRight", "ArrowLeft"].includes(event.key)) return;
  event.preventDefault();
  moveSlide(event.key === "ArrowRight" ? 1 : -1);
});
viewer.addEventListener("click", (event) => {
  if (event.target !== viewer) return;
  const bounds = viewer.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    viewer.close();
});

all("[data-copy]").forEach((button) =>
  button.addEventListener("click", async () => {
    const source = byId(button.dataset.copy);
    const label = button.querySelector("[data-en]");
    let message;
    try {
      await navigator.clipboard.writeText(source.textContent);
      message = choose("已复制", "Copied");
    } catch {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      message = choose("已选中，请手动复制", "Selected. Copy manually.");
    }
    byId("status").textContent = label.textContent = message;
    clearTimeout(copyTimers.get(button));
    copyTimers.set(
      button,
      setTimeout(() => {
        label.textContent = choose(button.dataset.copy === "cmd" ? "复制命令" : "复制", label.dataset.en);
        copyTimers.delete(button);
      }, 2400),
    );
  }),
);
