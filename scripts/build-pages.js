'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const files = ['index.html', 'styles.css', 'core.js', 'selection.js', 'ocr-client.js', 'app.js', 'mobile.js', 'updates.js', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg', 'sw.js'];
const version = process.env.RELEASE_VERSION || 'v' + require('../package.json').version;
if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid release version');
const hash = crypto.createHash('sha256');
let localKey = '';
try { localKey = JSON.parse(fs.readFileSync(path.join(root, 'config.local.json'), 'utf8')).apiKey || ''; } catch (_) {}
const contents = new Map();
for (const file of files) {
  const data = fs.readFileSync(path.join(root, 'public', file), 'utf8');
  if ((localKey && data.includes(localKey)) || /\bsk-[a-zA-Z0-9_-]{16,}/.test(data) || /llm-[a-z0-9]+\.[a-z-]+\.maas\.aliyuncs\.com/.test(data)) {
    throw new Error('Potential private configuration in public/' + file);
  }
  hash.update(file).update(data); contents.set(file, data);
}
const build = version + '-' + hash.digest('hex').slice(0, 12);
const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
for (const [file, source] of contents) {
  let data = source.replaceAll('__BUILD_ID__', build);
  if (file === 'index.html') data = data.replace('</head>', '<meta name="app-build" content="' + build + '">\n</head>');
  fs.writeFileSync(path.join(out, file), data);
}
fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify({ version, build }) + '\n');
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('Pages build ready: ' + build + ' (explicit public asset allowlist; no local config)');
