# 11 — Hijack 引擎（页面级模块改写）

> 目标：`3.1.41.205529` · web.pack `477f8a2`（1411 条目 / sha256 `bf2cf3dd80ebfe99`）
> 代码：`tools/bncm_preload.js`、`loader/hijacks.json`
> 测试：`test/preload-engine.test.mjs`（55 项，含对真实 web.pack 的漂移守卫）

## 1. 为什么需要它

`window.onProcessLyrics` 是 `RefinedNowPlaying` **定义**的钩子，但**没有任何插件调用它**——
唯一的调用者是客户端自己的歌词管线。上游 BetterNCM 的做法是重写
`orpheus://orpheus/pub/core` 的**响应体**（在客户端进程内挂 CEF scheme handler），把管线函数
改成会调用该钩子的版本。

这条路线在本工程走不通：`upstream/chromatic/src/3rd/libcef` 是**空子模块**（拿不到 CEF 头文件，
见 `docs/06` §7），而且上游那份 `from` 片段是 **2.10.4 时代**的字节片段——实测它在 3.1.41 的
前端包里**一次都不出现**，目标资源 `orpheus://orpheus/pub/core` 在本版本甚至**不存在**
（入口块是 `runtime~app.bundle` / `app.chunk` / `subApp.chunk`）。

## 2. 取而代之的机制

客户端是 webpack 4 jsonp 打包。实测 `runtime~app.bundle.477f8a2.js` 末尾：

```js
var t = this.webpackJsonp = this.webpackJsonp || [], u = t.push.bind(t);
t.push = c, t = t.slice(); for (var o = 0; o < t.length; o++) c(t[o]); var i = u; d()
```

即运行时会**给 `window.webpackJsonp.push` 赋值**。于是 `tools/bncm_preload.js` 用
`Object.defineProperty` 在数组上装一个**访问器**，在 `t.push = c` 发生的那一刻拿到运行时的回调，
并在**每个 chunk 注册模块工厂时**检查其源码、按规则改写、再用 `new Function` 重新注册。

这比上游的响应体重写**更精确**：规则只会在真正包含该片段的模块上生效，不会误伤同名文本。

### 时序是决定性的

模块工厂一旦注册就无法再改。因此预载必须**在页面脚本之前**执行：

- `loader/` 与 `tools/bncm_agent.mjs` 用 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 注册它
  （同时顺手修掉了旧文档里"注入不跨页面重载"的缺口——注册存在浏览器侧，刷新后仍生效）；
- `tools/cdp_watch.mjs` 也会注册它，所以 `launch.cmd` 的开发会话同样有 hijack 能力。

### `buffer-until-ready`

规则来自 `GET /api/hijacks`（异步）。规则到达之前到达的 chunk 会被**缓冲**，而不是直接放行——
晚到的规则对已注册的模块毫无意义。同时有 **2 s 上限**：后端挂了也必须让页面正常启动，
此时 `window.__BNCM_HIJACK__.rulesLate = true`，并在诊断里显示。

还有一个容易被忽略的坑：**运行时的 `push` 尚未安装** 时也不能放行 payload。早期实现把
`Array.prototype.push` 当作"运行时回调"的兜底，结果 payload 被写进数组，而运行时的
`for(...) c(t[o])` 重放循环会把它交给**原始回调**，静默绕过整个引擎。现在 `runtimeLive` 是唯一
判据，`realPush` 初始为 `null` 且永不用 `Array.prototype.push` 兜底。

## 3. 规则类型

| 类型 | 用法 | 说明 |
|---|---|---|
| `replace` | `from` / `to` | 命中模块工厂源码后做文本替换并 `new Function` 重新注册。上游 `hijacks` 的等价语义。 |
| `wrap-export` | `locate` / `wrapper` | 命中模块后，在**模块执行完的那一刻**把导出的函数换成包装版。 |

### 关于 `wrap-export`：本客户端上不可用（已实测）

看起来 `wrap-export` 更优雅（不依赖压缩后的局部变量名），但 webpack 的 harmony 导出助手是：

```js
r.d = function (e, c, d) { r.o(e, c) || Object.defineProperty(e, c, { enumerable: !0, get: d }) };
```

**`configurable` 默认为 false** → 导出属性是**不可重新定义**的访问器，从外部替换会直接 `TypeError`。
所以 `builtin:lyrics-hook` 用的是 `replace`。

