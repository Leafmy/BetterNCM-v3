# 04 — 反篡改面与规避

> 目标：`3.1.41.205529`（2026-09-18 构建）。所有结论标注证据来源：**[实测]** / **[静态]** / **[外部]** / **[推断]**。

本文件的核心结论只有一条，但它决定了加载器的落地形式：

> **网易云 3.1.41 会检查安装目录下是否存在名为 `msimg32.dll` 的文件，并在 `appInit` 阶段把结果上报为 `existThirdPlugin`。
> 因此代理 DLL 必须改用其它文件名（推荐 `version.dll`）。**

---

## 1. 第三方插件检测 = 文件名检测（关键发现）

`E:\CloudMusic\cloudmusic.dll` 中存在**唯一一处**第三方文件名常量，且以 UTF-16LE 存储（偏移 `27464728`）：

```
… "StatisLog::SetNativeInitCostTime, native init time: "   (ASCII)
  m\0s\0i\0m\0g\03\02\0.\0d\0l\0l\0\0                      (UTF-16LE ".msimg32.dll" -> "msimg32.dll")
  " Exist Third party plugin files!"                       (ASCII)
… "?CheckThirdPluginHook@StatisLog@storage@orpheus@@CA_NXZ" (MSVC 修饰名, ASCII)
… "existThirdPlugin" … "appInit" …
```

解读：

| 证据 | 含义 |
|---|---|
| `?CheckThirdPluginHook@StatisLog@storage@orpheus@@CA_NXZ` | 静态成员函数 `orpheus::storage::StatisLog::CheckThirdPluginHook()` |
| 同区域 ASCII `storage\statis_log.cpp` | 实现位于 `storage/statis_log.cpp` |
| 紧邻的 `existThirdPlugin` | 上报遥测字段名 |
| 紧邻的 `appInit` | 检查发生在启动阶段 |
| ASCII 中 **`msimg32.dll` 出现 0 次** | 检测字面量只有这一份 UTF-16 版本，**列表里没有其它文件名** |

**结论 [静态]**：这是**文件存在性检测**，而非模块枚举 / 内存扫描 / 哈希校验；检测名单目前只含
`msimg32.dll` 一个名字。

**结论 [推断]**：这正是 upstream issue #596 描述的"3.1.35 检测到类似 BetterNCM 的注入插件后会直接拒绝启动"
的实现。它解释了为什么保持文件名 `msimg32.dll` 的方案在 3.1.35+ 上不可行。

---

## 2. 代理文件名的选择

**不要**使用 `msimg32.dll`。改用 `cloudmusic.dll` 同样静态导入、且不在 KnownDLLs、也不在检测名单里的候选：

| 候选 | 导入者 | 导入方式 | KnownDLLs | 被检测 | 导出面 | 评价 |
|---|---|---|---|---|---|---|
| `msimg32.dll` | `cloudmusic.dll` | 静态 | 否 | **是** | 5 个 | 弃用（触发检测） |
| **`version.dll`** | `cloudmusic.dll` | 静态 | 否 | 否 | 17 个，全部为版本信息查询 | **推荐** |
| `winmm.dll` | `cloudmusic.exe` + `cloudmusic.dll` | 静态 | 否 | 否 | 约 180 个（mci/waveOut/midiOut/timeGetTime…） | 备选，导出面过大、转发易漏 |
| `dbghelp.dll` | `cloudmusic.dll` | **delay-load** | 否 | 否 | 很多 | 不推荐：delay-load 可能永不触发；且安装目录已存在正版 `dbghelp.dll`，替换属破坏性 |

**推荐 `version.dll`**：静态导入 → 加载时机早且确定；导出仅 17 个
（`GetFileVersionInfoA/W`、`GetFileVersionInfoSizeA/W`、`GetFileVersionInfoExA/W`、
`GetFileVersionInfoSizeExA/W`、`VerQueryValueA/W`、`VerFindFileA/W`、`VerInstallFileA/W`、
`VerLanguageNameA/W`，另加 2 个 `VerFindFile`/`VerInstallFile` 的 ANSI 变体），AheadLib 转发样板极小。

> 影响：这一项**改变了已批准计划的字面内容**（原计划为 `msimg32.dll`），但完全符合已批准的**策略**
> ——"只新增一个代理 DLL、不改其它文件"。因为 `msimg32.dll` 这个**名字本身**就是触发条件，
> 继续使用它会使方案在 3.1.41 上直接失败。

---

## 3. 其余反篡改面清单

