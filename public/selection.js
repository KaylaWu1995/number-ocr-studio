/* Mixed-length number regions and swept pointer hit testing. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core'));
  else root.OCRSelection = factory(root.OCRCore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';
  var REGION_PROMPT = [
    '定位图片里的号码，只输出 JSON：{"groups":[{"text":"0123","box":[100,200,180,240]}]}。',
    '号码三位与四位混合出现，三位只允许纯数字，四位允许数字和最多两个 X。保留前导零，×、x、*、+ 归一化为 X。',
    '按原图实际空隙和布局分组，不得将连续长数字猜测拆分。不同位置的重复号码分别返回。',
    '忽略金额、序号、备注和等号右边的结果。大括号不是数字，不能识别为 3、2、1。',
    'box 为完整号码的 [左,上,右,下]，以整张图片左上角为原点，横纵坐标均归一化到 0—1000。',
    '框须覆盖全部笔画并尽量贴合，不能包含相邻号码或备注。没有号码则 groups 为空数组。'
  ].join('\n');

  function regionPrompt(width, height) {
    return REGION_PROMPT.replace('横纵坐标均归一化到 0—1000',
      '使用原图像素坐标，图片宽' + width + '像素、高' + height + '像素，x范围0到' + width + '，y范围0到' + height + '，不要归一化');
  }

  async function requestRegions(fetcher, base, image, signal, dimensions) {
    function post(path, body) {
      return fetcher(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: signal, body: JSON.stringify(body) });
    }
    var response = await post('/api/ocr/regions', Object.assign({ image: image }, dimensions || {}));
    // Older running servers already support custom prompts through /api/ocr.
    var legacy = response.status === 404;
    if (legacy) response = await post('/api/ocr', { image: image, prompt: REGION_PROMPT });
    var data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '号码定位失败');
    return { groups: parseRegions(legacy ? data.text : JSON.stringify({ groups: data.groups })) };
  }

  function parseRegions(raw, dimensions) {
    var data = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!data || !Array.isArray(data.groups)) throw new Error('模型未返回号码位置，请使用框选或换用支持位置识别的模型');
    var seen = new Set(), invalidPositions = 0, validNumbers = 0;
    var groups = [];
    groups = data.groups.slice(0, 2000).flatMap(function (g) {
      if (!g || typeof g.text !== 'string') return [];
      var text = core.normalizeChars(g.text).trim(), b = g.box;
      if (!core.validateNumber(text).ok) return [];
      validNumbers++;
      if (dimensions && Array.isArray(b) && b.length === 4) {
        b = b.map(function (n, i) { return typeof n === 'number' ? n * 1000 / (i % 2 ? dimensions.height : dimensions.width) : n; });
      }
      if (!Array.isArray(b) || b.length !== 4 ||
          !b.every(function (n) { return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000; }) ||
          b[2] <= b[0] || b[3] <= b[1]) { invalidPositions++; return []; }
      var key = b.join(',');
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ text: text, box: b }];
    });
    if (!groups.length && (invalidPositions || data.groups.length)) {
      throw new Error(validNumbers ? '已识别到号码，但位置数据无效；请重启本地服务以启用视觉定位' : '模型把号码与备注混在一起，未返回独立号码；请重启本地服务以启用视觉定位');
    }
    return groups;
  }
  // Slab intersection includes the whole segment so fast drags cannot skip groups.
  function intersects(a, b, r) {
    var lo = 0, hi = 1;
    for (var axis of ['x', 'y']) {
      var delta = b[axis] - a[axis], min = r[axis], max = min + r[axis === 'x' ? 'w' : 'h'];
      if (delta === 0) { if (a[axis] < min || a[axis] > max) return false; }
      else {
        var t1 = (min - a[axis]) / delta, t2 = (max - a[axis]) / delta;
        lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
        if (lo > hi) return false;
      }
    }
    return true;
  }
  return { parseRegions: parseRegions, intersects: intersects, requestRegions: requestRegions, REGION_PROMPT: REGION_PROMPT, regionPrompt: regionPrompt };
});
