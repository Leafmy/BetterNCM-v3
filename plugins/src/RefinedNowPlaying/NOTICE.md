# 来源与许可（NOTICE）

本目录**不是原创作品**。这里发布的是对上游**已构建产物**的再分发，且只有 `manifest.json` 被改动。

## 上游来源

| 项 | 值 |
|---|---|
| 插件 | RefinedNowPlayingNext |
| 版本 | 3.0.2 |
| 作者 | MiHN, solstice23（上游 `author` 字段） |
| 上游仓库 | https://github.com/SUlTlUS/refined-now-playing-netease-next |
| 许可证 | MIT（已核对上游仓库的 `LICENSE` 文件，见下） |
| 取用基线 | 已发布的 `.plugin` 归档 RefinedNowPlayingNext 3.0.2 |
| 取代 | solstice23/refined-now-playing-netease 2.19.5（其 2.x DOM 在客户端 3.1.41 上已完全不存在） |

## 本目录相对上游的改动

**只有 `manifest.json`**，另有新增的 `manifest.upstream.json`（上游原始清单，用于溯源）。

- **slug 重命名**：`RefinedNowPlayingNext` → `RefinedNowPlaying`（为保持 `LyricBar` 的
  `requirements` / `loadAfter` 与用户可见名称稳定）
- `name`：`RefinedNowPlayingNext` → `RefinedNowPlaying`
- `loadAfter`：由 `["MaterialYouTheme","LibFrontendPlay","SimpleAudioVisualizer"]` 收窄为 `["MaterialYouTheme"]`
- `hijacks`：改为本加载器的 `builtin:` 规则形式（`builtin:redux-dispatch-hook`、`builtin:lyrics-hook`），
  上游的响应体重写写法移入 `legacy_hijacks` 存档
- 新增 `source`、`hijack_note`、`legacy_hijacks`
- `author` 字段补了 `long45343 lineage (see source)` 的说法

`main.js` 与上游归档**逐字节一致，未做改动**。

> **署名**：`manifest.json` 的 `author` 保留了上游写法 `MiHN, solstice23, long45343 lineage (see source)`。
> 许可依据不看这个字段（见下节）：`LICENSE` 逐字节取自上游仓库的原文件。

## 许可

同目录 `LICENSE` **逐字节取自上游仓库的 `LICENSE`**（`master`）：MIT，版权行是上游原文的
`Copyright (c) 2022 solstice23`。本目录未改写、未重排版该文件。

值得说明的是：上游 `manifest.json` 的 `author` 字段写的是 `MiHN, solstice23`（本项目原样保留），
而上游仓库自己的 `LICENSE` 版权行只有 `solstice23` —— 这与「3.0.2 是 solstice23 原作的续作」一致。
本目录以**上游 `LICENSE` 原文件**为准，而不是以 `author` 字段推测的署名为准。
