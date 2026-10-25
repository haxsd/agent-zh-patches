'use strict';
/**
 * 通用命令层：doctor / status / scan / pending / merge / verify / plan / apply / audit / restore。
 * 所有应用差异来自 apps/<app>/adapter.json；所有数据来自 --data 指定的数据目录。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('./lib/files');
const L = require('./lib/literals');
const P = require('./lib/platform');
const C = require('./lib/context');

const PLACEHOLDER_RE = /\{\d+\}|\$\([a-zA-Z0-9~-]+\)|%[sd]|\\n|\\u\{[0-9A-Fa-f]{1,6}\}|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}/g;
const emojiCount = (s) => Array.from(s).filter(function (ch) { var cp = ch.codePointAt(0); return (cp >= 0x1F000 && cp <= 0x1FAFF) || (cp >= 0x2600 && cp <= 0x27BF) || (cp >= 0x2B00 && cp <= 0x2BFF) || cp === 0xFE0F; }).length;

const log = (...a) => console.log(...a);

function readJson(file, def) { return C.readJson(file, def); }
function writeJson(file, obj) {
  F.ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 1) + '\n', 'utf8');
}

function targetPaths(ctx) {
  return ctx.rules.targets.map(t => ({ ...t, abs: path.join(ctx.appDir, t.file) }));
}
function checksumKey(ctx, relFile) {
  const prefix = (ctx.adapter.integrity && ctx.adapter.integrity.keyPrefix) || 'out/';
  let s = relFile.replace(/\\/g, '/');
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}
function integrityFile(ctx) {
  return path.join(ctx.appDir, (ctx.adapter.integrity && ctx.adapter.integrity.file) || 'product.json');
}
function validateSyntax(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err.stderr || err.message).slice(0, 4000) };
  }
}

/** 译文账本：兼容 {translations}/{byText}/扁平 三种写法，并叠加 overrides / promote */
function loadTranslations(ctx) {
  const raw = readJson(ctx.paths.translations, null) || readJson(ctx.paths.translationsLegacy, null);
  let map = {};
  if (raw) map = raw.translations || raw.byText || raw;
  const ov = readJson(ctx.paths.overrides, { text: {} });
  Object.assign(map, ov.text || ov);
  const pr = readJson(ctx.paths.promote, { text: {} });
  Object.assign(map, pr.text || pr);
  if (map.$comment) delete map.$comment;
  return map;
}
function loadPromote(ctx) {
  const pr = readJson(ctx.paths.promote, { text: {} });
  return pr.text || pr;
}
function isPromoted(ctx, value) {
  return Object.prototype.hasOwnProperty.call(loadPromote(ctx), value);
}
function loadCandidates(ctx) { return readJson(ctx.paths.candidates, null); }

function isPatched(ctx) {
  const applied = readJson(ctx.paths.applied, null);
  if (applied && applied.build === ctx.info.commit) {
    let n = 0;
    for (const rec of applied.files || []) {
      if (!rec.sha256 || !fs.existsSync(rec.file)) continue;
      if (F.sha256Hex(fs.readFileSync(rec.file)) === rec.sha256) n++;
    }
    if (n) return n;
  }
  // 没有本机落盘记录（例如换机器 / 用别人的数据包）时，用中文密度粗判
  let probe = 0;
  for (const t of ctx.rules.targets) {
    const abs = path.join(ctx.appDir, t.file);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const cjk = (text.match(/[\u4e00-\u9fff]{2,}/g) || []).length;
    if (cjk > 50) probe++;
  }
  return probe;
}

function pendingCount(ctx) {
  const cand = loadCandidates(ctx);
  if (!cand) return null;
  const tr = loadTranslations(ctx);
  return Object.entries(cand.entries)
    .filter(([v, e]) => (e.safety !== 'skip' || isPromoted(ctx, v)) && !tr[v]).length;
}

