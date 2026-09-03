const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebContentsView, session, shell, app } = require('electron');
const services = require('./services');

const BUNDLED_STYLES = path.join(__dirname, '..', 'styles');
const COLUMN_PRELOAD = path.join(__dirname, '..', 'preload', 'column-preload.js');
const DENIED_PERMISSIONS = new Set(['notifications', 'geolocation', 'midi', 'midiSysex', 'hid', 'serial', 'usb']);

// "Electron/38.0.0" のような "名前/バージョン" トークンを UA から取り除く。
function stripToken(ua, name) {
  const at = ua.indexOf(name + '/');
  if (at === -1) return ua;
  let end = at + name.length + 1;
  while (end < ua.length && ua[end] !== ' ') end += 1;
  const head = ua.slice(0, at).replace(/ +$/, '');
  const tail = ua.slice(end);
  return (head + tail).replace(/ {2,}/g, ' ').trim();
}

// Electron 既定の UA には "Electron/x.y.z" と製品名が入っており、X などが
// 古いブラウザ扱いして表示を崩すことがあるので素の Chrome UA に寄せる。
function cleanUserAgent() {
  return stripToken(stripToken(app.userAgentFallback, 'Electron'), app.getName());
}

// CSS がこちらの置いた内容のままかを見分けるための指紋。
// 改行コードの違いで別物と判定されないよう揃えてから取る。
function hash(text) {
  const normalized = String(text).split('\r\n').join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

class ColumnManager {
  /**
   * @param {import('electron').BaseWindow} win ドック本体のウインドウ
   * @param {() => import('electron').WebContents | null} getChrome UI 側へ状態を送るための関数
   */
  constructor(win, getChrome) {
    this.win = win;
    this.getChrome = getChrome;
    this.views = new Map(); // id -> { view, col }
    this.stylesDir = path.join(app.getPath('userData'), 'styles');
    this.preparedSessions = new Set();
    this.seedStyles();
  }

  /**
   * 既定の注入 CSS をユーザーデータ側へ複製する（ユーザーが編集できるようにするため）。
   *
   * 「無ければコピー」だけだと、アプリを更新しても古い CSS が残り続けて
   * 新しいルールが永久に届かない。かといって毎回上書きするとユーザーの
   * 編集が消える。そこで「前回こちらが書いた内容」のハッシュを控えておき、
   *   - 中身がそのままなら（＝手を入れていない）→ 新しい既定で置き換える
   *   - 変わっていれば（＝編集済み）→ 触らずに残す
   * とする。
   */
  seedStyles() {
    const manifestPath = path.join(this.stylesDir, '.seeded.json');
    let manifest = {};
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      manifest = {};
    }

    const kept = [];
    const backedUp = [];
    try {
      fs.mkdirSync(this.stylesDir, { recursive: true });
      for (const name of fs.readdirSync(BUNDLED_STYLES)) {
        if (!name.endsWith('.css')) continue;
        const src = path.join(BUNDLED_STYLES, name);
        const dest = path.join(this.stylesDir, name);
        const bundled = fs.readFileSync(src, 'utf8');
        const bundledHash = hash(bundled);

        let current = null;
        try {
          current = fs.readFileSync(dest, 'utf8');
        } catch {
          current = null;
        }

        if (current === null || hash(current) === manifest[name]) {
          // 未配置、または前回こちらが置いたまま手つかず → 最新に入れ替える
          if (current !== bundled) fs.writeFileSync(dest, bundled, 'utf8');
          manifest[name] = bundledHash;
        } else if (manifest[name] === undefined) {
          // 記録が無い＝この仕組みを入れる前から置かれていたファイル。
          // 編集済みかどうか判別できないので、控えを取ってから最新にする。
          const backup = dest + '.bak';
          try {
            if (!fs.existsSync(backup)) fs.copyFileSync(dest, backup);
            backedUp.push(name);
          } catch (err) {
            console.error('[columns] %s の控えを作れませんでした:', name, err.message);
          }
          fs.writeFileSync(dest, bundled, 'utf8');
          manifest[name] = bundledHash;
        } else if (manifest[name] !== bundledHash) {
          // ユーザーが編集している。上書きせず、更新があることだけ知らせる。
          kept.push(name);
        }
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    } catch (err) {
      console.error('[columns] CSS の初期配置に失敗:', err);
    }

    if (backedUp.length) {
      console.log('[columns] CSS を新しい既定に更新しました: %s（元の内容は .bak として %s に残しています）',
        backedUp.join(', '), this.stylesDir);
    }
    if (kept.length) {
      console.warn(
        '[columns] 編集済みのため更新しなかった CSS: %s（新しい既定を使うには %s のファイルを削除してください）',
        kept.join(', '),
        this.stylesDir
      );
    }
  }

  // サービス専用の CSS を探し、無ければ generic.css に落とす。
  // 新しいサービスを足したとき、CSS を書かなくても最低限は整うようにするため。
  readStyle(service) {
    for (const name of [service + '.css', 'generic.css']) {
      for (const dir of [this.stylesDir, BUNDLED_STYLES]) {
        try {
          return fs.readFileSync(path.join(dir, name), 'utf8');
        } catch {
          // 次の候補を試す
        }
      }
    }
    return '';
  }

  /**
   * 注入する CSS を組み立てる。
   * 設定のつまみは CSS 変数として先頭に置き、本体のルールはユーザーが
   * 編集できる .css 側に置く。こうしておくと、CSS を書き換えても
   * 文字倍率や画像の折りたたみのつまみは効いたまま残る。
   */
  buildCss(col) {
    const mediaMax = col.collapseMedia ? '96px' : 'none';
    const vars = `:root{--tld-text-scale:${col.textScale};--tld-media-max:${mediaMax};}`;
    return vars + '\n' + this.readStyle(col.service);
  }

  /** CSS を入れ直す。倍率を変えたときなど、再読み込みせずに反映させる。 */
  async applyCss(id) {
    const entry = this.views.get(id);
    if (!entry) return;
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return;

    const css = this.buildCss(entry.col);
    try {
      const key = await wc.insertCSS(css);
      // 先に入っていたぶんは、新しいものを入れてから外す（ちらつき防止）
      if (entry.cssKey) await wc.removeInsertedCSS(entry.cssKey).catch(() => {});
      entry.cssKey = key;
    } catch {
      // ページ遷移の途中などは失敗しうる。次の dom-ready で入り直す。
    }
  }

  prepareSession(service) {
    const def = services.get(service);
    const ses = session.fromPartition(def.partition);
    if (this.preparedSessions.has(def.partition)) return ses;

    ses.setUserAgent(cleanUserAgent());
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(!DENIED_PERMISSIONS.has(permission));
    });
    this.preparedSessions.add(def.partition);
    return ses;
  }

  status(id, payload) {
    const chrome = this.getChrome();
    if (chrome && !chrome.isDestroyed()) chrome.send('col:status', { id, ...payload });
  }

  create(col) {
    const def = services.get(col.service);
    const ses = this.prepareSession(col.service);
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: COLUMN_PRELOAD, // 新着検知と自動ログインをページ内で行う
        // サービス定義はここで渡す。プリロードは sandbox 下でファイルを読めないため。
        additionalArguments: ['--tld-service=' + encodeURIComponent(JSON.stringify(def))],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#15181c');

    const wc = view.webContents;
    wc.setUserAgent(cleanUserAgent());

    wc.on('dom-ready', () => {
      const current = this.views.get(col.id);
      wc.setZoomFactor(current ? current.col.zoom : col.zoom);
      if (current) current.cssKey = null; // ページが変われば前の CSS は失効している
      this.applyCss(col.id);
    });
    wc.on('did-start-loading', () => this.status(col.id, { loading: true }));
    wc.on('did-stop-loading', () => {
      this.status(col.id, {
        loading: false,
        error: null,
        url: wc.getURL(),
        canGoBack: wc.navigationHistory.canGoBack(),
      });
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 は ERR_ABORTED（別ページへの遷移などで日常的に出る）ので無視する。
      if (isMainFrame && code !== -3) this.status(col.id, { loading: false, error: desc + ' (' + code + ')', url });
    });
    wc.on('render-process-gone', (_e, details) => {
      this.status(col.id, { loading: false, error: '表示プロセスが停止しました (' + details.reason + ')' });
    });

    // リンククリックは同一サービス内ならその場で開き、外部サイトは既定のブラウザへ。
    wc.setWindowOpenHandler(({ url }) => {
      if (this.isInternal(url, def)) {
        wc.loadURL(url);
      } else if (/^https?:/i.test(url)) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    view.setVisible(false);
    this.win.contentView.addChildView(view);
    wc.loadURL(col.url).catch(() => {});
    this.views.set(col.id, { view, col: { ...col } });
    return view;
  }

  isInternal(url, def) {
    const host = hostOf(url);
    if (!host) return false;
    return def.hosts.some((h) => host === h || host.endsWith('.' + h));
  }

  destroy(id) {
    const entry = this.views.get(id);
    if (!entry) return;
    this.win.contentView.removeChildView(entry.view);
    entry.view.webContents.close();
    this.views.delete(id);
  }

  destroyAll() {
    for (const id of [...this.views.keys()]) this.destroy(id);
  }

  // 設定上のカラム一覧に合わせてビューを作成・破棄・更新する。
  sync(columns) {
    const wanted = new Set(columns.map((c) => c.id));
    for (const id of [...this.views.keys()]) {
      if (!wanted.has(id)) this.destroy(id);
    }

    for (const col of columns) {
      const entry = this.views.get(col.id);
      if (!entry) {
        this.create(col);
        continue;
      }
      const prev = entry.col;
      entry.col = { ...col };
      if (prev.service !== col.service) {
        // サービスが変わるとセッションも変わるので作り直す。
        this.destroy(col.id);
        this.create(col);
        continue;
      }
      if (prev.zoom !== col.zoom) entry.view.webContents.setZoomFactor(col.zoom);
      // 文字倍率や画像の折りたたみは、再読み込みせず CSS を入れ直すだけで反映できる。
      if (prev.textScale !== col.textScale || prev.collapseMedia !== col.collapseMedia) {
        this.applyCss(col.id);
      }
      if (prev.url !== col.url) entry.view.webContents.loadURL(col.url).catch(() => {});
    }
  }

  // レンダラーが計算した矩形（CSS px = DIP）をそのままビューに適用する。
  applyRects(rects) {
    const shown = new Set();
    for (const r of rects) {
      const entry = this.views.get(r.id);
      if (!entry) continue;
      const bounds = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.max(0, Math.round(r.width)),
        height: Math.max(0, Math.round(r.height)),
      };
      entry.view.setBounds(bounds);
      const visible = bounds.width > 0 && bounds.height > 0;
      entry.view.setVisible(visible);
      if (visible) shown.add(r.id);
    }
    for (const [id, entry] of this.views) {
      if (!shown.has(id)) entry.view.setVisible(false);
    }
  }

  setAllVisible(visible) {
    for (const [, entry] of this.views) entry.view.setVisible(visible);
  }

  withView(id, fn) {
    const entry = this.views.get(id);
    if (entry && !entry.view.webContents.isDestroyed()) fn(entry.view.webContents, entry.col);
  }

  /** ページから届いた IPC が、どのカラムのものかを引く。 */
  findByWebContents(wc) {
    for (const [id, entry] of this.views) {
      if (entry.view.webContents === wc) return { id, col: entry.col, webContents: wc };
    }
    return null;
  }

  send(id, channel, payload) {
    this.withView(id, (wc) => wc.send(channel, payload));
  }


  /**
   * 実際のキー入力を送る。
   * X の新着流し込みは「ピリオドキー」で行う（X 自身が aria-label で案内している）。
   * JS の合成クリックも、座標を狙った本物のマウス入力も効かなかったが、
   * このキー送信だけが通った。
   */
  sendKey(id, keyCode) {
    this.withView(id, (wc) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode });
      wc.sendInputEvent({ type: 'char', keyCode });
      wc.sendInputEvent({ type: 'keyUp', keyCode });
    });
  }

  reload(id) {
    this.withView(id, (wc) => wc.reload());
  }

  goHome(id) {
    this.withView(id, (wc, col) => wc.loadURL(col.url).catch(() => {}));
  }

  goBack(id) {
    this.withView(id, (wc) => {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    });
  }

  scrollTop(id) {
    this.withView(id, (wc) => {
      wc.executeJavaScript('window.scrollTo({ top: 0, behavior: "smooth" })', true).catch(() => {});
    });
  }

  openDevTools(id) {
    this.withView(id, (wc) => wc.openDevTools({ mode: 'detach' }));
  }

  openExternal(id) {
    this.withView(id, (wc) => {
      const url = wc.getURL();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    });
  }

  // 指定サービスの Cookie などを消す（＝ログアウト）。
  async clearSession(service) {
    const ses = this.prepareSession(service);
    await ses.clearStorageData();
    for (const [id, entry] of this.views) {
      if (entry.col.service === service) this.reload(id);
    }
  }
}

module.exports = { ColumnManager, cleanUserAgent };
