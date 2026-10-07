const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../public/core');

function workspace() {
  const source = fs.readFileSync(require.resolve('../public/app'), 'utf8');
  const input = { value: '1234=2\n5678=0.5', selectionStart: 0, selectionEnd: 0, focus() {} };
  const output = { value: '', focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const undo = [];
  const scope = { C, state: {}, imageBatch: null,
    $: id => id === '#output' ? output : input,
    normalizeLines: lines => Array.from(lines),
    applyOutput(text) { output.value = text; },
    setOutput(lines) { output.value = lines.join('\n'); },
    pushUndo() { undo.push(output.value); }, commit() {},
    trackImageDraft() {}, toast() {}, showSkipNotice() {},
    describeGroups: () => '', groupSizes: () => [],
    getLines: () => output.value.split('\n'),
    getComputedStyle: () => ({lineHeight:'30px'}), syncScroll() {}, updateSelHint() {},
    Event: function() {}, document: {dispatchEvent() {}}
  };
  vm.runInNewContext(source.slice(source.indexOf('  function outputLines('), source.indexOf('  function groupSizes(')), scope);
  return {scope, input, output, undo};
}

 test('两栏和三栏追加全倒、3字X，保留旧内容且只选中新批次，可整批撤销', () => {
  for (const image of [false, true]) {
    const {scope, input, output, undo} = workspace();
    if (image) scope.imageBatch = {selectedIds:new Set(['0:0']), draftOwners:['0:0','0:1']};
    output.value = '\n旧结果=9  \n';
    input.selectionStart=7; input.selectionEnd=input.value.length;
    for (const [action, expand] of [['doReverse','expandReverse'],['doThreeX','expandThreeX']]) {
      const old = output.value;
      const expected = C.joinGroups(C[expand]('5678=0.5').groups).join('\n');
      scope[action]();
      assert.ok(output.value.startsWith(old));
      assert.equal(output.value.slice(output.selectionStart, output.selectionEnd),expected);
      assert.equal(output.selectionEnd,output.value.length);
      assert.equal(undo.at(-1),old);
      assert.equal(input.value,'1234=2\n5678=0.5');
    }
  }
});

test('无文本选区时处理图片选区或全部，空白选区不改变输出及选择', () => {
  const {scope,input,output} = workspace();
  scope.imageBatch={selectedIds:new Set(['0:0']),draftOwners:['0:0','0:1']};
  scope.doThreeX();
  assert.equal(output.value,C.joinGroups(C.expandThreeX('1234=2').groups).join('\n'));
  assert.equal(output.selectionStart,0);
  scope.imageBatch.selectedIds.clear();
  scope.doReverse();
  assert.equal(output.value.slice(output.selectionStart,output.selectionEnd),C.joinGroups(C.expandReverse(input.value).groups).join('\n'));
  scope.imageBatch=null;
  scope.doThreeX();
  assert.equal(output.value.slice(output.selectionStart,output.selectionEnd),C.joinGroups(C.expandThreeX(input.value).groups).join('\n'));
  input.value='1234\n   '; input.selectionStart=5;input.selectionEnd=8;
  const before={...output};
  scope.doReverse();
  assert.deepEqual(output,before);
});
