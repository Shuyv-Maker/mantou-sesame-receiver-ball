# 馒头芝麻收图球（Windows MVP）

## 0.1.4 拖动与批次计数

修复 Windows 分数 DPI 下 setPosition 连续移动导致透明窗口膨胀的问题：使用原生鼠标 DIP 位置与固定大小 setBounds，松手、失焦、取消均释放捕获。拖入时不缩放，只打散粒子；右下角数字表示本批已经收到保存确认的图片数，失败不计数，下一批重新计数。支持多文件逐张传送，不再默默截取前 12 张。

安装包：`release/Mantou-Sesame-Receiver-Ball-0.1.4-Setup.exe`。`npm run test:orb` 在隔离的原生 Electron 验收窗口中使用 Windows 鼠标拖动，验证移动、后方页面点击、多文件传送与保存确认、部分失败计数、固定尺寸及右键菜单；这不等于生产网站端到端验收。

## 0.1.3 粒子外观（历史）

采用 thinking-orbs 0.3.1 的原版 Canvas 粒子引擎（MIT），独立圆球直径 76 DIP，透明窗口 88 DIP。待连接显示星点连线；就绪显示球面扫描；传送显示轨道粒子；成功显示勾号；失败显示感叹号，右键查看原因。鼠标悬停可读状态及项目名，主界面不再常驻两行文字。支持高 DPI、减少动态效果和不可见时暂停动画。版权信息见 THIRD_PARTY_NOTICES.md。

本地安装包：`release/Mantou-Sesame-Receiver-Ball-0.1.3-Setup.exe`。

这是「馒头芝麻 Mantou Sesame」的独立 Windows 收图球，而不是浏览器浮窗。它不会读取 ChatGPT、浏览器历史或任何网页内容；只会接收用户主动拖入小球的本地图片，并把图片交给已配对的馒头芝麻项目页面保存。

## 已实现

- 无标题栏、透明、始终置顶的 88 × 88 像素独立收图球。
- 左键拖动小球；把本地图片拖上小球即可传送；右键打开菜单并可选择“关闭收图球”；双击查看连接帮助。
- 网站点击「连接 Windows 收图球」后会自动将当前项目连接到小球，不需要复制或粘贴配对码。
- 系统托盘菜单可显示小球、查看连接状态、查看连接帮助或退出；备用配对码只在自动连接失败时使用。
- 只监听本机地址 127.0.0.1:49731，绝不对局域网开放。
- 单个图片最多 50 MiB，支持 JPG、PNG、WebP、GIF、HEIC、SVG、TIFF、AVIF、BMP。
- 运行期随机配对码、精确网站来源白名单、明确的保存确认（ACK）和 30 秒失败超时。
- 自定义启动协议：mantousesame://receiver。已安装版本可由网站唤起收图球或显示配对说明。

## 本地运行

在此目录执行：

    npm install
    npm start

首次运行后，去馒头芝麻网站的「我的创作」选择项目，点击「连接 Windows 收图球」。网站会启动或唤醒小球并自动连接当前项目；连接成功后显示球面扫描粒子和绿色状态点，悬停或右键查看项目名称。

便携版第一次必须由你手动运行一次 EXE，Windows 才能登记小球的唤起方式；之后在网站中点击连接即可自动唤起。

右键小球会打开系统菜单；只有点击“关闭收图球”才会完全退出小球和本机桥接服务。下次启动会生成新配对码。

## Windows 便携版（当前可直接使用）

已生成可直接运行的便携包：

    release/Mantou-Sesame-Receiver-Ball-0.1.1-portable.zip

解压后运行：

    Mantou-Sesame-Receiver-Ball-win32-x64/Mantou Sesame Receiver Ball.exe

无需安装；退出小球后下次可再次直接运行该 EXE。

## Windows 一键安装版

安装程序只在首次使用时需要你确认一次；安装完成后会自动启动收图球，并登记 `mantousesame://` 唤起方式。之后从网站进入项目，点击「连接 Windows 收图球」即可自动唤起并连接，不再输入配对码。

    release/Mantou-Sesame-Receiver-Ball-0.1.0-Setup.exe

浏览器和网站不能绕过 Windows 的安全确认静默执行本机程序；这一次确认无法取消。安装完成后的日常连接不需要重复下载或配对。

## 打包 Windows 安装程序（开发用）

    npm run package:win

成功后，安装程序会位于：

    release/Mantou-Sesame-Receiver-Ball-0.1.0-Setup.exe

也可先生成免安装目录以做测试：

    npm run package:dir

## 网站桥接协议（v1）

网站将一个不可见 iframe 加载为：

    http://127.0.0.1:49731/bridge

网站会在用户点击连接时通过自定义 Windows 启动链接传递一个仅在内存中使用的短随机令牌；不要把它写入 localStorage、日志、作品或云端。iframe 会从父页面的精确来源接收消息，且只允许以下来源：

- https://mantou-sesame-knowledge-studio.qishuyv.chatgpt.site
- http://localhost:3000
- http://127.0.0.1:3000

### iframe → 网站父页面

mantou:bridge-ready

    {
      type: "mantou:bridge-ready",
      version: 1,
      bridgeOrigin: "http://127.0.0.1:49731",
      protocol: 1
    }

mantou:paired

    {
      type: "mantou:paired",
      version: 1,
      token: "MS-...",
      projectId: "project-id",
      projectName: "项目名称"
    }

mantou:image

    {
      type: "mantou:image",
      version: 1,
      token: "MS-...",
      projectId: "project-id",
      id: "image_...",
      name: "图片.png",
      mime: "image/png",
      size: 12345,
      file: File
    }

mantou:error 和 mantou:closed 也会携带 version、token、projectId，其中错误消息另含 code 和 message。

所有 iframe 向父页面的消息都会使用已验证的精确 parentOrigin 作为 postMessage target origin，绝不使用通配符。

### 网站父页面 → iframe

网站必须用精确目标来源 http://127.0.0.1:49731 调用 iframe.contentWindow.postMessage：

    {
      type: "mantou:pair",
      version: 1,
      token: "MS-...",
      projectId: "project-id",
      projectName: "项目名称",
      parentOrigin: "https://mantou-sesame-knowledge-studio.qishuyv.chatgpt.site"
    }

图片保存到网站自身 IndexedDB 后，网站应确认：

    {
      type: "mantou:ack",
      version: 1,
      token: "MS-...",
      projectId: "project-id",
      id: "image_...",
      status: "saved"
    }

若网站拒绝保存，可将 status 设为 rejected 并带上 message。断开时使用 mantou:disconnect，需要携带同一 token 与 projectId。断开后收图球会轮换配对码。

## 重要限制

- 当前 MVP 只接收用户主动拖入的本地文件，不能也不会自动抓取 ChatGPT 页面或短视频平台内容。
- 图片最后由网站页面写入该浏览器、该网站同源的 IndexedDB；原生小球不会尝试读取或修改浏览器 Profile。
- 公网 HTTPS 网页访问本机回环地址会受到不同浏览器的 Private Network Access / 混合内容策略影响。Chrome/Edge 需要真机验证；如果目标环境阻止本机 iframe 或 WebSocket，网站必须显示手动上传回退。正式跨浏览器方案应升级为「浏览器扩展 + Native Messaging」。
- 如果提示 49731 端口无法启动，说明已有程序占用该端口。请退出旧收图球后重新启动。
