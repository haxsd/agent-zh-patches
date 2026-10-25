'use strict';
/**
 * 字面量扫描与安全分类 —— 整个工具的安全边界都在这里。
 *
 * 思路：
 * 1) 用正则扫出文件里所有单/双引号与模板字面量。
 * 2) 看每个字面量**前面 90 个字符**判断它处在什么上下文：
 *      ui      —— label: / title: / description: 这类 UI 字段的值
 *      id      —— id: / key: / type: / command: 这类功能性字段的值
 *      key     —— 对象键、数组元素（[...] 或 {...} 后面）
 *      compare —— === / case / switch 里
 *      method  —— .includes(...) / .test(...) / .replace(...) 等
 *      dom     —— querySelector / classList / dataset 等
 *      code    —— return / typeof / new 等
 *      other   —— 其余
 * 3) 按统计结果给出安全等级：
 *      auto    —— 出现位置全是 UI，且是自然语言（含空格）。可以全局替换。
 *      context —— 只在 ui 上下文的那几处替换（用于单词标签，如 "Agent"）。
 *      skip    —— 从不出现于 UI，或长得像功能性标识。
 */
const fs = require('fs');

const LITERAL_RE = /"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

function decodeLoose(raw) {
  const body = raw.slice(1, -1);
  return body
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; }
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function hasCJK(s) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(s);
}

