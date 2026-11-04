# macOS 启动台

在解压后的 EchoPaper 工作区运行 `_system/scripts/build-macos-app.sh`。
需要 macOS、Xcode Command Line Tools 和 Node.js；默认生成工作区根目录中的 `EchoPaper.app`，也可传入其他输出路径。
构建时将当前工作区与本机 Node.js 路径写入应用配置；移动工作区或换电脑后应重新构建，不要把自己构建的应用直接当作跨机器安装包。
网页与 PDF 使用系统默认浏览器打开。退出启动台不会停止后台，停止请使用工作区中的 `停止工作台.command`。
此分享包不包含本机编译应用、启动日志、性能采样或历史应用备份。
