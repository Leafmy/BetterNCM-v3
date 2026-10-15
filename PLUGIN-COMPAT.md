# 新插件兼容指南（BetterNCM 3.1.41 兼容层）

> 目标客户端：网易云音乐 **3.1.41.205529**（`web.pack` `83304b1`，hijack 规则出处已随该包复核）· 运行时 `loader/framework.js` = `bncm-v3-framework/0.4.0` · 后端 `tools/ncm_host.mjs`
> 本文结论均来自本仓库代码；无法确证的地方标 **未验证**。最权威的 API 契约清单是 `test/framework-api.test.mjs`。

本指南回答：**写好了一个 BetterNCM 插件，怎样才能让它在这个实现上真正加载并工作？**
最短答案：插件是一个 ZIP（`.plugin`）或解包目录，根目录放 `manifest.json`，`injects.Main` 指向入口 JS；入口 JS 通过形参 `betterncm` / `require` / `plugin` 拿 API。不要依赖 `window.APP_CONF`，不要假设未实现的 API 会抛错，不要按对象遍历 `window.loadedPlugins`。其余 90% 的坑在第 10 节。

---

## 1. 最小可用插件

目录（`plugins/src/MyPlugin/`）：`manifest.json` + `index.js`。

```json
{
  "manifest_version": 1,
  "name": "My Plugin",
  "slug": "my-plugin",
  "version": "1.0.0",
  "author": "your-name",
  "description": "一句话说明这个插件做什么。",
  "type": "extension",
  "ncm-version-req": "> 2.10.2",
  "injects": {
    "Main": [ { "file": "index.js" } ]
  }
}
```

```js
/* 入口脚本被求值为 new Function('betterncm', 'require', 'plugin', code)：
   这三个形参就是你能直接用的东西。不要把它们当全局变量长期依赖。 */
(function () {
  'use strict';
  var bncm = betterncm;

  plugin.onLoad(function () {                        // 注册函数，不是可赋值属性
    console.log('[my-plugin] loaded, NCM =', bncm.ncm.getNCMVersion());
  });
  plugin.onConfig(function (toolbox) {               // 有设置项才需要注册
    return toolbox.makeBtn('点我', function () {}, false, {});
  });
  plugin.onAllPluginsLoaded(function (loaded) {      // 此时 window.loadedPlugins 已发布
    console.log('[my-plugin] 共加载', loaded.length, '个插件');
  });
})();
```

三点必须踩对：
1. `plugin.onLoad / onConfig / onAllPluginsLoaded` 是**注册函数**，加载器随后派发 `load` / `config` / `allpluginsloaded` 事件；写成 `plugin.onLoad = fn` 无效。
2. 回调必须闭包捕获**形参** `plugin`。回调在求值很久之后才执行，那时 `window.plugin` 已被还原，把 `plugin` 当全局变量读会得到 `undefined`。
3. `plugin` 与 `plugin.mainPlugin` 都是 `EventTarget`，可以直接 `addEventListener` / `dispatchEvent`。

---

## 2. manifest 字段全解

`tools/ncm_host.mjs` 的 `normaliseManifest()` 会把磁盘上的清单**重建成一个固定字段集**再经 `GET /api/plugins` 交给 `loader/framework.js`。所以「字段存在」不等于「字段被读」：

| 字段 | 必需 | 加载器实际怎么处理 |
|---|---|---|
| `manifest_version` | **是**（打包器强制） | `loadPlugin()` 里 `if (m.manifest_version !== 1)` → `state:"skipped"`，`error:"unsupported manifest_version N"`。**必须为 `1`** |
| `name` | **是**（打包器要求） | 仅展示：管理 UI 列表、`__BNCM_LOADED__.plugins[].name` |
| `slug` | 建议必需 | 插件身份，缺失时回退目录名/归档名。用于 `/api/plugin/<slug>/…` 取文件、`loadedPlugins.<Slug>` 属性、`plugin.get(slug)`、`disabled_plugins.json`。**改名等于换身份** |
| `version` | **是**（打包器要求） | 仅展示/诊断；缺失补 `"0.0.0"` |
| `author` | **是**（打包器要求） | 仅展示；缺失补 `"unknown"` |
| `description` | 否（建议写） | 仅管理 UI（`GET /api/state` 的 `description`）；缺失补 `""` |
| `type` | 否 | 透传到记录，缺失补 `"extension"`；加载逻辑不使用 |
| `ncm-version-req` | 否 | 缺失补 `"> 2.10.2"`。版本已知时是硬门槛，未知时只标记不拦截（第 3 节） |
| `ncm3-compatible` | 否（**三态**） | `true` / `false` / 缺失。只有显式 `false` 会跳过；缺失照常加载（第 3 节） |
| `injects` | **是**（否则加载成功但不执行代码） | 只读 `injects.Main` 与 `injects["/pub/app.html"]` 两个桶；元素必须是 `{ "file": "..." }`，路径开头 `./` 会被去掉 |
| `hijacks` | 否 | **框架不读，由预载消费**：宿主 `aggregateHijacks()` 展平成 `GET /api/hijacks` 的规则列表（第 7 节） |
| `requirements` / `loadAfter` | 否 | 依赖插件的 slug 列表，`orderPlugins()` 把两者合并成排序提示（不是硬依赖）。**已由 `normaliseManifest` 透传**，排序在真实宿主上确实生效（第 4 节） |
| `author_links` / `source` / `preview` | 否 | 透传保留（上游商店元数据 / 溯源用），**加载器不读**，仅供诊断 |
| `incompatible` | 否 | 透传保留，但**仍无任何实现**：宿主与加载器都不据此做互斥检查，既不阻止加载也不告警 |
| `betterncm_version` | 否 | 被规范化成 `">=1.0.0"`，但 **`framework.js` 从不校验**；写它只为与上游清单兼容（拒绝行为 **未验证**） |
| `native_plugin` | 否 | 被规范化（缺省 `null`），但 **`framework.js` 从不读取**：原生 DLL 装载未实现（第 6 节） |
| `startup_script` | 否 | 被规范化（缺省 `"startup_script.js"`），但 **`framework.js` 从不读取**：该入口不执行 |

