# Devin

Devin 桌面端（Electron + VS Code 内核）的本地化适配。

## 支持的版本

| 版本 | build | 状态 | 验证日期 | 替换处数 |
| --- | --- | --- | --- | --- |
| 1.126.0 | `d70b4713dfea` | 已验证 | 2026-10-25 | 2,987 |

## 结构差异

Devin 的界面分两块，和 Cursor 不完全一样：

- **IDE 模式**：`out/vs/workbench/workbench.desktop.main.js`，VS Code 内核，官方语言包扩展可以覆盖一部分。
- **Agent 模式**：`out/vs/sessions/sessions.desktop.main.js`（自有实现，38 MB）与 `out/vs/workbench/windsurf-chat-client/index.js`，没有官方语言包，只能按本仓库的方式打补丁。
- 另有 `out/vs/workbench/devin-webapp-host/assets/`（约 1,900 个 JS，72 MB），疑似 Web 版界面资源，后续再评估。

## 目标文件

| label | 文件 | product.json 校验 |
| --- | --- | --- |
| workbench | `out/vs/workbench/workbench.desktop.main.js` | 是 |
| sessions | `out/vs/sessions/sessions.desktop.main.js` | 是 |
| chat-client | `out/vs/workbench/windsurf-chat-client/index.js` | 是 |

三块都在 `product.json` 的 `checksums` 里，替换后必须同步校验值，否则应用会拒绝加载。

## 安装位置

- Windows：`%LOCALAPPDATA%\Programs\Devin`、`C:\Program Files\Devin`
- macOS：`/Applications/Devin.app/Contents`
- Linux：`/opt/Devin`、`~/.local/share/devin`

应用目录是 `<安装目录>/resources/app`（无 asar，文件是展开的）。

## 已验证结果

- 扫描：去重 162,112 条，界面文案 1,509 条（规则已跳过 Monaco/WebGPU 调试名与 `%nls.key%` 消息键）。
- 替换：2,987 处 —— workbench 669 / sessions 1,546 / chat-client 772；审计三个目标全部一致。
- `product.json` 的三个 checksums 已同步。
