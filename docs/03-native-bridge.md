# 03 — 原生桥协议（3.1.41）

权威数据在 **`docs/native-commands.json`**（由 `tools/analyze_bundle.py` 从实际前端包生成）。
本文件解释其结构与用法。

## 1. 生成方式

```powershell
py tools\analyze_bundle.py "C:\Users\<user>\AppData\Local\Netease\CloudMusic\web.pack" `
    --out docs\native-commands.json --top 40
```

扫描对象为该包内全部 `.js` / `.html`（本次 253 个脚本），把源码中的字符串字面量按
`namespace.method` 形状归类；以 `on` + 大写字母开头的方法归入 **事件**（host → page），其余归入 **命令**。

## 2. 结果概览（3.1.41，web.pack @ `477f8a2`）

| 指标 | 值 |
|---|---|
| 扫描脚本 | 253 |
| 命令 | **250** |
| 事件 | 5 |
| 命名空间 | 15 |

各命名空间出现次数：

| 命名空间 | 次数 | 说明 |
|---|---:|---|
| `app` | 183 | 应用生命周期、配置、日志、遥测、更新 |
| `player` | 95 | 播放控制、歌词、音量、封面 |
| `os` | 82 | 系统信息、字体、外链、设备号、退出 |
| `winhelper` | 75 | 窗口位置/尺寸、菜单、热键、剪贴板、置顶 |
| `storage` | 66 | 文件读写、SQL、离线曲、目录扫描 |
| `trayicon` | 28 | 托盘图标与提示 |
| `network` | 26 | 请求、会话、代理、Aegis 加密 |
| `musiclibrary` | 24 | 本地音乐库增删 |
| `update` | 15 | 升级流程 |
| `audioeffect` | 14 | 音效 |
| `browser` / `download` / `desktop` | 10 / 10 / 10 | 内嵌浏览器、下载、桌面 |
| `process` | 8 | 跨进程调用 |
| `rtc` | 4 | 实时语音 |

host → page 事件（页面用 `channel.registerCall` 订阅）：

```
app.onBootFinish
app.onRecognizeMusic
app.onFeedbackRecognizeMusicResult
player.onRenderLRCImageResult
winhelper.onGetWKWebWindowLocalStorage
```

## 3. `exec()` 的数值参数白名单

`window.dbg.Command.exec()` 默认会把**对象/数字参数统一转成字符串**，但以下 22 条命令的数值参数
必须保持数值类型（否则原生侧解析失败）。这是 3.x 与 2.x 最容易踩的差异点之一：

```
winhelper.setWindowPosition     player.setCurrentTime        player.setVolume
app.scanMusicFile               winhelper.setWindowSizeLimit player.setLikeMark
storage.offlineTrack            storage.execsql              winhelper.popupMenu
storage.exectransaction         musiclibrary.addLibrary      musiclibrary.removeLibrary
storage.savetofile              storage.deletefile           storage.readfromfile
player.setTotalTime             player.setOffset             player.simulateKRC
player.showVolume               storage.downloadscanner      storage.scanDirectory
```

（共 22 项，清单与 `docs/native-commands.json` 的 `exec_numeric_arg_whitelist` 字段一致。）

> 注意：`storage.execsql` 在该白名单中出现两次（源码去重后 21 个唯一值）。

## 3b. 大小写变体命令

`docs/native-commands.json` 的键是**大小写敏感**的，其中存在一对仅大小写不同的命令：

```
winhelper.SetNativeWindowShow      (大写 S)
winhelper.setNativeWindowShow      (小写 s)
```

两者都在 3.1.41 的前端包里出现。可能其中一处是客户端自身的笔误，也可能原生侧确实注册了两个名字。
**插件实现时不要假设命令名大小写不敏感**；建议两个都尝试，或直接调用大写版本并观察结果。
（副产物提醒：Windows PowerShell 的 `ConvertFrom-Json` 对键大小写不敏感，会因这对命令报
`DuplicateKeysInJsonString` —— 用 Python 或 Node 读取该文件，不要用 PowerShell 的 JSON 转换。）

## 4. `registerCall` 的三种模式

`67.chunk.*.js` 中定义：

| 模式 | 值 | 语义 |
|---|---:|---|
| `FILL_EMPTY` | 0 | 仅当该命令**没有**已注册回调时注册（默认） |
| `OVERRIDE` | 1 | 覆盖已有回调 |
| `APPEND` | 2 | 追加回调 |

插件若要拦截某个命令（BetterNCM 的常用手法），应使用 `OVERRIDE` 或 `APPEND`，
并在卸载时用 `removeCall` 还原，避免破坏客户端自身的注册。

## 5. 命名空间多来源（`LegacyHacker`）

`67.chunk.*.js` 里有一层兼容代码：

```js
LegacyHacker.REGISTER_CALL_NS_LISTENER_MAP = { nej: {}, "pc-new": {}, websdk: {} };
```

`nej` / `websdk` 是 2.x 与网页版的历史来源，**3.x 原生桥走 `pc-new`**。
插件调用 `registerCall` 时若不指定 `_from`，会被默认归入 `nej`，
因此跨版本插件应当显式标记来源，或直接使用 `window.dbg.Command` 的封装。

## 6. 对插件兼容层的意义

1. BetterNCM 插件大量直接调用 `channel.call("winhelper.xxx", …)`。
   只要 `window.channel` 仍在（**[实测]** 在，13 个函数齐全），这类调用无需改动即可工作。
2. 依赖 `dbg.Command` 行为（数值白名单、回调注册模式）的插件需要按 §3/§4 校对。
3. 3.x 新增/改名的命令可用 `docs/native-commands.json` 与插件源码做差集，快速定位失效点。
4. `native-commands.json` 的 `files` 字段记录了每条命令被哪些 chunk 引用，
   可用于判断某命令属于哪个功能模块。