| # | 机制 | 证据（字符串 / 符号） | 触发条件 | 对本方案的影响 |
|---|---|---|---|---|
| 1 | 第三方插件文件检测 | `msimg32.dll` / `Exist Third party plugin files!` / `CheckThirdPluginHook` / `existThirdPlugin` | `E:\CloudMusic\msimg32.dll` 存在 | **已规避**：改名 `version.dll` |
| 2 | NTPK 包签名校验 | `[boot] Verify ntpk failed.` / `NTPKHelper check ntpk` / `ntpk_flag` / `update_ntpk_flag` / `appInit/verifyFile` | `package/*.ntpk` 被修改 | **已规避**：本方案不改 `package/` 下任何文件 |
| 3 | 命令行注入拦截 | `[boot] protocol command line injection detected, blocked. offending:` | CEF 命令行被外部追加可疑开关 | **需注意**：本方案若改用 CDP 需实测该拦截是否放行 `--remote-debugging-port`（见 §5） |
| 4 | 网易侧 CEF Hook 框架 | `enableCefHook` / `cefHookList` / `unhookReport` / `hook_host` / `unhook_host` / `unsupport_request` | 远程 abtest 开启 | **最高风险**：若网易自身 inline-hook 同一批 `libcef` 导出，将与 v2 的 Detours 抢同一函数入口 |
| 5 | 进程模型开关 | `muti-process-pc-disable` / `muti-process-pc-enable` | 远程 abtest 开启 | 单进程化会让 `--type=renderer` 分支消失，注入静默失效 |
| 6 | Aegis 安全 SDK | `AegisSDK.dll`、`%LOCALAPPDATA%\Netease\CloudMusic\Aegis\pubkey` | 未知 | 未分析；`pubkey` 内容为 base64 JSON `{"publickey":"…","version":"3000000010000","nextUpdateTime":1819684155000,"sk":"…"}`，32 字节公钥（Ed25519/X25519 量级），与 NTPK 签名（RSA-512）**不是同一套** |
| 7 | 遥测上报 | `Log\BI\`、`cloudmusic_reporter.exe`、`existThirdPlugin` | 检查命中时 | 即使成功规避启动拦截，仍可能有后台标记 |

**共同点**：以上机制**没有一项**依赖代码段完整性自校验（未发现 CRC/哈希自检或 `IsDebuggerPresent` 型反调试）。
因此"新增一个代理 DLL + 运行期 hook"的路线不会与它们产生直接的完整性对抗。

---

## 4. 规避原则（本方案遵守）

1. **不改被签名的文件**。`package/orpheus.ntpk`、`package/web.pack`、`*.skin` 一律不动。
   §3 #2 因此不会被触发。
2. **不用被检测的文件名**。代理名 `version.dll`，不是 `msimg32.dll`。
3. **不做内存补丁**。不去 NOP 掉 `CheckThirdPluginHook` 或 `Verify ntpk` 的判定分支——
   那会把"文件检测"升级为"代码完整性对抗"。
4. **与网易自身的 CEF hook 共存**，而不是对抗：
   - Detours 采用**链式**语义（保存并调用 `origin_*`），不覆盖对方入口；
   - 若 §3 #4 命中导致冲突，退路是改用**不需要 inline hook 的注入点**（见 §5）。
5. **可一键关闭**：保留 v2 原生的 `BETTERNCM_DISABLED_FLAG` 环境变量与 `BETTERNCM_PROFILE` 数据目录重定向。
6. **可完全还原**：`uninstall.ps1` 删除代理文件并比对 `test/baseline/hashes.json` 验证零差异。

---

## 5. 备选注入路线（不依赖 DLL 代理）

**[外部]** `AcmeLuo/CloudMusicLayoutFix` 报告并附带源码：在
**`3.1.40.205461` 与 `3.1.41.205529`（与本机完全一致的构建）** 上，
以 `cloudmusic.exe --remote-debugging-port=9222` 启动后，CDP 端点
`http://127.0.0.1:9222` 可用，可通过 DevTools 协议向页面注入 JS/CSS。

价值：

- **零文件改动**（除启动方式），不触碰 §3 #1/#2，也不会被 `CheckThirdPluginHook` 命中。
- 与本方案的 P4 是**互补**关系：若 `version.dll` 代理路线因 §3 #4/#5 失败，CDP 是已验证的退路。
- 局限：桌面歌词与迷你播放器是**独立窗口，不在 CDP target 内**，只能覆盖主浏览器窗口。

**[外部/待实测]** 客户端字符串 `[boot] protocol command line injection detected, blocked. offending:` 表明
客户端会过滤部分命令行开关。`--remote-debugging-port` 是否被过滤**必须在本机实测**，
不能仅凭外部报告推断。

---

## 6. 待实测清单（P4 门禁）

| 编号 | 待测项 | 判定方法 | 通过标准 |
|---|---|---|---|
| T1 | `version.dll` 代理是否被加载 | 只读枚举 `cloudmusic.exe` 各进程已加载模块 | 主/渲染进程模块表出现 `E:\CloudMusic\version.dll` |
| T2 | 渲染进程注入是否成功 | 加载器日志 + 页面内 JS 标记 | 日志出现注入成功标记，页面可执行我们的 JS |
| T3 | `CheckThirdPluginHook` 是否仍触发 | 不放置 `msimg32.dll` 的前提下观察 `Log\BI\` 与 `web.log` | 无 `existThirdPlugin` 上报 |
| T4 | 网易自身 `enableCefHook` 是否与本方案冲突 | 观察是否崩溃 / hook 是否生效 | 客户端正常启动且注入生效 |
| T5 | `--remote-debugging-port` 是否被命令行拦截 | 用该开关启动并访问 CDP 端点 | 端点可用（备选路线可用性） |
| T6 | 客户端是否仍为多进程 | 启动后枚举子进程命令行 | 存在 `--type=renderer` |