// ─────────────────────────────── doctor ───────────────────────────────
function cmdDoctor(ctx) {
  const info = ctx.info;
  log(ctx.adapter.name + '       ' + info.version + '  (build ' + String(info.commit).slice(0, 10) + ')');
  log('安装目录     ' + path.dirname(path.dirname(ctx.appDir)));
  log('应用目录     ' + ctx.appDir);
  log('数据目录     ' + ctx.dataDir);
  log('');
  log('目标文件：');
  const out = [];
  for (const t of targetPaths(ctx)) {
    if (!fs.existsSync(t.abs)) { log('  ✗ ' + t.label.padEnd(14) + ' 缺失 ' + t.file); out.push({ label: t.label, present: false }); continue; }
    const buf = fs.readFileSync(t.abs);
    let ckState = 'n/a';
    if (t.checksummed) {
      const key = checksumKey(ctx, t.file);
      const ck = (info.product.checksums || {})[key];
      const actual = F.sha256Base64(buf).replace(/=+$/, '');
      ckState = !ck ? '未登记' : ck === actual ? '校验值匹配 ✓' : '校验值不匹配 ✗';
    }
    log('  ✓ ' + t.label.padEnd(14) + ' ' + (buf.length / 1048576).toFixed(1) + ' MB  ' + ckState);
    out.push({ label: t.label, file: t.file, present: true, bytes: buf.length, checksummed: Boolean(t.checksummed) });
  }
  log('');
  log('语法校验器（node --check）：');
  for (const t of targetPaths(ctx)) {
    if (!fs.existsSync(t.abs)) continue;
    const v = validateSyntax(t.abs);
    log('  ' + (v.ok ? '✓' : '✗') + ' ' + t.label + (v.ok ? '' : '  ' + v.message.split('\n')[0]));
  }
  log('');
  log('应用是否在运行：' + (P.isRunning(ctx.adapter.processName) ? '是（改完需要完全退出再重开）' : '否'));
  writeJson(path.join(ctx.paths.reports, 'doctor.json'), { ...info, product: undefined, targets: out });
  return 0;
}

// ─────────────────────────────── status ───────────────────────────────
function cmdStatus(ctx) {
  const cand = loadCandidates(ctx);
  const patched = isPatched(ctx);
  const sameBuild = Boolean(cand && cand.build === ctx.info.commit);
  const pending = pendingCount(ctx);
  const tr = loadTranslations(ctx);
  const status = {
    app: ctx.appId,
    name: ctx.adapter.name,
    version: ctx.info.version,
    build: ctx.info.commit,
    appDir: ctx.appDir,
    dataDir: ctx.dataDir,
    patched,
    snapshotVersion: cand ? cand.version : null,
    snapshotBuild: cand ? cand.build : null,
    sameBuild,
    translations: Object.keys(tr).length,
    pending
  };
  if (ctx.args.json) { log(JSON.stringify(status)); return 0; }
  log(ctx.adapter.name + '       ' + status.version + '  (build ' + String(status.build).slice(0, 10) + ')');
  log('应用目录     ' + status.appDir);
  log('数据目录     ' + status.dataDir);
  log('补丁状态     ' + (patched ? '已打补丁（' + patched + '/' + ctx.rules.targets.length + ' 个文件）' : '未打补丁（原文）'));
  log('扫描快照     ' + (cand ? cand.version + ' / ' + String(cand.build).slice(0, 10) + (sameBuild ? '（一致）' : '（不一致，需要重新 scan）') : '无'));
  log('译文账本     ' + status.translations + ' 条，待翻译 ' + (pending === null ? '未知' : pending) + ' 条');
  log('下一步       ' + (!cand || !sameBuild ? 'node tools/zh.js scan --app ' + ctx.appId
    : pending ? 'node tools/zh.js pending --app ' + ctx.appId + '（再翻译）'
    : !patched ? 'node tools/zh.js apply --app ' + ctx.appId
    : '无需操作'));
  return 0;
}

