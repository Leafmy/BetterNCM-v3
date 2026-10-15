# 07 — 随网易云自动启动

> 目标：双击客户端 / 登录后启动，**无需任何命令行操作**，插件自动加载。
> 代码：`tools/bncm_agent.mjs`、`loader/bncm-agent.vbs`、`loader/startup.ps1`、`loader/create-shortcut.ps1`

## 1. 约束：为什么不能"事后补开关"

注入通道是 CDP（`--remote-debugging-port`），而 Chromium **只在进程启动时**读取该开关。
客户端里存在显式检测：

```
[boot] protocol command line injection detected, blocked. offending:
```

（`docs/04-antitamper.md` §3 #3）。运行期去改命令行/开调试端口正是这段检测要抓的行为，
所以本工程**不去碰它**——改为控制"进程是怎么被启动的"。

（`--remote-debugging-port` 本身在 3.1.41 上**没有被拦截**：`docs/05` §2.2 实测 CDP 可用。
被拦截的是"事后注入开关"这种做法，不是这个开关本身。）

## 2. 三个入口

| 入口 | 命令 | 行为 |
|---|---|---|
| **登录守护** | `loader\startup.cmd -Install` | 写 HKCU Run 项，登录时静默拉起 agent（`--at-logon`）。等待客户端出现；**若客户端没带调试端口，限流重启一次** |
| **启动器** | `loader\create-shortcut.cmd` | 生成「网易云音乐 (BetterNCM)」快捷方式，指向 `wscript.exe loader\bncm-agent.vbs --launch`。由 agent 自己启动客户端，**永不重启** |
| 开发会话 | `loader\launch.cmd` | 原样保留；新增 `-Agent` 可转交 agent |

两条正式入口最终都落到同一件事：**后端在跑 + 页面被注入**。

## 3. agent 做什么

`tools/bncm_agent.mjs`（单例）：

1. **单例**：`out/agent.lock` 记录 pid；已在跑就直接退出。日志 `out/agent.log`。
2. **后端**：若 `out/host.json` 描述的实例仍能响应 `GET /api/app/version` → 复用；
   否则以 `--data / --ncm / --plugins / --core-plugins` 拉起 `tools/ncm_host.mjs`（detached、隐藏窗口）。
3. **客户端**：
   - `--launch`：没有调试端口就直接以 `--remote-debugging-port=<port>` 启动；
   - `--at-logon`：轮询 `cloudmusic.exe`；若进程在跑但 CDP 不通 → 见 §4。
4. **注入**：`Page.enable` + `Page.addScriptToEvaluateOnNewDocument`（document-start 预载）
   + 对当前页面立即求值一次；随后按 `--interval`（默认 3 s）检查 canary，缺失则补注入。
5. **退出**：客户端退出后 `--at-logon` 回到等待；`--once` 注入一次即退出。

## 4. 唯一有侵入性的动作，以及它的边界

客户端**不带**调试端口时（例如用户双击了原始图标），守护需要重启它一次才能拿到注入通道。
这个动作被三重限流，并且全程写入 `out/agent.log`：

- 60 s 窗口内最多 1 次（`RELAUNCH_WINDOW_MS`）；
- 同一次客户端启动最多 3 次（`MAX_RELAUNCHES`）；
- 一次成功的启动会重置计数。

`--no-relaunch` 可完全关闭重启，此时 agent 只等待，不再干预。

想要**零重启**就用启动器：`loader\create-shortcut.cmd`（见 §2）。这条路径下客户端从一开始就带着开关，
agent 只会挂接与注入。

## 5. 数据与配置

| 项 | 默认 | 说明 |
|---|---|---|
| 数据目录 | `C:\betterncm` | 与上游一致；`%BETTERNCM_PROFILE%` 可重定向 |
| 用户插件目录 | `<数据目录>\plugins` | **注意**：不是仓库里的 `plugins/`。用户插件在自己可写、可卸载的位置 |
| 内置插件目录 | `<仓库>\plugins\core` | 随仓库分发，不可删除/禁用（见 `docs/08`） |
| 调试端口 | `9222` | agent `--port` |
| 后端端口 | 随机 | 由 `out/host.json` 描述符公布（含 API key） |

## 6. 验收

```powershell
loader\startup.cmd -Status                 # Run 项 / 插件目录 / agent 锁
node tools\bncm_agent.mjs --status         # 客户端进程数 / CDP / 后端（0=都正常，2=未就绪）
node tools\cdp_inject.mjs --expr "window.__BNCM_LOADED__.build"
node tools\cdp_inject.mjs --expr "JSON.stringify(window.__BNCM_HIJACK__.applied)"
powershell -NoProfile -ExecutionPolicy Bypass -File test\autostart.ps1
```

