# 12 — Material 3 深度重制：阶段 1 逆向分析

> 本文是用户九阶段规范里**阶段 1**的交付物。所有数字都是在运行中的
> NCM `3.1.41.205529`（`web.pack` COMMITHASH `477f8a2`，1411 条目）上**实测**得到的，
> 不是推测。文末给出阶段 2–9 的计划与本轮已完成的部分。

---

## 1. 测量方法（便于复核）

| 数据 | 来源 |
|---|---|
| 客户端自己的 CSS | 解压 `%LOCALAPPDATA%\Netease\CloudMusic\web.pack`（100 字节头 + 普通 ZIP）→ 127 个 `.css`，共 16,793,647 字符 |
| CSS-module 组件前缀 | 对上述 CSS 正则 `.([A-Za-z][A-Za-z0-9]*)_[a-z0-9]{6,}` 计数 |
| 客户端主题变量 | 在页面里读 `document.documentElement.style`（**内联**，由客户端 JS 动态写入） |
| 当前主题实现 | `plugins/src/MaterialYouTheme/main.js`（上游 dist，180,613 字符）静态分析 |
| 运行时状态 | CDP 注入探针（`tools/cdp_inject.mjs`） |

> 注意：在 CEF 91 里 `getComputedStyle(root)` 的枚举长度为 **0**，**无法**枚举自定义属性；
> 必须读 `documentElement.style`（内联部分）。这是后续所有工具的实现约束。

---

## 2. NCM 3.x 的真实可主题化面（最重要的发现）

### 2.1 客户端在 `<html>` 上内联写入 **83 个自定义属性**

这是 NCM 3.x 真正的主题接缝（CSS 文件里搜不到它们，因为是运行时 JS 写入的内联样式）：

| 家族 | 数量 | 样例（实测值） | 用途推断 |
|---|---|---|---|
| `--colorPrimary1..8` | 8 | — | 主色渐变/色阶 |
| `--colorSecondary1_1..1_2`, `2_1..2_4`, `3_1..3_4`, `4` | 11 | — | 次级色阶 |
| `--colorBlack1..12` | 12 | `--colorBlack1: rgba(240,235,231,1)` | **灰度阶（深色模式基色）** |
| `--colorWhite1..12` | 12 | `--colorWhite1: rgba(255,255,255,1)` | 灰度阶 |
| `--colorSidebar1..13` | 13 | — | 侧栏专用色阶 |
| `--colorBackground` | 1 | `rgba(53,47,43,1)` | 页面背景 |
| `--colorBackgroundWhite` | 1 | — | 卡片/白色表面 |
| `--colorFunction1..17` | 17 | `--colorFunction1: rgba(240,235,231,0.5)`, `--colorFunction10: rgba(240,235,231,0.1)` | **语义角色层**（文字/分隔/悬停/遮罩等，按透明度分层） |
| `--colorMask1..5` | 5 | `--colorMask1: rgba(0,0,0,0.7)` | 遮罩/蒙层 |
| `--minibar-hover--mask-bg` | 1 | — | 迷你条悬停 |

在客户端自己的 127 个 CSS 文件里**只定义了 24 个**自定义属性，全部是灰度
（`--colorBlack1..12`、`--colorWhite1..12`）。也就是说：

> **NCM 3.x 的配色是"运行时注入的一整套变量"，而不是"CSS 里写死的主题"。**
> 这既是机会（改这一层就能覆盖全站），也是约束（必须与它的动态更新共存）。

### 2.2 客户端已有动态取色

`--colorBackground: rgba(53,47,43,1)` 与 `--colorFunction*` 的取值随封面变化，
说明**客户端自身就会从封面提取主色**。因此本项目的"动态取色"应当：
**接管并规范化这层结果**（生成完整 tonal palette 写回这些变量），而不是另起一套平行变量。

### 2.3 组件地图（990 个 CSS-module 前缀）

127 个 CSS 文件里共有 **990** 个不同的 CSS-module 组件前缀，形如 `Name_hash`。
前缀匹配是可用的定位手段（hash 会随构建变化，前缀不会）。按出现频次取头部：

