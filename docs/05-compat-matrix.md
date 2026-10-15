# 05 — 兼容矩阵

维护原则：**每次客户端或前端包更新都可能改变结论**。前端包（`web.pack`）会独立于客户端安装包更新，
因此本表同时记录客户端版本与前端 `COMMITHASH`。

## 1. 上游基线状态

| 项目 | 状态 | 证据 |
|---|---|---|
| `std-microblock/BetterNCM` → `std-microblock/chromatic` | 已改名；API 301 重定向 | `api.github.com/repos/std-microblock/BetterNCM` |
| BetterNCM 代码位置 | 分支 `v2`（GPL-3.0） | `v2/LICENSE`（35,149 B） |
| 官方声明兼容范围 | **`2.10.* ~ 3.0.*`** | `v2/README.md` |
| 最后一版二进制 | `1.3.4`，2024-10-02 | releases |
| `master` 分支 | 2026-03 孤儿历史，无网易云代码，**无 LICENSE** | tree + `license` API 404 |
| NCM-3 插件门槛 | `v2` 仅加载 `ncm3-compatible: true` 的插件 | `v2/src/PluginManager.cpp` |
| 社区 3.1.x 反馈 | 3.1.3 / 3.1.4 / 3.1.9 均报告启动失败；issue #596 称 3.1.35+ 检测注入并拒绝启动 | GitHub issues #555 / #558 / #569 / #596 |

## 2. 本机实测结论（3.1.41.205529）

### 2.1 DLL 代理通道

| 检查项 | 结论 | 证据 |
|---|---|---|
| `msimg32.dll` 可被代理 | **是**（`cloudmusic.dll` 静态导入） | PE 导入表 |
| `msimg32.dll` 是否安全 | **否**，文件名被硬编码检测 | `CheckThirdPluginHook` + UTF-16 字面量 |
| `version.dll` 可被代理 | **是**（`cloudmusic.dll` 静态导入，非 KnownDLL） | PE 导入表 + KnownDLLs 注册表 |
| `version.dll` 代理实际加载 | **是**，Main / GpuProcess / **Renderer** 三个进程全部命中 | `%LOCALAPPDATA%\BetterNCM\logs\loader.log` |
| 真 `version.dll` 同时加载（不破坏宿主） | **是** | 模块表：`E:\CloudMusic\VERSION.dll` 与 `C:\WINDOWS\system32\version.dll` 并存 |
| 客户端是否正常启动 | **是**，多进程结构完整 | 进程枚举 |
| 是否触发第三方插件拦截 | **否**（未放置 `msimg32.dll`） | 客户端正常启动 |

### 2.2 CDP 通道

| 检查项 | 结论 | 证据 |
|---|---|---|
| `--remote-debugging-port` 是否被拦截 | **否**，端口正常监听 | `HTTP 200 /json/version` |
| 版本信息 | `Chrome/91.0.4472.169`，`V8 9.1.269.40` | `/json/version` |
| 目标页面 | **`orpheus://orpheus/pub/app.html`**（唯一 page target） | `/json/list` |
| 能否执行 JS | **能** | `Runtime.evaluate` 返回注入结果 |
| 状态能否跨会话保持 | **能**（另开 session 读回） | 读回 `window.__BNCM_LOADED__` |
| `window.betterncm` 注入 | **成功**（`version = 3.0.0-wip`） | DOM 查询 |
| 可见标记挂载 | **已移除浮动徽标** | 状态改为在 BetterNCM 面板内显示（`betterncm.status()` → `#bncm-manager` 头部） |
| `Page.captureScreenshot` | **超时不可用** | 15 s 超时；已知 CEF 限制 |
| 注入是否跨页面重载存活 | **否**，需 watcher 重注入 | 设计约束，见 `tools/cdp_watch.mjs` |

### 2.3 包改包通道

| 检查项 | 结论 |
|---|---|
| 族 A 包签名算法 | RSA-512 / PKCS#1 v1.5 / SHA-1，覆盖 `data[100:]` |
| 本机两包签名是否有效 | **均有效**（`tools/ntpk.py verify`） |
| 改正文后能否重新签名 | **不能**（无私钥） |
| 结论 | **放弃改包路线** |

### 2.4 插件兼容层

