# Relay + BotJS + WebRTC 远程控制（Electron）

本项目是一个最小可跑的远程控制 Demo，基于你提供的转发层协议：

- WebRTC 画面转发（`type=webrtc`）
- BotJS 键鼠控制（`type=botjs`）
- 屏幕信息同步（`type=screenInfo`）

## 1. 安装

```bash
npm install
```

## 2. 启动

```bash
npm start
```

## 2.1 打包（Mac + Win）

```bash
# 本机打包当前系统可支持的目标
npm run dist

# 仅打包 macOS arm64（dmg）
npm run dist:mac

# 仅打包 Windows x64（zip）
npm run dist:win
```

产物目录：`dist/`

原生模块打包逻辑：

- 打包前会执行 `npm run prepare:native`，自动下载：
  - `crobot-win32-x64.node` -> `build/native/win32-x64/crobot.node`
  - `crobot-darwin-arm64.node` -> `build/native/darwin-arm64/crobot.node`
- 打包时按平台拷贝到应用资源目录：
  - macOS 包含 `resources/native/crobot.node`（来自 darwin-arm64）
  - Windows 包含 `resources/native/crobot.node`（来自 win32-x64）

说明：

- `botjs` 当前目标平台为 macOS arm64 与 Windows x64。
- 在 macOS 本机直接打 Windows 包可能受原生模块编译与工具链限制，建议用 CI 分平台构建（下文提供 GitHub Actions）。

## 3. 使用方式

在两台设备（或同机两个实例）分别打开应用：

1. 共享端

- 选择“共享端（被控端）”
- 连接 Relay
- 点击“开始共享”，记下“共享密码”

2. 控制端

- 选择“控制端”
- 连接 Relay
- 输入共享密码，点击“认证并发起连接”
- 看到画面后，点击视频区域并开始键鼠控制

## 4. BotJS 依赖说明

默认依赖为：

- `botjs` @ `github:nhzpthapcd7062/botjs#v0.1.2`

主进程会尝试加载：

1. `botjs`
2. `c-robot`

如加载失败，请确认：

- 平台是 macOS arm64 或 Windows x64
- 已授予辅助功能权限（macOS）
- 原生模块安装编译成功

运行时下载兜底说明：

- 当本地 BotJS 原生模块不可用时，应用会在运行时下载对应平台的 `crobot.node`。
- 默认下载地址：`https://github.com/nhzpthapcd7062/botjs/releases/download/v0.1.2`
- 如目标机器无法访问 GitHub，可设置环境变量 `BOTJS_NATIVE_BASE_URLS` 指向镜像基础地址（可多个，逗号分隔）。

示例：

```bash
BOTJS_NATIVE_BASE_URLS=https://your-mirror.example.com/botjs/v0.1.2 npm start
```

## 5. 开发提示

- 开发环境默认忽略自签名证书错误（仅开发）
- 鼠标移动采用高频轻量限流（约 120Hz）并去重，提升跟手性
- 坐标映射优先使用 `screenInfo.captureWidth/captureHeight`

## 6. GitHub Actions 双平台打包

仓库已提供工作流文件：`.github/workflows/build-desktop.yml`

- 在 `macos-latest` 生成 macOS arm64 包
- 在 `windows-latest` 生成 Windows x64 包
- 构建结束后自动上传 `dist/` 产物
