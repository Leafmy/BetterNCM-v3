# 13 — Material 3 阶段 2：Design Token 落地

> ## ⚠️ 状态：本文所述的 M3 层**已按用户要求撤下**（本轮）
>
> `plugins/src/MaterialYouTheme/` 现在**只包含上游 v1.0.4 原版**（`manifest.json` + `main.js` +
> LICENSE，`main.js` 与上游 sha256 完全一致，从未被修改）。我编写的 `theme/` 层已移出加载路径，
> 存放在 `plugins/_attic/material3-theme-layer/theme/`（可恢复，未加载）。
> 实机复核：`html.m3-theme` 类不存在、`style[data-bncm-m3]` 数量为 **0**、
> `window.__BNCM_M3_THEME__` 为 `undefined`；同时上游主题仍在工作
> （`body.material-you-theme md-dynamic-theme`、`--md-accent-color: rgb(255,182,142)`、
> `--md-page-bg: rgb(54,47,44)`）。
>
> 本文保留作为**技术记录**（哪些做法有效、哪些假设被实测推翻），但它描述的层当前**未安装**。
> 与之对应，`test/m3-theme.mjs` 与 `test/m3-components.mjs` 也不再适用于当前状态。
>
> 撤下原因与"2.x 主题能否直接兼容 3.x"的实测结论见文末 §17。

> 阶段 1 的逆向分析见 [`docs/12-material3-phase1-analysis.md`](12-material3-phase1-analysis.md)。
> 本文记录**阶段 2（Design Token）**的产出、实机验证结果，以及过程中被实测推翻的两个设计。

---

## 1. 文件结构（可审查的源码，不再是 bundle 里的字符串）

```text
plugins/src/MaterialYouTheme/
├── manifest.json                 # injects.Main = [main.js, theme/palette.js, theme/loader.js]
├── main.js                       # 上游 v1.0.4 dist：动态取色 + 设置界面（未改动）
└── theme/
    ├── loader.js                 # 按固定顺序 fetch 并注入下列 CSS；记号 see below
    ├── palette.js                # 运行时生成 M3 tonal palette（色彩数学无法在 CEF 91 的 CSS 里做）
    ├── index.css                 # 全局不变式（选区、focus-visible、低性能开关）
    ├── tokens/
    │   ├── color.css             # 完整 M3 color role + state layer + surface 层级别名
    │   ├── radius.css            # 形状令牌 + 组件指派 + 间距阶
    │   ├── elevation.css         # 三级 elevation + surface tint + 暗色修正
    │   ├── typography.css        # display/headline/title/body/label 全套 + 中文字体策略
    │   └── motion.css            # duration/easing + prefers-reduced-motion + 关闭开关
    ├── components/
    │   └── surfaces.css          # 阶段 3 首片：卡片/封面/浮层/输入框/分隔线
    └── compatibility/
        └── plugins.css           # 明确排除 RNP / LyricBar / BetterNCM 管理器
```

**为什么 CSS 单独成文件**：上游 dist 是一个 180 KB 的压缩 bundle，无法审查、无法 diff。
本项目的做法是**不动上游 `main.js`**，把 M3 层作为可读源码放在 `theme/` 下，由插件清单的
多文件注入机制加载（`loader/framework.js` 已支持 `injects.Main` 多文件、按顺序执行）。

`theme/loader.js` 通过宿主自己的端点
`GET /api/plugin/MaterialYouTheme/<path>` 取每个 CSS，注入为一个带
`data-bncm-m3="<path>"` 的 `<style>`，顺序固定为
**tokens → components → compatibility → index**，缺文件会被记录而不是静默跳过。

---

## 2. 设计令牌概览

| 令牌族 | 数量/范围 | 说明 |
|---|---|---|
| `--md-sys-color-*` | **31 个 M3 role** | primary / on-primary / primary-container / secondary / tertiary / error / surface / surface-container(-low/lowest/high/highest) / surface-variant / on-surface / on-surface-variant / outline / outline-variant / inverse-* / scrim / shadow |
| `--md-sys-state-*` | 6 | hover 0.08 / focus 0.12 / pressed 0.12 / dragged 0.16 / disabled 0.38 / disabled-container 0.12 |
| `--md-sys-shape-*` | 7 阶 + 13 个组件指派 | none / xs 4 / s 8 / m 12 / l 16 / xl 28 / full |
| `--md-sys-space-*` | 9 | 4px 基准 |
| `--md-sys-elevation-*` | 3 级 + 4 个 surface role | **不靠堆 box-shadow**：深度主要来自 surface 阶梯 |
| `--md-sys-typescale-*` | 15 个 style（size/line/weight/tracking） | display 3 / headline 3 / title 3 / body 3 / label 3 |
| `--md-sys-motion-*` | 8 组时长 + 7 条 easing + 9 个组件指派 | 只允许 `transform`/`opacity` |