| 检查项 | 结论 | 证据 |
|---|---|---|
| `.plugin` 归档加载 | **可用**（ZIP，根目录 `manifest.json`） | `plugins/*.plugin` 三种插件均被正确发现 |
| 解包目录加载 | **可用** | `plugins/src/*` 开发模式 |
| 自检插件 | **14/14 通过** | `window.__BNCM_SELFTEST__` |
| **真实第三方插件** | **21/22 加载成功**（`C:\betterncm\plugins`，22 个） | `docs/real-plugin-compat.json` |
| 唯一失败 | `StyleSnippet 0.2.2` — `Minified React error #31`，插件级 React 版本不兼容 | 同上 |
| `betterncm.*` API | **可用** | `docs/06-plugin-framework.md` §6 |
| `plugin` 契约（注册函数 + EventTarget + mainPlugin） | **已对齐上游** | 同上 §4 |
| React 桥 `window.h` / `window.f` | **可用** | `typeof window.h === 'function'` |
| `betterncm.fs` 往返 | **可用** | `selftest-result.json` |
| 原生桥 `channel.call` | **可用**，回调必触发；部分命令回调 `undefined`、改由 `registerCall` 推送 | `docs/06-plugin-framework.md` §6 |
| 插件隔离（单插件抛错） | **有效**，`broken-plugin` 记 `error`，其余照常加载 | `window.__BNCM_LOADED__.plugins` |
| 3.x 门禁（`ncm3-compatible: false`） | **有效**，`incompatible-plugin` 记 `skipped` 且未执行 | `window.__BNCM_INCOMPAT_RAN__ === false` |
| 门禁策略偏离 | 未声明该字段者**照常加载**（上游会跳过 17/22 = 77%） | 同上 §5 |
| `ncm-version-req` 判定 | **有效**（`> 2.10.2` 对 `3.1.41.205529` 成立） | 自检项 |
| `hijacks` / `native_plugin` / `app.exec` / `fs.mountFile` | `hijacks` **0.3.0 已实现**（页面级 webpack 模块改写，`docs/11`），当前 2 条内置规则均对真实 web.pack 验证（片段命中 1 次 / 2 次，`COMMITHASH` 一致）。`native_plugin` / `fs.mountFile` / 进程启动语义仍未实现（调用时显式告警） |
| 内置核心插件机制（`plugins/core/`） | **机制保留，默认关闭**：显式传 `--core-plugins DIR` 才启用（core 插件不可禁用/卸载，服务端 403）。本仓库中该目录**不存在**——三个插件已解耦为普通用户插件，可禁用、可卸载（`docs/08`） |
| 2.x → 3.x DOM 断层（重大） | 原版 RNP 2.19.5 与 LyricBar 0.3.6 依赖的整套 2.x DOM 在 3.1.41 **全部为 0 次**：`#main-player`、`.m-player`、`.g-single`、`.n-single`、`.cdimg`、`.btnp`、`.brt`、`.g-mn`、`.playfrom`、`.cvr.j-curr`、`#page_pc_userfm_songplay`。RNP 因此改用 3.x 续作；LyricBar 数据通路可用但 DOM 探测退化 |
| 插件管理机制 | core/user 两分 + 自愈式入口（上游用的 `.cmd-icon-setting`、`section.g-mn` 在 3.1.41 均已不存在）+ 诊断页 |
| 旧插件退役 | 22 个旧 `.plugin` + 22 个解包目录 → `C:\betterncm\_backup_<时间戳>\`，含逐项 SHA-256，`cleanup_plugins.cmd -Verify` 复验通过 |



## 3. 逐版本记录表

填写规范：`客户端版本` + `web.pack COMMITHASH` → 四通道结论 + 备注。

| 客户端 | web.pack COMMITHASH | version.dll 代理 | CDP | 改包 | 插件框架 | 备注 |
|---|---|---|---|---|---|---|
| 3.1.41.205529 | `477f8a2` | ✅ 已实测（Main/Gpu/Renderer 全命中） | ✅ 已实测（可注入、可读回） | ❌ 签名 | ✅ 自检 14/14 | ✅ 真实插件 21/22 | 本表基线；`orpheus.ntpk` = `c6406e5` |

### 复现命令

```powershell
# 环境探测（版本、CEF、包签名、导入表、进程模型）
py tools\ncm_probe.py probe

# 包校验
py tools\ntpk.py verify "E:\CloudMusic\package\orpheus.ntpk"
py tools\ntpk.py verify "$env:LOCALAPPDATA\Netease\CloudMusic\web.pack"

# 桥命令清单重算
py tools\analyze_bundle.py "$env:LOCALAPPDATA\Netease\CloudMusic\web.pack" --out docs\native-commands.json

# 代理加载证据
Get-Content "$env:LOCALAPPDATA\BetterNCM\logs\loader.log"

# 插件框架验收（14/14）
loader\launch.cmd -Duration 45 -Force
node tools\cdp_inject.mjs --expr "var s=window.__BNCM_SELFTEST__; s.passed+'/'+s.total"
node tools\cdp_inject.mjs --expr "JSON.stringify(window.__BNCM_LOADED__.plugins)"

# 还原校验
powershell -NoProfile -ExecutionPolicy Bypass -File test\restore-verify.ps1
```

## 4. 需要每次复查的高风险项

| 项 | 为何要复查 |
|---|---|
| `muti-process-pc-disable`（abtest） | 若网易远程开启单进程 CEF，`--type=renderer` 分支消失，代理路线静默失效 |
| `enableCefHook` / `cefHookList`（abtest） | 网易自身 inline-hook CEF 时会与我们的 hook 抢同一入口 |
| 检测字面量是否新增 | 目前只检测 `msimg32.dll`；若新增 `version.dll`，代理需改 `winmm.dll` |
| `[boot] protocol command line injection` 规则是否收紧 | 若开始过滤 `--remote-debugging-port`，CDP 路线失效 |
| 前端 `web.pack` 更新 | 命令表 / `pc-new` 命名空间 / `exec` 白名单都可能变化 |
