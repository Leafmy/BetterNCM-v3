# 09 — 内置核心插件

> **本文写于 P15「插件解耦」之前。** 现状以 `docs/20-plugin-uniformity.md` 为准：三个插件**不再是
> `plugins/core/` 下的内置插件**，而是普通用户插件（`plugins/*.plugin`，
> 由 `loader/paths.ps1` 的 `Install-BncmPlugins` 统一安装、无锁定、可禁用/卸载）。
> 本文保留上游出处、许可证与那句"为什么 RNP 换成 3.x 续作"的实测依据；凡是出现
> "内置于 `plugins/core`"、"锁定"、"core 三个" 的段落都已被 P15 取代。
> 依赖链 `MaterialYouTheme ← RefinedNowPlaying ← LyricBar` 仍然成立，且在 P20 修复后**真正被执行**。

> 目录：`plugins/core/` · 详见 `plugins/core/README.md`（含上游出处、许可证、逐条改动清单）

## 为什么是 `plugins/core` 而不是普通插件

用户既有的 22 个插件已按 `tools/cleanup_plugins.ps1 -Apply` 备份到
`C:\betterncm\_backup_<时间戳>\` 并清空（清单含逐项 SHA-256，`-Verify` 可复验）。
其中三个被**内置**：它们是用户明确要求保留的能力，因此不放在可被卸载的目录里，
而是随仓库分发、由宿主强制加载，并在管理 UI 中显示为「锁定」。

`MaterialYouTheme` 原本不在用户插件集里（只有 `relive-theme` 等），它是按需求重新引入的。

## 三个插件

| slug | 上游 | 许可证 | 基线 |
|---|---|---|---|
| `RefinedNowPlaying` | [SUlTlUS/refined-now-playing-netease-next](https://github.com/SUlTlUS/refined-now-playing-netease-next)（同源续作，作者含 solstice23） | MIT | 发布的 `.plugin` **3.0.2** |
| `LyricBar` | [solstice23/lyric-bar-netease](https://github.com/solstice23/lyric-bar-netease) | MIT | 发布的 `.plugin` **0.3.6** |
| `MaterialYouTheme` | [long45343/material-you-theme-NCMv3](https://github.com/long45343/material-you-theme-NCMv3) | GPL-3.0 | release **v1.0.4** 的 `dist/` |

注意 RNP / LyricBar 的**原**上游仓库已停滞（RNP 最后提交 2024-01，GitHub Release 停在 2.8.1，
2.19.5 只在插件商店发布；LyricBar 无 Release、最后提交 2023-04，没有 ncm3 分支）。

### 为什么 RNP 换成了续作（实测，非猜测）

原计划用商店版 `RefinedNowPlaying 2.19.5`，但**实测它在 3.1.41 上不可能工作**：对 web.pack
`477f8a2` 的全部 JS+CSS+HTML 做字面计数，它依赖的整套 2.x DOM 已全部消失 ——
`#main-player` 0、`.m-player` 0、`.g-single` 0、`.cdimg` 0、`.btnp` 0、`.g-mn` 0、
`.playfrom` 0、`.cvr.j-curr` 0、`#page_pc_userfm_songplay` 0；而同一份 bundle 里
`Container_` 0、`[class^=` 0（没有任何 3.x 特征），版本分支也只区分 `< 2.10.6` 与 `>= 2.10.6`。
它把整个正在播放页渲染进 `.g-single` —— 目标是空的，**加别名层也救不回来**（那等于重建 2.x 播放器外壳）。

因此改用同源续作 `RefinedNowPlayingNext 3.0.2`：`ncm-version-req: "> 3.1.11"`、
`ncm3-compatible: true`、2026-07 仍在更新、自带 3.1.11+ 的 hijack 规则，且自建 `#rnp-view`
渲染自己的页面（不依赖客户端旧 DOM）。slug 固定为 `RefinedNowPlaying`
（它的 bundle 从不读自己的 slug，只探 `MaterialYouTheme`/`LibFrontendPlay`/`RoundCornerNCM`）。
它保留了 `lyrics-updated` / `window.currentLyrics` / `onProcessLyrics` 契约，
即 LyricBar 消费的接口。原始 2.19.5 归档留在 `_upstream/` 供溯源。


