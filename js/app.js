/* Redax — Obsidian-подобный блочный редактор заметок.
   Работает без установки в любом современном браузере.
   Хранение: реальная папка с .md-файлами (Chrome/Edge, File System Access API)
   или локальное демо-хранилище (localStorage) как запасной вариант. */
(function () {
  'use strict';

  var V = window.RedaxVault;

  var FONTS = [
    { key: 'classic', label: 'Книжный', heading: "'Cormorant Garamond', Georgia, serif", body: "'Lora', Georgia, serif" },
    { key: 'sans', label: 'Гротеск', heading: "'Helvetica Neue', 'Segoe UI', system-ui, sans-serif", body: "'Helvetica Neue', 'Segoe UI', system-ui, sans-serif" },
    { key: 'mono', label: 'Моно', heading: "'SF Mono', 'JetBrains Mono', ui-monospace, monospace", body: "'SF Mono', 'JetBrains Mono', ui-monospace, monospace" },
    { key: 'type', label: 'Машинка', heading: "'Courier Prime', 'Courier New', Courier, monospace", body: "'Courier Prime', 'Courier New', Courier, monospace" }
  ];

  var BLOCK_TYPES = [
    { key: 'h1', label: 'Заголовок 1' },
    { key: 'h2', label: 'Заголовок 2' },
    { key: 'h3', label: 'Заголовок 3' },
    { key: 'p', label: 'Текст' }
  ];

  var UID = 0;

  /* ── Markdown ⇄ блоки ── */
  function toBlocks(src) {
    var blocks = (src || '').split(/\n{2,}/).map(function (raw) {
      var b = raw.trim();
      if (!b) return null;
      if (b.indexOf('### ') === 0) return { id: ++UID, type: 'h3', text: b.slice(4) };
      if (b.indexOf('## ') === 0) return { id: ++UID, type: 'h2', text: b.slice(3) };
      if (b.indexOf('# ') === 0) return { id: ++UID, type: 'h1', text: b.slice(2) };
      return { id: ++UID, type: 'p', text: b };
    }).filter(Boolean);
    if (!blocks.length) blocks.push({ id: ++UID, type: 'p', text: '' });
    return blocks;
  }

  function toMarkdown(blocks) {
    return blocks.map(function (b) {
      var prefix = { h1: '# ', h2: '## ', h3: '### ', p: '' }[b.type] || '';
      return prefix + b.text;
    }).join('\n\n');
  }

  function wordCount(blocks) {
    var n = 0;
    blocks.forEach(function (b) {
      var words = b.text.trim().split(/\s+/).filter(Boolean);
      n += words.length;
    });
    return n;
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  function fmtDate(ts) {
    try {
      return new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' }).format(new Date(ts));
    } catch (e) {
      return '';
    }
  }

  function fileMeta(f) {
    var words = wordCount(f.blocks || []);
    return fmtDate(f.mtime) + ' · ' + words + ' ' + plural(words, 'слово', 'слова', 'слов');
  }

  function sanitizeName(s) {
    return s.replace(/[\/\\:*?"<>|]/g, '').trim();
  }

  /* ── Состояние ── */
  var state = {
    vault: null,          // активное хранилище (DemoVault | FsVault)
    files: [],            // [{ name, folder, mtime, blocks }]
    trash: [],
    active: 0,
    closed: {},           // свёрнутые папки
    removing: -1,         // индекс файла в анимации удаления
    sidebar: true,
    trashOpen: false,
    settings: { fontSize: 15, font: 'classic', showExt: false }
  };

  var editingId = null;   // блок, который сейчас редактируется (его DOM не трогаем)
  var pendingFocus = null;
  var menuAt = null;      // индекс блока с открытым меню «+»
  var saveTimer = null;
  var dirty = [];         // файлы с несохранёнными правками

  /* ── DOM ── */
  var $ = function (id) { return document.getElementById(id); };
  var elSidebar = $('sidebar');
  var elFileList = $('file-list');
  var elEditor = $('editor');
  var elTrashView = $('trash-view');
  var elWork = $('work');
  var elModalLayer = $('modal-layer');
  var elRemoveNote = $('btn-remove-note');
  var elCaret = $('sidebar-caret');

  function curFile() { return state.files[state.active] || null; }

  /* ── Сохранение ── */
  function loadSettings() {
    try {
      var raw = localStorage.getItem('redax.settings');
      if (raw) Object.assign(state.settings, JSON.parse(raw));
    } catch (e) { /* ок */ }
  }
  function saveSettings() {
    try { localStorage.setItem('redax.settings', JSON.stringify(state.settings)); } catch (e) { /* ок */ }
  }

  function scheduleSave(index) {
    var f = state.files[index];
    if (!f) return;
    f.mtime = Date.now();
    if (dirty.indexOf(f) < 0) dirty.push(f);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 600);
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!state.vault) return;
    state.files.forEach(function (f) { f.text = toMarkdown(f.blocks); });
    if (state.vault.kind === 'demo') {
      dirty = [];
      state.vault.sync(
        state.files.map(function (f) { return { name: f.name, folder: f.folder, mtime: f.mtime, text: f.text }; }),
        state.trash.map(function (f) { return { name: f.name, folder: f.folder, mtime: f.mtime, text: f.text }; })
      );
      return;
    }
    // FS: записываем все файлы с правками; при переименовании убираем файл со старым именем
    var batch = dirty;
    dirty = [];
    batch.forEach(function (f) {
      var old = f._oldName;
      delete f._oldName;
      var op = old && old !== f.name
        ? state.vault.rename(old, f)
        : state.vault.write(f);
      op.catch(function (err) { console.warn('Redax: не удалось сохранить файл', err); });
    });
  }

  /* ── Боковая панель ── */
  function renderSidebar() {
    elFileList.innerHTML = '';
    var folders = [];
    state.files.forEach(function (f) {
      var k = f.folder || '';
      if (folders.indexOf(k) < 0) folders.push(k);
    });
    folders.sort(function (a, b) {
      if (a === '') return 1;
      if (b === '') return -1;
      return a.localeCompare(b, 'ru');
    });

    folders.forEach(function (folder) {
      var open = !state.closed[folder];
      if (folder) {
        var frow = document.createElement('div');
        frow.className = 'row folder';
        frow.innerHTML = '<span class="marker">' + (open ? '⌄' : '›') + '</span><span class="row-name"></span>';
        frow.querySelector('.row-name').textContent = folder;
        frow.addEventListener('click', function () {
          state.closed[folder] = open;
          renderSidebar();
        });
        elFileList.appendChild(frow);
      }
      if (!open) return;
      state.files.forEach(function (f, i) {
        if ((f.folder || '') !== folder) return;
        var row = document.createElement('div');
        row.className = 'row' + (folder ? ' nested' : '') +
          (i === state.active && !state.trashOpen ? ' active' : '') +
          (i === state.removing ? ' removing' : '');
        var nm = state.settings.showExt ? f.name : f.name.replace(/\.md$/i, '');
        row.innerHTML = '<span class="marker"></span><span class="row-name"></span>';
        row.querySelector('.row-name').textContent = nm;
        row.addEventListener('click', function () {
          editingId = null;
          state.active = i;
          state.trashOpen = false;
          menuAt = null;
          render();
        });
        elFileList.appendChild(row);
      });
    });
  }

  /* ── Редактор ── */
  function renderEditor() {
    var f = curFile();
    elEditor.innerHTML = '';
    if (!f) return;
    f.blocks.forEach(function (b, i) {
      var row = document.createElement('div');
      row.className = 'block-row' + (menuAt === i ? ' menu-open' : '');

      var plus = document.createElement('button');
      plus.className = 'block-plus';
      plus.title = 'Добавить блок';
      plus.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>';
      plus.addEventListener('click', function (e) {
        e.stopPropagation();
        menuAt = (menuAt === i) ? null : i;
        renderEditor();
      });
      row.appendChild(plus);

      var el = document.createElement('div');
      el.className = 'block ' + b.type;
      el.contentEditable = 'true';
      el.spellcheck = true;
      el.dataset.ph = b.type === 'p' ? 'Текст заметки' : 'Заголовок';
      el.dataset.blockId = b.id;
      el.textContent = b.text;

      el.addEventListener('focus', function () { editingId = b.id; });
      el.addEventListener('input', function () { onBlockInput(i, el.innerText); });
      el.addEventListener('keydown', function (e) { onBlockKey(i, e, el); });
      row.appendChild(el);

      if (menuAt === i) {
        var menu = document.createElement('div');
        menu.className = 'block-menu';
        BLOCK_TYPES.forEach(function (t) {
          var item = document.createElement('button');
          item.className = 'block-menu-item';
          item.textContent = t.label;
          item.addEventListener('click', function (e) {
            e.stopPropagation();
            addBlock(i, t.key);
          });
          menu.appendChild(item);
        });
        if (f.blocks.length > 1) {
          var sep = document.createElement('div');
          sep.className = 'block-menu-sep';
          menu.appendChild(sep);
          var del = document.createElement('button');
          del.className = 'block-menu-item danger';
          del.textContent = 'Удалить блок';
          del.addEventListener('click', function (e) {
            e.stopPropagation();
            removeBlock(i);
          });
          menu.appendChild(del);
        }
        row.appendChild(menu);
      }

      elEditor.appendChild(row);
    });

    if (pendingFocus !== null) {
      focusBlock(pendingFocus);
      pendingFocus = null;
    }
  }

  function focusBlock(id) {
    var el = elEditor.querySelector('[data-block-id="' + id + '"]');
    if (!el) return;
    el.focus();
    var r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function onBlockInput(i, text) {
    var f = curFile();
    if (!f || !f.blocks[i]) return;
    // innerText отдаёт \n на переносах строк — храним как есть
    f.blocks[i].text = text.replace(/\n+$/, '');
    if (f.blocks[i].type === 'h1' && f.blocks[i].text.trim()) {
      var name = sanitizeName(f.blocks[i].text) + '.md';
      if (name !== '.md' && f.name !== name) {
        if (!f._oldName) f._oldName = f.name;
        f.name = name;
        renderSidebar();
      }
    }
    scheduleSave(state.active);
  }

  function onBlockKey(i, e, el) {
    var f = curFile();
    if (!f) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      var nb = { id: ++UID, type: 'p', text: '' };
      editingId = null;
      f.blocks.splice(i + 1, 0, nb);
      pendingFocus = nb.id;
      menuAt = null;
      renderEditor();
      scheduleSave(state.active);
    } else if (e.key === 'Backspace' && !el.textContent && f.blocks.length > 1) {
      e.preventDefault();
      var prev = f.blocks[i - 1];
      editingId = null;
      f.blocks.splice(i, 1);
      if (prev) pendingFocus = prev.id;
      menuAt = null;
      renderEditor();
      scheduleSave(state.active);
    }
  }

  function removeBlock(i) {
    var f = curFile();
    if (!f || f.blocks.length < 2) return;
    var prev = f.blocks[i - 1] || f.blocks[i + 1];
    editingId = null;
    f.blocks.splice(i, 1);
    if (prev) pendingFocus = prev.id;
    menuAt = null;
    renderEditor();
    scheduleSave(state.active);
  }

  function addBlock(i, type) {
    var f = curFile();
    if (!f) return;
    var nb = { id: ++UID, type: type, text: '' };
    editingId = null;
    f.blocks.splice(i + 1, 0, nb);
    pendingFocus = nb.id;
    menuAt = null;
    renderEditor();
    scheduleSave(state.active);
  }

  /* ── Корзина ── */
  function renderTrash() {
    elTrashView.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'trash-head';
    head.innerHTML = '<span class="trash-title">Корзина</span><span class="link-caps" id="trash-back">К заметкам</span>';
    elTrashView.appendChild(head);
    head.querySelector('#trash-back').addEventListener('click', function () {
      state.trashOpen = false;
      render();
    });

    if (!state.trash.length) {
      var empty = document.createElement('div');
      empty.className = 'trash-empty';
      empty.textContent = 'Здесь пока пусто.';
      elTrashView.appendChild(empty);
      return;
    }

    var groups = [];
    state.trash.forEach(function (f, i) {
      var key = f.folder || 'Без папки';
      var g = groups.filter(function (x) { return x.folder === key; })[0];
      if (!g) { g = { folder: key, items: [] }; groups.push(g); }
      g.items.push({ file: f, index: i });
    });

    groups.forEach(function (g) {
      var gEl = document.createElement('div');
      gEl.className = 'trash-group';
      var title = document.createElement('div');
      title.className = 'trash-group-title';
      title.textContent = g.folder;
      gEl.appendChild(title);
      g.items.forEach(function (it) {
        var row = document.createElement('div');
        row.className = 'trash-item';
        row.innerHTML = '<span class="trash-item-name"></span><span class="trash-item-meta"></span>' +
          '<button class="trash-restore" title="Вернуть файл">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.4"></path><path d="M3 4v5h5"></path></svg></button>';
        row.querySelector('.trash-item-name').textContent = it.file.name;
        row.querySelector('.trash-item-meta').textContent = fmtDate(it.file.mtime);
        row.querySelector('.trash-restore').addEventListener('click', function () {
          restoreFromTrash(it.index);
        });
        gEl.appendChild(row);
      });
      elTrashView.appendChild(gEl);
    });
  }

  function restoreFromTrash(i) {
    var f = state.trash.splice(i, 1)[0];
    if (!f) return;
    state.files.push(f);
    state.active = state.files.length - 1;
    state.trashOpen = state.trash.length > 0;
    if (state.vault.kind === 'fs') {
      state.vault.restore(f).catch(function (err) { console.warn('Redax: не удалось вернуть файл', err); });
    } else {
      flushSave();
    }
    render();
  }

  /* ── Удаление ── */
  function askDelete(i) {
    if (state.files.length < 2) return;
    var f = state.files[i];
    openModal(buildConfirmModal('«' + f.name + '» переместится в корзину.', function () {
      closeModal();
      state.removing = i;
      renderSidebar();
      setTimeout(function () {
        var gone = state.files.splice(i, 1)[0];
        state.removing = -1;
        if (gone) {
          state.trash.unshift(gone);
          if (state.vault.kind === 'fs') {
            gone.text = toMarkdown(gone.blocks);
            state.vault.moveToTrash(gone).catch(function (err) { console.warn('Redax: не удалось удалить файл', err); });
          } else {
            flushSave();
          }
        }
        state.active = Math.max(0, Math.min(state.active, state.files.length - 1));
        editingId = null;
        render();
      }, 200);
    }));
  }

  /* ── Новая заметка ── */
  function addFile() {
    var n = 1;
    while (state.files.some(function (f) { return f.name === 'Новая заметка ' + n + '.md'; })) n++;
    var title = 'Новая заметка ' + n;
    var blocks = [{ id: ++UID, type: 'h1', text: title }, { id: ++UID, type: 'p', text: '' }];
    var file = { name: title + '.md', folder: '', mtime: Date.now(), blocks: blocks, text: '' };
    state.files.push(file);
    state.active = state.files.length - 1;
    state.trashOpen = false;
    pendingFocus = blocks[1].id;
    render();
    scheduleSave(state.active);
  }

  /* ── Модальные окна ── */
  function openModal(node) {
    elModalLayer.innerHTML = '';
    elModalLayer.appendChild(node);
    elModalLayer.hidden = false;
  }
  function closeModal() {
    elModalLayer.hidden = true;
    elModalLayer.innerHTML = '';
  }
  elModalLayer.addEventListener('click', function (e) {
    if (e.target === elModalLayer) closeModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !elModalLayer.hidden) closeModal();
  });

  function buildConfirmModal(text, onConfirm) {
    var m = document.createElement('div');
    m.className = 'modal';
    m.style.width = '340px';
    m.innerHTML = '<div class="modal-title">Удалить заметку?</div>' +
      '<div class="modal-note"></div>' +
      '<div style="display:flex; gap:var(--space-3); margin-top:var(--space-5)">' +
      '<button class="btn btn-primary" data-act="ok">Удалить</button>' +
      '<button class="btn btn-ghost" data-act="cancel">Отмена</button></div>';
    m.querySelector('.modal-note').textContent = text;
    m.querySelector('[data-act="ok"]').addEventListener('click', onConfirm);
    m.querySelector('[data-act="cancel"]').addEventListener('click', closeModal);
    return m;
  }

  function buildVaultModal() {
    var m = document.createElement('div');
    m.className = 'modal';
    m.style.width = '380px';
    m.innerHTML = '<div class="modal-title" style="margin-bottom:var(--space-4)">Рабочая директория</div>' +
      '<div class="vault-list" style="display:flex; flex-direction:column; gap:2px"></div>' +
      '<div class="link-caps" id="pick-folder" style="margin-left:0; margin-top:var(--space-5); font-size:12.5px"></div>' +
      '<div class="modal-note" id="vault-hint" style="margin-top:var(--space-3)"></div>';

    var list = m.querySelector('.vault-list');

    function addRow(label, current, onPick) {
      var row = document.createElement('div');
      row.className = 'vault-row' + (current ? ' current' : '');
      row.textContent = label;
      row.addEventListener('click', onPick);
      list.appendChild(row);
    }

    addRow('Локальные заметки (в браузере)', state.vault && state.vault.kind === 'demo', function () {
      closeModal();
      switchVault(new V.DemoVault());
    });

    V.listRecentVaults().then(function (items) {
      items.forEach(function (it) {
        var isCurrent = state.vault && state.vault.kind === 'fs' && state.vault.label === it.name;
        addRow('📁 ' + it.name, isCurrent, function () {
          closeModal();
          openHandle(it.handle);
        });
      });
    });

    var pick = m.querySelector('#pick-folder');
    var hint = m.querySelector('#vault-hint');
    if (V.fsSupported) {
      pick.textContent = 'Выбрать другую папку…';
      pick.addEventListener('click', function () {
        window.showDirectoryPicker({ mode: 'readwrite' }).then(function (handle) {
          closeModal();
          V.saveRecentVault(handle);
          switchVault(new V.FsVault(handle));
        }).catch(function () { /* пользователь передумал */ });
      });
      hint.textContent = 'Заметки читаются и сохраняются как .md-файлы прямо в выбранной папке.';
    } else {
      pick.textContent = '';
      hint.textContent = 'Ваш браузер не поддерживает работу с папками (нужен Chrome или Edge). Заметки хранятся локально в браузере.';
    }
    return m;
  }

  function openHandle(handle) {
    handle.queryPermission({ mode: 'readwrite' }).then(function (p) {
      if (p === 'granted') return p;
      return handle.requestPermission({ mode: 'readwrite' });
    }).then(function (p) {
      if (p === 'granted') {
        V.saveRecentVault(handle);
        switchVault(new V.FsVault(handle));
      }
    }).catch(function (err) { console.warn('Redax: нет доступа к папке', err); });
  }

  function switchVault(vault) {
    // сначала дописываем всё несохранённое в старое хранилище
    if (saveTimer) flushSave();
    state.vault = vault;
    vault.list().then(function (data) {
      state.files = data.files.map(function (f) {
        return Object.assign({}, f, { blocks: toBlocks(f.text) });
      });
      state.trash = data.trash.map(function (f) {
        return Object.assign({}, f, { blocks: toBlocks(f.text) });
      });
      state.files.sort(function (a, b) {
        var fa = a.folder || '', fb = b.folder || '';
        if (fa !== fb) {
          if (fa === '') return 1;   // файлы без папки — в конец, как в панели
          if (fb === '') return -1;
          return fa.localeCompare(fb, 'ru');
        }
        return a.name.localeCompare(b.name, 'ru');
      });
      if (!state.files.length && vault.kind === 'fs') {
        // пустая папка — создаём первую заметку
        var blocks = [{ id: ++UID, type: 'h1', text: 'Новая заметка' }, { id: ++UID, type: 'p', text: '' }];
        state.files.push({ name: 'Новая заметка.md', folder: '', mtime: Date.now(), blocks: blocks, text: '' });
      }
      state.active = 0;
      state.trashOpen = false;
      state.closed = {};
      editingId = null;
      menuAt = null;
      render();
    }).catch(function (err) {
      console.warn('Redax: не удалось открыть хранилище', err);
    });
  }

  function buildSettingsModal() {
    var m = document.createElement('div');
    m.className = 'modal';
    m.style.width = '360px';
    m.innerHTML = '<div class="modal-title" style="margin-bottom:var(--space-4)">Настройки</div>' +
      '<div class="settings-grid">' +
      '<div class="settings-row"><span>Размер текста</span>' +
      '<span class="step-btn push" data-act="down">−</span>' +
      '<span class="step-value" id="fs-val"></span>' +
      '<span class="step-btn" data-act="up">+</span></div>' +
      '<div class="settings-row"><span style="flex:none">Шрифт</span>' +
      '<span class="push" id="font-opts" style="display:flex; gap:var(--space-3)"></span></div>' +
      '<div class="settings-row"><span>Показывать расширение .md</span>' +
      '<span class="toggle-link push" id="ext-toggle"></span></div>' +
      '<div class="settings-row"><span>Рабочая директория</span>' +
      '<span class="vault-current-link push" id="vault-link"></span></div>' +
      '</div>';

    var fsVal = m.querySelector('#fs-val');
    function syncFs() { fsVal.textContent = state.settings.fontSize + 'px'; }
    syncFs();
    m.querySelector('[data-act="down"]').addEventListener('click', function () {
      state.settings.fontSize = Math.max(13, state.settings.fontSize - 1);
      syncFs(); applySettings(); saveSettings();
    });
    m.querySelector('[data-act="up"]').addEventListener('click', function () {
      state.settings.fontSize = Math.min(20, state.settings.fontSize + 1);
      syncFs(); applySettings(); saveSettings();
    });

    var opts = m.querySelector('#font-opts');
    function renderFonts() {
      opts.innerHTML = '';
      FONTS.forEach(function (f) {
        var s = document.createElement('span');
        s.className = 'font-opt' + (state.settings.font === f.key ? ' current' : '');
        s.style.fontFamily = f.body;
        s.textContent = f.label;
        s.addEventListener('click', function () {
          state.settings.font = f.key;
          renderFonts(); applySettings(); saveSettings();
        });
        opts.appendChild(s);
      });
    }
    renderFonts();

    var ext = m.querySelector('#ext-toggle');
    function syncExt() { ext.textContent = state.settings.showExt ? 'да' : 'нет'; }
    syncExt();
    ext.addEventListener('click', function () {
      state.settings.showExt = !state.settings.showExt;
      syncExt(); renderSidebar(); saveSettings();
    });

    var vl = m.querySelector('#vault-link');
    vl.textContent = state.vault ? state.vault.label : '';
    vl.addEventListener('click', function () {
      closeModal();
      openModal(buildVaultModal());
    });
    return m;
  }

  function buildAccountModal() {
    var m = document.createElement('div');
    m.className = 'modal';
    m.style.width = '340px';
    m.innerHTML = '<div class="modal-title">Аккаунт</div>' +
      '<div class="modal-note">Вход через Google Account появится в одном из следующих обновлений — ' +
      'он позволит синхронизировать заметки между устройствами.</div>' +
      '<div style="display:flex; gap:var(--space-3); margin-top:var(--space-5)">' +
      '<button class="btn btn-primary" disabled style="opacity:.45; cursor:default">Войти через Google</button>' +
      '<button class="btn btn-ghost" data-act="close">Закрыть</button></div>';
    m.querySelector('[data-act="close"]').addEventListener('click', closeModal);
    return m;
  }

  /* ── Применение настроек и общий рендер ── */
  function applySettings() {
    var font = FONTS.filter(function (f) { return f.key === state.settings.font; })[0] || FONTS[0];
    document.documentElement.style.setProperty('--font-body', font.body);
    document.documentElement.style.setProperty('--font-heading', font.heading);
    elEditor.style.fontSize = state.settings.fontSize + 'px';
  }

  function render() {
    renderSidebar();
    if (state.trashOpen) {
      elEditor.hidden = true;
      elRemoveNote.hidden = true;
      elTrashView.hidden = false;
      renderTrash();
    } else {
      elTrashView.hidden = true;
      elEditor.hidden = false;
      elRemoveNote.hidden = state.files.length < 2;
      renderEditor();
    }
    elSidebar.classList.toggle('collapsed', !state.sidebar);
    elWork.classList.toggle('wide', !state.sidebar);
    elCaret.setAttribute('d', state.sidebar ? 'M16 9l-2 3 2 3' : 'M14 9l2 3-2 3');
    $('btn-sidebar').title = state.sidebar ? 'Скрыть панель' : 'Показать панель';
    $('btn-trash').title = state.trash.length ? 'Корзина · ' + state.trash.length : 'Корзина';
    $('btn-vault').title = state.vault ? 'Рабочая директория: ' + state.vault.label : 'Рабочая директория';
  }

  /* ── Обработчики рейки ── */
  $('btn-sidebar').addEventListener('click', function () {
    state.sidebar = !state.sidebar;
    render();
  });
  $('btn-vault').addEventListener('click', function () { openModal(buildVaultModal()); });
  $('btn-settings').addEventListener('click', function () { openModal(buildSettingsModal()); });
  $('btn-add').addEventListener('click', addFile);
  $('btn-trash').addEventListener('click', function () {
    state.trashOpen = true;
    render();
  });
  elRemoveNote.addEventListener('click', function () { askDelete(state.active); });
  $('btn-account').addEventListener('click', function () { openModal(buildAccountModal()); });

  // клик мимо меню «+» закрывает его
  document.addEventListener('click', function (e) {
    if (menuAt !== null && !e.target.closest('.block-menu') && !e.target.closest('.block-plus')) {
      menuAt = null;
      renderEditor();
    }
  });

  // сохранить незаписанное при закрытии вкладки
  window.addEventListener('beforeunload', function () {
    if (saveTimer) { clearTimeout(saveTimer); flushSave(); }
  });

  /* ── Запуск ── */
  loadSettings();
  applySettings();
  if (window.innerWidth < 640) state.sidebar = false;
  switchVault(new V.DemoVault());
})();