// ─────────────────────────────── scan ───────────────────────────────
function cmdScan(ctx) {
  const targets = targetPaths(ctx);
  const patched = isPatched(ctx);
  if (patched && !ctx.args.force) {
    throw new Error('当前文件已经是打过补丁的状态，扫描只会抽到中文。\n先还原：node tools/zh.js restore --app ' + ctx.appId + ' --force');
  }
  const merged = new Map();
  const fileStats = {};
  const nonAsciiByFile = {};
  for (const t of targets) {
    if (!fs.existsSync(t.abs)) { log('跳过（缺失）：' + t.file); continue; }
    const started = Date.now();
    const { entries, seen, nonAscii } = L.scanFile(t.abs, t.label, ctx.rules, { collectNonAscii: true });
    fileStats[t.label] = { file: t.file, bytes: fs.statSync(t.abs).size, literals: seen, values: entries.size, ms: Date.now() - started };
    nonAsciiByFile[t.label] = Object.fromEntries(nonAscii);
    log(t.label.padEnd(14) + ' 字面量 ' + String(seen).padStart(7) + '  去重 ' + String(entries.size).padStart(6) +
      '  自带非 ASCII ' + String(nonAscii.size).padStart(5) + '  ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
    for (const [value, e] of entries) {
      let m = merged.get(value);
      if (!m) { m = { value, ui: 0, risky: 0, other: 0, props: {}, riskyKinds: {}, files: {}, sample: null }; merged.set(value, m); }
      m.ui += e.ui; m.risky += e.risky; m.other += e.other;
      for (const [k, v] of Object.entries(e.props)) m.props[k] = (m.props[k] || 0) + v;
      for (const [k, v] of Object.entries(e.riskyKinds)) m.riskyKinds[k] = (m.riskyKinds[k] || 0) + v;
      if (!m.sample && e.sample) m.sample = e.sample;
      const rf = {};
      for (const [form, rec] of Object.entries(e.raw)) {
        rf[form] = { total: rec.total, ui: rec.ui.length, risky: rec.risky, other: rec.other, uiSpans: rec.ui, allSpans: rec.all };
      }
      m.files[t.label] = { raw: rf };
    }
  }
  const entries = Object.create(null);
  const counts = { auto: 0, context: 0, skip: 0, total: 0 };
  const byFile = {};
  for (const [value, m] of merged) {
    const { safety, natural } = L.classify(m);
    counts[safety]++; counts.total++;
    if (safety !== 'skip') {
      for (const label of Object.keys(m.files)) {
        byFile[label] = byFile[label] || { auto: 0, context: 0 };
        byFile[label][safety]++;
      }
    }
    for (const f of Object.values(m.files)) {
      for (const rec of Object.values(f.raw)) {
        rec.spans = safety === 'auto' ? rec.allSpans : rec.uiSpans;
        delete rec.allSpans; delete rec.uiSpans;
      }
    }
    entries[value] = { value, safety, natural, ui: m.ui, risky: m.risky, other: m.other, props: m.props, riskyKinds: m.riskyKinds, sample: m.sample, files: m.files };
  }
  writeJson(ctx.paths.candidates, {
    generatedAt: new Date().toISOString(),
    app: ctx.appId, appDir: ctx.appDir, version: ctx.info.version, build: ctx.info.commit,
    fileStats, counts, entries, nonAscii: nonAsciiByFile
  });
  log('');
  log('合计去重文案 ' + counts.total + ' 条：auto ' + counts.auto + ' / context ' + counts.context + ' / skip ' + counts.skip);
  log('已写入 ' + ctx.paths.candidates);
  return 0;
}

// ─────────────────────────────── pending / merge ───────────────────────────────
function cmdPending(ctx) {
  const cand = loadCandidates(ctx);
  if (!cand) throw new Error('先运行 scan');
  const tr = loadTranslations(ctx);
  const items = [];
  for (const [value, e] of Object.entries(cand.entries)) {
    if (e.safety === 'skip' && !isPromoted(ctx, value)) continue;
    if (tr[value]) continue;
    items.push({ value, safety: e.safety, props: Object.keys(e.props || {}), sample: e.sample });
  }
  const out = ctx.args.out || ctx.paths.pending;
  writeJson(out, { generatedAt: new Date().toISOString(), app: ctx.appId, version: ctx.info.version, build: ctx.info.commit, count: items.length, items });
  log('待翻译 ' + items.length + ' 条 -> ' + out);
  return 0;
}

function cmdMerge(ctx) {
  const from = ctx.args.from;
  if (!from || from === true) throw new Error('用法：node tools/zh.js merge --app <app> --from <zh.json>');
  const src = readJson(path.resolve(from), null);
  if (!src) throw new Error('读不到 ' + from);
  const incoming = src.translations || src.text || src;
  const tr = loadTranslations(ctx);
  let added = 0, changed = 0;
  const bad = [];
  for (const [k, v] of Object.entries(incoming)) {
    if (typeof v !== 'string' || !v.trim()) { bad.push(k); continue; }
    if (!(k in tr)) added++;
    else if (tr[k] !== v) changed++;
    tr[k] = v;
  }
  // 写回时把覆盖项固化进账本，避免依赖 overrides
  writeJson(ctx.paths.translations, {
    $comment: '英文原文 -> 简体中文。由 agent 翻译生成；按原文索引，跨版本复用。',
    updatedAt: new Date().toISOString(),
    count: Object.keys(tr).length,
    translations: tr
  });
  log('合并完成：新增 ' + added + ' 条，更新 ' + changed + ' 条，账本共 ' + Object.keys(tr).length + ' 条');
  if (bad.length) log('跳过空译文 ' + bad.length + ' 条：' + bad.slice(0, 5).map(x => JSON.stringify(x)).join(', '));
  return 0;
}

// ─────────────────────────────── verify ───────────────────────────────
function cmdVerify(ctx) {
  const cand = loadCandidates(ctx);
  if (!cand) throw new Error('先运行 scan');
  const tr = loadTranslations(ctx);
  const problems = { missing: [], empty: [], placeholder: [], untranslated: [], tooLong: [] };
  let checked = 0;
  for (const [value, e] of Object.entries(cand.entries)) {
    if (e.safety === 'skip' && !isPromoted(ctx, value)) continue;
    checked++;
    const t = tr[value];
    if (!t) { problems.missing.push(value); continue; }
    if (!t.trim()) { problems.empty.push(value); continue; }
    const srcPh = (value.match(PLACEHOLDER_RE) || []).sort().join('|');
    const dstPh = (t.match(PLACEHOLDER_RE) || []).sort().join('|');
    if (srcPh !== dstPh) problems.placeholder.push({ source: value, target: t, srcPh, dstPh });
    if (emojiCount(value) > 0 && emojiCount(t) === 0) problems.placeholder.push({ source: value, target: t, srcPh: 'emoji×' + emojiCount(value), dstPh: 'emoji×0' });
    if (t === value && value.length > 3) problems.untranslated.push(value);
    if (t.length > 120) problems.tooLong.push({ source: value, target: t });
  }
  const md = ['# 译文校验', '', '- 应用：' + ctx.adapter.name + ' ' + ctx.info.version + '（' + String(ctx.info.commit).slice(0, 10) + '）', '- 检查 ' + checked + ' 条', ''];
  const section = (title, list, fmt) => {
    md.push('## ' + title + '（' + list.length + '）', '');
    if (!list.length) { md.push('无', ''); return; }
    for (const item of list.slice(0, 200)) md.push('- ' + (fmt ? fmt(item) : String(item)));
    md.push('');
  };
  section('缺少译文', problems.missing);
  section('空译文', problems.empty);
  section('占位符不一致（硬错误）', problems.placeholder, p => '`' + p.source + '` → `' + p.target + '`（' + p.srcPh + ' vs ' + p.dstPh + '）');
  section('与原文相同（可能漏译）', problems.untranslated);
  section('译文过长（提示）', problems.tooLong, p => '`' + p.source + '` → `' + p.target + '`');
  F.ensureDir(ctx.paths.reports);
  fs.writeFileSync(path.join(ctx.paths.reports, 'verify-report.md'), md.join('\n'), 'utf8');
  log('校验 ' + checked + ' 条：缺译文 ' + problems.missing.length + '，占位符错误 ' + problems.placeholder.length +
    '，疑似漏译 ' + problems.untranslated.length + '，过长 ' + problems.tooLong.length);
  return problems.placeholder.length || problems.missing.length ? 1 : 0;
}

// ─────────────────────────────── plan / apply ───────────────────────────────
function buildPlan(ctx) {
  const cand = loadCandidates(ctx);
  if (!cand) throw new Error('先运行 scan');
  const tr = loadTranslations(ctx);
  const plan = [];
  for (const t of ctx.rules.targets) {
    const items = [];
    for (const [value, e] of Object.entries(cand.entries)) {
      if (e.safety === 'skip' && !isPromoted(ctx, value)) continue;
      const target = tr[value];
      if (!target || target === value) continue;
      const f = e.files[t.label];
      if (!f) continue;
      let replacements = 0;
      for (const rec of Object.values(f.raw)) replacements += (rec.spans || []).length;
      if (!replacements) continue;
      items.push({ value, target, safety: e.safety, replacements });
    }
    plan.push({ label: t.label, file: t.file, items, total: items.reduce((s, i) => s + i.replacements, 0) });
  }
  return { cand, tr, plan };
}

function cmdPlan(ctx) {
  const { plan } = buildPlan(ctx);
  for (const p of plan) log(p.label.padEnd(14) + ' ' + String(p.items.length).padStart(6) + ' 条文案，' + String(p.total).padStart(7) + ' 处替换');
  writeJson(path.join(ctx.paths.reports, 'plan.json'), plan.map(p => ({ label: p.label, items: p.items.length, total: p.total })));
  return 0;
}

function escapeForLiteral(text) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'");
}