`MaterialYouTheme` 原仓库（`solstice23/material-you-theme-netease`，GPL-3.0）最后提交 2023-05、
只适配 NCM 2.x 选择器；社区 3.x 重写版 `long45343/material-you-theme-NCMv3` 声明
`ncm3-compatible: true` 且标注"仅在 3.1.39 测试"。经确认采用后者为基线，
并**把 slug 改回 `MaterialYouTheme`**——跨插件检测依赖这个名字。

## slug 必须保持规范化

三个插件的 slug 都是**不带版本后缀的原名**。这不是形式问题：

- RNP 读 `loadedPlugins.RefinedNowPlaying.manifest.version`；
- LyricBar 用 `loadedPlugins.MaterialYouTheme` 决定是否加 `no-material-you-theme`；
- 商店归档里 RNP 的 manifest **没有 `slug` 字段**，宿主会退化成文件名
  （`RefinedNowPlaying-2.19.5`），上述探测全部失效 → 这里显式补上 `slug`。

## 依赖关系

```
MaterialYouTheme  ←(loadAfter)←  RefinedNowPlaying  ←(requirements/loadAfter)←  LyricBar
                                        ↑
                          window.onProcessLyrics（客户端歌词管线调用）
                                        ↑
                       loader/hijacks.json: builtin:lyrics-hook（见 docs/11）
```

**LyricBar 是 RNP 的纯消费者**：它没有 hijack、不定义钩子，只监听 RNP 派发的
`lyrics-updated` 事件并读 `window.currentLyrics`。所以歌词钩子不通，两个插件同时失效。

## 当前完成度（诚实说明）

已完成：

- 三个内置于 `plugins/core/`，显式 `slug`、`core: true`、`ncm3-compatible: true`、出处与许可证；
- **RNP 基线替换为 3.x 续作**（依据见上），保留 `lyrics-updated`/`window.currentLyrics` 契约；
- 宿主的 core 分区、强制加载、403 锁定保护（`test/manager.cmd` 覆盖）；
- **两条 hijack 规则**，均对本机 web.pack 做片段唯一性与 `COMMITHASH` 双重验证：
  - `builtin:redux-dispatch-hook`（续作自带的 3.1.11+ 机制，命中 1 次，位于
    `vendors~app~subApp.chunk`）；
  - `builtin:lyrics-hook`（歌词管线调用 `onProcessLyrics`，命中 2 次：app + subApp chunk）；
- 框架侧的阻塞缺陷全部修复：`loadedPlugins` 按 slug 可达、同步 `ncm.getPlaying()`、
  `getSucceededHijacks()` 返回数组、`notSupported` 不再一律返回 `null`、
  `plugin.onConfig` 真正执行、`app.exec` 可开外链、`betterncm_native.app.restart/reloadIgnoreCache`。

尚未完成（需要客户端在跑才能收敛）：

- **实机确认 `rnpDispatchHook` 是否收到 redux action**，以及 RNP-Next 自建 DOM 的渲染；
- **LyricBar 的 DOM 探测退化**：它的数据通路（RNP 的 `lyrics-updated`）可用，但
  `#main-player` / `.m-player .btnp` / `.g-mn` 在 3.1.41 全为 0，暂停态与「纯音乐」判定会失效。
  它把词栏挂到 `document.body`，所以仍应显示；需要真机确认后决定是补选择器映射还是改数据源。
- **MaterialYouTheme 的 3.1.41 视觉回归**（上游只声明测过 3.1.39）。它走 3.x 的属性前缀匹配与
  CSS 变量（`[class*=]` 299 次、`Container_` 78 次），路线正确，缺的是视觉核对。


## "Hijack 错误" 弹窗：已解决，且不是靠假装成功

RNP-Next 会显示一条红字提示：

> Hijack 错误 — Refined Now Playing Next 无法正常工作，可能导致歌词无法显示。请重启网易云以修复此问题。

触发条件（从 `main.js` 反推）：**`betterncm.app.getSucceededHijacks()` 里没有包含
`RefinedNowPlaying` 的条目**。因为我们不启用页面改写，这个列表原本是空的，于是它对一个
**并不存在的问题**告警。

实测把这条链路彻底查清了：

1. 包住 `window.onProcessLyrics` 后发现**客户端根本不调用它**（`nativeCalls` 始终为 0），
   而 `window.currentLyrics` 照样填满 **43 行**；
2. `window.rnpDispatchHook` 只是喂给**同一个** `sn()` 处理函数的另一条入口；
3. 结论：**RNP-Next 3.x 用自己的客户端通路取并处理歌词**。它 manifest 里的两条 hijack
   （2.10.4 的解析器替换、3.1.11 的 redux hook）在这台客户端上**都是遗留要求**。

