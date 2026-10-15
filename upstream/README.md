# upstream/ — 参考副本（不参与本项目构建，也不随发行包分发）

这里的每个子目录都是一次独立的 `git clone`，各自带自己的 `.git` 与 upstream 远端，
因此**不提交进本仓库**（见根目录 `.gitignore`）。它们只作对照基准：读上游实现、
比对插件 API 契约、核对历史结论。需要时按下表重新拉取。

| 目录 | 远端 | 分支 | 本检出所在提交 |
|---|---|---|---|
| `chromatic/` | <https://github.com/std-microblock/chromatic.git> | `v2` | `1b7eb7f` |
| `installer/` | <https://github.com/std-microblock/BetterNCM-Installer.git> | `main` | `6fbf21b` |
| `jsf/` | <https://github.com/BetterNCM/js-framework.git> | `master` | `44b4df2` |
| `wiki/` | <https://github.com/std-microblock/chromatic.wiki.git> | `master` | `99d3e19` |

```powershell
git clone --branch v2 https://github.com/std-microblock/chromatic.git upstream\chromatic
git clone https://github.com/std-microblock/BetterNCM-Installer.git upstream\installer
git clone https://github.com/BetterNCM/js-framework.git upstream\jsf
git clone https://github.com/std-microblock/chromatic.wiki.git upstream\wiki
```

## 两条必须记住的授权事实

1. **只有 `v2` 分支能用。** `master` 分支**没有 LICENSE 文件**，因此本项目不分发、也不基于
   `master` 做任何派生（README「边界与不做的事」§条 3）。
2. **`v2` 分支是 GPL-3.0-or-later。** 本项目实现它的插件 API 契约与加载器语义，属于派生作品，
   因此整体以 GPL-3.0-or-later 发布，全文见根目录 `LICENSE`，各组件的出处见
   `THIRD-PARTY-NOTICES.md`。

## 另有一份不在本目录的参考副本

`out/libcef-try/` 是 <https://gitee.com/MicroCBer/libcef> 的克隆，用于评估把注入搬进
`version.dll` 载荷（在渲染进程内 hook libcef）的可行性。它同样不提交、不分发，
`out/` 下的大件与运行态文件一律被 `.gitignore` 排除。