期望：`node tools\bncm_agent.mjs --status` 返回 0；`window.__BNCM_LOADED__.core` 含
`RefinedNowPlaying` / `LyricBar` / `MaterialYouTheme`；`__BNCM_HIJACK__.applied` 含
`builtin:lyrics-hook`。

## 8. 实机验证（2026-10-01，客户端 3.1.41.205529）

`test\autostart.cmd` 对运行中的客户端 **14/14 通过**，包括：

```
ok   agent --status reports ready      :: client processes : 3 | debug port 9222 : reachable | backend ok
ok   framework present in the page     :: build="bncm-v3-framework/0.3.0"
ok   document-start preload hooked webpack   :: hooksInstalled=true
ok   core plugins all loaded           :: ["LyricBar:loaded","MaterialYouTheme:loaded","RefinedNowPlaying:loaded"]
ok   RefinedNowPlaying hijack applied  :: ["builtin:redux-dispatch-hook", ...]
ok   document-start preload really beat the bundle  :: boot={"readyState":"loading","hadJsonp":false,...}
ok   synchronous ncm.getPlaying() works
ok   getSucceededHijacks resolves to an array   :: {"isArray":true,"n":2}
```

### 实机暴露并修掉的三个缺陷（都只会在真机上出现）

1. **CDP 注册与会话同生命周期。** `Page.addScriptToEvaluateOnNewDocument` 的注册属于**创建它的那个
   CDP 会话**，WebSocket 一关注册就被撤销。早期实现每个轮询周期开一次会话、注册、然后 `close()`，
   等于注册从未生效。实测表现：预载日志 `readyState:"complete", hadJsonp:true, existingLength:41`，
   `modulesSeen` 为 0、`applied` 为空。**现在会话在整个 agent 生命周期内保持打开**。
2. **首次挂接必然晚于文档。** 客户端已启动时，CDP target 只有在页面出现后才存在，因此预载无法
   对"当前这份文档"抢在 bundle 之前。现在 agent / `cdp_watch` / 预载**三方都会在检测到这一点时
   自动重载页面一次**（`reloadedFor` / `sessionStorage` 双重去重，不会循环）。
   判定依据就是预载自己抓的取证字段 `boot.hadJsonp`。
3. **`window.APP_CONF` 在 3.1.41 上不存在。** `loader/framework.js` 的版本探测只读它，于是
   `ncm.version` 为 `null` → `satisfies(null, '> 3.0.0')` 为假 → **所有声明 `ncm-version-req`
   的插件被静默跳过**（实测报 "not satisfied by null"）。现在按
   `APP_CONF → User-Agent（…NeteaseMusicDesktop/3.1.41.205529）→ 上一次运行记录` 分层探测，
   并且**版本未知时不再 fail-closed**（照常加载并标记 `unversioned`）——版本未知是我们的盲区，
   不是插件不兼容的证据。

### 已知代价

客户端启动后约 5–10 s 会发生**一次页面重载**（为了让 hijack 生效）。它发生在用户操作之前，
不影响使用；诊断页的 `boot` 字段可以确认重载后是否真的抢到了 document-start。

## 9. 恢复

```powershell
loader\startup.cmd -Uninstall      # 删除 Run 项 + 停掉 agent（插件文件保留）
loader\uninstall.cmd -StopClient   # 再移除 version.dll 代理并还原
loader\create-shortcut.cmd -Remove # 删除快捷方式，并恢复被 -Replace 覆盖的原快捷方式
```

`uninstall.ps1` 会**先**清 Run 项与 agent，避免代理都卸了守护还在重启客户端。
`-KeepAutostart` 可跳过这一步。

## 8. 已知限制

- **调试端口在会话期常开**（仅环回 `127.0.0.1`）。这是 CDP 路线的固有代价；
  `loader\startup.cmd -Uninstall` 或直接在不开 agent 的情况下启动客户端即可关闭。
- **`.ps1` 被执行策略拦截**，因此所有脚本都通过同名 `.cmd` 包装调用（仓库既有约定）。
- **`.ps1` 含非 ASCII 时必须带 UTF-8 BOM**：PowerShell 5.1 对无 BOM 文件按 ANSI 解码，
  中文会破坏解析（本工程的 `startup.ps1` / `create-shortcut.ps1` 已带 BOM）。
