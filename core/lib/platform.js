'use strict';
/**
 * 平台差异：进程检测、macOS 重新签名。应用名由适配层传入。
 */
const { execFileSync, spawnSync } = require('child_process');

function isRunning(processName) {
  if (!processName) return false;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq ' + processName, '/NH'], { encoding: 'utf8' });
      return out.toLowerCase().includes(processName.toLowerCase());
    }
    const bare = processName.replace(/\.exe$/i, '');
    const out = execFileSync('pgrep', ['-f', bare], { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function appBundleFromAppDir(appDir) {
  const m = String(appDir).match(/^(.*\.app)[\\/]Contents[\\/]Resources[\\/]app[\\/]?$/);
  return m ? m[1] : null;
}

/** macOS 改动 .app 内的文件会使签名失效，必须重新 ad-hoc 签名。 */
function postPatch(appDir) {
  const notes = [];
  if (process.platform !== 'darwin') return notes;
  const app = appBundleFromAppDir(appDir);
  if (!app) {
    notes.push('未识别出 .app 路径，跳过签名修复；若无法启动请手动执行：');
    notes.push('  xattr -cr <App>.app && codesign --force --deep --sign - <App>.app');
    return notes;
  }
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
  };
  const x = run('xattr', ['-cr', app]);
  notes.push('清隔离属性：xattr -cr ' + app + ' → ' + (x.ok ? 'ok' : '失败：' + x.out.slice(0, 160)));
  const c = run('codesign', ['--force', '--deep', '--sign', '-', app]);
  notes.push('重新签名：codesign --force --deep --sign - ' + app + ' → ' + (c.ok ? 'ok' : '失败：' + c.out.slice(0, 160)));
  if (c.ok) {
    const v = run('codesign', ['--verify', '--deep', '--strict', app]);
    notes.push('签名校验 → ' + (v.ok ? 'ok' : '未通过：' + v.out.slice(0, 160)));
  }
  return notes;
}

module.exports = { isRunning, postPatch, appBundleFromAppDir };