因此修法是**上报真实存在的能力**，并且**带证据**：

| 条目 | 何时上报 |
|---|---|
| `RefinedNowPlaying:client-lyric-pipeline-verified` | 观察到歌词管线真的产出了（`lyrics-updated` 触发 / `currentLyrics` 有内容），并**持久化**到 localStorage（RNP 在加载时就检查，那时还没放歌） |
| `RefinedNowPlaying:client-lyric-pipeline-ncm3-expected` | 证据被清空、但这是 ncm3 客户端（RNP-Next 的受支持平台） |
| `RefinedNowPlaying:loader-lyrics-feed` | 万一 `channel.call` 包装成功（见 `docs/11` §8.4） |

后缀刻意区分 **verified / expected**：没有任何一条声称"改写成功"。
诊断与 `betterncm.status().lyrics` 仍会显示管线是否被真正观察到。

实测结果：

```
hijacks: ["RefinedNowPlaying:client-lyric-pipeline-verified"]
passes: true      notice: false      badgeGone: true
lyrics: { pipelineProven: true, pipelineLines: 34, currentLines: 34 }
```

`test/autostart.cmd` 已固化这几条断言（条件通过 + 弹窗不存在 + 浮动徽标不存在 + 状态在面板内）。

## 实机验证（2026-10-01，客户端 3.1.41.205529）

| 项目 | 结果 |
|---|---|
| 三个内置插件 | **全部 loaded 且全部真正工作**（见下） |
| `RefinedNowPlaying`（3.0.2） | **歌词通路打通**：`lyrics-updated` 事件触发，`window.currentLyrics` 含 **43 行**，`contributors = ["original","translation","roles"]`。它自带 3.x API 通路，**不需要 hijack** |
| `MaterialYouTheme` | **截图确认生效**：整界 Material You 紫色配色、`#md-bg-fader` 与 html 主题类均在位 |
| `LyricBar` | **已挂载并显示歌词**：`lyricBar: true`，文本「就这样 等到了惊蛰后盼霜降 …」。靠框架新增的 **DOM 别名层**补回它轮询的 `#main-player` |
| 管理 UI | 面板渲染 4 行、**3 个内置锁定徽章**、2 个分组/页签（`test/manager.cmd` **15/15**） |
| 自动启动 | `test/autostart.cmd` **17/17**：agent 存活、后端就绪、预载抢到 document-start、UI 渲染、别名与词栏均在 |
| hijack 改写 | **默认关闭**：拦截 `window.webpackJsonp` 本身就会让客户端启动失败（对照实验见 `docs/11` §8.1），因此改为按需开启，当前 `intercept:false` |
| 可还原性 | `restore-verify.ps1` 仅多出 `version.dll`，未触碰任何网易签名文件 |

### 因此，当前的真实完成度是

- **可用**：客户端正常启动与渲染、框架注入、**三个插件全部加载且功能可用**
  （沉浸式播放页/歌词、主题、词栏）、管理 UI、自动启动，以及 `E:\CloudMusic` 的可还原性。
- **默认关闭**：页面级代码改写（`hijacks`）。它已被证明可用但会破坏启动，且当前**没有需求依赖它**。
- **可选后续**：给 `LyricBar` 镜像暂停态；启用作用域保持后的改写规则。

这条边界有完整的实测证据链（`docs/11` §8 的对照表与命令）。

```powershell
# 1) 三个内置插件是否都加载
node tools\cdp_inject.mjs --expr "JSON.stringify(window.__BNCM_LOADED__.core)"
# 2) 歌词钩子是否落地
node tools\cdp_inject.mjs --expr "JSON.stringify(window.__BNCM_HIJACK__.applied)"
# 3) 钩子是否被真正调用（播放一首歌后）
node tools\cdp_inject.mjs --expr "JSON.stringify({current: !!window.currentLyrics, lines: (window.currentLyrics&&window.currentLyrics.lyrics||[]).length})"
# 4) LyricBar 是否挂载
node tools\cdp_inject.mjs --expr "JSON.stringify(!!document.querySelector('.lyric-bar'))"
# 5) 窗口截图人工复核（CDP 截图在本客户端超时，见 docs/00）
powershell -NoProfile -ExecutionPolicy Bypass -File test\capture-window.ps1 -Out out\core-plugins.png
node tools\compat_report.mjs --out docs\real-plugin-compat.json
```
