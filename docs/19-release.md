# 19 — 发行包：一键安装包 与 免安装包

> 构建脚本：`tools/release/build_release.ps1`
> 验收脚本：`tools/release/verify_release.ps1`（客户端无需运行，**28/28** 通过）
> 目标产物：`%USERPROFILE%\Desktop\release\`

## 1. 两个产物

| 产物 | 形式 | 装什么 | 卸载方式 |
|---|---|---|---|
| `BetterNCM-v3-Setup-x64.exe` | IExpress 自解压 exe（双击即装） | 运行时装到 `%LOCALAPPDATA%\BetterNCM\app`；`version.dll` 代理装进客户端；四个插件装进数据目录；注册 HKCU 登录守护 + 开始菜单/桌面快捷方式 + 「应用和功能」卸载项 | 设置 → 应用，或 `<安装目录>\Uninstall.cmd` |
| `BetterNCM-v3-Portable-x64.zip` | 免安装压缩包 | 自带 Node；整包解压到任意位置；数据写在包内 `data\`；**不写注册表、不装自启、不动客户端目录** | 删目录 |

两个包携带的是**同一棵运行树**（同一个 `loader\framework.js`、同一套 `tools\*.mjs`、同一批
`.plugin`），差别只有启动器和安装动作。唯一的实质差别是免安装包**不安装 `version.dll` 代理**：
它只用 CDP 通道（agent 用 `--remote-debugging-port` 启动客户端并注入）。四个插件都不依赖
进程内代理（`framework.js` 自己提供 `betterncm_native` 的 fs/app shim），所以功能完整。

## 2. 运行树内容

```
app\
  bin\node.exe            自带 Node 24（agent 需要 Node >= 21 的全局 WebSocket）
  loader\framework.js     注入页面的运行时（与仓库同一份）
  loader\manager.js       插件管理 UI
  loader\hijacks.json     页面级改写规则（默认 pending/关闭）
  loader\selectors.json   按客户端版本的选择器注册表
  loader\*.ps1            install / uninstall / startup / create-shortcut / paths
  loader\bncm-agent.vbs   无控制台启动 shim
  tools\bncm_agent.mjs    守护 + 启动器 + 注入
  tools\ncm_host.mjs      后端：fs / 配置 / 插件发现 / 管理端点
  tools\cdp_*.mjs         CDP 注入与守护
  tools\bncm_preload.js   document-start 预载
  plugins\*.plugin        随包分发的三个插件（首次启动复制进 data\plugins）
  LICENSE                 本项目许可证（GPL-3.0-or-later）
  THIRD-PARTY-NOTICES.md  第三方组件出处与许可证
  bin\NODE-LICENSE.txt    自带 Node 运行时的 MIT 授权全文（逐字节取自上游发行版）
  out\loader\version.dll  代理二进制（安装器用）
```

## 3. 路径解析不再写死

`loader/paths.ps1` 是所有入口共用的解析器，仓库与发行包走同一条代码路径：

| 问题 | 顺序 |
|---|---|
| 客户端目录 | `-NcmDir` → `%BNCM_NCM_DIR%` → `HKLM\...\WOW6432Node\Netease\cloudmusic\install_dir` → 常见路径 → 正在运行的 `cloudmusic.exe` 路径 |
| Node | `-Node` → `%BNCM_NODE%` → `<包根>\bin\node.exe` → DSH 运行时 → PATH |
| 数据目录 | `-DataDir` → `%BETTERNCM_PROFILE%` → **已存在且可写的 `C:\betterncm`** → `%LOCALAPPDATA%\BetterNCM` |

保留「已存在的 `C:\betterncm` 优先」是有意的：这台机器上已有的插件与配置不会被复制成第二份。

## 4. 安装器做什么（可还原性）

1. `robocopy` 复制运行树到安装目录；
2. `loader\install.ps1` 装 `version.dll`：**先备份原有同名文件**，写 `install-manifest.json`，
   卸载时按 SHA-256 校验「这确实是我们装的那一份」才删除（`loader\uninstall.ps1`）；
3. `loader\startup.ps1 -Install`：三个插件走同一个 `Install-BncmPlugins`（缺则装、同则跳、
   不同则**先备份到 `_backup_<时间戳>` 再覆盖**），写 HKCU 登录项（值里带
   `--ncm/--data/--plugins`，不再是编译死的默认值），启动 agent；
4. `loader\create-shortcut.ps1` 建快捷方式（快捷方式同样带解析后的目录）；
5. 写 `HKCU\...\Uninstall\BetterNCM` 与 `Uninstall.cmd`。

开关：`-NoProxy / -NoAutostart / -NoShortcut / -NoStart / -DryRun`。
`-NoProxy` 时仍会装运行树与插件，只是不碰客户端目录。

`install.cmd` 的 `%*` 会被转发给 `install.ps1`；**但 IExpress 自解压壳在收到命令行参数时不会
启动 `AppLaunched`**（实测），所以自动化的沙箱安装改用环境变量
`BNCM_SETUP_ARGS`（见 `tools/release/verify_release.ps1`），双击安装不受影响。

## 5. 构建

```powershell
# 需要：已构建的 out\loader\version.dll（loader\build.cmd）与一个 Node >= 21
powershell -NoProfile -ExecutionPolicy Bypass -File tools\release\build_release.ps1
# 输出到桌面 release\，并写 SHA256SUMS.txt

