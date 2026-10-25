# 数据目录

引擎不把译文写进仓库。所有运行产物都在**数据目录**里，默认 `~/.agent-zh/`，可用 `--data <dir>` 指定。

## 结构

```text
<data>/
  <app>/
    candidates.json        扫描产物：候选字符串、UI 属性、风险计数、每个字面量的精确位置
    pending.json           还没译过的条目（给 agent 翻译）
    zh.json                本次翻译结果（agent 写，merge 后保留作记录）
    translations.json      账本：英文原文 -> 译文，跨版本复用
    overrides.json         人工修正（可选，优先于账本）
    applied.json           本次落盘记录：提交号、逐文件 sha256、replacements
    backups/<build>/       原始文件 gzip 备份（还原用，体积大，不要入库）
    last-run.json          上次运行的版本、替换数、输入哈希
```

我们自己的预置数据包放在**私有记录仓库**的 `agent-zh-patches/data/` 分区，结构相同（只含 `translations.json`、
`overrides.json`、`promote.json`），通过 `--data` 指向它即可。公开仓库永远不包含这些内容。

## 复用规则

- 译文以**英文原文**为键。应用升级后，`scan` 得到新的候选集，`pending` 只列出账本里没有的原文。
- 已译条目即使换了位置也自动复用；位置由本次扫描重建，不依赖旧数据。
- 同一个原文在不同上下文只能有一个译文；需要区分时用 `overrides.json` 按原文覆盖，或在 adapter 里拆 target。
- 升级后如果旧译文的上下文变了（比如从按钮变成标题），人工确认一次即可，不必整体重译。

## 迁移

换机器或换数据包：把整个数据目录拷过去即可。备份目录可以不带，`apply` 会重新备份。

## 清理

`backups/` 每个版本约 100 MB（gzip 后仍大）。确认新版稳定后，可以删掉上一版的备份目录；保留最近一版用于 `restore`。
