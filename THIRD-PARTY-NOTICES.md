# 第三方组件与出处

本仓库以 **GPL-3.0-or-later** 发布（全文见 `LICENSE`）。原因是它实现了上游
`std-microblock/chromatic` **v2 分支**（GPL-3.0-or-later）的插件 API 契约与加载器语义，
属于该作品的派生作品；上游 `master` 分支**没有 LICENSE**，本项目不使用、不分发它。

## 1. 代码与插件

| 组件 | 版本 / 提交 | 作者 | 许可证 | 在本仓库中的位置 |
|---|---|---|---|---|
| BetterNCM v2 (`std-microblock/chromatic`) | `v2` @ `1b7eb7f` | MicroCBer 及贡献者 | **GPL-3.0-or-later** | 插件 API 契约、加载器语义与对照基准；参考副本在 `upstream/chromatic`（**不随发行包分发**） |
| LyricBar | 0.3.6 | [solstice23](https://github.com/solstice23) | **MIT** | `plugins/LyricBar.plugin`、`plugins/src/LyricBar` |
| Material You Theme (NCMv3) | v1.0.4 | [long45343](https://github.com/long45343) | **GPL-3.0** | `plugins/MaterialYouTheme.plugin`、`plugins/src/MaterialYouTheme` |
| RefinedNowPlaying（= 上游 `RefinedNowPlayingNext` 3.0.2） | 3.0.2 | SUlTlUS / MiHN / solstice23 谱系 | **MIT** | `plugins/RefinedNowPlaying.plugin`、`plugins/src/RefinedNowPlaying` |

出处链接：

* LyricBar — <https://github.com/solstice23/lyric-bar-netease>
* Material You Theme (NCMv3) — <https://github.com/long45343/material-you-theme-NCMv3>
  （上溯 <https://github.com/solstice23/material-you-theme-netease>，GPL-3.0，已停止维护）
* RefinedNowPlaying Next — <https://github.com/SUlTlUS/refined-now-playing-netease-next>
  （替代 <https://github.com/solstice23/refined-now-playing-netease> 2.19.5）
* BetterNCM v2 — <https://github.com/std-microblock/chromatic/tree/v2>

`MaterialYouTheme.plugin` 的 bundle 内还包含两层第三方代码，授权横幅已随包保留，
可见 `plugins/src/MaterialYouTheme/main.js.LICENSE.txt`：

* Google Material Components for the Web — Apache-2.0（Copyright 2021–2023 Google LLC）
* `regenerator-runtime` — MIT（Copyright 2014–present, Facebook, Inc.）

### 仓库内保留的原始归档与溯源素材（**不随发行包分发**）

`build_release.ps1` 只把上表列出的四个 `.plugin` 放进发行包；下列目录仅存在于仓库中，
用于对照与溯源：

| 目录 | 内容 | 出处 | 许可证 |
|---|---|---|---|
| `plugins/_upstream/` | 四个原始 `.plugin` 归档（LyricBar 0.3.6、Material You NCMv3 v1.0.4、RefinedNowPlaying 2.19.5、RefinedNowPlayingNext 3.0.2） | 三个上游插件仓库 | 分别同其上游：MIT / GPL-3.0 / MIT / MIT |
| `plugins/_attic/material-you-theme-netease-2x/` | solstice23 原版 Material You 主题 **2.9.0** 源码（自带其 LICENSE） | <https://github.com/solstice23/material-you-theme-netease> | **GPL-3.0** |
| `plugins/_attic/material3-theme-layer/` | 本项目自研的 Material 3 层（`docs/12`、`docs/13` 的溯源素材） | 本项目 | GPL-3.0-or-later |

## 2. 发行包中捆绑的二进制

两个发行包（`BetterNCM-v3-Portable-x64.zip`、`BetterNCM-v3-Setup-x64.exe`）额外携带：

| 组件 | 版本 | 许可证 | 包内位置 |
|---|---|---|---|
| Node.js 运行时 | v24.21.0 | **MIT**（并含 V8 / OpenSSL / ICU 等捆绑依赖的授权文本） | `app/bin/node.exe` 与 `app/bin/NODE-LICENSE.txt` |
| `version.dll` 代理 | 本项目构建 | GPL-3.0-or-later | `app/out/loader/version.dll`；源码在 `loader/version_proxy/`（`loader/build.cmd` 需要 MSVC 工具链） |

发行包同时携带本仓库的 `LICENSE` 与 `THIRD-PARTY-NOTICES.md`。

## 3. 明确不包含的内容

以下内容只存在于本地开发检出中，**不提交、不分发**（见 `.gitignore`）：

* `out/orpheus/`、`out/repacked.ntpk` — 从网易云音乐客户端 `web.pack` / `orpheus.ntpk`
  抽取或重打包的**版权资源**，仅在本地做逆向分析用；
* `out/agent.log`、`out/host.json`、`out/agent.lock` — 本机运行态数据（`host.json` 含后端 API key）；
* `upstream/` 下的克隆 — 上游参考副本，按 `upstream/README.md` 的地址自行获取。

本项目不分发客户端本体、音源、皮肤或任何账号凭证，也不修改客户端带 RSA-512/SHA1
签名的 `orpheus.ntpk` / `web.pack` / `*.skin`。
