# BetterNCM v3 插件市场源

这个目录**本身就是一个插件市场源**，它既能被本项目的插件市场读取（作为随包分发的「内置源」），
也可以原样推送到一个独立仓库（例如 `Leafmy/BetterNCM-v3` 的 `main` 分支，或任何静态托管），
被在线源读取——包括**原版 BetterNCM 的插件市场插件**，因为这里的索引格式与上游完全一致。

```
market/
  plugins.json     索引：顶层数组，上游契约 + 少量附加字段（见下）
  market.json      源元数据（本项目的市场用它显示源信息，上游会忽略）
  plugins/         插件包，命名 <slug>-<version>.plugin
  previews/        预览图（SVG），索引的 preview 字段指向这里
  catalog.json     索引的**人工维护输入**（审阅信息），plugins.json 由它生成
```

## 索引契约

`plugins.json` 是顶层数组，每个元素的字段：

| 字段 | 来源 | 说明 |
|---|---|---|
| `name` `version` `author` `description` `type` `slugs` | 包内 `manifest.json` | 由构建脚本读出，**不允许**与包不一致 |
| `requirements` `loadAfter` `incompatible` | 包内 `manifest.json` | 依赖与互斥（互斥会被消费方自动补成双向） |
| `betterncm_version` `ncm-version-req` | 包内 `manifest.json` | 版本门槛 |
| `publish_time` `update_time` `stars` `repo` `author_links` `license` | `catalog.json` | 展示与排序用 |
| `preview` | `catalog.json` | 相对本目录的路径，如 `previews/LyricBar.svg` |
| `file` | 构建脚本 | 包文件名，如 `LyricBar-0.3.6.plugin` |
| `file-url` | 构建脚本 | 相对下载路径，**含 `plugins/` 前缀**（上游约定） |
| `sha256` `size` | 构建脚本 | 包的真实摘要与字节数，安装前会被校验 |
| `bundled` | `catalog.json` | 是否随发行包分发 |
| `notes` | `catalog.json` | 上架备注（来源、改动、坑） |

消费方的 URL 规则与上游一致：索引在 `<baseURL>/plugins.json`，包在 `<baseURL>/<file-url>`，
预览图在 `<baseURL>/<preview>`。

## 重建与校验

`plugins.json` **不是手写的**——它是从 `catalog.json`（审阅信息）与 `plugins/*.plugin`（真实包）
推导出来的。这样做的原因是：一个索引与它交付的包不一致的市场，比没有市场更糟。

```powershell
py tools\market\build_market.py           # 重建 market/（复制包、算 sha256、写索引）
py tools\market\build_market.py --check    # 只校验；market/ 过期则非零退出
```

构建时的硬校验：

- 每个条目的 `slug` / `version` / `name` 必须与包内 `manifest.json` 一致；
- `manifest_version` 必须是 `1`，`requirements` / `loadAfter` 指向的 slug 必须也在这个源里；
- `preview` 必须存在且位于 `previews/` 下；
- `--check` 还会报告 `plugins/` 里多出来的、索引不再引用的包。

## 上架准则（沿用上游标准）

以下要求取自上游 wiki《插件商店上架插件方式及准则》，本目录同样执行：

1. **唯一的名称与 ID**：`slug` 全局不冲突，且一旦发布不再更改（跨插件探测依赖它）。
2. **一张预览图**：`previews/<slug>.svg|png|webp`，尺寸尽量小。
3. **必须开源**：任何引用了 BetterNCM 源码的插件都必须公开源码，且提交的包能由该源码构建得到。
4. **只放运行需要的文件**：包内只有 `manifest.json` 与 `injects` 引用的文件；
   该仓库用 `py tools\pack_plugin.py <源码目录> -o plugins --runtime-only` 保证这一点。
5. **标注来源**：仓库链接、作者、支持的 BetterNCM 版本；若是他人插件的 fork，在 `manifest` 里标 `fork_of`。
6. **尽量不冲突**：能只用 CSS 就不用 JS，能加自己的元素就不要删改客户端原有节点。

本源的四个条目各自满足以上条件，并在 `notes` 里记录了对上游做过的最小改动。

## 发布成一个在线源

`market/` 是自包含的：把整个目录放到任何能提供静态文件的地址即可（GitHub raw、jsDelivr、
`unpkg`、对象存储都行）。注意 URL 规则要求 `<baseURL>/plugins.json` 直接可访问，所以：

| 托管方式 | baseURL |
|---|---|
| 仓库子目录（GitHub raw） | `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/market/` |
| 仓库根目录 | `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/` |
| jsDelivr（有 CDN 缓存） | `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/market/` |

**已经这样发布过了**：<https://github.com/Leafmy/BetterNCM-PluginMarket> 是本目录的独立副本，
baseURL 为 `https://raw.githubusercontent.com/Leafmy/BetterNCM-PluginMarket/main/`
（已实测与主仓库的 `market/` 逐字节一致）。市场的默认源列表里两条都在
（`tools/market_host.mjs` 的 `DEFAULT_SOURCES`），默认关闭，一键启用。

> 这台机器上 `raw.githubusercontent.com` 与 `cdn.jsdelivr.net` 的**直连被阻断**，客户端后端的
> Node `fetch` 又不走系统代理，所以在本机这两个源会一直「正在后台读取」。换一个可达的托管
> （Gitee 镜像、对象存储）或给 Node 配代理即可。

推送到别的仓库时，**不要**把 `plugins/`、`tools/`、发行包一起带过去：源只需要
`plugins.json`、`plugins/`、`previews/`（`catalog.json` 与 `market.json` 可选）。

```powershell
# 同步到已建好的源仓库（Leafmy/BetterNCM-PluginMarket）：
# 只带源需要的四样，README 用源仓库自己的那一份
$out = "$env:TEMP\bncm-market-sync"
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item market\plugins.json,market\market.json,market\catalog.json $out
Copy-Item market\plugins,market\previews $out -Recurse
git -C $out init -b main
git -C $out remote add origin git@github.com:Leafmy/BetterNCM-PluginMarket.git
# 先把源仓库的 README 取回来，再提交，避免用主仓库这份覆盖它
git -C $out fetch origin main; git -C $out checkout origin/main -- README.md
git -C $out add -A; git -C $out -c user.name=... -c user.email=... commit -m "sync market source"
git -C $out push origin HEAD:main
```

推送后，在插件市场的「源设置」里把该地址添加为自定义源并解锁，或者把它改成默认启用源
（`tools/market_host.mjs` 的 `DEFAULT_SOURCES`）。
