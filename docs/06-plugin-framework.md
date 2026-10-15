# 06 — 插件兼容层

> 目标：`3.1.41.205529`。
> **实测：自检插件 14/14 通过；22 个真实第三方插件中 21 个成功加载。**

## 1. 为什么后端在进程外

上游 BetterNCM 把 API 宿主放在客户端里：注入的 `framework.js` 通过回环 HTTP 与 `App.cpp` 在 CEF 宿主进程里
起的 httplib 服务通信，`framework.js` 本身是 DLL 里的 RCDATA 资源。复刻这条路需要 CEF 头文件与 vcpkg 依赖，
而本机无法获取（`libcef` 克隆被阻断，见 `docs/05-compat-matrix.md`）。

但**这套 API 表面并不要求同进程**。因此本工程把同样的契约搬到 `tools/ncm_host.mjs`：

```
NetEase 渲染进程                             本机回环
┌──────────────────────────────┐            ┌───────────────────────────────────────┐
│ orpheus://orpheus/pub/app.html │   fetch    │ node tools/ncm_host.mjs               │
│                                │ ─────────► │  /api/app/{version,datapath,ncmpath,  │
│ window.betterncm               │ X-BNCM-Key │            read_config,write_config} │
│  ├─ fs / app / ncm / utils     │            │  /api/fs/*        (限定数据目录)       │
│  ├─ betterncmFetch             │            │  /api/plugins                          │
│  └─ plugin 注册表              │            │  /api/plugin/<slug>/<path>             │
│ window.plugin (每个插件一个)   │            │  /framework.js                         │
│ window.dom / h / f             │            │  /local/*      (BETTERNCM_FILES_PATH)  │
└──────────────────────────────┘            └───────────────────────────────────────┘
        ▲                                                  ▲
        │ CDP Runtime.evaluate 注入 framework.js           │ 直接读磁盘
        └────────────── tools/cdp_watch.mjs ───────────────┘
```

好处：`framework.js` 直接从磁盘读取，改完 `-Force` 重注入即可生效，无需重建 DLL；零 CEF 头文件、零 vcpkg。
`version.dll` 代理仍负责需要进程内的能力。

## 2. 启动与验收

```powershell
loader\launch.cmd                                   # 后端 + 客户端 + 注入，守护至 Ctrl+C
loader\launch.cmd -PluginsDir C:\betterncm\plugins  # 指向真实插件目录
loader\launch.cmd -Duration 45 -Force               # 定时 + 强制重注入（改了 framework.js）
loader\launch.cmd -Ncm3Gate strict                  # 恢复上游的严格 3.x 门禁
loader\launch.cmd -StopClient                       # 停客户端，关闭调试端口
```

```powershell
# 自检插件（仓库自带，14 项断言）
loader\launch.cmd -Duration 45 -Force
node tools\cdp_inject.mjs --expr "var s=window.__BNCM_SELFTEST__; s.passed+'/'+s.total"
# -> 14/14

# 真实插件兼容报告（可复现，产物落盘）
loader\launch.cmd -PluginsDir C:\betterncm\plugins -Duration 80 -Force
node tools\compat_report.mjs --out docs\real-plugin-compat.json
# -> ncm 3.1.41.205529  plugins: 22 -> loaded=21 error=1
```

## 3. 真实插件兼容结果（2026-10-01）

数据源：`C:\betterncm\plugins`（用户既有 BetterNCM 安装，22 个 `.plugin`，2025-08 最后使用）。
完整机读结果：`docs/real-plugin-compat.json`。

| 结果 | 数量 | 说明 |
|---|---:|---|
| loaded | **21** | 脚本求值 + `onLoad` 均无异常 |
| error | 1 | `StyleSnippet 0.2.2`：`Minified React error #31`（"Objects are not valid as a React child"） |
| skipped | 0 | 无插件声明 `ncm3-compatible: false` |

已加载的代表性插件：`RefinedNowPlaying 2.19.5`、`Taskbar-Lyrics 1.6.3`、`SimpleAudioVisualizer`、
`LyricBar 0.3.6`、`LibFrontendPlay 1.1.0`、`TinyNCM 1.0.3`、`PluginMarket 0.8.4`、`RoundCornerNCM`、
`StyleSnippet`（失败）、`RevivedSource`、`relive-theme`、`What-is-the-cover-of-this-music` 等。

