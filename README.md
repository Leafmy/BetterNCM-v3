# BetterNCM 3.0

## 项目概览

本项目为 BetterNCM / `std-microblock` 方向的网易云 **3.x** 兼容化工程，面向
**网易云音乐 3.1.41.205529**（Orpheus / CEF 91）——上游只声明兼容 `2.10.* ~ 3.0.*`，
本项目补上这一段，让新版客户端重新可用起插件生态。

|              |                                                                                      |
| ------------ | ------------------------------------------------------------------------------------ |
| **许可证**      | GPL-3.0 —— 派生自上游 `chromatic` 的 `v2` 分支（`1b7eb7f`）。见 [`LICENSE`](LICENSE)            |
| **我要写插件**    | 见 [`PLUGIN-COMPAT.md`](PLUGIN-COMPAT.md)——manifest 字段、生命周期、API 已/未实现、常见坑        |
| **面向的客户端**   | 网易云音乐 `3.1.41.205529`（`orpheus://orpheus/pub/app.html`）                             |
| **我要安装**     | Releases 页的一键安装包 / 免安装包；两个包的内容与验收见 [`docs/19-release.md`](docs/19-release.md)   |
| **我要装插件**    | 启动后打开管理面板 →「插件市场」：内置源自带四个插件、离线可用；自建/上架一个源见 [`market/README.md`](market/README.md) |
| **第三方组件与出处** | 见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)                                  |

---

## 四个插件 + 插件市场

**插件市场**（`docs/21-plugin-market.md`）是 3.0 新增的主要功能：管理面板里的第三个标签
（外部入口 → 插件市场），带分类 / 搜索 / 五种排序 / 预览图 / 一键安装更新卸载 / 依赖处理 /
源管理。它复刻上游 `Plugin-Market`（`PluginMarket` 0.8.4）的功能与**索引契约**，但实现为宿主功能，
因此多出三件事：内置源离线可用、安装前逐项校验（zip / manifest / slug / sha256）、失败会被说出来
而不是永久转圈。默认只启用**内置源**（随包分发、离线），其它镜像与自建源在「源设置」里一键启用。

四个插件**随本仓库与两个发行包一起分发**，同时也在市场的内置源里（源码在
[`plugins/src/`](plugins/src)，归档是 [`plugins/*.plugin`](plugins)，市场拷贝在 [`market/`](market)）：

| 插件                        | 上游作者                        | 许可证     | 本目录相对上游改了什么                                                                                         |
| ------------------------- | --------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `LyricBar` 0.3.6          | solstice23                  | MIT     | 仅 `manifest.json`（补 `ncm3-compatible` 与来源声明）                                                        |
| `MaterialYouTheme` v1.0.4 | long45343                   | GPL-3.0 | 仅 `manifest.json`（slug 由 `material-u-theme-ncmv3` 改为 `MaterialYouTheme`）                            |
| `RefinedNowPlaying` 3.0.2 | SUlTlUS 续作（MiHN / solstice23 谱系） | MIT     | 仅 `manifest.json`（slug 由 `RefinedNowPlayingNext` 改为 `RefinedNowPlaying`，hijack 改为加载器 `builtin:` 规则） |
| `NCM-Font-Manager` 0.1.3  | **本项目自研**（BetterNCM-v3）     | GPL-3.0-or-later | 自研，非再分发：字体族/字号/字重、英数专用字体、桌面歌词原生字体、实时预览 |

> 前三个的 `main.js` 与上游发布包**逐字节一致**（已核对 SHA-256），改的只有清单；
> `NCM-Font-Manager` 是本项目自己的插件，`index.js` 是未压缩源码。
> 每个插件目录内都有 `NOTICE.md` 说明来源、许可证与具体改动，再分发的三个另带逐字节取自上游的
> `LICENSE`；**请连同它们一起阅读**。

四个插件都是普通**用户插件**：没有内置锁定，管理器里可启用 / 禁用 / 卸载，全部经过同一个
3.x 门禁与同一套加载顺序。依赖链 `MaterialYouTheme ← RefinedNowPlaying ← LyricBar`
在 `manifest` 的 `loadAfter` / `requirements` 里声明，并由加载器真正执行（`docs/20`），
市场安装 `LyricBar` 时会先装 `RefinedNowPlaying`，并把 `MaterialYouTheme` 列为建议。

