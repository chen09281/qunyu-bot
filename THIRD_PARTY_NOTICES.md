# Third-party components

## Subscription feeds

RSS / Atom parsing uses [rss-parser](https://github.com/rbren/rss-parser), pinned to `3.13.0` in `package.json` and distributed under the MIT license. Its dependencies retain their own licenses in the installed npm packages. Bilibili video feeds are read over HTTP from an administrator-configured [RSSHub](https://github.com/DIYgod/RSSHub) instance; RSSHub source is not copied or bundled. Scheduling, administration, filtering and the QQ delivery queue are implemented in this project.

## Daily check-in adapters

签到适配器参考/改写自 MIT 许可的 [YueHen14/skyland-auto-sign](https://github.com/YueHen14/skyland-auto-sign)、[Womsxd/MihoyoBBSTools](https://github.com/Womsxd/MihoyoBBSTools)，以及 Apache-2.0 许可的 [starudream/sign-task](https://github.com/starudream/sign-task)。来源版本、改写范围和完整许可文本位于 [`src/checkin/notices/`](src/checkin/notices/README.md)，随运行源码一同打包。成员管理、后台页面、加密存储和调度逻辑由本项目实现。

## yt-dlp

Video extraction/download uses [yt-dlp](https://github.com/yt-dlp/yt-dlp), installed from the official PyPI distribution at the version pinned in `requirements-parser.txt`. It is invoked through its public Python API; no NoneBot framework or remote parsing service is bundled.

The yt-dlp source and PyPI distribution are released under the [Unlicense](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE). Its optional dependencies retain their own licenses, included with the installed packages. Docker also installs the Alpine FFmpeg package, which retains its original package license and notices. The implementation does not embed a copied extractor or strip upstream license files.

## Platform icons

`src/platform-icons/*.png` 是各社交平台公开的站点图标（favicon），仅用于在解析卡片右上角标明内容来源平台。图标版权归各自平台所有，本项目不主张任何权利；如平台要求移除，删除对应文件后卡片会自动省略图标。使用的字体为 Noto Sans CJK（SIL Open Font License 1.1），由 Alpine `font-noto-cjk` 包提供。

## python-docx

Word 文档使用 [python-docx](https://github.com/python-openxml/python-docx) 生成，版本在 `requirements-parser.txt` 中固定，遵循其 [MIT 许可证](https://github.com/python-openxml/python-docx/blob/master/LICENSE)。其依赖 lxml 保留自身的许可证；PDF 使用已安装的 Chrome / Chromium 在隔离的临时配置下打印本地 HTML，字体由操作系统或容器提供。


## Noto Emoji

Card rendering bundles the scalable monochrome [Noto Emoji](https://github.com/google/fonts/tree/main/ofl/notoemoji) font under the SIL Open Font License 1.1. The unmodified font, full license, source URL and SHA-256 are in [`src/fonts/`](src/fonts/README.md). It is loaded offline for musical notes and combined emoji.
