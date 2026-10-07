const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function workspace() {
  const source = fs.readFileSync(require.resolve('../public/app'), 'utf8');
  const start = source.indexOf('  var imageBatch =');
  const end = source.indexOf('  var WORKSPACE_HOST', start);
  const nodes = new Map(), crops = [], undo = [], prompts = [];
  function element() {
    return { value: '', children: [], classList: { add() {}, remove() {}, toggle() {} },
      appendChild(x) { this.children.push(x); }, replaceChildren(...x) { this.children = x; },
      setAttribute() {} };
  }
  const $ = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  $('#input').value = '999=3';
  $('#output').value = '888=4';
  const scope = { $, Map, Set, Promise, Event: function(type) { this.type = type; },
    document: { createElement: element, querySelector: $, body: element(), dispatchEvent() {} },
    window: { dispatchEvent() {} }, toast() {}, renderInputHighlight() {},
    openModal(modal) { prompts.push(modal); },
    Image: class { set src(value) { this.onload(); } },
    readFileAsDataUrl: async file => file.name, downscale: async x => x,
    buildCropper(img, data, publish) {
      const crop = { data, publish, cleaned: false };
      crops.push(crop);
      return () => { crop.cleaned = true; };
    },
    pushUndoLeft() { undo.push($('#input').value); },
    setInput(text) { $('#input').value = text; }, commitLeft() {},
    pushUndo() {}, commit() {}, setOutput(lines) { $('#output').value = lines.join('\n'); }
  };
  vm.runInNewContext(source.slice(start, end), scope);
  function respond(yes) {
    const prompt = prompts.at(-1);
    prompt.buttons[yes ? 1 : 0].onClick();
    prompt.onClose();
  }
  return { scope, $, crops, undo, prompts, respond };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('取消选图或传入非图片文件不会清空文本', () => {
  const {scope, $} = workspace();
  scope.ocrFiles([]);
  scope.ocrFiles([{type:'text/plain'}]);
  assert.equal($('#input').value, '999=3');
  assert.equal($('#output').value, '888=4');
});

test('多图定位按图片顺序写入输入栏，标注只更新对应行，保留手动编辑和输出', async () => {
  const {scope, $, crops, undo} = workspace();
  scope.ocrFiles([{type: 'image/png', name: 'first'}, {type: 'image/png', name: 'second'}]);
  await settle();
  crops[1].publish(['012', '1234'], {initial: true});
  crops[0].publish(['012', '456'], {initial: true});
  assert.equal($('#input').value, '012\n456\n012\n1234');
  assert.equal(undo[0], '999=3');
  $('#input').value = '012\n654=8\n012\n1234\n789=9';
  crops[1].publish(['012=0.5', '1234'], {});
  assert.equal($('#input').value, '012\n654=8\n012=0.5\n1234\n789=9');
  assert.equal($('#output').value, '');
  crops[0].publish(['012=2', '456'], {});
  assert.equal($('#input').value, '012=2\n654=8\n012=0.5\n1234\n789=9');
});

test('更换图片及收起图片栏会清理旧会话，忽略旧结果且保留文本', async () => {
  const {scope, $, crops} = workspace();
  scope.ocrFiles([{type: 'image/png', name: 'first'}]);
  await settle();
  crops[0].publish(['123'], {initial: true});
  scope.ocrFiles([{type: 'image/png', name: 'replacement'}]);
  await settle();
  assert.equal(crops[0].cleaned, true);
  crops[1].publish(['456'], {initial: true});
  crops[0].publish(['123=5'], {});
  assert.equal($('#input').value, '456');
  scope.closeImageWorkspace();
  assert.equal(crops[1].cleaned, true);
  crops[1].publish(['456=9'], {});
  assert.equal($('#input').value, '456');
  assert.equal($('#output').value, '');
});

test('上传立即清空两栏，空结果或失败保持为空，重试成功后填入新结果', async () => {
  const {scope, $, crops} = workspace();
  scope.ocrFiles([{type: 'image/png', name: 'first'}]);
  assert.equal($('#input').value, '');
  assert.equal($('#output').value, '');
  await settle();
  crops[0].publish([], {error: '请求超时'});
  assert.equal($('#input').value, '');
  crops[0].publish([], {initial: true});
  assert.equal($('#input').value, '');
  crops[0].publish(['1234'], {initial: true});
  assert.equal($('#input').value, '1234');
  assert.equal($('#output').value, '');
});

test('清空输入后再次标注需确认恢复所选号码，未选号码不恢复', async () => {
  const {scope, $, crops, undo, respond} = workspace();
  scope.ocrFiles([{type:'image/png', name:'first'}]);
  await settle();
  crops[0].publish(['123', '456'], {initial:true});
  crops[0].publish(['123=2', '456'], {selected:[0]});
  $('#input').value = '';
  crops[0].publish(['123=2', '456'], {selected:[0]});
  assert.equal($('#input').value, '');
  respond(true);
  assert.equal($('#input').value, '123');
  assert.equal(undo.at(-1), '');
  crops[0].publish(['123', '456=0.5'], {selected:[1]});
  respond(true);
  assert.equal($('#input').value, '123\n456');
  assert.equal($('#output').value, '');
});

test('修改号码或金额后重新标注覆盖对应行，保留其他手动修改', async () => {
  const {scope, $, crops, respond} = workspace();
  scope.ocrFiles([{type:'image/png', name:'first'}]);
  await settle();
  crops[0].publish(['123=2', '456=3', '789'], {initial:true});
  $('#input').value = '321=8\n456=9\n789';
  crops[0].publish(['123=2', '456=3', '789'], {selected:[0]});
  assert.equal($('#input').value, '123=2\n456=9\n789');
  crops[0].publish(['123=2', '456=0.5', '789'], {selected:[1]});
  assert.equal($('#input').value, '123=2\n456=0.5\n789');
  $('#input').value = '456=0.5\n789';
  crops[0].publish(['123=4', '456=0.5', '789'], {selected:[0]});
  respond(true);
  assert.equal($('#input').value, '123\n456=0.5\n789');
});

test('点选联动选择身份；删除后先询问，取消不恢复，确认只恢复所选行', async () => {
  const {scope, $, crops, prompts, respond} = workspace();
  scope.ocrFiles([{type:'image/png', name:'first'}]);
  await settle();
  crops[0].publish(['123=2', '456=3'], {initial:true});
  $('#input').value = '';
  crops[0].publish([], {selectionOnly:true, picked:[0], settled:false});
  assert.equal(prompts.length, 0, '拖动期间不弹窗');
  crops[0].publish([], {selectionOnly:true, picked:[0], settled:true});
  assert.equal(prompts.length, 1);
  assert.equal($('#input').value, '');
  respond(false);
  assert.equal($('#input').value, '');
  crops[0].publish([], {selectionOnly:true, picked:[0], settled:true});
  respond(true);
  assert.equal($('#input').value, '123');
  assert.equal(scope.imageBatch.items[0].lines[0], '123');
  crops[0].publish(['123', '456=4'], {selected:[1]});
  respond(true);
  assert.equal($('#input').value, '123\n456');
  assert.deepEqual(Array.from(scope.imageBatch.selectedIds), ['0:0']);
  assert.equal($('#output').value, '');
});

test('重复号码手动修改后保持各自身份，重新批量标注不会追加重复行', async () => {
  const {scope, $, crops} = workspace();
  scope.ocrFiles([{type:'image/png', name:'first'}]);
  await settle();
  crops[0].publish(['123=2', '123=2'], {initial:true});
  $('#input').value = '123=9\n123=2';
  crops[0].publish(['123=2', '123=0.5'], {selected:[1]});
  assert.equal($('#input').value, '123=9\n123=0.5');
  crops[0].publish(['123=3', '123=3'], {selected:[0,1]});
  assert.equal($('#input').value, '123=3\n123=3');
});
