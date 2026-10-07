/*!
 * app.js —— 号码整理工具前端
 * 依赖 core.js（window.OCRCore）
 *
 * 右侧是一个大文本域：每行一组号码，可直接编辑、粘贴、删行。
 * 文本域里文字是透明的，真正的文字由下面那层 .editor-highlight 渲染，
 * 这样才能把异常行标红、重复行标黄（两层字体/内边距完全一致，滚动同步）。
 */
(function () {
  'use strict';

  var C = window.OCRCore;
  var $ = function (sel) { return document.querySelector(sel); };
  var STORAGE_KEY = 'number-ocr-studio-v2';
  var MAX_SIDE = 1800;

  /* ================================================================== *
   * 状态
   * ================================================================== */

  var state = {
    leftText: '',
    output: '',          // 右侧大文本域的内容（每行一组）
    deduped: false,
    skipped: null,
    undo: []
  };

  var shadow = '';          // 最近一次「已提交」的内容，用于撤销
  var typingBurst = false;
  var typingTimer = null;

  var saveTimer = null;
  function saveNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        leftText: state.leftText,
        output: state.output
      }));
    } catch (e) { /* 隐私模式等情况忽略 */ }
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }

  function loadSaved() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('number-ocr-studio-v1');
      if (!raw) return;
      var data = JSON.parse(raw);
      if (typeof data.leftText === 'string') state.leftText = data.leftText;
      if (typeof data.output === 'string') state.output = data.output;
      else if (Array.isArray(data.rows)) state.output = data.rows.join('\n'); // 兼容旧版逐行数据
    } catch (e) { /* 忽略损坏数据 */ }
  }

  /* ================================================================== *
   * 通用 UI：toast / modal
   * ================================================================== */

  function toast(msg, kind, ms) {
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 260);
    }, ms || 2600);
  }

  var modalOnClose = null;
  var modalOnEscape = null;
  var modalCloseOnBackdrop = true;

  function openModal(opts) {
    modalCloseOnBackdrop = opts.closeOnBackdrop !== false;
    modalOnClose = opts.onClose || null;   // 任何方式关闭（✕ / Esc / 点背景）都会回调
    modalOnEscape = opts.onEscape || null; // 返回 true 表示「Esc 我自己处理了，别关弹窗」
    $('#modalBox').classList.toggle('wide', !!opts.wide);
    $('#modalBox').classList.toggle('fill', !!opts.fill);   // 铺满窗口，空间尽量给内容
    $('#modalTitle').textContent = opts.title || '';
    var body = $('#modalBody');
    body.innerHTML = '';
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);

    var foot = $('#modalFoot');
    foot.innerHTML = '';
    (opts.buttons || []).forEach(function (b) {
      var btn = document.createElement('button');
      if (b.id) btn.id = b.id;
      btn.className = 'btn ' + (b.kind || '');
      btn.textContent = b.label;
      btn.onclick = function () { if (!b.onClick || b.onClick() !== false) closeModal(); };
      foot.appendChild(btn);
    });
    if (!opts.buttons) {
      var close = document.createElement('button');
      close.className = 'btn';
      close.textContent = '关闭';
      close.onclick = closeModal;
      foot.appendChild(close);
    }
    $('#modalBackdrop').classList.remove('hidden');
    if (opts.onOpen) opts.onOpen();
  }

  function closeModal() {
    var cb = modalOnClose;
    modalOnClose = null;
    modalOnEscape = null;
    $('#modalBackdrop').classList.add('hidden');
    if (cb) { try { cb(); } catch (e) { console.error(e); } }
  }

  function confirmModal(title, message, onYes, yesLabel) {
    openModal({
      title: title,
      body: '<div class="rules">' + message + '</div>',
      buttons: [
        { label: '取消', kind: 'ghost' },
        { label: yesLabel || '确定', kind: 'primary', onClick: onYes }
      ]
    });
  }

  /** OCR 过滤提示：告诉用户丢掉了什么，并允许放回 */
  function showOcrNotice(dropped, suspect, kept) {
    var box = $('#skipNotice');
    if (!dropped || !dropped.length) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    var head = kept
      ? '<b>已过滤 ' + dropped.length + ' 段不符合格式的内容</b>（OCR 只保留 3~4 位号码组合）：'
      : '<b>没有识别到符合格式的号码</b>，以下 ' + dropped.length + ' 段都不符合 3~4 位规则：';

    // 疑似项：给出「去掉多余那位」的建议
    var fixes = [];
    (suspect || []).forEach(function (s) {
      var f = C.suggestFix(s);
      if (f) fixes.push({ from: s, to: f });
    });

    var suspectLine = (suspect && suspect.length)
      ? '<div class="suspect">其中 <b>' + suspect.length + ' 段看起来像号码、但不符合格式</b>（常见原因：把大括号「}」、横线读成了数字，或位数不对）：' +
        suspect.slice(0, 6).map(function (d) { return '<code>' + escapeHtml(d) + '</code>'; }).join('、') +
        (suspect.length > 6 ? ' …' : '') +
        (fixes.length ? '<br>疑似修正：' + fixes.slice(0, 6).map(function (f) {
          return '<code>' + escapeHtml(f.from) + '</code> → <code>' + escapeHtml(f.to) + '</code>';
        }).join('、') + '（确认无误再采用）' : '') +
        '<br>建议：把照片裁剪到只剩号码部分、拍正一点，再识别一次。</div>'
      : '';

    box.innerHTML = head +
      dropped.slice(0, 8).map(function (d) { return '<code>' + escapeHtml(d) + '</code>'; }).join('、') +
      (dropped.length > 8 ? ' … 还有 ' + (dropped.length - 8) + ' 段' : '') +
      suspectLine +
      '<div class="notice-actions">' +
      (fixes.length ? '<button class="btn tiny" id="btnOcrFix">采用疑似修正（' + fixes.length + ' 组）</button>' : '') +
      '<button class="btn tiny" id="btnOcrDropped">查看全部 / 放回输入框</button>' +
      '<button class="btn tiny ghost" id="btnOcrDroppedHide">知道了</button>' +
      '</div>';

    var fixBtn = $('#btnOcrFix');
    if (fixBtn) fixBtn.onclick = function () {
      var values = fixes.map(function (f) { return f.to; });
      pushUndoLeft();                       // 套用疑似修正也记一步，套错了能退回
      setInput(values.join('\n'), 'replace');
      box.classList.add('hidden');
      toast('已采用 ' + values.length + ' 组疑似修正，请核对：' + values.slice(0, 4).join('、') + (values.length > 4 ? ' …' : ''), 'ok', 5000);
    };
    box.classList.remove('hidden');

    $('#btnOcrDropped').onclick = function () {
      openModal({
        title: '被过滤掉的内容（' + dropped.length + ' 段）',
        body: '<div class="rules muted small">这些内容不符合 3~4 位号码格式，已自动过滤。如果其中有你需要的，可以放回输入框手动修正。</div>' +
          '<div class="rules"><code>' + dropped.map(escapeHtml).join('</code><br><code>') + '</code></div>',
        buttons: [
          { label: '关闭', kind: 'ghost' },
          {
            label: '全部放回输入框',
            kind: '',
            onClick: function () {
              pushUndoLeft();
              setInput(dropped.join('\n'), 'append');
              toast('已把 ' + dropped.length + ' 段内容放回输入框', 'ok');
            }
          }
        ]
      });
    };
    $('#btnOcrDroppedHide').onclick = function () { box.classList.add('hidden'); };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ================================================================== *
   * 输入区
   * ================================================================== */

  function syncInput() {
    state.leftText = $('#input').value;
    if (imageBatch) trackImageDraft(imageBatch, state.leftText);
    updateInputCount();
    renderInputHighlight();
    saveSoon();
  }

  /* ---- 左侧输入框的实时校验：边打边把不合规的号码标红 ---- */

  /**
   * 按核心引擎的口径把原文切成一个个「号码组」，并给出它们在原文里的下标。
   * 与 parseText 的区别只有一点：parseText 在归一化后的串上切分，这里直接在原文上切，
   * 所以贴边 '=' 的空格/制表符（会被归一化吃掉）不算分隔符，切出来的组和引擎完全一致。
   * @returns {Array<{start:number,end:number}>}
   */
  function inputTokens(text) {
    var re = new RegExp(C.SEPARATOR.source, 'g');
    var out = [];
    var last = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0].length) { re.lastIndex++; continue; }               // 防御零宽匹配
      // 只有空格/制表符、且紧贴 '=' 的分隔符不切（"1234 = 2" 要当成一组）
      var spaces = /^[ \t]+$/.test(m[0]);
      var glued = text[m.index - 1] === '=' || text[m.index + m[0].length] === '=';
      if (spaces && glued) continue;
      if (m.index > last) out.push({ start: last, end: m.index });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ start: last, end: text.length });
    return out;
  }

  /** 生成左侧高亮层的 HTML：不合规的组套 <span class="hl-err">，其余原样转义 */
  function inputHighlightHtml(text) {
    if (!text) return '';
    var input = $('#input');
    // 失焦后继续显示原选区，输出框可同时选中新生成的批次。
    var start = input.selectionStart, end = input.selectionEnd;
    var keepSelection = document.activeElement !== input && start < end;
    function textHtml(from, to) {
      var left = Math.max(from, start), right = Math.min(to, end);
      if (!keepSelection || left >= right) return escapeHtml(text.slice(from, to));
      return escapeHtml(text.slice(from, left)) + '<span class="hl-input-selection">' +
        escapeHtml(text.slice(left, right)) + '</span>' + escapeHtml(text.slice(right, to));
    }
    var html = '';
    var cursor = 0;
    var row = 0, rowStart = 0;
    inputTokens(text).forEach(function (t) {
      while (text.indexOf('\n', rowStart) !== -1 && text.indexOf('\n', rowStart) < t.start) {
        rowStart = text.indexOf('\n', rowStart) + 1; row++;
      }
      var raw = text.slice(t.start, t.end);
      html += textHtml(cursor, t.start);
      var g = C.parseGroup(C.normalizeChars(raw));
      var linked = imageBatch && imageBatch.selectedIds && imageBatch.selectedIds.has(imageBatch.draftOwners[row]);
      if (linked) html += '<span class="hl-image-selected" data-image-row="' + row + '">';
      if (g && g.status !== 'ok') {
        html += '<span class="hl-err" title="' + escapeHtml(g.reason) + '">' + textHtml(t.start, t.end) + '</span>';
      } else {
        html += textHtml(t.start, t.end);
      }
      if (linked) html += '</span>';
      cursor = t.end;
    });
    return html + textHtml(cursor, text.length);
  }

  function renderInputHighlight() {
    var el = $('#inputHighlight');
    if (!el) return;
    // 末尾补一个零宽字符：最后那个空行的高度才和文本域一致
    el.innerHTML = inputHighlightHtml($('#input').value) + '\u200B';
    syncInputScroll();
  }

  /** 高亮层和文本域必须严丝合缝地一起滚 */
  function syncInputScroll() {
    var ta = $('#input');
    var hl = $('#inputHighlight');
    if (!ta || !hl) return;
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  }

  /** 输入计数：非空行数、空行分隔的组数，另保留格式异常提示。 */
  function updateInputCount() {
    var el = $('#inputCount');
    if (!el) return;
    var text = $('#input').value;
    if (!text.trim()) {
      el.className = 'pill';
      el.textContent = '0 行 · 0 组';
      return;
    }
    var nonEmpty = text.split('\n').filter(function (t) { return t.trim() !== ''; }).length;
    var parsed = C.parseText(text);
    var groups = splitGroups(text).length;
    el.className = 'pill' + (parsed.errorCount ? ' bad' : '');
    el.textContent = nonEmpty + ' 行 · ' + groups + ' 组' +
      (parsed.errorCount ? '（' + parsed.errorCount + ' 异常）' : '');
  }

  function setInput(text, mode) {
    var el = $('#input');
    if (mode === 'append' && el.value.trim()) {
      el.value = el.value.replace(/\s+$/, '') + '\n' + text;
    } else {
      el.value = text;
    }
    syncInput();
  }

  /**
   * 格式整理：把左侧输入框的内容**就地**整理成合规格式（每行一个号码）。
   * 合法的原样保留（含 =N 后缀）；整段不合法的先尝试救出号码（如 42×4=168（元）→ 42X4），
   * 救不出来的过滤掉并在下方提示，可一键放回，不静默删除。
   */
  function doFormatInput() {
    var el = $('#input');
    if (!el.value.trim()) { toast('左侧还没有内容', 'err'); el.focus(); return; }
    var before = C.cleanLines(el.value.split('\n')).length;
    var r = C.tidyText(el.value);
    if (!r.lines.length) {
      showOcrNotice(r.dropped, r.suspect, 0);
      toast('没有整理出合规号码，请看下方提示', 'err', 4000);
      return;
    }
    pushUndoLeft();                       // 整理会就地改写输入框，先留一步好退回
    setInput(r.lines.join('\n'), 'replace');
    outputLines(r.lines, function () {     // 同时同步一份到右边输出框
      toast('已整理成 ' + r.lines.length + ' 组，并同步到右侧' +
        (r.dropped.length ? '（过滤掉 ' + r.dropped.length + ' 段不合规内容）' : '') +
        (r.lines.length !== before ? '（原 ' + before + ' 行）' : ''), 'ok', 3600);
    });
    showOcrNotice(r.dropped, r.suspect, r.lines.length);
  }

  /* ---- 左侧输入框的撤销（和右侧那套各走各的，互不干扰） ---- */

  var undoLeft = [];          // 左边的历史快照
  var leftShadow = '';        // 最近一次「已提交」的左侧内容
  var leftBurst = false;      // 正在连续打字：这一串只算一步
  var leftTimer = null;

  function commitLeft() { leftShadow = state.leftText; }

  /** 左侧替换类操作（清空 / 放回内容）之前调用：把当前内容压进历史 */
  function pushUndoLeft() {
    if (leftBurst) { clearTimeout(leftTimer); leftBurst = false; commitLeft(); }
    undoLeft.push(leftShadow);
    if (undoLeft.length > 40) undoLeft.shift();
  }

  /** 刚开始打字：整段连续输入只记一步 */
  function beginTypingUndoLeft() {
    if (leftBurst) return;
    leftBurst = true;
    undoLeft.push(leftShadow);
    if (undoLeft.length > 40) undoLeft.shift();
  }

  function canUndoLeft() { return undoLeft.length > 0; }

  function doUndoLeft() {
    if (!undoLeft.length) { toast('没有可撤销的操作'); return; }
    clearTimeout(leftTimer);
    leftBurst = false;
    setInput(undoLeft.pop(), 'replace');   // setInput 不会反过来再压历史
    commitLeft();                          // 撤销后的内容就是新的「已提交」状态
    toast('已撤销', 'ok');
  }

  function showSkipNotice(kind, skipped) {
    var box = $('#skipNotice');
    if (!skipped || !skipped.length) {
      state.skipped = null;
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    state.skipped = { kind: kind, items: skipped };
    var label = kind === 'reverse' ? '全倒' : '3字X';
    var dropped = skipped.filter(function (s) { return !s.kept; });
    var list = skipped.slice(0, 12).map(function (s) {
      return '<code>' + escapeHtml(s.text || '(空)') + '</code> ' + escapeHtml(s.reason || '') +
        (s.kept ? '（原号码已保留在结果中）' : '');
    }).join('<br>');

    box.innerHTML =
      '<b>' + skipped.length + ' 组没有参与「' + label + '」运算</b>：<br>' + list +
      (skipped.length > 12 ? '<br>… 还有 ' + (skipped.length - 12) + ' 组' : '') +
      '<div class="notice-actions">' +
      (dropped.length ? '<button class="btn tiny" id="btnSkipAppend">把这 ' + dropped.length + ' 组追加到结果末尾</button>' : '') +
      '<button class="btn tiny ghost" id="btnSkipHide">知道了</button>' +
      '</div>';
    box.classList.remove('hidden');

    var btnAppend = $('#btnSkipAppend');
    if (btnAppend) btnAppend.onclick = function () {
      appendLines(dropped.map(function (s) { return s.text; }));
      document.dispatchEvent(new Event('output-generated'));
      box.classList.add('hidden');
      toast('已追加 ' + dropped.length + ' 组未参与运算的号码');
    };
    $('#btnSkipHide').onclick = function () { box.classList.add('hidden'); };
  }

  /* ================================================================== *
   * 右侧大文本域
   * ================================================================== */

  /** 取出行数组：去掉末尾换行产生的那个空行，方便按行号操作 */
  function getLines() {
    var lines = state.output.split('\n');
    if (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines;
  }

  /** 每行去首尾空白、去掉首尾空行，但**保留中间的空行**（分组间隔要用） */
  function normalizeLines(lines) {
    var out = (lines || []).map(function (t) { return String(t == null ? '' : t).trim(); });
    while (out.length && out[0] === '') out.shift();
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }

  function applyOutput(text) {
    state.output = text;
    $('#output').value = text;
    $('#output').scrollTop = 0;
    refresh();
    saveSoon();
  }

  /**
   * 整体替换右侧内容。
   * opts.keepScroll：就地修改（批量添加 =N / 清除后缀）时保持原来的滚动位置，
   * 免得改完一行，视图被弹回文本最开头。
   */
  function setOutput(lines, opts) {
    var ta = $('#output');
    var top = ta.scrollTop, left = ta.scrollLeft;
    state.output = normalizeLines(lines).join('\n');
    ta.value = state.output;
    if (opts && opts.keepScroll) { ta.scrollTop = top; ta.scrollLeft = left; }
    else { ta.scrollTop = 0; }
    state.deduped = false;
    refresh();
    saveSoon();
  }

  function appendLines(lines) {
    var add = normalizeLines(lines);
    if (!add.length) return 0;
    applyOutput(state.output.trim() ? state.output.replace(/\s+$/, '') + '\n' + add.join('\n') : add.join('\n'));
    return add.length;
  }

  /* ---- 撤销 ---- */

  function commit() { shadow = state.output; }

  function pushUndo() {
    if (typingBurst) { clearTimeout(typingTimer); typingBurst = false; commit(); }
    state.undo.push(shadow);
    if (state.undo.length > 40) state.undo.shift();
  }

  function beginTypingUndo() {
    if (typingBurst) return;
    typingBurst = true;
    state.undo.push(shadow);
    if (state.undo.length > 40) state.undo.shift();
  }

  function doUndo() {
    if (!state.undo.length) { toast('没有可撤销的操作'); return; }
    clearTimeout(typingTimer);
    typingBurst = false;
    applyOutput(state.undo.pop());
    commit();                 // 撤销后的内容就是新的「已提交」状态，否则撤销后再改动会串味
    toast('已撤销', 'ok');
  }

  /* ---- 校验 / 高亮 / 状态 ---- */

  /**
   * 右侧每一行的判定：先归一化字符（全角数字、全角＝、+ * x → X）再解析。
   * 和左侧实时校验、引擎 parseText 同一个口径 —— 三处判定必须完全一致。
   */
  function parseOutLine(t) {
    return C.parseGroup(C.normalizeChars(String(t == null ? '' : t).trim()));
  }

  function analyze() {
    var lines = getLines();
    var check = C.checkForExport(lines, { ignoreBlank: true });
    var dupMap = state.deduped ? {} : C.findDuplicateNumbers(lines.filter(function (t) {
      var g = parseOutLine(t);
      return g && g.status === 'ok' && t.trim() !== '';
    }));

    var errByLine = {};
    check.errors.forEach(function (e) { errByLine[e.index] = e.reason; });

    var dupLines = {};
    lines.forEach(function (t, i) {
      var g = parseOutLine(t);
      if (g && g.status === 'ok' && t.trim() !== '' && dupMap[g.number] > 1) dupLines[i] = true;
    });

    var nonEmpty = lines.filter(function (t) { return t.trim() !== ''; }).length;
    return {
      lines: lines,
      nonEmpty: nonEmpty,
      blank: lines.length - nonEmpty,
      // 组：连续非空行算一组、空行分隔（和「选择组」按钮同一套逻辑）
      groupCount: splitGroups(state.output).length,
      errors: check.errors,
      errByLine: errByLine,
      dupLines: dupLines,
      duplicates: check.duplicates
    };
  }

  function renderHighlight(a) {
    var html = a.lines.map(function (t, i) {
      var esc = escapeHtml(t);
      if (!t.trim()) return esc;
      if (a.errByLine[i]) return '<span class="hl-err">' + esc + '</span>';
      if (a.dupLines[i]) return '<span class="hl-dup">' + esc + '</span>';
      return esc;
    }).join('\n');
    // 末尾补一个零宽字符，保证最后那个空行的高度与文本域一致
    $('#editorHighlight').innerHTML = html + '\u200B';
    syncScroll();
  }

  function syncScroll() {
    var ta = $('#output');
    var hl = $('#editorHighlight');
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  }

  function renderIssues(a) {
    var box = $('#issueList');
    box.innerHTML = '';
    var items = [];

    a.errors.slice(0, 40).forEach(function (e) {
      items.push('<button class="issue-item" data-line="' + e.index + '">' +
        '<span class="ln">第 ' + (e.index + 1) + ' 行</span>' +
        '<span>' + escapeHtml(e.text || '(空)') + '</span>' +
        '<span class="why">' + escapeHtml(e.reason) + '</span></button>');
    });
    if (a.errors.length > 40) {
      items.push('<span class="issue-item">… 还有 ' + (a.errors.length - 40) + ' 行有问题</span>');
    }
    box.innerHTML = items.join('');
    box.querySelectorAll('.issue-item[data-line]').forEach(function (b) {
      b.onclick = function () { gotoLine(Number(b.dataset.line)); };
    });
  }

  function updateStatus(a) {
    // 两侧统一：非空行数，以及空行分隔的组数。
    $('#rowCount').textContent = a.nonEmpty + ' 行 · ' + a.groupCount + ' 组';

    var parts = [];
    parts.push('<span>共 ' + a.nonEmpty + ' 行 · ' + a.groupCount + ' 组</span>');

    if (a.errors.length) {
      parts.push('<span class="bad">异常 ' + a.errors.length + ' 行（建议先修正）</span>');
      parts.push('<button id="btnJumpErr">定位到第一个异常</button>');
    } else if (a.nonEmpty) {
      parts.push('<span class="ok">格式全部合规 ✓</span>');
    }

    if (a.duplicates.length && !state.deduped) {
      var names = a.duplicates.slice(0, 3).map(function (d) { return d.number + '×' + d.count; }).join('、');
      parts.push('<span class="warn">重复号码 ' + a.duplicates.length + ' 组（' + escapeHtml(names) +
        (a.duplicates.length > 3 ? ' …' : '') + '）</span>');
      parts.push('<button id="btnDedupe">去重</button><button id="btnKeepDup">保留</button>');
    } else if (a.duplicates.length && state.deduped) {
      parts.push('<span class="warn">已按号码去重</span>');
    }

    $('#statusBar').innerHTML = parts.join('');

    var jump = $('#btnJumpErr');
    if (jump) jump.onclick = function () { gotoLine(a.errors[0].index); };

    var dd = $('#btnDedupe');
    if (dd) dd.onclick = function () {
      pushUndo();
      var kept = C.dedupeByNumber(getLines());
      setOutput(kept);
      state.deduped = true;
      refresh();
      commit();
      toast('已去重：' + a.nonEmpty + ' → ' + C.cleanLines(kept).length + ' 组', 'ok');
    };
    var kd = $('#btnKeepDup');
    if (kd) kd.onclick = function () {
      state.deduped = true;
      refresh();
      toast('已保留重复号码');
    };
  }

  /** 重绘高亮、问题列表与状态栏 */
  function refresh() {
    var a = analyze();
    renderHighlight(a);
    renderIssues(a);
    updateStatus(a);
    return a;
  }

  /* ---- 行定位 / 选区 ---- */

  function lineStartOffset(lines, lineNo) {
    var off = 0;
    for (var i = 0; i < lineNo && i < lines.length; i++) off += lines[i].length + 1;
    return off;
  }

  function gotoLine(lineNo) {
    var ta = $('#output');
    var lines = ta.value.split('\n');
    if (lineNo < 0 || lineNo >= lines.length) return;
    var start = lineStartOffset(lines, lineNo);
    ta.focus();
    ta.setSelectionRange(start, start + lines[lineNo].length);
    var lh = parseFloat(getComputedStyle(ta).lineHeight) || 26;
    ta.scrollTop = Math.max(0, lineNo * lh - ta.clientHeight / 2 + lh);
    syncScroll();
    updateSelHint();
  }

  /** 当前选中的行范围；没有选中任何文本时返回 null */
  function selectedLineRange() {
    var ta = $('#output');
    var v = ta.value;
    if (ta.selectionStart === ta.selectionEnd) return null;
    var s = v.slice(0, ta.selectionStart).split('\n').length - 1;
    var e = v.slice(0, ta.selectionEnd).split('\n').length - 1;
    if (e > s && ta.selectionEnd === lineStartOffset(v.split('\n'), e)) e -= 1; // 整行选中时不吃掉下一行
    return { start: Math.min(s, e), end: Math.max(s, e) };
  }

  function updateSelHint() {
    var el = $('#selHint');
    if (!el) return;                 // 提示条被移除时不报错，选区逻辑照常工作
    var range = selectedLineRange();
    if (!range) {
      el.className = 'sel-hint';
      el.textContent = '未选中 → 对全部行生效';
    } else {
      var n = range.end - range.start + 1;
      el.className = 'sel-hint on';
      el.textContent = '已选中第 ' + (range.start + 1) + '~' + (range.end + 1) + ' 行（共 ' + n + ' 行）';
    }
  }

  /* ---- 选择组：以空行为界，一键选中光标所在的一整组 ---- */

  var groupSel = {};   // textarea id → 上一次「选择组」选出来的范围（连点可以往下多选一组）

  /**
   * 把文本切成若干「组」：连续的非空行算一组，组与组之间用空行隔开。
   * （全倒 / 3字X 生成结果时插的就是这种分组空行）
   * @returns {Array<{index:number,from:number,to:number,start:number,end:number}>}
   *          from/to 是行号（闭区间，从 0 开始），start/end 是字符偏移（end 不含组尾换行）
   */
  function splitGroups(text) {
    var lines = text.split('\n');
    var starts = [];
    var acc = 0;
    lines.forEach(function (l, i) { starts[i] = acc; acc += l.length + 1; });
    var out = [];
    var i = 0;
    while (i < lines.length) {
      if (!lines[i].trim()) { i++; continue; }
      var from = i;
      while (i < lines.length && lines[i].trim()) i++;
      var to = i - 1;
      out.push({
        index: out.length,
        from: from, to: to,
        start: starts[from],
        end: starts[to] + lines[to].length
      });
    }
    return out;
  }

  /** 字符偏移落在第几行（从 0 开始） */
  function lineAtOffset(text, pos) {
    var p = Math.max(0, Math.min(pos, text.length));
    return text.slice(0, p).split('\n').length - 1;
  }

  /** 光标所在的那一组；光标停在空行上时取下面最近的一组，下面没有了就取上面最近的一组 */
  function groupAtOffset(text, pos) {
    var all = splitGroups(text);
    if (!all.length) return null;
    var line = lineAtOffset(text, pos);
    for (var i = 0; i < all.length; i++) {
      if (line >= all[i].from && line <= all[i].to) return all[i];
    }
    for (var j = 0; j < all.length; j++) {
      if (all[j].from > line) return all[j];
    }
    return all[all.length - 1];
  }

  /**
   * 「选择组」按钮：选中光标所在的那一整组（空行分隔的若干行）。
   * 已经是这个按钮选出来的整组选区时，再点一次往下多选一组，方便一起「批量添加 =N」。
   */
  function selectGroup(ta) {
    var text = ta.value;
    var all = splitGroups(text);
    if (!all.length) { toast('这里还没有内容', 'err'); return; }

    var prev = groupSel[ta.id];
    var start, end;

    if (prev && prev.start === ta.selectionStart && prev.end === ta.selectionEnd) {
      var next = null;                                   // 顺着当前选区往下找下一组
      for (var i = 0; i < all.length; i++) {
        if (all[i].start >= prev.end) { next = all[i]; break; }
      }
      if (!next) { toast('已经是最后一组了', 'err'); return; }
      start = prev.start;
      end = next.end;
    } else {
      var g = groupAtOffset(text, ta.selectionStart);
      start = g.start;
      end = g.end;
    }

    ta.focus();
    ta.setSelectionRange(start, end);
    groupSel[ta.id] = { start: start, end: end };

    var firstLine = lineAtOffset(text, start);
    var lastLine = lineAtOffset(text, Math.max(start, end - 1));
    var picked = 0;                                      // 这次一共选了几组
    for (var k = 0; k < all.length; k++) {
      if (all[k].start >= start && all[k].end <= end) picked++;
    }
    if (ta.id === 'output') updateSelHint();          // 左侧输入框没有选中提示条
    var lineCount = lastLine - firstLine + 1;         // 选中范围一共几行
    toast((picked > 1 ? '已选中 ' + picked + ' 组：' : '已选中整组：') +
      '第 ' + (firstLine + 1) + '~' + (lastLine + 1) + ' 行（共 ' + lineCount + ' 行）', 'ok');
  }

  /* ---- 批量操作 ---- */

  function targetIndexes(range, lines) {
    if (!range) {
      return lines.map(function (_, i) { return i; });
    }
    var out = [];
    for (var i = range.start; i <= range.end && i < lines.length; i++) out.push(i);
    return out;
  }

  function openSuffixModal() {
    var lines = getLines();
    if (!C.cleanLines(lines).length) { toast('右侧还没有内容', 'err'); return; }
    var range = selectedLineRange();
    var targets = targetIndexes(range, lines);
    var scopeText = range
      ? '选中的第 ' + (range.start + 1) + '~' + (range.end + 1) + ' 行（共 ' + targets.length + ' 行）'
      : '全部 ' + targets.length + ' 行';

    var div = document.createElement('div');
    div.innerHTML =
      '<div class="field">' +
      '<label>给' + scopeText + '批量设置后缀 =N</label>' +
      '<input id="suffixValue" type="text" inputmode="decimal" placeholder="例如 2.5、0、12（不允许负数）" autocomplete="off">' +
      '<span class="hint">已有后缀会被直接替换；想只改几行，先在右边选中那几行再点这个按钮。留空可用「清除后缀」去掉。</span>' +
      '</div>';
    openModal({
      title: '批量添加 =N',
      body: div,
      buttons: [
        { label: '取消', kind: 'ghost' },
        {
          label: '应用',
          kind: 'primary',
          onClick: function () {
            var res = C.applySuffix(lines, targets, $('#suffixValue').value);
            if (!res.ok) { toast(res.reason, 'err', 3600); return false; }
            pushUndo();
            setOutput(res.lines, { keepScroll: true });
            commit();
            toast('已为 ' + (targets.length - res.failed.length) + ' 行设置为 =' + res.value +
              (res.failed.length ? '，' + res.failed.length + ' 行格式异常已跳过' : ''), 'ok', 3200);
          }
        }
      ],
      onOpen: function () { setTimeout(function () { $('#suffixValue').focus(); }, 30); }
    });
  }

  function doClearSuffix() {
    var lines = getLines();
    if (!C.cleanLines(lines).length) { toast('右侧还没有内容', 'err'); return; }
    var range = selectedLineRange();
    var targets = targetIndexes(range, lines);
    pushUndo();
    setOutput(C.clearSuffix(lines, targets), { keepScroll: true });
    commit();
    toast('已清除 ' + targets.length + ' 行的后缀', 'ok');
  }

  function doDedupe() {
    var lines = getLines();
    var before = C.cleanLines(lines).length;
    if (!before) { toast('右侧还没有内容', 'err'); return; }
    var kept = C.dedupeByNumber(lines);
    var after = C.cleanLines(kept).length;
    pushUndo();
    setOutput(kept);
    state.deduped = true;
    refresh();
    commit();
    toast(after === before ? '没有重复号码' : '已去重：' + before + ' → ' + after + ' 行', 'ok');
  }

  /* ================================================================== *
   * 生成动作：全倒 / 3字X
   * ================================================================== */

  function outputLines(lines, done, append) {
    if (!lines.length) return;
    var ta = $('#output');
    var prefix = append && ta.value ? ta.value + (/\n\n$/.test(ta.value) ? '' : /\n$/.test(ta.value) ? '\n' : '\n\n') : '';
    pushUndo();
    if (append) {
      state.deduped = false;
      applyOutput(prefix + normalizeLines(lines).join('\n'));
    } else {
      setOutput(lines);
    }
    commit();
    if (done) done();
    document.dispatchEvent(new Event('output-generated'));
    if (append) {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(prefix.length, ta.value.length);
      var lh = parseFloat(getComputedStyle(ta).lineHeight) || 26;
      ta.scrollTop = Math.max(0, (prefix.split('\n').length - 1) * lh);
      syncScroll();
      updateSelHint();
    }
    var dups = C.checkForExport(getLines(), { ignoreBlank: true }).duplicates;
    if (dups.length) toast('检测到 ' + dups.length + ' 组重复号码，可在下方选择去重或保留', 'err', 3600);
  }

  function generationInputText() {
    var input = $('#input');
    if (input.selectionStart !== input.selectionEnd) {
      return input.value.slice(input.selectionStart, input.selectionEnd);
    }
    if (imageBatch && imageBatch.selectedIds.size) {
      trackImageDraft(imageBatch, input.value);
      return input.value.split('\n').filter(function (line, index) {
        return imageBatch.selectedIds.has(imageBatch.draftOwners[index]);
      }).join('\n');
    }
    return input.value;
  }

  function requireInput(text) {
    if (!text.trim()) {
      toast('当前处理范围没有号码，请先输入或选择号码', 'err');
      $('#input').focus();
      return false;
    }
    return true;
  }

  function doReverse() {
    var text = generationInputText();
    if (!requireInput(text)) return;
    var out = C.expandReverse(text);
    if (!out.results.length) {
      toast('没有可用于全倒的 4 位纯数字', 'err', 3600);
      showSkipNotice('reverse', out.skipped);
      return;
    }
    var grouped = groupSizes(text);
    // 每个号码的排列自成一组，组与组之间空一行
    outputLines(C.joinGroups(out.groups), function () {
      toast('全倒完成：' + describeGroups(grouped) + '，共 ' + out.results.length + ' 组', 'ok', 4000);
    }, true);
    showSkipNotice('reverse', out.skipped);
  }

  function doThreeX() {
    var text = generationInputText();
    if (!requireInput(text)) return;
    var out = C.expandThreeX(text);
    if (!out.results.length) {
      toast('没有可用于 3字X 的内容', 'err', 3600);
      showSkipNotice('threex', out.skipped);
      return;
    }
    // 原号码 / 第1位 / 第2位 / 第3位 / 第4位 各自成组，组间空一行
    outputLines(C.joinGroups(out.groups), function () {
      toast('3字X 完成，共 ' + out.results.length + ' 组', 'ok', 4000);
    }, true);
    showSkipNotice('threex', out.skipped);
  }

  function groupSizes(text) {
    var sizes = [];
    C.parseText(text).groups.forEach(function (g) {
      if (g.status === 'ok' && C.isPure4(g.number)) sizes.push(C.reverseCount(g.number));
    });
    return sizes;
  }

  function describeGroups(sizes) {
    if (!sizes.length) return '';
    var map = {};
    sizes.forEach(function (n) { map[n] = (map[n] || 0) + 1; });
    return Object.keys(map).sort(function (a, b) { return b - a; }).map(function (n) {
      return map[n] + ' 组号码各 ' + n + ' 种排列';
    }).join('，');
  }

  /* ================================================================== *
   * 复制（导出 TXT 暂时下线，实现见 exportTxt）
   * ================================================================== */

  /**
   * 出手（复制）前统一成规范写法。
   * 校验按归一化后的结果判，复制出去的内容也得是归一化后的 —— 否则「１２３４」这种
   * 能通过校验，却把全角数字原样带进剪贴板。改动了哪些会提示出来。
   */
  function canonicalize(lines) {
    var changed = 0;
    var out = lines.map(function (t) {
      var s = String(t == null ? '' : t).trim();
      if (!s) return '';
      var g = parseOutLine(s);
      if (!g || g.status !== 'ok') return t;      // 不合规的行原样留着（这些行本来就会标红提示）
      if (g.text !== s) changed++;
      return g.text;
    });
    return { lines: out, changed: changed };
  }

  /**
   * 导出 TXT —— 暂时下线（先不做），实现整段保留在这里，调用点已全部撤掉。
   * 想恢复：把按钮接回 exportTxt，或把上面的 Ctrl/Cmd + S 改回 exportTxt()。
   * 导出前会先校验（异常行拦住并给出跳转）、有重复号码时二次确认，然后下载 .txt。
   */
  function exportTxt() {
    var lines = getLines();
    var nonEmpty = C.cleanLines(lines);
    if (!nonEmpty.length) { toast('右侧还没有内容', 'err'); return; }
    var check = C.checkForExport(lines, { ignoreBlank: true });

    if (!check.ok) {
      var items = check.errors.slice(0, 200).map(function (e) {
        return '<button class="err-item" data-row="' + e.index + '">' +
          '<span class="num">第 ' + (e.index + 1) + ' 行：' + escapeHtml(e.text || '(空)') + '</span>' +
          '<span class="why">' + escapeHtml(e.reason) + '</span></button>';
      }).join('');
      openModal({
        title: '还不能导出：有 ' + check.errors.length + ' 处需要修正',
        body: '<div class="rules">规则要求：异常内容必须修正后才能导出。点下面任意一条可以直接跳到那一行修改。</div>' +
          '<div class="err-list">' + items + '</div>',
        buttons: [{ label: '知道了', kind: 'primary' }],
        onOpen: function () {
          document.querySelectorAll('.err-item').forEach(function (b) {
            b.onclick = function () {
              closeModal();
              gotoLine(Number(b.dataset.row));
            };
          });
        }
      });
      return;
    }

    function write() {
      var body = normalizeLines(lines);   // 固定保留全倒 / 3字X 的分组空行
      var canon = canonicalize(body);     // 全角数字 / 符号统一成规范写法
      var text = canon.lines.join('\n') + '\n';
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var d = new Date();
      var pad = function (n) { return String(n).padStart(2, '0'); };
      a.href = url;
      a.download = '号码整理-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
        pad(d.getHours()) + pad(d.getMinutes()) + '.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      var blanks = body.length - nonEmpty.length;
      toast('已导出 ' + nonEmpty.length + ' 行' + (blanks > 0 ? '（含 ' + blanks + ' 个分组空行）' : '') +
        (canon.changed ? '，其中 ' + canon.changed + ' 行已转成规范写法（全角/符号）' : ''), 'ok');
    }

    if (check.duplicates.length && !state.deduped) {
      confirmModal('存在重复号码，仍然导出？',
        '检测到 <b>' + check.duplicates.length + '</b> 组重复号码（只看号码部分，忽略 =N）：<br><code>' +
        check.duplicates.slice(0, 10).map(function (d) { return d.number + ' ×' + d.count; }).join('</code> <code>') +
        '</code><br><br>重复不算格式错误，可以直接导出。', write, '仍然导出');
      return;
    }
    write();
  }

  /** 写剪贴板：优先用异步 API，不可用（旧浏览器 / 非安全上下文）时退回 execCommand */
  function writeClipboard(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function copyAll() {
    var lines = getLines();
    var text = canonicalize(normalizeLines(lines)).lines.join('\n');   // 复制出去的也是规范写法
    if (!text) { toast('右侧还没有内容', 'err'); return; }
    writeClipboard(text, function () { toast('已复制到剪贴板', 'ok'); });
  }

  /** 左侧「全部复制」：原样搬走输入框里的内容，不做规范化（方便原封不动转存到别处） */
  function copyAllInput() {
    var text = $('#input').value;
    if (!text.trim()) { toast('左侧还没有内容', 'err'); return; }
    writeClipboard(text, function () { toast('已复制到剪贴板', 'ok'); });
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择文本', 'err'); }
    ta.remove();
  }

  /* ================================================================== *
   * OCR
   * ================================================================== */

  function apiBase() { return ''; }

  function setOcrStatus(hasKey, masked) {
    var el = $('#ocrStatus');
    if (hasKey) {
      el.className = 'pill ok';
      el.textContent = 'OCR 已配置';
      el.title = '已配置密钥：' + (masked || '');
    } else {
      el.className = 'pill warn';
      el.textContent = 'OCR 未配置';
      el.title = '点「设置」填写通义千问 API Key';
    }
  }

  function loadConfig() {
    return fetchWithTimeout(apiBase() + '/api/config', {}, 8000).then(function (r) { return r.json(); })
      .then(function (cfg) {
        setOcrStatus(cfg.hasKey, cfg.keyMasked);
        return cfg;
      })
      .catch(function () {
        var el = $('#ocrStatus');
        el.className = 'pill bad';
        el.textContent = 'OCR 未配置';
        el.title = '请在设置中填写自己的 OCR 配置';
        return null;
      });
  }

  /** 带超时的 fetch：网络卡住时也要能给出提示，不能永远转圈 */
  function fetchWithTimeout(url, opts, ms) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 120000);
    var o = Object.assign({}, opts);
    if (ctl) o.signal = ctl.signal;
    return window.OCRBrowser.request(url, o).then(function (r) {
      clearTimeout(timer);
      return r;
    }, function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        throw new Error('接口超过 ' + Math.round((ms || 120000) / 1000) + ' 秒没响应，已中止');
      }
      throw e;
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  function downscale(dataUrl) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
        if (scale === 1 && dataUrl.length < 1400000) { resolve(dataUrl); return; }
        var cw = Math.round(w * scale), ch = Math.round(h * scale);
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        try { resolve(canvas.toDataURL('image/jpeg', 0.92)); } catch (e) { resolve(dataUrl); }
      };
      img.onerror = function () { resolve(dataUrl); };
      img.src = dataUrl;
    });
  }

  /* ================================================================== *
   * 识别前框选 / 涂画
   * ================================================================== */

  // Text entry owns its keys: never let decimal/IME/cancel keys dismiss the crop.
  function bindCropSuffixInput(input, apply) {
    var composing = false;
    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () { composing = false; });
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (composing || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && (e.key === '.' || e.code === 'Period'))) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
    });
    input.addEventListener('keyup', function (e) { e.stopPropagation(); });
  }

  function buildCropper(img, dataUrl, onUpdate, host) {
    var finished = false;
    var resizeObserver = null;
    function cleanup() {
      finished = true;
      if (regionController) regionController.abort();
      unbindZoom();
      if (resizeObserver) resizeObserver.disconnect();
    }

    var MAX = 1600;
    var fit = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    var W = Math.round(img.naturalWidth * fit);
    var H = Math.round(img.naturalHeight * fit);

    // shapes 按加入顺序生效：普通形状 = 选中；带 erase:true 的 = 擦掉
    // {type:'rect',start,end}（框选）或 {type:'stroke',points:[],radius}（涂画/擦除），都可以带 erase
    var shapes = [];
    var drawing = null;
    var regions = [], regionsLoaded = false, regionsLoading = false;
    var pendingGroupGesture = null;
    var regionController = null;
    var picked = new Set(), annotations = new Map(), cropHistory = [];
    var annotationColors = new Map();
    var tool = 'group';     // group | rect | brush | eraser
    var rectErase = false;
    var brushErase = false;
    // 画笔直径 = 图片短边 × 比例。默认给得比较大，细笔刷容易把号码从中间切开导致误读
    var brushRatio = 0.12;

    // 画笔光标（涂画 / 擦除）：cursorAt 是画布坐标下的光标位置，null = 光标不在画布上；
    // cursorBox 是上一帧圆环的包围盒，只清这一小块，鼠标移动时重绘更轻
    var cursorAt = null;
    var cursorBox = null;

    var stage, viewport, baseCtx, maskCanvas, overlayCtx, maskLayer, maskLayerCtx;
    var cursorCanvas, cursorCtx;
    var fitScale = 1;       // 「适应窗口」时的显示比例
    var zoom = 1;           // 相对适应窗口的放大倍数
    var pointers = new Map();
    var pinch = null;
    var spaceDown = false;
    var panning = null;

    var wrap = document.createElement('div');
    // Each image owns its elements, even when several images are in this batch.
    function $(selector) { return wrap.querySelector(selector); }
    wrap.className = 'crop-wrap';
    wrap.innerHTML =
      '<div class="crop-viewport" id="cropViewport">' +
        '<div class="crop-stage" id="cropStage">' +
          '<canvas id="cropBase" width="' + W + '" height="' + H + '"></canvas>' +
          '<canvas id="cropMask" tabindex="0" aria-label="点选图中号码" width="' + W + '" height="' + H + '" ' +
          'title="点击或拖动选择号码。双指缩放移动图片"></canvas>' +
          // 独立的画笔光标图层：只画跟随鼠标的笔触圆环，不参与选区计算
          '<canvas id="cropCursor" width="' + W + '" height="' + H + '"></canvas>' +
          '<div id="cropLocating" class="crop-locating hidden" role="status" aria-live="polite">' +
            '<span class="crop-locating-spinner" aria-hidden="true"></span>' +
            '<strong>正在定位号码…</strong>' +
            '<span>定位完成后即可继续点选</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="cropAnnotation" class="crop-annotation">' +
        '<span class="small muted" id="cropAnnotationCount" role="status">已定位 0 组，已标注 0 组</span>' +
        '<button class="btn tiny hidden" id="cropGroupRetry">重试定位</button>' +
        '<label for="cropSuffix">为选中号码添加 =N</label>' +
        '<input id="cropSuffix" type="text" inputmode="decimal" placeholder="如 2 或 0.5" autocomplete="off">' +
        '<button class="btn tiny primary" id="cropApplySuffix">标注选中号码</button>' +
        '<div id="cropAnnotationLegend" class="crop-annotation-legend" aria-label="标注颜色图例"></div>' +
      '</div>';

    host.appendChild(wrap);
    init();

    function init() {
      stage = $('#cropStage');
      viewport = $('#cropViewport');
      var baseCanvas = $('#cropBase');
      maskCanvas = $('#cropMask');
      cursorCanvas = $('#cropCursor');
      baseCtx = baseCanvas.getContext('2d');
      overlayCtx = maskCanvas.getContext('2d');
      cursorCtx = cursorCanvas.getContext('2d');
      baseCtx.drawImage(img, 0, 0, W, H);

      // 离屏画布：真实选区（不透明像素 = 选中）。可见蒙层由它推导，两者永远一致
      maskLayer = document.createElement('canvas');
      maskLayer.width = W;
      maskLayer.height = H;
      maskLayerCtx = maskLayer.getContext('2d');

      layout();
      bindZoom();
      $('#cropGroupRetry').onclick = loadRegions;
      $('#cropApplySuffix').onclick = applyAnnotation;
      bindCropSuffixInput($('#cropSuffix'), applyAnnotation);

      maskCanvas.addEventListener('pointerdown', onDown);
      maskCanvas.addEventListener('pointermove', onMove);
      maskCanvas.addEventListener('pointerup', onUp);
      maskCanvas.addEventListener('pointercancel', onUp);
      maskCanvas.addEventListener('pointerenter', onEnter);
      maskCanvas.addEventListener('pointerleave', onLeave);
      window.addEventListener('resize', layout);
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(layout);
        resizeObserver.observe(viewport);
      }
      loadRegions();
      renderMask();
    }

    cleanup.clearAnnotations = function (indices) {
      indices.forEach(function (i) { annotations.delete(i); });
      renderMask();
    };
    return cleanup;

    function rememberCrop() {
      cropHistory.push({ shapes: shapes.slice(), picked: new Set(picked), annotations: new Map(annotations) });
      if (cropHistory.length > 60) cropHistory.shift();
    }

    function clearPicked() {
      picked.clear(); drawing = null;
      shapes = shapes.filter(function (s) { return s.type !== 'groups'; });
    }

    function annotationKey(value) {
      // Treat 2, 02 and 2.0 as the same amount without losing decimal precision.
      var parts = value.split('.');
      var integer = parts[0].replace(/^0+(?=\d)/, '');
      var fraction = (parts[1] || '').replace(/0+$/, '');
      return integer + (fraction ? '.' + fraction : '');
    }

    function annotationColor(value) {
      var key = annotationKey(value);
      if (!annotationColors.has(key)) {
        var palette = ['#15803d', '#a16207', '#9333ea', '#be123c', '#0e7490', '#c2410c', '#4338ca', '#4d7c0f'];
        var index = annotationColors.size;
        annotationColors.set(key, palette[index] || 'hsl(' + ((index * 137.508) % 360).toFixed(2) + ', 65%, 36%)');
      }
      return annotationColors.get(key);
    }

    function annotationLines() {
      // Keep image order and separate identical numbers at different positions.
      var lines = [];
      regions.forEach(function (r, i) { if (annotations.has(i)) lines.push(r.text + '=' + annotations.get(i)); });
      return lines;
    }

    function workspaceLines() {
      return regions.map(function (r, i) {
        return r.text + (annotations.has(i) ? '=' + annotations.get(i) : '');
      });
    }

    function publishResults(initial, selected) {
      if (typeof onUpdate === 'function') {
        onUpdate(workspaceLines(), { initial: !!initial, selected: selected || [], located: regions.length, annotated: annotations.size });
      }
    }

    function publishSelection(settled) {
      var current = new Set(picked);
      if (drawing && drawing.type === 'groups') drawing.changes.forEach(function (selected, i) {
        if (selected) current.add(i); else current.delete(i);
      });
      if (typeof onUpdate === 'function') onUpdate([], { selectionOnly: true, picked: Array.from(current), settled: !!settled });
    }

    function applyAnnotation() {
      if (!picked.size) { toast('请先点选或拖过要标注的号码', 'err'); return; }
      var value = C.validateSuffix($('#cropSuffix').value);
      if (!value.ok) { toast(value.reason, 'err'); return; }
      rememberCrop();
      annotationColor(value.value);
      var selected = Array.from(picked);
      picked.forEach(function (i) { annotations.set(i, value.value); });
      clearPicked();
      renderMask();
      publishResults(false, selected);
    }

    function updateAnnotationPanel() {
      var lines = annotationLines();
      $('#cropAnnotationCount').textContent = '已定位 ' + regions.length + ' 组，已标注 ' + lines.length + ' 组';
      var counts = new Map();
      annotations.forEach(function (value) {
        var key = annotationKey(value);
        counts.set(key, (counts.get(key) || 0) + 1);
      });
      // Keys contain only validated decimal digits and '.', colors are generated locally.
      $('#cropAnnotationLegend').innerHTML = Array.from(counts).map(function (entry) {
        return '<span class="crop-legend-item" style="--annotation-color:' + annotationColor(entry[0]) + '">' +
          '<i aria-hidden="true"></i>=' + entry[0] + ' · ' + entry[1] + '组</span>';
      }).join('');
      $('#cropApplySuffix').disabled = !picked.size;
    }

    function loadRegions() {
      if (regionsLoading || regionsLoaded || finished) return;
      regionsLoading = true;
      var retry = wrap.querySelector('#cropGroupRetry');
      var locating = wrap.querySelector('#cropLocating');
      locating.classList.toggle('hidden', false);
      retry.classList.add('hidden');
      regionController = new AbortController();
      var timer = setTimeout(function () { regionController.abort(); }, 120000);
      window.OCRSelection.requestRegions(window.OCRBrowser.request, apiBase(), dataUrl, regionController.signal, { width: img.naturalWidth, height: img.naturalHeight }).then(function (data) {
        if (finished) return;
        regions = data.groups.map(function (g) {
          var b = g.box;
          return { text: g.text, x: b[0] * W / 1000, y: b[1] * H / 1000,
            w: (b[2] - b[0]) * W / 1000, h: (b[3] - b[1]) * H / 1000 };
        });
        regionsLoaded = regions.length > 0;
        if (regionsLoaded) applyPendingGroupGesture();
        renderMask();
        publishResults(true);
      }).catch(function (err) {
        if (!finished) {
          var message = '定位失败：' + (err.name === 'AbortError' ? '请求超时' : err.message) + '。请重试定位。';
          toast(message, 'err');
          if (typeof onUpdate === 'function') onUpdate([], { error: message });
        }
      }).finally(function () {
        clearTimeout(timer);
        regionsLoading = false;
        locating.classList.toggle('hidden', true);
        if (!finished) retry.classList.toggle('hidden', tool !== 'group' || regionsLoaded);
      });
    }

    function applyPendingGroupGesture() {
      if (!pendingGroupGesture || !regionsLoaded) return;
      var gesture = pendingGroupGesture;
      pendingGroupGesture = null;
      drawing = {
        type: 'groups', boxes: [], visited: new Set(), changes: new Map(),
        last: gesture.points[0]
      };
      gesture.points.forEach(sweepGroups);
      if (drawing.boxes.length) {
        rememberCrop();
        drawing.changes.forEach(function (selected, i) {
          if (selected) picked.add(i); else picked.delete(i);
        });
      }
      drawing = null;
    }

    function sweepGroups(p) {
      regions.forEach(function (r, i) {
        if (!drawing.visited.has(i) && window.OCRSelection.intersects(drawing.last, p, r)) {
          drawing.visited.add(i);
          drawing.boxes.push(r);
          drawing.changes.set(i, !picked.has(i));
        }
      });
      drawing.last = p;
    }

    /* ---------------- 缩放 / 平移 ---------------- */

    /** 把图按「适应窗口」塞进右侧视口：视口大小由 CSS 决定，这里只负责缩放 */
    function layout() {
      if (finished || !viewport.clientWidth || !viewport.clientHeight) return;
      // clientWidth/Height 已经扣掉边框，再留 2px 免得撑出假滚动条
      var availW = Math.max(80, viewport.clientWidth - 2);
      var availH = Math.max(80, viewport.clientHeight - 2);
      fitScale = Math.min(availW / W, availH / H, 1);
      applyZoom();
    }

    function applyZoom() {
      stage.style.width = Math.round(W * fitScale * zoom) + 'px';
      stage.style.height = Math.round(H * fitScale * zoom) + 'px';
      renderMask();
    }

    /** 缩放并把 (clientX, clientY) 那个点钉在原地；不传坐标就以视口中心为锚点 */
    function zoomAt(next, clientX, clientY) {
      next = Math.max(0.5, Math.min(6, next));
      var vp = viewport.getBoundingClientRect();
      var ax = clientX == null ? vp.left + vp.width / 2 : clientX;
      var ay = clientY == null ? vp.top + vp.height / 2 : clientY;

      // 记下锚点在图片上的相对位置（0~1），缩放后把它推回原处：
      // 这样图片居中留白、滚动条、边框都算得准，缩小时也不会跳
      var before = stage.getBoundingClientRect();
      var fx = before.width ? (ax - before.left) / before.width : 0.5;
      var fy = before.height ? (ay - before.top) / before.height : 0.5;

      zoom = next;
      applyZoom();

      var after = stage.getBoundingClientRect();
      viewport.scrollLeft += (after.left + fx * after.width) - ax;
      viewport.scrollTop += (after.top + fy * after.height) - ay;
    }

    function bindZoom() {
      // 滚轮缩放（触控板双指捏合也会走这里，就是带 ctrlKey 的 wheel）
      viewport.addEventListener('wheel', function (e) {
        e.preventDefault();
        var k = e.ctrlKey ? 0.012 : 0.0018;
        zoomAt(zoom * Math.exp(-e.deltaY * k), e.clientX, e.clientY);
      }, { passive: false });

      // 空格 / 中键拖动 = 平移（Mac 触控板没有中键，按住空格就行）
      document.addEventListener('keydown', onSpaceDown);
      document.addEventListener('keyup', onSpaceUp);
      window.addEventListener('blur', onBlur);
    }

    function unbindZoom() {
      document.removeEventListener('keydown', onSpaceDown);
      document.removeEventListener('keyup', onSpaceUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', layout);
    }

    function onBlur() { spaceDown = false; drawing = null; pointers.clear(); pinch = null; panning = null; renderMask(); }

    function onSpaceDown(e) {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.code === 'Escape' && drawing) {
        drawing = null; renderMask();
      }
      if (e.code === 'Space' && viewport.clientWidth &&
          document.querySelector('#modalBackdrop').classList.contains('hidden') && wrap.contains(document.activeElement)) {
        spaceDown = true;
        maskCanvas.style.cursor = 'grab';
        drawCursor();
        e.preventDefault();
      }
    }
    function onSpaceUp(e) {
      if (e.code === 'Space') {
        spaceDown = false;
        maskCanvas.style.cursor = cursorForTool();
        drawCursor();
      }
    }

    function onEnter(e) {
      if (tool === 'rect') return;
      cursorAt = pos(e);
      drawCursor();
    }

    function onLeave() {
      if (!cursorAt) return;
      cursorAt = null;
      drawCursor();
    }

    function pos(e) {
      var r = maskCanvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(W, (e.clientX - r.left) * (maskCanvas.width / r.width))),
        y: Math.max(0, Math.min(H, (e.clientY - r.top) * (maskCanvas.height / r.height)))
      };
    }

    function brushRadius() { return Math.max(6, Math.round(Math.min(W, H) * brushRatio / 2)); }

    function updateBrushTitle() {
      $('#cropBrushBox').title = '当前笔刷直径约 ' + (brushRadius() * 2) + ' 图片像素（光标上的圆环就是这个宽度）';
    }

    // 涂画 / 擦除时把系统光标藏起来，改用画布上的笔触圆环当光标
    function cursorForTool() { return tool === 'group' ? 'pointer' : (tool === 'rect' ? 'crosshair' : 'none'); }

    /**
     * 画笔光标：在独立图层上画一个跟随光标的圆环，直径 = 实际落笔宽度。
     * 圆环坐标就是画布坐标（= 图片像素），所以缩放后看到多大，涂出来就多大。
     */
    function drawCursor() {
      if (!cursorCtx) return;

      // 只清上一帧圆环占的那一小块；没有记录（如切换工具）就整层清一遍
      if (cursorBox) {
        cursorCtx.clearRect(cursorBox.x, cursorBox.y, cursorBox.w, cursorBox.h);
        cursorBox = null;
      } else {
        cursorCtx.clearRect(0, 0, W, H);
      }

      if (tool !== 'brush' && tool !== 'eraser') return;      // 框选不画
      if (!cursorAt || panning || pinch || spaceDown) return; // 平移 / 捏合时先收起来

      var r = brushRadius();
      var s = 1 / dispScale();        // 屏幕像素 → 画布像素，保证线宽看起来恒定
      var erase = tool === 'eraser';
      var cx = cursorAt.x, cy = cursorAt.y;

      var pad = r + 6 * s + 1;
      cursorBox = {
        x: Math.floor(cx - pad), y: Math.floor(cy - pad),
        w: Math.ceil(pad * 2) + 2, h: Math.ceil(pad * 2) + 2
      };

      cursorCtx.save();
      cursorCtx.lineCap = 'round';

      // 覆盖范围的淡色填充，一眼看出会涂到哪
      cursorCtx.beginPath();
      cursorCtx.arc(cx, cy, r, 0, Math.PI * 2);
      cursorCtx.fillStyle = erase ? 'rgba(239,68,68,.14)' : 'rgba(37,99,235,.14)';
      cursorCtx.fill();

      cursorCtx.setLineDash(erase ? [5 * s, 4 * s] : []);     // 擦除用虚线圈，和涂画区分开
      cursorCtx.lineWidth = Math.max(2, 2.6 * s);
      cursorCtx.strokeStyle = 'rgba(15,23,42,.55)';           // 先深后浅两道描边，深浅底图都看得清
      cursorCtx.stroke();
      cursorCtx.lineWidth = Math.max(1, 1.2 * s);
      cursorCtx.strokeStyle = erase ? '#ef4444' : '#ffffff';
      cursorCtx.stroke();
      cursorCtx.setLineDash([]);

      // 圆心小点，方便精确对准
      cursorCtx.beginPath();
      cursorCtx.arc(cx, cy, Math.max(1, 1.6 * s), 0, Math.PI * 2);
      cursorCtx.fillStyle = erase ? '#ef4444' : '#2563eb';
      cursorCtx.fill();
      cursorCtx.restore();
    }

    function onDown(e) {
      if (finished || regionsLoading) return;
      maskCanvas.focus({ preventScroll: true });
      pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
      try { maskCanvas.setPointerCapture(e.pointerId); } catch (_) { /* Synthetic events may not own a pointer. */ }

      // 两根手指：缩放 + 平移
      if (pointers.size === 2) {
        if (drawing) { drawing = null; renderMask(); }   // 放弃正在画的那一笔
        panning = null;
        startPinch();
        e.preventDefault();
        return;
      }
      if (pointers.size > 2) return;

      // 空格 / 鼠标中键：平移画面
      if (spaceDown || e.button === 1) {
        panning = { x: e.clientX, y: e.clientY, sl: viewport.scrollLeft, st: viewport.scrollTop };
        maskCanvas.style.cursor = 'grabbing';
        try { maskCanvas.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
        e.preventDefault();
        return;
      }
      if (e.pointerType === 'mouse' && e.button !== 0) return;   // 鼠标只响应左键

      e.preventDefault();

      try { maskCanvas.setPointerCapture(e.pointerId); } catch (_) { /* 某些环境不支持，忽略 */ }
      var p = pos(e);
      cursorAt = p;
      if (tool === 'group') {
        if (!regionsLoaded) {
          drawing = { type: 'pendingGroups', points: [p], pointerId: e.pointerId };
          return;
        }
        drawing = { type: 'groups', boxes: [], visited: new Set(), changes: new Map(), last: p, pointerId: e.pointerId };
        sweepGroups(p);
        renderMask();
        return;
      }
      drawing = tool === 'rect'
        ? { type: 'rect', start: p, end: p, erase: rectErase }
        : { type: 'stroke', points: [p], radius: brushRadius(), erase: tool === 'eraser' };
      drawing.pointerId = e.pointerId;
      renderMask();
    }

    /** 显示比例：画布像素 → CSS 像素 */
    function dispScale() { return Math.max(0.02, fitScale * zoom); }

    function startPinch() {
      var pts = Array.from(pointers.values()).slice(0, 2);
      var dx = pts[0].clientX - pts[1].clientX;
      var dy = pts[0].clientY - pts[1].clientY;
      var midX = (pts[0].clientX + pts[1].clientX) / 2;
      var midY = (pts[0].clientY + pts[1].clientY) / 2;
      var rect = stage.getBoundingClientRect();
      pinch = {
        dist: Math.max(1, Math.sqrt(dx * dx + dy * dy)),
        zoom: zoom,
        // 捏合中心落在图片上的相对位置，缩放时让它一直停在两指中间
        fx: rect.width ? (midX - rect.left) / rect.width : 0.5,
        fy: rect.height ? (midY - rect.top) / rect.height : 0.5
      };
    }

    function updatePinch() {
      if (!pinch) return;
      var pts = Array.from(pointers.values()).slice(0, 2);
      if (pts.length < 2) { pinch = null; return; }
      var dx = pts[0].clientX - pts[1].clientX;
      var dy = pts[0].clientY - pts[1].clientY;
      var dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      var midX = (pts[0].clientX + pts[1].clientX) / 2;
      var midY = (pts[0].clientY + pts[1].clientY) / 2;
      zoom = Math.max(0.5, Math.min(6, pinch.zoom * (dist / pinch.dist)));
      applyZoom();
      var after = stage.getBoundingClientRect();
      viewport.scrollLeft += (after.left + pinch.fx * after.width) - midX;
      viewport.scrollTop += (after.top + pinch.fy * after.height) - midY;
    }

    function onMove(e) {
      if (pointers.has(e.pointerId)) {
        var rec = pointers.get(e.pointerId);
        rec.clientX = e.clientX;
        rec.clientY = e.clientY;
      }
      if (pinch) { e.preventDefault(); updatePinch(); return; }
      if (panning) {
        viewport.scrollLeft = panning.sl - (e.clientX - panning.x);
        viewport.scrollTop = panning.st - (e.clientY - panning.y);
        e.preventDefault();
        return;
      }
      e.preventDefault();
      var p = pos(e);

      if (tool === 'group') {
        if (drawing && drawing.pointerId === e.pointerId) {
          if (drawing.type === 'pendingGroups') {
            var pendingLast = drawing.points[drawing.points.length - 1];
            if (Math.abs(pendingLast.x - p.x) + Math.abs(pendingLast.y - p.y) >= 2) drawing.points.push(p);
          } else {
            sweepGroups(p);
            renderMask();
          }
        }
        return;
      }
      if (tool === 'rect') {
        if (drawing && drawing.pointerId === e.pointerId) { drawing.end = p; renderMask(); }
        return;
      }

      if (!drawing) {
        // 涂画 / 擦除：没按住时也要让笔触圆环跟着光标走（只重画光标层，很轻）
        cursorAt = p;
        drawCursor();
        return;
      }
      cursorAt = p;
      var last = drawing.points[drawing.points.length - 1];
      if (Math.abs(last.x - p.x) + Math.abs(last.y - p.y) < 2) {   // 抽稀，省内存
        drawCursor();
        return;
      }
      drawing.points.push(p);
      renderMask();
    }

    function onUp(e) {
      pointers.delete(e.pointerId);
      if (pinch && pointers.size < 2) pinch = null;
      if (panning) {
        panning = null;
        maskCanvas.style.cursor = spaceDown ? 'grab' : cursorForTool();
        drawCursor();
        return;
      }
      if (!drawing || drawing.pointerId !== e.pointerId) return;
      if (e.type !== 'pointercancel') {
        if (drawing.type === 'pendingGroups') {
          drawing.points.push(pos(e));
          pendingGroupGesture = { points: drawing.points.slice() };
          drawing = null;
          if (e.pointerType === 'touch') cursorAt = null;
          renderMask();
          loadRegions();
          return;
        }
        if (drawing.type === 'groups') sweepGroups(pos(e));
        if (drawing.type === 'rect') drawing.end = pos(e);
        var hasSelection = drawing.type === 'groups' ? drawing.boxes.length > 0
          : drawing.type !== 'rect' || (Math.abs(drawing.end.x - drawing.start.x) * dispScale() >= 3 && Math.abs(drawing.end.y - drawing.start.y) * dispScale() >= 3);
        if (hasSelection) {
          rememberCrop();
          if (drawing.type === 'groups') {
            drawing.changes.forEach(function (selected, i) {
              if (selected) picked.add(i); else picked.delete(i);
            });
          } else shapes.push(drawing);
        }
      }
      drawing = null;
      if (e.pointerType === 'touch') cursorAt = null;   // 手指抬起后不留下圆环（触控笔还悬停，保留）
      renderMask();
      if (e.type !== 'pointercancel') publishSelection(true);
    }

    /**
     * 按顺序把形状画到 context 上。
     * 普通形状 = 画上（不透明）；erase 形状 = 擦掉（destination-out）
     */
    function paintTo(ctx, list) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#2563eb';
      ctx.strokeStyle = '#2563eb';
      list.forEach(function (s) {
        ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
        if (s.type === 'groups') {
          s.boxes.forEach(function (r) { ctx.fillRect(r.x, r.y, r.w, r.h); });
        } else if (s.type === 'rect') {
          ctx.fillRect(Math.min(s.start.x, s.end.x), Math.min(s.start.y, s.end.y), Math.abs(s.end.x - s.start.x), Math.abs(s.end.y - s.start.y));
        } else {
          ctx.lineWidth = s.radius * 2;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          s.points.forEach(function (p, i) { i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
          if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.01, s.points[0].y);
          ctx.stroke();
        }
      });
      ctx.globalCompositeOperation = 'source-over';
    }

    /** 先算出真实选区，再据此画可见蒙层：整张压暗，选中的地方挖亮 */
    function renderMask() {
      if (!overlayCtx) return;
      var all = shapes.slice();
      if (drawing && drawing.type !== 'groups' && drawing.type !== 'pendingGroups') all.push(drawing);
      if (tool === 'group') {
        all.push({ type: 'groups', boxes: regions.filter(function (r, i) {
          var selected = picked.has(i);
          if (drawing && drawing.type === 'groups' && drawing.changes.has(i)) selected = drawing.changes.get(i);
          return selected || annotations.has(i);
        }) });
      }

      maskLayerCtx.clearRect(0, 0, W, H);
      paintTo(maskLayerCtx, all);

      overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      overlayCtx.clearRect(0, 0, W, H);
      // 未选中区域的压暗程度：数字越小越透，底图看得越清楚（0.5 是二分之一黑）
      overlayCtx.fillStyle = 'rgba(15,23,42,.5)';
      overlayCtx.fillRect(0, 0, W, H);
      overlayCtx.globalCompositeOperation = 'destination-out';
      overlayCtx.drawImage(maskLayer, 0, 0);
      overlayCtx.globalCompositeOperation = 'source-over';

      // Tint only selected pixels; keep the source image readable.
      overlayCtx.save();
      overlayCtx.globalAlpha = 0.10;
      overlayCtx.drawImage(maskLayer, 0, 0);
      overlayCtx.restore();
      if (tool === 'group') {
        overlayCtx.save();
        overlayCtx.strokeStyle = '#60a5fa';
        overlayCtx.lineWidth = 1.5 / dispScale();
        regions.forEach(function (r, i) {
          var selected = picked.has(i);
          if (drawing && drawing.type === 'groups' && drawing.changes.has(i)) selected = drawing.changes.get(i);
          var color = annotations.has(i) ? annotationColor(annotations.get(i)) : '#60a5fa';
          if (annotations.has(i)) {
            overlayCtx.save();
            overlayCtx.globalAlpha = 0.13;
            overlayCtx.fillStyle = color;
            overlayCtx.fillRect(r.x, r.y, r.w, r.h);
            overlayCtx.restore();
          }
          overlayCtx.strokeStyle = selected ? '#2563eb' : color;
          overlayCtx.lineWidth = (selected ? 3 : 1.5) / dispScale();
          overlayCtx.strokeRect(r.x, r.y, r.w, r.h);
        });
        overlayCtx.restore();
      }
      updateAnnotationPanel();
      publishSelection(false);
      drawRectGuide();
      drawCursor();
    }

    function drawRectGuide() {
      if (!drawing || drawing.type !== 'rect') return;
      var x = Math.min(drawing.start.x, drawing.end.x), y = Math.min(drawing.start.y, drawing.end.y);
      var w = Math.abs(drawing.end.x - drawing.start.x), h = Math.abs(drawing.end.y - drawing.start.y);
      overlayCtx.save();
      overlayCtx.fillStyle = drawing.erase ? 'rgba(239,68,68,.22)' : 'rgba(37,99,235,.12)';
      overlayCtx.strokeStyle = drawing.erase ? '#ef4444' : '#2563eb';
      overlayCtx.lineWidth = 2 / dispScale();
      overlayCtx.setLineDash([6 / dispScale(), 3 / dispScale()]);
      overlayCtx.fillRect(x, y, w, h);
      overlayCtx.strokeRect(x, y, w, h);
      overlayCtx.restore();
    }

    /** 直接数像素：既得到包围盒，也得到真实覆盖面积（擦除之后都是准的） */
    function maskStats() {
      if (!maskLayerCtx) return null;
      var d = maskLayerCtx.getImageData(0, 0, W, H).data;
      var minX = W, minY = H, maxX = -1, maxY = -1, count = 0;
      for (var y = 0; y < H; y++) {
        var row = y * W * 4;
        for (var x = 0; x < W; x++) {
          if (d[row + x * 4 + 3] > 8) {
            count++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return null;
      return {
        x: minX, y: minY,
        w: maxX - minX + 1, h: maxY - minY + 1,
        count: count,
        ratio: count / (W * H)
      };
    }

    /** 抠出选中区域：其余部分涂白 → 裁到包围盒 → 小图放大，让号码占更多像素 */
    function extractSelection() {
      var b = maskStats();
      if (!b || b.w < 4 || b.h < 4) return dataUrl;

      var full = document.createElement('canvas');
      full.width = W; full.height = H;
      var fc = full.getContext('2d');
      fc.fillStyle = '#ffffff';
      fc.fillRect(0, 0, W, H);
      fc.drawImage(img, 0, 0, W, H);
      fc.globalCompositeOperation = 'destination-in';
      fc.drawImage(maskLayer, 0, 0);   // 直接用真实选区当遮罩（擦除已经算进去了）
      fc.globalCompositeOperation = 'source-over';

      var pad = Math.round(Math.max(b.w, b.h) * 0.05) + 12;
      var cx = Math.max(0, Math.round(b.x - pad));
      var cy = Math.max(0, Math.round(b.y - pad));
      var cw = Math.min(W, Math.round(b.x + b.w + pad)) - cx;
      var ch = Math.min(H, Math.round(b.y + b.h + pad)) - cy;

      var up = Math.min(3, Math.max(1, 1200 / Math.max(cw, ch)));
      var out = document.createElement('canvas');
      out.width = Math.round(cw * up);
      out.height = Math.round(ch * up);
      var oc = out.getContext('2d');
      oc.fillStyle = '#ffffff';
      oc.fillRect(0, 0, out.width, out.height);
      oc.imageSmoothingEnabled = true;
      oc.imageSmoothingQuality = 'high';
      oc.drawImage(full, cx, cy, cw, ch, 0, 0, out.width, out.height);
      return out.toDataURL('image/jpeg', 0.92);
    }
  }

  var imageBatch = null;
  var imageBatchVersion = 0;

  function setOcrBtnLabel(text) {
    var el = $('#ocrBtnLabel');
    if (el) el.textContent = text;
  }

  function setImageLayout(open) {
    $('#panelImage').classList.toggle('hidden', !open);
    document.querySelector('.layout').classList.toggle('image-active', open);
    document.body.classList.toggle('image-workspace-active', open);
    $('#inputStep').textContent = open ? '2' : '1';
    $('#outputStep').textContent = open ? '3' : '2';
    $('#inputTitle').textContent = open ? '首次识别' : '输入';
    $('#outputTitle').textContent = open ? '处理结果' : '输出';
    document.dispatchEvent(new Event(open ? 'image-workspace-opened' : 'image-workspace-closed'));
    window.dispatchEvent(new Event('resize'));
  }

  function closeImageWorkspace() {
    imageBatchVersion++;
    if (imageBatch) imageBatch.items.forEach(function (item) { if (item.cleanup) item.cleanup(); });
    imageBatch = null;
    renderInputHighlight();
    $('#imageWorkspace').replaceChildren();
    $('#imageTabs').replaceChildren();
    setImageLayout(false);
    setOcrBtnLabel('上传图片');
  }

  // Keep a row's image identity while its text is edited. Inserted manual rows
  // have no image owner; deleted image rows can be restored by explicit annotation.
  function trackImageDraft(batch, text) {
    var before = batch.draftText ? batch.draftText.split('\n') : [];
    var after = text ? text.split('\n') : [];
    var owners = batch.draftOwners || [];
    var first = 0, tail = 0;
    while (first < before.length && first < after.length && before[first] === after[first]) first++;
    while (tail < before.length - first && tail < after.length - first &&
        before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    var updated = owners.slice(0, first);
    var oldCount = before.length - first - tail;
    var newCount = after.length - first - tail;
    for (var i = 0; i < newCount; i++) {
      updated.push(i < oldCount ? owners[first + i] || null : null);
    }
    if (tail) updated = updated.concat(owners.slice(before.length - tail));
    batch.draftText = text;
    batch.draftOwners = updated.map(function (id, i) { return after[i].trim() ? id : null; });
  }

  function missingImageRows(batch, ids) {
    trackImageDraft(batch, $('#input').value);
    var present = new Set(batch.draftOwners);
    return Array.from(ids).filter(function (id) { return !present.has(id); });
  }

  function refreshImageSelection(batch, scroll) {
    var item = batch.items[batch.activeIndex];
    batch.selectedIds = new Set((item ? item.picked : []).map(function (index) {
      return batch.activeIndex + ':' + index;
    }));
    trackImageDraft(batch, $('#input').value);
    renderInputHighlight();
    if (scroll) {
      var mark = document.querySelector('#inputHighlight .hl-image-selected');
      var input = $('#input');
      if (mark && input.clientHeight) {
        var rect = mark.getBoundingClientRect(), view = input.getBoundingClientRect();
        if (rect.top < view.top || rect.bottom > view.bottom) {
          input.scrollTop += rect.top - view.top - input.clientHeight / 3;
          syncInputScroll();
        }
      }
    }
  }

  function confirmImageRestore(batch, missing, answer) {
    if (!missing.length) { answer(true); return; }
    if (batch.restorePrompt) return;
    batch.restorePrompt = true;
    var answered = false;
    function finish(restore) {
      if (answered) return;
      answered = true;
      batch.restorePrompt = false;
      if (imageBatch === batch) answer(restore);
    }
    openModal({
      title: '重新填回号码？',
      body: '第二栏中有 ' + missing.length + ' 组对应号码已被删除，是否重新填回？',
      closeOnBackdrop: false,
      buttons: [
        { label: '取消', kind: 'ghost', onClick: function () { finish(false); } },
        { label: '重新填回', kind: 'primary', onClick: function () { finish(true); } }
      ],
      onClose: function () { finish(false); }
    });
  }

  function writeImageDraft(batch, text) {
    if ($('#input').value !== text) {
      pushUndoLeft(); setInput(text, 'replace'); commitLeft();
    }
    refreshImageSelection(batch, false);
  }

  function resetRestoredRows(batch, rows, missing) {
    var restored = new Set(missing);
    batch.items.forEach(function (item, imageIndex) {
      var indices = [];
      item.lines = item.lines.map(function (line, index) {
        if (!restored.has(imageIndex + ':' + index)) return line;
        indices.push(index);
        return line.split('=')[0];
      });
      if (indices.length && item.cleanup && item.cleanup.clearAnnotations) {
        item.cleanup.clearAnnotations(indices);
      }
    });
    return rows.map(function (row) {
      return restored.has(row.id) ? { id: row.id, text: row.text.split('=')[0] } : row;
    });
  }

  function mergeImageRows(batch, next, draft, selected) {
    trackImageDraft(batch, draft);
    var lines = draft ? draft.split('\n') : [];
    var owners = batch.draftOwners.slice();
    var positions = new Map();
    owners.forEach(function (id, i) { if (id != null) positions.set(id, i); });
    var old = new Map(batch.previous.map(function (row) { return [row.id, row]; }));
    var inserts = new Map();
    next.forEach(function (row, i) {
      var force = selected.has(row.id);
      if (positions.has(row.id)) {
        var at = positions.get(row.id);
        if (force || (old.has(row.id) && lines[at] === old.get(row.id).text)) {
          lines[at] = row.text;
        }
      } else if (force || !old.has(row.id)) {
        var anchor = lines.length;
        for (var j = i + 1; j < next.length; j++) {
          if (positions.has(next[j].id)) { anchor = positions.get(next[j].id); break; }
        }
        if (!inserts.has(anchor)) inserts.set(anchor, []);
        inserts.get(anchor).push(row);
      }
    });
    var result = [], resultOwners = [];
    for (var i = 0; i <= lines.length; i++) {
      if (inserts.has(i)) inserts.get(i).forEach(function (row) {
        result.push(row.text); resultOwners.push(row.id);
      });
      if (i < lines.length) { result.push(lines[i]); resultOwners.push(owners[i]); }
    }
    batch.draftText = result.join('\n');
    batch.draftOwners = resultOwners;
    return batch.draftText;
  }

  function ocrFiles(files) {
    var imgs = Array.prototype.slice.call(files).filter(function (f) {
      return f && /^image\//.test(f.type);
    });
    if (!imgs.length) { toast('请选择图片文件', 'err'); return; }
    if (imageBatch) imageBatch.items.forEach(function (item) { if (item.cleanup) item.cleanup(); });
    var version = ++imageBatchVersion;
    var batch = { items: [], previous: [], started: false, draftText: '', draftOwners: [], activeIndex: 0, selectedIds: new Set() };
    imageBatch = batch;
    if ($('#input').value) pushUndoLeft();
    setInput('', 'replace');
    commitLeft();
    if ($('#output').value) pushUndo();
    setOutput([]);
    commit();
    var host = $('#imageWorkspace'), tabs = $('#imageTabs');
    host.replaceChildren(); tabs.replaceChildren();
    setImageLayout(true);
    $('#skipNotice').classList.add('hidden');
    setOcrBtnLabel('上传图片');
    $('#ocrInfo').textContent = '正在识别图片…';

    function alive() { return version === imageBatchVersion; }
    function selectImage(index) {
      if (!alive()) return;
      batch.activeIndex = index;
      host.replaceChildren(batch.items[index].host);
      batch.items.forEach(function (item, i) {
        item.tab.setAttribute('aria-pressed', String(i === index));
      });
      refreshImageSelection(batch, false);
      window.dispatchEvent(new Event('resize'));
    }
    function publish(item, lines, meta) {
      if (!alive()) return;
      if (meta.selectionOnly) {
        item.picked = meta.picked;
        refreshImageSelection(batch, meta.settled);
        if (meta.settled && batch.items[batch.activeIndex] === item) {
          var missing = missingImageRows(batch, batch.selectedIds);
          if (missing.length) confirmImageRestore(batch, missing, function (restore) {
            if (!restore) return;
            var rows = resetRestoredRows(batch, batch.previous, missing);
            var text = mergeImageRows(batch, rows, $('#input').value, new Set(missing));
            batch.previous = rows;
            writeImageDraft(batch, text);
            refreshImageSelection(batch, true);
          });
        }
        return;
      }
      if (meta.error) {
        $('#ocrInfo').textContent = meta.error;
        return;
      }
      item.lines = lines;
      var rows = [];
      batch.items.forEach(function (entry, imageIndex) {
        entry.lines.forEach(function (text, rowIndex) {
          rows.push({ id: imageIndex + ':' + rowIndex, text: text });
        });
      });
      if (rows.length) {
        var imageIndex = batch.items.indexOf(item);
        var selected = new Set((meta.selected || []).map(function (index) { return imageIndex + ':' + index; }));
        var missing = batch.started ? missingImageRows(batch, selected) : [];
        confirmImageRestore(batch, missing, function (restore) {
          if (!restore) missing.forEach(function (id) { selected.delete(id); });
          else if (missing.length) rows = resetRestoredRows(batch, rows, missing);
          var nextText = batch.started
            ? mergeImageRows(batch, rows, $('#input').value, selected)
            : rows.map(function (row) { return row.text; }).join('\n');
          if (!batch.started) {
            batch.draftText = nextText;
            batch.draftOwners = rows.map(function (row) { return row.id; });
          }
          writeImageDraft(batch, nextText);
          batch.started = true;
          batch.previous = rows;
        });
      }
      $('#ocrInfo').textContent = '本批 ' + imgs.length + ' 张图片，已识别 ' + rows.length + ' 组';
      if (meta.initial && !lines.length) toast('这张图片未定位到合规号码，可重试定位', 'err');
    }

    imgs.forEach(function (file, index) {
      var item = { host: document.createElement('div'), lines: [], picked: [], cleanup: null, tab: document.createElement('button') };
      item.host.className = 'image-session';
      item.host.textContent = '正在读取图片…';
      item.tab.className = 'btn tiny';
      item.tab.textContent = '图片 ' + (index + 1);
      item.tab.title = file.name || item.tab.textContent;
      item.tab.onclick = function () { selectImage(index); };
      batch.items.push(item);
      tabs.appendChild(item.tab);
      readFileAsDataUrl(file).then(downscale).then(function (dataUrl) {
        if (!alive()) return;
        var img = new Image();
        img.onload = function () {
          if (!alive()) return;
          item.host.replaceChildren();
          item.cleanup = buildCropper(img, dataUrl, function (lines, meta) {
            publish(item, lines, meta);
          }, item.host);
        };
        img.onerror = function () {
          if (!alive()) return;
          item.host.textContent = '图片读取失败，请重新上传';
          $('#ocrInfo').textContent = '图片读取失败';
        };
        img.src = dataUrl;
      }).catch(function (err) {
        if (!alive()) return;
        item.host.textContent = '图片读取失败，请重新上传';
        $('#ocrInfo').textContent = err.message;
        toast('图片读取失败：' + err.message, 'err');
      });
    });
    tabs.classList.toggle('hidden', imgs.length < 2);
    selectImage(0);
  }

  /* ================================================================== *
   * 设置
   * ================================================================== */

  var WORKSPACE_HOST = 'https://dashscope.aliyuncs.com';

  var PROVIDER_PRESETS = {
    dashscope: { baseUrl: WORKSPACE_HOST + '/compatible-mode/v1', model: 'qwen-vl-ocr-latest' },
    'dashscope-native': { baseUrl: WORKSPACE_HOST + '/compatible-mode/v1', model: 'qwen-vl-ocr' },
    openai: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '' }
  };

  function openSettings() {
    var div = document.createElement('div');
    div.innerHTML =
      '<div class="rules muted small">填好后点「保存并测试」。密钥只保存在当前浏览器，直接发给你填写的 OCR 服务，不经过本站服务器。默认仅当前会话有效；测试会调用你的 API 并可能计费。</div>' +
      '<div class="field"><label>服务提供方</label><select id="cfgProvider">' +
      '<option value="dashscope">通义千问 · OpenAI 兼容模式（推荐）</option>' +
      '<option value="dashscope-native">通义千问 · DashScope 原生接口</option>' +
      '<option value="openai">其他 OpenAI 兼容服务</option>' +
      '</select></div>' +
      '<div class="field"><label>接口地址</label><input id="cfgBaseUrl" type="text" spellcheck="false">' +
      '<span class="hint">业务空间专属域名与公共域名 dashscope.aliyuncs.com 不通用。</span></div>' +
      '<div class="field"><label>模型名称</label><input id="cfgModel" type="text" spellcheck="false" list="modelList" placeholder="如 qwen-vl-ocr-latest">' +
      '<datalist id="modelList">' +
      '<option value="qwen-vl-ocr-latest">通义千问 OCR 最新版（推荐）</option>' +
      '<option value="qwen-vl-ocr">通义千问 OCR 稳定版</option>' +
      '<option value="qwen3.5-ocr">通义千问 3.5 OCR（新版，支持 PDF）</option>' +
      '<option value="qwen-vl-ocr-2025-11-20">通义千问 OCR 快照版</option>' +
      '<option value="qwen-vl-max-latest">qwen-vl-max（通用视觉模型，可兜底）</option>' +
      '</datalist>' +
      '<span class="hint">识别不准时可以换成 qwen3.5-ocr 或 qwen-vl-max 对比。</span></div>' +
      '<div class="field"><label>API Key</label><input id="cfgKey" type="password" spellcheck="false" placeholder="sk-...">' +
      '<span class="hint" id="cfgKeyHint"></span></div>' +
      '<label class="inline"><input type="checkbox" id="cfgRemember">在此浏览器记住密钥（共享设备请勿勾选）</label>' +
      '<div class="field"><label>识别提示词（高级，留空用默认）</label>' +
      '<textarea id="cfgPrompt" spellcheck="false" style="min-height:96px;font-size:13px" ' +
      'placeholder="默认提示词已针对手写号码调优，一般不用填"></textarea>' +
      '<span class="hint">某类照片老是识别不准时，可以在这里补充说明，例如「号码是红笔写的」「忽略表格线」「大括号后面是金额」。</span></div>' +
      '<div id="cfgResult" class="hint"></div>';

    openModal({
      title: 'OCR 接口设置',
      body: div,
      buttons: [
        { label: '清除密钥', kind: 'ghost', onClick: function () { saveConfig({ apiKey: '__CLEAR__' }); return false; } },
        { label: '关闭', kind: 'ghost' },
        { label: '仅保存', kind: '', onClick: function () { saveConfig(readCfgForm()); return false; } },
        { label: '保存并测试', kind: 'primary', onClick: function () { testConnection(readCfgForm()); return false; } }
      ],
      onOpen: function () {
        // 弹窗可能在请求返回前就被关掉/换成别的弹窗，所以每次写值前都要确认元素还在
        var alive = function () { return !!document.getElementById('cfgProvider'); };
        window.OCRBrowser.request('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
          if (!alive()) return;
          $('#cfgProvider').value = cfg.provider;
          $('#cfgBaseUrl').value = cfg.baseUrl || '';
          $('#cfgModel').value = cfg.model || '';
          $('#cfgPrompt').value = cfg.ocrPrompt || '';
          $('#cfgRemember').checked = !!cfg.remember;
          $('#cfgKeyHint').textContent = cfg.hasKey
            ? '当前已保存：' + cfg.keyMasked + '（留空表示不修改）'
            : '还没有密钥。在阿里云百炼控制台创建 API-KEY 后粘贴到这里。';

        }).catch(function () {
          if (!alive()) return;
          $('#cfgKeyHint').textContent = '无法读取浏览器配置，请检查浏览器存储权限';
        });
        $('#cfgProvider').onchange = function () {
          var p = PROVIDER_PRESETS[$('#cfgProvider').value];
          if (p) { $('#cfgBaseUrl').value = p.baseUrl; $('#cfgModel').value = p.model; }
        };
      }
    });
  }

  function readCfgForm() {
    return {
      provider: $('#cfgProvider').value,
      baseUrl: $('#cfgBaseUrl').value,
      model: $('#cfgModel').value,
      apiKey: $('#cfgKey').value,
      ocrPrompt: $('#cfgPrompt').value,
      remember: $('#cfgRemember').checked
    };
  }

  function saveConfig(patch) {
    return fetchWithTimeout(apiBase() + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    }, 20000).then(function (r) { return r.json(); }).then(function (cfg) {
      if (cfg.ok) {
        setOcrStatus(cfg.hasKey, cfg.keyMasked);
        if (patch.apiKey === '__CLEAR__') toast('已清除密钥', 'ok');
        else toast('设置已保存', 'ok');
      }
      if (!cfg.ok) toast(cfg.error || '保存失败', 'err');
      return cfg;
    }).catch(function () {
      toast('保存失败，请检查浏览器存储权限', 'err');
    });
  }

  function testConnection(cfg) {
    var box = $('#cfgResult');
    box.textContent = '正在测试…';
    fetchWithTimeout(apiBase() + '/api/ocr/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    }, 60000).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d.ok) {
          box.innerHTML = '<span style="color:var(--ok)">✓ 连接正常（' + res.d.ms + ' ms，模型 ' +
            escapeHtml(res.d.model) + '）</span>';
          saveConfig(cfg).then(function () { setTimeout(closeModal, 700); });
        } else {
          box.innerHTML = '<span style="color:var(--danger)">✗ ' + escapeHtml(res.d.error || '测试失败') + '</span>';
        }
      })
      .catch(function (err) {
        box.innerHTML = '<span style="color:var(--danger)">✗ ' + escapeHtml(err.message) + '</span>';
      });
  }

  /* ================================================================== *
   * 帮助
   * ================================================================== */

  function openHelp() {
    openModal({
      title: '规则说明',
      body:
        '<div class="rules">' +
        '<b>一、号码格式</b>' +
        '<ul>' +
        '<li>只允许 <code>0-9</code> 和 <code>X</code>，粘贴内容里的 <code>+</code> <code>*</code> <code>x</code> 一律转成大写 <code>X</code>。</li>' +
        '<li>4 位：纯数字，或含 1~2 个 X（<code>1234</code> <code>X234</code> <code>XX34</code> 合法；<code>XXX4</code> <code>XXXX</code> 非法）。</li>' +
        '<li>3 位：只允许纯数字（<code>123</code> 合法；<code>X23</code>、<code>XX3</code> 非法）。</li>' +
        '<li>其它位数（如 <code>12345</code>、<code>12345678</code>）判为异常，不会自动拆分。</li>' +
        '<li>允许前导 0（<code>0123</code>、<code>012</code>）；<b>粘贴进左边输入框就实时校验，不合规的号码当场标红</b>（鼠标停上去能看到原因），' +
        '必须修正后才能生成；空行会自动忽略。</li>' +
        '<li>后缀 <code>=N</code>：N 可以是 0、正整数或正小数（<code>2.5</code>），不允许负数；' +
        '<code>1234=2</code>、<code>1234 = 2</code>、<code>1234=+2</code>、全角 <code>１２３４＝２</code> 都算合规（判之前先做字符归一化）。</li>' +
        '</ul>' +
        '<b>二、全倒</b>' +
        '<ul>' +
        '<li>对每个 4 位纯数字生成全部不重复排列，包含原号码。</li>' +
        '<li><code>1234</code> → 24 组；<code>1224</code> → 12 组；<code>1122</code> → 6 组；<code>1112</code> → 4 组；<code>1111</code> → 1 组。</li>' +
        '</ul>' +
        '<b>三、3字X</b>' +
        '<ul>' +
        '<li>先输出全部原号码，再依次把第 1、2、3、4 位替换成 X。</li>' +
        '<li>例：<code>1234、5678、8901</code> → 原号码 3 组 + <code>X234 X678 X901</code> + <code>1X34 5X78 8X01</code> + <code>12X4 56X8 89X1</code> + <code>123X 567X 890X</code>。</li>' +
        '</ul>' +
        '<b>四、右侧输出框</b>' +
        '<ul>' +
        '<li>一个大文本域，<b>每行一组</b>，可以直接改、直接粘贴、直接删。</li>' +
        '<li>异常行显示为红色，重复号码显示为橙色，下面还有可点击的问题列表。</li>' +
        '<li>「批量添加 =N」「清除后缀」：<b>先选中若干行</b>就只对这些行生效，不选则对全部行生效。</li>' +
        '<li><b>「选择组」</b>：以<b>空行</b>为界，一键把光标所在的<b>一整组</b>（连续若干行）选上，省得手动拖；' +
        '已经是整组选区时再点一次，会顺着往下多选一组（到最后一组会提示）。左右两个输入框都有这个按钮，' +
        '配合「批量添加 =N」就能给一整组号码统一加后缀。</li>' +
        '<li>重复只看号码部分：<code>1234=2</code> 与 <code>1234=3</code> 算重复，不会自动合并或相加；保留不算错误。</li>' +
        '<li><b>「撤销」左右各一个，历史互不相通</b>：左边的撤销管输入框（打字、粘贴、清空、套用疑似修正），' +
        '右边的撤销管图片生成、全倒 / 3字X、去重、批量 =N 和手动编辑。连续打字只算一步，最多回退 40 步。</li>' +
        '</ul>' +
        '<b>五、全部复制</b>' +
        '<ul><li>一键把右侧当前内容<b>整段复制</b>到剪贴板：每行一组，含手动改过的 =N 后缀，全倒 / 3字X 的分组空行也会一起带上。</li>' +
        '<li>复制出去的是<b>规范写法</b>：全角数字、符号会自动转成半角（右侧文本域里显示的还是你输入的原样）。</li>' +
        '<li>右侧还没有内容时会提示。</li></ul>' +
        '<b>六、图片点选标注</b>' +
        '<ul>' +
        '<li>上传或粘贴图片后，主页面展开为原图、首次识别、处理结果三栏，并立即定位三位 / 四位号码；定位完成后点击号码可选中，再点一次取消，拖动经过多组时逐组切换选择。</li>' +
        '<li>操作区显示已定位和已标注的组数。选择号码后输入 =N 并标注，不同数值用不同颜色区分。</li>' +
        '<li>首次识别与图片标注同步到中间输入栏，可以直接编辑和复制；使用「全倒」「3字X」或「格式整理」生成右侧处理结果。手机端通过图片、输入、输出标签切换。</li>' +
        '<li><b>格式整理</b>：把左侧输入框的内容<b>就地</b>整理成合规格式（每行一个号码）。' +
        '合法的原样保留（含 <code>=N</code> 后缀）；<code>42×4=168（元）</code> 这种会救出 <code>42X4</code>；' +
        '救不出来的（<code>XXX4</code>、<code>12345678</code>）过滤掉并在下方提示，可一键放回。' +
        '<b>整理结果会同时同步一份到右侧输出框</b>。整理错了按左右两侧各自的「撤销」退回。</li>' +
        '<li><b>放大缩小</b>：鼠标滚轮缩放，手机双指捏合。' +
        '放大后拖滚动条，或按住<b>空格</b>／鼠标中键拖动即可平移。</li>' +
        '</ul>' +
        '<b>七、OCR 识别只保留合规号码</b>' +
        '<ul>' +
        '<li>识别结果会先过滤一遍：<b>只留下符合规则的 3~4 位号码组合</b>，其它内容自动丢掉。</li>' +
        '<li>如果一段都不合规，输入框<b>不会被写入任何内容</b>，只在下方提示，不会把垃圾塞进来。</li>' +
        '<li>「看起来像号码但不符合格式」的内容（例如 <code>42713</code> 这种被读成 5 位的）会单独列为疑似误读，' +
        '并建议你把照片裁剪到只剩号码部分、拍正一点再识别。</li>' +
        '<li>每行「=」后面的算式结果整段丢弃：<code>42×4=168（元）</code> → <code>42X4</code>；<code>49×1=49（元）</code> → <code>49X1</code>。</li>' +
        '<li><code>×</code>、<code>+</code>、<code>*</code>、<code>x</code> 一并转成大写 <code>X</code>：<code>4×94</code> → <code>4X94</code>。</li>' +
        '<li>连续 5 位以上（如 <code>12345678</code>）不会被截断，整段丢弃，避免错误拆分。</li>' +
        '<li><code>XXX4</code>、<code>X23</code> 这类不合规的组合也会被丢掉，但会在下方提示里列出来，点「查看全部 / 放回输入框」可以找回来手动改。</li>' +
        '<li>如果出现 <code>64915</code> 这种「像是把括号读成了数字」的结果，会给出<b>疑似修正建议</b>' +
        '（<code>64915 → 6491</code>），点「采用疑似修正」一键写入输入框，你核对一下即可。</li>' +
        '</ul>' +
        '</div>',
      buttons: [{ label: '知道了', kind: 'primary' }]
    });
  }

  /* ================================================================== *
   * 事件绑定
   * ================================================================== */

  function bind() {
    var inputTa = $('#input');
    // 输入（含粘贴）：一边实时校验，一边记撤销点（连续打字算一步）
    inputTa.addEventListener('input', function () {
      beginTypingUndoLeft();
      syncInput();
      clearTimeout(leftTimer);
      leftTimer = setTimeout(function () { leftBurst = false; commitLeft(); }, 800);
    });
    inputTa.addEventListener('scroll', syncInputScroll);
    ['select', 'focus', 'blur', 'keyup', 'mouseup'].forEach(function (event) {
      inputTa.addEventListener(event, renderInputHighlight);
    });
    document.addEventListener('selectionchange', renderInputHighlight);
    $('#btnFormat').onclick = doFormatInput;
    $('#btnReverse').onclick = doReverse;
    $('#btnThreeX').onclick = doThreeX;
    $('#btnOcr').onclick = function () { $('#fileInput').click(); };
    $('#btnReplaceImage').onclick = function () { $('#fileInput').click(); };
    $('#btnCloseImage').onclick = closeImageWorkspace;
    $('#fileInput').onchange = function (e) { ocrFiles(e.target.files); e.target.value = ''; };

    $('#btnUndoInput').onclick = doUndoLeft;
    $('#btnClearInput').onclick = function () {
      if (!state.leftText) return;
      pushUndoLeft();                       // 清空也能撤销回来
      setInput('', 'replace');
      showSkipNotice(null, null);
    };
    $('#btnSelectAllInput').onclick = function () { inputTa.focus(); inputTa.select(); };
    $('#btnCopyAllInput').onclick = copyAllInput;
    $('#btnSelectGroupInput').onclick = function () { selectGroup($('#input')); };

    // 右侧文本域
    var ta = $('#output');
    ta.addEventListener('input', function () {
      beginTypingUndo();
      state.output = ta.value;
      refresh();
      saveSoon();
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function () { typingBurst = false; commit(); }, 800);
    });
    ta.addEventListener('scroll', syncScroll);
    ['keyup', 'mouseup', 'focus', 'blur', 'select'].forEach(function (ev) {
      ta.addEventListener(ev, function () { setTimeout(updateSelHint, 0); });
    });
    ta.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') { setTimeout(updateSelHint, 0); }
    });

    $('#btnSetSuffix').onclick = openSuffixModal;
    $('#btnClearSuffix').onclick = doClearSuffix;
    $('#btnDedupeAll').onclick = doDedupe;
    $('#btnSelectAllOutput').onclick = function () { ta.focus(); ta.select(); updateSelHint(); };
    $('#btnSelectGroupOutput').onclick = function () { selectGroup(ta); };
    $('#btnUndo').onclick = doUndo;
    $('#btnClearOutput').onclick = function () {
      if (!state.output) return;
      confirmModal('清空右侧？', '将清空右侧全部内容（可用「撤销」恢复）。', function () {
        pushUndo(); setOutput([]); commit(); toast('已清空右侧', 'ok');
      }, '清空');
    };
    $('#btnCopyAll').onclick = copyAll;

    $('#btnSettings').onclick = openSettings;
    $('#btnHelp').onclick = openHelp;
    $('#modalClose').onclick = closeModal;
    $('#modalBackdrop').addEventListener('click', function (e) { if (modalCloseOnBackdrop && e.target.id === 'modalBackdrop') closeModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' && !$('#modalBackdrop').classList.contains('hidden')) {
        if (modalOnEscape && modalOnEscape() === true) return;   // 弹窗自己消费掉这次 Esc
        closeModal();
      }
      // Ctrl/Cmd + S 原本接的是导出 TXT；导出暂时下线（先不做），这里只拦掉浏览器的「保存网页」
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && document.activeElement !== ta && document.activeElement !== $('#input') &&
          !(e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)))) {
        e.preventDefault(); doUndo();
      }
    });

    // 拖拽图片
    var dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover'); });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) ocrFiles(e.dataTransfer.files);
    });
    ['dragover', 'drop'].forEach(function (ev) {
      window.addEventListener(ev, function (e) { e.preventDefault(); });
    });

    // 粘贴图片（截图）
    document.addEventListener('paste', function (e) {
      if (!e.clipboardData || !e.clipboardData.items) return;
      var files = [];
      for (var i = 0; i < e.clipboardData.items.length; i++) {
        var it = e.clipboardData.items[i];
        if (it.kind === 'file' && /^image\//.test(it.type)) {
          var f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        ocrFiles(files);
      }
    });

    window.addEventListener('resize', syncScroll);
  }

  /* ================================================================== *
   * 启动
   * ================================================================== */

  function init() {
    loadSaved();
    $('#input').value = state.leftText;
    $('#output').value = state.output;
    commit();
    commitLeft();              // 左侧撤销的基线
    refresh();                 // 右侧：高亮 / 问题列表 / 状态栏
    updateInputCount();        // 左侧：行数徽标
    renderInputHighlight();    // 左侧：本地恢复的内容也要立刻标红
    updateSelHint();
    bind();
    loadConfig();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 忽略 */ });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
