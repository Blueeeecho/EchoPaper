# EchoPaper

**本地优先的一体化学术工作台** —— 覆盖研究课题管理、文献阅读与双语对照、知识关系图、LaTeX 写作与审稿、AI 助手及可编辑汇报导出。

![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-2f4858?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-3c6e71?style=flat-square)
![Stack](https://img.shields.io/badge/Stack-React%2019%20%2B%20Fastify%205-4a6fa5?style=flat-square)
![LaTeX](https://img.shields.io/badge/LaTeX-Tectonic-5c6b73?style=flat-square)
![Storage](https://img.shields.io/badge/Mode-Local--First-6b705c?style=flat-square)

---

## 设计原则

- **网页与本地文件共用同一工作区**：所有论文、笔记、配置与索引直接保存在本机目录中，支持网页端、桌面程序与外部脚本/编辑器协同读写，无云端锁定。
- **开箱可离线运行**：本地编辑、LaTeX 编译、PDF 阅读、批注、目录索引与 Git 版本管理均不依赖外部模型服务；AI 与翻译按需接入。
- **源码分享版（已脱敏）**：本仓库仅包含程序源码、锁定依赖清单、通用模板、自动化测试与合成示例 `papers/DEMO/`，不含任何个人论文、文献库数据或凭据。

---

## 核心功能

| 模块 | 主要能力 |
| :--- | :--- |
| **研究课题与进度** | 按课题组织研究阶段、日常待办与工作日历，维护研究笔记与证据关联，支持跨视图返回并恢复阅读位置与草稿。 |
| **资料库与文献管理** | 连接本机学术目录（读写权限可选、可恢复回收站与操作撤销），文献列表统一展示**原题、中文译题、发表会议/期刊与年度及关键词**，支持原文与译文全文检索。 |
| **PDF 阅读与双语对照** | HiDPI 连续 PDF 渲染、区域框选与划词翻译、后台 OCR 版面解析与分段翻译队列、Markdown 阅读笔记与摘录联动。 |
| **学术知识关系图** | 60fps Canvas 交互式文献关系图，结合元数据归一化与本地译文缓存提取实体与关系，并支持按需调用 AI 深化关系抽取。 |
| **LaTeX 写作与审稿** | 基于 Tectonic 的本地编译、源码与 PDF 双向定位（SyncTeX）、结构化编译诊断、PDF 右键批注、审稿意见逐条回复、投稿包校验打包与本地 Git 历史。 |
| **本地 AI 助手** | 基于 LangGraph JS 与 SQLite 检查点的任务运行时，对接 OpenAI 兼容接口；代码/文稿修改通过变更集（Changeset）审阅确认后落盘。 |
| **可编辑 PPT 导出** | 从论文、笔记或文献资料生成大纲并导出可编辑 `.pptx`（内含 HZAU 汇报风格包）；导出后建议在目标 PowerPoint / WPS 中复核版式。 |

> PPT 模板中文字体使用**隶书**，英文字体使用 **Times New Roman**，请确保本机已安装对应字体。

---

## 快速开始

### 环境要求

| 工具 | 要求 | 说明 |
| :--- | :--- | :--- |
| **Node.js** | **22+**（必选） | 前后端运行、构建及桌面控制脚本依赖 |
| **Python 3** | **3.x**（必选） | 用于系统钥匙串凭据桥接及安全归档脚本 |
| **Git** | 最新稳定版（推荐） | 论文工作区本地版本管理 |
| **Tectonic** | 最新稳定版（可选） | 仅本地编译 LaTeX 论文需要；不会自动安装或切换到 TeX Live |

### 获取源码

```sh
git clone https://github.com/Blueeeecho/EchoPaper.git
cd EchoPaper
```

> 请保留完整的仓库目录结构运行，**不要只单独复制 `_system/` 目录**。

### 方式一：双击一键启停（推荐）

- **macOS**：双击 `启动工作台.command` 启动，双击 `停止工作台.command` 停止。
- **Windows**：双击 `启动工作台.bat` 启动，双击 `停止工作台.bat` 停止。

首次启动（或从 macOS 直接拷贝至 Windows 后首次启动）会自动联网安装当前平台所需依赖（如 `better-sqlite3` 原生模块）并构建前端，随后自动打开浏览器。

### 方式二：命令行启动

```sh
npm --prefix _system ci --no-audit --no-fund
npm --prefix _system run build
node _system/scripts/control.mjs start
```

停止后台服务：

```sh
node _system/scripts/control.mjs stop
```

- 默认服务地址为 `http://127.0.0.1:4173`（若端口被占用会自动顺延并输出实际地址）。
- 若 `tectonic` 不在默认搜索路径中，可通过环境变量 `TECTONIC_PATH` 指定路径后启动：

```sh
# macOS / Linux
export TECTONIC_PATH="$(command -v tectonic)"
node _system/scripts/control.mjs start
```

```powershell
# Windows PowerShell
$env:TECTONIC_PATH = "C:\path\to\tectonic.exe"
node _system\scripts\control.mjs start
```

- **可选 macOS 启动台应用**：可在本机运行 `_system/scripts/build-macos-app.sh` 构建本地启动器；工作区目录移动后需重新构建，详见 [`_system/native/README.md`](_system/native/README.md)。

---

## 模型、翻译与 OCR 配置

1. 未配置外部服务时，论文编辑、资料库浏览、PDF 原文阅读与本地编译均可正常使用。
2. 需要启用 AI 助手、文献翻译或版面解析时，在界面右上角 **模型设置** 中填写你的 OpenAI 兼容 `Base URL`、模型名称与 `API Key`：
   - **安全存储**：API Key 不会明文写入代码或仓库目录，分别安全保存在 **macOS Keychain** 或 **Windows Credential Manager**。
   - **独立配置**：对话模型、翻译来源与 OCR 解析引擎支持分开配置与切换。

---

## 目录结构与常用命令

```text
EchoPaper/
├── 启动工作台.command / 停止工作台.command   # macOS 双击启停脚本
├── 启动工作台.bat / 停止工作台.bat           # Windows 双击启停脚本
├── papers/DEMO/                              # 合成示例论文项目（日常使用新增项目也位于此）
├── shared/                                   # 通用 LaTeX 模板、检查清单与汇报风格包
├── _system/                                  # 前后端源码、自动化测试、控制脚本与接口文档
├── workspace/                                # 本地运行后生成的资料库索引、阅读与图谱缓存（不入库）
├── archive/                                  # 原始导入归档（不入库）
└── backups/                                  # 工作台本地备份（不入库）
```

### 常用维护与校验命令

```sh
node _system/scripts/echopaper.mjs help   # 查看命令行接口帮助
npm --prefix _system run doctor           # 检查 Node、SQLite 原生模块、Tectonic 与项目结构
npm --prefix _system test                 # 运行自动化测试套件
```

### 相关文档

- 本地命令行与接口规范：[`_system/docs/LOCAL_API.md`](_system/docs/LOCAL_API.md)
- 学术工作台接口说明：[`_system/docs/ACADEMIC_API.md`](_system/docs/ACADEMIC_API.md)
- 翻译服务配置说明：[`_system/docs/TRANSLATION_SERVICES.md`](_system/docs/TRANSLATION_SERVICES.md)
- 知识关系图设计说明：[`_system/docs/RESEARCH_MAP.md`](_system/docs/RESEARCH_MAP.md)
- 代理协作与工作区约定：[`AGENTS.md`](AGENTS.md)
- 分享清理清单与变更说明：[`SHARING_NOTES.md`](SHARING_NOTES.md)

---

## 技术栈

| 层级 | 主要技术 |
| :--- | :--- |
| **前端** | React 19、TypeScript 5、Vite 6、CodeMirror 6、PDF.js、KaTeX |
| **后端** | Fastify 5、SQLite（多表 WAL）、Node 22 原生 `fs.watch` |
| **AI 与文档** | LangGraph JS、`@langchain/langgraph-checkpoint-sqlite`、PptxGenJS、Tectonic |

---

## 使用约定与许可说明

- **编译触发机制**：文件监听与自动保存仅同步源码，不自动触发 LaTeX 编译；需要生成 PDF 时请主动保存编译目标、点击界面编译按钮，或在 CLI 修改后显式执行 `compile`。
- **备份安全**：本工作区在使用过程中会在 `workspace/`、`archive/`、`backups/` 与 `_system/runtime/` 生成本地索引和运行记录；切勿直接打包压缩使用后的整个文件夹对外分发（`.gitignore` 不会阻止 ZIP 工具收入文件）。
- **分享范围与开源许可**：
  - 本仓库排除了全部私人论文、外部资料索引、聊天/审稿/批注/任务数据库、模型配置与旧版 Git 历史，详见 [`SHARING_NOTES.md`](SHARING_NOTES.md)。
  - 第三方 npm 依赖保留各自开源许可（安装后可在 `node_modules` 查看）；HZAU 相关标识、照片与模板素材版权归原权利人所有，本项目未对其也未对整体仓库新增额外开源许可证，复用规范见 [`_system/docs/ACADEMIC_REUSE.md`](_system/docs/ACADEMIC_REUSE.md)。
