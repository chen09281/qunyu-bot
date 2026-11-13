# 帮助图片的配色与素材

核对日期：2026-10-24。配色参考平台自己的官网、公开样式文件和品牌说明，不采用下载站截图作为取色依据。下列颜色是本项目选择的代表色；除明确列出的品牌变量外，不声称是平台唯一的官方标准色。官网静态资源文件名可能随版本变化。

## 签到帮助

| 平台 | 本图主色 | 核对依据 |
| --- | --- | --- |
| 森空岛 | 荧光绿 `#C8EB21` | [官网](https://www.skland.com/) 加载的 [主题脚本](https://bbs.hycdn.cn/skland-fe-static/skland-bbs/3158.81328732.js) 明确包含 `brand_green_1: "#C8EB21"`、`brand_green_2: "#90C208"` |
| 米游社 | 亮蓝 `#00C3FF` | [官网](https://www.miyoushe.com/) 加载的 [样式文件](https://www.miyoushe.com/assets/index-BqjfWTmc.css) 包含 `.c-00c3ff` 蓝色类；同一文件还使用 `#00B1F7` 作为另一种蓝色 |
| 库街区 | 青色 `#00D2D6` | [官网](https://www.kurobbs.com/) 加载的 [主题样式](https://web-static.kurobbs.com/resource/prod/assets/index-CnHFA3OT.css) 中 `--kr-label-green: #00d2d6`、`--kr-label-deep-green: #14c4bc` |

品牌色用于卡片侧边和平台标签；正文、命令采用本地调配的深色，命令背景用对应浅色。保留阿米娅与派蒙装饰，素材与生成提示词见 [签到插画说明](../src/checkin/assets/README.md)。

## 订阅帮助

整体采用安妮亚的粉色与芙莉莲的薄荷绿、米白色。插画源文件、内置图像工具生成提示词见 [订阅插画说明](../src/subscriptions/assets/README.md)。四种来源分别设置标识色：

| 来源 | 本图主色 | 核对依据 |
| --- | --- | --- |
| B 站 | 粉色 `#FB7299` | [哔哩哔哩小程序官方配置文档](https://miniapp.bilibili.com/miniprogram-docs/reference/configuration/page) 中导航栏默认色为 `#fb7299` |
| 抖音 | 黑 `#16161A`、红 `#FE2D54` | [抖音开放平台](https://open.douyin.com/) 的 [基础样式](https://lf-developer-cdn.open-douyin.com/obj/open-platform-scm/ies/tiktok_open_pc/common/base.c84dde96.css) 使用红色 `#fe2d54`；其 [公共样式](https://lf-developer-cdn.open-douyin.com/obj/open-platform-scm/ies/tiktok_open_pc/common/vendor.7bd6afbb.css) 包含深黑 `#16161a` |
| GitHub | 绿 `#0FBF3E` | [GitHub 官方品牌颜色说明](https://brand.github.com/foundations/color) 的主色 GitHub Green；其品牌主色已不限于旧版黑白视觉 |
| RSS / Atom | 橙 `#EE802F` | [Mozilla Feed Icon Guidelines](https://www.mozilla.org/en-US/foundation/feed-icon-guidelines/) 说明橙白的通用 Feed 标识；具体色值为本图选用的近似橙色，不是 RSS 协议规定的颜色 |

## 酒馆帮助

`src/tavern/help.html`（`1080 × 2440`）使用纯离线 HTML/CSS 与本地系统无衬线/等宽中文字体排版渲染（零外部链接与图片），采用浅蓝、淡紫、粉紫与薄荷绿分层标识基础切换、导演控制、情绪羁绊互动及作用域隔离规则，底部提供 `/酒馆 文档` 完整 PDF 教程领取入口。

## 渲染与预览

签到、订阅与酒馆三张长图都由固定 HTML/CSS（及各自本地透明 PNG）离线生成，不需要从官网在线加载图片、字体或脚本。文字命令由 HTML 排版，插画不承载命令文本。整图为预览／运行时产物，不纳入 Git。

源码：`src/checkin/help.html`（1080 × 2800）、`src/subscriptions/help.html`（1080 × 2800）、`src/tavern/help.html`（1080 × 2440）。每次修改后检查实际 Chromium 输出尺寸、所有插画已加载、文字不溢出、不与插画重叠、底部文档指令完整可见。`/签到 帮助`、`/订阅 帮助` 与 `/酒馆 帮助` 仍各自只发送一张图，文档分别通过 `/签到 文档`、`/订阅 文档` 与 `/酒馆 文档` 获取。