**`StyleSnippet` 的失败是插件级的 React 版本不兼容，不是加载器缺陷**：该插件针对 NCM 2.10 时代的 React
构建，在 3.1.41 的 React 上渲染时报错。它已按设计被隔离，不影响其余 21 个插件，客户端保持正常
（`document.title` 正常、DOM 结构完整）。

## 4. `plugin` 的真实契约（重要，与常见误解不同）

上游 `BetterNCM/js-framework` 的 `src/plugin.ts`（`class NCMInjectPlugin extends EventTarget`）决定了一切。
本工程的实现逐条对齐：

| 成员 | 语义 |
|---|---|
| `plugin.onLoad(fn)` / `onConfig(fn)` / `onAllPluginsLoaded(fn)` | **注册函数**，不是可赋值属性。加载器随后派发 `load` / `config` / `allpluginsloaded` 事件 |
| `plugin.addEventListener` / `dispatchEvent` / `removeEventListener` | 插件对象本身是 `EventTarget` |
| `plugin.mainPlugin` | 另一个 `EventTarget`（上游 `class NCMPlugin extends EventTarget`），插件会往它挂方法/监听 |
| `plugin.getConfig(key, default)` / `setConfig(key, value)` | **键值对**，持久化在 `localStorage["config.betterncm.<slug>"]`（与上游一致，非整对象写入） |
| `plugin.pluginPath` / `plugin.manifest` | 插件路径 / 清单 |

三个必须踩对的细节，都是实测踩出来的：

1. **`plugin` 必须是真正的闭包绑定，不能只挂 `window.plugin`。**
   插件的回调在求值很久之后才执行，例如 `PluginMarket` 写的是
   `plugin.onLoad(function () { plugin.mainPlugin.getAdditionalSources = ... })`。
   若 `plugin` 只是全局变量，回调运行时它已被还原成 `undefined` →
   `Cannot read property 'mainPlugin' of undefined`。
   实现改为把 `plugin` 作为 `new Function('betterncm','require','plugin', code)` 的**形参**传入，
   闭包因此捕获各自的对象。
2. **`plugin` 与 `plugin.mainPlugin` 都要是 `EventTarget`。**
   `LibFrontendPlay 1.1.0` 直接调用 `plugin.mainPlugin.addEventListener(...)`。
3. **`plugin.onConfig(fn)` 的回调接收 `configToolBox` 并需要返回一个元素**
   （`makeBtn` / `makeCheckbox` / `makeInput`）。

## 5. `ncm3-compatible` 门禁：本实现与上游的有意差异（有实测依据）

上游 `v2` 的逻辑：

```cpp
static const bool isNCM3 = util::getNCMExecutableVersion().major == 3;
if (isNCM3 && !manifest.ncm3Compatible) continue;   // 未声明即跳过
```

对 `C:\betterncm\plugins` 里 22 个真实插件统计：

| 声明情况 | 数量 | 上游严格门禁下 |
|---|---:|---|
| `ncm3-compatible: true` | 5 | 加载 |
| `ncm3-compatible: false` | 0 | 跳过 |
| **完全未声明** | **17 (77%)** | **全部被静默跳过** |

照搬上游会把插件生态的 77% 静默禁用。因此本实现把该字段处理为**三态**：
`true` / `false` / `null`（未声明），**只有显式 `false` 才跳过**，未声明者照常加载。
需要上游语义时用 `-Ncm3Gate strict`。
（注意 `tools/ncm_host.mjs` 的 `normaliseManifest` 必须保留三态；早期的实现对未声明者归为 `false`，
导致 17 个插件被误跳过——这正是本轮修掉的第一个 bug。）

## 6. 提供的 API

`window.betterncm`（另暴露 `window.betterncmFetch` / `window.dom` / `window.h` / `window.f` /
`BETTERNCM_API_KEY` / `BETTERNCM_API_PORT` / `BETTERNCM_API_PATH` / `BETTERNCM_FILES_PATH`）：

