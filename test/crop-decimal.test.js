const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('标注小数输入隔离快捷键，输入法确认不提前标注，Esc与Cmd+.不退出', () => {
  const source = fs.readFileSync(require.resolve('../public/app'), 'utf8');
  const start = source.indexOf('  function bindCropSuffixInput(');
  const end = source.indexOf('  function buildCropper(', start);
  const events = {}; let applied = 0;
  const scope = { input: { addEventListener: (name, fn) => { events[name] = fn; } }, apply: () => applied++ };
  vm.runInNewContext(source.slice(start, end) + '\nbindCropSuffixInput(input, apply);', scope);
  function key(key, extra = {}) {
    const e = { key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    events.keydown(e); return e;
  }
  for (const k of ['0', '.', '5']) {
    const e = key(k); assert.equal(e.stopped, true); assert.equal(e.prevented, false);
  }
  assert.equal(key('.', { code: 'NumpadDecimal' }).prevented, false);
  assert.equal(key('Escape').prevented, true);
  assert.equal(key('.', { metaKey: true }).prevented, true);
  assert.equal(key('z', { ctrlKey: true }).prevented, false); // Native input undo remains available.
  events.compositionstart(); key('Enter'); assert.equal(applied, 0);
  events.compositionend(); key('Enter', { isComposing: true }); assert.equal(applied, 0);
  key('Enter', { keyCode: 229 }); assert.equal(applied, 0);
  key('Enter'); assert.equal(applied, 1);
});
