# Linux 启动教程

[Windows](启动-Windows.md) ｜ [macOS](启动-macOS.md) ｜ [Linux](启动-Linux.md)

以下以 Ubuntu 24.04 的本机或 VPS 为例，使用 Docker Engine + Compose 运行机器人后台和 NapCat。宿主机无需安装 Node.js / npm，也不需要 Docker Desktop。

## 1. 安装 Docker

按 [Docker 官方 Ubuntu 安装指南](https://docs.docker.com/engine/install/ubuntu/) 的「Install using the apt repository」步骤添加官方软件源，再安装 Docker Engine 和 Compose 插件。其他发行版从 [Docker Engine 安装入口](https://docs.docker.com/engine/install/) 选择对应指南。

已添加 Docker 官方 apt 软件源的 Ubuntu 可执行：

```bash
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker info
sudo docker compose version
```

已有 Docker 时先执行最后两条确认引擎和 Compose 正常，无需重复安装。

## 2. 进入应用并启动

将应用文件放在服务器上，例如 `/opt/qunyu`，确保该目录内直接包含 `package.json`、`ubuntu.sh` 和 `compose.ubuntu.yaml`。下面路径是示例，请改成自己的实际路径：

```bash
cd /opt/qunyu
sudo bash ubuntu.sh deploy
```

脚本会生成 `.env.ubuntu`，初始化数据目录权限、配对 NapCat、构建镜像并启动容器。首次执行需要访问 Docker 镜像仓库以及 npm / Python 软件源，等待出现健康运行提示。

默认访问地址：

- Linux 本机浏览器：[机器人后台](http://127.0.0.1:3080)。
- VPS：在浏览器地址栏输入 `http://服务器公网IP:3080`，将中文替换成真实 IP，保留 `:3080`。

VPS 的云安全组需允许你的设备访问 TCP 3080。NapCat 的 3000、6099 无需对公网开放。打开后台后按 [首次配置](01-部署与首次配置.md) 创建管理员、绑定 Key、登录 QQ 并设置授权群。

## 3. 停止、恢复与查看日志

以下命令均在应用目录中执行，按需选择：

| 操作 | 命令 |
| --- | --- |
| 停止后台和 QQ | `sudo bash ubuntu.sh stop` |
| 恢复启动 / 更新代码后重新构建 | `sudo bash ubuntu.sh deploy` |
| 重启现有服务 | `sudo bash ubuntu.sh restart` |
| 查看状态与端口 | `sudo bash ubuntu.sh status` |
| 跟踪后台日志 | `sudo bash ubuntu.sh logs` |
| 诊断服务 | `sudo bash ubuntu.sh doctor` |

日志界面按 `Ctrl+C` 只退出日志查看，容器继续运行。停止容器不会删除数据，保留 `data/` 和 `.env.ubuntu`；自定义数据目录以 `UBUNTU_DATA_DIR` 为准。

## 4. 修改访问地址和端口

```bash
sudo nano .env.ubuntu
```

常用配置：

```dotenv
UBUNTU_BIND=0.0.0.0
UBUNTU_PORT=3080
UBUNTU_DATA_DIR=./data
UBUNTU_ADMIN_PASSWORD=
```

`UBUNTU_BIND=0.0.0.0` 监听所有 IPv4 网卡；仅供本机或反向代理访问时设为 `127.0.0.1`。`UBUNTU_ADMIN_PASSWORD` 保持空值，首次访问时在页面设置账号密码。已有管理员时仍使用原账号。

保存后运行 `sudo bash ubuntu.sh deploy` 使端口配置生效。仅执行 `restart` 不会重新创建端口映射。已有 HTTPS 代理时，按 [配置说明](01-部署与首次配置.md#https-与访问配置) 设置访问来源与安全 Cookie。

## 5. 页面打不开时

先检查容器与本机健康接口：

```bash
sudo bash ubuntu.sh status
curl -i --max-time 5 http://127.0.0.1:3080/health
```

若改了端口，将 `3080` 换成实际值。本机返回 200 而公网访问失败时，检查安全组、实际绑定地址和网址端口；健康接口失败时执行 `sudo bash ubuntu.sh doctor` 查看错误。
