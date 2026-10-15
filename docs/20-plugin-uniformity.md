# 20 — 三个第三方插件的「唯一兼容性」核查

> 问题：目前的三个第三方插件（LyricBar / MaterialYouTheme / RefinedNowPlaying）是否以
> **同一套机制**被 BNCM 识别与管理？有没有哪一个是特例？
>
> 结论：**识别、门禁、管理三件事上确实是唯一路径，没有任何插件被特判**；但核查中发现
> **依赖顺序这条契约被静默丢掉**，已修复并补了端到端回归测试；分发路径上也修掉了一处不对称。
>
> 复现：`node tools/release/order-check.mjs`、`node test/host-scale.test.mjs`、
> `powershell -File tools/release/verify_release.ps1`

## 1. 被核查的对象

| 文件 | slug | 版本 | `ncm-version-req` | `ncm3-compatible` | 声明的顺序边 | 来源 |
|---|---|---|---|---|---|---|
| `LyricBar.plugin` | `LyricBar` | 0.3.6 | 未声明 → 默认 `> 2.10.2` | `true` | `loadAfter` + `requirements`: `RefinedNowPlaying` | MIT · solstice23 |
| `MaterialYouTheme.plugin` | `MaterialYouTheme` | `v1.0.4` | 未声明 → 默认 `> 2.10.2` | `true` | — | GPL-3.0 · long45343 |
| `RefinedNowPlaying.plugin` | `RefinedNowPlaying` | 3.0.2 | `> 3.1.11` | `true` | `loadAfter`: `MaterialYouTheme`；`incompatible`: `Apple-Musiclike-lyrics` | MIT · SUlTlUS 续作 |

`docs/09` 画的依赖链是 `MaterialYouTheme ←(loadAfter)← RefinedNowPlaying ←(requirements/loadAfter)← LyricBar`，
这条链是否真的被执行，正是本次核查的重点。

## 2. 识别与管理：唯一路径（✅ 实测）

三个插件走的是**同一条函数链**，没有任何分支按插件名或来源区分：

```
scanPlugins(dir)                      目录里的 *.plugin（zip）与解包目录一视同仁
  └─ readZipArchive(manifest.json)
      └─ normaliseManifest(m, slug)   统一字段规范化
          └─ discoverAll(o)           统一打标：core / locked / disabled
              └─ GET /api/plugins     ← framework.js loadAllPlugins() 唯一入口
```

实测（本机后端，`--plugins C:\betterncm\plugins`，`--core-plugins` 未传）：

| slug | kind | core | locked | lock_reason | error |
|---|---|---|---|---|---|
| LyricBar | zip | false | false | null | null |
| MaterialYouTheme | zip | false | false | null | null |
| RefinedNowPlaying | zip | false | false | null | null |

`core` 列表为空（`DEFAULT_CORE_PLUGINS = null`，仓库里也没有 `plugins/core`），因此
`POST /api/plugins/{disable,enable,uninstall}` 对三个插件一视同仁；管理 UI 里**没有任何锁定徽章**，
三个都能启用/禁用/卸载。

门禁也是同一个：

* 三态 `ncm3-compatible`：三个都声明 `true`，因此都通过；实现只在**显式 `false`** 时跳过
  （上游会把「未声明」也当不可用，实测会静默禁掉 77% 的插件生态）。
* 版本门禁：三个的 `ncm-version-req` 在 3.1.41.205529 上都满足；客户端版本取不到时**失败开放**
  并标记 `ncm_version_unverified`，不会变成"悄悄不加载"。

## 3. 缺陷 1：依赖顺序元数据被丢弃（❌→✅ 已修复）

**位置**：`tools/ncm_host.mjs` 的 `normaliseManifest()`。

**因果链**：`framework.js` 的 `orderPlugins()` 按 `manifest.loadAfter` / `manifest.requirements`
做拓扑式 DFS；它读的 `manifest` 来自 `GET /api/plugins`，也就是 `normaliseManifest()` 的产物。
而 `normaliseManifest()` 是**用固定 key 列表重建 manifest**的，那两个字段不在列表里，于是：

* 页面拿到的是"没有依赖声明"的插件集合；
* 排序退化成目录名的字典序（`readdirSync().sort()`）；
* 文档里那条链自然就不成立了。

**实测**（`node tools/release/order-check.mjs <plugins 目录>`，输入就是随包分发的那三个真实 `.plugin` 归档）：

```
discovery order        : LyricBar -> MaterialYouTheme -> RefinedNowPlaying
declared edges         : LyricBar after RefinedNowPlaying, LyricBar after RefinedNowPlaying,
                         RefinedNowPlaying after MaterialYouTheme
order BEFORE the fix   : LyricBar -> MaterialYouTheme -> RefinedNowPlaying
order AFTER the fix    : MaterialYouTheme -> RefinedNowPlaying -> LyricBar
```

即：**声明了 `requirements: ["RefinedNowPlaying"]` 的 LyricBar 反而最先加载**，排在它依赖的插件之前。

**为什么原有测试没抓到**：`test/loader-scale.test.mjs` 的 harness **直接伪造** `/api/plugins`
响应（`userEntry('A', { manifest: { loadAfter: ['B'] } })`），字段永远都在，测的是
`orderPlugins()` 本身；只有一条经过 `discoverPlugins()`/`normaliseManifest()` 的用例才看得见丢失。

**修复**：`loadAfter` / `requirements` / `incompatible` 原样透传（空数组而非 `undefined`，
调用方的 `|| []` 与 `Array.isArray` 都能安全处理）。