### 2.1 tonal palette（`palette.js`）

标准的 **CIELAB 色调法**：源色 → Lab → 固定 L\* 到目标 tone（0..100）→ 回到 sRGB，
两端按 Material 的做法收敛 chroma，避免色域裁剪成泥色。产出：

- primary / secondary / tertiary / neutral / neutral-variant / error 六条色阶；
- 按 M3 标准 tone 号映射成 31 个 role；
- **对比度保护**：每个 `on-*` 与它的容器做 WCAG 对比度检查，低于 4.5:1 时从同一色阶里换一个可读的 tone；
- 暗色模式有独立的 tone 映射，且**降低 shadow、提高 surface tint**（深色上阴影几乎不可见，M3 的答案是"更亮的容器"而不是"更大的模糊"）。

实测（客户端 3.1.41，动态源色取自封面）：

```
source: rgba(255,183,128,1)   →  scheme: dark
--md-sys-color-primary     #f2bb9b
--md-sys-color-surface     #141312
--md-sys-color-on-surface  #e4e2e1
--md-sys-color-outline     #978f8a
```

---

## 3. 实测推翻的两个设计（重要）

### 3.1 暗/亮模式必须以**客户端当前背景**为准，而不是类名

第一版按 `body.md-dark` 判断模式。实测出现：`body` 带着 `md-dark`，而客户端
`--colorBackground` 是 `rgba(237,233,233,1)`（**浅色**）。于是我们把深色方案投到浅色背景上——
**浅色文字压在浅色表面上**，正是本项目要避免的问题。

现在改为：**读客户端当前 `--colorBackground` 的亮度**（阈值 128）作为唯一权威信号，
类名只在背景无法解析时兜底。实测复核：`clientBg: rgba(54,47,43,1)` ⇒ `scheme: dark`，一致。

### 3.2 不覆盖客户端自己的动态变量（默认关闭投影）

阶段 1 发现客户端在 `<html>` 上**内联**写入 83 个变量，并随封面重写
（同一台机器上实测到 `rgba(237,233,233,1)` 与 `rgba(53,47,43,1)` 两种背景）。
内联自定义属性是"后写者赢"，所以把我们的值投到同一批名字上：

1. 只能在下次换歌前赢，之后被客户端覆盖；
2. 即使赢了，也**抹掉了客户端自己的封面动态取色**——而那正是用户想要的 Material You 行为。

因此：**客户端继续拥有它的动态调色板**，我们把它当作**源色**（`readSource` + 模式判定），
M3 方案用于驱动**本项目真正重写的组件**。投影代码保留并可用
`--m3-project-client-vars: 1` 显式开启（用于固定品牌色的场景），并在文档里说明代价。

### 3.3 观察者自激循环（性能）

我们写 `<html>` 的 `style`，观察者又监听 `<html>` 的 `style` → 写一次触发一次，
形成 4 Hz 永久空转。修法两条并用：
- 写前比较现有值，**相同就不写**；
- 写入期间置 `writing` 标志，观察者忽略自己引起的那次回调，并在下一个 tick 释放；
- `publish()` 外层 try/catch，异常时也保证释放（否则观察者会被永久静音）。

实测：连续两次采样 `documentElement.style.cssText` 长度 **4418 → 4418，稳定**。

---

## 4. 性能与"不破坏"约束（已落实到代码）

