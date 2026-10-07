const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function viewport() {
  const properties = new Map();
  const scroller = {scrollTop:0, getBoundingClientRect:() => ({top:80, bottom:280, height:200})};
  const field = {matches:() => true, closest:() => scroller,
    getBoundingClientRect:() => ({top:310, bottom:350})};
  const scope = {media:{matches:true}, body:{style:{
    getPropertyValue:key => properties.get(key), setProperty:(key,value) => properties.set(key,value)
  }}, window:{innerHeight:800, visualViewport:{height:400, offsetTop:30, scale:1}},
  document:{activeElement:field}};
  const source = fs.readFileSync(require.resolve('../public/mobile'), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('  function revealModalField()'), source.indexOf('  function viewportTick(')), scope);
  return {scope, properties, scroller, field};
}

test('移动弹窗使用键盘上方可见高度和偏移，键盘收起后恢复高度', () => {
  const {scope,properties,scroller} = viewport();
  scope.measureViewport();
  assert.equal(properties.get('--mobile-height'),'400px');
  assert.equal(properties.get('--mobile-top'),'30px');
  assert.equal(scroller.scrollTop,78);
  scope.measureViewport();
  assert.equal(scroller.scrollTop,78,'视口未变化时不干扰手动滚动');
  scope.window.visualViewport.height=800;
  scope.window.visualViewport.offsetTop=0;
  scope.measureViewport();
  assert.equal(properties.get('--mobile-height'),'800px');
  assert.equal(properties.get('--mobile-top'),'0px');
});

test('弹窗输入项可见时不滚动，超高输入项对齐顶部，非弹窗输入不滚动', () => {
  const {scope,scroller,field} = viewport();
  field.getBoundingClientRect=() => ({top:100,bottom:150});
  scope.revealModalField();
  assert.equal(scroller.scrollTop,0);
  field.getBoundingClientRect=() => ({top:120,bottom:500});
  scope.revealModalField();
  assert.equal(scroller.scrollTop,32);
  field.closest=() => null;
  scope.revealModalField();
  assert.equal(scroller.scrollTop,32);
});

test('缩放中保留原视口尺寸，缺少 visualViewport 时使用窗口高度', () => {
  const {scope,properties} = viewport();
  scope.window.visualViewport.scale=2;
  scope.measureViewport();
  assert.equal(properties.size,0);
  scope.window.visualViewport=null;
  scope.measureViewport();
  assert.equal(properties.get('--mobile-height'),'800px');
});
