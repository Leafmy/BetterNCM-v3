BetterNCM(v3) 免安装包 - Portable
================================

适用：网易云音乐 3.1.41.205529（Orpheus / CEF 91）

本包是「免安装」的：不动注册表、不写开始菜单、不装自启，整个目录可直接放在任意位置
（U 盘、桌面、D 盘都行），删除目录即卸载。

不含 version.dll 代理
---------------------
免安装包只用 CDP 通道（agent 用 --remote-debugging-port 启动客户端并注入），不向客户端
安装目录写任何文件。本仓库的四个插件都不依赖进程内的原生代理，所以功能完整。
需要原生通道（native_plugin / fs.mountFile 这类）时请用一键安装包。


使用方法
--------
1. 解压整个文件夹（不要只解压里面的文件）。
2. 双击 Start.cmd。
   - 会自动找到网易云音乐的安装目录（读注册表 HKLM\...\Netease\cloudmusic\install_dir，
     再退回常见路径；找不到时用 Start.cmd -NcmDir "D:\CloudMusic" 指定）。
   - 会用调试端口启动客户端并注入框架，插件随客户端一起加载。
   - 插件的配置数据和日志都在本目录的 data\ 里，删掉目录就干净了。
3. Status.cmd 查看状态（客户端 / 调试端口 / 后端 / 数据目录 / 插件）。
4. Stop.cmd 停止 agent 和后端。

目录说明
--------
  app\bin\node.exe        自带 Node 运行时（无需另装 Node）
  app\tools\              agent / 后端 / CDP 注入器
  app\loader\             框架、管理器、hijack 规则、选择器表
  app\plugins\            随包分发的三个插件（首次启动时复制到 data\plugins）
  data\plugins\           实际生效的用户插件目录（管理器里可启停 / 卸载）
  data\host.log           后端日志
  app\out\agent.log       agent 日志


三个插件（都由同一套机制识别和管理）
------------------------------------
  RefinedNowPlaying.plugin    正在播放页 / 歌词
  MaterialYouTheme.plugin     Material You 主题
  LyricBar.plugin             软件内词栏（依赖并跟随 RefinedNowPlaying）

它们都是普通「用户插件」：没有内置锁定，管理器里可启用 / 禁用 / 卸载，全部经过同一个
3.x 门禁与同一套加载顺序（manifest 的 loadAfter / requirements 会被真正执行）。

常见问题
--------
* 客户端没启动 / 没插件：确认是用 Start.cmd 启动的。直接从桌面图标启动的客户端没有调试
  端口，agent 会（限流地）重启它一次。
* 想看错误：data\host.log、app\out\agent.log。
* 端口：--remote-debugging-port 只监听 127.0.0.1；Stop.cmd 会关掉 agent。


许可证与出处
------------
本包整体以 GPL-3.0-or-later 分发，授权全文见 app\LICENSE。
随包分发的三个插件都是第三方作品（LyricBar / RefinedNowPlaying 为 MIT，MaterialYouTheme
为 GPL-3.0），逐个组件的版本、作者、许可证与出处见 app\THIRD-PARTY-NOTICES.md。自带的
Node 运行时按 MIT 分发，其授权全文（含 V8 / OpenSSL / ICU 等捆绑依赖）见
app\bin\NODE-LICENSE.txt。
本包不包含网易云音乐的任何客户端资源、音源或账号凭证，也不修改带签名的客户端资源包。
