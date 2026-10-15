# 02 — 资源包格式（NTPK / 签名 web pack）

> 目标构建：`3.1.41.205529`。工具：`tools/ntpk.py`（纯标准库）。
> 所有格式结论均已在本机文件上用 `tools/ntpk.py` **实测**通过。

网易云的资源包分为**两族**，此前常被混为一谈。

---

## 族 A —— 签名 web pack

**文件**：`E:\CloudMusic\package\orpheus.ntpk`、`%LOCALAPPDATA%\Netease\CloudMusic\web.pack`

```
偏移        长度   内容
[  0:  4]   4      ASCII 十进制版本标记，值为 3（字面 b"0003"）
[  4: 36]  32      ASCII hex 元数据（跨构建**恒定**：67dfa02516200b5f925155f0becd1849）
[ 36:100]  64      RSA-512 / PKCS#1 v1.5 签名，被签数据 = data[100:]
[100:   ]   ?      明文 ZIP
```

### 实测校验结果

```
orpheus.ntpk  version=3  concat=100  signature OK (rsa-512/sha1)  1408 entries  COMMITHASH=c6406e5
web.pack      version=3  concat=100  signature OK (rsa-512/sha1)  1411 entries  COMMITHASH=477f8a2
```

`tools/ntpk.py verify` 用公钥做纯 Python 的 `pow(sig, e, n)` + PKCS#1 v1.5 解填充 + SHA-1 比对，
在两份文件上均返回 OK。**这同时证明了**：头部布局、签名算法（RSA-512 + SHA1）、公钥、
以及 `concat = 100` 的几何关系。

公钥（DER SubjectPublicKeyInfo，来自 `YUCLing/open-orpheus`，MIT）：

```
305c300d06092a864886f70d0101010500034b003048024100
b057e5f79eaca212f43cc51de0da2349d13b0ac7de87eb52
da23096f0b1594cab08f87ff1a6a05808046a67e359b902f
8982a1ad987a83ae62246dd3b64ee6f50203010001
```

### 关键几何：`concat`

ZIP 中央目录在记录 `cd_offset` 时，其值**相对于去掉 100 字节头之后的正文**：

```
EOCD 位置 37938988 - cd_size 158943 - cd_offset 37779945 = 100
```

Python 的 `zipfile` 会自行计算该 `concat` 偏移，因此 `zipfile.ZipFile(path)` 可直接读取族 A 文件。

### 重打包的正确做法

**先构建独立 ZIP（偏移相对于 0），再前置 100 字节头**。这样记录的偏移天然相对正文，
与原始文件几何完全一致。

`tools/ntpk.py pack --template <原文件>` 即按此实现。实测：

```
orig entries 1408 / rebuilt entries 1408    missing: []   extra: []
orig concat 100  / rebuilt concat 100
COMMITHASH preserved
rebuilt signature: False   <- 预期：正文变了，签名必然失效
```

### **签名不可绕过（本方案的路线约束）**

签名覆盖整个正文，且为 SHA-1 + RSA-512，**无私钥无法重新签名**。
因此：**任何对族 A 包正文的修改都会导致客户端 `appInit/verifyFile` 阶段校验失败**
（对应 `cloudmusic.dll` 中的 `[boot] Verify ntpk failed.` / `NTPKHelper check ntpk`）。

→ 本方案**不改族 A 包**，走运行期注入。`tools/ntpk.py pack` 仅用于分析/取证，
其输出**不可用于投放**。

> 历史注记：2018 年的 NCM 2.3.0 使用**不同**的容器（16 字节头 + 256 字节 RSA-2048 签名 + **加密** ZIP），
> 并且社区记录过"替换 `cloudmusic.dll` 内嵌公钥（文件偏移 `0x7C3438`）后重签名"的做法。
> 3.1.41 已改为 100 字节头 + RSA-512 + 明文 ZIP，攻击面不同。

---

## 族 B —— NTPK 容器

**文件**：`package/native.ntpk`、`package/common.skin`、`package/dark.skin`

```
偏移        长度   内容
[  0:  4]   4      b"NTPK"
[  4:  8]   4      uint32 LE 版本/标志（=0）
[  8: 12]   4      uint32 LE 载荷长度（= 文件长度 - 272）
[ 12: 16]   4      uint32 LE 头部长度（= 0x100 = 256）
[ 16:272] 256      头部 blob（不透明）
[272:   ]   ?      ZIP
```

### 实测

| 文件 | 载荷长度 | 长度自洽 | 条目数 | 加密条目 |
|---|---:|:---:|---:|---:|
| `native.ntpk` | 507 | ✔ | 2（`start.html`, `version.dat`） | 2（全部） |
| `common.skin` | 1,213,401 | ✔ | 258 | 244 |
| `dark.skin` | 1,218,666 | ✔ | 259 | 245 |

族 B 的 ZIP 条目使用 **ZipCrypto** 加密（local header 的 general-purpose flag bit0 = 1）。
`native.ntpk` 的两个条目**全部加密且密码未知** → 当前**无法解出**，在 `tools/ntpk.py` 中记为
"跳过（需要密码）"，不阻塞加载器路线。

未加密的少数条目（`common.skin` 中 14 个）为目录条目。

---

## 两个包的关系

| | `orpheus.ntpk`（安装目录） | `web.pack`（用户数据目录） |
|---|---|---|
| `pub/COMMITHASH` | `c6406e5` | `477f8a2` |
| `pub/VERSION` | `patch-pc-1` | `patch-pc-1` |
| 条目数 | 1408 | 1411 |
| 修改时间 | 2026-09-18 | 2026-09-25 |

两者都是族 A、签名均有效，但 `chunk` 文件名前缀（`c6406e5` vs `477f8a2`）与 `styles/` 哈希完全不同
→ 是**两次不同的前端构建**。`web.pack` 位于用户数据目录、时间更晚、条目更多，因此
**[推断]** 它是运行期通过 `ResourceDownloadCEF::DoCheckMd5AndUnzip` 下载并替换的较新前端包，
优先于安装包内的 `orpheus.ntpk`。

对方案的含义：**前端包会独立于客户端安装包自动更新**，所以任何依赖"包内容固定"的做法都会失效；
运行期注入（本方案）不受影响。该结论同时说明为何 `docs/05-compat-matrix.md` 需要记录每次包哈希。

---

## 工具用法

```powershell
py tools\ntpk.py info    "E:\CloudMusic\package\orpheus.ntpk"
py tools\ntpk.py list    "E:\CloudMusic\package\common.skin"
py tools\ntpk.py verify  "C:\Users\<user>\AppData\Local\Netease\CloudMusic\web.pack"
py tools\ntpk.py extract "E:\CloudMusic\package\orpheus.ntpk" --out out\orpheus
py tools\ntpk.py pack    out\orpheus -o out\repacked.ntpk --template "E:\CloudMusic\package\orpheus.ntpk"
py tools\ntpk.py diff    "E:\CloudMusic\package\orpheus.ntpk" "…\web.pack"
```

工具永远只读源文件；输出一律写到调用方指定位置（默认 `out/`）。
