# macOS 启动教程

[Windows](启动-Windows.md) ｜ [macOS](启动-macOS.md) ｜ [Linux](启动-Linux.md)

macOS 使用 Docker Desktop 一体运行机器人后台与 NapCat，Node.js 用于执行本机启动脚本。

## 1. 安装运行环境

1. 按 [Docker Desktop for Mac 安装指南](https://docs.docker.com/desktop/setup/install/mac-install/) 下载对应 Apple Silicon 或 Intel 芯片的版本，打开 Docker Desktop，等待引擎启动完成。
2. 安装 [Node.js](https://nodejs.org/en/download)，推荐 Node.js 24 LTS，版本需为 24.12+；也兼容 Node.js 22.18+ 的 22.x 版本。
3. 打开「终端」确认环境：

```bash
node --version
npm --version
docker info
docker compose version
```

## 2. 进入应用并启动

在终端输入 `cd `（末尾保留一个空格），把包含 `package.json` 的应用文件夹拖入终端，再按回车。若软件外层有 `应用` 文件夹，拖入内层 `应用`。

```bash
npm run deploy
```

该命令会配对 NapCat、构建镜像并启动服务，前端依赖在镜像中安装，不需要先在本机运行 `npm install`。首次执行需联网下载镜像和依赖。

打开 [机器人后台](http://127.0.0.1:3080)，按 [首次配置](01-部署与首次配置.md) 创建账号、绑定 Key、登录 QQ 并设置授权群。默认只供本机访问，部署完成后可以关闭终端，Docker Desktop 需保持运行。

## 3. 停止、恢复与查看日志

在同一应用目录中按需执行：

| 操作 | 命令 |
| --- | --- |
| 停止后台和 QQ | `docker compose -f compose.integrated.yaml stop` |
| 恢复已停止的服务 | `docker compose -f compose.integrated.yaml start` |
| 更新代码后重新构建 | `npm run deploy` |
| 重启现有服务 | `docker compose -f compose.integrated.yaml restart` |
| 查看状态 | `docker compose -f compose.integrated.yaml ps` |
| 跟踪后台日志 | `docker compose -f compose.integrated.yaml logs --tail=100 -f qq-bot` |

日志界面按 `Ctrl+C` 只退出查看。保留应用目录中的 `data/` 和 `.env`；如配置了自定义数据路径，以该路径为准。

## 4. 只启动后台页面

如果已有 `dist/index.html`，也可在应用目录直接运行：

```bash
npm run start:prebuilt
```

打开 [机器人后台](http://127.0.0.1:3080)，按 `Ctrl+C` 停止。此方式仅启动后台，需要单独连接已有 NapCat，完整链接解析还需 Python、yt-dlp、Pillow 和 FFmpeg。缺少 `dist/` 时先执行 `npm ci`、`npm run build`。

不要让 Docker 后台与本机 Node 后台同时占用 3080 端口；出现 `EADDRINUSE` 时先停止原来的后台。Docker 引擎未就绪时，先打开 Docker Desktop，再用 `docker info` 确认。