| 要求 | 落实 |
|---|---|
| 不用 `!important` | 本层 **0 处** `!important`（上游 dist 的 475 处不在此层） |
| 不用通配符改字体 | `typography.css` 只在 `html.m3-theme` 上设 family，**靠继承**；图标元素自带 family 因而天然不被覆盖，另加一小段显式图标例外 |
| 不猛加 blur | 本层 **0 处** `blur(` / `backdrop-filter` |
| 不猛加 box-shadow | 只有 3 级 elevation，暗色模式反而**减弱** |
| 动画只用合成属性 | `--md-sys-motion-animatable: transform, opacity`；`prefers-reduced-motion` 与 `m3-motion-off` 双开关 |
| 不改 SMTC | 未触及 |
| 不破坏插件 | `html.m3-theme` 作用域 + `compatibility/plugins.css` 显式排除 RNP / LyricBar / BetterNCM 管理器 / DOM 别名元素 |
| 选择器可维护 | 一律用**类名前缀**匹配（990 个 `Name_hash` 中 hash 会漂移），配合 `docs/11` 的选择器回退日志 |

---

## 5. 实机验证（客户端 3.1.41.205529，本轮结束时）

```
html class            window-fullscreen m3-theme bncm-fm minibar-shown
注入的样式表          8（tokens 5 + components 1 + compatibility 1 + index 1）
missing / failed      [] / []
令牌抽查              shape-corner-large / motion-state / elevation-level2 /
                      typescale-body-medium-size / color-outline  全部 ok
palette               源色 rgba(255,183,128,1)（封面）· scheme 与客户端背景一致
观察者稳定性          cssText 长度稳定（无自激）
客户端渲染            正常（root 有子节点）
三个插件              LyricBar / MaterialYouTheme / RefinedNowPlaying 全部 loaded
LyricBar              已挂载
```

---

## 6. 阶段 3–6 落地（本轮）

### 6.1 阶段 3 基础 UI

先用 CDP 把 3.x 的真实布局骨架取出来（而不是照搬 2.x）：

```
body.AppEle 1920x1032
├── #homepage-gray                  背景层（transparent）
├── #page_pc_main_tab  204x1032     侧栏
│   └── .ContentContainer 202x1032
│       ├── .BackContainer 204x72   侧栏头
│       └── .LeftScrollContainer 202x960
│           └── .draggable 188x1739
│               ├── .ItemContainer_* 164x36   （`.selected` = 当前页）
│               ├── .mine-area / .TitleContainer_* / .StyledMoreButton_*
│               └── .PlayListItemContent_*
└── .ad-tutorial-step-0-stop 1716x1032
    ├── #page_pc_main_nav 1716x72   顶栏（.DomWarpper 搜索、.Bar 图标簇）
    └── .scrollCss 1716x960
        └── .KeepAliveWrapper 1636x942
```

新增 `components/sidebar.css`、`components/navigation.css`：抽屉用 `surface-low` 一档 + 一条
`outline-variant` 细线（不用阴影）；导航行做 M3 navigation-drawer 的胶囊 + `.selected` 用
`secondary-container`；搜索框整圆；`cmd-button`/`cmd-icon` 这些**客户端自己的非哈希类名**优先用作钩子。

**specificity 策略**（用户要求）：客户端给选中行的规则挂在 `#page_pc_main_tab` 这个 **id** 上，
纯类选择器会输。实测：`html.m3-theme [class*="LeftScrollContainer"] [class*="ItemContainer"].selected`
算出来仍是客户端自己的浅色。改为把 id 一并写进选择器（id 数相等、类数更多即胜），**没有用 `!important`**。

### 6.2 阶段 4 核心组件

`buttons / inputs / slider / tabs / menus / dialogs` 六个文件。统一：
圆角取 `--md-sys-shape-*`、hover/focus/pressed 取 `--md-sys-state-*` 透明度、
弹层（菜单/提示/对话框）统一 `surface-container-high` + 各自 elevation，
**scrim 用平涂 `scrim` 色并显式 `backdrop-filter: none`**（全屏模糊是桌面主题最贵的操作）。

### 6.3 阶段 5 业务 UI

`player.css` + `playlist.css`。播放条：`surface-container` + 一条 `outline-variant` 上边线 + 一级 elevation；
播放键用 `primary-container`，hover 切 `primary`；封面用 `--md-sys-shape-cover`；
时间读数 `tabular-nums`（避免数字跳动）。

歌曲列表按用户要求处理了四种状态：
- hover = `surface-high`
- selected = `secondary-container`
- **playing = 左侧 3px 主色条（用渐变绘制，不额外插 DOM）+ 标题主色**，明确但不高饱和；
- 表头/序号/附加列各自取语义色。

