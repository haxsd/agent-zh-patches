# agent-zh-patches

给 AI 桌面应用做简体中文补丁的**工具集**，设计成让 agent 直接执行：把这个仓库的链接丢给你的 agent，说一句「帮我把 Cursor 汉化」，它就能完成扫描、翻译、替换和校验。

仓库里**不包含任何厂商的界面原文或译文**——译文由你本机的 agent 现场生成，缓存留在你自己的机器上。每个补丁都标注对应的应用版本，agent 会先检测你装的是哪一版。

> **状态：引擎移植中。** 当前仓库已包含适配层、版本矩阵与 agent 执行契约；	ools/zh.js 的实现还在从已有的 Cursor 工具移植，落地后按 AGENTS.md 即可直接使用。

## 支持的应用

| 应用 | 版本 | build | 状态 | 验证日期 |
| --- | --- | --- | --- | --- |
| Cursor | 3.27.12 | `df132ffba9` | 已验证 | 2026-10-24 |
| Cursor | 3.27.6 | `f711952054` | 已验证 | 2026-10-23 |
| Cursor | 3.26.16 | `8fcb8ace5c` | 已验证 | 2026-10-22 |
| Cursor | 3.26.13 | `3bfec37374` | 已验证 | 2026-10-21 |
| Devin | 1.126.0 | `d70b4713dfea` | 待验证 | — |

版本矩阵的权威来源是每个应用目录下的 `versions.json`；未列出的版本仍可尝试，agent 会标为 `unverified` 并提示风险。

## 怎么用

把仓库地址发给你的 agent，例如：

> 用 https://github.com/haxsd/agent-zh-patches 帮我把本机的 Cursor 汉化，装的是 3.27.12。

agent 会读 [`AGENTS.md`](AGENTS.md)，按流程执行：

1. 定位安装目录、读版本，和 `apps/<app>/versions.json` 对照；
2. 扫描界面文案（只记录 UI 属性里的字符串与精确位置）；
3. **由 agent 自己翻译**（不依赖任何翻译 API），生成的译文缓存在 `~/.agent-zh/<app>/`；
4. 备份原文件 → 按位置替换 → 更新应用自身的校验值 → 语法校验 → 逐字面量审计；
5. 提示你完全退出应用再重开。

译文以英文原文为键缓存，应用升级后命中的直接复用，只翻新增条目。要还原：`node tools/zh.js restore --app cursor`。

## 目录结构

```text
core/                 通用引擎：扫描、替换、审计、备份、还原
apps/<app>/           adapter.json（路径与目标文件）、versions.json（版本矩阵）、README.md
docs/                 原理、数据目录规范
tools/zh.js           统一入口：detect / scan / translate / apply / audit / restore
AGENTS.md             给 agent 的执行契约
```

## 边界

- 只替换扫描记录到的 UI 字符串位置，不动代码标识符、事件名、枚举值；
- 命令面板按英文搜索命令、原生菜单栏、扩展提供的文案不在覆盖范围；
- 修改的是本机安装目录里的程序文件，升级会被覆盖，需要重跑；风险自担，非官方工具。

## 许可证

MIT（仅覆盖本仓库的代码与文档）。