引擎保留了 `wrap-export`（在可配置导出上仍有用），但**遇到不可配置导出会显式报错**并写入
`window.__BNCM_HIJACK__.errors`——"看起来装上了但其实什么都没做"是本工程最不能接受的结果。

## 4. 歌词钩子规则（`builtin:lyrics-hook`）

### 目标：3.1.41 的歌词管线入口

实测 `app.chunk.477f8a2.js`（`subApp.chunk` 里是同一模块的另一份拷贝）：

```js
n.d(t,"a",(function(){return a})), n.d(t,"c",…), n.d(t,"b",…), n.d(t,"d",…);
function a(e){const t={currentUsedLyric:"none",currentUsedLyricVersion:-1,…};
              if(!e.lrc&&!e.yrc)return t; let n=[],i=[];if(e.lrc){…} if(e.yrc){…} }
```

它把**歌词 API 原始响应**（`lrc` / `yrc` / `tlyric` / `romalrc` / `ytlrc` / `yromalrc`）转成展示模型。
`from` 片段就选在"模型已初始化、任何歌词字段被读取之前"：

```
from: if(!e.lrc&&!e.yrc)return t;
```

**唯一性已实测**：在 web.pack `477f8a2` 的全部 `.js` 中，该片段出现 **2 次**
（`app.chunk` 1 次、`subApp.chunk` 1 次），其余为 0。测试 `test/preload-engine.test.mjs` 的漂移守卫
会在每次运行时重新断言这一点，并比对 `pub/COMMITHASH` 是否仍等于规则记录的 `derived_from_pack`。

### 注入的代码

```js
if(window.onProcessLyrics){try{
  var _bncmP=window.onProcessLyrics(e);
  if(_bncmP&&(_bncmP.lrc||_bncmP.yrc||_bncmP.tlyric||typeof _bncmP==='string'))e=_bncmP;
}catch(_bncmE){try{console.warn('[BetterNCM] onProcessLyrics threw',_bncmE);}catch(_bncmE2){}}}
```

三点说明：

1. **返回值不是必须的。** RNP 的钩子是在 `setTimeout` 里异步做处理的：它设置
   `window.currentLyrics`、派发 `lyrics-updated`，然后 `return Ge(e,t)`——把**拿到的 payload 原样返回**。
   所以这里按副作用调用即可，**不能 `await`**。如果某天有插件真的返回了新的 payload，上面的判断也会把它接住。
2. **钩子抛错不能影响客户端。** 整体包在 `try/catch` 里，只 `console.warn`。
3. **RNP 还没加载时是安全的**：`window.onProcessLyrics` 不存在 → 整段跳过，客户端照常解析歌词。

### 期望的可见结果

钩子生效后：`window.currentLyrics` 有值 → `document.dispatchEvent(new CustomEvent('lyrics-updated'))`
→ `LyricBar` 的监听器收到 `detail.lyrics` 并渲染词栏；同时
`betterncm.app.getSucceededHijacks()` 会包含 `RefinedNowPlaying::module:lyrics-pipeline`，
RNP 因此**不再**显示它自己的"Hijack JS 注入失败"提示。

## 6. 实机验证与加固（2026-10-01）

对运行中的 3.1.41 客户端实测，`window.__BNCM_HIJACK__`：

```json
{ "boot": {"readyState":"loading","hadJsonp":false,"existingPushType":null,"existingLength":0},
  "runtimeHooked": true, "jsonpPayloads": 3821, "modulesSeen": 4500522, "modulesRewritten": 1,
  "bufferedPayloads": 0, "applied": ["builtin:redux-dispatch-hook",
  "RefinedNowPlaying::module:redux-dispatch-hook"], "missed": ["builtin:lyrics-hook"], "errors": [] }
```

- `readyState: "loading"` + `hadJsonp: false` → **预载确实抢在 bundle 之前**；
- `runtimeHooked: true` → 运行时的 `t.push` 被捕获；
- **`builtin:redux-dispatch-hook` 真的改写了真实模块**（module 1979，位于
  `vendors~app~subApp.chunk`），`getSucceededHijacks()` 返回两条 RNP 命中。

### 三次失败与加固（都是真机才暴露的）

