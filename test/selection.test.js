const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRegions, intersects } = require('../public/selection');

test('混合三四位、前导零、X 归一化，重复号码不同位置保留', () => {
  const groups = ['012', '0123', '42×4', '012'].map((text, i) => ({ text, box: [i * 100, 0, i * 100 + 90, 50] }));
  assert.deepEqual(parseRegions('```json\n' + JSON.stringify({ groups }) + '\n```').map(g => g.text), ['012', '0123', '42X4', '012']);
});
test('不截断长串、不接受非法格式或越界坐标，重复框只保留一次', () => {
  const groups = ['1234567', 'X23', 'XXX4', '12', '123'].map(text => ({ text, box: [0, 0, 100, 50] }));
  groups.push({ text: '123', box: [0, 0, 100, 50] }, { text: '1234', box: [0, 0, 1001, 50] },
    { text: '1234', box: [100, 0, 0, 50] }, { text: '1234', box: ['0', 0, 100, 50] });
  assert.equal(parseRegions(JSON.stringify({ groups })).length, 1);
  assert.throws(() => parseRegions('123\n1234'));
  assert.throws(() => parseRegions('{}'));
  assert.deepEqual(parseRegions('{"groups":[]}'), []);
});
test('点选及快速拖过命中，支持反向、斜线，空白和邻行不命中', () => {
  const r = { x: 10, y: 10, w: 30, h: 20 };
  assert.equal(intersects({ x: 15, y: 15 }, { x: 15, y: 15 }, r), true);
  assert.equal(intersects({ x: 0, y: 20 }, { x: 100, y: 20 }, r), true);
  assert.equal(intersects({ x: 100, y: 20 }, { x: 0, y: 20 }, r), true);
  assert.equal(intersects({ x: 0, y: 0 }, { x: 50, y: 50 }, r), true);
  assert.equal(intersects({ x: 0, y: 40 }, { x: 100, y: 40 }, r), false);
  assert.equal(intersects({ x: 0, y: 0 }, { x: 0, y: 0 }, r), false);
});

test('旧服务 404 自动用现有 OCR 接口定位，保留取消信号与图片', async () => {
  const { requestRegions, REGION_PROMPT } = require('../public/selection');
  const calls = [], controller = new AbortController();
  const result = await requestRegions(async (url, opts) => {
    calls.push({ url, opts });
    return calls.length === 1 ? { status: 404, ok: false } : {
      status: 200, ok: true, json: async () => ({ ok: true, text: JSON.stringify({ groups: [{ text: '012', box: [10, 10, 80, 40] }] }) })
    };
  }, '/base', 'image-data', controller.signal);
  assert.equal(result.groups[0].text, '012');
  assert.deepEqual(calls.map(c => c.url), ['/base/api/ocr/regions', '/base/api/ocr']);
  assert.deepEqual(JSON.parse(calls[1].opts.body), { image: 'image-data', prompt: REGION_PROMPT });
  assert.equal(calls[1].opts.signal, controller.signal);
});

test('定位服务真实错误不重复调用 OCR', async () => {
  const { requestRegions } = require('../public/selection');
  let calls = 0;
  await assert.rejects(requestRegions(async () => {
    calls++;
    return { status: 500, ok: false, json: async () => ({ error: '模型不可用' }) };
  }, '', 'image'), /模型不可用/);
  assert.equal(calls, 1);
});

test('实图号码与干扰信息混合：保留12组、过滤标题金额括号，像素坐标转归一化', () => {
  const numbers = ['1439','1458','5839','0469','2469','4439','4458','4417','4436','4469','5504','4504'];
  const groups = numbers.map((text, i) => ({ text, box: [80, 170 + i * 75, 280, 230 + i * 75] }));
  groups.push({ text: '各2角', box: [330, 170, 640, 260] }, { text: '14', box: [350, 50, 450, 160] },
    { text: '}', box: [280, 170, 320, 310] }, { text: '123456', box: [1,1,20,20] });
  const out = parseRegions(JSON.stringify({ groups }), { width: 664, height: 1190 });
  assert.deepEqual(out.map(g => g.text), numbers);
  assert.equal(out[0].box[0], 80 * 1000 / 664);
  assert.ok(out.at(-1).box[3] < 1000);
});

test('有号码但坐标格式错误不能伪装为没有合规号码', () => {
  assert.throws(() => parseRegions(JSON.stringify({ groups: [{ text: '1439', box: [262,226,61,253,90] }] })), /位置数据无效/);
  assert.throws(() => parseRegions(JSON.stringify({ groups: [{ text: '1439 全倒各2角', x: 528, y: 168, width: 250, height: 71 }] })), /备注/);
});
