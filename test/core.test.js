'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/core.js');

test('字符归一化：+ * x × 全部转成大写 X，全角数字转半角', () => {
  assert.equal(C.normalizeChars('1+2'), '1X2');
  assert.equal(C.normalizeChars('1*2'), '1X2');
  assert.equal(C.normalizeChars('1x2X3×4'), '1X2X3X4');
  assert.equal(C.normalizeChars('１２３４'), '1234');
  assert.equal(C.normalizeChars('1234  =  2.5'), '1234=2.5');
});

test('归一化：全角＝ / 全角ｘＸ 都要认，紧跟在 = 后面的 + 是正数号而不是 X', () => {
  assert.equal(C.normalizeChars('１２３４＝２'), '1234=2');
  assert.equal(C.normalizeChars('Ｘ234'), 'X234');
  assert.equal(C.normalizeChars('ｘ234'), 'X234');
  assert.equal(C.normalizeChars('1234 = +2.5'), '1234=+2.5');   // + 留给后缀解析
  assert.equal(C.normalizeChars('1+2'), '1X2');                 // 号码里的 + 仍然是 X
  assert.equal(C.parseGroup(C.normalizeChars('1234=+2')).text, '1234=2');
  assert.equal(C.parseGroup(C.normalizeChars('1234=+X2')).status, 'error');
});

test('导出校验和 parseText 一个口径：=N 与全角写法都不该被判异常', () => {
  const lines = ['1234=2', 'X234=2.5', '012=0', '1234 = +2', '１２３４＝２', 'Ｘ234', '1234=2.'];
  const check = C.checkForExport(lines, { ignoreBlank: true });
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  // 逐行判定必须和 parseText（左侧实时校验走的那条路）一致
  lines.forEach((line) => {
    assert.equal(C.parseText(line).errorCount, 0, line + ' 不该被判异常');
  });
  // 真正不合规的还是要拦住
  ['1234=', '1234=abc', '1234=-1', '12345=2', 'X23=2', 'XXX4=2'].forEach((line) => {
    assert.equal(C.checkForExport([line], { ignoreBlank: true }).ok, false, line + ' 应当被判异常');
  });
});

test('合法组合：4 位纯数字 / 4 位含 1~2 个 X / 3 位纯数字', () => {
  ['1234', 'X234', 'XX34', 'X2X4', '123'].forEach((n) => {
    assert.equal(C.validateNumber(n).ok, true, n + ' 应当合法');
  });
});

test('非法组合：XXX4、XXXX、X23、XX3、位数不符', () => {
  ['XXX4', 'XXXX', 'X23', 'XX3', '12345', '12345678', '12', ''].forEach((n) => {
    assert.equal(C.validateNumber(n).ok, false, n + ' 应当非法');
  });
  assert.match(C.validateNumber('12345678').reason, /超过 4 位/);
});

test('允许前导 0，号码按字符串处理', () => {
  const r = C.parseText('0123、0012、012');
  assert.equal(r.okCount, 3);
  assert.deepEqual(r.groups.map((g) => g.text), ['0123', '0012', '012']);
});

test('多种分隔符与换行都能正确拆分', () => {
  const r = C.parseText('1234、5678\nX234,9012；3456  7890');
  assert.deepEqual(r.groups.map((g) => g.text), ['1234', '5678', 'X234', '9012', '3456', '7890']);
});

test('混合文本里的 + 和 * 会被转成 X 并保留为合法号码', () => {
  const r = C.parseText('12+4、56*8');
  assert.deepEqual(r.groups.map((g) => g.text), ['12X4', '56X8']);
  assert.equal(r.errorCount, 0);
});