1. **注册随会话消失**：`Page.addScriptToEvaluateOnNewDocument` 的注册绑定在创建它的 CDP 会话上。
   早期每轮开/关会话 → 注册从未生效。现在会话常驻（见 `docs/07` §8）。
2. **工厂被反复处理 / 错误刷屏**：`applied` 与 `errors` 曾在一秒内涨到数百条，错误全是
   `rewrite failed for module 1979: Maximum call stack size exceeded`。原因有两个：
   - `handlePayload` 原地改写 payload 的工厂槽，同一个工厂对象再被推入时会**再次进入**匹配；
   - 超大模块用 `new Function` 重新解析会撑爆解析器栈（上游是重写响应体，不会重建函数）。

   现在的加固：**每个工厂只处理一次**（在函数对象上打 `__bncmSeen` 标记，成功/失败/跳过都会打）；
   超过 `MAX_REWRITE_BYTES`（512 KB）的模块**记录一次 `skipped`（带原因）并放弃**，不再重复报错；
   `applied` / `skipped` / `missed` / `errors` 数组有上限（计数器仍然精确）。
   `skipped` 与 `missed` 语义不同：**skipped = 命中但蓄意不改写**（附原因），
   **missed = 规则从未命中任何模块**（前端包可能已更新）。
3. **`missed` 在启动时是"狼来了"**：`builtin:lyrics-hook` 在启动阶段始终未命中——因为**歌词模块
   是懒注册的**。实测：`app.chunk` 的文本里确实含该片段（1 次），但启动后
   `__webpack_require__.m` 只有 1182 个模块，里面**没有**该片段，也没有
   `currentUsedLyricVersion`；字符段随"正在播放页"（subApp）加载后才注册。
   所以规则会在用户进入播放页/开始播放时才应用，属于**预期行为**，不是失效。
   诊断页因此同时展示 `applied` / `skipped` / `missed` 三者，而不是只报 missed。

## 8. 当前阻塞：作用域丢失（两条规则默认关闭）

**现状：`loader/hijacks.json` 里两条规则都是 `pending: true`，即默认不生效。**

引擎本身已被证明可用：真机上它成功改写了 module 1979（`modulesRewritten=1`），
`window.rnpDispatchHook` 随之出现，`getSucceededHijacks()` 也返回了真实命中。
但**一旦改写生效，客户端白屏**。判定链（全部实测）：

| 场景 | 结果 |
|---|---|
| 无任何注入（基线） | 正常渲染：`rootKids=2`、`bodyTextLen=2100`、`ContentContainer 202x1032` |
| 框架 + 预载 + 4 个插件，**无 hijack** | 正常渲染：`rootKids=2` |
| 启用 `builtin:redux-dispatch-hook` | **白屏**：`rootKids=0`、容器高度 0 |
| 启用 `builtin:lyrics-hook` | **白屏**：同样 `rootKids=0`，页面错误钩子记录到 3 条 `Script error.` |

**根因是结构性的**：改写后的工厂是用
`new Function('return (' + source + ')')()` **重建**的，它在全局作用域里重新创建函数，
因此**丢掉了原工厂的闭包**。只要模块里有任何一个从外层（webpack/vendor 作用域）解析的自由标识符，
运行时就会抛错；而一个模块抛错就足以中止整个启动。
精心挑选 `from` 片段解决不了这一点——**问题出在机制上**。

### 下一步（作用域保持的改写，两条候选路线）

1. **经工厂自身重新进入**：不重建函数，而是把改写的代码作为"补丁"在工厂执行时注入——
   例如用 `Proxy` 包住 `__webpack_require__`，或在工厂执行前后操作其 `exports`。
   对"插入一次副作用调用"这类改写，这条路更自然。
2. **在模块自己的作用域里求值改写结果**：保留原工厂的 `arguments`/形参绑定，
   用 `factory.apply` 加上一个新的环境对象求值补丁片段，而不是重建整个函数体。

两条都需要真机验证；本预载新加的 **页面错误探针**
（`window.__BNCM_HIJACK__.pageErrors`，捕获 `error` 与 `unhandledrejection`）就是为了让这类尝试
第一次就能看到原因，而不是只剩一个白屏。**在验证通过前，不要把这些规则改回 `pending: false`。**

### 这对插件意味着什么

- `RefinedNowPlaying`(Next) **仍然加载**，并仍会安装 `window.rnpDispatchHook`（只是没有事件流），
  也仍保留 `lyrics-updated` / `window.currentLyrics` 契约；缺的是歌词/歌曲变化的推送源。