`MaterialYouTheme` 的 slug 保持为 `MaterialYouTheme` 是有意为之：`LyricBar` 与 `RefinedNowPlaying`
都通过 `loadedPlugins.MaterialYouTheme` 做跨插件特性探测，改 slug 会静默破坏这两个插件。

---

## 快速开始

你是**用户**：Releases 页有两个包。

| 产物 | 适合 | 特点 |
|---|---|---|
| `BetterNCM-v3-Setup-x64.exe` | 想一键装好 | 运行树 + `version.dll` 代理 + 三个插件 + 登录守护 + 快捷方式 + 「应用和功能」卸载项 |
| `BetterNCM-v3-Portable-x64.zip` | 不想动系统 | 自带 Node，数据写在包内 `data\`，不写注册表、不装自启；只用 CDP 通道（**不含**代理） |

两个包都靠 `--remote-debugging-port`（仅监听 `127.0.0.1`）注入；**必须经 `Start.cmd` 或安装器
生成的快捷方式启动客户端**，直接双击客户端不会加载插件。

你是**插件开发者**：读 [`PLUGIN-COMPAT.md`](PLUGIN-COMPAT.md)（manifest 契约、生命周期、
API 已/未实现清单、常见坑），开发时用 dev mode 免打包直载 + 热重载：

```powershell
loader\launch.cmd -DevDir C:\src\MyPlugin -DevWatch
loader\launch.cmd -DevSource acme/MyPlugin#dev:dist -DevWatch
# 页面里： betterncm.dev.plugins() / dev.reload() / dev.hook.add({...})
```

---

## 当前状态（P0–P21）

| 阶段 | 状态 |
|---|---|
| P0 基线快照 | ✅ `test/baseline/hashes.json`（171 文件 / 439.7 MB） |
| P1 包格式工具 + 签名验证 | ✅ `tools/ntpk.py`（两族容器全部实测通过） |
| P2 原生桥解构 | ✅ `docs/native-commands.json`（250 命令 / 5 事件 / 15 命名空间） |
| P3 反篡改分析 | ✅ `docs/04-antitamper.md`（定位到 `msimg32.dll` 文件名检测） |
| P4 注入通道验证 | ✅ **两条通道均已实测可用**：`version.dll` 代理 + CDP |
| P5 插件兼容层 | ✅ 自检 **14/14**；**22 个真实第三方插件中 21 个成功加载**（`docs/real-plugin-compat.json`） |
| P6 安装/卸载/还原 | ✅ `loader/install.cmd`、`loader/uninstall.cmd`、`test/restore-verify.ps1` |
| P7 随客户端自动启动 | ✅ `tools/bncm_agent.mjs` + `loader/startup.cmd` + 启动器（`docs/07`） |
| P8 Hijack 引擎（页面级模块改写） | ✅ `tools/bncm_preload.js` + `loader/hijacks.json`；歌词钩子已从真实 `web.pack` 推导，带漂移守卫（`docs/11`） |
| P9 插件管理机制与 UI | ✅ core/user 两分、服务端 403 锁定、自愈式入口（`docs/08`）；P15 起 core 层为空 |
| P10 内置核心插件（当时的三个） | ✅ 实机验证：客户端正常渲染、**三个插件功能全部可用**（RNP 歌词 43 行 + 事件、主题、LyricBar 显示词栏） |
| P11 页面级代码改写（hijacks） | ⏸️ **默认关闭**：改写本身可用（真机改写成功），但**拦截 `window.webpackJsonp` 就会让客户端启动失败**（对照实验见 `docs/11` §8）。改为按需开启 `intercept` |
| P12 RNP「Hijack 错误」弹窗 | ✅ **已解决**：该弹窗只因 `getSucceededHijacks()` 里没有它的 slug。实测客户端**不调用** `onProcessLyrics` 却仍有 43 行歌词 → RNP-Next 走自己的 3.x 通路。改为上报**带证据**的能力条目，不谎称改写成功 |
| P13 状态显示位置 | ✅ 浮动徽标 `#__bncm_badge__` **已移除**，状态改为显示在面板头部（`betterncm.status()`） |
| P14 `ncm.call` 多值回调契约 | ✅ 根因是 `ncm.call` 只取了回调第 0 个参数，而宿主回的是 `('success', [...])` → 调用方永远拿到字符串 `"success"`。按上游约定改为 `r.length > 1 ? r : r[0]` |
| P15 插件解耦 | ✅ 三个插件不再是内置 core：移入 `plugins/src/` + 打成 `.plugin` 放进用户插件目录，移除 core 锁定与宿主 403，管理器 **0 个锁定徽章**，都可禁用/卸载。顺带修好：`loadAfter` 排序原本只作用于 core，现对用户插件同样生效 |
| P16 Material 3 深度重制 | 🟡 阶段 1（逆向分析）与阶段 2（Design Token）完成，阶段 3 首片已落地；阶段 4–9 待做。见 `docs/12`、`docs/13` |
| P17 插件开发支撑（dev mode） | ✅ 免打包直载（目录 / 归档 / **GitHub repo**）、变更检测 + 热重载、`betterncm.dev` 钩子对象、dev 期 hijack 规则试错（`docs/14`） |
| P18 插件规模无关的加载器 | ✅ 实测 61 插件启动 **1941ms → 386ms**；一个永不返回的脚本以前让整批**永久挂起**，现在被隔离为 `error`；宿主 240 次请求 **1592ms → 381ms**（`docs/18`） |
| P19 发行包 | ✅ `tools/release/build_release.ps1` 打出**一键安装包 `Setup.exe`**与**免安装包 `Portable.zip`**（路径解析共用 `loader\paths.ps1`）；`verify_release.ps1` 端到端验收（`docs/19`） |
| P20 唯一兼容性核查 | ✅ 三个第三方插件走**同一条**发现/门禁/管理路径（实测 `core=false / locked=false / error=null`）；修掉两处不一致：**依赖顺序元数据被 `normaliseManifest()` 丢弃**（LyricBar 曾排在它依赖的 RNP 之前）与**发行时只有一个插件会被自动安装**（`docs/20`） |
| P21 插件市场 | ✅ 复刻上游 `PluginMarket` 的功能与索引契约（`docs/21`）；市场是宿主功能而非插件，故**内置源离线可用**、**安装前四道校验**（zip/manifest/slug/sha256）、失败可见而不转圈；后端 **85/85**、UI **29/29**、发行包验收 **51/51**；自带四个插件（三个第三方 + 本项目的 Font Manager） |