实测（用宿主自身代码读真实插件目录）：

```powershell
node -e "import('./tools/ncm_host.mjs').then(m=>{for(const x of m.discoverPlugins('plugins/src'))console.log(x.manifest.slug, Object.keys(x.manifest).join(','))})"
# -> slug,name,version,author,description,type,manifest_version,betterncm_version,
#    ncm_version_req,ncm3_compatible,ncm3_declared,injects,hijacks,startup_script,
#    native_plugin,hide,loadAfter,requirements,incompatible,author_links,preview,source
```

**没出现在这份键表里的字段就是真丢了**，例如 `legacy_hijacks`、`hijack_note` 这类自定义键不会透传
（`hide` 与 `ncm3_declared` 是宿主另加的，加载器不读）。

依赖声明（`loadAfter` / `requirements`）与溯源字段**已在透传之列**——早期版本会把依赖声明一并丢掉，
导致排序在真实客户端上静默失效，该缺陷已修复，并由 `test/plugin-ordering.test.mjs` 钉住。

---

## 3. 3.x 门禁的三态语义

这是与上游**有意且关键**的差异。上游 v2 的逻辑是「客户端是 3.x 且 `ncm3-compatible` 不为 `true` 就跳过」，而实测真实插件目录 22 个 `.plugin` 中有 **17 个（77%）从未声明该字段**——照搬上游等于静默禁用大半个生态。

| 清单声明 | 非 strict（默认） | strict（`-Ncm3Gate strict`） |
|---|---|---|
| `"ncm3-compatible": true` | 加载 | 加载 |
| `"ncm3-compatible": false` | **跳过** | **跳过** |
| 字段缺失（`null`） | **加载** | **跳过**（`error:"ncm3-compatible not declared (strict gate)"`） |

判断只有两处（`framework.js`，`CFG` = `window.__BNCM_CONFIG__`）：

```js
var STRICT_NCM3 = CFG.ncm3Gate === 'strict';
if (STRICT_NCM3 && m.ncm3_compatible !== true) { result.state = 'skipped'; ... }
if (m.ncm3_compatible === false)               { result.state = 'skipped'; ... }
```

恢复上游语义：`loader\launch.cmd -Ncm3Gate strict`（或给 watcher/agent 传 `--ncm3-gate strict`）。**core 插件（`plugins/core/`）完全绕过门禁与版本区间，也忽略禁用表**——它被采纳时已人工核对过；用户插件才走上面的判定。

### 版本门禁同样 fail-open

```js
if (ncm.version) {
  if (!satisfies(ncm.version, m.ncm_version_req)) { skip; }   // 版本已知 → 硬门槛
} else if (m.ncm_version_req && m.ncm_version_req !== '*') {
  result.ncm_version_unverified = true;                        // 版本未知 → 加载 + 标记
  warn('client version unknown; loading ' + m.slug + ' without checking ncm-version-req ...');
}
```

- 版本**已知**且不满足 → `skipped`，`error:"ncm-version-req X not satisfied by Y"`。
- 版本**探测不到** → **不跳过**，加载并打标 `ncm_version_unverified`：未知版本是我们的探测盲区，不是「插件不兼容」的证据。查看方式：`window.__BNCM_LOADED__.plugins.filter(p => p.ncm_version_unverified).map(p => p.slug)`。
- `satisfies()` 是极简实现：`> 2.10.2` 这类**运算符与版本间带空格**的写法可用（不按空白切分区间），多比较符是与、`||` 是或、空区间与 `*` 恒真；**不支持** `^` / `~` / 预发布语义。

> `betterncm.status().ncmVersionUnverified` **已修复**：现在按逐插件记录聚合
> （`plugins.some(p => p.ncm_version_unverified)`）。早期版本读的是从未赋值的顶层键，因而恒为 `false`。
> 两种写法都可用；逐插件过滤还能进一步定位是**哪一个**插件被标记。

---

## 4. 加载顺序与依赖

