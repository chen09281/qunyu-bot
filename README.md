# 群屿 · QQ 群智能助手

**版本：`v1.1.0`** · 集成 **多模型 AI 对话**、**SillyTavern 酒馆角色羁绊**、**多平台链接解析**、**订阅推送**、**每日签到** 与 **Vue 3 可视化后台** 的自托管 QQ 群机器人。

通过 **NapCat / OneBot v11** 接入 QQ，原生支持 **DeepSeek** 与 **OpenAI 兼容接口**；采用前后端一体服务架构，支持 Docker 一键编排与源码本地运行。

> [!IMPORTANT]
> 本项目默认按**私有交付 / 自托管部署**编写。在正式对外开源或公网暴露服务前，请务必先阅读文末的 [开源状态与合规提醒](#七开源合规与免责声明) 及 [安全上线建议](#4-公网与安全上线建议)。

---

## 目录

- [一、核心功能总览](#一核心功能总览)
- [二、系统架构与目录结构](#二系统架构与目录结构)
- [三、快速开始](#三快速开始)
- [四、首次配置步骤](#四首次配置步骤)
- [五、常用脚本与环境变量](#五常用脚本与环境变量)
- [六、测试、交付打包与干净开源导出](#六测试交付打包与干净开源导出)
- [七、开源合规与免责声明](#七开源合规与免责声明)
- [八、详细文档索引](#八详细文档索引)

---

## 一、核心功能总览

| 模块 | 主要能力与亮点 | 关键文件 / 说明 |
| --- | --- | --- |
| **多模型 AI 对话与记忆** | 支持 DeepSeek 与任意 OpenAI 兼容服务商（多配置库切换、冷却、Token 预算、超时无上限开关）；按机器人、群聊、成员及白名单私聊隔离会话记忆 | [docs/openai-api.md](docs/openai-api.md)、[docs/model-library.md](docs/model-library.md)、[docs/private-chat.md](docs/private-chat.md) |
| **图片细节识图与找图** | QQ 图片优先获取原图并对大截图自动无损分片送入识图模型；支持联网搜索正文并抓取过滤后原图发回群聊 | [docs/images.md](docs/images.md)、[docs/music-and-web-search.md](docs/music-and-web-search.md) |
| **文档生成与实时工作空间** | 通过工具调用生成 Word (`.docx`)、PDF、Markdown、TXT 群文件或私聊文件；后台「实时任务」每秒流式查看排队状态与思考过程 | [docs/live-workspace.md](docs/live-workspace.md)、`src/documents.mjs`、`src/document-worker.py` |
| **可选人设与酒馆角色羁绊** | 支持内置二次元人设或导入 SillyTavern PNG/JSON 角色卡（含世界书、宏替换与情绪触发贴纸）；支持全群共享或个人独立好感度、`/情绪` 雷达图卡片、`/羁绊榜`、`/投喂`、`/剧场`、`/ooc`、`/retry` 与分群绑定 | [docs/ds-persona.md](docs/ds-persona.md)、[docs/aemeath-persona.md](docs/aemeath-persona.md)、[docs/tavern.md](docs/tavern.md)、[src/tavern/usage-guide.md](src/tavern/usage-guide.md) |
| **群聊娱乐工坊** | 内置 `/玩法` 速查、`/今日运势`、`/喜报`/`/悲报`/`/举牌`/`/加字` 梗图、`/存语录`/`/语录` 名场面海报、`/群日报`（仅记录 7 天匿名频次）、`/十连`/`/欧非榜` 抽卡、`.r`/`.ra`/`.rh` TRPG 骰娘、`/海龟汤` 与 `/卧底` 桌游，子功能可逐项开关 | `src/fun/`、`src/card-renderer.mjs` |
| **社交链接自动解析** | 无需 `@` 自动识别 B 站视频/动态、抖音图文/视频、小红书、微博、X / Twitter 等链接，离线字体渲染高清信息卡并回传原图/视频（含 X `socks5://` 代理与 DNS 防护） | `src/social-links.mjs`、`src/link-worker.py` |
| **B 站总结与点歌** | `@ 机器人 + 视频链接/BV 号` 汇总简介、评论、字幕及低清视频抽帧联系表送交识图总结；`/点歌` 支持 30 秒高潮试听/完整版与自定义音频目录（AAC 192k 转码） | `src/music.mjs`、`src/music-catalog.mjs`、[docs/music-and-web-search.md](docs/music-and-web-search.md) |
| **多平台订阅推送** | 支持 B 站投稿、抖音主页作品、GitHub Release、通用 RSS / Atom 以及游戏官方活动与前瞻直播（明日方舟 / 绝区零 / 终末地 / 鸣潮），含同名作者优先抖音及失败回退 | [docs/subscriptions.md](docs/subscriptions.md)、[docs/rsshub-maintenance.md](docs/rsshub-maintenance.md) |
| **每日签到与 Token 工具** | 森空岛、米游社、库街区自动与手动签到、成员私聊自助绑定与回执；自带库街区 PC / Android APK / iOS Scriptable 辅助获取页面 `/tools/kuro/` | [docs/checkin.md](docs/checkin.md)、[docs/android-token-tool.md](docs/android-token-tool.md) |
| **后台安全、账单与运维** | 首次打开创建管理员（无默认密码）、scrypt 哈希、30 天 HttpOnly Cookie、TOTP 双因素认证、同源校验、`DATA_ENCRYPTION_KEY` 加密存储凭据、Token 用量校准/周报、邮件告警、资源监控与空闲 GC、加密备份恢复 | [docs/delivery/02-运行维护与问题排查.md](docs/delivery/02-运行维护与问题排查.md)、[docs/server-resources.md](docs/server-resources.md)、[docs/token-usage-and-pricing.md](docs/token-usage-and-pricing.md) |

---

## 二、系统架构与目录结构

- **后端核心**：Node.js（ESM，`^22.18.0 || >=24.12.0`），内建 HTTP / 静态资源服务与调度引擎，零重型 Web 框架依赖。
- **管理控制台**：Vue 3 (`3.5`) + Vite (`8`) 构建的单页应用，自适应桌面端与移动端。
- **解析与渲染 Worker**：Python 3 隔离虚拟环境（`yt-dlp`、`python-docx`、`Pillow` 等）配合 FFmpeg 与无头 Chromium 生成卡片及 PDF。
- **QQ 接入**：独立或编排同网络 NapCat Docker 容器（OneBot v11 HTTP 双向通信与登录管理）。

```text
.
├── src/                        # 后端服务、OneBot 消息引擎与插件模块
│   ├── server.mjs              # HTTP 服务入口、鉴权/同源防护与 WebSocket/Webhook 处理
│   ├── bot.mjs                 # 核心问答调度、队列控制、图片细节与工具协调
│   ├── tavern/                 # SillyTavern 角色卡解析、世界书、情绪羁绊与指令
│   ├── fun/                    # 群聊娱乐工坊插件（梗图/语录/十连/骰娘/桌游）
│   ├── subscriptions/          # RSS/B站/抖音/GitHub/游戏活动订阅与回退逻辑
│   ├── checkin/                # 游戏每日签到适配器、许可声明与 Token 提取工具源码
│   ├── link-worker.py          # 多平台链接解析与卡片截图 Worker
│   ├── document-worker.py      # Word / PDF / Markdown / TXT 导出 Worker
│   └── backup.mjs              # 加密备份与恢复 CLI
├── frontend/                   # Vue 3 管理后台源码
├── test/                       # Node 测试套件与 Python 单元测试
├── scripts/                    # 交付打包、Ubuntu 归档、RSSHub 同步与开源导出脚本
├── docs/                       # 功能设计、运维手册与 delivery 交付指南
├── compose.yaml                # 仅运行机器人容器的 Compose 配置
├── compose.integrated.yaml     # macOS / 本地开发一体化 Compose（机器人 + NapCat）
├── compose.ubuntu.yaml         # Linux / WSL2 Ubuntu 生产部署 Compose（配合 ubuntu.sh）
├── compose.rsshub.yaml         # 可选：受限本地自建 RSSHub 服务 Compose
├── ubuntu.sh                   # Ubuntu 宿主机一键部署、诊断、状态与停机脚本
├── Dockerfile                  # 多阶段生产镜像（Node 24 Alpine + Python venv + FFmpeg + Chromium）
├── .env.example                # 本机 / 通用 Compose 环境变量模板
├── .env.ubuntu.example         # Ubuntu 生产部署环境变量模板
├── THIRD_PARTY_NOTICES.md      # 第三方开源组件、字体与适配器许可证声明
└── CHANGELOG.md                # 版本更新日志
```

---

## 三、快速开始

### 1. Docker 一体化部署（推荐，全功能开箱即用）

完整运行（含 NapCat QQ 客户端、Python 解析依赖、FFmpeg 与无头浏览器）推荐使用 Docker：

| 运行环境 | 适用方式 | 执行命令 | 默认访问地址 |
| --- | --- | --- | --- |
| **Linux / VPS (Ubuntu)** | Docker Engine + Compose | `sudo bash ubuntu.sh deploy` | `http://服务器IP:3080` |
| **Windows 10/11** | Docker Desktop + WSL2 Ubuntu | Ubuntu 终端执行 `sudo bash ubuntu.sh deploy` | `http://127.0.0.1:3080` |
| **macOS** | Docker Desktop + Node.js 22/24 | 终端执行 `npm run deploy` | `http://127.0.0.1:3080` |

> 各平台前置安装及停止/重启/排查命令详见对应指南：[Windows 启动教程](docs/delivery/启动-Windows.md) ｜ [macOS 启动教程](docs/delivery/启动-macOS.md) ｜ [Linux 启动教程](docs/delivery/启动-Linux.md)

**通用 Docker 注意事项**：如果从交付包内层 `应用/` 启动通用 `compose.yaml`，建议先将目录移至英文路径（如 `/opt/qunyu`，`启动-Linux.md` 已默认采用此方式），或显式指定项目名 `docker compose -p qunyu up -d --build`，避免部分 Compose 版本因中文目录名报错；使用 `ubuntu.sh` 与 `compose.ubuntu.yaml`（已内置 `name: qunyu`）不受此限制。

### 2. 源码本地运行（开发 / 轻量调试）

适合本地调试 Web 后台和纯 Node 逻辑（Node.js 需为 `^22.18.0` 或 `>=24.12.0`）：

```bash
# 1. 安装 Node 依赖并构建前端
npm ci
npm run build

# 2. 按需准备环境变量（可选）
cp .env.example .env

# 3. 启动生产模式服务（默认监听 127.0.0.1:3080）
npm start
```

开发模式热更新可同时开启两个终端运行前端 Vite（`npm run dev`）和后端监听（`npm run dev:server`）。如需在非 Docker 环境下使用链接解析与文档生成，还需额外准备 Python 3 虚拟环境安装 [requirements-parser.txt](requirements-parser.txt)、`ffmpeg` 与 `chromium`。

### 3. 可选：自建 RSSHub（用于 B 站 / 抖音主页订阅）

如需在独立容器中配合 Cookie 池运行 RSSHub：

1. 准备权限为 `600` 的环境文件（默认读取 `./rsshub.env`，或通过 `RSSHUB_ENV_FILE` 指定路径，**禁止提交至仓库**）。
2. 在机器人 `.env.ubuntu` 中配置受管理员管控的内网地址 `RSSHUB_INTERNAL_URL=http://rsshub:1200`。
3. 使用 [compose.rsshub.yaml](compose.rsshub.yaml) 启动并用 [scripts/rsshub-cookie-sync.py](scripts/rsshub-cookie-sync.py)（默认只读，加 `--apply` 原子更新并重建容器）同步已登录的 B 站 Cookie。详见 [RSSHub 维护说明](docs/rsshub-maintenance.md)。

---

## 四、首次配置步骤

### 1. 初始化向导

1. 服务健康启动后，在浏览器打开后台地址（默认 `http://127.0.0.1:3080`）。
2. **创建管理员**：首次访问无默认密码，直接填写自定义管理员账号（3–64 位）与强密码（8 位以上）；建议随后在安全设置开启 **TOTP 两步验证**。
3. **绑定模型 API Key**：在引导或「模型与回复」中填写 DeepSeek 或 OpenAI 兼容服务商密钥并拉取模型列表。
4. **连接 QQ**：进入「QQ 连接」扫码登录作为机器人使用的 QQ 账号并确认在线状态。
5. **配置白名单**：在「白名单 → 群聊白名单」添加授权群号并勾选对应开关（AI 对话 / 链接解析 / 定时问候）；私聊按需在「私聊白名单」添加允许 QQ 号。
6. **按需启用插件**：在「插件」面板启用酒馆角色、群聊娱乐工坊、每日签到或订阅推送。

完整图解流程见 [首次配置指南](docs/delivery/01-部署与首次配置.md)。

### 2. 公网与安全上线建议

* `.env.ubuntu.example` 默认设置 `UBUNTU_BIND=0.0.0.0`、`UBUNTU_COOKIE_SECURE=false` 以便初始化期即开即用。
* 若在公网服务器长期运行，**强烈建议**前置 Nginx / Caddy 配置 **HTTPS 反向代理**，同时在 `.env` / `.env.ubuntu` 设置：
  * `COOKIE_SECURE=true`（或 `UBUNTU_COOKIE_SECURE=true`）
  * `PUBLIC_ORIGIN=https://你的域名`（或 `UBUNTU_PUBLIC_ORIGIN=https://你的域名`）
  * `DATA_ENCRYPTION_KEY=<随机高强度密钥>`（加密保存平台解析 Cookie；签到凭据使用独立的 `data/checkin/key`）
* 不要将 NapCat 的 `3000`、`6099` 端口暴露到公网。

---

## 五、常用脚本与环境变量

### 常用 `npm` 命令

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 使用 Vite 构建前端页面至 `dist/` |
| `npm start` / `npm run start:prebuilt` | 启动机器人后端服务（加载 `.env` 并启用 `--expose-gc`） |
| `npm run dev` / `npm run dev:server` | 分别以开发模式启动前端 Vite 与后端监听服务 |
| `npm run deploy` | macOS / 本机执行一体化 Docker 部署（`compose.integrated.yaml`） |
| `npm run deploy:ubuntu` | Ubuntu 宿主机执行 `bash ubuntu.sh deploy` |
| `npm test` | 构建前端并运行完整 `node --test` 测试套件 |
| `npm run reset-password` | 命令行重置管理员密码并吊销旧会话 |
| `npm run backup` / `npm run restore` | 使用 `BACKUP_PASSWORD` 对 `data/` 执行加密备份或恢复 |
| `npm run package:delivery` | 打包标准交付文件夹与校验 ZIP（输出至 `交付版本/`） |
| `npm run package:ubuntu` | 生成 `release/qq-bot-ubuntu.tar.gz` 与 `.sha256` 部署归档 |
| `npm run export:opensource` | 导出无私人历史与敏感文件的干净单提交开源 Git 仓库 |

### 核心环境变量（详见 [.env.example](.env.example) / [.env.ubuntu.example](.env.ubuntu.example)）

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3080` | 进程实际绑定地址与端口 |
| `BOT_BIND` / `UBUNTU_BIND` | `127.0.0.1` / `0.0.0.0` | Docker 宿主机端口监听地址 |
| `DATA_DIR` / `UBUNTU_DATA_DIR` | `./data` | 管理员、配置、数据库与日志持久化目录 |
| `DATA_ENCRYPTION_KEY` | 空 | 可选，用于加密存储平台解析 Cookie 的主密钥；签到凭据使用独立密钥 |
| `COOKIE_SECURE` / `UBUNTU_COOKIE_SECURE` | `false` | 启用 HTTPS 反向代理后改为 `true` |
| `PUBLIC_ORIGIN` / `UBUNTU_PUBLIC_ORIGIN` | 空 | 反向代理真实外网 Origin，用于严格同源校验 |
| `GC_INTERVAL_MINUTES` | `15` | 空闲定时回收 JS 堆的周期（分钟），`0` 关闭 |
| `RSSHUB_INTERNAL_URL` | 空 | 仅由服务端设置的固定内网 RSSHub 地址（如 `http://rsshub:1200`） |
| `ADMIN_PASSWORD` / `UBUNTU_ADMIN_PASSWORD` | 空 | 仅兼容旧版无向导预置密码脚本，新建部署保持留空即可 |

三份机器人 Compose 配置均将 `DATA_ENCRYPTION_KEY` 传给机器人容器。修改 `.env`（Ubuntu 为 `.env.ubuntu`）后，需要重新创建容器才能加载新值，仅执行 `restart` 不会更新环境变量。已有明文 Cookie 不会自动迁移，需在后台重新保存或重新扫码；已加密 Cookie 需保留原密钥才能读取。密钥应单独备份，具体操作见 [平台 Cookie 加密配置](docs/delivery/01-部署与首次配置.md#平台-cookie-加密配置)。

---

## 六、测试、交付打包与干净开源导出

### 1. 运行测试

```bash
# 前端构建 + 全部 Node 测试
npm test

# Python Worker / 同步脚本单元测试（需先安装对应 Python 依赖）
python3 -m unittest test/document-worker-test.py test/rsshub-sync-test.py
```

### 2. 生成离线交付包

```bash
# 输出到 交付版本/<子目录>（含文件夹、ZIP、VERSION.json 与 SHA256SUMS）
npm run package:delivery -- 交付版本/v1.1.0

# 生成 Ubuntu tar.gz 压缩包
npm run package:ubuntu
```

### 3. 导出公开开源仓库（消除历史提交与本地工作区痕迹）

为防止早期 Git 提交记录里的服务器 IP、本地目录或 `.workbuddy/` 等工作区文件意外上传，**请勿直接把开发主仓库的历史推向公开远端**。可直接运行：

```bash
# 生成干净的单提交源码仓库至 release/opensource-repo（可用 --force 覆盖）
npm run export:opensource
```

导出脚本会自动过滤 `dist/`、`data/`、`.env*`、`.workbuddy/`、`.claude/`、`AGENTS.md`、`.githooks/`、`docs/GIT-WORKFLOW.md` 等文件，完成正则隐私校验，并使用匿名作者（默认为 `qunyu-bot <noreply@users.noreply.github.com>`，可通过环境变量 `OPENSOURCE_AUTHOR_NAME` 与 `OPENSOURCE_AUTHOR_EMAIL` 覆盖）创建单一干净提交，随后按终端提示推送至目标远端即可。

---

## 七、开源合规与免责声明

1. **开源许可证状态**：当前仓库默认按私有交付管理，根目录下暂未放置 `LICENSE` 文件且 [package.json](package.json) 标记为 `"private": true`。如决定公开开源，请先根据自身需求补充开源许可证（例如与所引用 Apache-2.0 / MIT 上游组件兼容的协议）。
2. **第三方组件说明**：项目引用的开源库、字体（Noto Emoji SIL OFL 1.1）及签到适配器修改范围和原许可文本完整保存于 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [src/checkin/notices/](src/checkin/notices/README.md)。
3. **第三方美术与商标素材**：
   * `frontend/src/assets/aemeath.png`（详见 [docs/artwork-sources.md](docs/artwork-sources.md)）及 `src/assets/`、`src/checkin/assets/`、`src/subscriptions/assets/` 中的二次元角色装饰素材仅作个人非商业界面展示，**不属于开源授权资产**；对外公开分支或二次分发前请自行移除或替换为可商用/开源授权图片。
   * [src/platform-icons](src/platform-icons/) 下为各社交平台公开网站图标，商标权归各平台所有，如移除对应 PNG，渲染卡片会自动省略图标。
4. **平台协议与账号风险**：本项目依赖 NapCat / OneBot 接入 QQ，并包含社交平台链接解析及游戏/社区每日签到功能。相关能力可能涉及第三方平台服务条款限制，存在账号风控、限流或接口失效风险，**仅供技术学习与个人自托管使用，禁止用于商业盈利或批量滥用**，一切使用后果由部署者自行承担。
5. **模型数据外发提示**：触发 AI 对话、识图或工具总结时，对应消息上下文与图片会发送至你配置的模型 API 服务商，请勿在群内提交高敏感个人隐私或机密凭据。

---

## 八、详细文档索引

| 类别 | 文档路径 |
| --- | --- |
| **部署与交付指南** | [交付总览](docs/delivery/README.md) ｜ [首次配置](docs/delivery/01-部署与首次配置.md) ｜ [运行维护排查](docs/delivery/02-运行维护与问题排查.md) ｜ [交付验收清单](docs/delivery/03-交付清单与验收.md) ｜ [Ubuntu 部署细节](docs/UBUNTU.md) ｜ [通用运维手册](docs/RUNBOOK.md) |
| **模型与回复能力** | [人设与聊天方式](docs/ds-persona.md) ｜ [OpenAI 兼容接入](docs/openai-api.md) ｜ [模型配置库](docs/model-library.md) ｜ [私聊与白名单](docs/private-chat.md) ｜ [图片细节识图](docs/images.md) ｜ [实时工作空间](docs/live-workspace.md) |
| **功能插件指南** | [酒馆角色扮演说明](docs/tavern.md) ｜ [订阅推送使用说明](docs/subscriptions.md) ｜ [RSSHub 维护指南](docs/rsshub-maintenance.md) ｜ [每日签到使用说明](docs/checkin.md) ｜ [Android Token 工具](docs/android-token-tool.md) ｜ [点歌与搜索说明](docs/music-and-web-search.md) |
| **账单、监控与版本** | [Token 账单与校准](docs/token-usage-and-pricing.md) ｜ [服务器状态与 GC](docs/server-resources.md) ｜ [变更日志](CHANGELOG.md) ｜ [第三方许可证清单](THIRD_PARTY_NOTICES.md) |
