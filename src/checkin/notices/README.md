# 签到适配器来源

本目录随 `src/` 一起进入 Docker 镜像和交付包，保留所参考/改写项目的许可文本。

| 项目 | 固定审查版本 | 使用范围 | 许可证 |
| --- | --- | --- | --- |
| [YueHen14/skyland-auto-sign](https://github.com/YueHen14/skyland-auto-sign) | `78366552a56170908546746ad3673a710acd8c41` | `src/SecuritySm.py` 的设备标识流程移植到 `skland-device.mjs`；`src/skyland.py` 的登录、签名和签到流程改写为 Node | MIT，原版权 xxyz30，完整文本见同目录 |
| [Womsxd/MihoyoBBSTools](https://github.com/Womsxd/MihoyoBBSTools) | `f062d1fda8fab88fd312a5ca3a89537f6351943b` | `gamecheckin.py`、`setting.py`、`tools.py`、`mihoyobbs.py` 的接口、活动 ID、签名和签到行为改写为 Node | MIT，原版权 Womsxd，完整文本见同目录 |
| [starudream/sign-task](https://github.com/starudream/sign-task) | `eb87b246b4e99aba8f851b52837867759e37c311` | `pkg/kuro/api` 的请求字段、角色、游戏和社区签到；其他平台接口交叉核对 | Apache-2.0，完整文本见同目录；该仓库已归档 |

改动：适配本项目的 Node HTTP 客户端、凭据结构、错误脱敏、成员绑定、取消与限流机制；不包含上游发帖、点赞、分享、消费补签、第三方验证码代答服务。适配器并非直接加载原项目，也不声称原作者为本项目提供支持。

另外检查了 [TomyJan/Yunzai-Kuro-Plugin](https://github.com/TomyJan/Yunzai-Kuro-Plugin) 的 `aba427c3cccbe4107c92a56b808a220f7acfd775` 版本（MPL-2.0），仅用于核对库街区当前接口路径、版本号和返回字段；未复制其实现。
