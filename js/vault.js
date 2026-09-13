/* Redax — слой хранения.
   Два вида хранилищ:
   - DemoVault: заметки в localStorage, работает в любом браузере (в т.ч. с file://).
   - FsVault: настоящая папка с .md-файлами через File System Access API (Chrome/Edge).
   Оба отдают файлы вида { name, folder, mtime, text } и принимают их обратно. */
(function () {
  'use strict';

  var SEED = [
    { name: 'Архив как метод.md', folder: 'Исследования', mtime: Date.now() - 86400000 * 2,
      text: '# Архив как метод\n\nСобрание документов перестаёт быть складом в тот момент, когда между единицами хранения появляется маршрут. Порядок описи — не свойство материала, а решение исследователя.\n\n## Три операции\n\nОпись, перестановка, комментарий. Первая фиксирует, вторая проверяет фиксацию на прочность, третья оставляет след самой проверки.\n\nКаталог — это гипотеза о том, что с чем лежит рядом.\n\nОтсюда простое требование к инструменту: писать поверх файла, не изменяя файл.' },
    { name: 'Онтология памяти.md', folder: 'Исследования', mtime: Date.now() - 86400000 * 4,
      text: '# Онтология памяти\n\nЕдиница хранения получает имя раньше, чем место: опись закрепляет имя, полка — только соседство.' },
    { name: 'Черновик статьи.md', folder: 'Тексты', mtime: Date.now() - 86400000 * 7,
      text: '# Черновик статьи\n\nПервый абзац ещё не написан.' },
    { name: 'Словарь терминов.md', folder: '', mtime: Date.now() - 86400000 * 12,
      text: '# Словарь терминов\n\nОпись — перечень единиц хранения фонда с указанием состава и датировки.' }
  ];

  var LS_KEY = 'redax.demo.vault';

  /* ── Демо-хранилище (localStorage) ── */
  function DemoVault() {
    this.kind = 'demo';
    this.label = 'Локальные заметки';
  }
  DemoVault.prototype._load = function () {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* приватный режим и т.п. — работаем из памяти */ }
    return null;
  };
  DemoVault.prototype._save = function (data) {
    this._cache = data;
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) { /* ок */ }
  };
  DemoVault.prototype.list = function () {
    var data = this._cache || this._load();
    if (!data) {
      data = { files: SEED.slice(), trash: [] };
      this._save(data);
    }
    this._cache = data;
    return Promise.resolve({ files: data.files.slice(), trash: (data.trash || []).slice() });
  };
  DemoVault.prototype.sync = function (files, trash) {
    this._save({ files: files, trash: trash });
    return Promise.resolve();
  };
  // Для демо-хранилища всё делает sync(); отдельные операции — no-op.
  DemoVault.prototype.write = function () { return Promise.resolve(); };
  DemoVault.prototype.rename = function () { return Promise.resolve(); };
  DemoVault.prototype.moveToTrash = function () { return Promise.resolve(); };
  DemoVault.prototype.restore = function () { return Promise.resolve(); };
  DemoVault.prototype.emptyTrash = function () { return Promise.resolve(); };

  /* ── Настоящая папка (File System Access API) ── */
  function FsVault(dirHandle) {
    this.kind = 'fs';
    this.dir = dirHandle;
    this.label = dirHandle.name;
  }

  FsVault.prototype._folderHandle = function (folder, create) {
    if (!folder) return Promise.resolve(this.dir);
    return this.dir.getDirectoryHandle(folder, { create: !!create });
  };

  FsVault.prototype._readDir = function (dirHandle, folder, out) {
    var self = this;
    var iter = dirHandle.entries();
    function step() {
      return iter.next().then(function (res) {
        if (res.done) return;
        var name = res.value[0], handle = res.value[1];
        var p;
        if (handle.kind === 'file' && /\.md$/i.test(name)) {
          p = handle.getFile().then(function (f) {
            return f.text().then(function (text) {
              out.push({ name: name, folder: folder, mtime: f.lastModified, text: text });
            });
          });
        } else if (handle.kind === 'directory' && folder === '' && name !== '.trash' && name.charAt(0) !== '.') {
          p = self._readDir(handle, name, out);
        } else {
          p = Promise.resolve();
        }
        return p.then(step);
      });
    }
    return step();
  };

  FsVault.prototype.list = function () {
    var self = this;
    var files = [];
    var trash = [];
    return this._readDir(this.dir, '', files).then(function () {
      return self.dir.getDirectoryHandle('.trash', { create: false }).then(function (td) {
        return self._readTrash(td, trash);
      }, function () { /* корзины ещё нет */ });
    }).then(function () {
      return { files: files, trash: trash };
    });
  };

  // В .trash файлы лежат как "папка__имя.md", чтобы помнить исходную папку.
  FsVault.prototype._readTrash = function (td, out) {
    var iter = td.entries();
    function step() {
      return iter.next().then(function (res) {
        if (res.done) return;
        var name = res.value[0], handle = res.value[1];
        var p = Promise.resolve();
        if (handle.kind === 'file' && /\.md$/i.test(name)) {
          p = handle.getFile().then(function (f) {
            return f.text().then(function (text) {
              var folder = '', plain = name;
              var sep = name.indexOf('__');
              if (sep > 0) { folder = name.slice(0, sep); plain = name.slice(sep + 2); }
              out.push({ name: plain, folder: folder, mtime: f.lastModified, text: text });
            });
          });
        }
        return p.then(step);
      });
    }
    return step();
  };

  FsVault.prototype.write = function (file) {
    return this._folderHandle(file.folder, true).then(function (dh) {
      return dh.getFileHandle(file.name, { create: true });
    }).then(function (fh) {
      return fh.createWritable();
    }).then(function (w) {
      return w.write(file.text).then(function () { return w.close(); });
    });
  };

  FsVault.prototype._removeFile = function (folder, name) {
    return this._folderHandle(folder, false).then(function (dh) {
      return dh.removeEntry(name);
    }).catch(function () { /* файла уже нет — не страшно */ });
  };

  FsVault.prototype.rename = function (oldName, file) {
    var self = this;
    return this.write(file).then(function () {
      if (oldName !== file.name) return self._removeFile(file.folder, oldName);
    });
  };

  FsVault.prototype.moveToTrash = function (file) {
    var self = this;
    return this.dir.getDirectoryHandle('.trash', { create: true }).then(function (td) {
      var trashName = (file.folder ? file.folder + '__' : '') + file.name;
      return td.getFileHandle(trashName, { create: true }).then(function (fh) {
        return fh.createWritable();
      }).then(function (w) {
        return w.write(file.text).then(function () { return w.close(); });
      });
    }).then(function () {
      return self._removeFile(file.folder, file.name);
    });
  };

  FsVault.prototype.restore = function (file) {
    var self = this;
    return this.write(file).then(function () {
      return self.dir.getDirectoryHandle('.trash', { create: false }).then(function (td) {
        var trashName = (file.folder ? file.folder + '__' : '') + file.name;
        return td.removeEntry(trashName);
      }).catch(function () { /* ок */ });
    });
  };

  FsVault.prototype.emptyTrash = function () {
    return this.dir.removeEntry('.trash', { recursive: true })
      .catch(function () { /* корзины нет — уже чисто */ });
  };

  FsVault.prototype.sync = function () { return Promise.resolve(); };

  /* ── Недавние папки (IndexedDB, там можно хранить directory handle) ── */
  var DB_NAME = 'redax';
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('vaults', { keyPath: 'name' }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function saveRecentVault(handle) {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('vaults', 'readwrite');
        tx.objectStore('vaults').put({ name: handle.name, handle: handle, at: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    }).catch(function () { /* без IndexedDB просто не будет недавних */ });
  }
  function listRecentVaults() {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('vaults', 'readonly');
        var req = tx.objectStore('vaults').getAll();
        req.onsuccess = function () {
          var items = req.result || [];
          items.sort(function (a, b) { return b.at - a.at; });
          resolve(items);
        };
        req.onerror = function () { resolve([]); };
      });
    }).catch(function () { return []; });
  }

  window.RedaxVault = {
    DemoVault: DemoVault,
    FsVault: FsVault,
    saveRecentVault: saveRecentVault,
    listRecentVaults: listRecentVaults,
    fsSupported: typeof window.showDirectoryPicker === 'function'
  };
})();
