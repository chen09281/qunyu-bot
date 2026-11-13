# Windows 启动教程

[Windows](启动-Windows.md) ｜ [macOS](启动-macOS.md) ｜ [Linux](启动-Linux.md)

Windows 使用 Docker Desktop + WSL2 Ubuntu 运行完整服务。安装步骤在 PowerShell 中完成；机器人启动、停止等命令在 Ubuntu 终端中执行。

## 1. 安装 WSL2 Ubuntu

按 [Microsoft WSL 安装指南](https://learn.microsoft.com/zh-cn/windows/wsl/install) 操作。以管理员身份打开 PowerShell：

```powershell
wsl --install -d Ubuntu
```

按提示重启 Windows，打开 Ubuntu，完成 Linux 用户名和密码设置。此账号用于 Ubuntu 的 `sudo`，与机器人后台账号无关。在 PowerShell 检查：

```powershell
wsl -l -v
```

确认 Ubuntu 的 VERSION 为 `2`。已有 WSL 时可执行 `wsl --update`；需要转换时执行 `wsl --set-version Ubuntu 2`。

## 2. 安装 Docker Desktop

安装 [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)，使用 Linux 容器和 WSL2 引擎。启动后进入 **Settings → Resources → WSL Integration**，启用 Ubuntu 并应用配置。参考 [Docker WSL2 集成说明](https://docs.docker.com/desktop/features/wsl/)。

在 Ubuntu 终端确认能连接引擎：

```bash
docker info
docker compose version
```

已有 Docker Desktop 时使用其 WSL 集成，无需在 Ubuntu 中重复安装另一套 Docker 引擎。本方式不要求 Windows 或 Ubuntu 单独安装 Node.js。

## 3. 放置应用并启动

在 Ubuntu 终端创建目录并查看 Linux 用户名：

```bash
mkdir -p ~/qunyu
whoami
```

在 Windows 文件资源管理器打开 `\\wsl.localhost\Ubuntu\home\你的Linux用户名\qunyu`，把应用文件复制到这里，使 `package.json`、`ubuntu.sh` 直接位于 `qunyu` 内。若软件外层有 `应用` 文件夹，复制其内部内容。推荐放在 Ubuntu 文件系统内，便于处理数据目录权限。

回到 Ubuntu 终端：

```bash
cd ~/qunyu
sudo bash ubuntu.sh deploy
```

首次启动会下载镜像并构建服务，保持 Docker Desktop 运行。看到后台健康运行后，在 Windows 浏览器打开 [机器人后台](http://127.0.0.1:3080)，按 [首次配置](01-部署与首次配置.md) 创建管理员、绑定 Key 和登录 QQ。

## 4. 停止、恢复与查看日志

以下命令均先在 Ubuntu 终端执行 `cd ~/qunyu`，再按需选择：

| 操作 | 命令 |
| --- | --- |
| 停止后台和 QQ | `sudo bash ubuntu.sh stop` |
| 恢复启动 / 更新代码后重新构建 | `sudo bash ubuntu.sh deploy` |
| 重启现有服务 | `sudo bash ubuntu.sh restart` |
| 查看状态 | `sudo bash ubuntu.sh status` |
| 跟踪后台日志 | `sudo bash ubuntu.sh logs` |
| 诊断服务 | `sudo bash ubuntu.sh doctor` |

日志界面按 `Ctrl+C` 只退出日志查看。修改端口或监听地址时编辑 `.env.ubuntu`，再运行 `deploy`；仅在本机使用可设置 `UBUNTU_BIND=127.0.0.1`。保留 `data/` 和 `.env.ubuntu`，停止容器不会删除记录。

如果 `docker info` 失败，先检查 Docker Desktop 引擎和 Ubuntu 集成；如果提示找不到 `ubuntu.sh`，检查当前路径是否为 `~/qunyu`，且没有多套一层 `应用` 目录。
