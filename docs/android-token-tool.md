# 库街区安卓工具构建说明

安卓原生源码位于 `src/checkin/token-tool/android/`，包名 `local.qqbot.kuro`，版本 1.1.0，最低 Android 8.0（API 26），target API 35。只有平台自带 Java / Android API，没有第三方运行库。功能与电脑、iOS 工具一致：手动在官网领短信，再直连官方 App 登录接口；或离线解析自己的 App 登录响应。不会自动发送短信、识别验证码、访问其他 App 数据。

## 准备工具链

从 [Android 官方下载页](https://developer.android.com/studio#command-line-tools-only) 安装命令行工具，使用 `sdkmanager` 安装 `platforms;android-35` 与 `build-tools;35.0.0`；安装 JDK 17 或以上版本。构建脚本使用 `javac`、`d8`、`aapt2`、`zipalign` 和 `apksigner`，不需要 Gradle 或 Android Studio。

## 构建和签名

在项目根目录执行（替换两项工具链路径）：

```sh
python3 src/checkin/token-tool/android/build.py \
  --jdk /path/to/jdk \
  --sdk /path/to/android-sdk \
  --output data/downloads/kuro-token-android.apk \
  --signing-dir data/kuro-android-signing \
  --create-key
```

首次使用 `--create-key` 在指定目录生成独立 PKCS12 签名密钥和随机密码文件。后续构建复用该目录，省略 `--create-key`；密钥丢失不会自动覆盖。请私下备份目录，App 更新需要相同签名。目录权限 0700，私钥与密码 0600，不在命令参数中传递密码。

脚本编译、转换 DEX、对齐并签名，检查 v2 签名后原子发布 APK，同时输出包含文件大小、SHA256、公钥证书 SHA256 的 JSON。构建临时文件自动清理。不要提交 `data/`、签名文件、APK 或工具链。

## VPS 下载发布

遵循项目 Git 约定：先在本机提交；仅在用户授权推送和部署后，VPS 从已推送版本取得源码。随后在 VPS 上用上述命令构建，输出到运行目录的 `data/downloads/kuro-token-android.apk`，不通过 SCP 上传代码或 APK。构建工具链无需放进机器人容器。

固定地址为 `/downloads/kuro-token-android.apk`，无需后台登录。文件必须是常规文件且不超过 10 MiB，不接受符号链接；缺失时返回 503，下载页不展示有效按钮。构建成功后下载页和 `/tools/kuro/manifest.json` 自动读取新文件，不需重启。只提供 GET/HEAD，不能上传账号数据；签名目录没有下载路由。

## 测试

`test/KuroProtocolTest.java` 在 JDK 上使用 JSON-java 测试协议，模拟登录、失败、风控、过期、格式注入和网络错误，验证输出兼容机器人。JSON-java 仅用于主机测试，不打包进 App。

```sh
KURO_ANDROID_JDK=/path/to/jdk \
KURO_ANDROID_JSON_JAR=/path/to/json-java.jar \
node --test test/kuro-android.test.mjs test/kuro-token-tool.test.mjs test/checkin.test.mjs
```

真实手机号验证码和安卓设备需要由账号持有人在本机验证；编译与签名校验不能替代真机登录测试。实现使用官方 HTTPS，禁止跟随重定向，不信任额外证书、不写账号存储；只有用户点复制时才写系统剪贴板。
