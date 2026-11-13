# 启动、停止与重启

版本 1.1.0。命令均在应用目录执行。新安装首次打开页面创建账号；已有安装使用原账号。停止或重启不会删除持久化数据，运行日志会清空。

## Ubuntu

```bash
sudo bash ubuntu.sh deploy
sudo bash ubuntu.sh status
sudo bash ubuntu.sh logs
sudo bash ubuntu.sh stop
sudo docker compose --env-file .env.ubuntu -f compose.ubuntu.yaml start napcat qq-bot
sudo bash ubuntu.sh restart
```

只重启后台：

```bash
sudo docker compose --env-file .env.ubuntu -f compose.ubuntu.yaml restart qq-bot
```

## Mac Docker

启动 Docker Desktop 后：

```bash
npm run deploy
docker compose -f compose.integrated.yaml stop
docker compose -f compose.integrated.yaml start
docker compose -f compose.integrated.yaml restart qq-bot
```

## 纯 Node 后台

包内有构建好的 `dist` 时：

```bash
npm run start:prebuilt
```

修改过前端源码时：

```bash
npm ci
npm start
```

在运行终端按 `Ctrl+C` 停止。不要同时启动多个后台争用同一端口。

## 二维码无法生成

后台会先自动处理：检测到登录服务卡死后，备份并清空 `data/napcat/qq`（保留最近两份 `qq.auto-*`），调用 NapCat 的 `RestartNapCat` 重启登录进程，再轮询新二维码，首次点击约需 30–60 秒。自动处理失败时再手动重启 NapCat 或清空目录，完整步骤见[运行维护与问题排查](delivery/02-运行维护与问题排查.md#qq-二维码无法生成)。

备份、恢复、密码重置和问题排查见 [维护文档](delivery/02-运行维护与问题排查.md)。