`loadAllPlugins()` 的顺序固定：① 等 React 桥（`window.h`/`window.f`）就绪 → ② 拉选择器注册表（`GET /api/selectors`）→ ③ 拉清单（`GET /api/plugins`）→ ④ **core 列表逐个加载完，再逐个加载 user 列表**（同一条串行 promise 链）→ ⑤ 发布 `window.loadedPlugins` 并对每个已加载插件派发 `allpluginsloaded` → ⑥ 最后挂载管理 UI（`GET /manager.js`，它失败**不会**影响插件加载）。

两个列表各自先经过 `orderPlugins()` 拓扑排序：

```js
var after = [].concat(p.manifest.loadAfter || [], p.manifest.requirements || []);
after.forEach(function (slug) { if (bySlug[slug]) visit(bySlug[slug], depth + 1); });
```

- `loadAfter` 与 `requirements` **同等对待**，都是「让我排在它们之后」的排序提示，不是硬依赖。
- 递归有 `seen` 去重与 `depth > 8` 上限，循环依赖不会死循环（超深度的边被丢弃）。
- 排序**同时作用于 core 与 user 列表**（早期实现只排 core，用户插件的 `loadAfter` 被静默忽略）。
- `incompatible` **没有任何实现**：既不阻止加载也不产生警告。

> **第 4 节偏差已修复。** 早期 `normaliseManifest()` 用固定字段集重建清单，`loadAfter` / `requirements`
> 不在其中，于是经真实宿主加载时这两个字段在加载器眼里恒为 `undefined`，**排序静默不发生**
> （`framework-api.test.mjs` 没能发现，是因为它自建清单绕过了宿主）。现在两者都会透传，
> `test/plugin-ordering.test.mjs` 用「真实文件 + 真实宿主 `discoverPlugins()` + 真实 `/api/plugins` 载荷」钉住该行为。
> **仍然建议**：这两个字段是排序提示而非硬依赖，跨插件取用请用 `plugin.onAllPluginsLoaded` +
> `betterncm.plugin.get(slug)` 做运行时探测，不要把正确性押在加载顺序上。

---

## 5. 生命周期钩子

运行时**只会**调用下面三个注册函数（`framework.js` 的 `makePluginContext()`）：

| 注册函数 | 事件名 | 回调签名（`fn.call(inject, …)`） | 何时派发 |
|---|---|---|---|
| `plugin.onLoad(fn)` | `load` | `fn(detail, event)`，`detail` = 该插件的 `plugin` 上下文 | 入口脚本全部求值成功之后 |
| `plugin.onConfig(fn)` | `config` | `fn(configToolBox)`，**返回值被当成设置元素** | 加载时主动取一次（`ctx._getConfigElement()`），管理 UI 打开设置视图时再取 |
| `plugin.onAllPluginsLoaded(fn)` | `allpluginsloaded` | `fn(detail, event)`，`detail` = `window.loadedPlugins` | 全部插件加载完之后 |
| `plugin.addEventListener` / `removeEventListener` / `dispatchEvent` | 任意 | 标准 `EventTarget` 语义 | 插件可自行冒泡自定义事件 |

三个钩子的调用都被 `try/catch` 包住：`onLoad` 抛错 → `inject.loadError` 被置位 → 该插件 `state:"error"`；`onConfig` 抛错 → 只 `warn(m.slug + '.onConfig threw: …')` 且 `hooks.onConfig` 记 `false`；`onAllPluginsLoaded` 抛错 → 只警告。

**没有 `onEnable` / `onDisable`**（`loader/framework.js` 与 `loader/manager.js` 均无，已全仓检索）。启用/禁用完全由宿主实现：写 `<数据目录>\disabled_plugins.json` 后重载，被禁用的插件脚本**根本不会被求值**，所以不要指望收到「被禁用」的通知。

`plugin` 上下文上值得一提的成员：`plugin.manifest`（规范化清单）；`plugin.pluginPath`（实际是 **slug**，不是磁盘路径，`pluginPath: m.slug`）；`plugin.mainPlugin`（另一个 `EventTarget`，插件常往它上面挂方法/监听，是跨插件通信的常见做法）；`plugin.getConfig(key, default)` / `setConfig(key, value)`（**键值对**，持久化在 `localStorage["config.betterncm.<slug>"]`）；`plugin.configViewElement` / `haveConfigElement()` / `_getConfigElement()`（上一次 `onConfig` 的产物，后者会按需派发 `config` 事件）；`plugin.loadError`（`onLoad` 抛出的异常，正常时为 `null`）。

```js
plugin.onConfig(function (toolbox) {
  var wrap = document.createElement('div');
  wrap.appendChild(toolbox.makeBtn('保存', function () {}, false, {}));
  wrap.appendChild(toolbox.makeCheckbox({ checked: plugin.getConfig('on', true),
    onclick: function (e) { plugin.setConfig('on', e.target.checked); } }));
  wrap.appendChild(toolbox.makeInput(plugin.getConfig('text', ''), {
    onchange: function (e) { plugin.setConfig('text', e.target.value); } }));
  return wrap;                  // 必须有返回值，否则 UI 显示「该插件没有提供设置项」
});
```

**入口脚本执行环境**：`new Function('betterncm', 'require', 'plugin', code + sourceURL)`。`require()` 只认 `'betterncm'`，其它 id 抛 `require("…") is not supported`；不是 ES module，无 `import`/`export`、无顶层 `await`。