**注意**：`minibar-shown` 布局下没有全宽播放条，所以 `player.css` 只对 `DefaultPlayerContainer`
（两种布局都存在）给小圆角芯片样式，不对全宽条做任何尺寸假设。

### 6.4 阶段 6 Motion

`components/motion.css`：页面切换（`KeepAliveWrapper > *`，按"挂载时播放一次"设计，
所以 500 行列表滚动不会触发动画）、封面切换、播放条出现、侧栏选中回弹。
只动 `transform`/`opacity`；`prefers-reduced-motion` 与 `html.m3-motion-off` 双重关闭。

---

## 7. 本轮实测发现并修掉的两个真问题

### 7.1 `motion.css` 被静默丢失（HTTP 500）

`loader.js` 里写的是 `tokens/motion.css` / `components/motion.css`，但**包内真实路径**是
`theme/tokens/motion.css`。宿主对插件内文件有一个**同名回退**（basename fallback），
所以 17 个文件看起来"正常加载"；而 `motion.css` 恰好存在两份 → 回退无法唯一确定 → **500**。
结果：阶段 6 的动效令牌**根本没加载**，而界面上完全看不出来。

修法：请求真实路径（`BASE = 'theme/'`），并把"缺失/失败"从日志提升为**验收断言**。
现在 `test/m3-theme.mjs` 会断言 `injected >= 19 且 missing/failed 为空`。

### 7.2 动态取色退化成灰色

`readSource()` 原本取"第一个能解析的候选值"。实测某时刻 `--colorPrimary1` 是 `#c6c6c6`（中性灰），
于是生成了**一整套灰色 Material You**——技术上合法，但完全不达意。

修法：候选按 **Lab chroma 排序**取最有彩度的那个；当所有候选都接近中性（chroma < 6）时，
回退到 M3 基准紫并在诊断里写明"客户端调色板已去饱和"。修后实测源色回到封面的 `rgba(255,182,142,1)`，
`--md-sys-color-primary = #f2bb95`。

（同类教训还有两处：`--md-sys-color-*` 一度只有 17 个是因为声明在 `body.material-you-theme`
而非 `:root`；暗/亮判定曾在客户端浅色背景上套深色方案，见 §3.1。）

---

## 8. 阶段 3–6 的实机验收

新增 `test/m3-theme.mjs`（**13/13 通过**），把用户 §17 里可自动化的条目变成断言：

| 断言 | 实测 |
|---|---|
| 主题标记生效 | `html.m3-theme` |
| 19 个授权样式表全部加载 | `injected=19`，`missing=[]`，`failed=[]` |
| 令牌齐备（色/圆角/动效/字体） | `primary=#f2bb95` `radius=16px` `motion=300ms cubic-bezier(.2,0,0,1)` `type=14px` |
| Light/Dark 与客户端背景一致 | `scheme=dark`，`clientBg=rgba(54,47,43,1)` |
| 正文对比度达标 | **14.53:1** |
| **图标字体未被替换** | icon=`cloudmusic-iconfont, iconfont, Material Icons…`，body=`Microsoft YaHei…` |
| 主题未使用 `!important` | 0（注释内提及不计，按注释剥离后统计） |
| 主题未引入 blur / backdrop-filter | 0 |
| LyricBar 未被强加样式 | `shadow=none` |
| 客户端仍渲染 / 四个插件仍在 | ✅ |

**性能（阶段 8 初测）**：3 秒内 695 帧（≈231 FPS，环境上限内），最大帧间隔 8.4 ms；
我方样式表 0 处 blur；调色板观察者已用"先比较再写 + 写入守卫"消除自激（§3.3）。

---

## 10. 本轮第二个重要发现：歌曲列表根本不是 `<table>`

阶段 5 的第一版 `playlist.css` 按经典表格写（`tr` / `td` / `th` 元素选择器）。**实机导航到歌单页后实测：
`tr` 元素数量 = 0**，即那些规则**一条都没生效**。真实结构（CDP 实测）：

```
.StyledTableViewer_*
├── .thead
│   └── .tr > .th.th-num / .th.th-sortable > span.title
└── .tbody.XVirtualizeListWrapper_*          ← react-virtualized 虚拟列表
    └── .ListWrapper_*
        └── .ReactVirtualized__Grid (role=grid)
            └── .ReactVirtualized__Grid__innerScrollContainer
                └── .tr                       ← 行是 div.tr，不是 <tr>
                    └── .td.td-title
                        └── .cell-more.StyledTitleCell_*
                    └── .styledIndexCellCls_* .playing   ← 「正在播放」标记在序号格上
```