function patchText(src, entries, label, promoted) {
  const edits = [];
  for (const [value, e] of entries) {
    if (e.safety === 'skip' && !promoted.has(value)) continue;
    if (!e.__target || e.__target === e.__value) continue;
    const f = e.files[label];
    if (!f) continue;
    for (const [form, rec] of Object.entries(f.raw)) {
      const spans = rec.spans || [];
      if (!spans.length) continue;
      const quote = form[0];
      const repl = quote + escapeForLiteral(e.__target) + quote;
      for (const start of spans) edits.push({ start, end: start + form.length, repl, kind: e.safety });
    }
  }
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const ed of edits) {
    const prev = kept[kept.length - 1];
    if (prev && ed.start < prev.end) {
      if (ed.end - ed.start > prev.end - prev.start) kept[kept.length - 1] = ed;
      continue;
    }
    kept.push(ed);
  }
  let out = src, positional = 0, global = 0;
  for (let i = kept.length - 1; i >= 0; i--) {
    const ed = kept[i];
    out = out.slice(0, ed.start) + ed.repl + out.slice(ed.end);
    if (ed.kind === 'auto') global++; else positional++;
  }
  return { text: out, positional, global };
}

function cmdApply(ctx) {
  const cand = loadCandidates(ctx);
  if (!cand) throw new Error('先运行 scan');
  if (cand.build !== ctx.info.commit && !ctx.args['allow-stale']) {
    throw new Error('扫描快照来自 ' + cand.version + '（' + String(cand.build).slice(0, 10) + '），当前安装是 ' +
      ctx.info.version + '（' + String(ctx.info.commit).slice(0, 10) + '）。\n先重新 scan。');
  }
  const promoted = new Set(Object.keys(loadPromote(ctx)));
  const tr = loadTranslations(ctx);
  const entries = Object.entries(cand.entries).map(([value, e]) => [value, { ...e, __value: value, __target: tr[value] }]);
  const backupDir = path.join(ctx.paths.backups, String(ctx.info.commit).slice(0, 12));
  const manifest = { appliedAt: new Date().toISOString(), app: ctx.appId, version: ctx.info.version, build: ctx.info.commit, appDir: ctx.appDir, files: [], integrity: null };
  let total = 0;

  const integrityPath = integrityFile(ctx);
  let integrity = fs.existsSync(integrityPath) ? JSON.parse(fs.readFileSync(integrityPath, 'utf8')) : null;
  let integrityChanged = false;

  for (const t of targetPaths(ctx)) {
    if (!fs.existsSync(t.abs)) continue;
    const buf = fs.readFileSync(t.abs);
    const stat = cand.fileStats && cand.fileStats[t.label];
    if (stat && buf.length !== stat.bytes) {
      throw new Error(t.file + ' 的大小与扫描时不一致（扫描 ' + stat.bytes + '，现在 ' + buf.length + '）。\n' +
        '应用可能在扫描后被升级或改写。先 restore/scan 再 apply。');
    }
    const patched = patchText(buf.toString('utf8'), entries, t.label, promoted);
    if (!patched.positional && !patched.global) { log(t.label.padEnd(14) + ' 无需替换'); continue; }
    const tmp = t.abs + '.zh-check.mjs';
    fs.writeFileSync(tmp, patched.text, 'utf8');
    const v = validateSyntax(tmp);
    fs.unlinkSync(tmp);
    if (!v.ok) throw new Error(t.file + ' 替换后语法校验失败，已中止：\n' + v.message);

    const rec = F.backupFile(t.abs, backupDir, t.file);
    rec.origSha256 = rec.sha256;
    rec.replacements = patched.positional + patched.global;
    rec.sha256 = F.sha256Hex(Buffer.from(patched.text, 'utf8'));
    F.writeBufAtomic(t.abs, Buffer.from(patched.text, 'utf8'));
    manifest.files.push(rec);
    total += rec.replacements;
    log(t.label.padEnd(14) + ' 已替换 ' + String(rec.replacements).padStart(6) + ' 处');

    if (integrity && t.checksummed && integrity.checksums) {
      const key = checksumKey(ctx, t.file);
      if (Object.prototype.hasOwnProperty.call(integrity.checksums, key)) {
        const after = F.sha256Base64(Buffer.from(patched.text, 'utf8')).replace(/=+$/, '');
        if (integrity.checksums[key] !== after) { integrity.checksums[key] = after; integrityChanged = true; }
      }
    }
  }

  if (integrityChanged) {
    const fresh = JSON.parse(fs.readFileSync(integrityPath, 'utf8'));
    if (fresh.commit !== ctx.info.commit) throw new Error('product.json 在写盘前发生变化，可能正在升级；请重新 scan 再 apply。');
    manifest.integrity = F.backupFile(integrityPath, backupDir, path.basename(integrityPath));
    F.writeBufAtomic(integrityPath, Buffer.from(JSON.stringify(integrity, null, '\t'), 'utf8'));
    log('校验值已同步：' + path.basename(integrityPath));
  }

  writeJson(ctx.paths.applied, manifest);
  writeJson(ctx.paths.lastRun, { finishedAt: new Date().toISOString(), version: ctx.info.version, build: ctx.info.commit, replacements: total });
  log('');
  log('完成：共替换 ' + total + ' 处，涉及 ' + manifest.files.length + ' 个文件');
  for (const note of P.postPatch(ctx.appDir)) log(note);
  log('重启 ' + ctx.adapter.name + ' 生效：' + ctx.adapter.restart);
  return 0;
}

