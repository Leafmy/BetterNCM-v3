# 01 — 架构解构

> 目标：`3.1.41.205529`。标注 **[实测]**（本机运行/静态取证得到）/ **[外部]**（上游或第三方公开资料）/ **[推断]**。

## 1. 进程与线程模型 **[实测]**

网易云 3.x 是 **CEF 91 多进程应用**：

```
cloudmusic.exe                      <- 启动器（2.6 MB，仅静态导入 KERNEL32/USER32/SHELL32/SHLWAPI/WINHTTP/WINMM/ADVAPI32/PSAPI/OLE32）
  └─ 通过 LoadLibraryExW 动态载入 cloudmusic.dll（37.7 MB）= 真正的应用
       └─ libcef.dll                <- CEF 91.2.3 / Chromium 91.0.4472.169
```

运行期实测进程树：

| 进程 | 命令行特征 | 职责 |
|---|---|---|
| Main | 无 `--type=` | CEF 宿主、所有原生插件、窗口管理 |
| GpuProcess | `--type=gpu-process` | 合成/光栅化 |
| Renderer | `--type=renderer --renderer-client-id=N` | 执行 `orpheus://` 页面 JS |
| `cloudmusic_reporter.exe` | — | 遥测上报 |

关键点：

- **Renderer 独立进程存在** → 符合 BetterNCM 的 `--type=renderer` 分支假设。
- 客户端以 `--no-sandbox` 运行。
- UA 固定为 `Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.41.205529`（注意 UA 里的 patch 是 `.164`，
  而 `libcef.dll` 是 `.169`：网易在 UA 里写死了旧 patch 号，**不能**用 UA 判定 CEF 版本）。

窗口类名（**[实测]** 枚举顶层窗口）：

| 类名 | 典型尺寸 | 含义 |
|---|---|---|
| `Chrome_WidgetWin_0` | 960×663 | **主 UI**（CEF browser） |
| `OrpheusBrowserHost` | 160×28 | 小型播放条/悬浮层 |
| `DesktopLyrics` | 616×122 | 桌面歌词（独立窗口） |
| `MiniPlayer` | 303×48 | 迷你播放器（独立窗口） |
| `SystemHintWindow` | 256×366 | 系统提示 |

→ BetterNCM v2 用 `FindWindow(L"OrpheusBrowserHost")` / `FindWindowEx(..., L"OrpheusShadow")` 定位窗口；
类名在 3.1.41 仍然存在 **[实测]**。

## 2. Web 前端 **[实测]**

- 自定义协议 **`orpheus://`**，主页面 **`orpheus://orpheus/pub/app.html`**。
  CDP `/json/list` 实测返回唯一 page target，其 `url` 正是该地址、`title` 为 `网易云音乐`。
- 页面栈是 webpack 打包的 React 应用；`pub/hybrid/*.chunk.<hash>.js`，构建号见 `pub/COMMITHASH`。
- `app.html` 的 CSP 允许内联脚本与 `orpheus:` 源：

  ```
  script-src 'self' 'unsafe-inline' 'unsafe-eval' … orpheus:;
  connect-src orpheus://orpheus/style/res/ orpheus://localmusic/lyric | pic
              orpheus://orpheus/storage/customrequest | cacheresource | customskin
              orpheus://orpheus/wasm/resource | SDK | aioresource | cache …
  ```
  → 页面内注入脚本在 CSP 层面是允许的。
- 运行期实测的页面全局：`APP_CONF`（含 `appver === "3.1.41.205529"`）、`channel`、`dbg.Command`。

## 3. JS ↔ 原生桥 **[实测 + 静态]**

桥由 CEF 的 **V8 extension** 提供（脚本以 `native function call()` 形式嵌在 `cloudmusic.dll` 中）：

```js
var channel; if (!channel) channel = {};
(function () {
  channel.call            = function (name, ret, arguments) { native function call();            return call(name, ret, arguments); };
  channel.registerCall    = function (name, callback)      { native function registerCall();    return registerCall(name, callback); };
  channel.viewCall        = function ()                    { native function viewCall();        return viewCall(); };
  channel.encodeAnonymousId / encodeAnonymousId2 / encryptId
  channel.serialData / serialData2 / deSerialData / serialKey
  channel.enData / deData
  channel.oldLocalStorageData
})();
```