---

## 6. API 表面：已实现 vs 未实现

`window.betterncm`（另暴露 `window.betterncmFetch` / `window.dom` / `window.h` / `window.f` / `window.BETTERNCM_API_KEY` / `BETTERNCM_API_PORT` / `BETTERNCM_API_PATH` / `BETTERNCM_FILES_PATH` / `window.betterncm_native`）。

| 已实现 | 说明 |
|---|---|
| `betterncm.fs.*` | `exists` / `listDir` / `readFileText` / `writeFileText` / `readFile`（返回 `ArrayBuffer`）/ `writeFile` / `mkdir` / `remove`，全部经 Node 后端；**路径限制在数据目录内**，越界报错 |
| `app.readConfig(key, default)` / `writeConfig(key, value)` | 读写 `<数据目录>\config.json` 顶层键，文本返回，签名同上游 |
| `app.getVersion` / `getBetterNCMVersion` / `getDataPath` / `getNCMPath` | 文本；路径中的 `/` 规范化为 `\` |
| `app.getSucceededHijacks()` | **返回数组**（可能为空），元素形如 `"<slug>:<ruleId>"`，绝不是 `null` |
| `app.exec(target)` | 只接受 `http(s):` / `mailto:` / `orpheus:` / `X:\` 形态，走原生 `os.navigateExternal`；其它形态转交未实现桩 |
| `app.reloadPlugins()` / `isLightTheme()` / `getNCMWinPos()` / `setRoundedCorner(v)` | 重跑发现+加载 / 走原生桥或返回兜底值 |
| `ncm.call(cmd, …args)` / `ncm.callRaw(cmd, …args)` | 包 `window.channel.call`。`call`：**多参回调**解析成参数数组，单参解析成该值（`a.length > 1 ? a : a[0]`）；`callRaw` 永远解析成原始参数数组（诊断用） |
| `ncm.on(event, handler)` | 包 `channel.registerCall`，返回 `off()`（当前 `off` 是空实现） |
| `ncm.getNCMVersion()` / `ncm.version` | 客户端版本字符串（探测分层见第 3 节） |
| `ncm.getPlayingSong()` / `ncm.getPlaying()` | 前者异步、桥无返回时为 `null`；后者**同步、永不返回 `null`**（兜底 `{id:'',title:'',type:0}`） |
| `ncm.findApiFunction(name)` | 扫 webpack 模块缓存找导出函数；预载未 hook 时返回 `null` |
| `ncm.openUrl(url)` / `ncm.channel` / `ncm.channelFunctions` | 原生 opener（失败回退 `window.open`）/ 桥对象 / 函数名清单 |
| `utils.waitForElement` / `waitForFunction` / `debounce` / `delay` / `dom` / `appendStyle` | `waitForElement` **永不 reject**（同上游）；`dom(tag, settings, …children)` 即 `window.dom`；`appendStyle(css, id)` 幂等 |
| `betterncm.path.join` / `basename` / `extname` | Windows 风格路径处理 |
| `betterncm.betterncmFetch(path, opts)` | 相对 `BETTERNCM_API_PATH` 取数并自动带 `X-BNCM-Key`（`opts.ignoreApiKey` 可关） |
| React 桥 `window.h` / `window.f` | `h = React.createElement`、`f = React.Fragment`；加载插件前会 **await** 这个桥，消除上游竞态 |
| `betterncm.plugin.getAll()` / `get(slug)` | 返回**插件上下文**（含 `mainPlugin`、`_getConfigElement`），不是内部记录 |
| `betterncm.dom.selectors` / `selector(key)` / `el(key)` / `reportMissing(key)` | 按客户端版本解析的 DOM 选择器注册表 |
| `betterncm.injector` | 诊断对象：预载版本、webpack 是否被 hook、`React`/`ReactDOM`/`legacyNativeCmder` 是否存在、选择器命中、hijack 状态、歌词通路、DOM 别名 |
| `betterncm.status()` / `statusText()` | 状态快照（build、NCM 版本、core/user 计数、失败列表、hijack 计数、歌词行数） |
| 插件隔离 | 单文件求值失败只影响该插件（`runScript()` 捕获异常 → `state:"error"`），其它插件继续加载；`plugins/src/Broken-Plugin` 即此负向样例 |

| 未实现（明确记为缺口） | 现状 |
|---|---|
| `native_plugin`（原生插件 DLL） | 字段被规范化但**不装载**；`window.betterncm_native.native_plugin` 不存在 |
| `betterncm.fs.mountFile` | 需要 `orpheus://` scheme handler（CEF hook），未实现 |
| 完整 `betterncm.react` | 只提供 `h` / `f`（客户端自身暴露 `window.React` / `window.ReactDOM`） |
| `app.exec` 的进程启动语义 | **有意缩减**：只打开 URL / `mailto:` / 文件路径，不启动任意进程 |
| `app.openFileDialog` / `showConsole` / `takeBackgroundScreenshot` | 需要原生能力，是显式桩 |
| `startup_script` 入口 / `incompatible` 互斥检查 / 插件商店网络源 | 均未实现 |

### 未实现 API 的行为：显式告警 + 空值