// ─────────────────────────────── audit ───────────────────────────────
function auditFile(ctx, cand, label) {
  const target = ctx.rules.targets.find(t => t.label === label);
  const abs = path.join(ctx.appDir, target.file);
  if (!fs.existsSync(abs)) return { label, ok: false, reason: '文件不存在' };
  const scanned = L.scanFile(abs, label, ctx.rules, { includeCJK: true }).entries;
  const scannedCount = new Map();
  for (const [v, e] of scanned) scannedCount.set(v, e.ui + e.risky + e.other);
  const tr = loadTranslations(ctx);
  const promoted = loadPromote(ctx);
  const expected = new Map();
  for (const [value, e] of Object.entries(cand.entries)) {
    const f = e.files[label];
    if (!f) continue;
    let totalCount = 0;
    for (const rec of Object.values(f.raw)) totalCount += rec.total;
    let replaced = 0;
    const t = tr[value];
    const usable = e.safety !== 'skip' || Object.prototype.hasOwnProperty.call(promoted, value);
    if (usable && t && t !== value) {
      for (const rec of Object.values(f.raw)) replaced += (rec.spans || []).length;
    }
    expected.set(value, (expected.get(value) || 0) + (totalCount - replaced));
    if (replaced) expected.set(t, (expected.get(t) || 0) + replaced);
  }
  const nonAscii = (cand.nonAscii && cand.nonAscii[label]) || {};
  for (const [v, n] of Object.entries(nonAscii)) {
    if (v.length < (ctx.rules.limits && ctx.rules.limits.minLength || 2)) continue;
    expected.set(v, (expected.get(v) || 0) + n);
  }
  const mismatches = [];
  for (const k of new Set([...expected.keys(), ...scannedCount.keys()])) {
    if (k.length < (ctx.rules.limits && ctx.rules.limits.minLength || 2)) continue;
    if (!expected.has(k) && !/^[\x20-\x7E]*$/.test(k)) continue;
    const want = expected.get(k) || 0;
    const got = scannedCount.get(k) || 0;
    if (want !== got) mismatches.push({ value: k, expected: want, actual: got });
  }
  return { label, file: target.file, ok: mismatches.length === 0, checked: expected.size, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 20) };
}

