# SparkWright

**新手必看：[操作指南（HTML 图文版）](操作指南.html)**。下载并解压后，双击根目录的 `操作指南.html` 即可查看，无需先启动应用。

记录灵感，让灵感成为作品。SparkWright 集成灵感管理、AI 评分与合成、创作计划、开发项目、内容制作、需求商单与灵感酱 3D 互动。

前端：React + TypeScript + Vite。服务端：Fastify。数据库：SQLite。电脑保留完整私人工作区，公共社区统一提供聊天、公开灵感和排行榜。支持中文 / English 与四种主题。

![SparkWright 个人版首页：星空主题与灵感酱](docs/images/homepage.png)

## 个人开源版

本仓库提供个人客户端。启动后显示社区登录界面；也可选择“先使用本地个人功能”，无需登录即可创作。首次运行自动建立本地工作区身份，保留私人灵感、评分、合成、项目与 Key。社区账号与本地身份完全分开，本地 owner 不具有云端管理权限。

升级已有的单账号数据库时，沿用原用户 ID、灵感与配置，不修改旧的邮箱或密码哈希。首次增加社区映射表前自动创建一致性快照。若数据库包含多个账号，启动明确拒绝自动选择，请保留备份由维护者处理。

社区注册填写昵称、邮箱和密码，不发送邮箱验证码；昵称可以重名，聊天同时显示稳定账号 ID。首次登录需要联网，社区故障和退出不锁住个人功能。公共社区入口：[community.sparkwright.asia](https://community.sparkwright.asia)(手机端也可访问该网站，进行社区讨论），与本地私人工作区独立运行。

电脑通过本机后端连接配置的 HTTPS/WSS 社区，手机直接打开轻量社区网址。手机本期只提供社区功能，不下载电脑 3D、视频图标或私人工作台。完整边界见 [个人客户端与社区使用指南](docs/个人客户端与社区使用指南.md)。云端部署适配源码不包含在此次个人仓库公开发布范围。

社区上线后，电脑在“社区公告”入口、手机在社区“公告”页查看同一份管理员公告，已读状态按社区账号跨设备同步。owner/admin 在社区后台管理公告；本地默认身份没有社区管理权限。心仪视频作品功能已移除，旧数据仍保留在本机备份和导出中，自媒体制作与需求商单继续可用。

喜欢 SparkWright？进入 [GitHub 为我点亮 Star](https://github.com/letsgo-6/SparkWright)，你们的点亮是我的最大动力 :) 如果 GitHub 访问不畅，可以访问 [Watt Toolkit 官方下载](https://steampp.net/)后尝试加速。Star 由你在 GitHub 手动操作。

## 快速开始

**Windows 推荐下载：[一键版 ZIP（含 Node.js 和 npm，约49 MB）](https://github.com/letsgo-6/SparkWright/releases/download/windows-one-click-2026-10-06/SparkWright-personal-v0.2.1-Windows-x64.zip)**，适用于 Intel/AMD 64位 Windows。完整解压后双击 `启动SparkWright.bat`；首次联网安装项目依赖，随后自动打开浏览器。

源码下载：[个人客户端源码 ZIP](https://github.com/letsgo-6/SparkWright/archive/refs/heads/main.zip)。源码 ZIP 不包含便携 Node.js，启动器会使用已安装的兼容环境或自动下载。社区部署包由作者另行部署，不需要普通用户安装。

**Windows 一键启动：**解压到可写目录后，双击根目录的 `启动SparkWright.bat`，无需先输入命令。启动器优先使用包内便携 Node.js 或已安装的 Node.js 22.12+；缺少可用环境时自动从 Node.js 官网下载并校验，放入项目的 `.runtime/node/`，无需管理员权限，也不修改系统 PATH。首次运行自动安装依赖，需要联网；服务就绪后自动打开浏览器。支持64位 Windows（x64/ARM64），请保持启动窗口打开，按 Ctrl+C 停止服务。如果个人版已经运行，会直接打开网址。

安装 Node.js 22.12+，在项目根目录运行：

```sh
npm ci
npm start
```

Windows PowerShell 请使用 `npm.cmd`，避免执行策略拦截 `npm.ps1`；无需修改系统执行策略：

```powershell
npm.cmd ci
npm.cmd start
```

等待安装完成后再启动，保持启动窗口打开。也可以在项目文件夹的资源管理器地址栏输入 `cmd`，再运行上面的通用命令。

启动后访问 `http://127.0.0.1:5318`，登录社区或选择本地个人功能。以后只需运行 `npm start`，无需初始化本地账号。旧命令 `npm run account:init` 只提示本地工作区无需账号；它不是社区 owner 初始化工具。

个人工作区仅供本机使用：服务监听 `127.0.0.1`，拒绝非本机 Host、远程客户端和外部网站请求；写入接口保留来源校验。请勿公开本地个人服务。公共社区使用独立部署包；旧完整多人工作台不再是当前发布产品。

开发：`npm run dev`，界面地址 `http://127.0.0.1:5310`。检查：`npm run typecheck`、`npm test`、`npm run build`。

完整操作步骤见 [SparkWright 使用说明书](docs/SparkWright使用说明书.md)。AI 评测工具说明见 [评测模板](eval-templates/scoring-v5/README.md)。评分规则说明见 [V5 评分说明](README_SCORING_V5.md)。

## 功能

- 我的灵感、标签、截止日期、状态、执行步骤与数据导出。
- V5 标准评分、一位小数、评分历史与自主报名排行榜；排除超过 60 秒及 100.0 分的评分。
- 两条不同灵感的随机合成，结果可高可低，导入后继续创作。
- 统一公共频道、实时消息、历史分页、断线补齐、账号去重在线人数与 owner 治理。
- 自媒体制作、开发工程、参考视频、需求商单与平台资源页。
- 社区用户反馈、通知、管理后台，以及分别统计的聊天活跃与社区活跃趋势。
- 粒子灵感酱、3D 场景、四种主题、双语和移动端布局。
- 自愿支持作者：[爱发电](https://afdian.com/a/luoxijixian567)，应用内保留微信赞赏码。

## 配置与数据

`npm run setup:local` 自动准备本机 `.env`。参照 [.env.example](.env.example) 设置端口、`COMMUNITY_URL` 与可选本地 AI 配置。社区不依赖 SMTP；不要带入旧邮件授权码。用户在普通「设置」填写的 Key 用于本地 AI；参榜需要在“我的社区投稿”单独设置社区 Key。

源码不包含真实 `.env`、数据库、账号、密码哈希、邮件凭据、API Key 或备份。运行时生成的 `.env`、`data/` 与 `node_modules/` 不应提交到 GitHub。个人 Key 当前存储于 SQLite，数据库及备份应按敏感凭据保管。

私人数据库不自动同步。只有用户确认的单条标题和正文会上传为社区草稿；云端重新评分后，还需主动公开与参榜。联网反馈发送到社区管理员收件箱；代码问题也可在项目 Issues 提交。社区会话只保存在本机服务内存与 HttpOnly 桥接 Cookie 中；关闭本机服务后需要重新登录社区，密码不缓存。

## 许可证与合作

本项目源码按根目录 [LICENSE](LICENSE) 中的 **Mozilla Public License 2.0（MPL-2.0）** 提供。非商业用途与商业用途均可按许可证使用；分发修改后的受覆盖文件时，请遵守 MPL 的源码提供和许可告知要求。

商业使用无须另行取得作者授权。付费支持、部署协助、定制开发与合作事项可另行联系 [作者](https://github.com/letsgo-6)，这些服务不改变 MPL 已授予的使用权利。第三方依赖适用各自的许可证，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

SparkWright 名称、Logo 和作者身份不应被用于暗示第三方服务获得作者背书。自行运营的服务请明确运营者及其数据处理政策。
