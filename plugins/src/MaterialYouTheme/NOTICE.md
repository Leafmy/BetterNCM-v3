# 来源与许可（NOTICE）

本目录**不是原创作品**。这里发布的是对上游**已构建产物**的再分发，且只有 `manifest.json` 被改动。

## 上游来源

| 项 | 值 |
|---|---|
| 插件 | Material You Theme (NCM v3) |
| 版本 | v1.0.4 |
| 作者 | long45343 |
| 上游仓库 | https://github.com/long45343/material-you-theme-NCMv3 |
| 许可证 | **GPL-3.0**（已核对上游仓库的 `LICENSE` 文件：GNU GPL-3.0 全文，逐字节一致） |
| 取用基线 | Release v1.0.4 的 `dist/` |
| 更早的源头 | https://github.com/solstice23/material-you-theme-netease （GPL-3.0，2023-05 起停止维护，仅支持 NCM 2.x） |

## 本目录相对上游的改动

**只有 `manifest.json`。**

- **slug 重命名**：`material-u-theme-ncmv3` → `MaterialYouTheme`
- `name`：`Material You Theme (NCM v3)` → `Material You`
- `description`：改写为与 3.1.41 复核对齐的说明
- 新增 `"source"` 来源块（含 slug 保留原因）

`main.js` 与 `main.js.LICENSE.txt` 与上游归档**逐字节一致，未做改动**。

> **slug 为什么不能改回去**：`LyricBar` 与 `RefinedNowPlaying` 都通过
> `loadedPlugins.MaterialYouTheme` 做跨插件特性探测。改 slug 会静默破坏这两个插件。

## 许可

本作品是 GPL-3.0 作品的衍生/再分发，因此**本目录整体按 GPL-3.0 分发**：见同目录 `LICENSE`
（GNU GPL-3.0 全文，逐字节取自上游仓库，未做改动）。`main.js.LICENSE.txt` 为打包进 bundle 的
第三方依赖的许可证清单。

由于 `main.js` 未经修改，本目录实际是 GPL-3.0 作品的原样再分发 + 元数据修改；再分发本身即受 GPL-3.0 约束。