function cmdAudit(ctx) {
  const cand = loadCandidates(ctx);
  if (!cand) throw new Error('先运行 scan');
  let bad = 0;
  const results = [];
  for (const t of ctx.rules.targets) {
    const r = auditFile(ctx, cand, t.label);
    results.push(r);
    if (!r.ok) bad++;
    log('审计 ' + t.label.padEnd(14) + (r.ok ? ' ✓ 一致' : ' ✗ ' + r.mismatchCount + ' 处不一致'));
    if (!r.ok) for (const m of (r.mismatches || []).slice(0, 5)) log('   ' + JSON.stringify(m.value) + ' 期望 ' + m.expected + ' 实际 ' + m.actual);
  }
  writeJson(path.join(ctx.paths.reports, 'audit.json'), results);
  return bad ? 1 : 0;
}

// ─────────────────────────────── restore ───────────────────────────────
function cmdRestore(ctx) {
  const manifest = readJson(ctx.paths.applied, null);
  if (!manifest) throw new Error('没有 applied.json，找不到备份');
  if (manifest.build !== ctx.info.commit && !ctx.args['allow-stale']) {
    throw new Error('备份来自 ' + manifest.version + '（' + String(manifest.build).slice(0, 10) + '），当前是 ' +
      ctx.info.version + '（' + String(ctx.info.commit).slice(0, 10) + '）。升级已覆盖文件，不需要 restore。');
  }
  for (const rec of manifest.files) { F.restoreFromBackup(rec); log('已还原 ' + rec.file); }
  if (manifest.integrity) { F.restoreFromBackup(manifest.integrity); log('已还原 ' + manifest.integrity.file); }
  fs.renameSync(ctx.paths.applied, ctx.paths.applied.replace(/\.json$/, '.restored.json'));
  log('还原完成。重启 ' + ctx.adapter.name + ' 生效。');
  return 0;
}