```js
function notSupported(name, why, empty) {
  if (!warned[name]) { warned[name] = true; warn('UNIMPLEMENTED API: ' + name + ' (' + why + ') -- returning ' + ...); }
  return Promise.resolve(empty === undefined ? null : empty);
}
```

- 每个名字**只告警一次**，同时进页面控制台与宿主日志（`POST /api/log`）。
- 返回值形状由第 3 个参数决定：**列表给 `[]`、对象给 `{}`、谓词给 `false`**；**但当前所有内置桩的调用点都没传**第 3 个参数，所以它们实际解析为 `null`——`test/framework-api.test.mjs` 明确断言了 `takeBackgroundScreenshot()` 解析为 `null`。真正返回列表的是 `app.getSucceededHijacks()`，它不是桩。
- **可操作结论**：不要假设任何未实现 API 返回非 `null`；要立刻解引用/遍历的结果自己兜一层 `var list = (await betterncm.app.getX()) || [];`。反面教材：早期实现让 `getSucceededHijacks()` 返回 `null`，而插件写的是 `(await betterncm.app.getSucceededHijacks()).filter(...)`，于是加载即抛 `Cannot read properties of null`——这就是「空值必须按返回类型给」这条规则的由来。

---

## 7. hijacks（页面级模块改写）

上游用 CEF scheme handler 重写 `orpheus://` 响应体；本实现没有 CEF 头文件，改为在**页面层**改 webpack 模块工厂（`tools/bncm_preload.js`，由 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 在 document-start 注册）。

### 规则形状

插件清单里的 `hijacks` 是「**版本区间 → URL → 规则**」两层映射：

```json
{ "hijacks": {
  ">= 3.1.11": { "orpheus://orpheus/pub/hybrid/vendors": { "rule": "builtin:redux-dispatch-hook" } },
  ">= 2.10.4": { "orpheus://orpheus/pub/core": {
    "type": "replace", "from": "if(!e.lrc&&!e.yrc)return t;", "to": "/* 替换文本 */" } }
} }
```

- 第一层的键是 **version_range**。宿主 `aggregateHijacks()` 遍历**所有**区间，把每个 URL 条目展平成一条规则交给引擎并原样带上 `version_range`，规则 `id` 为 `` `${slug}::${url}` ``。**读代码确认 `bncm_preload.js` 里没有任何地方读 `version_range`**——版本区间目前只作分类/文档用途，**不会**按客户端版本筛选，所有非 `pending` 规则一律参与匹配。
- 两种类型：`replace`（`from`/`to` 文本替换后 `new Function` 重新注册工厂，对应上游 `hijacks` 语义）；`wrap-export`（`locate`/`wrapper`，模块执行完时替换导出函数）。**本客户端上 `wrap-export` 基本不可用**：webpack harmony 导出是 `configurable:false` 的访问器，替换会 `TypeError`，引擎会把失败**显式写进** `window.__BNCM_HIJACK__.errors` 而不假装成功。
- **`builtin:` 规则**：`{"rule":"builtin:xxx"}` 表示委派给 `loader/hijacks.json` 的内置规则，由宿主聚合时展开成具体 `from`/`to`，引擎只会看到可执行规则。委派规则**继承内置规则的 `pending`**（否则关闭内置规则后委派副本仍在生效——实测踩出来的坑）。
- 规则不完整（`replace` 缺 `from`/`to`，`wrap-export` 缺 `locate`/`wrapper`）会被标 `pending`，引擎装载时 `filter(r => !r.pending)` 直接丢弃。

### 为什么默认关闭（有意为之）

现有两条内置规则（`builtin:lyrics-hook`、`builtin:redux-dispatch-hook`）**都是 `pending:true`**，工程上也默认不做拦截。对照实测：

| 场景 | 结果 |
|---|---|
| 无注入 | 正常渲染 |
| 注入但**不拦截** webpack（`intercept:false`） | 正常渲染，`pageErrors = 0` |
| 注入并拦截 webpack（**passthrough、0 条规则**） | **白屏**：`#root` 0 个子节点，5 条 `Script error.` |

即**只要对 `window.webpackJsonp` 做拦截，客户端就会启动失败**，即使一条规则都没有。更具体地说，改写后的工厂由 `new Function('return (' + source + ')')()` **重建**，在全局作用域重新创建函数、**丢掉原工厂的闭包**；只要模块里有任何从外层作用域解析的自由标识符，运行时就会抛错，而**一个模块抛错就足以中止整个启动**。

所以拦截改为**按需开启**：`tools/bncm_agent.mjs` 的 `hijackRulesEnabled()` 读 `loader/hijacks.json`，只在**存在 `!pending` 且带 `from`/`locate` 的规则**时才给预载传 `intercept:true`；为 `false`（当前默认）时预载只是一个「把框架拉起来」的引导脚本，**完全不碰 webpack**。引擎能力完整保留，待作用域保持方案落地后可用。

### 按插件开启，以及风险

1. 在自己清单的 `hijacks` 里写具体规则，或委派一个非 `pending` 的 `builtin:` 规则。
2. 规则**不带 `pending`**（有 `from`/`to`，或委派的内置规则不是 `pending`）——只有此时 agent 才会把 `intercept` 置真。
3. 重载页面后用诊断确认：`node tools\cdp_inject.mjs --expr "JSON.stringify(window.__BNCM_HIJACK__)"`。

