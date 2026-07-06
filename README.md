# iPerf3 UI

iPerf3 UI 是一个 vibe coding 项目，用 Tauri、React、TypeScript 和 Rust 为 iPerf3 开发的桌面 GUI 工具。

这个项目的目标是给 [iPerf3](https://iperf.fr/) 这个网络性能测试工具提供一个更直观的界面，方便调整客户端、服务端、协议、带宽、并发流、传输时长、窗口、认证、SSH 远程运行等参数，并直接运行命令、查看实时日志和结果概览。


## 大致演示

https://github.com/user-attachments/assets/4e5cd907-5aa5-41ee-9f04-8d1c197d3f3f


## 前置环境

浏览器预览需要：

- Node.js 20+
- pnpm

Windows 桌面应用开发和编译还需要：

- Rust stable MSVC toolchain
- Visual Studio 2022 或 Build Tools for Visual Studio
- Visual Studio 中安装 `Desktop development with C++`
- WebView2 Runtime

项目已内置 `iperf3.exe` 和运行所需 DLL，也支持在界面中选择自定义 `iperf3.exe`。

## 快速启动

安装依赖：

```powershell
pnpm install
```

启动浏览器预览：

```powershell
pnpm dev
```

访问：

```text
http://127.0.0.1:5173/
```

启动 Tauri 桌面开发模式：

```powershell
pnpm dev:tauri:win
```

`dev:tauri:win` 会自动加载 Visual Studio C++ 编译环境，比直接运行 `pnpm tauri:dev` 更适合 Windows。

## 编译二进制

先检查 Rust/Tauri 后端：

```powershell
pnpm check:tauri:win
```

构建前端：

```powershell
pnpm build
```

编译 Windows 桌面应用和安装包：

```powershell
pnpm build:tauri:win
```

常见产物位置：

```text
src-tauri/target/release/app.exe
src-tauri/target/release/bundle/msi/
```

## 项目结构

```text
iperf3-ui/
├─ docs/
│  └─ demo.mp4              # 项目演示视频
├─ scripts/
│  └─ build-tauri.ps1       # Windows Tauri 构建辅助脚本
├─ src/
│  ├─ App.tsx               # 主界面
│  ├─ App.css               # 主界面样式
│  ├─ main.tsx              # React 入口
│  └─ lib/
│     ├─ backend.ts         # 前端调用 Tauri 后端的封装
│     ├─ command.ts         # iPerf3 参数校验与命令生成
│     ├─ options.ts         # 参数目录与说明
│     ├─ results.ts         # iPerf3 输出解析与结果格式化
│     └─ types.ts           # 共享类型定义
├─ src-tauri/
│  ├─ bin/                  # 内置 iperf3.exe 和依赖 DLL
│  ├─ icons/                # 应用图标
│  ├─ src/
│  │  ├─ lib.rs             # Tauri commands、进程管理、SSH、预设存储
│  │  └─ main.rs            # Tauri 入口
│  ├─ tauri.conf.json       # Tauri 配置
│  └─ Cargo.toml            # Rust 依赖配置
├─ package.json             # 前端依赖与脚本
├─ vite.config.ts           # Vite 配置
└─ tsconfig*.json           # TypeScript 配置
```