**列表/表格**：`StyledTitleCell`(1075)、`StyledTableViewer`(176)、`StyledIndexCell`(83)、`StyledTableExtra`(62)、`TrackTitleContainer`(62)
**卡片/封面**：`TrackCardWrapper`(384)、`VoiceCardWrapper`(369)、`CardWrapper`(267)、`AlbumWrapper`(262)、`StyledCard`(82)、`StyledCover`(65)、`ArtistWrapper`(86)、`VideoCardContainer`(72)
**表单控件**：`InputWrapper`(571)、`SelectWrapper`(142)、`RadioWrapper`(132)、`CheckboxWrapper`(106)、`SwitchWrapper`(98)、`TextAreaWrapper`(88)、`TagInputWrapper`(106)、`SliderWrapper`(66)、`StyledSliderContainer`(64)
**容器/布局**：`Container`(494)、`Wrapper`(213)、`Main`(195)、`TabsWrapper`(194)、`ContainerBox`(184)、`GridCarouselWrapper`(161)、`CarouselWrapper`(154)、`ListWrapper`(89)、`SideSheetWrapper`(100)、`SpaceWrap`(82)
**反馈/浮层**：`TipContainer`(163)、`TooltipWrapper`(86)、`PopoverWrapper`(86)、`ModalWrapper`(84)、`ModalContent`(70)
**播放器**：`DefaultBarWrapper`(76)、`VinylCoverContainer`(224)、`AudioWrapper`(215)、`VinylPageBarWrapper`(106)、`VinalPageTrackViewerCss`(72)
**排版**：`TypographyWrapper`(106)
**其它**：`tapableCss`(108)、`TabsCss`(96)、`button`/`cmd-button`（客户端自定义元素类名，非 module 哈希）

> 与旧版的关键差异：NCM 2.x 的 `#main-player`、`.m-player`、`.g-mn`、`.cdimg`、`.btnp`、
> `.g-single`、`.n-single` 等**在 3.x 中计数为 0**（已实测）。任何依赖它们的选择器都必须重写。

### 2.4 布局变体（必须考虑）

实测 `document.documentElement.className = "window-fullscreen bncm-fm minibar-shown"`，
同一台机器上播放器有两种布局：

- **完整播放条**：`DefaultBarWrapper_*`，1920×80，位于视口底部；
- **迷你条**：只有 `DefaultPlayerContainer_*` 的 40×100 竖条与 40×20 小块，**没有全宽条**。

主题**必须两种都覆盖**，且不要假设底部条一定存在（本项目的 DOM 别名层就因此改为
"找不到就用占位元素"）。

---

## 3. 当前主题 `material-you-theme-NCMv3` v1.0.4 的实现范围

静态分析 `main.js`（180,613 字符）的结果：

| 指标 | 数值 | 说明 |
|---|---|---|
| 自定义属性定义 | **51** | 其中 `--md-*` 仅 **17** 个 |
| `--md-*` 命名 | `--md-accent-color`、`--md-accent-color-bg`、`--md-accent-color-grey-base`、`--md-elev-1..3`、`--md-page-bg`、`--md-page-primary`、`--md-page-fg` … | **2.x 时代命名**，没有 M3 role |
| 覆盖的客户端变量 | `--colorBackground`、`--colorBackgroundWhite`、`--colorFunction1..17`、`--colorMask1..5` | 即"改配色"的那一层 |
| `!important` | **475** | 与用户"不要无脑 `!important`"的要求冲突 |
| `backdrop-filter` / `blur(` | **0 / 0** | 性能上已经是克制的 |
| `transition` | 27 | 有少量动效 |
| 选择器 | 143 | 主要两类：① `.material-you-theme .cmd-button`、`.tbody .tr.selected`、`#page_pc_main_nav` 等少量客户端内部节点；② **它自己的设置界面**（`#md-theme-setting*`、`.md-scheme-*`） |
| token 声明位置 | `body.material-you-theme` | 所以从 `:root` 读这些 `--md-*` 得到**空字符串**（已实测） |

**结论**：当前主题 = **"设置界面 + 变量重着色"**。
它**没有** M3 color role、**没有** tonal palette、**没有** radius/typography/elevation/motion token 体系，
也几乎没有改造任何具体组件。这正是用户描述的"网易云原生 UI + 一套 Material 配色"。

### 3.1 可复用 / 必须重写

