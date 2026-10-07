/* Mobile presentation only. Reuse existing actions so editing semantics stay identical. */
(function () {
  'use strict';
  var media = window.matchMedia('(max-width: 860px)');
  var active = 'input';
  var body = document.body;
  var nav = document.createElement('nav');
  nav.className = 'mobile-nav';
  nav.setAttribute('aria-label', '编辑区域');
  nav.innerHTML = '<button type="button" data-pane="image" class="hidden" aria-controls="panelImage"><span class="mobile-pane-label">图片</span></button>' +
    '<button type="button" data-pane="input" aria-controls="panelInput"><span class="mobile-pane-label"><svg class="mobile-pane-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20H4v-8M14 5l5 5M5 19l1-5L16 4a2.1 2.1 0 0 1 3 3L9 17z"/></svg>输入</span><small id="mobileInputCount"></small></button>' +
    '<button type="button" data-pane="output" aria-controls="panelOutput"><span class="mobile-pane-label"><svg class="mobile-pane-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H5v18h14V8zM14 3v5h5M8 14l3 3 5-6"/></svg>输出</span><small id="mobileOutputCount"></small></button>' +
    '<button type="button" id="mobileFont" aria-pressed="false">大字</button>' +
    '<button type="button" id="mobileDone">完成</button>';
  var topbar = document.querySelector('.topbar');
  var rail = document.createElement('div');
  rail.className = 'mobile-rail';
  topbar.before(rail);
  rail.append(topbar, nav);
  var toasts = document.getElementById('toasts');
  rail.before(toasts);
  toasts.setAttribute('role', 'status');
  var bar = document.createElement('div');
  bar.className = 'mobile-actions';
  body.appendChild(bar);
  var actions = {
    input: [['btnFormat', '格式整理'], ['btnReverse', '全倒'], ['btnThreeX', '3字X'], ['btnCopyAllInput', '全部复制']],
    output: [['btnSetSuffix', '添加 =N'], ['btnClearSuffix', '清除后缀'], ['btnDedupeAll', '去重'], ['btnCopyAll', '全部复制']]
  };
  function button(id, label) {
    return '<button type="button" class="btn" data-action="' + id + '">' + label + '</button>';
  }
  function render() {
    body.dataset.mobilePane = active;
    nav.querySelectorAll('[data-pane]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.pane === active));
    });
    if (active === 'image') { bar.innerHTML = ''; return; }
    var input = active === 'input';
    bar.innerHTML = '<div class="mobile-primary">' + actions[active].map(function (a) { return button(a[0], a[1]); }).join('') + '</div>' +
      '<div class="mobile-secondary">' + button(input ? 'btnUndoInput' : 'btnUndo', '撤销') +
      button(input ? 'btnSelectAllInput' : 'btnSelectAllOutput', '全选') +
      button(input ? 'btnSelectGroupInput' : 'btnSelectGroupOutput', '选择组') +
      button(input ? 'btnClearInput' : 'btnClearOutput', '清空') +
      (input ? button('btnOcr', '上传图片') : '') + '</div>';
  }
  var viewportFrame = 0;
  var settleUntil = 0;
  function revealModalField() {
    var field = document.activeElement;
    if (!field || !field.matches('input, textarea, select, [contenteditable="true"]')) return;
    var scroller = field.closest('.modal-body');
    if (!scroller) return;
    var bounds = scroller.getBoundingClientRect();
    var rect = field.getBoundingClientRect();
    if (bounds.height <= 0) return;
    // 只滚动弹窗正文，保持底部按钮和页面位置稳定。
    if (rect.top < bounds.top + 8) scroller.scrollTop += rect.top - bounds.top - 8;
    else if (rect.bottom > bounds.bottom - 8) {
      scroller.scrollTop += Math.min(rect.bottom - bounds.bottom + 8, rect.top - bounds.top - 8);
    }
  }
  function measureViewport() {
    if (!media.matches) return;
    var v = window.visualViewport;
    // Preserve native pinch zoom; resume measuring once the user returns to 1x.
    if (v && Math.abs(v.scale - 1) > 0.05) return;
    var height = Math.min(window.innerHeight, v ? v.height : window.innerHeight);
    if (!Number.isFinite(height) || height <= 0) return;
    var top = v ? Math.max(0, v.offsetTop) : 0;
    var heightValue = Math.floor(height) + 'px';
    var topValue = Math.round(top) + 'px';
    var changed = body.style.getPropertyValue('--mobile-height') !== heightValue ||
      body.style.getPropertyValue('--mobile-top') !== topValue;
    if (body.style.getPropertyValue('--mobile-height') !== heightValue) {
      body.style.setProperty('--mobile-height', heightValue);
    }
    if (body.style.getPropertyValue('--mobile-top') !== topValue) {
      body.style.setProperty('--mobile-top', topValue);
    }
    if (changed) revealModalField();
  }
  function viewportTick(now) {
    viewportFrame = 0;
    if (!media.matches || document.hidden) return;
    measureViewport();
    // Mobile browsers can report the old viewport on focus/resize, then update it
    // during the keyboard animation without delivering another reliable event.
    if (now < settleUntil) viewportFrame = requestAnimationFrame(viewportTick);
  }
  function viewport() {
    if (!media.matches || document.hidden) return;
    settleUntil = performance.now() + 1000;
    if (!viewportFrame) viewportFrame = requestAnimationFrame(viewportTick);
  }
  function finish() {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    body.classList.remove('mobile-editing');
    viewport();
  }
  function mode() {
    if (media.matches) {
      render();
      if (document.activeElement.id === 'input' || document.activeElement.id === 'output') {
        active = document.activeElement.id;
        render();
        body.classList.add('mobile-editing');
      }
      viewport();
    } else {
      cancelAnimationFrame(viewportFrame);
      viewportFrame = 0;
      settleUntil = 0;
      body.classList.remove('mobile-editing');
      body.style.removeProperty('--mobile-height');
      body.style.removeProperty('--mobile-top');
    }
  }
  ['input', 'output'].forEach(function (id) {
    document.getElementById(id).addEventListener('focus', function () {
      if (!media.matches) return;
      if (active !== id) { active = id; render(); }
      body.classList.add('mobile-editing');
      viewport();
    });
  });
  // Keep the textarea's native selection and keyboard when touching editing actions.
  [nav, bar].forEach(function (el) {
    el.addEventListener('pointerdown', function (e) {
      if (media.matches && e.target.closest('button')) e.preventDefault();
    });
  });
  function switchPane(id) {
    var editing = body.classList.contains('mobile-editing');
    if (active === id) return;
    // Transfer focus directly: an explicit blur can start closing the keyboard.
    active = id;
    render();
    if (id === 'image') finish();
    else if (editing) document.getElementById(active).focus({ preventScroll: true });
    window.dispatchEvent(new Event('resize'));
    viewport();
  }
  document.addEventListener('image-workspace-opened', function () {
    nav.querySelector('[data-pane="image"]').classList.remove('hidden');
    if (media.matches) switchPane('image');
  });
  document.addEventListener('image-workspace-closed', function () {
    nav.querySelector('[data-pane="image"]').classList.add('hidden');
    if (active === 'image') switchPane('input');
  });
  document.addEventListener('output-generated', function () {
    if (media.matches && active === 'input') switchPane('output');
  });
  nav.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.pane) {
      switchPane(b.dataset.pane);
    } else if (b.id === 'mobileDone') finish();
    else if (b.id === 'mobileFont') {
      var large = body.classList.toggle('mobile-large');
      b.setAttribute('aria-pressed', String(large));
      window.dispatchEvent(new Event('resize'));
    }
  });
  bar.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.action) {
      var original = document.getElementById(b.dataset.action);
      if (original && !original.disabled) {
        // Release the editor before opening the native image picker.
        if (b.dataset.action === 'btnOcr') finish();
        original.click();
      }
    }
  });
  // Counts stay current for typing, OCR, undo and generated results.
  [['inputCount', 'mobileInputCount'], ['rowCount', 'mobileOutputCount']].forEach(function (pair) {
    var source = document.getElementById(pair[0]);
    function update() { document.getElementById(pair[1]).textContent = source.textContent; }
    new MutationObserver(update).observe(source, { childList: true, characterData: true, subtree: true });
    update();
  });
  // Text dialogs restore the active editor; the image view does not open a keyboard.
  var modal = document.getElementById('modalBackdrop');
  new MutationObserver(function () {
    if (!media.matches) return;
    viewport();
    if (active !== 'image' && modal.classList.contains('hidden') && body.classList.contains('mobile-editing')) {
      document.getElementById(active).focus({ preventScroll: true });
    }
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  media.addEventListener('change', mode);
  window.addEventListener('resize', viewport);
  window.addEventListener('orientationchange', viewport);
  window.addEventListener('pageshow', viewport);
  window.addEventListener('scroll', viewport, { passive: true });
  // Includes suffix dialogs and keyboard dismissal via the system's Done button.
  document.addEventListener('focusin', viewport);
  document.addEventListener('focusin', function () {
    if (media.matches) requestAnimationFrame(revealModalField);
  });
  document.addEventListener('focusout', viewport);
  document.addEventListener('visibilitychange', viewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', viewport);
    window.visualViewport.addEventListener('scroll', viewport);
    window.visualViewport.addEventListener('scrollend', viewport);
  }
  mode();
})();
