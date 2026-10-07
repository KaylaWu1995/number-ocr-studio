/* Browser-only OCR. No server configuration or default credential is read. */
(function () {
'use strict';
const CONFIG_KEY = 'number-ocr-browser-config-v1';
const DEFAULTS = { provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-ocr-latest', apiKey: '', ocrPrompt: '', remember: false };
function read() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(sessionStorage.getItem(CONFIG_KEY) || localStorage.getItem(CONFIG_KEY) || '{}')); }
  catch (_) { return Object.assign({}, DEFAULTS); }
}
function merge(patch) {
  const cfg = read();
  for (const k of ['provider', 'baseUrl', 'model', 'ocrPrompt']) if (typeof patch[k] === 'string') cfg[k] = patch[k].trim();
  if (patch.apiKey === '__CLEAR__') cfg.apiKey = '';
  else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) cfg.apiKey = patch.apiKey.trim();
  if (typeof patch.remember === 'boolean') cfg.remember = patch.remember;
  if (!['dashscope', 'dashscope-native', 'openai'].includes(cfg.provider)) throw new Error('不支持的服务提供方');
  const url = new URL(cfg.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('请输入不带密码、查询参数的 HTTPS 接口地址');
  return cfg;
}
function save(cfg) {
  // Write first so a storage quota error does not delete the previous config.
  (cfg.remember ? localStorage : sessionStorage).setItem(CONFIG_KEY, JSON.stringify(cfg));
  (cfg.remember ? sessionStorage : localStorage).removeItem(CONFIG_KEY);
}
function summary(cfg) {
  return Object.assign({}, cfg, { apiKey: undefined, ok: true, hasKey: !!cfg.apiKey, keyMasked: cfg.apiKey ? '已保存（不显示密钥）' : '' });
}
const OCR_PROMPT = [
  '这是一张手写号码纸的照片。请提取纸上手写的**号码**，每行一个。',
  '要求：',
  '- 号码是 3 位或 4 位，字符只能是 0-9，或者手写的乘号（×、x、*、+ 都算 X），例如 4271、649、42×4、4×94。',
  '- 纸上的大括号「}」只是把相邻两行号码括在一起，不是数字，绝对不要识别成 3、2、1 等数字。',
  '- 大括号旁边的「各2元」「各5角」是金额备注，不要输出。',
  '- 顶部的「36.-」「⑦」是金额和序号，不要输出。',
  '- 算式像「42×4=168（元）」，只输出等号左边的号码「42×4」，等号右边和括号里的内容不要输出。',
  '- 只输出号码本身，不要任何其他文字、标点或解释。',
  '- 输出前自检：每一行都必须是 3 位或 4 位，出现 5 位就说明读错了，请重新判断。'
].join('\n');

// 图像像素阈值：小于 min_pixels 会放大、大于 max_pixels 会缩小（手写小图放大后识别更准）
const MIN_PIXELS = 64 * 64;          // 4096，兼容 OCR 与视觉定位模型
const MAX_PIXELS = 32 * 32 * 8192;   // 8388608

const NATIVE_PATH = '/services/aigc/multimodal-generation/generation';
const PUBLIC_COMPATIBLE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

function endpointFor(cfg) {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  const native = (cfg.nativeUrl || '').replace(/\/+$/, '');

  if (cfg.provider === 'dashscope-native') {
    if (base.endsWith(NATIVE_PATH)) return base;                 // 已经填了完整地址
    if (native) return native + NATIVE_PATH;
    if (base.includes('compatible-mode')) {
      return base.replace(/\/compatible-mode\/v1$/, '') + '/api/v1' + NATIVE_PATH;
    }
    if (base) return base + NATIVE_PATH;
    return 'https://dashscope.aliyuncs.com/api/v1' + NATIVE_PATH;
  }
  if (base.endsWith('/chat/completions')) return base;           // 已经填了完整地址
  return (base || PUBLIC_COMPATIBLE) + '/chat/completions';
}

function buildRequest(cfg, imageDataUrl, prompt) {
  if (cfg.provider === 'dashscope-native') {
    return {
      model: cfg.model,
      input: {
        messages: [{
          role: 'user',
          content: [
            {
              image: imageDataUrl,
              min_pixels: MIN_PIXELS,
              max_pixels: MAX_PIXELS,
              enable_rotate: true // 拍歪的照片自动转正
            },
            { text: prompt }
          ]
        }]
      },
      parameters: {}
    };
  }
  return {
    model: cfg.model,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: imageDataUrl },
          min_pixels: MIN_PIXELS,
          max_pixels: MAX_PIXELS
        },
        { type: 'text', text: prompt }
      ]
    }]
  };
}

function extractText(cfg, data) {
  if (!data) return '';
  if (cfg.provider === 'dashscope-native') {
    const c = data.output && data.output.choices && data.output.choices[0];
    const content = c && c.message && c.message.content;
    if (Array.isArray(content)) return content.map((p) => p.text || '').join('\n');
    if (typeof content === 'string') return content;
    return '';
  }
  const choice = data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p.text || '').join('\n');
  return '';
}


async function call(cfg, image, prompt, signal) {
  if (!cfg.apiKey) throw new Error('请先在设置中填写你自己的 OCR API Key');
  const response = await fetch(endpointFor(cfg), {
    method: 'POST', credentials: 'omit', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify(buildRequest(cfg, image, prompt || cfg.ocrPrompt || OCR_PROMPT))
  });
  if (!response.ok) throw new Error('OCR 接口返回 ' + response.status + '，请检查自己的密钥、地址、模型和额度');
  const data = await response.json();
  if (data.error || (data.code && !data.output && !data.choices)) throw new Error('OCR 服务返回错误，请检查模型与配置');
  return { text: extractText(cfg, data), usage: data.usage || null };
}
function json(data, status) { return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } }); }
async function request(path, options) {
  const opts = options || {};
  try {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (path === '/api/config') {
      if (opts.method === 'POST') { const cfg = merge(body); save(cfg); return json(summary(cfg)); }
      return json(summary(read()));
    }
    const cfg = merge(path === '/api/ocr/test' ? body : {});
    if (path === '/api/ocr/test') {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 96;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 96, 96);
      ctx.fillStyle = 'black'; ctx.font = '24px sans-serif'; ctx.fillText('1234', 10, 50);
      const start = Date.now();
      await call(cfg, canvas.toDataURL(), '只回复：正常', opts.signal);
      return json({ ok: true, ms: Date.now() - start, model: cfg.model });
    }
    if (path === '/api/ocr/regions') {
      if (!body.image) throw new Error('缺少图片');
      if (/^dashscope/.test(cfg.provider) && /ocr/i.test(cfg.model)) cfg.model = 'qwen-vl-max';
      const selection = window.OCRSelection;
      const dimensions = Number.isInteger(body.width) && Number.isInteger(body.height) && body.width > 0 && body.height > 0 ? { width: body.width, height: body.height } : null;
      const out = await call(cfg, body.image, dimensions ? selection.regionPrompt(body.width, body.height) : selection.REGION_PROMPT, opts.signal);
      return json({ ok: true, groups: selection.parseRegions(out.text, dimensions), model: cfg.model });
    }
    if (path === '/api/ocr') return json(Object.assign({ ok: true }, await call(cfg, body.image, body.prompt, opts.signal)));
    return json({ error: '未知操作' }, 404);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return json({ ok: false, error: err instanceof TypeError ? '无法直连接口，请检查网络、HTTPS 地址及服务商的跨域（CORS）支持' : err.message }, 400);
  }
}
window.OCRBrowser = { request };
})();