test('=N 后缀：0、正整数、正小数合法；负数与乱码非法', () => {
  assert.equal(C.validateSuffix('0').ok, true);
  assert.equal(C.validateSuffix('12').ok, true);
  assert.equal(C.validateSuffix('2.5').ok, true);
  assert.equal(C.validateSuffix('0.5').ok, true);
  assert.equal(C.validateSuffix('.5').value, '0.5');
  assert.equal(C.validateSuffix('-2.5').ok, false);
  assert.equal(C.validateSuffix('abc').ok, false);
  assert.equal(C.validateSuffix('').ok, false);
});

test('带后缀的分组解析与规范化', () => {
  const g = C.parseGroup('0123 = 2.50');
  assert.equal(g.status, 'ok');
  assert.equal(g.number, '0123');
  assert.equal(g.suffix, '2.50');
  assert.equal(g.text, '0123=2.50');

  const bad = C.parseGroup('1234=-3');
  assert.equal(bad.status, 'error');
  assert.match(bad.reason, /不允许为负数/);
});

test('全倒：不同重复情况得到 24 / 12 / 6 / 4 / 1 组，且含原号码', () => {
  const cases = [['1234', 24], ['1224', 12], ['1122', 6], ['1112', 4], ['1111', 1]];
  for (const [num, count] of cases) {
    const r = C.expandReverse(num);
    assert.equal(r.results.length, count, num + ' 应当有 ' + count + ' 组');
    assert.equal(new Set(r.results).size, count, num + ' 组内不应有重复');
    assert.equal(r.results.includes(num), true, num + ' 应当包含原号码');
    assert.equal(C.reverseCount(num), count);
  }
  assert.equal(C.expandReverse('1234').results[0], '1234');
  assert.equal(C.expandReverse('1234').results.length, 24);
});

test('全倒：非 4 位纯数字被跳过并给出提示，不静默丢弃', () => {
  const r = C.expandReverse('1234、012、X234、XXX4');
  assert.equal(r.results.length, 24);
  assert.equal(r.skipped.length, 3);
  assert.deepEqual(r.skipped.map((s) => s.text), ['012', 'X234', 'XXX4']);
});

test('全倒会保留 =N 后缀', () => {
  const r = C.expandReverse('1234=2.5');
  assert.equal(r.results.length, 24);
  assert.equal(r.results.every((t) => t.endsWith('=2.5')), true);
});

test('3字X：按需求示例的顺序输出（先原号码，再第1→第4位替换）', () => {
  const r = C.expandThreeX('1234、5678、8901');
  assert.deepEqual(r.results, [
    '1234', '5678', '8901',
    'X234', 'X678', 'X901',
    '1X34', '5X78', '8X01',
    '12X4', '56X8', '89X1',
    '123X', '567X', '890X'
  ]);
  assert.equal(r.results.length, 15);
  assert.equal(r.skipped.length, 0);
});

test('分组：3字X 分出 5 组，组间空一行后与需求示例完全一致', () => {
  const r = C.expandThreeX('1234、5678');
  assert.equal(r.groups.length, 5);
  assert.deepEqual(r.groups.map((g) => g.length), [2, 2, 2, 2, 2]);
  assert.deepEqual(C.joinGroups(r.groups), [
    '1234', '5678', '',
    'X234', 'X678', '',
    '1X34', '5X78', '',
    '12X4', '56X8', '',
    '123X', '567X'
  ]);
  // 拍平后仍然等于 results
  assert.deepEqual(C.flatten(r.groups), r.results);
});

test('分组：全倒按「每个号码一组」，组间空一行', () => {
  const r = C.expandReverse('1234、1224、1111');
  assert.deepEqual(r.groups.map((g) => g.length), [24, 12, 1]);
  const joined = C.joinGroups(r.groups);
  assert.equal(joined.length, 24 + 12 + 1 + 2); // 两个空行
  assert.equal(joined[24], '');
  assert.equal(joined[37], '');
  assert.deepEqual(C.flatten(r.groups), r.results);
});