# 换输出目录 / 跳过 exe / 只验不改
... -OutDir D:\dist
... -SkipSetup
powershell -NoProfile -ExecutionPolicy Bypass -File tools\release\verify_release.ps1
```

构建时的三条硬性自检（都是踩过的坑）：

* **字节一致性**：`node.exe` / `version.dll` / 三个 `.plugin` 在暂存后必须与原文件 SHA-256 相同。
  （早期版本用 `Get-ChildItem -Include '*.ps1'` 过滤 BOM 归一化，但 `-Include` 与 `-LiteralPath`
  同用时**被静默忽略**，于是所有二进制文件被当成 UTF-8 文本重写，`node.exe` 从 89 MB 膨胀到
  130 MB 且无法运行。）
* **zip 条目名用 `/`**：`.NET Framework` 的 `ZipFile::CreateFromDirectory` 在 Windows 上写的是
  反斜杠（不符合 ZIP 规范），所以打包是手写的 `ZipArchive` 循环。
* **`.cmd` 必须是纯 ASCII**：cmd.exe 没有 BOM 约定，中文 `echo` 在任何代码页都会花屏；
  中文只出现在 `.ps1`（统一加 UTF-8 BOM，否则 PowerShell 5.1 按 GBK 解码 → 乱码）。
* **授权文件随包走**：`LICENSE`、`THIRD-PARTY-NOTICES.md` 与 Node 发行版自带的 `LICENSE`
  被复制进 `app\`（Node 那份为 `app\bin\NODE-LICENSE.txt`），且后者**跳过 BOM 归一化**——
  许可证要的是逐字节原件，多一个 BOM 就不是原件了。

## 6. 验收（28/28）

`verify_release.ps1` 全程只在临时目录里操作（唯一例外是安装器写的
`HKCU\...\Uninstall\BetterNCM`，脚本结束时删除）：

* 解压免安装包 → 自带 node 能跑（`v24.21.0`）→ 打包后的 agent `--status` 正常；
* `loader\startup.ps1 -Start -NoStart` 把三个插件种进 `data\plugins`；
* 用打包后的后端查询 `/api/plugins`：三个插件全部被发现、`locked=false`、`core` 为空、
  `LyricBar.requirements` 与 `RefinedNowPlaying.loadAfter` **确实传到了加载器**；
  `/api/selectors` 返回 `3.1.41-r1`；
* 以沙箱参数运行 `Setup.exe`：运行树、卸载器、三个插件、卸载项全部落地。

## 7. 已知限制

* 免安装包不含 `version.dll` 代理（见 §1）。
* 自解压壳无法接收命令行开关（见 §4），需要非默认安装时用环境变量。
* 安装器会**主动关闭正在运行的客户端**（代理替换要求文件未被映射），这是 `-NoProxy` 存在的原因。
* 安装器默认安装代理；若客户端目录不可写（Program Files），代理步骤会失败但**不中断**其余步骤
  （插件走 CDP 通道，功能不受影响）。
