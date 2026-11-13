# RSSHub 订阅修复与维护说明

## 核对结果

自建 RSSHub 使用 `diygod/rsshub:chromium-bundled`，通过容器部署并配合 Cookie 同步脚本维持 B 站与抖音登录态，日常维护不得在未授权时改动宿主机配置、凭据、订阅或容器。

附件变更记录用于排查，不能代替代码和运行状态。几项更正如下：

| 原记录的说法 | 核对与修复 |
| --- | --- |
| PUT 必须提交全量字段 | `configure()` 合并提交字段，未提交的启用状态、间隔和地址会保留。写接口仍要求登录和同源校验。 |
| 修改 env 后 restart 就能加载 Cookie | Docker 重启保留创建时的环境。必须重建容器，并核对新容器实际加载的值；磁盘内容相同也不能跳过此核对。 |
| 只比较 SESSDATA 即可 | `bili_jct`、账号和指纹也可能变化。新工具比较完整有效 Cookie，并处理 `#HttpOnly_` 行。 |
| 每增加 UP 主都要修改 UID 数组 | 当前 RSSHub 从配置的 Cookie 池取登录态，并非按被关注 UP 主 UID 查找 Cookie。按登录账号配置一个池条目即可，新订阅不再依赖脚本维护名单。 |
| 只能暴露公网 80 | 普通后台 URL 继续限制公网与 80/443。服务器可单独配置固定内网 RSSHub；普通 RSS、图片和重定向不继承该例外。 |
| 1 秒响应代表 Cookie 有效 | 响应时间不能证明登录方式；应检查有效 RSS、所需条目、后台成功状态和容器实际环境。 |
| 注入 DOUYIN_COOKIE 必然恢复抖音 | 当前官方用户路由及请求工具没有读取该字段的代码，添加环境变量不能证明登录态已应用。无头浏览器和平台风控仍可能导致失败。 |

实现依据：[RSSHub B 站 Cookie 池](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/bilibili/cache.ts)、[B 站投稿路由](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/bilibili/video.ts)、[抖音用户路由](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/douyin/user.ts)、[抖音请求工具](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/douyin/utils.ts)。这些结论对应核对时的实现，升级 RSSHub 前应重新验证。

## 机器人侧修复

- RSSHub 路由读取上限改为 75 秒，允许上游 60 秒的浏览器等待返回结果。普通 RSS、GitHub 保持 25 秒。
- 自动检查以两个工作位推进，预览也共用两个读取名额，限制浏览器实例压力。已知同名 B 站仍等待本轮对应抖音结果，其他作者可继续检查。
- 抖音读取失败，或超过 `max(30 分钟, 检查间隔 × 3)` 未成功读取时，解除同群 B 站抑制；读取恢复后重新优先抖音。QQ 发送失败与消息源读取失败分别判断，不因 QQ 暂时失败直接更换平台。
- 消息源读取失败时，已经持久化的待发消息仍可按目标群重试；撤销授权、暂停、取消和跨重启去重规则继续生效。
- 后台显示 HTTP 状态、超时、登录页、格式错误等经过清理的原因，以及下次检查时间。不会显示 Cookie、原始错误响应或私有服务地址。

此修复不绕过抖音的登录验证或风控，也不将“未报错”冒充已恢复。若抖音路由仍失败，检查对应条目的错误；存在同名 B 站订阅时，按上述规则回退。

## 自建服务配置

`compose.rsshub.yaml` 只管理 RSSHub，项目名 `qqbot-rsshub`，容器名 `rsshub`，使用浏览器镜像和现有 `qunyu_default` 网络。凭据由 `./rsshub.env` 提供（可通过 `RSSHUB_ENV_FILE` 指定路径），文件需为 600，禁止提交。默认内存上限 1 GiB，可通过 `RSSHUB_MEMORY_LIMIT` 调整；本地诊断入口监听 `127.0.0.1:80`，不再发布到公网。

机器人运行环境增加：

```dotenv
RSSHUB_INTERNAL_URL=http://rsshub:1200
```

此项只由服务器管理员配置，不能通过后台请求修改。启用后，B 站、抖音及游戏官方动态使用这个固定服务；后台地址作为备用值保留，并明确显示当前服务受服务器管理。停用内部地址后重新使用备用公网地址。不同部署网络需同步设置 `RSSHUB_DOCKER_NETWORK`，不要猜测容器 IP。

### 首次迁移旧容器

迁移属于部署操作，必须取得本次明确部署授权；以下是操作顺序，不是自动执行任务。

1. 先部署含此次修复的机器人代码，确认原配置仍可工作。备份原 RSSHub 的镜像 ID、启动选项及私有环境文件；确认新 Compose 文件使用同一个凭据文件。
2. 暂停并备份旧的 `/etc/cron.d/rsshub-cookie-sync`，避免旧脚本同时写环境文件。不要删除凭据，也不要重置订阅数据。
3. 停止旧 RSSHub 并改名保留作回滚。按项目的新 Compose 文件启动 RSSHub，确认容器健康和网络别名 `rsshub` 可达；名称冲突时停止处理，不强删不明容器。
4. 在 `.env.ubuntu` 设置 `RSSHUB_INTERNAL_URL=http://rsshub:1200`，只重建机器人容器。使用“预览内容”核对各来源；它不发送群消息。需要检查实际推送时，再使用“检查更新”，该操作会发送新内容。
5. 运行下面的只读 Cookie 检查。只有确认 Compose 迁移完成后才启用新定时任务。
6. 保留旧容器、原环境文件备份和旧任务，确认新服务持续正常后再清理。回滚时恢复原 RSSHub 启动配置、机器人备用公网入口及原任务，不删除任何订阅已读记录。

## Cookie 同步工具

默认只读，不写文件、不重启、不重建：

```sh
sudo python3 scripts/rsshub-cookie-sync.py
```

输出仅包含是否需更新、是否需重建和 Cookie 池键名，不输出 Cookie。即使磁盘文件已被旧脚本改过，也会发现运行环境仍未加载的问题。

应用到已迁移的服务：

```sh
sudo python3 scripts/rsshub-cookie-sync.py --apply
```

工具要求登录状态为 `valid` / `refreshed`、最近 24 小时已检查、所需 Cookie 未过期且完整。登录无效、未检查、等待确认或数据损坏时保留原凭据并退出；先在机器人后台检查或重新登录后再试。

完整 Cookie 按登录账号组成一个 `BILIBILI_COOKIE_<DedeUserID>` 池条目；该工具面向机器人单账号登录，管理全部 `BILIBILI_COOKIE_*` 条目，不适用于手工维护的多账号池。抖音 Cookie、其他环境变量保留，不跨登录账号沿用旧指纹。

工具加锁、原子写入 600 文件，拒绝符号链接；只有识别到对应 Compose 项目才允许应用。更新后强制重建并比对容器实际环境；未确认时恢复原文件并执行回滚。回滚失败会明确提示，不记录凭据或上游响应。

迁移后定时任务可配置为下列形式，路径以 Git 部署后的目录为准：

```cron
17 * * * * root /usr/bin/python3 "/path/to/qq-bot/scripts/rsshub-cookie-sync.py" --apply >> /var/log/rsshub-cookie-sync.log 2>&1
```

不要继续执行旧 `/usr/local/bin/rsshub-cookie-sync`，也不要同时启用两套任务。
