# Netflix 双语字幕(英语学习)

适用于 Safari 的用户脚本。在 Netflix 上选择中文(或其他非英语)字幕时,英语字幕会始终显示在原字幕下方,方便对照学习英语。

## 功能

- 英语字幕固定显示在你所选字幕的下方,全屏下同样可用。
- 如果你选的字幕本身就是英语,或该视频没有英语字幕,则不叠加。
- 优先使用普通字幕,没有时才退回听障字幕(如 `[door slams]`)。
- 快捷键 `Alt+E` 开关英语行,设置会被记住。

## 安装

1. 在 Safari 安装用户脚本管理器,如 [Tampermonkey](https://www.tampermonkey.net/) 或 [Userscripts](https://github.com/quoid/Userscripts)。
2. 在 Safari 设置的「扩展」中启用它,并允许它访问 `netflix.com`(Safari 默认每次询问,容易漏掉)。
3. 新建脚本,粘贴 [`netflix-bilingual.user.js`](./netflix-bilingual.user.js) 的全部内容并保存。
4. 打开 Netflix **首页**并刷新,再进入播放页,选择中文字幕即可。

> 脚本必须在进入播放页之前就已加载,否则抓不到字幕数据。装好或更新脚本后,请先在首页刷新,再开始播放。

## 工作原理

1. 脚本在 `document-start` 时被注入到页面自己的运行环境,钩住 `JSON.stringify` 和 `JSON.parse`(思路与 [Netflix - subtitle downloader](https://greasyfork.org/scripts/26654) 相同)。
2. Netflix 请求 manifest 时,脚本在请求的 `profiles` 里补上文本字幕格式(`webvtt-lssdh-ios8`、`dfxp-ls-sdh`、`simplesdh`、`imsc1.1`)。
3. 解析 manifest 响应,记下各语言字幕轨的下载地址(响应中的字幕轨列表可能叫 `timedtexttracks` 或 `textTracks`)。
4. 选出英语字幕轨,下载并解析(优先 WebVTT,否则 TTML)。
5. 每 100ms 按 `video.currentTime` 查找当前应显示的句子,绘制在播放器内,位于原生字幕下方。位置不够时,会把原生字幕整体上移。

## 配置

脚本顶部的常量:

| 常量 | 含义 | 默认值 |
| --- | --- | --- |
| `LEARN_LANG` | 始终显示的语言 | `'en'` |
| `FONT_RATIO` | 字号占播放器高度的比例 | `0.034` |
| `GAP_PX` | 与原生字幕的间距(像素) | `4` |

## 排查问题

在 Web Inspector 控制台过滤 `NF-Bilingual`,正常流程会依次出现:

```
hooks installed
manifest request patched
manifest <id> tracks: ...
using movie <id>, native lang=...
loaded N <格式> cues for <id>
```

- 没有任何 `NF-Bilingual` 日志:脚本没有运行,检查扩展是否启用、是否已授权访问 `netflix.com`。
- 有 `hooks installed` 但没有 `manifest request patched`:没在进入播放页前加载,回到首页刷新后重试。
- 有 `patched` 但没有 `manifest ... tracks`:Netflix 响应结构可能变了,运行 `__nfBilingual.dump()` 查看内部状态。
- `no usable en subtitle track`:该视频没有可用的英语文本字幕。

## 已知限制

- 依赖 Netflix 的内部数据结构和播放器 DOM(如 `.player-timedtext`、`netflix.appContext`),Netflix 改版后可能需要调整。
- 英语字幕轨若没有 WebVTT 格式,会走 TTML 解析,这条路径尚未在真实环境验证。
- 仅用于个人学习,字幕内容版权归 Netflix 及其权利方所有。
