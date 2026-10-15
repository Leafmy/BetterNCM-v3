# 21 — 插件市场

> 代码：`tools/market_host.mjs`（市场的全部逻辑）、`tools/ncm_host.mjs`（HTTP 端点）、
> `loader/manager.js`（市场页 UI）、`tools/market/build_market.py`（索引构建）、`market/`（内置源）
> 测试：`test/plugin-market.test.mjs`（85 项）、`test/manager-market.test.mjs`（29 项）

## 1. 它是什么，以及它复刻的是哪一个上游

上游 BetterNCM 的插件市场是一个**插件**（`BetterNCM/Plugin-Market`，发布名 `PluginMarket`，
最后一版 0.8.4，`hide: true` / `force-install: true`）：一个 React 应用，从几个镜像拉
`<baseURL>plugins.json`，把选中的 `.plugin` 通过 `betterncm.fs.writeFile` 写进插件目录。

本项目复刻的是它的**功能与数据契约**，但实现位置不同：市场是宿主功能，不再是插件。三条理由：

1. **它必须在插件坏掉时也能用。** 市场最常见的用途是"某个插件出问题了，我要装回旧版/卸掉它"，
   而这正是把一个插件当市场最尴尬的场景。
2. **它必须离线可用。** `market/` 就在程序旁边，内置源直接读磁盘；断网时四个自带插件照样能装。
3. **安装必须可校验。** 上游把 404 响应当作 blob 写进 `plugins/`，也没有任何摘要校验；
   这里在写盘前校验 zip 结构、manifest、slug 与 sha256，失败时插件目录**一个字节都不变**。

保真的部分（有意保留，见 §7）：索引字段与 URL 规则、多源合并顺序、`requirements` 依赖语义、
搜索语法（空格 AND 与 `author:` 前缀）、五种排序键、综合排序的新插件加成曲线、
以及"安装不会自己刷新页面，只提示需要重载/重启"。

## 2. 数据契约

索引就是上游那一份：**顶层数组**，所以本仓库的 `market/` 目录可以原样作为上游兼容源发布。

| 字段 | 必需 | 说明 |
|---|---|---|
| `slug` | 是 | 身份键：依赖、互斥、已安装状态、`loadedPlugins` 探测都靠它 |
| `name` `version` `author` | 是 | 展示与版本比较 |
| `file` | 是 | 写进插件目录的文件名（`<slug>-<version>.plugin`） |
| `file-url` | 是 | 下载路径，**含 `plugins/` 前缀**（上游约定，不写会导致 404） |
| `preview` | 否 | 相对源根目录的预览图路径 |
| `description` `repo` `author_links` `stars` `license` | 否 | 展示 |
| `publish_time` `update_time` | 否 | 排序与 NEW 角标（`publish_time` 还用于加成曲线） |
| `type` | 否 | `extension` / `theme` / `lib` / `library` / `dependency` / `framework` |
| `requirements` | 否 | 依赖的 slug 数组，安装时前序递归 |
| `loadAfter` | 否 | 只是加载顺序提示；市场把它作为**建议**列出，不会静默安装 |
| `incompatible` | 否 | 互斥 slug；聚合时自动补成双向 |
| `betterncm_version` `ncm-version-req` | 否 | 版本门槛 |
| `sha256` `size` | 本工程附加 | 安装前校验；上游会忽略这两个字段 |
| `bundled` | 本工程附加 | 是否随发行包分发 |

URL 规则与上游一致：`<baseURL>plugins.json`（请求时附带时间戳查询参）、
包在 `<baseURL><file-url>`、预览图在 `<baseURL><preview>`。

### 源

| id | 名称 | 默认 | 说明 |
|---|---|---|---|
| `builtin` | 内置（随包分发） | **启用，不可移除** | 磁盘上的 `market/`，离线、即时 |
| `bncm-v3-github` | BetterNCM-v3 市场源（主仓库） | 关闭 | 主仓库 `market/` 的在线副本，已推送可用 |
| `better-ncm-plugin-market` | BetterNCM-PluginMarket（独立源仓库） | 关闭 | <https://github.com/Leafmy/BetterNCM-PluginMarket>，与主仓库 `market/` **逐字节一致**（已实测） |
| `upstream-unpkg` | BetterNCM 官方源（Unpkg） | 关闭 | 上游镜像，约 67 个面向 2.x 的插件 |
| `upstream-github` | BetterNCM 官方源（GitHub raw） | 关闭 | 与 Unpkg 同源 |
| `upstream-microblock` | MicroBlock CDN（上游默认源） | 关闭 | 上游的默认源；本机实测已不可达（HTTP 522） |