**回归测试**：`test/host-scale.test.mjs` 新增第 10 节，走
「真实 zip → scanPlugins → normaliseManifest → HTTP」全链路，断言三个字段存活、
且没有声明顺序的插件拿到的是空数组。套件从 **34 → 39 项全通过**。

## 4. 缺陷 2：分发路径不对称（❌→✅ 已修复）

`loader/startup.ps1` 以前只做一件事：

```powershell
Install-Plugin (Join-Path $root 'plugins\LyricBar.plugin')
```

也就是说当时只有一个插件会被装进用户插件目录，其余都要靠手工复制——
"同样方式识别与管理"在**安装**这一环并不成立。

现在三个走同一个 `Install-BncmPlugins`（`loader/paths.ps1`）：

* 目标缺失 → 复制；
* 字节相同 → 跳过；
* 字节不同 → **先把用户那一份备份到 `_backup_<时间戳>\` 再覆盖**（`plugins\` 是用户目录，
  更新发行包不该毁掉用户改过的插件）；
* 名单是显式的三个（`$BncmDistPlugins`），所以仓库里的三个测试夹具
  （`bncm-selftest` / `broken-plugin` / `incompatible-plugin`）永远不会被装给用户。

一键安装包与免安装包都调用这一段，安装结果一致（`verify_release.ps1` 两者都断言三个 `.plugin` 到位）。

## 5. 核查中一并发现的其它问题

| # | 问题 | 影响 | 处理 |
|---|---|---|---|
| a | `loader/selectors.json` **在仓库里缺失**，但 `tools/ncm_host.mjs`、`loader/framework.js`、README、`docs/08` 都引用它 | `/api/selectors` 永远返回空 → framework 静默退回内置兜底，且"前端包更新只改数据不改代码"的设计无法落地 | 按 `framework.js` 的 `SELECTOR_FALLBACK` 重建（内容与兜底逐字一致，无新断言），标注 provenance；`/api/selectors` 现在返回 `3.1.41-r1` |
| b | `.ps1` 里写了 C 风格块注释 `/* … */`（`loader/uninstall.ps1` 原有；`paths.ps1` 初稿同错） | PowerShell 不支持块注释，这行会被当成命令；它恰好位于 `catch` 体内，**只在真正需要兜底时才抛错**（注册表第一个不存在的键就会触发），表现为"找不到客户端目录" | 全部改为空 `catch { }` |
| c | 含中文的 `.ps1` 未加 UTF-8 BOM（`create-shortcut.ps1`、`launch.ps1`） | PowerShell 5.1 对无 BOM 文件按 ANSI(GBK) 解码 → 中文乱码，`create-shortcut.ps1` 的快捷方式名会花 | 加 BOM；构建器对 payload 内所有 `.ps1`/`.txt` **强制** BOM，并对二进制文件拒绝重编码 |
| d | **前端包已更新**：`web.pack` COMMITHASH 由 `477f8a2` → `83304b1` | `test/preload-engine.test.mjs` 的漂移守卫当时报 2 项失败（**62/64**），提示 hijack 规则的出处已过期 | 已按 `docs/11` §9 的**离线**流程重新复核并更新 `derived_from_pack`（两条片段仍分别命中 2 次 / 1 次），守卫现 **64/64**；hijack 仍默认 `pending`/关闭，三个插件都不依赖它 |
| e | `incompatible`（RNP 声明 `Apple-Musiclike-lyrics`）此前被丢弃 | 契约丢失；该插件不在当前集合里，暂无可观测影响 | 现在会带到加载器，但 **加载器尚未消费它**——属于"声明保真、暂不执行"，文档如实标注 |

## 6. manifest 字段：谁声明、谁消费

| 字段 | LyricBar | MYT | RNP | 加载器是否消费 |
|---|---|---|---|---|
| `manifest_version` | 1 | 1 | 1 | ✅ 必须是 1，否则跳过 |
| `slug` | ✅ | ✅ | ✅ | ✅ `loadedPlugins.<slug>` 探测、依赖匹配、管理端点 |
| `ncm3-compatible` | `true` | `true` | `true` | ✅ 三态门禁 |
| `ncm-version-req` | — | — | `> 3.1.11` | ✅ 版本门禁（失败开放） |
| `loadAfter` / `requirements` | ✅ | — | ✅ | ✅ 修复后真正参与排序 |
| `incompatible` | — | — | ✅ | ⚠️ 透传但未消费 |
| `injects.Main` | ✅ | ✅ | ✅ | ✅ 脚本清单 |
| `hijacks` | — | — | ✅（2 条，均 `pending`） | ✅ 预载聚合（默认不拦截） |
| `betterncm_version` | `>=1.0.0` | `>=1.3.4` | `>=1.0.0` | ❌ 不检查（本项目未实现该门禁） |

`MaterialYouTheme` 的 `version` 写成 `"v1.0.4"`（带 `v`）：加载器不用插件版本做门禁，
RNP 的设置页只把它当显示字符串，因此**无功能影响**，保留上游原样。

## 7. 复现值

```powershell
# 顺序：修复前/后对照（读真实 .plugin）
node tools\release\order-check.mjs

# 归一化：真实 zip → HTTP 的回归测试
node test\host-scale.test.mjs          # 39 passed, 0 failed
node test\loader-scale.test.mjs        # 33 passed, 0 failed

# 两个发行包里的三个插件是否同样被识别、同样无锁定
powershell -NoProfile -ExecutionPolicy Bypass -File tools\release\verify_release.ps1

# 后端亲自回答（客户端不必运行）
node tools\ncm_host.mjs --port 0 --data "%TEMP%\bncm-check" --plugins C:\betterncm\plugins
# 然后 GET /api/plugins ：三个都是 core=false / locked=false，且 loadAfter/requirements 在位
```