**风险不是「可能不生效」，而是「可能白屏」**：拦截一旦开启，整个客户端可能无法挂载。所以开发时先用 `test\autostart.cmd` + 人工目视确认页面正常，再看功能；引擎会把未捕获错误记进 `window.__BNCM_HIJACK__.pageErrors`（`error` + `unhandledrejection` 探针），这是白屏时唯一的线索。诊断语义：`applied` = 真正改写成功，`skipped` = 命中但蓄意不改写（带原因），`missed` = 规则从未命中任何模块（通常意味着前端包已更新）。加固：每个工厂只处理一次（`__bncmSeen` 标记），超过 `MAX_REWRITE_BYTES`（512 KB）的模块记一次 `skipped` 后放弃，避免解析器栈溢出刷屏。

### 漂移守卫

`test/preload-engine.test.mjs` 会对真实 `web.pack` 重新断言：每条已发布且非 `pending` 的规则，其 `from` 片段必须仍能命中，且包内 `pub/COMMITHASH` 必须等于规则记录的 `derived_from_pack.commithash`（找不到 `web.pack` 时该组断言跳过）。前端包更新导致规则失效时，用 `node tools\hijack_probe.mjs` 重新推导。

---

## 8. 打包与安装

`.plugin` 就是 **ZIP**，根目录放 `manifest.json`：

```powershell
py tools\pack_plugin.py plugins\src\MyPlugin -o plugins
# packed my-plugin.plugin  (N files, N bytes)
```

`pack_plugin.py` 的校验与加载器一致：必需 `manifest_version` / `name` / `version` / `author`；`manifest_version` 必须为 `1`；`injects` 若存在必须是对象；slug 取 `manifest.slug`，缺失则由 `name` 生成（非字母数字→`-`、转小写、合并重复连字符）；输出 `<out>/<slug>.plugin`，`manifest.json` 排第一条；跳过 `__pycache__` / `.git` / `*.pyc`。

宿主**同时接受两种形态**：打包归档 `<插件目录>\my-plugin.plugin`（中央目录驱动读取，容忍前置数据），以及解包目录 `<插件目录>\MyPlugin\manifest.json`。`plugins/src/` 放源码、**不参与扫描**（扫描 `--plugins` 指定目录，默认仓库下 `plugins/`；`plugins/core/` 只有显式 `--core-plugins` 时才算内置插件，默认为空）。实用兜底：清单 `injects` 路径与归档实际布局不一致时（上游有归档声明 `./dist/main.js` 而实际只有 `main.js`），宿主按**唯一文件名**回退并打警告，而不是返回 500。

```powershell
loader\launch.cmd -PluginsDir C:\betterncm\plugins   # 指向真实插件目录
```

---

## 9. 自测与验收

**不需要客户端**（每次改框架/预载必跑）：

```powershell
node test\framework-api.test.mjs     # 框架 API 契约（假 DOM + 桩后端）
node test\preload-engine.test.mjs    # hijack 引擎单测 + 真实 web.pack 漂移守卫
node test\plugin-ordering.test.mjs   # 依赖排序：走真实宿主 discoverPlugins()
```

本机实测：`framework-api` **34 passed, 0 failed**；`preload-engine` **64 passed, 0 failed**；
`plugin-ordering` **16 passed, 0 failed**；三者退出码均为 0。

`framework-api.test.mjs` 是最权威的 API 契约清单：用假 DOM 与桩后端执行真实 `loader/framework.js`，逐条钉住已实现行为（core 先加载并绕过门禁、`loadedPlugins` 的数组+slug 混合形态、`getPlaying()` 同步、`getSucceededHijacks()` 返回数组、`app.exec` 走原生 opener、未知版本不 fail-closed、`onConfig` 真的执行、选择器注册表合并、未实现 API 的空值形状等）。

它**不覆盖**依赖真实宿主 `normaliseManifest()` 的字段透传——那正是 `plugin-ordering.test.mjs` 的职责：
它在临时目录里写真实 `manifest.json`，交给**真实的** `discoverPlugins()`，再把宿主 `/api/plugins` 的原样载荷
喂给 `framework.js`，断言加载顺序符合 `loadAfter` / `requirements`。
（这个测试的存在本身就是教训：只用自建对象的测试会让「字段在宿主层被丢掉」这类缺陷完全隐形。）

**需要运行中的客户端 / 后端**：

```powershell
loader\launch.cmd -Duration 45 -Force                            # 起后端 + 客户端 + 注入
node tools\cdp_inject.mjs --expr "JSON.stringify(window.__BNCM_LOADED__.plugins)"
node tools\cdp_inject.mjs --expr "JSON.stringify(window.betterncm.status())"
node tools\cdp_inject.mjs --expr "JSON.stringify(window.__BNCM_INCOMPAT_RAN__)"
test\autostart.cmd                                              # 需要运行中的客户端
test\manager.cmd                                                # 需要运行中的后端
node tools\compat_report.mjs --out docs\real-plugin-compat.json  # 批量兼容报告
```