要点：

- `tr`/`td`/`th`/`thead`/`tbody` 在这里是**普通类名**（不是 CSS-module 哈希），因此是稳定钩子；
- 列表是**虚拟滚动**，DOM 里只有可见行 → 不能给行加动画（滚动会重放），也不能假设行数；
- 「正在播放」状态挂在**序号格**上；CEF 91 **没有 `:has()`**，所以无法选中父行做整行高亮 ——
  本主题如实只样式化真实存在的钩子（序号格的 `.playing`），不假装做了整行高亮。
- **Tabs 同理**：原先按 `TabItem` / `tab-item` 等具体名匹配，实测 `border-radius` 仍是 `0px`（13 个
  `[class*="Tab"]` 元素在 `TabsWrapper` 下），改为「前缀匹配 + 限定在 Tabs 容器内」。

### 10.1 又一个可读性问题：客户端的 `--colorFunction*` 语义不是名字暗示的那样

`--md-sys-fg-dim` 原本别名到客户端的 `--colorFunction2`。实测歌曲列表表头算出
**`rgb(68,62,59)` —— 深色文字压在深色表面上**，几乎不可见。也就是说客户端的 17 个
"function" 角色**并不携带名字所暗示的含义**，且它自己的 CSS 里没有任何注释说明。

修法：**文字颜色一律取我们自己算出来并做过对比度保护的 M3 role**，
客户端变量只在**surface**这类语义可观测的地方作为回退。修后实测表头
`rgb(203,197,194)`，对比度 **10.87:1**（正文 14.53:1）。

这条更新了 `docs/12` 里"把客户端变量当投影目标"的设想：**可以用于表面，不能用于文字**。


## 12. 阶段 4 复核：改用客户端自带的 `cmd-*` 设计系统（本轮最大改进）

阶段 4 复核时我先做了两件事：**枚举客户端 CSS 里的全部 `cmd-*` 类名**，以及在**实时 DOM** 里
统计它们。结果（详见 `docs/12` §3.2）：客户端有一套 **823 个非哈希、跨构建稳定**的组件类名，
覆盖用户清单里的每一个组件，而且每族都有明确的状态修饰符。

这与 CSS-module 哈希相比是决定性的优势，因此**主题的组件层改为以 `cmd-*` 为主钩子**：

| 文件 | 现在的主钩子 |
|---|---|
| `buttons.css` | `.cmd-button` + `-disabled` / `-block` / `-outline-pri` / `-group` |
| `inputs.css` | `.cmd-input`（**引用次数最高的家族，1624**）/ `-focus` / `-disabled` / `-error`、`.cmd-select`、`.cmd-tagInput`、`.cmd-switch`（`-checked`/`-knob`）、`.cmd-checkbox`（`-checked`/`-indeterminate`）、`.cmd-radio` |
| `slider.css` | `.cmd-slider-rail` / `-handle` / `-handle-clicked` / `-dot-active` / `-disabled`、`.cmd-progress-track-inner` |
| `menus.css` | `.cmd-dropdown`（+`-item`/`-item-active`/`-item-disabled`/`-divider`）、`.cmd-popover-wrapper`、`.cmd-tooltip-wrapper`、`.cmd-toast`、`.cmd-popconfirm` |
| `dialogs.css` | `.cmd-modal-content` / `-close` / `-confirm` / `-centered`、`.cmd-sidesheet-content`、`.cmd-sidesheet-mask` |
| `tabs.css` | `.cmd-tabs-tab` / `.cmd-tabs-tab-active` / `.cmd-tabs-bar-line` |
| `playlist.css` | 真实列表结构（`.div.tr` / `.td`）+ `.cmd-list` / `.cmd-list-item` / `.cmd-card` / `.cmd-tag` |
| `typography.css` | `.cmd-typography`（`-h1..h4` / `-disabled` / `-danger`），`.cmd-typography-icon` 显式映射回**图标字体** |

### 12.1 一条方法论教训：属性选择器是大小写敏感的

