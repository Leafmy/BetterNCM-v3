# 08 — 插件管理机制与 UI

> **本文写于 P15「插件解耦」之前，描述的是 core/user 两分与内置锁定那一版。**
> 现状以 `docs/20-plugin-uniformity.md` 为准：**core 层是空的**（`DEFAULT_CORE_PLUGINS = null`，
> 仓库里也没有 `plugins/core`），三个第三方插件都是普通用户插件，
> 没有锁定徽章、都能启用/禁用/卸载；`test/manager.cmd` 现在断言的正是「不存在锁定」。
> 下面关于 core 的部分保留作机制说明（`--core-plugins DIR` 仍然可用，只是没人住在那儿）。

> 代码：`tools/ncm_host.mjs`（后端契约）、`loader/manager.js`（UI）、`loader/framework.js`（加载器）
> 代码：`loader/selector-registry` 数据 → `loader/selectors.json`

## 1. 两类插件（这是本机制的核心）

| | **core（内置）** | **user（用户）** |
|---|---|---|
| 位置 | `<仓库>\plugins\core\<Slug>\` | `<数据目录>\plugins\*.plugin` 或解包目录 |
| 来源 | 随仓库分发 | 用户安装 |
| 可禁用 | **否** | 是 |
| 可卸载 | **否** | 是（**移动**到 `_uninstalled\`，不删除） |
| 受 3.x 门禁 | **否**（被采纳时已人工核对过） | 是（三态门禁，见 `docs/06` §5） |
| 受 `disabled_plugins.json` | 否 | 是 |

**"不可删除/不可禁用"不是 UI 层面的客气话**：判定只有一处——`discoverAll()` 认为目录在 core 下即
`locked: true`，`POST /api/plugins/{disable,enable,uninstall}` 对它一律返回 **403**。
UI 只是把这个事实显示出来。

## 2. 后端契约（`tools/ncm_host.mjs`）

| 端点 | 说明 |
|---|---|
| `GET /api/plugins` | `{plugins_dir, core_dir, plugins[], core[]}`；每项含 `core/locked/lock_reason/disabled` |
| `GET /api/plugin/<slug>/<path>` | 插件内文件；**先查 core 再查 user**（用户副本不能遮蔽内置插件） |
| `GET /api/state` | 管理 UI 的一次性快照（core + user + 禁用表 + 目录） |
| `GET /api/hijacks` | 预载用的 hijack 规则（含 `builtin:lyrics-hook` 展开） |
| `GET /api/selectors` | 选择器注册表（按客户端版本） |
| `GET /preload.js` `/framework.js` `/manager.js` | 注入与 UI 资源（免鉴权，环回） |
| `POST /api/plugins/disable\|enable` | 写 `<数据目录>\disabled_plugins.json` |
| `POST /api/plugins/uninstall` | **移动**到 `<数据目录>\_uninstalled\<时间戳>\` |
| `POST /api/selector-report` | 页面上报缺失选择器的候选节点 → `<数据目录>\selector-discovery.json` |

## 3. 加载顺序与形状

1. **core 先加载**（`orderCorePlugins()` 按 manifest 的 `requirements`/`loadAfter` 拓扑排序），
   再加载 user。
   这一点是功能性的：RNP 的设置页读 `loadedPlugins.RefinedNowPlaying.manifest.version`，
   LyricBar 读 `loadedPlugins.MaterialYouTheme`。
2. **`window.loadedPlugins` 是"数组 + slug 属性"的混合形态。**
   上游是**按 slug 索引的对象**，而本工程早期版本是**数组**——于是所有
   `loadedPlugins.<Slug>` 探测都静默读到 `undefined`（这正是"LyricBar 明明加载了主题却一直加
   `no-material-you-theme`"的原因）。现在两者都成立：数组语义（`.length/.map/.filter/for...of`）
   加上**规范化 slug**（去掉版本后缀）命名属性。
3. **`plugin.onConfig` 会真正执行。** 早期版本从不派发 `config` 事件，导致
   `docs/real-plugin-compat.json` 里 22 个插件的 `hooks.onConfig` **全是 false**。
   现在加载时会主动取一次设置元素，把结果据实记录。

## 4. UI（`loader/manager.js`）

上游的管理器是把 React 应用塞进客户端页面布局，并从设置齿轮的**克隆节点**打开——
两个锚点（`.cmd-icon-setting`、`section.g-mn`）在 3.1.41 中**都已不存在**（实测计数为 0）。
所以这里改成**自愈式**实现：

- **入口**：先按选择器注册表在设置图标旁插入一个 `B` 按钮；**找不到就退化为右下角浮动按钮**。
  每 4 s 重试内联入口。也就是说前端包把图标类名全改了，管理器依然可达。
- **面板**：右侧固定抽屉（`position: fixed`）+ 自带命名空间样式，不依赖也不污染客户端布局。
- **左栏**：「内置插件（不可删除 / 不可禁用）」+「用户插件」，后者带启用/禁用开关与卸载按钮。
- **右栏**：所选插件的设置视图，取自 `ctx._getConfigElement()`（即 `plugin.onConfig` 的产物）。
- **状态行**：面板头部显示 `NCM 版本 · core 3/3 · 插件 4✓ · 歌词 N 行`，数据取自
  `betterncm.status()`。**这里取代了早期的右下角浮动徽标 `#__bncm_badge__`**——状态属于
  BetterNCM 自己的面板，不应该覆盖在客户端界面之上（`test/autostart.cmd` 会断言徽标不存在）。
