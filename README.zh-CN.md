# EchoPaper

[English](README.md) | **简体中文**

平时做科研，文献常年躺在不同的软件和浏览器标签页里：读 PDF 用一个工具、翻译复制去网页、笔记散在零碎的 Markdown 里、写论文再切回 LaTeX 编辑器，到组会前还要重头拼一份 PPT。**EchoPaper** 想做的事情很简单——把这一整条研究链路放进电脑里的同一个本地文件夹，浏览器打开就能用，所有稿件、资料和缓存都踏实留在你自己硬盘上，没有任何云端绑定。

## 日常可以这样用

- **读文献**：连上你本机的论文目录后，列表会整齐列出英文原题、中文译题、发表会议或期刊年份与关键词，支持同时搜索原文和译文；点开就能连续看 PDF、对照双语译文、划词翻译并随手写阅读笔记。
- **理课题**：按课题记下每天的进展、实验记录和待办，还能把同一个课题下的文献自动连成一张可交互的知识关系图，理清彼此的承接与对比。
- **写稿与返修**：内置 LaTeX 编辑与 Tectonic 编译预览，点一下 PDF 就能跳回对应源码行；支持在 PDF 上做标注、逐条整理审稿回复，也能直接校验打包投稿压缩包。
- **AI 搭把手与做汇报**：接入你自己的 OpenAI 兼容模型后，可以让助手帮忙读文献或润色修改（所有改动都会先给你看对比、确认后才落盘）；组会前也能把论文或笔记直接转成可继续修改的 `.pptx` 演示文稿。

## 快速上手

开始前需要在电脑上准备好 **Node.js 22+** 和 **Python 3**（如果要本地编译 LaTeX 再装一下 **Tectonic**，需要版本记录可以装上 **Git**）。克隆或下载时请保留完整目录，不要只拷贝里面的 `_system`。

```sh
git clone https://github.com/Blueeeecho/EchoPaper.git
cd EchoPaper
```

**最省事的方式**：在 macOS 上直接双击 `启动工作台.command`，在 Windows 上直接双击 `启动工作台.bat`（关闭时点对应的 `停止工作台` 即可）。第一次启动或跨系统拷贝后，它会自动安装当前系统所需的依赖，并在浏览器里打开 `http://127.0.0.1:4173`。

**习惯用终端的话**：

```sh
npm --prefix _system ci --no-audit --no-fund
npm --prefix _system run build
node _system/scripts/control.mjs start
```

不填任何 API Key 也可以正常用完所有本地功能；需要使用 AI 助手、全文翻译或版面解析时，在界面右上角“模型设置”里填入自己的接口与密钥即可，密钥保存在系统钥匙串（macOS Keychain / Windows 凭据管理器）里，不会明文写进仓库目录。

## 补充说明

- 仓库自带一个空白合成示例 `papers/DEMO/` 供试用；平时改源码不会每次敲字就触发编译，需要生成 PDF 时主动保存编译目标或点一下编译即可。
- 如果你想了解命令行工具、本地接口、翻译源配置或构建 macOS 桌面启动器，可以看 [`LOCAL_API.md`](_system/docs/LOCAL_API.md)、[`ACADEMIC_API.md`](_system/docs/ACADEMIC_API.md)、[`TRANSLATION_SERVICES.md`](_system/docs/TRANSLATION_SERVICES.md) 和 [`_system/native/README.md`](_system/native/README.md)。
- 这是一份清理过个人信息的公开源码版，不包含任何私人论文、文献库或密钥（详见 [`SHARING_NOTES.md`](SHARING_NOTES.md)）；自己本地用过之后，请不要直接把整个文件夹打成 ZIP 分享给别人。
- 第三方依赖各自遵循原开源许可；内置 HZAU 汇报模板中的校徽、照片等素材版权归原权利人所有（详见 [`ACADEMIC_REUSE.md`](_system/docs/ACADEMIC_REUSE.md)），本仓库暂未统一指定开源许可证。
