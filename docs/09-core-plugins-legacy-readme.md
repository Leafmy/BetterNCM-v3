# `plugins/core` — 内置核心插件（不可删除、不可禁用）

这个目录里的插件与仓库一起分发，属于 **core plugin**：它们由宿主强制加载，
在插件管理 UI 中没有「启用/禁用」开关，也没有「卸载」按钮；即使伪造请求，
`POST /api/plugins/{disable,enable,uninstall}` 也会因为 `core` 判定返回 **403**。
判定逻辑只有一处：`tools/ncm_host.mjs` 的 `discoverAll()`（目录位于本目录下即 `locked`）。

## 为什么只有这三个

用户既有的 BetterNCM 插件集（`C:\betterncm\plugins`，22 个）已按
`tools/cleanup_plugins.ps1 -Apply` 备份到 `C:\betterncm\_backup_<ts>\` 并清空。
其中 `LyricBar` 与 `RefinedNowPlaying` 被保留并升级为内置插件；
`MaterialYouTheme` 以社区 3.x 重写版为基线重新引入。其余 19 个属于 2.10/3.0 时代，
既无维护也未适配 3.1.41，因此不再随本仓库分发。

## 目录

| 目录 | slug | 上游 | 许可证 | 基线 |
|---|---|---|---|---|
| `RefinedNowPlaying/` | `RefinedNowPlaying` | [SUlTlUS/refined-now-playing-netease-next](https://github.com/SUlTlUS/refined-now-playing-netease-next)（同源续作，作者含 solstice23） | MIT | 发布的 `.plugin` **3.0.2** |
| `LyricBar/` | `LyricBar` | [solstice23/lyric-bar-netease](https://github.com/solstice23/lyric-bar-netease) | MIT | 发布的 `.plugin` 0.3.6（上游没有任何 Release） |
| `MaterialYouTheme/` | `MaterialYouTheme` | [long45343/material-you-theme-NCMv3](https://github.com/long45343/material-you-theme-NCMv3)（派生自 [solstice23/material-you-theme-netease](https://github.com/solstice23/material-you-theme-netease)） | GPL-3.0 | release `v1.0.4` 的 `dist/` |

## 为什么 `RefinedNowPlaying` 换了基线（实测依据）

原本计划沿用本机商店版 `RefinedNowPlaying 2.19.5`。**实测证明它在 3.1.41 上不可能工作**：

对 web.pack `477f8a2` 的全部 JS + CSS + HTML 做字面计数，2.19.5 依赖的**整套 DOM 词汇已不存在**：

| 选择器 | 出现次数 |
|---|---:|
| `#main-player` | **0** |
| `.m-player` / `.m-player-fm` | **0** / **0** |
| `.g-single` / `.g-singlec-ct` | **0** / **0** |
| `.n-single` `.cdimg` | 4 / **0** |
| `.btnp` / `.btnp-pause` | **0** / **0** |
| `.brt` | 30（但不在播放条语境） |
| `.g-mn` / `.playfrom` / `.cvr.j-curr` | **0** / **0** / **0** |
| `#page_pc_userfm_songplay` | **0** |

同一份 bundle 里也没有**任何** 3.x 特征：`Container_` 0 次、`[class^=` 0 次、`[class*=]` 0 次；
它的"版本分支"只区分 `< 2.10.6` 与 `>= 2.10.6`，没有 3.x 分支。
而它的挂载方式就是往 `.g-single` 里渲染整个正在播放页 —— 目标不存在，所以**加别名层也救不回来**：
那等于我们自己重建一遍 2.x 的播放器外壳。

因此改用同源、明确支持 3.x 的续作 `RefinedNowPlayingNext 3.0.2`：
`ncm-version-req: "> 3.1.11"`、`ncm3-compatible: true`、2026-07 仍在更新，且**自带 3.1.11+ 的
hijack 规则**（`"sagaEffects.put"),` → 注入 `window.rnpDispatchHook`，见下）。
它自建 `#rnp-view` 渲染自己的页面（其 bundle 内 `class="g-single"` 是**它自己**创建的、
`g-singlec` 出现 163 次），因此不再依赖客户端已消失的 2.x DOM。

**slug 固定为 `RefinedNowPlaying`**（上游发布名是 `RefinedNowPlayingNext`）：
它的 bundle 只探测 `loadedPlugins.{LibFrontendPlay,MaterialYouTheme,RoundCornerNCM}`、
**从不读自己的 slug**，所以改名安全；这样 LyricBar 的 `requirements: ["RefinedNowPlaying"]`
以及用户认知都保持不变。

它仍然保留 `lyrics-updated` / `window.currentLyrics` / `onProcessLyrics` 契约
（分别出现 6 / 9 / 4 次）——这正是 LyricBar 依赖的接口。

原始 2.19.5 归档保留在 `_upstream/RefinedNowPlaying-2.19.5.plugin` 供溯源与对比。


`_upstream/` 保存**未经修改**的上游归档，用于溯源与回归对比；它里面没有
`manifest.json`，因此不会被插件扫描器识别。改动记录写在各自的 `manifest.json`
（`source` 字段）以及本文件的「改动清单」里。

## 关于 slug

三个内置插件都使用**不带版本后缀的原 slug**。这不是形式问题：

