# EchoPaper

[English](README.md) | **简体中文**

平时做科研，文献常年躺在不同的软件和浏览器标签页里：读 PDF 用一个工具、翻译复制去网页、笔记散在零碎的 Markdown 里、写论文再切回 LaTeX 编辑器，到组会前还要重头拼一份 PPT。**EchoPaper** 想做的事情很简单——把这一整条研究链路放进电脑里的同一个本地文件夹，浏览器打开就能用，所有稿件、资料和缓存都踏实留在你自己硬盘上，没有任何云端绑定。

## 日常可以这样用

- **读文献**：连上你本机的论文目录后，列表会整齐列出英文原题、中文译题、发表会议或期刊年份与关键词，支持同时搜索原文和译文；点开就能连续看 PDF、对照双语译文、划词翻译并随手写阅读笔记。
- **理课题**：按课题记下每天的进展、实验记录和待办，还能把同一个课题下的文献自动连成一张可交互的知识关系图，理清彼此的承接与对比。
- **写稿与返修**：内置 LaTeX 编辑与 Tectonic 编译预览，点一下 PDF 就能跳回对应源码行；支持在 PDF 上做标注、逐条整理审稿回复，也能直接校验打包投稿压缩包。
- **AI 搭把手与做汇报**：接入你自己的 OpenAI 兼容模型后，可以让助手帮忙读文献或润色修改（所有改动都会先给你看对比、确认后才落盘）；组会前也能把论文或笔记直接转成可继续修改的 `.pptx` 演示文稿。

## 快速上手

请先安装 **Node.js 22.13 及以上的 22.x，或 Node.js 24.x**、**Git 2.28+** 和 **Python 3**。即使是下载 ZIP，打开论文工作区也需要 Git。请保留完整目录，不要只拷贝 `_system`。

```sh
git clone https://github.com/Blueeeecho/EchoPaper.git
cd EchoPaper
```

**最省事的方式**：在 macOS 上双击 `启动工作台.command`，在 Windows 上双击 `启动工作台.bat`，关闭后台用对应的 `停止工作台`。首次启动或在 macOS 和 Windows 间搬迁后，需要联网从 `registry.npmmirror.com` 安装锁定的 npm 依赖及其平台二进制文件。如果浏览器没自动打开，请用启动脚本打印的本地地址。默认是 `http://127.0.0.1:4173`，端口占用时会另选。

**习惯用终端的话**：

```sh
npm --prefix _system ci --no-audit --no-fund
npm --prefix _system run build
node _system/scripts/control.mjs start
```

阅读、笔记、本地搜索和 LaTeX 编辑不需要 API Key。编译 LaTeX 还要安装 **Tectonic** 和模板所需字体；找不到编译器时可设置 `TECTONIC_PATH`。首次编译可能要下载 TeX 宏包资源，离线编译需要本地已有相应缓存。HZAU 幻灯片模板需要 **隶书** 和 **Times New Roman**，缺字体不会静默替换。已经安装 npm 依赖但启动有问题时，可以运行 `npm --prefix _system run doctor` 检查。

需要使用 AI 助手、全文翻译或版面解析时，在“模型设置”里填入自己的接口与密钥。密钥保存在 macOS 钥匙串或 Windows 凭据管理器里，不会明文写进仓库。

## 补充说明

- 仓库自带一个空白合成示例 `papers/DEMO/` 供试用；平时改源码不会每次敲字就触发编译，需要生成 PDF 时主动保存编译目标或点一下编译即可。
- 如果你想了解命令行工具、本地接口、翻译源配置或构建 macOS 桌面启动器，可以看 [`LOCAL_API.md`](_system/docs/LOCAL_API.md)、[`ACADEMIC_API.md`](_system/docs/ACADEMIC_API.md)、[`TRANSLATION_SERVICES.md`](_system/docs/TRANSLATION_SERVICES.md) 和 [`_system/native/README.md`](_system/native/README.md)。
- 这是一份清理过个人信息的公开源码版，不包含任何私人论文、文献库或密钥（详见 [`SHARING_NOTES.md`](SHARING_NOTES.md)）；自己本地用过之后，请不要直接把整个文件夹打成 ZIP 分享给别人。
- 第三方依赖各自遵循原开源许可；内置 HZAU 汇报模板中的校徽、照片等素材版权归原权利人所有（详见 [`ACADEMIC_REUSE.md`](_system/docs/ACADEMIC_REUSE.md)），本仓库暂未统一指定开源许可证。