**默认只有内置源是开着的**，这是对上游"每次打开都拉镜像"的有意反着做：内置源在本地磁盘上
（即时、离线），而每个镜像都是一次可能挂满超时的网络往返。打开面板立刻看到四个可用插件、
其余源一次点击即可启用，比"因为某个 CDN 被墙而看到转圈"要好。

网络分工也据此拆开：普通 `GET /api/market/plugins` **从不等待网络**（未拉取的源标为
`pending` 并在后台拉，拉到后页面自动补上）；只有 `?refresh=1`（用户点「刷新索引」）与
**安装**（确实需要最新列表）才允许联网等待，且索引超时 8 s、包下载超时 30 s，两者分开。

选择结果会按上游习惯镜像到 `<数据目录>\config.json` 的 `cc.microblock.pluginmarket.source`，
因为这些键有第三方插件在读。

**自定义源**需要显式解锁（对应上游那个被硬编码成 `return true` 的
`custom-source-unlocked-1` 开关，这里恢复成真的门槛）：从自定义源安装前必须先勾选「信任自定义源」。

### 合并语义

- 顺序 = 当前选中源 → 其它已启用源；**同一个 slug 先出现者胜**（与上游一致）。
- `incompatible` 只声明一侧即双向生效；互斥的另一方**已安装**时，安装按钮会被禁用并说明原因。
- 已安装但任何已启用源都不再列出的插件仍然显示，标记为「来源已不在任何已启用源」，仍可卸载。

## 3. 内置源是推导出来的，不是手写的

`market/plugins.json` 由 `tools/market/build_market.py` 从两个输入生成：

| 输入 | 内容 |
|---|---|
| `market/catalog.json` | 只能人工判断的信息：预览图、上游仓库、许可证、时间戳、stars、上架备注 |
| `plugins/*.plugin` | 真实分发的插件包 |

`name` / `version` / `slug` / `description` / `type` / `requirements` / `loadAfter` /
`incompatible` / `betterncm_version` / `ncm-version-req` 全部**从包内的 `manifest.json` 读出**，
构建时逐条比对。这样做的理由只有一条：**索引与它交付的包不一致的市场，比没有市场更糟。**
构建还会拒绝 `requirements` 指向源里不存在插件的条目，并报告 `plugins/` 里多余的包。

```powershell
py tools\market\build_market.py           # 重建 market/
py tools\market\build_market.py --check    # 校验（过期则非零退出）
```

## 4. 后端

`tools/market_host.mjs` 是独立模块，`ncm_host.mjs` 只做挂载与鉴权。

| 端点 | 说明 |
|---|---|
| `GET /api/market/sources` | 源列表、当前选择、自定义源解锁状态 |
| `GET /api/market/plugins[?refresh=1]` | 聚合索引 + 已安装/可更新/冲突等派生字段 + 每个源的成败报告 |
| `POST /api/market/install` | `{slug, version?, include_recommended?, refresh?}` → 安装依赖链 |
| `POST /api/market/settings` | 选择/启停源、增删自定义源、解锁 |
| `POST /api/market/cache/clear` | 清空索引与预览图缓存 |
| `GET /api/market/preview?slug=` | 预览图（宿主代理 + 缓存，页面只与本机通信） |

CLI：`--no-market`（整个关掉）、`--market-dir DIR`、`--market-offline`、`--market-ttl-ms N`。
`out/host.json` 里会写出 `market: {enabled, dir, offline}`，验收脚本据此判断。

缓存分层：内存（TTL，默认 10 分钟）→ `<数据目录>\market-cache\<id>.json` → 失败时回退到磁盘缓存
并在 UI 上说明"来自缓存"。**网络失败永远不是致命的**：内置源始终可用，页面照常渲染。

## 5. 安装流水线

1. **解析**：`requirements` 前序递归，依赖先装；成环直接报错（上游会无限递归），
   依赖在源里缺失则整次安装中止（不写任何文件）。
