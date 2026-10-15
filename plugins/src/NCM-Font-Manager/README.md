# NCM Font Manager

网易云音乐 **3.1.41.205529**（Orpheus / CEF 91）字体管理器，BetterNCM 兼容插件。
slug：`NCM-Font-Manager` · 版本 `0.1.3` · 类型 `extension`

0.1.3 性能修复：歌词让位使用区域标记和简短排除规则，替代在每个字体选择器里重复展开完整歌词选择器。只检查新插入的歌词区域，歌词区域内部更新不再触发全页面查找；原生字体命令按实际参数去重，正文 / 字重等无关修改不再重复设置原生字体。保留其他歌词插件优先的行为。

0.1.2 增加歌词字体让位：检测到启用的 NowPlaying / LyricBar / 歌词字体插件，或其他注入样式在指定歌词字体时，停用本插件的歌词字体和字重规则，并让 UI / 正文规则避开歌词区域。所有 `player.setLRCFont` 调用（包括启动、修改、恢复默认、自检及 FontSize 回调）都会让位。面板显示当前控制方；每秒重新检查，其他插件退出后恢复本插件的歌词设置。歌词匹配不再误命中带有 lyric 设置类名的 body。

兼容回归：`node test/font-cooperation.mjs`，在隔离的 CEF frame 中验证后加载的歌词样式、原生命令让位及控制方退出后的恢复，不修改真实用户配置。

0.1.1 修复字体切换只改变容器样式、实际文字仍使用微软雅黑的问题：规则覆盖客户端显式指定字体的子元素，保留图标字体与 SVG；正文未单独选字体时跟随 UI 字体。歌词规则仅作用于歌词区域，不再把整个播放器当作歌词。面板预览现在可以覆盖面板自己的默认字体规则。

渲染回归检查：`node test/font-rendering.mjs`（需运行客户端，不写入用户配置）。`node test/fonts.mjs --drive-panel` 还会通过真实下拉框检查侧栏文字与预览的计算字体，并恢复原选项。

---

## 1. 功能

| # | 功能 | 生效方式 | 作用范围 |
|---|---|---|---|
| 1 | 字体选择（可搜索/可自由输入） | `os.querySystemFonts` → 内置 CJK 列表（`os.checkNativeSupportFonts` 过滤）→ `<datalist>` 自由输入 | 面板 |
| 2 | 字号（UI 字号 / 歌词字号分开） | UI：`player.setFont(family, size)` + `body{font-size}`；歌词：`player.setLRCFont(size, style, family)` | 原生（含桌面歌词） |
| 3 | 字重（UI / 正文 / 歌词 各一组） | 注入 `font-weight: N !important` | **仅主窗口 CSS** |
| 4 | UI 字体 | `player.setFont` **和** `font-family !important` 同时施加（CSS 用于压过客户端内联样式） | 原生 + 主窗口 CSS |
| 5 | 歌词字体 | `player.setLRCFont` + 应用内歌词节点 CSS（含 RefinedNowPlaying 的 `rnp-*` 节点） | 原生 + 主窗口 CSS |
| 6 | 英文 / 数字字体 | 生成 `@font-face{font-family:'BNCM-Latin';src:local('<family>');unicode-range:…}`，字体栈前置 `'BNCM-Latin'`。**不重写任何 DOM** | **仅主窗口 CSS** |
| 7 | 字体回退 | 可增删、上移、下移的有序列表，拼进 CSS 字体栈 | **仅主窗口 CSS** |
| 8 | 一键恢复默认 | `player.setFont('默认', <snapshot size 或 14>)` + `player.setLRCFont('默认', size, style)` + 移除 `<style id="bncm-font-style">` + 清空本插件配置；另有「对比快照」诊断 | 原生 + CSS |
| 9 | 实时预览 | 面板内预览块使用**同一份生成的字体栈**，`input` 事件 → 100 ms 防抖 → 预览、样式表、原生调用同时更新 | 面板 + 全局 |

### 桌面歌词 / 迷你播放器的硬限制（重要）

桌面歌词窗口和迷你播放器是**独立的 CEF 窗口**，有各自的 document，**页面 CSS 完全无法触及**。
只有原生命令能影响它们：

- `player.setFont(family, size)` —— 主窗口 body 字体
- `player.setLRCFont(size, style, family)` —— 桌面歌词字体（**只接受 字号 / 粗细 / 字体族 三个参数**）

因此第 3（字重）、6（英文数字专用字体）、7（回退链）三项**只对主窗口生效**，对桌面歌词无效。
面板里每一项都带 `主窗口 CSS` / `原生命令（含桌面歌词）` 标记，UI 上也写明了这一点。

---

## 2. 原生命令契约（已对照真实 3.1.41 bundle 核实）