`cmd-tabs-tab` 之前完全没被命中，因为我写的是 `[class*="Tab"]` —— **大写 T**。
属性选择器默认区分大小写，所以一个都没匹配；实测 active tab 的 `border-radius` 一直是 `0px`。
现在改为客户端原类名匹配（必要时加 `i` 标志）。这类"看着对、实际零命中"的错误，
**只有实机量 computed style 才能发现**，读代码看不出来。

### 12.2 复核后的实机结果（歌单页）

```
cmd-button 202 · cmd-icon 284 · cmd-typography 107 · cmd-tabs-tab 3 · cmd-tag 45 · cmd-portal 4
cmdButtonRadius  100px         （= --md-sys-shape-button）
tabRadius        8px           （修前恒为 0px）
tabActiveBg      rgb(88,66,55) （= --md-sys-color-secondary-container #584237，即本主题的角色）
tagRadius        8px
typographyFont   "Microsoft YaHei", 微软雅黑, "Segoe UI", …
iconFont         cloudmusic-iconfont, iconfont, "Material Icons"   ← 图标字体未被替换
```

`test/m3-theme.mjs` 已把上述断言固化，现为 **19/19**。

## 14. 阶段 4/9 复核（本轮）：把能开出来的组件逐个量一遍

### 14.1 新增 `test/m3-components.mjs`：先驱动界面，再量 computed style

本轮的关键动作是**真正把设置界面打开**（点击顶栏 `[title="设置"]`），那里是表单控件最密集的地方。
实测该屏幕上：`cmd-checkbox 30 · cmd-radio 42 · cmd-input 18 · cmd-select 12 · cmd-slider-rail/handle 各 1`。

新增的 `test/m3-components.mjs` 逐个断言（**9/9 通过**）：

| 断言 | 实测 |
|---|---|
| 复选框取 extra-small 圆角 | `4px` = token |
| 勾选态用本主题 primary | `rgb(242,187,157)` = `--md-sys-color-primary` |
| 单选取 full（胶囊） | `999px` = token |
| 文本框取 input 形状 | `4px` = token |
| 下拉取 menu 形状 | `8px` = token |
| 滑轨取 slider-track 形状 | `999px` = token |
| 滑块完全圆 | `999px` |
| 滑块用 primary | `rgb(242,187,157)` = primary |
| 滑轨用 outline-variant | `rgb(76,69,66)` = `#4c4542` |

### 14.2 有 6–7 个组件在本环境**开不出来** —— 如实上报，不当成通过

尝试过并失败的触发路径：右键菜单（合成 `contextmenu`）、行内「…」按钮、点击 `cmd-select`、
在图标上派发 `mouseover/mouseenter`（触发 tooltip）、侧栏「新建」按钮（`AddPointer`）。
都没有让客户端挂载对应浮层。

因此 **`cmd-switch` / `cmd-modal` / `cmd-sidesheet` / `cmd-dropdown` / `cmd-popover` /
`cmd-tooltip` / `cmd-toast` 属于「按客户端自己的类名与状态修饰符写好，但未在 DOM 中观察到」**。
测试脚本把这类组件单独打印为 `not observable here`，**不计入通过**，也不计入失败 —— 它们是"未验证"，
不是"已验证"。

### 14.3 阶段 9 清理（本轮完成）

- **卡片规则去重**：卡片的外观（圆角/表面/elevation/hover）原本在 `surfaces.css` 与
  `playlist.css` 各写一份，两者会互相覆盖。现在**表面归 `surfaces.css` 独有**，
  `playlist.css` 只保留卡片**内容**相关（封面、标题、副标题）。
- **页面背景去重**：`surfaces.css` 里重复声明的 `html.m3-theme body` 背景删除，
  由 `tokens/color.css` 单独拥有。
- **同一选择器、不同关注点**的两处（`DefaultBarWrapper` 的动效 vs 外观、
  侧栏行的回弹 vs 选中色）**保留但加注释说明**：它们写的属性不相交，
  而且分开才能让"整层动效可关闭"不影响外观。
- 复查结果：370 个选择器中已无真正的重复定义（其余是 `@keyframes` 的 `from`/`to`
  与各文件在自己作用域下声明 token，属预期）。

### 14.4 修掉一个测试自身的缺陷：依赖当前屏幕