| 成员 | 实测 |
|---|---|
| `fs.*` — `exists/listDir/readFileText/writeFileText/readFile/writeFile/mkdir/remove` | ✔ 往返一致 |
| `app.getVersion/getBetterNCMVersion` | ✔ 文本，对齐上游 `/app/version` |
| `app.getDataPath/getNCMPath` | ✔ 反斜杠规范化 |
| `app.readConfig(key, default)` / `app.writeConfig(key, value)` | ✔ 顶层 `cc.microblock.*` 配置（**非**每插件目录） |
| `app.reloadPlugins()` | ✔ 重新扫描并加载 |
| `app.isLightTheme/getSucceededHijacks` | ✔ / 桩 |
| `ncm.version/channelFunctions/call/on/getNCMVersion/openUrl/getPlayingSong` | ✔ |
| `utils.waitForElement/waitForFunction/debounce/delay/dom` | ✔ 语义对齐上游（**waitForElement 永不 reject**） |
| `path.join/basename/extname` | ✔ |
| `plugin.getAll()/get(slug)` | ✔ |
| `betterncmFetch(path, opts)` | ✔ 相对 `BETTERNCM_API_PATH`，自动带 key |

### 0.3.0 新增/修正的契约（都是真实插件踩出来的）

| 成员 | 变化与原因 |
|---|---|
| `ncm.getPlaying()` | **新增，且必须是同步的**。RNP 在歌词管线里同步取 `.id`；返回 `{id,title,type}`，**永不返回 null**。优先走 `findApiFunction('getPlaying')`，否则用事件/轮询维护的同步缓存 |
| `ncm.findApiFunction(name)` | **实现**：扫 `window.__BNCM_WP__.cache`（webpack 模块缓存，由预载捕获 `__webpack_require__` 得到），取代原先的 `notSupported` |
| `app.getSucceededHijacks()` | **返回真实命中列表**（数组），取代 `null`。RNP 用它决定是否显示"hijack 失败"提示 |
| `app.exec(target)` | **可开 URL / `mailto:` / 文件路径**（走 `os.navigateExternal`）；非上述形态仍拒绝进程启动 |
| `app.setRoundedCorner(v)` | 有原生命令则转发 |
| `betterncm_native.app.restart()` / `reloadIgnoreCache()` | **新增**（RNP 设置页会调用） |
| `window.loadedPlugins` | **数组 + slug 属性**混合形态；slug 为**规范化**（去版本后缀）。上游是按 slug 索引的对象，纯数组会让 `loadedPlugins.RefinedNowPlaying` 等全部静默失效 |
| `plugin.onConfig` | **现在会真正执行**：加载时主动取一次设置元素并据实记录 `hooks.onConfig`（此前从不派发 `config` 事件，22 个真实插件全部报告 false） |
| `betterncm.injector` | **新增诊断对象**：预载版本、webpack 是否被 hook、`React`/`ReactDOM`/`legacyNativeCmder` 是否存在、选择器注册表命中情况、hijack 状态 |
| `betterncm.dom.selectors` / `.selector(key)` / `.el(key)` | **新增**：按客户端版本解析选择器，缺失时上报候选节点（见 `docs/08` §5） |
| `betterncm.dev` | **新增（P17）**：面向插件作者的开发钩子对象——开发源（目录 / `.plugin` / GitHub repo，免打包）、变更检测与热重载、dev 期 hijack 规则试错、`dev.plugins(slug)` 诊断；`plugin.devMode` 对开发源插件为 `true`。见 `docs/14` |

**实测澄清（曾被误判为阻塞）**：客户端**自己**暴露了 `window.React` 与 `window.ReactDOM`
（`app/subApp.chunk` 内有 `e.exports = window.ReactDOM` 模块），也设置了
`window.legacyNativeCmder`。因此 RNP / LyricBar 的裸全局 `React`/`ReactDOM` 能解析；
框架在派发 `load` 之前会断言它们存在并在缺失时显式告警。

### 真机才暴露的两个契约缺陷（2026-10-01 修复）