---

## 验收（免客户端，2026-10-15 实测）

```powershell
node test\plugin-ordering.test.mjs   # 真实 manifest 文件 → 真实 discoverPlugins() → /api/plugins 载荷
node test\host-scale.test.mjs        # 后端规模：惰性解压/发现缓存/ETag/归一化保真
node test\loader-scale.test.mjs      # 加载器规模：并发/超时隔离/顺序/遥测
node test\framework-api.test.mjs     # 框架 API 契约（假 DOM，含 betterncm.dev）
node test\dev-source.test.mjs        # dev mode：开发源 / 变更检测 / dev hijack 规则
node test\preload-engine.test.mjs    # hijack 引擎单测（含真实 web.pack 漂移守卫）
node test\plugin-reload.mjs          # 重复/并发 reload → 仅一次整页刷新
node test\plugin-market.test.mjs     # 插件市场后端：内置源/校验/依赖/更新/主题排他/源信任/可逆卸载
node test\manager-market.test.mjs    # 插件市场 UI：分类/搜索/排序/按钮守卫（假 DOM）
py tools\market\build_market.py --check  # 内置市场索引与插件包是否仍然一致
```

| 套件 | 实测 | 说明 |
|---|---:|---|
| `plugin-ordering` | **16 / 16** | 依赖排序与 `normaliseManifest()` 字段保真 |
| `host-scale` | **39 / 39** | |
| `loader-scale` | **33 / 33** | |
| `framework-api` | **59 / 59** | |
| `dev-source` | **59 / 59** | |
| `plugin-reload` | **PASS** | |
| `preload-engine` | **64 / 64** | 含漂移守卫：逐 chunk 复核两条 hijack 规则仍命中，且 `derived_from_pack` 与当前 `web.pack`（`83304b1`）一致 |
| `plugin-market` | **85 / 85** | 内置源离线安装、四道校验（zip/manifest/slug/sha256）失败后插件目录逐字节不变、依赖链与成环、更新移旧、主题排他、自定义源信任门槛、可逆卸载 |
| `manager-market` | **29 / 29** | 市场页的分类与 `author:` 搜索语法、五种排序（含无下载量统计时退化为 star）、互斥/被依赖时的按钮守卫 |

`test\autostart.cmd` 与 `test\manager.cmd` **需要运行中的客户端 / 后端**，不在上表内。