`m3-theme.mjs` 原本断言"当前页面"的状态。在 `m3-components.mjs` 把客户端切到设置页之后，
它开始报 `cmd-button=90`、`tabs radius=null` —— **看起来像主题回归，其实只是换了屏幕**。
现在该测试**先导航到歌单页**（那里同时有大量 `cmd-button` 和真实 tabs）再断言，连续两次运行 19/19。

这也是一条值得记下的教训：**验收断言必须自己把被测对象带到确定状态**，
否则会产出"看起来是产品 bug 的测试 bug"。

### 14.5 阶段 8：做了 A/B 对照，并据此优化

单跑一次 FPS 说明不了问题，所以做了**同负载对照**：同样的 10 秒窗口（每 700ms 滚动列表，
第 5 步切换下一首），一次开着主题、一次**移除 `html.m3-theme` 类并摘掉 19 个样式节点**
（主题整体失效），对比：

| 指标 | 主题开 | 主题关 |
|---|---|---|
| 帧数 / FPS | 2021 / 202.1 | 2120 / 212.0 |
| 最大帧间隔 | 404 ms | 279 ms |
| Long task | 7 次，最长 264 ms，合计 **1305 ms** | 6 次，最长 155 ms，合计 **763 ms** |
| 布局偏移 CLS | **0.0105** | 0.0461 |
| JS 堆 | 190 MB | 190 MB |

结论：
- 主题吞吐代价约 **5%**（两者都远高于 60 FPS）；
- **布局稳定性反而更好**（CLS 0.0105 vs 0.0461）—— 统一的表面层级减少了跳变；
- **堆内存完全相同**，没有泄漏。

**并据此定位并修掉一个真实开销**：`publish()` 原本在每次 `<html>` 的 style 变化时重建
**六条 tonal 色阶（约 150 次 Lab→sRGB 换算）**，而客户端在加载歌曲时会频繁改写这些内联变量。
现在按 `(源色, 模式)` 做**记忆化**，源色不变则直接复用色阶。

优化后同负载：**palette 构建次数 1 次**（此前每 tick 一次），
long task 合计 **1305 ms → 944 ms**（约 −28%），次数 7 → 5。
FPS 单跑波动较大（192 / 202 / 212），**不**据此宣称提升；可靠的是"构建次数 1"这个计数器与
long task 总量的下降。该计数器已作为断言写进 `test/m3-theme.mjs`（`paletteBuilds <= 2`），
因为这类退化在界面上**完全看不出来**，只会白白烧 CPU。

## 15. 测试自身的两个缺陷（本轮修掉）

1. **依赖当前屏幕**：`m3-theme.mjs` 原本断言"当前页面"。在 `m3-components.mjs` 把客户端切到设置页后，
   它开始报 `cmd-button=90`、`tabs radius=null` —— 看起来像主题回归，其实只是换了屏幕。
   现在它会**先导航到歌单页**再断言，连跑两次都是 22/22。
2. **把注释当成违规**：统计 `!important` / `blur` 时把我的解释性注释也算进去了。
   现在先剥离注释再统计 —— 注释不参与渲染，测注释等于测文档。

## 16. 阶段 7–9 状态与剩余工作

| 阶段 | 状态 |
|---|---|
| 7 插件兼容 | **基本完成**：LyricBar（强制阴影=无、`.lyric-bar` 存在）、RNP（4 插件全 loaded）已进断言；`#main-player` 别名排除在 `compatibility/plugins.css` |
| 8 性能 | **初测完成**（见 §8），仍需长时采样与滚动场景 |
| 9 清理 | **部分**：`surfaces.css` 与 `playlist.css` 对卡片规则的覆盖关系需要合并去重；`--md-sys-*` 回退值与调色板生成值两处来源需要标注主次 |

### 仍需在后续轮次完成（诚实清单）

1. **6–7 个组件仍未在 DOM 中观察到**（`cmd-switch` / `cmd-modal` / `cmd-sidesheet` /
   `cmd-dropdown` / `cmd-popover` / `cmd-tooltip` / `cmd-toast`）。已尝试 5 类合成触发路径均未成功。
   它们的选择器来自**客户端自己的 CSS 与状态修饰符**（可信度高于此前的哈希猜测），
   但"打开后长什么样"未经验证。若后续能拿到真实交互（人工操作一遍再复查 DOM），应优先补这一项。