**CDP 实测 `Object.keys(window.channel)` 返回的 13 个函数与上面静态提取的清单逐项一致**
——这是静态分析与运行期观察的交叉验证。

上层封装 `window.dbg.Command`（webpack module 118）提供
`exec / call / do / nameDo / registerCall / addCall / removeCall / clearCall /
useNativeRegisterCall / createObservableFromNativeRegisterCall / rxFromNativeEvent /
createPromiseFromNativeRegisterCall`。

命令与事件清单一律以 `docs/native-commands.json` 为准（由 `tools/analyze_bundle.py` 生成）：
**250 条命令 / 5 个 host→page 事件 / 15 个命名空间**。

## 4. 前端版本会独立更新 **[实测 + 推断]**

| | 安装目录 `package/orpheus.ntpk` | 用户数据目录 `web.pack` |
|---|---|---|
| COMMITHASH | `c6406e5` | `477f8a2` |
| 时间 | 2026-09-18 | 2026-09-25 |
| 条目 | 1408 | 1411 |

两者签名均有效但 chunk 文件名与 CSS 哈希完全不同，是两个构建。`web.pack` 在用户目录、更晚、更全
→ **[推断]** 运行期通过 `ResourceDownloadCEF::DoCheckMd5AndUnzip` 下载替换的较新前端。

**对方案的含义**：任何依赖"包内容固定"的改包方案都会随前端自动更新而失效；
运行期注入（本方案）不受影响。

## 5. 启动序列（可作为 hook 时机表）**[静态]**

`cloudmusic.dll` 中的埋点字符串给出了完整启动阶段：

```
init/checkMutex
init/checkRuntime
init/appConfigInit
Install.Update            [boot] No Check Install
init/checkUpdateInstall   [boot] Detect Update, Try To Restart And Update.
versign_check
init/clearUserData
orpheusInit               [boot] ClientApp Initialize.  → [boot] Init app failed.
appInit/clientAppInitialize
appInit/verifyFile        [boot] To Check Resource Valid. → [boot] Verify ntpk failed.  ← 包签名校验
orpheusAppInit
initConfig/appConfigInit  / checkOSVersionCacheClear / checkWebCacheUpgrade
initConfig/checkHighDPI   / initFromAppConfig / initNeNetworks
orpheusInitConfig
initBrowser/cefInitialize [boot] Init CEF3 Failed.
initBrowser/registerCustomConfig
initBrowser/threadManagerInit
initBrowser/createStartBrowse
initBrowser/initRes
orpheusInitBrowser
initEnd/audioPlayerInit
initEnd/fileUploaderInit
orpheusInitEnd
Finailze
```

另有 `[boot] CefProcess start, process_type: …` 与
**`[boot] protocol command line injection detected, blocked. offending: …`**
（命令行拦截，见 `04-antitamper.md` §5）。

## 6. 注入面总结

| 通道 | 是否仍可用 | 证据 | 用途 |
|---|---|---|---|
| `msimg32.dll` 代理 | **文件级可用，但被检测** | `cloudmusic.dll` 静态导入 `MSIMG32.dll`；`CheckThirdPluginHook` 检测该文件名 | **弃用** |
| `version.dll` 代理 | **可用** | `cloudmusic.dll` 静态导入 `VERSION.dll`；不在 KnownDLLs；**实测已成功载入 Main/Renderer/Gpu** | 进程内原生能力（fs / native plugin / 持久化） |
| `winmm.dll` 代理 | 可用（未实测） | `cloudmusic.exe` 与 `cloudmusic.dll` 均静态导入 | 备选 |
| CDP `--remote-debugging-port` | **可用** | 实测 3.1.41.205529 返回 CDP 目标 `orpheus://orpheus/pub/app.html` | JS 注入（快速、无需头文件） |
| 改 `package/*.ntpk` | **不可用** | RSA-512/SHA1 签名校验，无私钥 | 弃用 |

两条可用通道是互补的：**CDP 负责 JS，`version.dll` 代理负责进程内原生能力。**
