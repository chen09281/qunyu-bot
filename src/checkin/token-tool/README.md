# 库街区 Token 工具 1.1.0

用于群成员获取自己的库街区 App token，并生成 `/签到 绑定 库街区 {...}` 命令。命令只发机器人私聊。

## 安卓 App

Android 8.0 及以上可直接安装 `kuro-token-android.apk`，不需要 Python 或 Scriptable。

1. 从 VPS 工具下载页选择“安卓 App”，下载 APK，按系统提示允许当前浏览器安装此应用。
2. 打开“库街区 Token 工具”，点“打开库街区官网”。在浏览器中手动完成人机验证并领取短信；收到后不要点击官网登录。
3. 返回工具 App，输入同一手机号和验证码，勾选新登录提示，点“获取 token 并生成命令”。
4. 成功后点“复制绑定命令”，只粘贴到机器人 QQ 私聊；以机器人“绑定成功”为准。
5. 已有 App token 或登录响应时，直接粘贴到“离线提取”。退出前可点“清空本页凭据”。

App 只需要网络权限，不读取短信、通讯录或其他 App 的账号；不写入账号文件，不恢复输入，不自动请求验证码。手机号和验证码直接提交给库街区官方 HTTPS 接口。凭据复制后会进入系统剪贴板，请勿再粘贴到群里。

管理员须从本项目源码构建签名 APK 放入 `data/downloads/kuro-token-android.apk`，下载页才会显示按钮。构建步骤见项目 `docs/android-token-tool.md`；私钥和 APK 不提交 Git。

## 电脑使用

1. 安装 Python 3.10 或更新版本，Windows 安装时勾选 Add Python to PATH。
2. 解压整个工具包，不要只从压缩包中打开单个文件。
3. Windows 双击 `启动.bat`；macOS / Linux 在解压目录执行 `python3 kuro_token.py`。浏览器会自动打开本机页面。
4. 点“打开库街区官网”，点击获取验证码并手动完成人机验证。收到短信后不要点击官网登录。
5. 回本机工具输入同一手机号与短信验证码，确认新登录可能使旧 App 会话失效，再获取 token。
6. 复制生成的完整命令，只发机器人私聊。以机器人“绑定成功”为准；工具不执行签到。
7. 退出时在终端按 Ctrl+C。工具不保存手机号、短信验证码或 token。

本机页面只监听 `127.0.0.1` 随机端口。若没有自动打开浏览器，把终端显示的本机地址复制到浏览器。标准库即可运行，无需 pip 安装依赖。这是 Python 源码版，不是免 Python 的 Windows EXE。

## iPhone 和 iPad

iOS 不能直接运行电脑 Python 包。可从 App Store 安装 Scriptable，下载本包的 `kuro-token-ios.js`。

1. 在 Safari 打开 VPS 工具下载页，下载 iOS 脚本；也可以展开页面上的完整源码并复制。
2. 打开 Scriptable，点右上角加号新建脚本，粘贴完整源码并保存。
3. 在 Scriptable 内运行，选择“用官网短信验证码获取”。不要在小组件里运行。
4. 在打开的库街区官网领取验证码并手动完成验证；收到短信后不要点官网登录。点“完成”回工具。
5. 输入同一手机号和验证码，确认登录；成功后点“复制绑定命令”，到 QQ 私聊机器人粘贴。

脚本直接向 `https://api.kurobbs.com/user/sdkLogin` 请求，不通过 VPS 代理账号数据。不需要安装抓包证书或描述文件。Scriptable 原生界面和网络由其运行环境提供，不能把该脚本当作独立 iOS 安装包。

## 已有 App token 或登录响应

电脑选“从已有登录响应提取”，粘贴自己的登录响应 JSON 或原始 token；iOS 先复制自己的响应，再选择“从剪贴板中的响应提取”。只有用户主动选择时才读取剪贴板。提取只解析文本，不发网络请求，也不验证账号是否仍有效。

若短信方式被官方风控拦截，可使用自己通过 App HTTPS 调试取得的 token。iOS 抓包只针对 `api.kurobbs.com`：查看库街区 App 的 `/user/sdkLogin` 响应 `data.token`，或库街区请求标头 `token`；不要复制鸣潮游戏 token、抽卡记录链接或 `refreshToken`。App 若阻止解密，不代表本工具能够绕过；停止调试，清理记录和临时证书信任。

## 常见情况

- 验证码错误或过期：重新到官网领取，勿先在官网消耗该验证码。
- 验证码通道不再兼容或官方拦截：本工具会停止并提示，不自动重试、发短信或通过人机验证；改用 App 已有响应提取。
- 重新登录库街区 App 后机器人登录失效：平台可能只保留一个 App 会话，请重新获取和绑定；希望共用会话时提取现有 App token。
- 账号信息错误：userId 是库街区社区用户 ID，不是游戏角色 UID。
- 提取成功不是绑定成功：把命令发机器人并查看实际回执。
- 自行搭建服务器者：下载包仅含本目录固定源码，无账号配置或聊天数据。

## 接口核对

实现由本项目编写，接口路径和字段核对自 `TomyJan/Kuro-API-Collection` 的 sdkLogin 文档与 `mxyooR/Kuro_login` 的 login.py；不包含第三方验证码代答代码。

- https://github.com/TomyJan/Kuro-API-Collection/blob/master/API/user/sdkLogin.md
- https://github.com/mxyooR/Kuro_login/blob/main/login.py
- https://docs.scriptable.app/request/
- https://docs.scriptable.app/alert/

平台接口可能变化；没有真实手机号与验证码时，模拟测试不代表真实账号登录已成功。