判定要点：仓库自带的 **`plugins/src/BNCM-SelfTest`** 是参考插件兼验收插件，结果写进 `window.__BNCM_SELFTEST__`（`{build, appver, passed, total, results}`）与 `<数据目录>\selftest-result.json`；**`plugins/src/Broken-Plugin`** 必须在加载期抛错并被记成 `error`，而其它插件照常加载；**`plugins/src/Incompatible-Plugin`** 声明 `ncm3-compatible:false`，其脚本**绝不能执行**（探针 `window.__BNCM_INCOMPAT_RAN__` 必须为 `undefined`）。

---

## 10. 常见坑（症状 → 原因 → 修法）

**10.1 `window.loadedPlugins` 是「数组 + slug 属性」混合体。**
症状：`Object.keys(window.loadedPlugins)` 近乎空；`for (var k in loadedPlugins)` 里 `loadedPlugins[k].manifest` 为 `undefined`；`JSON.stringify` 丢掉全部 slug 属性。
原因：发布的是**真正的数组**（`.length`/`.map`/`.filter`/`for...of` 可用），每个已加载插件的**规范化 slug**（去版本后缀）作为**属性**挂在同一个数组对象上；上游是按 slug 索引的对象，所以「按对象遍历」在上游也不会露馅。
修法：按 slug 精确取用，不遍历对象键。

```js
var theme = window.loadedPlugins.MaterialYouTheme;        // ✅ 属性
var hit = window.loadedPlugins.filter(function (p) {      // ✅ 数组语义
  return p.manifest && p.manifest.slug === 'some-slug'; });
// ❌ Object.keys(loadedPlugins) / for...in / structuredClone / deep-merge
```

**10.2 跨插件探测靠 `loadedPlugins.<Slug>`，改 slug 等于把别人坑了。**
症状：你改了 `slug`，自己一切正常，别的插件**不再检测到你**，静默降级且无任何报错。
原因：跨插件探测的既定契约是 `window.loadedPlugins.<Slug>.manifest.version` 与 `plugin.get(<Slug>)`，属性名来自 `manifest.slug`（另有原始文件名 slug 作别名）。
修法：**把 slug 当不可变的公开 API**，发布后不改；确需改名时保留一个能被老代码识别的别名并在更新说明里提示。探测别人时要容错：`var dep = window.loadedPlugins && window.loadedPlugins.SomePlugin; if (dep && dep.manifest) { … }`。

**10.3 `getSucceededHijacks()` 返回 `null` 会直接炸掉调用方。**
症状：`TypeError: Cannot read properties of null (reading 'filter')`，多发生在插件加载初期。
原因：早期实现让未实现 API 一律返回 `null`，而真实插件写的是 `(await betterncm.app.getSucceededHijacks()).filter(...)`。
修法：本版本已改为返回**真实数组**（可为空），并确立通用规则——未实现 API 的空值要按返回类型给（列表 `[]`、对象 `{}`、谓词 `false`）。注意当前内置桩仍未传形状参数，故它们解析为 `null`；你自己对外暴露的查询接口也要返回空数组而不是 `null`。

**10.4 `ncm.call` 的多参回调：只取第 0 个参数会拿到 `"success"`。**
症状：拿到字符串 `"success"` 而不是后面那个真正的数据数组，于是 `Array.isArray` 为假、长度判断失效、代码静默走兜底分支。
原因：原生桥回调可以收到**多个参数**（「成功状态 + 载荷」是常见形态）；早期实现只转发 `arguments[0]`，把状态字符串当成了结果。
修法：现在的约定是客户端自身的惯例 `r.length > 1 ? r : r[0]`：

```js
var r = await betterncm.ncm.call('some.native.command', arg1);
var payload = Array.isArray(r) ? r[r.length - 1] : r;                 // 多参：最后一个通常是载荷
var raw = await betterncm.ncm.callRaw('some.native.command', arg1);   // 永远是数组
```

另外：**不是每条命令都会回调出值**——有些回调 `undefined`，真正的数据经 `betterncm.ncm.on(event, handler)`（底层 `channel.registerCall`）推送，两条路都要考虑。

**10.5 `window.APP_CONF` 在 3.1.41 上不存在 → `ncm.version === null`。**
症状：`betterncm.ncm.version === null`；所有声明 `ncm-version-req` 的插件被 `skipped`，`error` 形如 `ncm-version-req > 3.0.0 not satisfied by null`。
原因：上游（及早期实现）只从 `window.APP_CONF.appver` 取版本，而**实测 3.1.41 上 `window.APP_CONF` 是 `undefined`**，`satisfies(null,'> 3.0.0')` 为假 → 静默跳过。
修法：本版本分层探测 `window.APP_CONF` → **User-Agent**（`… NeteaseMusicDesktop/3.1.41.205529`）→ 上次运行记录（`window.__BNCM_LOADED__.appver`）。插件侧别自己解析版本，用 `betterncm.ncm.getNCMVersion()`；`JSON.parse(window.APP_CONF).appver` 在 3.1.41 上直接 `TypeError`。完全探测不到时加载器**不会**拦截插件，只打逐插件标记 `ncm_version_unverified` 并告警——你的插件应允许这种「未知版本」状态并自我降级。