- `LyricBar` 的数据源因此也没有内容，但插件本身加载正常。
- `MaterialYouTheme` 与内置能力**不受影响**——主题在真机上已被截图确认生效。

## 8. 结论：改写机制默认关闭，改用两层不侵入的方案

**现状：`loader/hijacks.json` 里两条规则都是 `pending: true`，默认不生效；预载也默认不做 webpack 拦截。**

### 8.1 白屏的真正原因（比"闭包丢失"更根本）

上一轮把白屏归因于 `new Function` 重建工厂丢闭包。继续实测后发现**更根本的原因**：
**只要对 `window.webpackJsonp` 做拦截，客户端就会启动失败**——即使一条规则都没有、
即使引擎处于纯 passthrough、即使把框架推迟到 `load` 之后。

对照实验（全部实测）：

| 场景 | 结果 |
|---|---|
| 无注入，纯客户端 | 渲染正常 `rootKids=2` |
| **无注入，普通 page reload** | **渲染正常 `rootKids=2`**（证明"reload 本身有害"是错的） |
| 注入但**不拦截** webpack（`intercept:false`） | **渲染正常 `rootKids=2, containers=8, pageErrors=0`** |
| 注入并拦截 webpack（passthrough、0 规则） | **白屏** `rootKids=0`、`pageErrors=5` |

所以修复是：**拦截改为按需开启**。agent / `cdp_watch` 在注册预载时读取 `loader/hijacks.json`，
只有存在启用规则时才传 `intercept: true`；否则预载只是一个"把框架拉起来"的引导脚本，
完全不碰 webpack。拦截逻辑本身保留（真机上确实成功改写过 module 1979），待作用域问题解决后可用。

### 8.2 歌词需求已用不侵入的方式满足

继续实测发现：**`RefinedNowPlayingNext 3.0.2 自己的 3.x 路径就能拿到歌词**，根本不需要 hijack：

```
lyrics-updated 事件触发，detail 含 43 行歌词
window.currentLyrics = { lyrics: [...43], contributors: ["original","translation","roles"] }
```

也就是说，"必须改写客户端代码才能让 RNP 拿到歌词"这个前提**只对 2.x 版本成立**。
3.x 续作自带 API 通路。

### 8.3 剩下唯一的插件缺口：LyricBar 的挂载点 → 已用 DOM 别名解决

`LyricBar` 通过轮询 `#main-player` 来挂载（`k("#main-player", cb)`），而 3.1.41 已无此 id，
于是它加载后什么都不做。框架新增 **DOM 别名层**（`betterncm.injector.domAliases`）：

- 先按类名找（`DefaultPlayerContainer` / `MiniBar`），找不到就**按几何形状找**：
  在视口下半部定位播放控件，向上找"横跨大半宽度、高度像条"的祖先，取**位置最低**的那个；
- 给它加 `id="main-player"` 与类 `m-player`，并给其中的播放按钮加 `btnp`；
- 每秒复查（React 重渲染可能抹掉），因为客户端会在启动过程中**替换 `window.channel`**。

实测结果：别名指向真正的播放条（`DefaultBarWrapper_d196mr`，1920×80，可见），
**`LyricBar` 随即挂载并显示歌词文本**：

```
lyricBar: true
lyricBarText: "就这样 等到了惊蛰后盼霜降 成了没日没夜的工作狂 负了我心里的少年郎 健忘的症状这种"
```

### 8.4 尚未完成 / 仍可选做的部分

1. **`builtin:lyrics-hook` / `builtin:redux-dispatch-hook` 仍未启用**：需要作用域保持的改写。
   在 RNP-Next 自带通路可用的情况下，它们的收益已经很小（只对老式 `onProcessLyrics` 消费者有用）。
2. **`lyricsFeed`（`channel.call` 上拦截 `/api/song/lyric`）实测未能生效**：
   客户端会在启动过程中替换 `window.channel`，包装会落在被丢弃的对象上。
   实现已改为**据实上报**（`installed` 由 `String(ch.call)` 是否含包装标记推导，
   包装后每秒复查重装），不会出现"声称生效其实没有"的情况。RNP-Next 不需要它。