| 分类 | 内容 |
|---|---|
| **可直接复用** | ① 动态取色与配色方案的**设置界面**及其状态管理；② `body.material-you-theme` / `md-dark` 等**主题开关类名约定**（LyricBar、RNP 会探测 `loadedPlugins.MaterialYouTheme`，这个契约必须保持）；③ 它对 `--colorFunction*`/`--colorMask*` 的重着色思路（方向正确，只是不完整）；④ 0 blur/backdrop-filter 的性能取舍 |
| **必须重写** | ① 只有 17 个 `--md-*` 的 token 层 → 换成完整 M3 scheme + tonal palette；② 475 处 `!important` → 用作用域选择器 + 明确的 specificity 策略；③ 缺失的 radius / typography / elevation / motion 体系；④ 缺失的组件级改造（播放器、歌曲列表、侧栏、菜单、弹窗、滑杆、开关…）；⑤ 对 3.x 已不存在选择器的依赖 |

---

## 3.2 【重要补充】客户端自带一整套 `cmd-*` 设计系统（阶段 4 实测发现）

阶段 4 复核选择器时发现：NCM 3.x 的 CSS 里共有 **823 个 `cmd-*` 类名**，是一套完整、
**非哈希、跨构建稳定**的组件库 —— 比 CSS-module 哈希好得多，也**直接覆盖用户清单里的每一个组件**。

按引用次数（客户端自己的 CSS 中出现次数）：

| 家族 | 次数 | 家族 | 次数 |
|---|---|---|---|
| `cmd-input` | 1624 | `cmd-popover` | 171 |
| `cmd-tabs` | 664 | `cmd-typography` | 169 |
| `cmd-carousel` | 440 | `cmd-tooltip` | 167 |
| `cmd-upload` | 364 | `cmd-icon` | 145 |
| `cmd-select` | 358 | `cmd-sidesheet` | 144 |
| `cmd-card` | 350 | `cmd-dropdown` | 142 |
| `cmd-button` | 335 | `cmd-list` | 122 |
| `cmd-checkbox` | 304 | `cmd-slider` | 102 |
| `cmd-radio` | 252 | `cmd-empty` / `cmd-popconfirm` | 94 / 70 |
| `cmd-modal` | 226 | `cmd-toast` / `cmd-progress` | 51 / 48 |
| `cmd-tagInput` | 188 | `cmd-badge` / `cmd-skeleton` / `cmd-space` / `cmd-page` / `cmd-layout` / `cmd-spin` / `cmd-tag` / `cmd-image` / `cmd-anchor` / `cmd-metacard` | … |
| `cmd-switch` | 176 | `cmd-portal`（浮层挂载点） | 13 |

而且每个家族都带**明确的状态/尺寸修饰符**，例如：

- `cmd-button-disabled` / `-disabled-30|40|50` / `-block` / `-content` / `-outline-pri` / `-group`
- `cmd-switch-checked` / `-active` / `-knob` / `-disabled` / `-focus` / `-loading`
- `cmd-checkbox-checked` / `-indeterminate` / `-focus` / `-disabled`
- `cmd-slider-rail` / `-handle` / `-handle-clicked` / `-dot-active` / `-boundary` / `-disabled`
- `cmd-modal-content` / `-close` / `-confirm` / `-centered` / `-content-animate-show|hide`
- `cmd-dropdown-item` / `-item-active` / `-item-disabled` / `-divider`
- `cmd-tabs-tab` / `cmd-tabs-tab-active` / `cmd-tabs-bar-line`

**结论（已据此重写主题的选择器策略）**：主题组件层**以 `cmd-*` 为主钩子**，
哈希前缀只作为回退。实机验证（歌单页）：`cmd-button` 202 个、`cmd-icon` 284 个、
`cmd-typography` 107 个、`cmd-tabs-tab` 3 个、`cmd-tag` 45 个、`cmd-portal` 4 个。

**同时验证了一个反例**：`cmd-tabs-tab` 之所以之前完全没被样式命中，是因为我写的是
`[class*="Tab"]`，而**属性选择器默认大小写敏感**，`cmd-tabs-tab` 里的 `tab` 是小写 → 不匹配。
这类"看起来对、其实一个都没中"的选择器，只有实机量 computed style 才能发现。

## 4. 兼容性与风险清单