test('分组：joinGroups 可以关掉空行，空分组不产生多余空行', () => {
  assert.deepEqual(C.joinGroups([['a'], [], ['b']]), ['a', '', 'b']);
  assert.deepEqual(C.joinGroups([['a'], ['b']], false), ['a', 'b']);
});

test('分组空行不会被去重和后缀操作吃掉', () => {
  assert.deepEqual(C.dedupeByNumber(['1234', '', '1234', '', 'X234']), ['1234', '', '', 'X234']);

  const r = C.applySuffix(['1234', '', 'X234'], [0, 1, 2], '2');
  assert.deepEqual(r.lines, ['1234=2', '', 'X234=2']);
  assert.deepEqual(r.failed, []);                       // 空行不算失败
  assert.deepEqual(C.clearSuffix(['1234=2', '', 'X234=2'], [0, 1, 2]), ['1234', '', 'X234']);
});

test('分组空行不影响导出校验', () => {
  const ok = C.checkForExport(['1234', '', 'X234'], { ignoreBlank: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.errors.length, 0);
});

test('3字X：3 位号码与含 X 号码保留原样但不展开，并给出提示', () => {
  const r = C.expandThreeX('1234、012、X234');
  assert.deepEqual(r.results.slice(0, 3), ['1234', '012', 'X234']);
  assert.equal(r.results.length, 3 + 4);
  assert.equal(r.skipped.length, 2);
});

test('重复检测只看号码部分：1234=2 与 1234=3 算重复', () => {
  const dup = C.findDuplicateNumbers(['1234=2', '1234=3', 'X234']);
  assert.equal(dup['1234'], 2);
  assert.equal(dup['X234'], 1);

  const deduped = C.dedupeByNumber(['1234=2', '1234=3', 'X234']);
  assert.deepEqual(deduped, ['1234=2', 'X234']);
});

test('批量设置 =N：替换已有后缀，错误行不处理', () => {
  const r = C.applySuffix(['1234=2', 'X234', 'XXX4'], [0, 1], '3');
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines, ['1234=3', 'X234=3', 'XXX4']);

  const bad = C.applySuffix(['1234'], [0], '-1');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /负数/);

  assert.deepEqual(C.clearSuffix(['1234=3', 'X234'], [0, 1]), ['1234', 'X234']);
});

test('导出检查：存在异常行必须阻止导出', () => {
  const bad = C.checkForExport(['1234', 'XXX4', '', '012']);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  assert.match(bad.errors[0].reason, /最多允许 2 个 X/);

  const good = C.checkForExport(['1234', 'X234', '012=2.5']);
  assert.equal(good.ok, true);
  assert.equal(good.errors.length, 0);
  assert.equal(good.duplicates.length, 0);

  const dup = C.checkForExport(['1234=2', '1234=3']);
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicates.length, 1);
  assert.equal(dup.duplicates[0].number, '1234');
});

test('OCR 过滤：只保留符合格式的 3~4 位号码组合', () => {
  const raw = [
    '42×4=168（元）',
    '49×1=49（元）',
    '4394',
    '4284',
    '5484',
    '4584',
    '4×94'
  ].join('\n');
  const r = C.extractGroups(raw);
  assert.deepEqual(r.groups, ['42X4', '49X1', '4394', '4284', '5484', '4584', '4X94']);
  assert.deepEqual(r.dropped, ['168（元）', '49（元）']);
});

test('OCR 过滤：算式两边有空格也照样处理', () => {
  assert.deepEqual(C.extractGroups('42×4 = 168 （元）').groups, ['42X4']);
});

test('OCR 过滤：一行多组全部保留，按原顺序', () => {
  assert.deepEqual(C.extractGroups('1234、5678 8901').groups, ['1234', '5678', '8901']);
});

test('OCR 过滤：连续 5 位以上不会被截断（避免错误拆分），并标记为疑似误读', () => {
  const r = C.extractGroups('12345678');
  assert.deepEqual(r.groups, []);
  assert.deepEqual(r.dropped, ['12345678']);
  assert.deepEqual(r.suspect, ['12345678']);
});

