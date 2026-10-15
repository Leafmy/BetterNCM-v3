# 14 — 插件开发指南（dev mode）

> 面向**要基于本项目写新插件的作者**。内部逆向结论见 `docs/00`–`docs/13`；
> 上游 2.x 语义的参考资料在 `upstream/wiki/`。本文只讲"今天在这台客户端上怎么把插件写出来"。

适用的客户端：**网易云音乐 3.1.41.205529**（Orpheus / CEF 91）。
插件跑在页面里、由 `loader/framework.js` 加载、通过回环 HTTP 访问 `tools/ncm_host.mjs` 后端。

---

## 1. 五分钟跑通（不用打包）

```powershell
# 1) 把源码目录挂成"开发插件源"，并打开变更监听
loader\launch.cmd -DevDir C:\src\MyPlugin -DevWatch

# 或直接从 GitHub 拉（不用 clone）
loader\launch.cmd -DevSource acme/MyPlugin#dev:dist -DevWatch

# 或挂一个已经打包好的归档
loader\launch.cmd -DevSource C:\src\MyPlugin.plugin
```

`loader\launch.cmd` 会拉起后端 + 客户端 + 注入。页面里然后可以直接驱动：

```js
betterncm.dev.enabled            // -> true
betterncm.dev.sources            // 当前开发源（含解析出的 slug）
betterncm.dev.plugins('MyPlugin')// 我的插件到底加载了没有、报什么错
betterncm.dev.reload()           // 就地重跑插件加载器
betterncm.dev.watch(true)        // 打开变更监听（默认 3s 轮询 generation）
```

目录里最小需要的两个文件：

```
MyPlugin/
  manifest.json
  main.js
```

```json
{
  "manifest_version": 1,
  "name": "My Plugin",
  "slug": "MyPlugin",
  "version": "0.1.0",
  "author": "you",
  "type": "extension",
  "ncm-version-req": "> 2.10.2",
  "ncm3-compatible": true,
  "injects": { "Main": [{ "file": "main.js" }] }
}
```

```js
plugin.onLoad(function () {
  betterncm.dev.log('MyPlugin loaded', plugin.manifest.version);
  document.title = 'MyPlugin is alive';
});
```

---

## 2. 插件契约（必须踩对的几条）

上游 `NCMInjectPlugin extends EventTarget` 的语义，本项目逐条对齐（依据见 `docs/06` §4）：

| 成员 | 说明 |
|---|---|
| `plugin.onLoad(fn)` / `onConfig(fn)` / `onAllPluginsLoaded(fn)` | **注册函数**，不是可赋值属性；加载器随后派发 `load` / `config` / `allpluginsloaded` |
| `plugin.addEventListener / dispatchEvent / removeEventListener` | 插件对象本身就是 `EventTarget` |
| `plugin.mainPlugin` | 另一个 `EventTarget`（`NCMPlugin`），用来挂跨 inject 的方法/监听 |
| `plugin.getConfig/ setConfig(key, value)` | 键值对，存在 `localStorage["config.betterncm.<slug>"]` |
| `plugin.pluginPath` / `plugin.manifest` | 路径 / 清单 |
| `plugin.onConfig(fn)` 的返回值 | 必须是设置项元素（`makeBtn` / `makeCheckbox` / `makeInput`） |
| `plugin.devMode` | **本项目新增语义**：该插件来自开发源时为 `true`（未打包、目录位置在 `dev.plugins(slug)` 里） |

`plugin` 是作为**函数形参**传进你的脚本闭包的，所以回调里可以直接用，不需要 `window.plugin`。

`window.betterncm` 的 API 表面（fs / app / ncm / utils / dom / path / betterncm_native）见
`docs/06` §6；未实现的会打印 `UNIMPLEMENTED API: …` 并返回**类型正确的空值**（列表 `[]`、对象 `{}`）。

---

## 3. `betterncm.dev` — 开发钩子对象

| 成员 | 作用 |
|---|---|
| `dev.enabled` / `dev.known` | 后端是否处于 dev 模式 / 是否已探到状态 |
| `dev.sources` | 开发源列表（含 `plugin.slug`、`error`） |
| `dev.generation` | 后端变更代数；**它就是热重载信号** |
| `dev.watching` / `dev.intervalMs` | 监听状态与轮询间隔 |
| `dev.refresh()` | 主动拉一次状态；代数变大则自动重载插件列表 |
| `dev.reload({hard})` | 就地重跑加载器；`{hard:true}` 改为整页 `location.reload()` |
| `dev.watch(bool, ms)` | 打开/关闭后端变更监听 |
| `dev.addSource(spec)` / `dev.removeSource(id)` | 增删开发源（立即生效） |
| `dev.plugins(slug?)` | 已加载插件记录：`state` / `error` / `hooks` / `devMode` / `manifest` |
| `dev.hook.add(rule)` / `.clear()` / `.list()` / `.applied()` | 页面级改写（见 §5） |
| `dev.on('reload'\|'assert', fn)` | 订阅事件，返回退订函数 |
| `dev.log(...)` / `dev.assert(name, cond)` | 打到页面控制台 + 后端 `host.log` |
| `dev.inspect(selector)` | `{count, sample}`，快速看选择器是否命中 |

**热重载的诚实边界**：`dev.reload()` 会重新执行插件脚本，但**不会**撤销旧副本已经做过的
DOM/样式/定时器改动——页面上会出现第二份。要干净的状态请用 `dev.reload({hard:true})`。
`devMode` 为 `true` 时建议插件自己用 `dev.on('reload', fn)` 清理（移除自己的节点、清掉定时器）。