2. **取包**：内置源 = 复制 `market/` 下的文件；远程源 = 下载（15 s 超时，64 MB 上限，失败即中止）。
3. **校验**：必须是可解析的 zip、根目录有可读的 `manifest.json`、`manifest.slug` 与请求的 slug 一致、
   索引若给了 `sha256` 则必须匹配。**失败时插件目录保持原样**（测试逐一验证这一点）。
4. **落地**：先写 `<插件目录>\.bncm-tmp-<slug>.plugin`，再原子 rename；同 slug 的旧包被移动到
   `<数据目录>\_replaced\<时间戳>\`（永不删除）。
5. **主题排他**：安装 `type: theme` 的插件前，其它已装主题被移动到 `_uninstalled\`——
   两个主题抢同一批界面元素的结果是不可用的客户端。这一步放在**新包校验通过之后**，
   所以镜像在中途失败不会让用户丢掉原来的主题。
6. **通知**：返回写入了什么、跳过了什么、哪些 `loadAfter` 目标值得一并安装、是否需要重载页面；
   页面**不会**自己刷新。

卸载走既有的 `POST /api/plugins/uninstall`：移动到 `_uninstalled\<时间戳>\`，不是删除。

## 6. 前端（`loader/manager.js`）

管理面板的第三个标签（插件 / 插件市场 / 诊断）。上游的市场是 React + react-flip-toolkit + SCSS；
这里是原生 DOM + 一段命名空间 CSS，功能对齐、实现替换。

- **分类**：全部 / 扩展 / 主题 / 已安装 / 有更新（`显示“依赖库”分类` 打开后多一个「依赖库」，
  默认与上游一样把库类插件从"全部"里过滤掉）。
- **搜索**：空格分词 AND；`author:xxx` 只比作者；匹配 name/slug/author。
- **排序**：综合（`downloads + bonus`，没有统计时退化为 stars）、下载量（无统计时隐藏该按钮）、
  Star、更新时间、名称；点同一个键翻转方向；**依赖库永远排在最后**（与上游一致）。
- **卡片**：预览图（`IntersectionObserver` 懒加载，经宿主代理到 blob URL）、名称、版本、
  作者、来源、stars、描述、标签（已安装 / 可更新 / 随包分发 / NEW / 依赖 / 不兼容 / 被依赖 / 下载量）、
  动作（安装 / 更新到 x / 卸载 / 设置 / 仓库）。
- **守卫**：与已安装插件互斥时禁用「安装」并说明；被其它已安装插件 `requirements` 依赖时禁用「卸载」。
- **提示**：安装结果、每个源的成功/失败与"来自缓存"状态、以及"需要重载页面"的提示条与一键重载。

加成曲线（`bonusDownloads`）与上游逐字一致：`t` 为距 `publish_time` 的小时数，`M` 为全站最大下载量，
`t < 2160` 时 `factor = 0.15·(1 − t/2160)^6 + 0.85`，否则 `factor = 0.85·0.99^(t−2160)`，
`bonus = parseInt(factor·M)`。上游的下载量 API（`betterncm.microblock.cc`）**已经下线**
（DNS 不可解析），所以没有统计时综合排序退化为 stars——这与上游的降级路径相同。

## 7. 保真清单与有意偏离

**保留（上游契约）**：索引字段与 URL 规则；多源合并的"先到先得"；`incompatible` 双向补全；
`requirements` 前序递归、本地版本与线上版本相同则跳过；`loadAfter` 只当排序/建议；
主题排他；安装后不自动刷新而是提示重载；`native` 类插件提示"重启"而非"重载"；
搜索语法；五种排序键与库类垫底；加成曲线；`cc.microblock.pluginmarket.source` 这个配置键。

**偏离（有理由的改进）**：
| 上游行为 | 这里 | 理由 |
|---|---|---|
| 二进制下到页面再由页面写盘（`fs.writeFile` 收到 Blob 会写 0 字节） | 宿主下载、校验、原子落地 | 页面只跟本机通信，也绕开了 CORS 与半截文件 |
| 安装无 `try/catch`，失败永久转圈 | 失败返回错误并显示 | 用户需要知道发生了什么 |
| 依赖成环无限递归 | 报错 | 挂死比报错糟 |
| 无摘要校验、404 也写盘 | zip/manifest/slug/sha256 四道校验 | 保住用户手上能用的那份 |
| 卸载真删文件 | 移动到 `_uninstalled\` | 与项目其余部分一致的可逆性 |
| 自定义源解锁开关被硬编码为已解锁 | 恢复成真的门槛 | 未解锁的源不应能写可执行脚本 |
| 每次打开都全量拉取 | 内存 + 磁盘缓存，可强制刷新 | 打开面板不该依赖镜像的响应速度 |

**上游已知 bug 一律不复刻**：`getBaseURL()` 里失效的 `?? sources[0]`、依赖缺失文案里的 `undefined`、
`getDependencies` 的死代码、`addCustomSource(url, position)` 里未定义的 `newSource`、
`getPluginDownloads()` 缺 `.catch`、远端 `sources.json` 里 Unpkg 条目多写了 `plugins.json`、
`#pri-skin-gride` 的拼写错误。它们只是实现瑕疵，不是契约。