| 风险 | 实测依据 | 对策 |
|---|---|---|
| **类名哈希化** | 990 个 `Name_hash` 前缀，hash 随构建变化 | 只用**前缀**匹配 `[class*="XxxWrapper"]`，绝不用完整 hash；并保留 `docs/11` 的选择器回退日志 |
| **布局变体** | 完整条 vs 迷你条（2.4） | 两种布局分别覆盖；不假设全宽条存在 |
| **变量被客户端动态重写** | 83 个变量是内联样式，随封面更新 | 主题写入后要**能被客户端刷新覆盖时自愈**（观察 + 重写，且必须节流；或写入更高优先级的样式表而不是内联） |
| **CEF 91 限制** | `getComputedStyle` 无法枚举自定义属性 | 用 `documentElement.style` 读内联；用 `element.style.setProperty` 写 |
| **与 RNP / LyricBar 冲突** | `body` 上有 `refined-now-playing`；LyricBar 把 `.lyric-bar` 追加到 `body` | 主题只作用于"客户端容器"范围，避免使用 `body > *` 之类宽泛选择器；`docs/11` §8.3 的 `#main-player` 别名不得被覆盖 |
| **性能** | 桌面播放器，大量列表项 | 禁止大面积 `backdrop-filter`/`blur`；动画只用 `transform`/`opacity`；不用 `MutationObserver` 全树观察，若用则限定子树 + 节流 |
| **SMTC** | 3.x 原生支持 | 本项目**不实现、不改动** SMTC |
| **主题契约** | LyricBar/RNP 探测 `loadedPlugins.MaterialYouTheme` | slug 与主题类名保持不变 |

---

## 5. 目标架构（阶段 2 起）

不再往上游 minified bundle 里塞 CSS，而是**在主题插件内新增可读、可审查的源码目录**，
由插件清单的多文件注入机制加载（`injects.Main` 支持多文件，已确认 `loader/framework.js` 会按顺序执行）：

```text
plugins/src/MaterialYouTheme/
├── manifest.json          # injects.Main: [main.js, theme/loader.js]
├── main.js                # 上游 dist：动态取色 + 设置界面（保持不动）
└── theme/
    ├── loader.js          # 按固定顺序 fetch 并在 <style> 注入下列 CSS
    ├── index.css
    ├── tokens/
    │   ├── color.css      # 完整 M3 scheme + tonal palette（含最低对比度保护）
    │   ├── typography.css # display/headline/title/body/label + 中文字体策略
    │   ├── radius.css     # small/medium/large/xl/full
    │   ├── elevation.css  # surface 层级（不堆 box-shadow）
    │   └── motion.css     # duration/easing token
    ├── components/        # buttons / sidebar / player / playlist / dialogs / menus / inputs / slider
    └── compatibility/     # RNP、LyricBar、迷你条等作用域与例外
```

**变量映射策略**（关键设计）：M3 role 作为**单一真相**，再把客户端的 83 个变量映射过去：

```
--md-sys-color-primary            →  --colorPrimary*
--md-sys-color-surface-container* →  --colorBackground / --colorBackgroundWhite / --colorBlack*
--md-sys-color-on-surface-variant →  --colorFunction1..17
--md-sys-color-outline-variant    →  --colorMask*
--md-sys-color-* (sidebar)        →  --colorSidebar1..13
```

这样"改一处、全站生效"，且与客户端自身的动态取色**同源**，不再另起平行体系。

---

## 6. 阶段 2–9 计划与验收映射

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 逆向分析 | 本文 | ✅ 完成 |
| 2 Design Token | `theme/tokens/*`：color（完整 M3 scheme + tonal palette + 对比度保护）、typography、radius、elevation、motion | 本轮开始（见 §7） |
| 3 基础 UI | 背景 / surface 层级 / 侧栏 / 导航 | 待做 |
| 4 核心组件 | button / input / slider / menu / dialog / tab | 待做 |
| 5 业务 UI | playlist / song list / player / album / artist | 待做 |
| 6 Motion | 页面切换、弹窗、菜单、hover/press/selected、封面过渡 | 待做 |
| 7 插件兼容 | RNP / LyricBar 回归 | 待做 |
| 8 性能 | CPU/GPU、DOM 变更、repaint、节流审查 | 待做 |
| 9 清理 | 去重复 CSS、无效选择器、临时 hack | 待做 |

用户 §17 的 15 条验收标准已逐条对应到上面的阶段（Light/Dark、动态取色、中文字体、
图标字体不被误替换、播放器/列表/侧栏/弹窗/菜单一致性、状态完整性、动画、性能、
RNP、LyricBar、SMTC、重启稳定），每一条都将在对应阶段用 CDP 实机断言固化。

---

## 7. 本轮（阶段 2）已完成内容

见 `docs/13-material3-tokens.md`：token 层已落地为可读来源并实机注入。
