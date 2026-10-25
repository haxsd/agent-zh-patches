# AGENTS.md · 给执行汉化的 agent

你正在替用户给一个 AI 桌面应用打简体中文补丁。本文件是执行契约：按顺序做，每步都有验收条件。**仓库里没有译文**，翻译由你完成。

## 0. 先确认

- 用户装的是哪个应用、大概什么版本、安装在哪里（不知道就自己检测）。
- 目标应用是否已完全退出（可以让它开着跑 `--force`，但**必须**在结束时提醒完全退出再重开）。
- 本机 Node.js ≥ 16。

## 1. 检测

```powershell
node tools/zh.js detect --app cursor        # 或 devin
```

输出包含：安装目录、应用目录、版本、build、已支持/未支持（对照 `apps/<app>/versions.json`）。

- 版本在矩阵里且 `status: verified` → 按该版本的适配配置执行。
- 版本不在矩阵里 → 用 `apps/<app>/adapter.json` 的通用规则继续，但先告诉用户「这个版本没有验证过」，并在最终报告里标 `unverified`。

## 2. 扫描（本地，不联网）

```powershell
node tools/zh.js scan --app cursor
```

它只抽取 UI 属性（`label` / `title` / `description` / `children` / `placeholder` 等）里的自然语言，并记录每个字符串在文件中的**精确字节位置**。跳过代码标识符、事件名、颜色值、URL、图标语法。

产物：`<data>/<app>/candidates.json`（`<data>` 默认 `~/.agent-zh`，可用 `--data` 指定）。

## 3. 翻译（由你完成）

```powershell
node tools/zh.js pending --app cursor --out <data>/<app>/pending.json
```

`pending.json` 是还没译过的条目（` id, source, props, context }[]`）。你把它翻译成简体中文，写成 `zh.json`：

```json
{ "Add context": "添加上下文", "New Agent": "新建智能体" }
```

翻译规则：

- 保留占位符原样（`${name}`、`{{count}}`、`%s`、`0}`），数量与拼写都不能改。
- 不翻产品名与协议名：`Cursor`、`Devin`、`GitHub`、`MCP`、`GPT-5`、`Claude`、`npm`、`URI`、`JSON`。
- 不翻代码标识符、文件路径、命令、快捷键（`Cmd+K`、`Ctrl+Shift+P`）。
- 句末标点跟随中文习惯；按钮与菜单用短词（「取消」「保存」），长句用陈述语气。
- 同一概念前后一致：`Agent` → 智能体，`Session` → 会话，`Workspace` → 工作区，`Checkpoint` → 检查点，`Skill` → 技能。
- 拿不准的宁可按字面译，并在最终报告里列出「需要人工确认」的条目。

```powershell
node tools/zh.js merge --app cursor --from <data>/<app>/zh.json
```

合并进 `<data>/<app>/translations.json`（以英文原文为键）。**这是跨版本复用的账本**：下次升级只会有新增条目进入 `pending.json`。

## 4. 校验与打补丁

```powershell
node tools/zh.js verify --app cursor
node tools/zh.js apply  --app cursor
```

`apply` 会：备份原文件到 `<data>/<app>/backups/<build>/` → 按扫描记录的位置替换 → 更新应用 `product.json` 的校验值 → `node --check` 语法校验 → 逐字面量审计。

必须全部通过：审计一致、语法通过、校验值同步。任一失败就停止，把输出原样报告给用户，不要手工改安装目录。

## 5. 收尾

- 报告：应用与版本、翻译条数（本次新增 / 复用）、替换处数、审计结果、未验证项。
- 提醒用户：**完全退出应用再重新打开**（关窗口不算）。
- 告诉用户译文缓存在 `<data>/<app>/translations.json`，升级后重跑会自动复用。

## 禁止

- 不要把译文缓存、扫描产物、备份提交回本仓库（`.gitignore` 已屏蔽 `data/`、`.cache/`）。
- 不要替换非 UI 位置的字符串；不要为了让界面「看起来全中文」去改代码标识符。
- 不要在没有备份的情况下直接编辑安装目录。
- 不要把本仓库内容当作译文来源——这里没有译文，只有工具与规则。

## 故障处置

| 现象 | 处理 |
| --- | --- |
| `detect` 找不到安装目录 | 让用户确认安装路径，用 `--app-dir "<...>/resources/app"` 显式指定 |
| `scan` 报「已经在汉化文件上扫描」 | 先 `restore --force` 还原英文，再重新 scan |
| `apply` 报文件大小/哈希与扫描时不一致 | 应用在扫描后被升级或改写，重新 scan 再 apply |
| 审计不一致 | 停止，不要重试覆盖；先 `restore`，再重新 scan/apply |
| 用户升级后界面变回英文 | 正常现象，应用升级会覆盖补丁；重跑 1–4 步即可，旧译文自动复用 |
