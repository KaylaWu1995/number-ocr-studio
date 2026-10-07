/* Never interrupt editing: the user chooses when to reload a deployed version. */
(function () {
  'use strict';
  var current = document.querySelector('meta[name="app-build"]');
  if (!current) return;
  var notice, busy = false;
  async function check() {
    if (busy || document.hidden || notice) return;
    busy = true;
    try {
      var response = await fetch('version.json', { cache: 'no-store' });
      if (!response.ok) return;
      var next = await response.json();
      if (!next.build || next.build === current.content) return;
      notice = document.createElement('button');
      notice.className = 'btn tiny';
      notice.textContent = '有新版本';
      notice.title = '保存文本后刷新；图片选择请先完成或识别后再更新';
      notice.onclick = async function () {
        if (!confirm('将保存输入和输出文本并刷新。当前图片、选区和撤销记录不会保留，确认更新？')) return;
        // A storage failure cancels reload rather than losing the current text.
        try {
          localStorage.setItem('number-ocr-studio-v2', JSON.stringify({ leftText: document.getElementById('input').value, output: document.getElementById('output').value }));
          var registration = await navigator.serviceWorker?.getRegistration();
          if (registration) await registration.update();
          location.reload();
        } catch (_) { alert('更新未完成，请先复制保存文本后刷新。'); }
      };
      document.querySelector('.topbar-icons').appendChild(notice);
    } catch (_) { /* Offline: keep the current version. */ }
    finally { busy = false; }
  }
  check(); setInterval(check, 60000);
  document.addEventListener('visibilitychange', check);
})();