test('OCR 过滤：大括号被读成数字时（位数超标）会被挡下并标为疑似', () => {
  const r = C.extractGroups('42713\n64713\n42942\n64941');
  assert.deepEqual(r.groups, []);
  assert.deepEqual(r.suspect, ['42713', '64713', '42942', '64941']);
  // 纯文字、金额、圈号不算「疑似号码」
  const r2 = C.extractGroups('36.-\n⑦\n各2元');
  assert.deepEqual(r2.suspect, []);
  assert.equal(r2.dropped.length, 3);
});

test('OCR 过滤：XXX4、X23 这类非法组合进 dropped，不放进来', () => {
  const r = C.extractGroups('XXX4 X23 123');
  assert.deepEqual(r.groups, ['123']);
  assert.deepEqual(r.dropped, ['XXX4', 'X23']);
  assert.deepEqual(r.suspect, ['XXX4', 'X23']);   // 像号码但不符合格式
});

test('OCR 过滤：保留前导 0，纯文字内容被丢掉', () => {
  const r = C.extractGroups('姓名：张三\n0123\n备注abc');
  assert.deepEqual(r.groups, ['0123']);
  assert.equal(r.dropped.includes('姓名'), true);
});

test('OCR 疑似修正建议：优先去掉末尾那位（大括号多被读在右边）', () => {
  assert.equal(C.suggestFix('64913'), '6491');
  assert.equal(C.suggestFix('42913'), '4291');
  assert.equal(C.suggestFix('42713'), '4271');
  assert.equal(C.suggestFix('X2345'), 'X234');
  assert.equal(C.suggestFix('12X45'), '12X4');
});

test('OCR 疑似修正建议：位数差太多就不猜', () => {
  assert.equal(C.suggestFix('12345678'), null);
  assert.equal(C.suggestFix('各2元'), null);
  assert.equal(C.suggestFix(''), null);
  assert.equal(C.suggestFix('XXXXX'), null);   // 去掉一位还是非法
});

test('OCR 疑似修正建议：末尾去不掉时才去开头那位', () => {
  assert.equal(C.suggestFix('71234'), '7123');   // 末位优先
  assert.equal(C.suggestFix('XXX12'), 'XX12');   // 去末位仍是 XXX1/XXX（非法）→ 去首位成立
});

test('格式整理：合法的原样保留（含 =N 后缀），不合规的过滤掉', () => {
  const r = C.tidyText('1234、X234、XX34、123');
  assert.deepEqual(r.lines, ['1234', 'X234', 'XX34', '123']);
  assert.deepEqual(r.dropped, []);

  const r2 = C.tidyText('1234=2.5\nX234\nXXX4\nX23\n12345678');
  assert.deepEqual(r2.lines, ['1234=2.5', 'X234']);
  assert.deepEqual(r2.dropped, ['XXX4', 'X23', '12345678']);
  assert.deepEqual(r2.suspect, ['XXX4', 'X23', '12345678']);
});

test('格式整理：整段不合法时救出等号左边的号码', () => {
  const r = C.tidyText('42×4=168（元）\n49×1=49（元）\n4394\n4×94');
  assert.deepEqual(r.lines, ['42X4', '49X1', '4394', '4X94']);
  assert.deepEqual(r.dropped, ['168（元）', '49（元）']);
});

test('格式整理：+ * x 归一成 X，前导 0 保留', () => {
  assert.deepEqual(C.tidyText('12+4、56*8、x234、0123').lines, ['12X4', '56X8', 'X234', '0123']);
});

test('格式整理：空输入返回空', () => {
  assert.deepEqual(C.tidyText('   \n  '), { lines: [], dropped: [], suspect: [] });
});

