#!/usr/bin/env node
/**
 * 号码整理工具 —— 本地服务
 *
 * 作用：
 *   1. 把 public/ 目录作为网页托管出来（Windows 上可用 Edge/Chrome 安装成独立窗口应用）
 *   2. OCR 由浏览器直连用户服务商，不读取本地密钥，不提供共用 OCR 接口
 *
 * 零依赖，Node 18+ 即可运行：node server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEFAULT_PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0'; // 监听所有网卡，手机才能通过局域网访问
const MAX_BODY = 30 * 1024 * 1024; // 30MB，手机拍的照片也够用
let ACTIVE_PORT = DEFAULT_PORT;   // 实际监听的端口（被占用时会顺延）


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('图片太大（超过 30MB），请压缩后再试'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // 单页应用回退
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

async function handleApi(req, res, urlPath) {
  return sendJson(res, 410, { error: '共用 OCR 接口已关闭。请在浏览器设置中配置自己的 API，直接连接服务商。' });
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (urlPath.startsWith('/api/')) {
    handleApi(req, res, urlPath).catch((err) => {
      const code = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      console.error('[api error]', urlPath, err.message);
      sendJson(res, code, { error: err.message, detail: err.detail || '' });
    });
    return;
  }
  serveStatic(req, res, urlPath);
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((info) => {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    });
  });
  return out;
}

/** 打开浏览器；Windows/macOS 上优先用 Edge/Chrome 的「应用模式」，看起来就是个独立客户端 */
function openBrowser(url) {
  const { spawn, exec } = require('child_process');
  const fsx = fs;
  const tryPaths = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    tryPaths.push(
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(local, 'Google\\Chrome\\Application\\chrome.exe')
    );
  } else if (process.platform === 'darwin') {
    tryPaths.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  }
  for (const p of tryPaths) {
    try {
      if (p && fsx.existsSync(p)) {
        spawn(p, ['--app=' + url], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
    } catch (_) { /* 继续尝试下一个 */ }
  }
  const cmd = process.platform === 'win32' ? 'start "" "' + url + '"'
    : process.platform === 'darwin' ? 'open "' + url + '"'
      : 'xdg-open "' + url + '"';
  exec(cmd, () => {});
}

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error('启动失败：' + err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    ACTIVE_PORT = port;
    console.log('');
    console.log('  号码整理工具已启动');
    console.log('  ─────────────────────────────────────────');
    console.log('  本机使用：  http://127.0.0.1:' + port);
    lanAddresses().forEach((ip) => {
      console.log('  手机/平板： http://' + ip + ':' + port + '   （需同一 Wi-Fi）');
    });
    console.log('  ─────────────────────────────────────────');
    console.log('  API Key：  ' + (cfg.apiKey ? '已配置 ' + maskKey(cfg.apiKey) : '未配置（点网页右上角「设置」填写）'));
    console.log('  按 Ctrl+C 退出');
    console.log('');
    if (process.argv.includes('--open')) openBrowser('http://127.0.0.1:' + port);

    // 路由器重新分配 IP 后，原来的地址就失效了 —— 这里盯着，一变就提示新地址
    let lastLan = lanAddresses().join(',');
    setInterval(() => {
      const now = lanAddresses();
      const key = now.join(',');
      if (key === lastLan) return;
      lastLan = key;
      console.log('');
      if (!now.length) {
        console.log('  ⚠ 网络断开了，其他设备暂时连不上。恢复后这里会提示新地址。');
      } else {
        console.log('  ⚠ 本机 IP 变了！其他设备请改用下面的新地址（旧地址已失效）：');
        now.forEach((ip) => console.log('     http://' + ip + ':' + port));
      }
      console.log('');
    }, 10000).unref();
  });
}

if (require.main === module) listen(DEFAULT_PORT, 10);

module.exports = { server };
