/*!
 * core.js —— 号码整理核心规则引擎
 * 无任何依赖，浏览器（window.OCRCore）与 Node（require）通用。
 *
 * 规则速查：
 *   1. 只允许 0-9 与 X，+ * x × 等一律转写为大写 X
 *   2. 4 位：纯数字，或含 1~2 个 X（XXX4 / XXXX 非法）
 *   3. 3 位：只允许纯数字（X23 / XX3 非法）
 *   4. 其它位数（含 12345、12345678）一律判为异常，不自动拆分
 *   5. 允许前导 0，号码按字符串处理
 *   6. 可选后缀 =N，N 为 0 / 正整数 / 正小数，不允许负数
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OCRCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 会被转写成 X 的字符（含全角、数学符号、西里尔字母形近字） */
  var X_LIKE = /[xX×✕✖✗╳＊*＋+хХ]/g;
  /** 所有标点、符号和空白均可分隔；保留后缀等号，X 类字符已提前归一化。 */
  var SEPARATOR = /(?:(?!=)[\p{P}\p{S}\s])+/u;
  /**
   * 行首的序号标记，如 "1. "、"2) "、"(3) "、"4、 "。
   * 注意：裸数字只允许 1~2 位 —— 1~2 位本身永远不是合法号码，
   * 因此剥离它们绝不会丢掉有效数据；"123. 456" 这类 3 位号码不会被误剥离。
   */
  var ENUM_PREFIX = /^\s{0,3}(?:[(（]\s*\d{1,3}\s*[)）]\s*|\d{1,2}\s*[.)）、]\s*)/;
  var WRAP_HEAD = /^[（(\[【<《「『"'`]+/;
  var WRAP_TAIL = /[）)\]】>》」』"'`]+$/;

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  function toHalfWidth(s) {
    return String(s)
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
      .replace(/[ｘＸ]/g, function (c) { return c === 'ｘ' ? 'x' : 'X'; })   // 全角 x / X
      .replace(/[＝]/g, '=')
      .replace(/[？]/g, '?');
  }

  /** 把 + * x 等统一成大写 X，并归一化 '=' 两侧空白 */
  function normalizeChars(text) {
    var t = toHalfWidth(text == null ? '' : text);
    t = t.replace(/[ \t]*=[ \t]*/g, '=');          // 先收掉 '=' 两侧空白
    // 再转 X；例外：紧跟 '=' 的 '+' 是「正数」号（=+2 读作 =2），不能当成 X
    t = t.replace(X_LIKE, function (c, offset, all) {
      return (c === '+' && all[offset - 1] === '=') ? '+' : 'X';
    });
    return t;
  }

  function countX(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) if (s[i] === 'X') n++;
    return n;
  }

  function isPureDigits(s) { return /^[0-9]+$/.test(s); }
  function isPure4(s) { return /^[0-9]{4}$/.test(s); }

  /* ------------------------------------------------------------------ *
   * 校验
   * ------------------------------------------------------------------ */

  /** 校验号码部分，返回 { ok, reason } */
  function validateNumber(num) {
    var s = String(num == null ? '' : num).trim();
    if (!s) return { ok: false, reason: '号码为空' };
    if (s.indexOf('?') >= 0) return { ok: false, reason: '存在识别存疑字符「?」，请核对后修正' };
    if (!/^[0-9X]+$/.test(s)) {
      var bad = [];
      for (var i = 0; i < s.length; i++) {
        if (!/[0-9X]/.test(s[i]) && bad.indexOf(s[i]) < 0) bad.push(s[i]);
      }
      return { ok: false, reason: '含非法字符「' + bad.join(' ') + '」，只允许 0-9 和 X' };
    }
    var len = s.length, xc = countX(s);
    if (len === 4) {
      if (xc >= 3) return { ok: false, reason: '4 位号码最多允许 2 个 X（当前 ' + xc + ' 个）：' + s };
      return { ok: true, reason: '' };
    }
    if (len === 3) {
      if (xc > 0) return { ok: false, reason: '3 位号码只允许纯数字，不允许 X：' + s };
      return { ok: true, reason: '' };
    }
    if (len > 4) {
      return { ok: false, reason: '共 ' + len + ' 位，超过 4 位；若图片中是连续数字，请自行确认怎么分组：' + s };
    }
    return { ok: false, reason: '共 ' + len + ' 位，少于 3 位：' + s };
  }

  /** 校验 =N 后缀，返回 { ok, value, reason } */
  function validateSuffix(n) {
    var s = String(n == null ? '' : n).trim();
    if (!s) return { ok: false, reason: '「=」后面缺少数值' };
    if (/^[-−—]/.test(s)) return { ok: false, reason: '数值不允许为负数：=' + s };
    var t = s.replace(/^\+/, '');
    if (/^\d+\.$/.test(t)) t = t.slice(0, -1);
    if (/^\.\d+$/.test(t)) t = '0' + t;
    if (!/^\d+(\.\d+)?$/.test(t)) {
      return { ok: false, reason: '数值只能是 0、正整数或正小数（不允许负数）：=' + s };
    }
    return { ok: true, value: t, reason: '' };
  }

  /* ------------------------------------------------------------------ *
   * 解析
   * ------------------------------------------------------------------ */

  function makeError(raw, number, suffix, reason) {
    return {
      raw: raw,
      number: number,
      suffix: suffix == null ? null : suffix,
      status: 'error',
      reason: reason,
      text: raw
    };
  }

  /** 解析单个分组，无法解析时返回 null */
  function parseGroup(raw) {
    var original = String(raw == null ? '' : raw);
    var s = original.trim();
    s = s.replace(ENUM_PREFIX, '');
    s = s.replace(WRAP_HEAD, '').replace(WRAP_TAIL, '');
    s = s.replace(/[.。·]+$/, '');
    if (!s) return null;

    var number = s, suffix = null, eq = s.indexOf('=');
    if (eq >= 0) {
      number = s.slice(0, eq).trim();
      suffix = s.slice(eq + 1).trim();
      if (suffix.indexOf('=') >= 0) {
        return makeError(original, number, suffix, '出现了多个「=」，一组号码只能有一个后缀');
      }
    }

    var nv = validateNumber(number);
    if (!nv.ok) return makeError(original, number, suffix, nv.reason);

    var sfx = null;
    if (suffix !== null) {
      var sv = validateSuffix(suffix);
      if (!sv.ok) return makeError(original, number, suffix, sv.reason);
      sfx = sv.value;
    }

    return {
      raw: original,
      number: number,
      suffix: sfx,
      status: 'ok',
      reason: '',
      text: number + (sfx === null ? '' : '=' + sfx)
    };
  }

  /**
   * 把 =N 后缀里的小数点先藏起来。
   * 因为「.」现在是分组分隔符（8103.6583.5583 → 3 组），
   * 不保护的话 1234=2.5 会被切成 1234=2 和 5。
   */
  function protectSuffixDots(text) {
    var store = [];
    var out = normalizeChars(text).replace(/=\s*([+-]?[0-9]+(?:\.[0-9]+)?(?:[（(]元[）)])?)/g, function (m, num) {
      store.push(num);
      return '=\u0001' + (store.length - 1) + '\u0001';
    });
    return { text: out, store: store };
  }

  function restoreSuffixDots(str, store) {
    // 占位符可能在切掉「=」之后单独出现（例如提示里只留后缀），所以不要求前面有 =
    return String(str).replace(/\u0001(\d+)\u0001/g, function (m, i) {
      return store[+i] != null ? store[+i] : '';
    });
  }

  /** 逐行剥离行首序号标记（"1. 1234" → "1234"） */
  function stripEnumerators(text) {
    return String(text == null ? '' : text).split('\n').map(function (line) {
      return line.replace(ENUM_PREFIX, '');
    }).join('\n');
  }

  /**
   * 解析整段文本
   * @returns {{groups:Array, okCount:number, errorCount:number, isEmpty:boolean}}
   */
  function parseText(text) {
    var guard = protectSuffixDots(text);
    var normalized = stripEnumerators(normalizeChars(guard.text));
    var parts = normalized.split(SEPARATOR);
    var groups = [];
    for (var i = 0; i < parts.length; i++) {
      var g = parseGroup(restoreSuffixDots(parts[i], guard.store));
      if (g) groups.push(g);
    }
    var okCount = 0, errorCount = 0;
    groups.forEach(function (g) { g.status === 'ok' ? okCount++ : errorCount++; });
    return {
      groups: groups,
      okCount: okCount,
      errorCount: errorCount,
      isEmpty: groups.length === 0
    };
  }

  /**
   * OCR 专用过滤：只留下符合规则的 3~4 位号码组合，其余内容丢掉。
   *
   * 规则：
   *   1. 先把 + * x × 归一成 X、全角转半角
   *   2. 每行第一个「=」后面的内容视为算式结果，整段丢弃
   *      —— 例如「42×4=168（元）」只留「42×4」
   *   3. 按空白/标点切成片段，每段里的连续 数字/X 串必须是完整合法的 3~4 位号码才算数
   *      —— 「12345」这种连续 5 位不会被截成 1234，整段丢弃，避免错误拆分
   *   4. 找不到合法号码的片段整段丢弃，并记进 dropped，方便用户回看
   *
   * @returns {{groups:string[], dropped:string[], suspect:string[]}}
   *          suspect = 看起来像号码但位数不对的片段（多半是把大括号/横线读成了数字）
   */
  function extractGroups(text) {
    var groups = [], dropped = [], suspect = [];
    var guard = protectSuffixDots(text);
    guard.text.split(/\r?\n/).forEach(function (rawLine) {
      var line = normalizeChars(rawLine);
      var eq = line.indexOf('=');
      if (eq >= 0) {
        var tail = restoreSuffixDots(line.slice(eq + 1).trim(), guard.store);   // 还原被保护的小数点，别把占位符露给用户
        if (tail) dropped.push(tail);
        line = line.slice(0, eq);
      }
      line.split(SEPARATOR).forEach(function (token) {
        var t = token.trim();
        if (!t) return;
        var runs = t.match(/[0-9X]+/g) || [];
        var hit = '';
        for (var i = 0; i < runs.length; i++) {
          if (validateNumber(runs[i]).ok) { hit = runs[i]; break; }
        }
        if (hit) {
          groups.push(hit);
        } else {
          dropped.push(t);
          var runs2 = t.match(/[0-9X]+/g) || [];
          var maxLen = runs2.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
          // 里面有 3 个以上的数字/X：像号码但读错了（位数超标、X 太多等）
          if (maxLen >= 3) suspect.push(t);
        }
      });
    });
    return { groups: groups, dropped: dropped, suspect: suspect };
  }

  /**
   * 对「疑似误读」的片段给出修正建议（只是建议，不自动改）。
   * 手写纸上最常见的误读是把右边的大括号「}」读成数字，导致 4 位变 5 位，
   * 所以优先尝试「去掉末尾 1 位 / 2 位」，再尝试「去掉开头 1 位 / 2 位」。
   * 位数差得太多（≥7 位）就不猜了。
   * @returns {string|null}
   */
  function suggestFix(text) {
    var runs = String(text == null ? '' : text).match(/[0-9X]+/g);
    if (!runs) return null;
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (r.length < 5 || r.length > 6) continue;
      var cuts = [];
      for (var c = 1; c <= 2; c++) cuts.push(['tail', c]);
      for (var c2 = 1; c2 <= 2; c2++) cuts.push(['head', c2]);
      for (var k = 0; k < cuts.length; k++) {
        var side = cuts[k][0], n = cuts[k][1];
        var cand = side === 'tail' ? r.slice(0, r.length - n) : r.slice(n);
        if (cand.length >= 3 && cand.length <= 4 && validateNumber(cand).ok) return cand;
      }
    }
    return null;
  }

  /**
   * 格式整理：把一段混杂文本整理成「每行一个合规号码」。
   * 与 OCR 过滤的区别：**保留 =N 后缀**，且整段不合法时会先尝试救出里面的号码。
   *   1234=2.5        → 1234=2.5（合法，原样保留）
   *   42×4=168（元）  → 42X4   （整段不合法，按 OCR 规则救出等号左边的号码）
   *   XXX4            → 丢弃，并记进 dropped
   * @returns {{lines:string[], dropped:string[], suspect:string[]}}
   */
  function tidyText(text) {
    var lines = [], dropped = [], suspect = [];
    var guard = protectSuffixDots(text);
    normalizeChars(guard.text).split(/\r?\n/).forEach(function (line) {
      line.split(SEPARATOR).forEach(function (raw) {
        var t = restoreSuffixDots(raw, guard.store).trim();
        if (!t) return;
        var g = parseGroup(t);
        if (g && g.status === 'ok') { lines.push(g.text); return; }
        var ex = extractGroups(t);
        if (ex.groups.length) {
          ex.groups.forEach(function (v) { lines.push(v); });
          if (ex.dropped.length) dropped.push(ex.dropped.join(' '));
          return;
        }
        dropped.push(t);
        var runs = t.match(/[0-9X]+/g) || [];
        var maxLen = runs.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
        if (maxLen >= 3) suspect.push(t);
      });
    });
    return { lines: lines, dropped: dropped, suspect: suspect };
  }

  /** 只取解析通过的号码文本 */
  function parsedTexts(text) {
    return parseText(text).groups.filter(function (g) { return g.status === 'ok'; })
      .map(function (g) { return g.text; });
  }

  /* ------------------------------------------------------------------ *
   * 全倒（4 位纯数字的全部不重复排列）
   * ------------------------------------------------------------------ */

  function permutationsOf4(num) {
    var chars = num.split('');
    var seen = Object.create(null);
    var out = [];
    var idx = [0, 1, 2, 3];
    (function walk(k) {
      if (k === 4) {
        var s = chars[idx[0]] + chars[idx[1]] + chars[idx[2]] + chars[idx[3]];
        if (!seen[s]) { seen[s] = 1; out.push(s); }
        return;
      }
      for (var i = k; i < 4; i++) {
        var t = idx[k]; idx[k] = idx[i]; idx[i] = t;
        walk(k + 1);
        t = idx[k]; idx[k] = idx[i]; idx[i] = t;
      }
    })(0);
    out.sort();
    return out;
  }

  function suffixOf(g) { return g.suffix === null || g.suffix === undefined ? '' : '=' + g.suffix; }

  /**
   * 全倒：对每个 4 位纯数字生成全部不重复排列（含原号码），单组内部自动去重。
   * 每个输入号码的所有排列是一个「分组」，输出时可以组间空行。
   * @returns {{groups:string[][], results:string[], skipped:Array<{text:string, reason:string}>}}
   */
  function expandReverse(text) {
    var parsed = typeof text === 'string' ? parseText(text) : text;
    var list = parsed.groups || [];
    var groups = [], skipped = [];
    list.forEach(function (g) {
      if (g.status !== 'ok') { skipped.push({ text: g.number || g.raw, reason: g.reason, kept: false }); return; }
      if (!isPure4(g.number)) {
        skipped.push({ text: g.text, reason: '不是 4 位纯数字（含 X 或位数不符），无法全倒', kept: false });
        return;
      }
      var sfx = suffixOf(g);
      groups.push(permutationsOf4(g.number).map(function (p) { return p + sfx; }));
    });
    return { groups: groups, results: flatten(groups), skipped: skipped };
  }

  /** 把若干分组按顺序拍平 */
  function flatten(groups) {
    var out = [];
    (groups || []).forEach(function (g) { out = out.concat(g || []); });
    return out;
  }

  /**
   * 把分组拍平成「可放进文本域」的行数组，组与组之间插一个空行
   * @param {string[][]} groups
   * @param {boolean} [blank=true] 是否插入空行
   */
  function joinGroups(groups, blank) {
    var out = [];
    (groups || []).forEach(function (g) {
      if (!g || !g.length) return;
      if (out.length && blank !== false) out.push('');
      out = out.concat(g);
    });
    return out;
  }

  /** 全倒组数速查（4 位数字的不重复排列数） */
  function reverseCount(num) {
    if (!isPure4(num)) return 0;
    var counts = Object.create(null), n = 1;
    for (var i = 0; i < 4; i++) counts[num[i]] = (counts[num[i]] || 0) + 1;
    n = 24;
    Object.keys(counts).forEach(function (d) {
      var c = counts[d];
      if (c === 2) n /= 2;
      else if (c === 3) n /= 6;
      else if (c === 4) n /= 24;
    });
    return Math.round(n);
  }

  /* ------------------------------------------------------------------ *
   * 3字X（先保留全部原号码，再按第 1→第 4 位替换成 X）
   * ------------------------------------------------------------------ */

  function replaceAt(num, i) {
    return num.slice(0, i) + 'X' + num.slice(i + 1);
  }

  /**
   * 分组 = [全部原号码, 第1位替换, 第2位替换, 第3位替换, 第4位替换]，空分组会被去掉。
   * @returns {{groups:string[][], results:string[], skipped:Array<{text:string, reason:string}>}}
   */
  function expandThreeX(text) {
    var parsed = typeof text === 'string' ? parseText(text) : text;
    var groups = parsed.groups || [];
    var originals = [];
    var batches = [[], [], [], []];
    var skipped = [];

    groups.forEach(function (g) {
      if (g.status !== 'ok') { skipped.push({ text: g.number || g.raw, reason: g.reason, kept: false }); return; }
      originals.push(g.text);
      if (!isPure4(g.number)) {
        // 这一组没有被展开，但作为原号码已经保留在结果里（kept: true）
        skipped.push({ text: g.text, reason: '不是 4 位纯数字（含 X 或位数不符），未生成 3字X', kept: true });
        return;
      }
      var sfx = suffixOf(g);
      for (var i = 0; i < 4; i++) batches[i].push(replaceAt(g.number, i) + sfx);
    });

    var outGroups = [originals, batches[0], batches[1], batches[2], batches[3]]
      .filter(function (g) { return g.length > 0; });
    return {
      groups: outGroups,
      results: flatten(outGroups),
      skipped: skipped
    };
  }

  /* ------------------------------------------------------------------ *
   * 去重 / 统计
   * ------------------------------------------------------------------ */

  function numberKey(text) {
    var g = parseGroup(text);
    if (!g) return String(text || '').trim();
    return (g.number || '').trim();
  }

  /** 找出号码部分重复的项（忽略 =N 差异）。返回 Map<number, count> */
  function findDuplicateNumbers(texts) {
    var map = Object.create(null);
    texts.forEach(function (t) {
      var k = numberKey(t);
      if (!k) return;
      map[k] = (map[k] || 0) + 1;
    });
    return map;
  }

  /** 按号码去重，保留首次出现；空行原样保留（分组空行不能被吃掉） */
  function dedupeByNumber(texts) {
    var seen = Object.create(null), out = [];
    texts.forEach(function (t) {
      var k = numberKey(t);
      if (!k) { out.push(t); return; }
      if (seen[k]) return;
      seen[k] = 1;
      out.push(t);
    });
    return out;
  }

  /** 清理：去掉空行与首尾空白（不影响内容） */
  function cleanLines(lines) {
    return (lines || []).map(function (s) { return String(s == null ? '' : s).trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  /**
   * 批量添加 / 替换 =N
   * @param {string[]} lines
   * @param {number[]} indexes 需要处理的下标
   * @param {string} value N
   */
  function applySuffix(lines, indexes, value) {
    var sv = validateSuffix(value);
    if (!sv.ok) return { ok: false, reason: sv.reason, lines: lines };
    var out = lines.slice();
    var failed = [];
    indexes.forEach(function (i) {
      if (i < 0 || i >= out.length) return;
      if (!String(out[i]).trim()) return;          // 空行（分组间隔）直接跳过，不算失败
      var g = parseGroup(out[i]);
      if (!g || g.status !== 'ok') { failed.push(out[i]); return; }
      out[i] = g.number + '=' + sv.value;
    });
    return { ok: true, lines: out, failed: failed, value: sv.value };
  }

  /** 清除后缀（空行原样保留） */
  function clearSuffix(lines, indexes) {
    var out = lines.slice();
    indexes.forEach(function (i) {
      if (i < 0 || i >= out.length) return;
      if (!String(out[i]).trim()) return;
      var g = parseGroup(out[i]);
      if (g && g.status === 'ok') out[i] = g.number;
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 输出文本组装 / 导出前检查
   * ------------------------------------------------------------------ */

  function joinLines(lines) { return cleanLines(lines).join('\n'); }

  /**
   * 导出前检查：任何一行不合规都不允许导出
   * @param {string[]} lines
   * @param {{ignoreBlank?:boolean}} [opts] ignoreBlank=true 时空行视为可忽略的空白（多行文本域用）
   * @returns {{ok:boolean, errors:Array<{index:number, text:string, reason:string}>, duplicates:Array<{number:string,count:number}>}}
   */
  function checkForExport(lines, opts) {
    var ignoreBlank = !!(opts && opts.ignoreBlank);
    var errors = [];
    var valid = [];
    (lines || []).forEach(function (t, i) {
      var s = String(t == null ? '' : t).trim();
      if (!s) {
        if (!ignoreBlank) errors.push({ index: i, text: '', reason: '这一行是空的，请填写或删除' });
        return;
      }
      // 先归一化再判：全角数字、全角＝、+ * x 这些和 parseText / 界面上的实时校验同一口径，
      // 否则「１２３４＝２」这种能通过 OCR 过滤却在右侧被判异常，两边说法会打架
      var g = parseGroup(normalizeChars(s));
      if (!g || g.status !== 'ok') {
        errors.push({ index: i, text: s, reason: (g && g.reason) || '格式不合规' });
        return;
      }
      valid.push(g.text);
    });
    var map = findDuplicateNumbers(valid);
    var duplicates = Object.keys(map).filter(function (k) { return map[k] > 1; })
      .map(function (k) { return { number: k, count: map[k] }; });
    return { ok: errors.length === 0, errors: errors, duplicates: duplicates };
  }

  return {
    // 常量
    SEPARATOR: SEPARATOR,
    // 基础
    normalizeChars: normalizeChars,
    toHalfWidth: toHalfWidth,
    countX: countX,
    isPure4: isPure4,
    isPureDigits: isPureDigits,
    // 校验
    validateNumber: validateNumber,
    validateSuffix: validateSuffix,
    // 解析
    parseGroup: parseGroup,
    parseText: parseText,
    parsedTexts: parsedTexts,
    extractGroups: extractGroups,
    tidyText: tidyText,
    suggestFix: suggestFix,
    // 生成
    permutationsOf4: permutationsOf4,
    reverseCount: reverseCount,
    expandReverse: expandReverse,
    expandThreeX: expandThreeX,
    replaceAt: replaceAt,
    flatten: flatten,
    joinGroups: joinGroups,
    // 集合操作
    numberKey: numberKey,
    findDuplicateNumbers: findDuplicateNumbers,
    dedupeByNumber: dedupeByNumber,
    cleanLines: cleanLines,
    applySuffix: applySuffix,
    clearSuffix: clearSuffix,
    // 导出
    joinLines: joinLines,
    checkForExport: checkForExport
  };
});