/** 看起来像代码/标识/路径/快捷键，而不是给人看的文案 */
function looksLikeCode(v) {
  // NLS message key（VS Code 的 %key% 形式）：不是界面文案
  if (/^%[A-Za-z0-9_.-]+%$/.test(v)) return true;
  if (/^[\w$./\\:@#%&?=~+*<>|^!,;()\[\]{}-]+$/.test(v) && !/\s/.test(v)) return true; // 无空格的单 token
  if (/:\/\//.test(v)) return true;
  if (/^[./\\]/.test(v)) return true;
  if (/^[\w-]+(\.[\w-]+)+$/.test(v)) return true;                     // a.b.c / foo-bar.baz
  if (/^[0-9a-fA-F]{3,8}$/.test(v)) return true;                      // 颜色/哈希
  if (/^(Ctrl|Cmd|Alt|Shift|Meta|Option|Super)([+-](Ctrl|Cmd|Alt|Shift|Meta|Option|Super|[A-Za-z0-9]|F\d{1,2}))+$/.test(v)) return true;
  if (/^(https?|file|vscode|cursor|mailto|data):/.test(v)) return true;
  if (/^[a-z][a-zA-Z0-9]*$/.test(v)) return true;                     // camelCase 单词
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(v)) return true;                // kebab-case
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(v)) return true;                // snake_case
  if (/^[A-Z0-9_]+$/.test(v)) return true;                            // CONSTANT
  if (/[{}<>$]/.test(v)) return true;                                 // 插值/模板残留
  if (/^[\d\s.,:;/\\-]+$/.test(v)) return true;                       // 纯数字标点
  if (!/[A-Za-z]/.test(v)) return true;                               // 没有拉丁字母
  return false;
}

const KIND_UI = 'ui';
const KIND_ID = 'id';
const KIND_KEY = 'key';
const KIND_COMPARE = 'compare';
const KIND_METHOD = 'method';
const KIND_DOM = 'dom';
const KIND_CODE = 'code';
const KIND_OTHER = 'other';

function looksNaturalText(v) {
  if (v.length < 3 || v.length > 200) return false;
  if (!/[A-Za-z]/.test(v)) return false;
  if (!/[a-z]{2,}/.test(v)) return false;            // 至少一个正常单词（排除 SVG 路径、缩写串）
  if (/[\/{}\\]/.test(v)) return false;             // 路径/URL/模板片段
  if (/^[a-z][a-zA-Z0-9_$]*$/.test(v)) return false;   // 单个小写标识符
  if (/^[A-Z0-9_]+$/.test(v)) return false;            // 常量
  if (/^[MLHVCSQTAZ][0-9\s.,-]+$/i.test(v)) return false; // SVG path
  if (/=>|::|;\s*$/.test(v)) return false;
  if (looksLikeCode(v)) return false;
  const t = v.trim();
  if (/^[A-Za-z]/.test(t) && t.split(/\s+/).length >= 2) return true;
  if (/^[A-Z][a-zA-Z]+$/.test(t) && t.length >= 4) return true;
  return false;
}
function buildClassifiers(rules) {
  // 属性名识别分两层：
  //   uiProps         —— 精确匹配（label / title / description …）
  //   uiPropSuffixes  —— 后缀匹配，用来覆盖带前缀的属性名
  //                      （autoUsageBarLabel、settingsButtonTitle、apiDescription …）
  // 后缀清单只收「展示语义」的词；像 Text 这种混着功能值的后缀（sortText /
  // searchText / newText）不列入，否则会把排序、过滤、差异内容当成文案翻译。
  const esc = (list) => list.join('|').replace(/[-]/g, '\\-');
  const uiParts = rules.uiProps.slice();
  for (const s of rules.uiPropSuffixes || []) uiParts.push('\\w{2,28}' + s);
  const ui = esc(uiParts);
  const id = esc(rules.idProps);
  const uiRe = new RegExp('(?:^|[^\\w$.-])(' + ui + ')\\s*:\\s*$');
  const idRe = new RegExp('(?:^|[^\\w$.-])(' + id + ')\\s*:\\s*$');
  return (prefix) => {
    let m = prefix.match(uiRe);
    if (m) return { kind: KIND_UI, prop: m[1] };
    m = prefix.match(idRe);
    if (m) return { kind: KIND_ID, prop: m[1] };
    if (/[{,[]\s*$/.test(prefix)) return { kind: KIND_KEY };
    if (/(?:===|!==|==|!=|<=|>=|<|>)\s*$/.test(prefix)) return { kind: KIND_COMPARE };
    if (/\b(?:case|switch)\b[^;]{0,40}$/.test(prefix)) return { kind: KIND_COMPARE };
    if (/\.\s*(?:includes|startsWith|endsWith|indexOf|lastIndexOf|match|matchAll|test|split|replace|replaceAll|localeCompare|trim|toLowerCase|toUpperCase|padStart|padEnd|charAt|concat)\s*\(\s*[^)]*$/.test(prefix)) return { kind: KIND_METHOD };
    if (/(?:getElementById|querySelector|querySelectorAll|createElement|classList|setAttribute|getAttribute|dataset|localStorage|sessionStorage|appendChild)\b[^;]{0,40}$/.test(prefix)) return { kind: KIND_DOM };
    if (/\b(?:return|typeof|instanceof|new|delete|throw|in|of)\s*$/.test(prefix)) return { kind: KIND_CODE };
    if (/[A-Za-z0-9_$)\]]\s*$/.test(prefix) && /\(\s*$/.test(prefix)) return { kind: KIND_METHOD };
    return { kind: KIND_OTHER };
  };
}

function cleanSnippet(s) {
  return s.replace(/\s+/g, ' ').trim().slice(0, 100);
}

/**
 * 扫一个文件。
 * @returns {Map<string, entry>}  key = 解码后的文案
 */
function scanFile(absPath, label, rules, opts) {
  const options = opts || {};
  const src = fs.readFileSync(absPath, 'utf8');
  const lookback = rules.limits.contextLookback;
  const minLen = rules.limits.minLength;
  const maxLen = rules.limits.maxLength;
  const classify = buildClassifiers(rules);
  const entries = new Map();
  const nonAscii = new Map();   // 原文自带的非 ASCII 字面量（审计用）

  // JSON.parse(`...`) 消息表：把两端的反引号替换为空格，让内部字符串成为候选
  const blobMasks = [];
  {
    const re = /JSON\.parse\(\s*`/g;
    let bm;
    while ((bm = re.exec(src)) !== null) {
      let k = bm.index + bm[0].length;
      let close = -1;
      for (; k < src.length; k++) {
        if (src[k] === '\\') { k++; continue; }
        if (src[k] === '`') { close = k; break; }
      }
      if (close > 0) blobMasks.push([bm.index + bm[0].length - 1, close]);
    }
  }

  // 含插值的模板字符串整体屏蔽（等长替换为空格），避免把内部代码当文案
  const masked = src.replace(/`(?:\\.|[^`\\])*`/g, function (tpl) {
    return tpl.indexOf('${') === -1 ? tpl : '`' + ' '.repeat(tpl.length - 2) + '`';
  });

  // 消息表两端反引号置空，让内部 "..." 参与匹配
  let masked2 = masked;
  if (blobMasks.length) {
    const chars = masked2.split('');
    for (const r of blobMasks) {
      if (chars[r[0]] === '`') chars[r[0]] = ' ';
      if (chars[r[1]] === '`') chars[r[1]] = ' ';
    }
    masked2 = chars.join('');
  }
  LITERAL_RE.lastIndex = 0;
  let m;
  let seen = 0;

  // 1) 先收集所有字面量匹配
  const matches = [];
  while ((m = LITERAL_RE.exec(masked2)) !== null) {
    const st = m.index, en = st + m[0].length;
    matches.push({ start: st, end: en, raw: src.slice(st, en) });
  }
  LITERAL_RE.lastIndex = 0;

  // 2) 丢掉嵌套在另一个字面量内部的匹配。
  //    单引号字符串里出现的 "双引号片段" 会被正则当成独立字面量，这类内层假匹配
  //    既不该被翻译，也会和外壳的替换打架，所以只保留最外层。
  const outer = [];
  let lastEnd = -1;
  for (const mt of matches) {
    if (mt.start < lastEnd) continue;
    outer.push(mt);
    lastEnd = mt.end;
  }

  for (const mt of outer) {
    const raw = mt.raw;
    const bodyLen = raw.length - 2;
    if (bodyLen < minLen || bodyLen > maxLen) continue;
    const body = raw.slice(1, -1);
    if (body.includes('${') || body.includes('\\n') || body.includes('\\t')) continue;
    const value = decodeLoose(raw);
    if (!value) continue;
    if (hasCJK(value) && !options.includeCJK) {
      // 原文自带的中文（Cursor 自己的多语言文案）：记录清单供审计使用，不参与翻译
      if (options.collectNonAscii) nonAscii.set(value, (nonAscii.get(value) || 0) + 1);
      continue;
    }
    if (/[\r\n]/.test(value)) continue;
    if (/^%[A-Za-z0-9_.-]+%$/.test(value)) continue;   // NLS 消息键不是界面文案
    if (value.indexOf('\\"') !== -1 || value.indexOf('\":\"') !== -1) continue;   // 嵌套 JSON 片段
    if (value.indexOf('`') !== -1) continue;   // 模板字符串片段
    seen++;

    const start = mt.start;
    const prefix = masked.slice(Math.max(0, start - lookback), start);
    const cls = classify(prefix);
    let kind = cls.kind, prop = cls.prop;
    if ((options.textValues || rules.textValues) && kind !== KIND_UI && kind !== KIND_ID && kind !== KIND_COMPARE &&
        kind !== KIND_METHOD && kind !== KIND_DOM && looksNaturalText(value)) {
      kind = KIND_UI; prop = 'textValue';
    }

    let e = entries.get(value);
    if (!e) {
      e = {
        value,
        ui: 0, risky: 0, other: 0,
        props: {}, riskyKinds: {},
        raw: {},
        sample: null,
      };
      entries.set(value, e);
    }
    let rec = e.raw[raw];
    if (!rec) { rec = { total: 0, ui: [], all: [], risky: 0, other: 0 }; e.raw[raw] = rec; }
    rec.total++;
    rec.all.push(start);

    if (kind === KIND_UI) {
      e.ui++;
      rec.ui.push(start);
      e.props[prop] = (e.props[prop] || 0) + 1;
      if (!e.sample) {
        e.sample = {
          file: label,
          prop: prop,
          before: cleanSnippet(src.slice(Math.max(0, start - 70), start)),
          after: cleanSnippet(src.slice(start + raw.length, start + raw.length + 70)),
        };
      }
    } else if (kind === KIND_OTHER) {
      e.other++;
      rec.other++;
    } else {
      e.risky++;
      rec.risky++;
      e.riskyKinds[kind] = (e.riskyKinds[kind] || 0) + 1;
    }
  }
  return { src, entries, seen, nonAscii };
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'in', 'on', 'at', 'to', 'of', 'for', 'with', 'and', 'or', 'if', 'is', 'are',
  'was', 'were', 'be', 'by', 'as', 'it', 'its', 'this', 'that', 'these', 'those', 'from', 'via',
  'not', 'no', 'yes', 'you', 'your', 'we', 'our', 'i', 'me', 'my', 'he', 'she', 'they', 'them',
]);

