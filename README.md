<div align="center">
  <img src="src-tauri/icons/app-icon.png" width="128" height="128" alt="Surfisle 图标">
  <h1>Surfisle</h1>
  <p><strong>把常用效率工具收进桌面顶部的一座灵动岛。</strong></p>
  <p>待办事项、剪贴板历史、AI Agent 状态和媒体控制，一个紧凑入口即可完成。</p>

  <p>
    <img alt="Version" src="https://img.shields.io/badge/版本-1.0.3-111111?style=flat-square">
    <img alt="Platform" src="https://img.shields.io/badge/平台-Windows-111111?style=flat-square">
    <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white">
    <img alt="React" src="https://img.shields.io/badge/React-19-20232A?style=flat-square&logo=react&logoColor=61DAFB">
    <img alt="License" src="https://img.shields.io/badge/许可-Source%20Available-5B5B5B?style=flat-square">
  </p>
</div>

## Surfisle 是什么

Surfisle 是一款 Windows 桌面效率工具。它以透明、无边框、始终置顶的悬浮岛运行，在不打断当前工作的前提下提供待办管理、剪贴板回溯、AI 编程助手状态和系统媒体控制。

界面可以折叠、展开或收起到屏幕边缘。不使用时保持克制，需要时从桌面顶部快速进入。

## 功能亮点

| 功能 | 能做什么 |
| --- | --- |
| 桌面灵动岛 | 折叠、展开、长按拖动、托盘隐藏和开机启动 |
| 今日待办 | 新增、编辑、完成、删除、排序，并设置当前专注任务 |
| 每日笔记与归档 | 记录当天信息，跨天后自动归档历史内容 |
| Markdown 保存 | 将当天待办和笔记保存为本地 `YYYY-MM-DD.md` |
| 剪贴板历史 | 记录文本和图片，支持搜索、收藏、复制、删除和清空 |
| AI Agent 状态 | 汇总 Codex、Claude Code 和 OpenCode 的运行与完成状态 |
| 媒体控制 | 查看系统播放状态，控制播放、暂停、上一首和下一首 |
| 外观设置 | 调整透明度、缩放、顶部间距、面板高度、颜色与预设 |

## 安装

Surfisle 当前面向 Windows。建议从仓库右侧的 **Releases** 下载最新的 `Surfisle_1.0.3_x64-setup.exe`，运行安装程序即可。

> Release 发布前，也可以按照下方开发说明从源码构建。项目当前处于早期版本，升级前建议保留重要的 Markdown 文件。

## 快速使用

### 待办与笔记

1. 展开灵动岛，在待办页添加今天要完成的事项。
2. 将最重要的一项设为当前专注任务，折叠后仍可看到任务标题。
3. 在设置中选择 Markdown 保存目录，将当天内容写入本地文件。
4. 日期变化后，上一天的内容会进入归档。

默认 Markdown 目录：

```text
%USERPROFILE%\Documents\Surfisle
```

### 剪贴板历史

- 默认快捷键为 `Ctrl+Q`，可在设置中修改。
- 支持文本和图片记录，以及搜索、收藏、再次复制和单条删除。
- 清空历史时会保留已收藏的记录。

### 移动与录屏

- 在灵动岛的非按钮区域长按约半秒后拖动，可在本次运行中调整位置。
- 应用重启后会恢复到当前显示器顶部居中，不会永久保存拖动位置。
- 折叠态右侧录制按钮会触发 Windows Xbox Game Bar 的 `Win+Alt+R`，用于开始或停止屏幕录制。

### AI Agent 状态

在设置页安装或修复状态 Hooks 后，Surfisle 可显示 Codex、Claude Code 与 OpenCode 的运行、完成、失败或超时状态。详细说明见 [Agent 状态 Hooks 文档](docs/agent-status-hooks.md)。

## 数据与隐私

Surfisle 的主要数据保存在本机，不依赖云端账户：

| 数据 | 位置 |
| --- | --- |
| 待办、笔记、归档和外观设置 | WebView `localStorage`，键名以 `surfisle-*` 开头 |
| 剪贴板历史、图片与 Agent 状态 | `%APPDATA%\com.ryancy.surfisle` |
| Markdown 文件 | 用户在设置中选择的目录 |
| 开机启动 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` |

剪贴板历史可能包含敏感文本或图片。请只在可信的个人设备上启用，并根据需要定期清理记录。

## 本地开发

### 环境要求

- Windows 10 或 Windows 11
- Node.js 20+
- pnpm 11+
- Rust stable
- Tauri 2 在 Windows 上所需的 WebView2 与 C++ 构建工具

### 启动

```powershell
pnpm install
pnpm tauri dev
```

### 验证与构建

```powershell
# TypeScript 类型检查与前端生产构建
pnpm build

# 完整桌面安装包
pnpm tauri build
```

构建产物位于：

```text
src-tauri\target\release\bundle
```

## 技术栈

- React 19 + TypeScript + Vite 7
- Tauri 2 + Rust
- Windows API
- Lucide React

## 许可

Copyright (c) 2026 [ryancy](https://github.com/beginner1868). All rights reserved.

本项目采用 [Surfisle Source-Available License 1.0](LICENSE)，属于**源码可见（Source Available）**，不是 OSI 定义下的开源软件。[中文协议](LICENSE.zh-CN.md)仅用于辅助理解，法律效力以英文正式版本为准。

协议允许个人查看和研究源码、非商业使用官方版本，以及为个人非商业用途编译未经修改的源码。未经作者书面许可，不得商业使用、修改或发布衍生版本、重新打包，也不得分发非官方构建。

商业授权、组织使用、修改或其他授权需求，请通过 [GitHub](https://github.com/beginner1868) 联系作者。