- **诊断页**：`betterncm.injector`（预载版本、webpack 是否被 hook、`React`/`ReactDOM`/
  `legacyNativeCmder` 是否存在、选择器注册表命中情况）、hijack 的 applied/missed/pending/errors、
  本次会话的选择器缺失记录、目录路径。

## 5. 插件市场（3.0 新增）

面板顶部现在有三个标签：**插件 / 插件市场 / 诊断**。市场页与本文描述的插件页共用同一个面板与
同一份 `/api/state`，但数据来自 `/api/market/*`（见 [`docs/21-plugin-market.md`](21-plugin-market.md)）：

- 市场是**宿主功能**，不是插件——这样它在插件坏掉时也能用，并且内置源可以离线；
- 默认启用「内置源」（`market/`，随包分发，四个自带插件）+ 本仓库的 GitHub 源；
  上游镜像保留在源列表里但默认关闭（`bncm-plugin.microblock.cc` 本机实测 522）；
- 安装是校验式的（zip / manifest / slug / sha256），失败时插件目录不变；
  卸载仍走本文 §2 的 `POST /api/plugins/uninstall`（移动到 `_uninstalled\`，可逆）。

---

## 6. 选择器注册表

前端包（`web.pack`）会独立于客户端更新，类名是 CSS Modules 哈希，因此**任何硬编码选择器都会过期**。
`loader/selectors.json` 按客户端版本给出选择器；framework 按
「本版本 → `default` → 内置兜底」的优先级合并，缺一个就向上报候选节点（见 `reportMissing()`），
使后续修复是**数据改动**而非代码改动。

3.1.41 实测可用的前缀：`RightContainer_`、`AppScrollContainer_`、`LeftScrollContainer_`、
`MiniModeIconBar_`、`LyricWrapper_`、`ScrollableLyricDisplayContainer`、`LyricDisplayInnerContainer`。
**已失效**：`.cmd-icon-setting`、`section.g-mn`、`CommentWrapper_`、`u-cover`。

## 7. 验收

```powershell
loader\startup.cmd -Status
node tools\cdp_inject.mjs --expr "JSON.stringify(window.__BNCM_LOADED__.core)"
node tools\cdp_inject.mjs --expr "JSON.stringify(window.loadedPlugins.MaterialYouTheme && true)"
node tools\cdp_inject.mjs --expr "JSON.stringify(window.betterncm.injector)"
powershell -NoProfile -ExecutionPolicy Bypass -File test\manager.ps1
```

期望：core 三个 slug 均为 `loaded`；`loadedPlugins.MaterialYouTheme` 有值；
对 core 调 `POST /api/plugins/uninstall` 返回 403 且磁盘无变化。