/** 汇总多个文件的扫描结果，给出安全等级 */
function classify(entry) {
  const v = entry.value;
  const hasSpace = /\s/.test(v);
  const natural = hasSpace && !looksLikeCode(v);
  let safety;
  if (entry.ui === 0) safety = 'skip';
  else if (entry.risky === 0 && natural) safety = 'auto';
  else if (looksLikeCode(v) && entry.ui === 0) safety = 'skip';
  else safety = 'context';
  if (/^(Ctrl|Cmd|Alt|Shift|Meta|Option|Super)[+-]/.test(v)) safety = 'skip';
  if (/^[\w.+-]+@[\w.-]+$/.test(v)) safety = 'skip';
  // 句子碎片与错误码：单行小写标识符（internal_error、agent）、单个虚词
  if (!hasSpace && /^[a-z][a-z0-9_]*$/.test(v)) safety = 'skip';
  if (!hasSpace && STOPWORDS.has(v.toLowerCase())) safety = 'skip';
  if (/^[\d\s.,:;/\\%+\-·•–—]+$/.test(v)) safety = 'skip';
  // CSS 类名 / 驼峰 / kebab / snake 片段，不该当成界面文案
  if (/^[a-z]+(-[a-zA-Z0-9]+)+$/.test(v)) safety = 'skip';
  if (/^[a-z]+[A-Z][a-zA-Z0-9]*$/.test(v)) safety = 'skip';
  if (/^[a-z0-9]+([-_][a-z0-9]+)+$/.test(v)) safety = 'skip';
  return { safety, natural };
}

module.exports = { scanFile, classify, decodeLoose, looksLikeCode, hasCJK, cleanSnippet };