// ─────────────────────────────── detect ───────────────────────────────
function cmdDetect(ctx) {
  const versions = readJson(path.join(ctx.appDefDir, 'versions.json'), { versions: [] }).versions || [];
  const hit = versions.find(v => v.build === ctx.info.commit) ||
    versions.find(v => v.version === ctx.info.version);
  log(ctx.adapter.name + '       ' + ctx.info.version + '  (build ' + String(ctx.info.commit).slice(0, 10) + ')');
  log('应用目录     ' + ctx.appDir);
  log('数据目录     ' + ctx.dataDir);
  if (hit) log('版本矩阵     ' + hit.status + '（验证于 ' + (hit.verifiedAt || '—') + '，目标 ' + (hit.targets || '?') + ' 个文件）');
  else log('版本矩阵     未收录这个版本，将用通用规则扫描，结果标记为 unverified');
  const patched = isPatched(ctx);
  log('当前状态     ' + (patched ? '已打补丁（' + patched + '/' + ctx.rules.targets.length + ') ' : '原文（未打补丁）'));
  if (ctx.args.json) log(JSON.stringify({ app: ctx.appId, version: ctx.info.version, build: ctx.info.commit, appDir: ctx.appDir, dataDir: ctx.dataDir, matrix: hit || null, patched }));
  return 0;
}
const COMMANDS = {
  doctor: cmdDoctor,
  detect: cmdDetect,
  status: cmdStatus,
  scan: cmdScan,
  pending: cmdPending,
  merge: cmdMerge,
  verify: cmdVerify,
  plan: cmdPlan,
  apply: cmdApply,
  audit: cmdAudit,
  restore: cmdRestore
};

function run(argv) {
  const cmd = argv[0];
  if (!cmd || !COMMANDS[cmd]) {
    log('用法：node tools/zh.js <doctor|status|scan|pending|merge|verify|plan|apply|audit|restore> --app <cursor|devin> [--data <dir>] [--app-dir <dir>]');
    return 2;
  }
  const ctx = C.buildContext(argv.slice(1));
  try {
    return COMMANDS[cmd](ctx);
  } catch (err) {
    console.error('\n[失败] ' + err.message);
    return 3;
  }
}

module.exports = { run, loadTranslations, buildPlan, patchText, loadPromote };