2. **阶段 8 长时性能采样**：目前只有 3 秒初测（695 帧 / 最大帧间隔 8.4 ms）。
   仍需连续滚动、换歌、开关弹窗下的采样。
3. **视觉自证**：客户端窗口抓取在本环境不稳定，本项目所有结论均为 DOM / computed style 层面的实测，
   **没有**任何"看起来不错"的声明。最终以你自己打开界面的观感为准。





## 17. 【实测】solstice23 的 2.x 版 MaterialYou 能否"兼容"到 3.1.41

按用户要求，把 2.x 原版（`solstice23/material-you-theme-netease`，master `be151a6`）的源码取到
`plugins/_attic/material-you-theme-netease-2x/src/`（`styles.scss` 100 KB + `ncm-css-override.css` 等），
然后**实测它的选择器在 3.1.41 上能命中多少**（在运行中的客户端里逐个 `querySelectorAll`）：

| | 结果 |
|---|---|
| 2.x 主题用到的 **id** | **3 / 9** 命中 |
| 2.x 主题用到的 **class** | **5 / 70** 命中 |

而且命中的那些**都不是 NCM 的组件**：

- `#main-player` —— 是**本项目 DOM 别名层造出来的占位元素**，不是原生 3.x 节点；
- `#md-theme-setting` / `#md-theme-setting-btn` —— 主题**自己注入**的设置界面；
- `.item` / `.title` / `.track` —— 通用词，命中的是无关节点；
- `.refined-now-playing` / `.ignore-now-playing` —— **RefinedNowPlaying** 设的类。

**NCM 自己的 2.x 组件锚点命中数为 0**。对照它在 2.x 主题里的使用次数：
`.g-mn` 47 次、`.m-player` 28 次、`.u-cover` 9 次、`.btnp` / `.cvr` / `.prg` / `.m-nav` /
`.u-tab2` / `.z-sel` / `.mq-playing` … 在 3.1.41 的 DOM 里**全部为 0**。

### 结论：不是"改几个选择器"的事

2.x 主题的 100 KB 样式表假设的是 **2.x 的结构**（`.g-mn > .g-sd` 的布局、`.m-player .btnp` 的
控件层级、`.u-cover` 里的封面 `<img>`），不只是类名。把类名硬贴到 3.x 节点上，样式表里的
尺寸/定位/浮动会作用在与它无关的布局上 —— 结果是坏的界面，不是"兼容"。
唯一可行的做法是**逐组件把 2.x 选择器映射到 3.x 选择器**，那是**一次完整移植**，
不是兼容层。

### 而这个移植**已经存在，就是你现在装着的那个**

把两边对比：

- 安装版 manifest 自己写着 `derived_from: solstice23/material-you-theme-netease (2.x, 2023-05 弃坑)`；
- 两边**共享 38 个自定义属性名**，包括整套动态取色：
  `--md-dynamic-light-bg` / `--md-dynamic-dark-primary` / `--md-accent-color-bg-darken-rgb` /
  `--rnp-accent-color-shade-1` …；
- 差异恰好是"必须改的那部分"：3.x 版改用 3.x 自己的 `--colorFunction1..17` / `--colorMask1..5`
  与 `--colorBackground*`，并重写了全部选择器。

也就是说：**`material-you-theme-NCMv3` 就是 2.x MaterialYou 移植到 3.x 的产物**，
视觉语言、配色方案、设置界面、动态取色都来自同一作者谱系。把 2.x 的原始 CSS 搬到 3.x
不会得到"2.x 的样子"，只会得到一套对不上 DOM 的规则。

### 如果仍要推进，三条现实路径

1. **保持现状（推荐）**：上游 3.x 移植版已在运行，也就是撤下我那一层之后的状态。
2. **有选择地移植**：从 2.x 的 `styles.scss` 里挑具体区块（例如播放器、歌单行），
   逐个映射到 3.x 的真实结构（`div.tr` / `.cmd-*` / `DefaultBarWrapper` …），
   每块单独实机验证。这是可控的增量工作，我可以做。
3. **恢复我那一层**：`plugins/_attic/material3-theme-layer/theme/` 移回
   `plugins/src/MaterialYouTheme/theme/`，并在 manifest 里恢复
   `injects.Main = [main.js, theme/palette.js, theme/loader.js]`。
