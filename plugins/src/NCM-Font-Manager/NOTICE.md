# 来源与许可（NOTICE）

本目录**是本项目自研作品**，不是上游再分发：没有第三方上游仓库，也没有上游 `LICENSE` 需要逐字节保留。

| 项 | 值 |
|---|---|
| 插件 | NCM Font Manager |
| 版本 | 0.1.3 |
| slug | `NCM-Font-Manager` |
| 作者 | BetterNCM-v3（本项目） |
| 来源 | 本项目自研源码 |
| 许可证 | 随本仓库整体以 **GNU GPL-3.0-or-later** 分发，见仓库根 [`LICENSE`](../../LICENSE) |

## 本目录的文件与来源

| 文件 | 来源 |
|---|---|
| `index.js` | 本项目自研源码。**未压缩、未混淆**（1593 行，最长行 201 字符，无 sourceMappingURL、无打包器运行时） |
| `manifest.json` | 与源码同步；本目录版本只多了 `preview` / `source` 两个展示字段（与 `LyricBar` / `MaterialYouTheme` / `RefinedNowPlaying` 三个上游插件的清单风格一致） |
| `README.md` | 插件自己的文档，随源码一起维护 |

三份文件的原始形态与哈希（用于溯源）：

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `index.js` | 69,398 | `bfed40a1c2711c2d027ab5b571d448725acb957a5316779e648e83272fac1582` |
| `manifest.json`（增补前） | 549 | `2e00365e87bbef4c270e2df9e6250c15b386ab59e0410f671c3758230d5f616b` |
| `README.md` | 9,103 | `b3a323dbb17d7f549a42c1d18b2a4e3191678a133b2ff6bf8436685a8970b889` |

## 配套回归脚本的去向

`README.md` 引用了三个曾经的回归脚本：`test/font-cooperation.mjs`、`test/font-rendering.mjs`、
`test/fonts.mjs`。**这三个文件目前不在仓库里**，因此 README 里那三行「兼容回归 / 渲染回归检查」
暂时无法执行；插件本身的加载与打包由本仓库的通用套件覆盖（`test/plugin-ordering.test.mjs`、
`test/framework-api.test.mjs` 与插件市场的离线验收）。要恢复逐条字体行为的验证，需要重写这三个脚本。

## 授权边界

本插件不依赖任何未在本仓库实现的 API（只用 `betterncm.utils.waitForElement` /
`betterncm.ncm.call` / `betterncm.app.readConfig` / `betterncm.app.writeConfig` /
`betterncm.fs.writeFileText` 与 `plugin.onConfig`），也不修改客户端签名容器。
