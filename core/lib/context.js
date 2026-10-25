'use strict';
/**
 * 运行上下文：解析命令行参数、加载应用适配层、定位安装目录、确定数据目录。
 * 引擎本身不认识任何具体应用，差异全在 apps/<app>/adapter.json。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
  }
  return out;
}

function readJson(file, def) {
  if (!fs.existsSync(file)) return def;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function expand(p) {
  return path.normalize(String(p)
    .replace(/%([^%]+)%/g, (_, k) => process.env[k] || '')
    .replace(/^~(?=$|[\\/])/, os.homedir()));
}

function isAppDir(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, 'product.json')) &&
    fs.existsSync(path.join(dir, 'out'));
}

function fromCommandOnPath(exe) {
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(cmd, [exe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (!p) continue;
      const idx = p.replace(/\//g, '\\').toLowerCase().indexOf('\\resources\\app\\');
      if (idx !== -1) return p.slice(0, idx) + '\\resources\\app';
    }
  } catch { /* 找不到就算了 */ }
  return null;
}

function fromRegistry(appName) {
  if (process.platform !== 'win32') return null;
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];
  for (const key of keys) {
    let dump;
    try {
      dump = execFileSync('reg.exe', ['query', key, '/s', '/f', appName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { continue; }
    for (const block of dump.split(/\r?\n\r?\n/)) {
      if (!new RegExp('DisplayName\\s+REG_SZ\\s+' + appName, 'i').test(block)) continue;
      const m = block.match(/InstallLocation\s+REG_SZ\s+(.+)/i);
      if (!m) continue;
      const appDir = path.join(m[1].trim().replace(/\\+$/, ''), 'resources', 'app');
      if (isAppDir(appDir)) return appDir;
    }
  }
  return null;
}

function detectAppDir(adapter, explicit) {
  const tried = [];
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.AGENT_ZH_APP_DIR) candidates.push(process.env.AGENT_ZH_APP_DIR);
  const dirs = (adapter.appDirs && (adapter.appDirs[process.platform] || [])) || [];
  candidates.push(...dirs.map(expand));
  if (adapter.command) candidates.push(fromCommandOnPath(adapter.command));
  candidates.push(fromRegistry(adapter.displayName || adapter.name));
  for (const c of candidates) {
    if (!c) continue;
    tried.push(c);
    if (isAppDir(c)) return { appDir: c, tried };
  }
  const err = new Error(
    '找不到 ' + adapter.name + ' 的应用目录（resources/app）。已尝试：\n  ' + tried.join('\n  ') +
    '\n用 --app-dir="<安装目录>/resources/app" 或环境变量 AGENT_ZH_APP_DIR 指定。');
  err.tried = tried;
  throw err;
}

function describe(appDir, adapter) {
  const productPath = path.join(appDir, 'product.json');
  const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
  const pkgPath = path.join(appDir, adapter.version.packageJson || 'package.json');
  const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : {};
  const version = pkg[adapter.version.field || 'version'] || product.version;
  const buildField = adapter.version.build && adapter.version.build.field;
  const buildFile = adapter.version.build && adapter.version.build.file;
  let commit = null;
  if (buildField) {
    const file = buildFile && buildFile !== 'product.json' ? path.join(appDir, buildFile) : productPath;
    const data = file === productPath ? product : readJson(file, {});
    commit = data[buildField] || null;
  }
  return { appDir, productPath, version, commit, product, pkg };
}

function expandTargets(adapter, appDir) {
  const out = [];
  for (const t of adapter.targets || []) {
    if (!t.glob) { out.push(t); continue; }
    const base = path.dirname(t.glob);
    const pattern = path.basename(t.glob);
    const dir = path.join(appDir, base);
    if (!fs.existsSync(dir)) continue;
    const parts = pattern.split('*').map(function (part) {
      return part.replace(/[.*+?^${}()|[\]\\]/g, function (m) { return '\\' + m; });
    });
    const re = new RegExp('^' + parts.join('.*') + '$');
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort(function (a, b) { return a.name.localeCompare(b.name); })) {
      if (!e.isFile()) continue;
      if (!re.test(e.name)) continue;
      const rel = path.posix.join(base.split(path.sep).join('/'), e.name);
      out.push({ label: (t.labelPrefix || 'file__') + e.name.replace(/[^A-Za-z0-9_-]/g, '_'), file: rel, checksummed: false, textValues: Boolean(t.textValues) });
    }
  }
  return out;
}

function buildContext(argv) {
  const args = parseArgs(argv);
  const appId = args.app || 'cursor';
  const appDefDir = path.join(ROOT, 'apps', appId);
  if (!fs.existsSync(appDefDir)) {
    throw new Error('未知应用：' + appId + '（可用：' + fs.readdirSync(path.join(ROOT, 'apps')).join(', ') + '）');
  }
  const adapter = readJson(path.join(appDefDir, 'adapter.json'));
  const rules = readJson(path.join(appDefDir, 'rules.json'), {});
  const { appDir: detected, tried } = detectAppDir(adapter, args['app-dir'] || null);
  rules.targets = expandTargets(adapter, detected);
  const glossary = readJson(path.join(appDefDir, 'glossary.json'), { terms: {} });

  const dataBase = path.resolve(expand(args.data || path.join(os.homedir(), '.agent-zh')));
  const dataDir = path.join(dataBase, appId);

  const appDir = detected;
  const info = describe(appDir, adapter);

  return {
    args,
    appId,
    adapter,
    rules,
    glossary,
    appDefDir,
    appDir,
    tried,
    info,
    dataBase,
    dataDir,
    paths: {
      candidates: path.join(dataDir, 'candidates.json'),
      translations: path.join(dataDir, 'translations.json'),
      translationsLegacy: path.join(dataDir, 'translations.zh.json'),
      overrides: path.join(dataDir, 'overrides.json'),
      promote: path.join(dataDir, 'promote.json'),
      applied: path.join(dataDir, 'applied.json'),
      lastRun: path.join(dataDir, 'last-run.json'),
      pending: path.join(dataDir, 'pending.json'),
      reports: path.join(dataDir, 'reports'),
      backups: path.join(dataDir, 'backups')
    }
  };
}

module.exports = { ROOT, buildContext, parseArgs, readJson, isAppDir, describe, expand };
