# Windows 一键启动

`Node.js 22.12+` 是软件版本要求，不是要输入终端的命令。

推荐下载：[Windows x64 一键版 ZIP（含 Node.js 和 npm）](https://github.com/letsgo-6/SparkWright/releases/download/windows-one-click-2026-10-06/SparkWright-personal-v0.2.1-Windows-x64.zip)。

1. 将个人版 ZIP **完整解压**到可写文件夹，例如桌面。不要直接在压缩包中运行。
2. 双击根目录的 **启动SparkWright.bat**。不用先打开 PowerShell/CMD，也不用手动安装 Node.js。
3. 首次启动需要联网安装项目依赖，请等待。安装成功后启动服务，并自动打开浏览器。
4. 保持启动窗口打开。以后仍然双击同一 BAT，按 Ctrl+C 停止。

Windows x64 一键包附带官方便携 Node.js 22.23.3 与 npm，保存在 `.runtime/node/`，无需管理员权限，不修改系统 PATH。GitHub 源码 ZIP 不包含运行环境；同一启动器会复用已安装的兼容 Node.js，或自动下载经 SHA-256 校验的官方便携版。支持64位 Windows，ARM64 源码用户可自动获取 ARM64 运行环境；本次提供的一键包面向 x64 电脑。

这不是完全离线的安装包，首次项目依赖安装以及聊天、AI 功能需要网络。下载失败时启动器会保留错误信息；检查网络后重新双击，不要把版本要求当作命令输入。

打开后可使用本地个人功能，也可登录公共社区。社区默认连接 `https://community.sparkwright.asia`；BAT 启动的是本机个人客户端，不会在用户电脑部署公共服务器。