**10.6 插件在加载期抛错，绝不能拖垮别人（也不该拖垮自己）。**
症状（期望行为）：某插件入口抛异常，它自己被记成 `state:"error"`，其余插件全部照常加载，界面不受影响；症状（错误用法）：把有风险的初始化写在**顶层**（求值期）而非 `plugin.onLoad` 里，或在顶层读不存在的全局、`require()` 不存在的模块。
原因：入口脚本求值被 `runScript()` 的 `try/catch` 包住，`onLoad` 调用也被包住（异常落到 `plugin.loadError`）；但**只有这两处**受保护。
修法：把可能失败的逻辑放进 `plugin.onLoad` / `onAllPluginsLoaded` 并自行 `try/catch`；需要的外部全局（`React` / `ReactDOM` / `legacyNativeCmder`）先探测再用。参考 `plugins/src/Broken-Plugin`（故意抛错验证隔离）与 `plugins/src/BNCM-SelfTest`（每项检查独立记录）。

**10.7 顶层直接 `await` / `import` 不可用。**
症状：`SyntaxError: Unexpected token 'export'` 或 `await is only valid in async function`。原因：入口脚本被 `new Function(...)` 求值，不是 ES module，也没有同步返回值可用。修法：IIFE + 回调；需要异步就 `.then()`，或 `async function main(){}` 后调用 `main()`。

**10.8 `require()` 只认 `'betterncm'`。**
症状：`Error: require("xxx") is not supported`。原因：注入的 `require` 是极简实现，只有 `'betterncm'` 一个 id。修法：用打包器把自己的依赖打进入口文件（真实插件入口都是自包含 bundle），运行时不要指望 `require` 解析第三方模块。

**10.9 依赖顺序不能当硬保证。**
症状：在 `onLoad` 里读 `window.loadedPlugins.OtherPlugin`，偶尔拿到 `undefined`。
原因：`loadAfter` / `requirements` 是排序提示而非硬依赖（这两个字段现已能透传，见第 4 节），且 `onLoad` 阶段 `window.loadedPlugins` 尚未发布——排序只保证「先加载」，不保证「已发布」。
修法：跨插件协作一律放到 `plugin.onAllPluginsLoaded` 并二次探测：

```js
plugin.onAllPluginsLoaded(function () {
  var other = betterncm.plugin.get('SomePlugin');
  if (!other) { console.warn('[my-plugin] SomePlugin 缺失，降级运行'); return; }
  other.mainPlugin.myExportedFn && other.mainPlugin.myExportedFn();
});
```

**10.10 禁用后收不到任何通知。**
症状：实现了 `onDisable`，被禁用时从不执行，资源也没清理。原因：**本实现没有 `onEnable` / `onDisable`**；禁用是宿主层面的（写 `disabled_plugins.json` + 重载），被禁用的插件脚本根本不会被求值。修法：把清理放进自己的卸载路径，或用 `plugin.mainPlugin` 上的自定义事件与别的插件约定；不要依赖禁用钩子。

---

## 11. 上架前检查清单

- [ ] `manifest_version` 是数字 `1`；`name` / `slug` / `version` / `author` 齐全。
- [ ] `slug` 与发布名一致，且**今后不再更改**（跨插件探测依赖它）。
- [ ] `injects.Main[0].file` 指向归档里真实存在的文件（打包后已验证路径）。
- [ ] 入口脚本只用形参 `betterncm` / `require` / `plugin`，不依赖 `window.plugin` 长期存在。
- [ ] 钩子用 `plugin.onLoad(...)` / `onConfig(...)` / `onAllPluginsLoaded(...)` 注册。
- [ ] `plugin.onConfig` 的回调**有返回值**（元素），否则 UI 显示「该插件没有提供设置项」。
- [ ] 顶层脚本不抛异常；有风险的动作放在 `onLoad` 里并自行 `try/catch`。
- [ ] 不读 `window.APP_CONF`；版本一律用 `betterncm.ncm.getNCMVersion()`，并允许「版本未知」。
- [ ] 跨插件取用走 `onAllPluginsLoaded` + `betterncm.plugin.get(slug)`，并对缺失做降级。
- [ ] 不按对象遍历 `window.loadedPlugins`；遍历用数组方法，取插件用 slug 属性。
- [ ] 自己对外暴露的查询接口返回空数组/空对象而不是 `null`。
- [ ] 不依赖 `native_plugin` / `fs.mountFile` / 完整 `betterncm.react` / `app.exec` 启动进程 / `startup_script` / `incompatible` 互斥检查。
- [ ] 若用 `hijacks`：规则非 `pending`、`from` 片段在当前 `web.pack` 中唯一命中，并已在真机确认客户端**不白屏**（查 `window.__BNCM_HIJACK__.pageErrors`）。
- [ ] 本地跑过 `node test\framework-api.test.mjs` 与 `node test\preload-engine.test.mjs`，均 0 failed。
- [ ] 真机确认：本插件 `state:"loaded"`、`window.__BNCM_INCOMPAT_RAN__` 未被误置真、功能可用、控制台无 `UNIMPLEMENTED API:` 告警（有则说明你依赖了未实现的接口）。