3. **`LyricBar` 的暂停态/纯音乐判定**仍依赖 `.btnp` / `data-log`，目前只做了类名别名，
   真机上如需精确暂停态还需要把客户端播放状态镜像到别名元素上。

## 9. 失败与漂移

| 现象 | 含义 | 处理 |
|---|---|---|
| `window.__BNCM_HIJACK__.hooksInstalled === false` | 预载没能在运行时安装 `push` 之前执行 | 检查 `Page.addScriptToEvaluateOnNewDocument` 是否可用（诊断页会显示） |
| `rulesLate === true` 且有 `bufferedPayloads` | 规则迟到，首块可能漏改 | 后端是否可达；重载页面即可恢复 |
| `applied` 为空、`missed` 含 `builtin:lyrics-hook` | **前端包可能已更新**，片段失效 | 先**离线**复核（漂移守卫读磁盘上的 `web.pack`）；片段仍在就更新 `derived_from_pack`，真的失效再走下面的探针实验 |
| `errors` 含 `non-configurable` | 用了 `wrap-export` 而导出不可配置 | 改用 `replace` |

诊断入口：插件管理 UI 的**诊断**页（`loader/manager.js`），或
`node tools/cdp_inject.mjs --expr "JSON.stringify(window.__BNCM_HIJACK__)"`。

### 规则随前端包更新：默认走离线复核

`test/preload-engine.test.mjs` 的漂移守卫直接读磁盘上的
`%LOCALAPPDATA%\Netease\CloudMusic\web.pack`，逐 chunk 统计每条规则 `from` 片段的出现次数，
并比对 `pub/COMMITHASH` 与规则记录的 `derived_from_pack`：

```powershell
node test\preload-engine.test.mjs
# 片段失效            -> "still matches web.pack (0: )" 失败
# 包变了但片段还在    -> 只有 "derives from this pack (旧 vs 新)" 失败
```

* **只是出处过期**（片段仍唯一命中）：`tools/ntpk.py info <web.pack>` 取新的 `COMMITHASH` 与
  `entries`，加上 pack 文件 sha256 的前 16 位，更新 `derived_from_pack`，重跑守卫即可。
  2026-10-15 就是这样处理 `477f8a2 → 83304b1` 的：两条片段分别仍然命中 2 次（app + subApp）
  与 1 次（vendors~app~subApp）。
* **片段真的失效**（命中 0 次）：才需要重新推导，见下。

### 用探针重新推导（实验性，会白屏）

`tools/hijack_probe.mjs` 依赖 `window.__BNCM_WP__`，而它**只在预载的 webpack 拦截打开时才存在**。
拦截开关不是自己判断的：`cdp_watch.mjs` 从 `loader/hijacks.json` 推出
`rules.some(r => !r.pending && (r.from || r.locate))`——两条规则都 `pending: true` 时，预载就是一个
"纯 bootstrap"，探针会直接报 `window.__BNCM_WP__ is missing`（**哪怕客户端正在运行、经 loader 启动**）。

而拦截**本身**（装上 `push` 访问器 + 合成捕获模块，即使零规则纯 passthrough）就会让客户端不挂载：
`#root` 空、若干 `Script error.`。这正是两条规则默认关闭的原因（见第 7、8 节）。

所以探针只能在**一次性实验会话**里用：

```powershell
# 1. 临时把某条规则的 pending 改成 false（该规则因此也会被真正应用）
# 2. loader\launch.cmd -Duration 240          # 客户端必须经 loader 启动
# 3. node tools\hijack_probe.mjs --top 25 --size 6000
#    -> out/hijack-candidates.json：按 lyrics/originalLyric/await 等信号打分排序的模块与其源码
# 4. 在候选里找"接收歌词 API 响应并构造歌词行"的函数，取一段唯一且靠前的片段填进 from/to，
#    更新 derived_from_pack，并把 pending 改回 true
# 5. node test\preload-engine.test.mjs        # 漂移守卫把关
# 6. 关掉客户端 —— 白屏是这一模式的预期现象，不是新 bug
```

## 6. 兼容性约定

`loader/hijacks.json` 里允许保留 `pending: true` 的规则：它表示**能力已声明但片段尚未确定**。
这种规则不会被执行（预载会过滤掉），也不会计入 `missed` 噪音，但管理 UI 的「诊断」页会**明确列出**
"⏳ 待推导"，避免它悄悄消失。
