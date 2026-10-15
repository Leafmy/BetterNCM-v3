# 00 — 基线快照与环境事实

> 捕获时间：2026-10-01 · 目标：网易云音乐 `3.1.41.205529` (Orpheus / CEF 91)

本文件固定后续所有实验的**可复现基线**。任何"已还原"的结论都必须回到这里比对。

## 1. 目标客户端

| 项 | 值 | 来源 |
|---|---|---|
| 产品名 | 网易云音乐 | 注册表 Uninstall 项 |
| 版本 | `3.1.41.205529` | `cloudmusic.exe` VS_FIXEDFILEINFO |
| 安装目录 | `E:\CloudMusic` | `HKLM` 卸载项 `UninstallString = E:\CloudMusic\UnInstall.exe` |
| 用户数据目录 | `%LOCALAPPDATA%\Netease\CloudMusic` | 运行期实测 |
| CEF | `91.2.3+g3268653+chromium-91.0.4472.169` | `libcef.dll` 版本资源 |
| Chromium UA | `Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.41.205529` | 子进程命令行 |

注意：`libcef.dll` 的 Chromium **分支**是 `91.0.4472`，patch 为 `.169`；而 BetterNCM v2 固定的子模块 `BetterNCM/libcef@615be4a` 声明 `91.1.23+...-91.0.4472.164`（patch `.164`）。**同一分支**，因此 v2 钩的 `libcef.dll` C 导出表在当前客户端上是同一套 ABI。

## 2. 关键产物哈希（未修改状态）

完整清单见 `test/baseline/hashes.json`（173 个文件，439,710,476 字节，无读取错误）。

| 文件 | 大小 | SHA-256（前 16） |
|---|---:|---|
| `cloudmusic.exe` | 2,634,744 | `16689d9731121f0f` |
| `cloudmusic.dll` | 37,747,192 | `7f667f876caf94bc` |
| `libcef.dll` | 155,353,600 | `a2a441490a9600f7` |
| `package/orpheus.ntpk` | 37,939,010 | `58bee4e575f2b276` |
| `package/native.ntpk` | 779 | `5730531082ac10e9` |
| `package/common.skin` | 1,213,673 | `b5687b60416ccdbf` |
| `package/dark.skin` | 1,218,938 | `599e003412250018` |
| `%LOCALAPPDATA%\Netease\CloudMusic\web.pack` | 38,310,561 | `bf2cf3dd80ebfe99` |

**基线排除项**（运行期生成/易变，不参与"零差异"判定，且已在脚本中显式剔除）：
`Cache/`、`Log/`、`logs/`、`update/`、`Temp/`、`dumps/`、`webapp91x64/`、`webdata/`、`ad/`、`__pycache__/`，
以及安装根目录下的 `debug.log`、`cloudmusic.elog`、`localdata`、`info`。

`E:\CloudMusic\update\orpheus_install.exe`（166,592,080 字节）是升级包残留；`install.log` 记录上一版本为 `3.1.40.205461`。

## 3. 运行期事实（实测，2026-10-01）

客户端运行时存在 **多进程 CEF**，这对注入方案是决定性的：

```
PID 9272   (Main)      "E:\CloudMusic\cloudmusic.exe"
PID 37748  (Child)     ... --type=gpu-process ... --no-sandbox ... /prefetch:2
PID 12872  (Child)     ... --type=renderer ... --no-sandbox ... --renderer-client-id=3 ... /prefetch:1
PID 36536  (Child)     "E:\CloudMusic\cloudmusic_reporter.exe"
```

要点：

- **`--type=renderer` 子进程存在** → BetterNCM 的进程分类逻辑
  （`--type=renderer` → `Renderer` → `EasyCEFHooks::InstallHooks()`）在 3.1.41 上仍然成立。
- 客户端以 `--no-sandbox` 运行。
- 日志：`%LOCALAPPDATA%\Netease\CloudMusic\web.log`（子进程 `--log-file`），
  `E:\CloudMusic\debug.log`，遥测 `%LOCALAPPDATA%\Netease\CloudMusic\Log\BI\`。

> 风险提示：客户端字符串中存在 abtest 键 `muti-process-pc-disable`，说明网易可远程把 CEF 切到单进程。
> 若发生，`--type=renderer` 分支将不再出现，加载器会静默失效。每次适配需复查本项。

## 4. 导入表（决定 DLL 代理可行性）

从 PE 导入表解析（非字符串扫描）：

| 宿主 | 静态导入中的候选代理目标 | KnownDLLs? |
|---|---|---|
| `cloudmusic.exe` | `WINMM.dll` | 否 |
| `cloudmusic_util.exe` | `WINMM.dll` | 否 |
| **`cloudmusic.dll`** | **`MSIMG32.dll`**、`VERSION.dll`、`WINMM.dll` | 均**不在** KnownDLLs |
| `cloudmusic.dll`（delay-load） | `dbghelp.dll`、`dwmapi.dll` | 不在 |

`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\KnownDLLs` 中 **不含** `msimg32.dll`、`version.dll`、
`winmm.dll`、`dbghelp.dll`（含 `SHLWAPI`、`SHELL32`、`USER32`、`OLE32`、`IMM32`、`CRYPT32` 等）。
因此**应用目录优先**的搜索顺序生效，放置在 `E:\CloudMusic\` 下的同名代理 DLL 会被加载。

关键结论：**`cloudmusic.dll` 静态导入 `MSIMG32.dll`** —— 这正是 BetterNCM 选择 `msimg32.dll`
作为代理名的原因，且在 3.1.41 上依然成立。但该文件名**已被网易检测**，见 `04-antitamper.md`。

## 5. 上游基线

| 项 | 值 |
|---|---|
| 仓库 | `std-microblock/chromatic`（原 `std-microblock/BetterNCM`，API 301 重定向） |
| 选中分支 | **`v2`** @ `1b7eb7fdaa08de15e579c86dadb6ef848a72b6f1` |
| 授权 | **GPL-3.0-or-later**（`LICENSE` 35,149 B；`vcpkg.json` 亦声明） |
| 官方兼容声明 | `2.10.* ~ 3.0.*`（`v2/README.md`）→ **3.1.41 不在声明范围内** |
| 最后一版发布 | `1.3.4`，2024-10-02 |
| 子模块 | `src/js-framework` @ `44b4df2`（本地已就位）；`src/3rd/libcef` @ `615be4a` |

`master` 分支是 2026-03 的**孤儿历史**，已不含任何网易云代码，且**无 LICENSE**（不可再分发）。
参考分支 `3.0.0-adaption` @ `7bb194b`（冻结于 2023-10-01，面向 3.0.0 beta）。

## 6. 已知未被证实的风险（需实测）

1. **3.1.35+ 启动拦截**：issue #596 报告"检测到类似 BetterNCM 的注入插件后会直接拒绝启动"。
   本地静态分析已定位到该检测的实现（见 `04-antitamper.md`）——它是**文件名检测**，不是内存扫描。
2. `check_thrid_plugin` / `existThirdPlugin` 是否后台上报，静态无法定论。
3. `enableCefHook` / `cefHookList` 若被远程开启，网易自身会 inline-hook CEF，可能与 v2 的 Detours 冲突。
