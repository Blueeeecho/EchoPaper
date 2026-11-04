# EchoPaper 分享版

本地学术工作台：研究课题、资料库、LaTeX 写作与 PDF 预览、AI 助手、翻译、审稿管理和可编辑 PPT 导出。
网页与本机文件共用同一工作区。这个分享包包含程序源码、锁定的依赖清单、通用模板、自动测试和一个全新合成示例。

## macOS 启动

1. 将整个 `EchoPaper` 文件夹解压到自己的可写目录；不要只复制 `_system`。
2. 安装 Node.js 22、Python 3 和 Tectonic。LaTeX 编译使用 Tectonic，不会自动安装或切换到 TeX Live。
3. 在该文件夹执行：

```sh
npm --prefix _system ci --no-audit --no-fund
npm --prefix _system run build
node _system/scripts/control.mjs start
```

也可以双击 `启动工作台.command`，首次运行会安装依赖和构建前端。后台默认从 `http://127.0.0.1:4173` 启动，端口占用时会另选端口，以命令输出为准。
关闭后台使用 `停止工作台.command` 或 `node _system/scripts/control.mjs stop`。
本包是源码分享包，没有携带 Node.js、Tectonic、npm 依赖或 macOS 已安装应用；首次安装和宏包下载需要联网。当前主要验证环境为 macOS，不承诺 Windows 开箱运行。

Tectonic 默认路径为 `/opt/homebrew/bin/tectonic`。若安装位置不同，从终端设置后启动：

```sh
export TECTONIC_PATH="$(command -v tectonic)"
node _system/scripts/control.mjs start
```

AI 与翻译功能需要在“设置”中配置自己的服务地址、模型和 API Key。未配置时可使用普通编辑、资料管理等本地功能。本包没有原作者的模型连接或凭据。凭据机制使用 macOS 钥匙串。

## 使用与目录

- `papers/DEMO/` 是新建的示例；可在网页新建、导入自己的论文。
- `shared/` 为通用 LaTeX 模板、检查清单与 HZAU 汇报风格包。
- `_system/` 为前后端源码、测试、脚本与接口文档。
- `workspace/`、`archive/`、`backups/` 在本机使用时生成资料索引、归档和备份。
- 文件监听只同步源码。需要 PDF 时主动保存当前编译目标或点击编译；CLI 修改后显式调用 `compile`。
- 连接资料库前选择自己的目录。PPT 字体需要本机具备 Times New Roman 和隶书；导出后在 WPS/PowerPoint 检查。

接口说明见 `_system/docs/LOCAL_API.md`、`_system/docs/ACADEMIC_API.md`；CLI 入口：

```sh
node _system/scripts/echopaper.mjs help
npm --prefix _system test
npm --prefix _system run doctor
```

可选 macOS 启动台在自己的电脑上构建：`_system/scripts/build-macos-app.sh`。移动工作区后需要重新构建，详见 `_system/native/README.md`。

## 分享范围

已排除个人论文、原始导入材料、聊天/审稿/批注/任务历史、资料库路径与数据库、PPT 项目、投稿包、备份、模型配置、缓存、日志、截图和 Git 历史。
源码中的个人绝对路径已改为通用路径；PPT 模板的作者与自定义元数据已清理。详细清单见 `SHARING_NOTES.md`。
未来继续分享时，请从干净副本或已检查的源码导出；使用后不要直接压缩整个工作区。`.gitignore` 仅帮助防止误提交，不会阻止 ZIP 收入文件。

第三方 npm 依赖保留各自许可，安装后可在依赖目录查看。HZAU 学校标识、照片与模板素材沿用原模板，相关权利仍归原权利人；本包未为其新增开源许可，也未为整个项目擅自指定开源许可证。复用说明见 `_system/docs/ACADEMIC_REUSE.md`。
