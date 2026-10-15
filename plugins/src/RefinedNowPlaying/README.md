# RefinedNowPlaying 3.0.2 — BetterNCM 3.1.41 适配

重新设计的正在播放页面与歌词，针对 **BetterNCM 3.1.41 兼容层**（Orpheus / CEF 91）适配。

> ⚠️ **这是再分发内容，不是原创作品。**
> 上游：[`SUlTlUS/refined-now-playing-netease-next`](https://github.com/SUlTlUS/refined-now-playing-netease-next) · 上游 `author` 字段：MiHN / solstice23 · **MIT**
>
> 上游发布名为 **`RefinedNowPlayingNext` 3.0.2**；本目录把它固定为 slug `RefinedNowPlaying`。
>
> 本目录相对上游**只修改了 `manifest.json`**；`main.js` 与上游发布包**逐字节一致**（已核对 SHA-256）。
> 来源、许可证与本目录的具体改动，见 [`NOTICE.md`](NOTICE.md)；许可全文见 [`LICENSE`](LICENSE)（逐字节取自上游仓库）。

## 为什么用 3.0.2 而不是原版 2.19.5

原版 2.19.5 依赖的整套网易云音乐 **2.x DOM 在 3.1.41 上出现 0 次**：
`#main-player`、`.m-player`、`.g-single`、`.n-single`、`.cdimg`、`.btnp`、`.brt`、
`.cvr.j-curr`、`.playfrom`、`#page_pc_userfm_songplay` 全部不存在，
且其 bundle 内没有任何 3.x 特征（`Container_` 0 次）。**无法靠适配或别名层救回。**

3.0.2 是同源续作，声明 `ncm3-compatible: true`、要求 `ncm > 3.1.11`，并自带 3.1.11+ 专用钩子。

## 改了什么

只有 `manifest.json`（另新增 `manifest.upstream.json` 存放上游原始清单，用于溯源）：

- **slug 重命名**：`RefinedNowPlayingNext` → `RefinedNowPlaying`
- `name`：`RefinedNowPlayingNext` → `RefinedNowPlaying`
- `loadAfter`：由 `["MaterialYouTheme","LibFrontendPlay","SimpleAudioVisualizer"]` 收窄为 `["MaterialYouTheme"]`
- `hijacks`：改为加载器的 `builtin:` 规则形式（`builtin:redux-dispatch-hook`、`builtin:lyrics-hook`），
  上游的响应体重写写法移入 `legacy_hijacks` 存档
- 新增 `source`、`hijack_note`、`legacy_hijacks`

> **署名**：`manifest.json` 的 `author` 保留了上游写法 `MiHN, solstice23, long45343 lineage (see source)`。
> 许可依据不看这个字段：同目录 `LICENSE` 逐字节取自上游仓库的 `LICENSE`（`master`），
> 其版权行为 `Copyright (c) 2022 solstice23`——上游仓库自身沿用的原始公告，本项目未改写。

## 安装

**方式一：复制目录**把整个目录复制到 BetterNCM 数据目录的 `plugins\` 下：

```
C:\betterncm\plugins\RefinedNowPlaying\
    manifest.json
    main.js
```

**方式二：打成 `.plugin`**（用 BetterNCM 主仓库里的打包器）

```powershell
py tools\pack_plugin.py <本目录> -o <输出目录>
```

## 相关

- BetterNCM 兼容层本体：本仓库根目录；插件开发指南：[`PLUGIN-COMPAT.md`](../../PLUGIN-COMPAT.md)
- 被适配的上游：[`SUlTlUS/refined-now-playing-netease-next`](https://github.com/SUlTlUS/refined-now-playing-netease-next)