test('句点也是分隔符：8103.6583.5583 拆成 3 组', () => {
  assert.deepEqual(C.tidyText('8103.6583.5583').lines, ['8103', '6583', '5583']);
  assert.equal(C.parseText('8103.6583.5583').okCount, 3);
  assert.deepEqual(C.extractGroups('8103.6583.5583').groups, ['8103', '6583', '5583']);
});

test('句点分隔 + =N 小数后缀共存（后缀里的小数点不能被切开）', () => {
  assert.deepEqual(C.tidyText('1234=2.5').lines, ['1234=2.5']);
  assert.deepEqual(C.tidyText('1234=2.5、5678').lines, ['1234=2.5', '5678']);
  assert.deepEqual(C.tidyText('X234=0.5').lines, ['X234=0.5']);
  assert.deepEqual(C.parseText('1234 = 2.5').groups.map((g) => g.text), ['1234=2.5']);
});

test('用户实际那串（20 组，句点分隔）能全部整理出来', () => {
  const raw = '8103.6583.5583.0583.0573.6573.4478.4546.4483.3951.9162.9062.6803.1493.1293.1093.3134.0501.2501.6853';
  const r = C.tidyText(raw);
  assert.equal(r.lines.length, 20);
  assert.deepEqual(r.lines.slice(0, 4), ['8103', '6583', '5583', '0583']);
  assert.deepEqual(r.lines.slice(-3), ['0501', '2501', '6853']);
  assert.deepEqual(r.dropped, []);
  // 前导 0 保留
  assert.equal(r.lines.includes('0583'), true);
});

test('导出文本每行一组', () => {
  assert.equal(C.joinLines(['1234', ' X234 ', '', '012']), '1234\nX234\n012');
});

test('序号前缀与括号包裹能被清理', () => {
  const r = C.parseText('1. 1234\n2) X234\n(3) 012');
  assert.deepEqual(r.groups.map((g) => g.text), ['1234', 'X234', '012']);
});


test('感叹号分隔的号码全部保留，中英文和连续分隔符均支持', () => {
  for (const raw of ['6631！2631！6011', '6631!2631!6011', '！6631!!2631！!6011！']) {
    const expected = ['6631', '2631', '6011'];
    assert.deepEqual(C.tidyText(raw), { lines: expected, dropped: [], suspect: [] });
    assert.deepEqual(C.parseText(raw).groups.map(g => g.text), expected);
    assert.deepEqual(C.extractGroups(raw).groups, expected);
  }
});

test('感叹号分隔保留前导零和小数后缀，不截断超长号码', () => {
  const r = C.tidyText('0631=2.5！2631=0.5!6011！12345678');
  assert.deepEqual(r.lines, ['0631=2.5', '2631=0.5', '6011']);
  assert.deepEqual(r.dropped, ['12345678']);
});

test('任意中英标点、符号和空白均可分隔号码', () => {
  for (const sep of ['！', '?', '@', '#', '$', '%', '&', '(', ')', '[', ']', '{', '}', '"', "'", '……', '—', '→', '★', '￥', '🙂', ' ', '\t', '\n', '\u3000', '\u00a0']) {
    const raw = ['6631', '2631', '6011'].join(sep);
    assert.deepEqual(C.tidyText(raw).lines, ['6631', '2631', '6011'], sep);
    assert.equal(C.parseText(raw).okCount, 3, sep);
    assert.deepEqual(C.extractGroups(raw).groups, ['6631', '2631', '6011'], sep);
  }
});

test('广泛符号分隔仍保留 X 规则、全角及正数小数后缀', () => {
  assert.deepEqual(C.tidyText('12×4＠56+8#x234；０１２３＝２.５！6631=+0.5').lines,
    ['12X4', '56X8', 'X234', '0123=2.5', '6631=0.5']);
  assert.equal(C.parseText('6631=-2.5').errorCount, 1);
  assert.deepEqual(C.tidyText('66312631★6011').lines, ['6011']);
});
