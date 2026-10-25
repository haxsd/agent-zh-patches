# Cursor

Cursor 桌面端自有界面（Agent 窗口、设置页、Automations）的本地化适配。

## 支持的版本

| 版本 | build | 状态 | 验证日期 | 替换处数 |
| --- | --- | --- | --- | --- |
| 3.27.12 | `df132ffba9` | 已验证 | 2026-10-24 | 9,859 |
| 3.27.6 | `f711952054` | 已验证 | 2026-10-23 | 9,802 |
| 3.26.16 | `8fcb8ace5c` | 已验证 | 2026-10-22 | 9,783 |
| 3.26.13 | `3bfec37374` | 已验证 | 2026-10-21 | 9,746 |

未列出的版本可以用通用规则尝试，`detect` 会标为 `unverified`。

## 目标文件

| label | 文件 | product.json 校验 |
| --- | --- | --- |
| agent-window | `out/vs/workbench/workbench.glass.main.js` | 否 |
| editor-window | `out/vs/workbench/workbench.desktop.main.js` | 是 |
| automations | `out/vs/workbench/workbench.anysphere-ui-automations.js` | 否 |

## 安装位置

- Windows：`%LOCALAPPDATA%\Programs\cursor`、`C:\Program Files\Cursor`
- macOS：`/Applications/Cursor.app/Contents`
- Linux：`/opt/Cursor`、`~/.local/share/cursor`

应用目录是 `<安装目录>/resources/app`。定位不到时用 `--app-dir` 显式指定。

## 已知限制

- 命令面板按英文搜命令会搜不到（汉化方案的固有代价）。
- 原生菜单栏、扩展提供的文案不在覆盖范围。
- Cursor 升级会整体覆盖这三个文件，补丁失效但不损坏，重跑即可。