```
AudioPlayer.getSystemFonts()          channel.call('os.querySystemFonts')
                                      → ['success', [family, ...]]  |  undefined
AudioPlayer.getNativeSupportFonts(n)  channel.call('os.checkNativeSupportFonts', [names])
                                      → ['success', [...usable...]]
AudioPlayer.setFont(family, size)     channel.call('player.setFont', family, size)
                                      → 无返回值
setDekstopLyricStyle({name:'lrcFont', value:[size, style, family]})
                                      channel.call('player.setLRCFont', size, style, family)
subscribeDeskLyricFontSize(cb)        legacyNativeCmder.appendRegisterCall('FontSize','player', r => cb({size:r}))
```

要点：

- `betterncm.ncm.call` 会把多值返回解包成 `r.length > 1 ? r : r[0]`，
  所以 `['success', [...]]` **可能以原始形状或已解包成 `[...]` 的形状到达**。插件两种都接受，
  并且接受 `undefined`（命令不受支持时就是这样）。
- `player.setFont` 的 family 传字面量 `"默认"` 时，客户端自己替换成 `微软雅黑`。
- 桌面歌词字体参数顺序是 **`(字号, 粗细, 字体族)`**，不是 `(字体族, 字号, …)`；
  客户端拼的是 `value:[lyricFontSize.toString(), lyricFontStyle.toString(), lyricFont]`。
- 客户端**没有暴露任何读取桌面歌词字体当前值的命令**（每个字段只有 setter）。所以快照里的
  `lyricFont` 只能记录「本插件最后一次设置的值」或「首次启用时的客户端默认值」，
  诊断里如实标注为 `not read back from the client`，不假装读回成功。

---

## 3. 持久化键与优先级

**写入**同时落到两处：

| 存储 | 键 | 说明 |
|---|---|---|
| localStorage | `config.betterncm.NCM-Font-Manager` | 每插件配置（`plugin.getConfig/setConfig` 同源） |
| `<data>/config.json` | `cc.microblock.ncmfont.<key>` | 顶层配置，清缓存后仍可恢复（文本值；数组存 JSON 字符串） |

**读取优先级**（`Preferences`）：

```
cc.microblock.ncmfont.<key>   (config.json，清缓存后仍在)
  >  config.betterncm.NCM-Font-Manager.<key>   (localStorage)
  >  DEFAULTS
```

首次绘制用 localStorage 同步结果立刻应用；随后 `app.readConfig` 的持久副本到位后覆盖并重新应用一次。
后端不可达不是致命错误（localStorage 仍可工作），但会在面板里显示警告——不静默失败。

插件自己额外使用的键（不属于上面的配置集，恢复默认时会清掉 `applied`、保留 `snapshot`）：

| 键 | 用途 |
|---|---|
| `config.betterncm.NCM-Font-Manager.snapshot` | 首次启用时的字体快照（诊断用，恢复默认后仍保留） |
| `config.betterncm.NCM-Font-Manager.applied` | 本插件最后一次设置的原生歌词字体 |
| `<data>/FontManager/font-snapshot.json` | 快照的落盘副本（通过 `betterncm.fs.writeFileText`，尽力而为） |

配置键：`uiFamily` `uiSize` `uiWeight` `bodyFamily` `bodyWeight` `lyricFamily` `lyricSize`
`lyricWeight` `lyricStyle` `latinFamily` `latinIncludeCjkPunct` `fallbacks` `lyricFontDefault`。

---

## 4. CSS 注入约定

- 单一 `<style id="bncm-font-style">`，重复注入只替换 `textContent`（不堆叠）。
- 面板样式 `<style id="bncm-font-panel-style">`，同样按 id 幂等。
- `<html>` 上加标记类 `bncm-fm`，**所有注入选择器都以 `html.bncm-fm` 开头**，不会误伤其他插件或客户端。
- 不使用 `:where()`：它会把特异性归零，正好会输给客户端的内联样式（而我们恰恰需要 `!important` 去压过它）。
- 仅在必须压过客户端**内联样式**的地方使用 `!important`（`font-family` / `font-weight` / `body{font-size}`）。
- 配置面板自身被强制指定为系统 UI 字体，避免「把字体设坏之后面板也读不了、改不回来」。
- 歌词选择器包含 RNP 节点：`[class^=LyricWrapper_]`、`[class*=LyricDisplayInnerContainer]`、
  `[class*=ScrollableLyricDisplayContainer]`、`[class*=LyricDefaultPageContainer]`、`#main-player`、
  `.rnp-lyrics-overview-line`、`[class*=lyric]`、`[class*=Lyric]`。

## 5. 幂等 / 重新注入

重新注入时通过 `window.__BNCM_NCM_FONT_MANAGER__.dispose()` 释放上一个实例：移除样式元素、
标记类、面板样式，并清空引用。**唯一无法完全撤销的是原生 `FontSize` 回调注册**——客户端注册表是
「同名覆盖」语义，本插件固定占用 `player.onFontSize` 这一个回调名（面板里也写明了）。

## 6. 已知无法在无客户端环境下验证的部分

见交付说明；简言之：实际字体枚举结果、桌面歌词窗口的真实渲染、迷你播放器行为、
`player.setLRCFont` 的参数顺序在真机上的最终效果、以及 `FontSize` 事件的实际触发时机。
