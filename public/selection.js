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
    '框须覆盖全部笔画并紧贴数字最上、最下、最左、最右的笔画，只留极少空白；尤其右边界必须停在号码最后一位的最后笔画处，不得包含等号、金额或备注。不得包含行距或相邻号码，相邻号码框不得重叠。没有号码则 groups 为空数组。'
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
    function number(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
      if (typeof value === 'string' && value.trim() !== '') {
        var parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : NaN;
      }
      return NaN;
    }
    function boxFor(group) {
      var source = group.box || group.bbox || group.bbox_2d;
      var box;
      if (Array.isArray(source) && source.length >= 4) {
        box = source.slice(0, 4).map(number);
        // Some visual models return [centerX, centerY, width, height, confidence].
        if (source.length >= 5 && box.every(Number.isFinite) && (box[2] <= box[0] || box[3] <= box[1]) && box[2] > 0 && box[3] > 0) {
          box = [box[0] - box[2] / 2, box[1] - box[3] / 2, box[0] + box[2] / 2, box[1] + box[3] / 2];
        }
      } else if (source && typeof source === 'object') {
        if ('x1' in source || 'left' in source) {
          box = [number(source.x1 ?? source.left), number(source.y1 ?? source.top),
            number(source.x2 ?? source.right), number(source.y2 ?? source.bottom)];
        } else if ('x' in source && 'y' in source && 'width' in source && 'height' in source) {
          box = [number(source.x), number(source.y), number(source.x) + number(source.width), number(source.y) + number(source.height)];
        }
      } else if ('x' in group && 'y' in group && 'width' in group && 'height' in group) {
        box = [number(group.x), number(group.y), number(group.x) + number(group.width), number(group.y) + number(group.height)];
      }
      if (!box || !box.every(Number.isFinite)) return null;
      if (dimensions) {
        var fitsPixels = box[0] >= 0 && box[1] >= 0 && box[2] <= dimensions.width && box[3] <= dimensions.height;
        var fitsNormalized = box.every(function (n) { return n >= 0 && n <= 1000; });
        // The prompt asks for pixels, but Qwen visual models can still return their native 0-1000 coordinates.
        if (fitsPixels) box = box.map(function (n, i) { return n * 1000 / (i % 2 ? dimensions.height : dimensions.width); });
        else if (!fitsNormalized) return null;
      }
      return box;
    }
    var groups = [];
    groups = data.groups.slice(0, 2000).flatMap(function (g) {
      if (!g || typeof g.text !== 'string') return [];
      var text = core.normalizeChars(g.text).trim(), b;
      if (!core.validateNumber(text).ok) return [];
      validNumbers++;
      b = boxFor(g);
      if (!Array.isArray(b) || b.length !== 4 ||
          !b.every(function (n) { return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000; }) ||
          b[2] <= b[0] || b[3] <= b[1]) { invalidPositions++; return []; }
      var key = b.join(',');
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ text: text, box: b }];
    });
    if (!groups.length && (invalidPositions || data.groups.length)) {
      throw new Error(validNumbers ? '已识别到号码，但模型返回的位置格式无法使用；请重试定位' : '模型把号码与备注混在一起，未返回独立号码；请重试定位');
    }
    return groups;
  }

  function tightenRegions(groups, dimensions) {
    var scaleX = dimensions ? dimensions.width / 1000 : 1;
    var scaleY = dimensions ? dimensions.height / 1000 : 1;
    return groups.map(function (region, index) {
      var box = region.box, width = box[2] - box[0], height = box[3] - box[1];
      var centerY = (box[1] + box[3]) / 2, nearest = Infinity;
      groups.forEach(function (other, otherIndex) {
        if (otherIndex === index) return;
        var candidate = other.box, otherHeight = candidate[3] - candidate[1];
        var overlapX = Math.min(box[2], candidate[2]) - Math.max(box[0], candidate[0]);
        if (overlapX < Math.min(width, candidate[2] - candidate[0]) * 0.5) return;
        var gap = Math.abs(centerY - (candidate[1] + candidate[3]) / 2);
        // Ignore near-duplicate detections instead of letting them collapse a valid row.
        if (gap < Math.min(height, otherHeight) * 0.45) return;
        nearest = Math.min(nearest, gap);
      });
      if (!Number.isFinite(nearest)) return region;
      // Dense rows often arrive with boxes as tall as the whole line pitch. Preserve
      // the center while reserving 18% of the pitch for visible separation.
      var targetHeight = Math.max(height * 0.6, Math.min(height, nearest * 0.82));
      // Four handwritten characters are normally at most about three times as wide
      // as their ink height (three characters are narrower). Keep the reliable left
      // edge and trim only the right edge where =N and notes are commonly included.
      var maxAspect = region.text.length === 3 ? 2.6 : 3.35;
      var aspectWidth = targetHeight * scaleY * maxAspect / scaleX;
      var targetWidth = Math.max(width * 0.55, Math.min(width, aspectWidth));
      if (targetHeight >= height - 0.01 && targetWidth >= width - 0.01) return region;
      return Object.assign({}, region, { box: [box[0], centerY - targetHeight / 2, box[0] + targetWidth, centerY + targetHeight / 2] });
    });
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
  return { parseRegions: parseRegions, tightenRegions: tightenRegions, intersects: intersects, requestRegions: requestRegions, REGION_PROMPT: REGION_PROMPT, regionPrompt: regionPrompt };
});