## 8. 随市场自带的四个插件

| 插件 | 来源 | 许可证 |
|---|---|---|
| `LyricBar` 0.3.6 | solstice23（再分发，只改清单） | MIT |
| `MaterialYouTheme` v1.0.4 | long45343（再分发，slug 归一化） | GPL-3.0 |
| `RefinedNowPlaying` 3.0.2 | SUlTlUS 续作（再分发，slug 固定为 `RefinedNowPlaying`） | MIT |
| `NCM-Font-Manager` 0.1.3 | **本项目自研**（非上游再分发） | GPL-3.0-or-later |

市场里的包与 `plugins/*.plugin` **同一份字节**（构建时逐字节校验），发行包同时携带两者：
`plugins\` 是安装时种子目录，`market\` 是市场源。Font Manager 的源码在
`plugins/src/NCM-Font-Manager/`（`index.js` 未压缩），来源与配套回归脚本的现状见
该目录的 `NOTICE.md`。

## 9. 验收

```powershell
node test\plugin-market.test.mjs      # 85 项：内置源、校验、依赖/成环、更新、主题排他、源信任、可逆卸载
node test\manager-market.test.mjs     # 29 项：市场页的分类/搜索/排序/按钮守卫（假 DOM）
py tools\market\build_market.py --check
powershell -NoProfile -ExecutionPolicy Bypass -File tools\release\verify_release.ps1
```

`verify_release.ps1` 里与市场有关的新断言：内置索引与四个包/预览图都在包内；
打包后的后端能给出内置源（`ok`、4 条）与四个 bundled 条目、并认出已种下的插件；
Font Manager 条目的 `sha256` 形状正确；安装器落地后 `app\market\plugins.json` 存在。

需要客户端的端到端验证（打开面板 → 插件市场 → 安装 → 重载）：

```powershell
loader\launch.cmd -Duration 60 -Force
node tools\cdp_inject.mjs --expr "JSON.stringify(window.__BNCM_MANAGER__ && true)"
```

## 10. 已知限制

- **`loadAfter` 不会自动安装**：它按上游语义只当顺序提示，市场只把它列成建议。
  想一次装好 `LyricBar` 的完整依赖链，可以点安装后再按提示装 `MaterialYouTheme`，
  或用 `POST /api/market/install {slug, include_recommended:true}`。
- **纯前端源的下载量统计**依赖索引里带 `downloads` 字段；上游那个统计服务已下线，
  本项目不自建上报（也避免像上游那样把用户 ID 发出去）。
- **自定义源只有"信任/不信任"两档**：没有上游那种 Konami 彩蛋式的解锁入口。
- **本机 `bncm-plugin.microblock.cc` 与上游下载量 API 均已不可达**，因此默认只启用内置源；
  上游镜像、主仓库的 GitHub 源与独立源仓库都保留在源列表里，一键即可启用。
- **本机对 `raw.githubusercontent.com` 与 `cdn.jsdelivr.net` 的直连被阻断**（走系统代理才通），
  而客户端后端的 Node `fetch` 不走系统代理，所以三个 GitHub 类源在这台机器上会一直
  「正在后台读取」。这是网络环境问题，不是索引问题：同一份内容用代理取回后与本地
  `market/` 逐字节相同（`plugins.json` `23e2c82a…`、Font Manager 包 `de71a3cc…`）。
