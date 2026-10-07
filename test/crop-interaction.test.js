const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('页面点选：自动定位、切换选择、分批标注并发布首次识别结果', async () => {
  const nodes = new Map(), canvases = [];
  function element() {
    const classes = new Set();
    const context = new Proxy({ rects: [], globalCompositeOperation: 'source-over',
      clearRect() { this.rects = []; }, measureText(t) { return { width: t.length * 7 }; },
      fillRect(x, y, w, h) { this.rects.push({ x, y, w, h, mode: this.globalCompositeOperation }); }
    }, { get(o, k) { return k in o ? o[k] : () => {}; } });
    return { value: '', style: {}, dataset: {}, width: 1000, height: 1000, clientWidth: 1002, clientHeight: 1002,
      classList: {
        toggle(name, force) {
          const add = force === undefined ? !classes.has(name) : force;
          if (add) classes.add(name); else classes.delete(name);
          return add;
        },
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); }
      }, listeners: {},
      addEventListener(k, f) { this.listeners[k] = f; }, removeEventListener() {},
      focus() {}, appendChild(child) { this.child = child; },
      getContext() { return context; }, setPointerCapture() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 1000 }; },
      querySelector: $, querySelectorAll() { return []; }, setAttribute() {}
    };
  }
  function $(s) { if (!nodes.has(s)) nodes.set(s, element()); return nodes.get(s); }
  let completed, metadata, selection, fetchCalls = 0, updates = 0;
  const scope = { $, Map, Set, AbortController, setTimeout, clearTimeout, C: require('../public/core'), toast() {},
    done(result, meta) {
      if (meta.selectionOnly) { selection = Array.from(meta.picked); return; }
      completed = Array.from(result); metadata = meta; updates++;
    },
    window: { OCRSelection: require('../public/selection'), addEventListener() {}, removeEventListener() {} },
    document: { createElement(tag) { const e = element(); if (tag === 'canvas') canvases.push(e); return e; },
      querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {} },
    apiBase() { return ''; },
    fetch: async () => { fetchCalls++; return ({ ok: true, json: async () => ({ ok: true, groups: [
      { text: '123', box: [100, 100, 200, 150] }, { text: '1234', box: [300, 100, 450, 150] }
    ] }) }); }
  };
  scope.window.OCRBrowser = { request: scope.fetch };
  const source = fs.readFileSync(require.resolve('../public/app'), 'utf8');
  const start = source.indexOf('  function bindCropSuffixInput('), end = source.indexOf('  var imageBatch =', start);
  vm.runInNewContext(source.slice(start, end) + '\nvar cleanup = buildCropper({ naturalWidth:1000,naturalHeight:1000 }, "image", done, $("#host"));', scope);
  assert.match($('#host').child.innerHTML, /id="cropViewport"/);
  assert.doesNotMatch($('#host').child.innerHTML, /cropAnnotationPreview|cropZoom|data-tool=/);
  assert.equal(fetchCalls, 1);
  const mask = $('#cropMask'), drawn = () => canvases[0].getContext().rects;
  function pointer(type, x, y) { mask.listeners[type]({ type, pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, preventDefault() {} }); }
  assert.equal($('#cropLocating').classList.contains('hidden'), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal($('#cropLocating').classList.contains('hidden'), true);
  assert.equal($('#cropAnnotationCount').textContent, '已定位 2 组，已标注 0 组');
  assert.deepEqual(completed, ['123', '1234']);
  pointer('pointerdown', 20, 20); pointer('pointerup', 20, 20);
  assert.equal(drawn().length, 0);
  // Each group toggles independently: select, cancel, select again.
  pointer('pointerdown', 120, 120); pointer('pointerup', 120, 120);
  assert.equal(drawn().length, 1);
  assert.deepEqual(selection, [0]);
  pointer('pointerdown', 120, 120); pointer('pointerup', 120, 120);
  assert.equal(drawn().length, 0);
  assert.deepEqual(selection, []);
  pointer('pointerdown', 120, 120); pointer('pointerup', 120, 120);
  assert.equal(drawn().length, 1);
  pointer('pointerdown', 120, 120); pointer('pointerup', 120, 120);
  assert.equal(drawn().length, 0);
  // Sweeping toggles every crossed group once per gesture.
  pointer('pointerdown', 50, 120); pointer('pointermove', 500, 120); pointer('pointerup', 500, 120);
  assert.equal(drawn().length, 2);
  pointer('pointerdown', 50, 120); pointer('pointermove', 500, 120); pointer('pointerup', 500, 120);
  assert.equal(drawn().length, 0);
  pointer('pointerdown', 50, 120); pointer('pointermove', 500, 120); pointer('pointerup', 500, 120);
  assert.equal(drawn().length, 2);
  pointer('pointerdown', 120, 120); pointer('pointercancel', 120, 120);
  assert.equal(drawn().length, 2);
  assert.equal(updates, 1, '选择不会反复写入文本栏');
  // Cancel the second group, then annotate separate batches.
  pointer('pointerdown', 320, 120); pointer('pointerup', 320, 120);
  $('#cropSuffix').value = '-1'; $('#cropApplySuffix').onclick();
  assert.deepEqual(completed, ['123', '1234']);
  $('#cropSuffix').value = '0'; $('#cropApplySuffix').onclick();
  assert.deepEqual(completed, ['123=0', '1234']);
  assert.deepEqual(Array.from(metadata.selected), [0]);
  assert.equal($('#cropAnnotationCount').textContent, '已定位 2 组，已标注 1 组');
  assert.equal($('#cropApplySuffix').disabled, true);
  pointer('pointerdown', 320, 120); pointer('pointerup', 320, 120);
  $('#cropSuffix').value = '0.5'; $('#cropApplySuffix').onclick();
  assert.deepEqual(completed, ['123=0', '1234=0.5']);
  // Swept batch updates both values, then undo restores distinct values and selection.
  pointer('pointerdown', 50, 120); pointer('pointerup', 500, 120);
  $('#cropSuffix').value = '2'; $('#cropApplySuffix').onclick();
  assert.deepEqual(completed, ['123=2', '1234=2']);
  // Existing annotations can be reassigned by selecting them again.
  pointer('pointerdown', 120, 120); pointer('pointerup', 120, 120);
  $('#cropSuffix').value = '0'; $('#cropApplySuffix').onclick();
  pointer('pointerdown', 320, 120); pointer('pointerup', 320, 120);
  $('#cropSuffix').value = '0.5'; $('#cropApplySuffix').onclick();
  assert.deepEqual(completed, ['123=0', '1234=0.5']);
  scope.cleanup.clearAnnotations([0]);
  assert.equal($('#cropAnnotationCount').textContent, '已定位 2 组，已标注 1 组');
  pointer('pointerdown', 320, 120); pointer('pointerup', 320, 120);
  $('#cropSuffix').value = '3'; $('#cropApplySuffix').onclick();
  assert.deepEqual(completed, ['123', '1234=3']);
  scope.cleanup();
});
