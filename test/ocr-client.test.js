const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function client(fetcher = () => { throw new Error('unexpected network'); }) {
  const storage = () => { const data = new Map(); return { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) }; };
  const scope = { window: { OCRSelection: require('../public/selection') }, sessionStorage: storage(), localStorage: storage(), Response, URL, fetch: fetcher };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/ocr-client'), 'utf8'), scope);
  return { ...scope, request: scope.window.OCRBrowser.request };
}
const post = body => ({ method: 'POST', body: JSON.stringify(body) });
test('browser config starts empty, session-only by default, clear removes saved key', async () => {
  const c = client();
  assert.equal((await (await c.request('/api/config')).json()).hasKey, false);
  const data = await (await c.request('/api/config', post({ apiKey: 'test-only-secret' }))).json();
  assert.equal(data.hasKey, true); assert.equal(data.apiKey, undefined);
  const k = 'number-ocr-browser-config-v1';
  assert.ok(c.sessionStorage.getItem(k)); assert.equal(c.localStorage.getItem(k), undefined);
  await c.request('/api/config', post({ remember: true }));
  assert.ok(c.localStorage.getItem(k)); assert.equal(c.sessionStorage.getItem(k), undefined);
  await c.request('/api/config', post({ apiKey: '__CLEAR__' }));
  assert.ok(!c.localStorage.getItem(k).includes('test-only-secret'));
  assert.equal((await (await c.request('/api/config')).json()).hasKey, false);
});
test('no credential means no OCR network; non-HTTPS endpoints rejected', async () => {
  const c = client();
  assert.equal((await c.request('/api/ocr', post({ image: 'test' }))).status, 400);
  assert.equal((await c.request('/api/config', post({ baseUrl: 'http://example.test/v1' }))).status, 400);
});
test('region OCR sends only user credential to configured host, parses dimensions', async () => {
  let sent;
  const c = client(async (url, opts) => { sent = { url, opts }; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ groups: [{ text: '0123', box: [10, 10, 90, 40] }] }) } }] })); });
  await c.request('/api/config', post({ baseUrl: 'https://example.test/v1', apiKey: 'test-only-secret' }));
  const result = await (await c.request('/api/ocr/regions', post({ image: 'test', width: 100, height: 100 }))).json();
  assert.equal(result.ok, true); assert.equal(result.groups[0].text, '0123');
  assert.equal(sent.url, 'https://example.test/v1/chat/completions');
  assert.equal(sent.opts.headers.Authorization, 'Bearer test-only-secret');
  assert.equal(sent.opts.credentials, 'omit'); assert.equal(sent.opts.redirect, 'error');
  assert.equal(JSON.parse(sent.opts.body).model, 'qwen-vl-max');
});

test('Qwen3 VL 定位框保持模型的 0-1000 坐标，不按竖图高度重复压缩', async () => {
  let sent;
  const groups = [{ text: '6714', box: [203, 325, 359, 358] }, { text: '9214', box: [203, 820, 359, 853] }];
  const c = client(async (url, opts) => {
    sent = JSON.parse(opts.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ groups }) } }] }));
  });
  await c.request('/api/config', post({ model: 'qwen3-vl-plus', apiKey: 'test-only-secret' }));
  const result = await (await c.request('/api/ocr/regions', post({ image: 'test', width: 1080, height: 1920 }))).json();
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.groups.map(g => g.box))), groups.map(g => g.box));
  const prompt = sent.messages[0].content[1].text;
  assert.match(prompt, /归一化到 0—1000/);
  assert.doesNotMatch(prompt, /原图像素坐标/);
});
test('legacy server never exposes shared config or performs paid OCR', async () => {
  const { server } = require('../server');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const path of ['/api/config', '/api/ocr', '/api/ocr/regions', '/api/ocr/test']) {
      const response = await fetch('http://127.0.0.1:' + server.address().port + path);
      assert.equal(response.status, 410);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('模型不存在时说明模型与业务空间问题，兼容两种服务商错误格式', async () => {
  for (const body of [{error:{code:'model_not_found',message:'Model not exist.'}}, {code:'InvalidParameter',message:'Model not exist.'}]) {
    const c = client(async () => new Response(JSON.stringify(body),{status:404}));
    await c.request('/api/config',post({apiKey:'test-only-secret'}));
    const data = await (await c.request('/api/ocr',post({image:'test'}))).json();
    assert.match(data.error,/404.*业务空间.*qwen-vl-ocr-latest/);
    assert.doesNotMatch(data.error,/额度|test-only-secret/);
  }
});

test('其他接口失败保留错误原因并隐藏密钥，非JSON响应保留HTTP状态', async () => {
  for (const response of [new Response(JSON.stringify({error:{code:'invalid_api_key',message:'Invalid test-only-secret'}}),{status:401}), new Response('Not found',{status:404})]) {
    const c=client(async () => response);
    await c.request('/api/config',post({apiKey:'test-only-secret'}));
    const data=await (await c.request('/api/ocr',post({image:'test'}))).json();
    assert.match(data.error,/OCR 接口返回 (401|404)/);
    assert.doesNotMatch(data.error,/test-only-secret/);
    if(response.status===401) assert.match(data.error,/invalid_api_key/);
  }
});

test('Qwen3 VL 图片请求使用服务商要求的最小像素，其他模型保留原阈值', async () => {
  for (const provider of ['dashscope','dashscope-native']) {
    for (const [model,minPixels] of [['qwen3-vl-plus',65536],['qwen3-vl-flash',65536],['qwen-vl-ocr-2025-11-20',4096]]) {
      let sent;
      const c=client(async (url,opts) => {sent=JSON.parse(opts.body);return new Response(JSON.stringify(provider==='dashscope-native' ? {output:{choices:[{message:{content:[{text:'1234'}]}}]}} : {choices:[{message:{content:'1234'}}]}));});
      await c.request('/api/config',post({provider,model,apiKey:'test-only-secret'}));
      const result=await (await c.request('/api/ocr',post({image:'test'}))).json();
      assert.equal(result.ok,true);
      const image=provider==='dashscope-native' ? sent.input.messages[0].content[0] : sent.messages[0].content[0];
      assert.equal(image.min_pixels,minPixels);
    }
  }
});