| 缺陷 | 实测表现 | 修复 |
|---|---|---|
| **`window.APP_CONF` 在 3.1.41 上不存在** | 版本探测只读它 → `ncm.version === null` → `satisfies(null, '> 3.0.0')` 为假 → **所有声明 `ncm-version-req` 的插件被静默跳过**（实测报 `not satisfied by null`） | 分层探测：`APP_CONF` → **User-Agent**（`…NeteaseMusicDesktop/3.1.41.205529`）→ 上次运行记录；并且**版本未知时不再 fail-closed**，照常加载并标记 `ncm_version_unverified` |
| **`plugin.get()/getAll()` 返回的是加载器内部记录** | 调用方拿不到 `_getConfigElement`／`mainPlugin`，任何"打开插件设置视图"的代码都拿到空值——**包括我们自己的管理 UI**，它会给每个插件显示"该插件没有提供设置项" | 按上游语义返回**插件上下文**（`ctx`），内部记录改为从 `ctx._result` 取 |

> 第二条影响面很大：修好之后，契约单测里 `a config element is built (plugin.onConfig ran)`
> 才由 FAIL 转为 PASS——也就是说**管理 UI 的配置面板此前对所有插件都是坏的**，而不是插件没写配置。



**React 桥**：上游 `react.ts` 轮询 NCM 自带的 `window.React`，然后把
`window.h = React.createElement`、`window.f = React.Fragment`。
本实现相同，但**让插件加载 await 这个桥**以消除竞态（上游是并发等待，存在竞态）。
实测 `window.h` 为 function、`window.f` 为 symbol。

## 7. 尚未实现（明确记为缺口）

> **变更（0.3.0）**：`hijacks` **已实现**——但不是在原生层，而是在页面层用 webpack 模块改写
> 完成的（`tools/bncm_preload.js` + `loader/hijacks.json`）。上游那种"重写 `orpheus://` 响应体"
> 需要 CEF scheme handler，本机没有 CEF 头文件；页面级方案语义等价且更精确。
> 详见 `docs/11-hijack-engine.md`。`RefinedNowPlaying` 依赖的歌词钩子
> （`builtin:lyrics-hook`）已从真实 web.pack 推导并落地。

| 缺口 | 原因 |
|---|---|
| `native_plugin`（原生插件 DLL 装载） | 字段已解析，未装载 |
| `fs.mountFile` | 需要 scheme handler |
| `betterncm.react`（完整 React 工具集） | 仅提供 `h`/`f`（客户端自身暴露 `window.React` / `window.ReactDOM`） |
| `app.exec` 的进程启动语义 | **有意为之**：只打开 URL / `mailto:` / 文件路径（`os.navigateExternal`），不启动进程 |
| `app.openFileDialog` / `showConsole` / `takeBackgroundScreenshot` | 需要原生能力 |
| `PluginMarket` 的商店网络源 | 后端未代理外网 |

以上被调用时会**在页面控制台与 host 日志打出 `UNIMPLEMENTED API: …`**，并返回**类型正确的空值**：
列表类返回 `[]`、对象类返回 `{}`、谓词类返回 `false`、其余返回 `null`。
旧版本一律返回 `null`，而 `(await app.getSucceededHijacks()).filter(...)` 这类调用会因此直接抛错
（RefinedNowPlaying 就是这么坏的），所以空值必须按返回类型给。


## 8. 插件格式与打包

`.plugin` = ZIP，根目录 `manifest.json`，字段与上游一致
（`manifest_version` 必须为 1、`name`/`slug`/`version`/`author`/`injects`/`hijacks`/`native_plugin`/
`ncm-version-req`/`ncm3-compatible`/`startup_script`）。

```powershell
py tools\pack_plugin.py plugins\src\BNCM-SelfTest -o plugins   # 打包并校验清单
```

宿主同时接受**解包目录**与 `.plugin` 归档；`plugins/src/` 存源码不参与扫描。
对清单里 `injects` 路径与归档实际布局不一致的插件（如 `BetterCloudSearch 1.4` 声明
`./dist/main.js` 但归档只有 `main.js`），宿主会按**唯一文件名回退**并打印警告，而不是 500。

## 9. 已知限制

- 注入不跨页面重载，由 `cdp_watch.mjs` 轮询重注入；真正持久化要等渲染进程内的 CEF hook。
- 后端是独立 Node 进程：**直接双击客户端不会加载插件**，必须经 `launch.cmd`。
- 数据目录默认 `C:\betterncm`（与上游一致）；不可写时回退 `out/bncm-data`。
  本机会向该目录写入 `host.log`、`selftest*.json`——若该目录已有 BetterNCM 数据，属追加、不删除既有内容。