两个发行包另由 `tools/release/verify_release.ps1` 端到端验收（同样不需要客户端，**51/51 通过**）：
解压免安装包 → 自带 Node 可运行 → agent `--status` 正常 → 四个插件与 `market\` 种子进包内目录 →
打包后的后端能发现四个插件且 `locked=false`、无 core → `LyricBar.requirements` 与
`RefinedNowPlaying.loadAfter` 确实传到加载器 → 打包后的市场用**内置源**列出四个自带插件、
认出已安装状态、Font Manager 条目带校验摘要 → 沙箱内运行 `Setup.exe` 后运行树 / 卸载器 /
四个插件 / 市场索引 / 卸载项全部落地。

---

## 目录结构

```
loader/      version.dll 代理源码 · 注入页面的框架 · 管理 UI · hijack 规则
             install / uninstall / startup / launch / create-shortcut / paths
tools/       ntpk.py 容器工具 · ncm_host.mjs 后端 · market_host.mjs 插件市场后端
             bncm_agent.mjs 守护与注入 · CDP 工具 · market/build_market.py 市场索引构建
             release/ 发行包构建与验收
market/      内置插件市场源：plugins.json 索引 · plugins/ 插件包 · previews/ 预览图 · catalog.json 审阅输入
plugins/     src/<Name>/ 插件源码与出处材料（不参与扫描） · <Name>.plugin 随包分发的归档
             _upstream/ 上游原始归档 · _attic/ 溯源素材（都不进发行包）
docs/        00 基线 · 01 架构 · 02 容器格式 · 03 原生桥 · 04 反篡改 · 05 兼容矩阵
              06 插件框架 · 07 自动启动 · 08 管理器 · 09 插件出处 · 11 hijack 引擎
              12/13 Material 3 · 14 插件开发指南 · 17/18 性能 · 19 发行包 · 20 兼容性核查
              21 插件市场
test/        免客户端单测 + 需要客户端的验收脚本 + 基线哈希
PLUGIN-COMPAT.md  插件作者指南（manifest 契约、生命周期、API 现状、常见坑）
upstream/    上游参考克隆的获取说明（克隆本身不提交，见 upstream/README.md）
```

---

## 关键结论（三条）

1. **`msimg32.dll` 这个文件名已经不能用了。** 客户端在 `appInit` 阶段检查安装目录下是否存在
   同名文件并上报遥测 `existThirdPlugin`——这是**文件存在性检测**，不是内存扫描。改用
   `version.dll` 代理；`cloudmusic.dll` 静态导入 `VERSION.dll`，该名字不在 KnownDLLs 也不在
   检测名单里。
2. **CDP 通道可用，且指向 BetterNCM 的目标页面。** `/json/list` 返回的唯一 page target 就是
   `orpheus://orpheus/pub/app.html`；已实测可在其中执行 JS、注入 `window.betterncm`、跨会话读回状态。
3. **上游的 3.x 门禁会静默禁用 77% 的插件生态。** 上游只在插件声明 `ncm3-compatible: true` 时
   才加载，而 22 个真实插件里只有 5 个声明了该字段。本实现改为三态（只有显式 `false` 才跳过），
   并保留 `-Ncm3Gate strict` 以恢复上游语义——这是有实测依据的有意偏离。

---

## 边界与不做的事

- 不绕过会员/付费，不解密或分发音源与版权内容，不导出账号凭证。
- 不修改 `package/orpheus.ntpk`、`package/web.pack`、`package/*.skin`（RSA-512/SHA1 签名）。
- 不对客户端做内存补丁以篡改校验函数。
- 不分发 `chromatic` 的 `master` 分支（该分支无 LICENSE）。
- 客户端抽取物、重打包容器与运行态日志不进仓库（见 `.gitignore`）。

## 已知限制

- **`hijacks` 默认关闭**：拦截 `window.webpackJsonp` 会让客户端启动失败（`docs/11` §8）。
  当前四个插件都不依赖它。
