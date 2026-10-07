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
