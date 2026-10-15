# LyricBar 0.3.6 — BetterNCM 3.1.41 适配

网易云音乐软件内歌词栏插件，针对 **BetterNCM 3.1.41 兼容层**（Orpheus / CEF 91）适配。

> ⚠️ **这是再分发内容，不是原创作品。**
> 上游：[`solstice23/lyric-bar-netease`](https://github.com/solstice23/lyric-bar-netease) · 作者 solstice23 · **MIT**
>
> 本目录相对上游**只修改了 `manifest.json`**；`main.js` 与上游发布包**逐字节一致**（已核对 SHA-256）。
> 来源、许可证与本目录的具体改动，见 [`NOTICE.md`](NOTICE.md)；许可全文见 [`LICENSE`](LICENSE)（逐字节取自上游仓库）。

## 改了什么

只有 `manifest.json`：

- 新增 `"ncm3-compatible": true`
- 新增 `"source"` 来源块（上游仓库 / 许可证 / 取用基线）

## 安装

本目录就是一个完整的未打包插件（`manifest.json` + `main.js`）。

**方式一：复制目录**（宿主同时接受解包目录与 `.plugin` 归档）
把整个目录复制到 BetterNCM 数据目录的 `plugins\` 下：

```
C:\betterncm\plugins\LyricBar\
    manifest.json
    main.js
```

**方式二：打成 `.plugin`**（用 BetterNCM 主仓库里的打包器）

```powershell
py tools\pack_plugin.py <本目录> -o <输出目录>
```

## 依赖

需要 **`RefinedNowPlaying`** 先加载，已在 `manifest.json` 里用 `requirements` / `loadAfter` 声明。

> 排序是**提示而非硬依赖**：跨插件取用请用 `plugin.onAllPluginsLoaded` + `betterncm.plugin.get(slug)` 做运行时探测。

## 相关

- BetterNCM 兼容层本体：本仓库根目录；插件开发指南：[`PLUGIN-COMPAT.md`](../../PLUGIN-COMPAT.md)
- 被适配的上游：[`solstice23/lyric-bar-netease`](https://github.com/solstice23/lyric-bar-netease)
