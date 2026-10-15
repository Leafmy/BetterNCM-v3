# Material You (MaterialYouTheme) v1.0.4 — BetterNCM 3.1.41 适配

动态取色的 Material You 主题，针对 **BetterNCM 3.1.41 兼容层**（Orpheus / CEF 91）适配。

> ⚠️ **这是再分发内容，不是原创作品。**
> 上游：[`long45343/material-you-theme-NCMv3`](https://github.com/long45343/material-you-theme-NCMv3) · 作者 long45343 · **GPL-3.0**
>
> 更早的源头：[`solstice23/material-you-theme-netease`](https://github.com/solstice23/material-you-theme-netease)（GPL-3.0，2023-05 起停止维护，仅支持 NCM 2.x）
>
> 本目录相对上游**只修改了 `manifest.json`**；`main.js` 与 `main.js.LICENSE.txt` 与上游**逐字节一致**。
> 来源、许可证与本目录的具体改动，见 [`NOTICE.md`](NOTICE.md)；许可全文见 [`LICENSE`](LICENSE)（逐字节取自上游仓库）。

## 改了什么

只有 `manifest.json`：

- **slug 重命名**：`material-u-theme-ncmv3` → `MaterialYouTheme`
- `name`：`Material You Theme (NCM v3)` → `Material You`
- `description`：改写为与 3.1.41 复核对齐的说明
- 新增 `"source"` 来源块

> **slug 为什么不能改回去**：`LyricBar` 与 `RefinedNowPlaying` 都通过
> `loadedPlugins.MaterialYouTheme` 做跨插件特性探测。改 slug 会**静默破坏**这两个插件。

## 许可证

上游声明为 **GPL-3.0**，因此本目录按 **GPL-3.0** 分发（见 [`LICENSE`](LICENSE)，全文逐字节取自上游仓库）。
`main.js.LICENSE.txt` 列出了打包进 bundle 的第三方依赖的许可证。

## 安装

**方式一：复制目录**把整个目录复制到 BetterNCM 数据目录的 `plugins\` 下：

```
C:\betterncm\plugins\MaterialYouTheme\
    manifest.json
    main.js
    main.js.LICENSE.txt
```

**方式二：打成 `.plugin`**（用 BetterNCM 主仓库里的打包器）

```powershell
py tools\pack_plugin.py <本目录> -o <输出目录>
```

## 相关

- BetterNCM 兼容层本体：本仓库根目录；插件开发指南：[`PLUGIN-COMPAT.md`](../../PLUGIN-COMPAT.md)
- 被适配的上游：[`long45343/material-you-theme-NCMv3`](https://github.com/long45343/material-you-theme-NCMv3)