---

## 4. 开发源（source）的三种形态

| 写法 | 例子 | 行为 |
|---|---|---|
| 目录 | `C:\src\MyPlugin`、`..\MyPlugin` | 直接读盘；按 mtime 判断变更（最快） |
| 归档 | `C:\a\MyPlugin.plugin`、`https://…/x.plugin` | 按 ZIP 读；本地文件按 mtime，远程按内容哈希 |
| GitHub | `owner/repo`、`owner/repo#v1.2.3`、`owner/repo#dev:dist`、`https://github.com/owner/repo/tree/dev/plugins/x` | 走 `codeload.github.com` 的 tarball（**不需要 token、不吃 API 限流**），`dist/middle` 这类子目录用 `:subdir` 指定 |

规则与限制：

- 归档中 `manifest.json` 不在根目录时，宿主会在文件映射里找**最浅**的那个（作者常把产物放 `dist/`）；找不到就是一条明确的报错。
- **开发源不会遮蔽已安装插件**：slug 冲突时以 `plugins/` 里的正式安装为准（`host.log` 会写明），
  避免"调了半天调的是旧包"。
- 开发源里的插件与正式插件走**完全相同**的加载路径（含 `ncm3-compatible` 三态与 `ncm-version-req` 门禁），
  否则 dev 模式就是在骗你。
- 本地路径不存在会**立刻报错**（不会静默变成空源）；远程拉取失败会保留在源列表里并带 `error`。

---

## 5. 页面级改写（hijack）的试错路径

页面级模块改写是本项目最有效、也最容易踩坑的能力。内置规则在 `loader/hijacks.json`，
插件也可以在 `manifest.json` 里声明：

```json
"hijacks": {
  ">= 3.1.11": {
    "module:redux-dispatch-hook": {
      "type": "replace",
      "rule": "builtin:redux-dispatch-hook"
    }
  }
}
```

（左键是版本范围、右键是任意的"目标标识"；也可以直接写 `from`/`to` 片段而不用 `rule`，
真实例子见 `plugins/src/RefinedNowPlaying/manifest.json` 与 `docs/11`。）

开发期不必改仓库文件，用 dev 钩子先试：

```js
await betterncm.dev.hook.add({ id: 'try-1', type: 'replace', from: '原片段', to: '替换片段' });
location.reload();                    // 预载在 document-start 取规则，所以必须整页重载
betterncm.dev.hook.applied();         // -> {applied, missed, rulesReady, hooksInstalled}
```

- 片段要从**真实 `web.pack`** 推导：`node tools\hijack_probe.mjs --top 25`。
- `missed` 里的规则表示"装载了但没匹配到任何模块"，通常是前端包已更新。
- dev 规则会随 `<data>\dev_hijacks.json` 持久化，`dev.hook.clear()` 清空。
- 参考实现与坑：`docs/11-hijack-engine.md`。

---

## 6. 常见问题速查

| 现象 | 先看什么 |
|---|---|
| 插件根本没加载 | `dev.plugins()`；再确认 `manifest_version: 1`、`slug` 是否与别处冲突 |
| 被静默跳过 | `state: "skipped"` + `error`：`ncm3-compatible: false` 或 `ncm-version-req` 不满足（版本探测不到时**故意 fail-open**） |
| React 渲染报错 | 客户端自带 React 18；按 2.x 时代 API 写的插件会炸（真实案例 `StyleSnippet`），错误被隔离不影响其他插件 |
| 找不到界面元素 | 别写死 CSS-module 哈希；用 `betterncm.dom.selector(key)` + `dev.inspect()`，缺失会上报 `<data>\selector-discovery.json` |
| 改了代码没生效 | `dev.reload()` 只重跑脚本；DOM 残留用 `{hard:true}`；确认后端真的在监听（`dev.watching`） |
| 设置项不显示 | `plugin.onConfig(fn)` 要**返回**元素；`dev.plugins(slug).hooks.onConfig` 会告诉你回调跑没跑 |

自带测试（**不需要客户端**，改完框架/预载必跑）：

```powershell
node test\framework-api.test.mjs     # 框架 API 契约（含 dev 对象）
node test\preload-engine.test.mjs    # hijack 引擎 + 真实 web.pack 漂移守卫
node test\dev-source.test.mjs        # 开发源 / 变更检测 / dev 钩子
```

---

## 7. 打包与发布

```powershell
# 打成 .plugin（ZIP + 根目录 manifest.json），会校验清单
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" `
    tools\pack_plugin.py plugins\src\<MyPlugin> -o plugins
```

- 宿主同时接受**解包目录**与 `.plugin` 归档；`plugins/src/` 是源码区，**不参与扫描**。
- 上架到上游插件商店的要求见 `upstream/wiki/插件商店上架插件方式及准则.md`。

---

## 8. 明确不做的事（别在这上面浪费时间）

| 能力 | 现状 |
|---|---|
| `native_plugin`（原生插件 DLL） | 字段已解析，**不装载** |
| `fs.mountFile` | 需要 CEF scheme handler |
| `app.exec` 启动进程 | 有意只开 URL / `mailto:` / 文件路径 |
| `betterncm.react` 完整工具集 | 只有 `h` / `f`（客户端自身暴露 `window.React` / `ReactDOM`） |
| 任意 document-start 代码注入通道 | **有意不提供**：dev 钩子只能声明"改写规则"，不能在后端存一段 JS 让预载执行 |

dev 模式的开关与实现分别在 `tools/ncm_host.mjs`（`/api/dev/*`、`loadDevState`）与
`loader/framework.js`（`betterncm.dev`）。