- **插件市场的在线源默认全部关闭，只启用「内置源」**：内置源在本地磁盘（即时、离线）。
  在线源有三个自己的：主仓库的 `market/` 与独立源仓库
  [Leafmy/BetterNCM-PluginMarket](https://github.com/Leafmy/BetterNCM-PluginMarket)
  （两者已实测**逐字节一致**，`plugins.json` `23e2c82a…`），以及上游镜像
  （`bncm-plugin.microblock.cc` 本机实测 HTTP 522，上游下载量 API 的 DNS 已不可解析）。
  本机对 `raw.githubusercontent.com` / `cdn.jsdelivr.net` 的直连被阻断，客户端后端的 Node `fetch`
  又不走系统代理，所以 GitHub 类源在这台机器上会停在「正在后台读取」——网络环境问题，不是索引问题。
  普通打开市场**从不等待网络**，只有「刷新索引」与安装才会联网等待；索引没有 `downloads`
  字段时综合排序退化为按 star（与上游的降级路径相同）。
- **市场的 `loadAfter` 只作建议**：它按上游语义只是加载顺序提示，安装 `LyricBar` 会自动装它的
  `requirements`（`RefinedNowPlaying`），`MaterialYouTheme` 只作为建议列出，需要再点一次安装，
  或调用 `POST /api/market/install {slug, include_recommended:true}`。
- **CDP 注入不跨页面重载**，`cdp_watch.mjs` 通过轮询 canary 重新注入。
- **CEF 9x 的 `Page.captureScreenshot` 在本客户端上超时**，改用 `test\capture-window.ps1`。
- **`--remote-debugging-port` 是调试接口**（仅监听 `127.0.0.1`），不用时请 `startup.cmd -Uninstall`
  或直接双击客户端启动。
- **前端包会独立更新**（`web.pack` 已从 `c6406e5` → `477f8a2` → `83304b1`），命令表与插件兼容性
  需按 `docs/05-compat-matrix.md` 逐版本复查。hijack 规则的出处已随新包离线复核（`docs/11` §9）；
  片段真的失效时漂移守卫会报失败，而不是静默变成空操作。
- **仍未实现**：`native_plugin`（原生插件 DLL）、`fs.mountFile`、完整 `betterncm.react`、
  `app.exec` 的进程启动语义（**有意为之**：只开 URL/文件路径）。被调用时会显式打印
  `UNIMPLEMENTED API: …` 并返回**类型正确的空值**。
- **`window.loadedPlugins` 是「数组 + slug 属性」混合形态**（上游是按 slug 索引的对象）。
- **自动启动的代价**：登录守护在客户端「未带调试端口」时会**限流重启一次**（60 s 内最多 1 次、
  每次启动最多 3 次，可 `--no-relaunch` 关闭）；用 `loader\create-shortcut.cmd` 生成的启动器则永不重启。
- **dev mode 的热重载不是「干净重载」**：`betterncm.dev.reload()` 会重新执行插件脚本，但不会撤销
  旧副本做过的 DOM/样式/定时器改动；要干净状态用 `dev.reload({hard:true})`。
- **必须经 `Start.cmd` / 启动器启动**：后端是独立 Node 进程，直接双击客户端不会加载插件。
- **加载器的可扩展性有边界**：并发下载不改变求值顺序，超时会让永不返回的插件**被隔离**；
  但**插件里的同步死循环无法被抢占**（单线程 JS），框架只能保证它只影响自己并被记录成可归因的数据。
- **免安装包不含 `version.dll` 代理**（只用 CDP 通道）；安装器会主动关闭正在运行的客户端
  （代理替换要求文件未被映射），客户端目录不可写时该步失败但不中断其余步骤。

---

## 许可证

本仓库整体按 **GNU GPL-3.0** 分发，见 [`LICENSE`](LICENSE)。

这是派生作品：它实现了上游 [`std-microblock/chromatic`](https://github.com/std-microblock/chromatic)
的 `v2` 分支（GPL-3.0）的插件 API 契约与加载器语义，因此本仓库及其派生必须继续以 GPL-3.0 分发。
上游 `master` 分支**没有 LICENSE**，本项目不使用、不分发它。

四个插件中，前三个是**再分发**、不是原创作品：`LyricBar` 与 `RefinedNowPlaying` 为 **MIT**，
`MaterialYouTheme` 为 **GPL-3.0**；每个插件目录内的 `NOTICE.md` 与（再分发那三个的）`LICENSE` 为准，
汇总见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。`NCM-Font-Manager` 是本项目自研，
随仓库整体以 GPL-3.0-or-later 分发。

两个发行包内携带 `LICENSE`、`THIRD-PARTY-NOTICES.md`，以及所捆绑 Node.js 运行时的 MIT 授权全文
（`app/bin/NODE-LICENSE.txt`，逐字节与上游一致）。