- `RefinedNowPlaying` 会读 `loadedPlugins.RefinedNowPlaying.manifest.version`；
- `LyricBar` 用 `loadedPlugins.MaterialYouTheme` 决定是否加 `no-material-you-theme`；
- 其它插件也会按 slug 探测彼此（`loadedPlugins.LibFrontendPlay` 等）。

上游商店归档里 `RefinedNowPlaying` 的 manifest 没有 `slug` 字段，宿主会退化成
文件名（`RefinedNowPlaying-2.19.5`），于是上述探测全部失效——这里显式补上 `slug`。
`MaterialYouTheme` 同理：上游 3.x 重写版用的是 `material-u-theme-ncmv3`，
这里改回 `MaterialYouTheme`，否则 `LyricBar`/`RefinedNowPlaying` 的跨插件检测会一直落到
「没有 Material You 主题」的分支。

## 改动清单（相对于上游归档）

### RefinedNowPlaying

1. 基线整体替换为本目录说明的 `RefinedNowPlayingNext 3.0.2`（见「为什么换了基线」）。
2. `manifest.json`：slug 固定为 `RefinedNowPlaying`；新增 `core`、`source`（含替代理由与 slug 说明）、
   `ncm-version-req: "> 3.1.11"`；`loadAfter` 收敛为仍在分发的 `MaterialYouTheme`。
3. `manifest.json` 的 `hijacks` 改为**委托内置规则**：
   - `module:redux-dispatch-hook` → `builtin:redux-dispatch-hook`（续作自带的 3.1.11+ 机制）；
   - `module:lyrics-pipeline` → `builtin:lyrics-hook`（让歌词管线调用 `onProcessLyrics`）。
   两条规则的原片段已对本机 web.pack `477f8a2` 逐一验证：分别命中 1 次与 2 次，
   且 `COMMITHASH` 与规则记录一致（`test/preload-engine.test.mjs` 每次都会重新断言）。
4. **删掉**续作自带的 `>= 2.10.4` 那条（目标 `orpheus://orpheus/pub/core` 在 3.1.41 不存在，
   留着只会被报成 miss）；原条目保留在 `manifest.upstream.json` 与 `legacy_hijacks` 中溯源。
5. `main.js`：与上游发布产物**字节一致**（772,002 字节，未改动）。

### LyricBar

1. `manifest.json`：新增 `core`、`ncm3-compatible`、`source`。`requirements`/`loadAfter`
   保持指向 `RefinedNowPlaying`——宿主的 core 加载顺序会遵守它。
2. `main.js`：**尚未改动**。它依赖的 `#main-player` / `.m-player .btnp` / `.g-mn` 在 3.1.41
   全部不存在（实测 0 次），所以：
   - **数据通路可用**：消费 RNP 的 `lyrics-updated` + `window.currentLyrics`；
   - **DOM 探测退化**：暂停态识别与「纯音乐」判定会失效；
   - 它把词栏挂到 `document.body`，所以仍能显示，但无法读取播放器的内部状态。
   真机核对后再决定是补一层选择器映射还是改成消费 RNP 暴露的状态。


### MaterialYouTheme

1. `manifest.json`：`slug` 由 `material-u-theme-ncmv3` 改为 `MaterialYouTheme`，
   新增 `core`、`source`（含 GPL-3.0 与派生来源声明）。
2. `main.js`：**尚未改动**。上游只声明在 3.1.39 测试过，3.1.41 的 DOM/CSS 需要实测校对。

## 还没做完的部分（诚实的现状）

宿主侧已经全部落地：`loadedPlugins` 的 slug 属性访问、同步 `ncm.getPlaying()`、
`getSucceededHijacks()` 返回真实命中、`app.exec` 开外链、`notSupported` 不再返回 `null`、
`plugin.onConfig` 的 `config` 事件，以及**两条 hijack 规则**（`builtin:lyrics-hook`、
`builtin:redux-dispatch-hook`）——两条都已对本机 web.pack 做片段与 `COMMITHASH` 双重验证。

还差的是**实机收敛**（需要客户端在运行）：

- `RefinedNowPlayingNext`：它自建 `#rnp-view`，理论上不再依赖客户端旧 DOM；但它的若干
  `querySelector`（`footer .middle button`、`.n-single .cdimg`、`.info .playfrom …`）在
  3.x 上是否仍能命中、以及 `rnpDispatchHook` 是否真的收到 redux action，需要实机确认。
  若有落空项，优先在 `loader/selectors.json` + 别名层里补，而不是改它的 bundle。
- `LyricBar`：数据通路可用，DOM 探测退化（见上）。需要真机看一眼词栏是否正确显示与滚动。
- `MaterialYouTheme`：上游只声明测过 3.1.39，需要 3.1.41 的视觉回归（它用的是 3.x 的属性前缀
  匹配与 CSS 变量：`[class*=]` 299 次、`Container_` 78 次，路线是对的）。

### 若歌词仍未出现，先看这两个地方

1. `window.__BNCM_HIJACK__.applied` 是否含 `builtin:redux-dispatch-hook` 与 `builtin:lyrics-hook`；
   若 `missed` 里有它们 → 前端包已更新，跑 `tools\hijack_probe.mjs` 重新推导。
2. 插件管理 UI 的**诊断**页：预载是否 hook 了 webpack、`React`/`ReactDOM`/`legacyNativeCmder`
   是否存在。三者缺一，React 插件都不会渲染。

