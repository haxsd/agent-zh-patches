#!/usr/bin/env node
'use strict';
/**
 * 一条命令跑完（不含翻译）：检测 → 必要时还原/扫描 → 校验 → 打补丁 → 审计。
 * 译文由 agent 负责：缺译文时本脚本只生成 pending.json 并以退出码 5 结束。
 *
 *   node tools/update.js --app cursor [--data <dir>] [--force] [--allow-stale]
 *
 * 退出码：0 完成；5 有待译条目（先翻译再重跑）；3 命令失败；7 校验失败；8 审计失败。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ZH = path.join(__dirname, 'zh.js');

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[a.slice(2)] = next; i++; } else out[a.slice(2)] = true;
  }
  return out;
}
const args = parse(process.argv.slice(2));
if (!args.app) { console.error('用法：node tools/update.js --app cursor|devin [--data <dir>]'); process.exit(2); }

const base = ['--app', args.app];
if (args.data) base.push('--data', args.data);
if (args['app-dir']) base.push('--app-dir', args['app-dir']);

function run(cmd, extra, capture) {
  const argv = [ZH, cmd].concat(base, extra || []);
  const res = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  return { code: res.status, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}
function step(name) { console.log('\n=== ' + name + ' ==='); }
function status() {
  const r = run('status', ['--json'], true);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.out.split('\n').pop()); } catch { return null; }
}

step('检测');
const d = run('detect', [], true);
if (d.code !== 0) { console.error(d.err || d.out); process.exit(3); }
console.log(d.out);

let st = status();
if (!st) { console.error('无法读取 status'); process.exit(3); }
console.log('\n版本 ' + st.version + ' / ' + String(st.build).slice(0, 10) +
  ' · 补丁 ' + st.patched + '/' + (st.targets || 3) +
  ' · 待译 ' + (st.pending === null ? '未知' : st.pending));

const needScan = !st.sameBuild;
const rebuild = args.force || needScan || st.patched === 0 || (st.pending || 0) > 0;

if (!rebuild) {
  console.log('\n已是最新：补丁在位、快照与安装一致、没有待译条目。');
  process.exit(0);
}

if (st.patched > 0 && (needScan || args.force)) {
  step('还原（restore）');
  const r = run('restore', ['--force']);
  if (r.code !== 0) process.exit(3);
}
if (needScan) {
  step('扫描（scan）');
  const r = run('scan');
  if (r.code !== 0) process.exit(3);
}

st = status();
if ((st.pending || 0) > 0) {
  step('生成待译清单（pending）');
  run('pending');
  console.log('\n有 ' + st.pending + ' 条待翻译。请让 agent 翻译 data 目录下的 pending.json，');
  console.log('写成 zh.json 后执行：node tools/zh.js merge --app ' + args.app + ' --from <zh.json>');
  console.log('再重新运行本命令。');
  process.exit(5);
}

step('校验（verify）');
if (run('verify').code !== 0) { console.error('校验未通过'); process.exit(7); }

step('计划（plan）');
run('plan');

step('打补丁（apply）');
if (run('apply', ['--force']).code !== 0) { console.error('apply 失败'); process.exit(3); }

step('审计（audit）');
if (run('audit').code !== 0) { console.error('审计未通过'); process.exit(8); }

console.log('\n=== 完成 ===');
console.log('完全退出应用再重新打开，中文才会加载。');
