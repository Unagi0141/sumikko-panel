const path = require('path');
const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  screen,
  shell,
  ipcMain,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  dialog,
} = require('electron');

// userData の場所は app が ready になる前に決めきる必要があるので、
// 他のモジュールを読み込むより先に確定させる。
const dataLocation = require('./data-location');
const dataInfo = dataLocation.applyAtStartup();

const store = require('./store');
const services = require('./services');
const features = require('./features');
// 無効なときは読み込まない。積んでいないことをはっきりさせるため。
const credentials = features.credentials ? require('./credentials') : null;
const { ColumnManager } = require('./columns');
const { Win32Bridge, hwndOf } = require('./win32');
const updater = require('./updater');

const STRIP_WIDTH = 6;          // 自動的に隠したときに残す帯の幅
const FULLSCREEN_POLL_MS = 1200;

// 新着音はユーザー操作なしで鳴らしたいので、自動再生の制限を外す。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Windows のスタートアップから起動されたときは、いきなり前面に出さずトレイに待機させる。
const startHidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden;

let win = null;          // ドック本体（BaseWindow）
let chromeView = null;   // ヘッダー・設定パネルを描画する UI レイヤー
let strip = null;        // 自動的に隠したときの呼び出し用の帯
let tray = null;
let columns = null;
let hideTimer = null;
let cursorPoll = null;
let snapUntil = 0;       // この時刻まではジオメトリ再適用中とみなす（再入防止）
let quitting = false;

/* ------------------------------------------------------------------ *
 * 落ちたときの記録
 * ------------------------------------------------------------------ */

// 常駐アプリなので、理由を残さず消えるのがいちばん困る。
// パッケージ版は端末を持たないため、握りつぶさずファイルへ書く。
function errorLogPath() {
  try {
    return path.join(app.getPath('userData'), 'error.log');
  } catch {
    return null;
  }
}

function recordError(kind, err) {
  const text = `[${new Date().toISOString()}] ${kind}: ${(err && err.stack) || err}
`;
  console.error(text.trim());

  const file = errorLogPath();
  if (!file) return;
  try {
    const fs = require('fs');
    // 際限なく太らせない。1MB を超えたら捨てて新しく始める。
    try {
      if (fs.statSync(file).size > 1024 * 1024) fs.unlinkSync(file);
    } catch {
      // まだ無いだけ
    }
    fs.appendFileSync(file, text, 'utf8');
  } catch {
    // 書けなくても続行する
  }
}

// 既定のままだと、主プロセスの例外は毎回モーダルダイアログになって終了する。
// 終了処理の途中で届く通知（作業領域の変化など）でも出てしまい、
// 利用者には「閉じるたびにエラーが出る」としか見えない。
process.on('uncaughtException', (err) => {
  recordError('uncaughtException', err);
  // 終了中の例外は、もう誰にも知らせる必要がない
  if (quitting) return;
  // それ以外は動き続ける。常駐をやめるほうが実害が大きい。
});

process.on('unhandledRejection', (reason) => {
  recordError('unhandledRejection', reason);
});

const win32 = new Win32Bridge();
let appbarActive = false;
let fullscreenPoll = null;
let fullscreenNow = false;
let hiddenByFullscreen = false;

// カラム id -> 直近に報告されたログアウト状態。同じ内容を繰り返しログに出さないため。
const lastAuthState = new Map();
// 同じ案内を繰り返さないための記録。
const filledNotified = new Set();

// 新着の流し込みと、更新が途絶えたときの再読み込み用。
// カラム id -> { at: 最後に送った時刻, top: そのときの先頭投稿, misses: 空振りの回数 }
const livePress = new Map();
const lastFreshAt = new Map();     // カラム id -> 最後に新着を見た時刻
const lastStaleReload = new Map(); // カラム id -> 最後に再読み込みした時刻
const LIVE_MAX_INTERVAL_MS = 300000; // 空振りが続いたときの上限（5 分）
const LIVE_MAX_MISSES = 4;

const appStartedAt = Date.now();

const state = () => store.load();

function chromeWebContents() {
  return chromeView && !chromeView.webContents.isDestroyed() ? chromeView.webContents : null;
}

function sendToUi(channel, payload) {
  const wc = chromeWebContents();
  if (wc) wc.send(channel, payload);
}

function broadcastState() {
  sendToUi('state', state());
}

/* ------------------------------------------------------------------ *
 * ジオメトリ（画面端への吸着 / 作業領域の予約）
 * ------------------------------------------------------------------ */

// 表示先は「設定で指定したディスプレイ」→「主ディスプレイ」の順で決める。
// ウインドウの現在位置からは決めない（起動直後に画面情報が揺れると、
// 意図しないモニタへ吸着してそのまま居座ってしまうため）。
function currentDisplay() {
  const wanted = state().displayId;
  if (wanted !== null) {
    const found = screen.getAllDisplays().find((d) => d.id === wanted);
    if (found) return found;
  }
  return screen.getPrimaryDisplay();
}

function dockBounds(display = currentDisplay()) {
  const area = display.workArea;
  const width = Math.min(state().width, area.width);
  const x = state().edge === 'right' ? area.x + area.width - width : area.x;
  return { x, y: area.y, width, height: area.height };
}

function stripBounds(display = currentDisplay()) {
  const area = display.workArea;
  const x = state().edge === 'right' ? area.x + area.width - STRIP_WIDTH : area.x;
  return { x, y: area.y, width: STRIP_WIDTH, height: area.height };
}

function isSnapping() {
  return Date.now() < snapUntil;
}

/**
 * AppBar として画面の端に居座り、作業領域を予約する。
 * 予約すると、最大化した他のウインドウはこのドックの手前で止まる。
 *
 * 希望する矩形にはモニタ全体を渡す。タスクバーなど既存の AppBar のぶんは
 * シェル側（ABM_QUERYPOS）が差し引いてくれるので、ここで差し引くと二重になる。
 */
async function applyAppBar(display) {
  const scale = display.scaleFactor || 1;
  const b = display.bounds;
  const result = await win32.call('appbar_setpos', {
    hwnd: hwndOf(win),
    edge: state().edge,
    // 希望する矩形はモニタ全体。タスクバーなど既存の AppBar のぶんは
    // シェル側（ABM_QUERYPOS）が差し引くので、ここで引くと二重になる。
    x: Math.round(b.x * scale),
    y: Math.round(b.y * scale),
    w: Math.round(b.width * scale),
    h: Math.round(b.height * scale),
    thickness: Math.round(state().width * scale),
  });
  appbarActive = true;
  if (process.env.TLDOCK_DEBUG) console.log('[debug] appbar =>', JSON.stringify(result));

  // 希望した厚みと、シェルが認めた幅がずれたら記録しておく。
  // 予約幅が設定と食い違うときの切り分けに要る。
  const wanted = Math.round(state().width * scale);
  if (result && result.width && Math.abs(result.width - wanted) > 1) {
    console.warn('[main] 予約幅が希望と違います: 希望=%d 実際=%d (設定の幅=%d, 倍率=%s)',
      wanted, result.width, state().width, scale);
  }

  // MoveWindow が動かすのは「影の余白を含む枠」なので、そのままだと見えている
  // 部分が予約領域より 8px ほど内側に入る。Electron 側の座標系で置き直して隙間を消す。
  if (result && result.width && alive()) {
    win.setBounds({
      x: Math.round(result.x / scale),
      y: Math.round(result.y / scale),
      width: Math.round(result.width / scale),
      height: Math.round(result.height / scale),
    });
  }
  return result;
}

async function removeAppBar() {
  if (!appbarActive) return;
  appbarActive = false;
  try {
    await win32.call('appbar_remove', {});
  } catch (err) {
    console.error('[main] AppBar の解除に失敗:', err.message);
  }
}

async function applyGeometry(display = currentDisplay()) {
  if (!alive()) return;
  snapUntil = Date.now() + 900;

  if (state().reserveSpace && win32.available) {
    try {
      await applyAppBar(display);
      if (!alive()) return;
      if (strip && !strip.isDestroyed()) strip.setBounds(stripBounds(display));
      snapUntil = Date.now() + 900;
      return;
    } catch (err) {
      console.error('[main] 領域の予約に失敗したので通常配置にします:', err.message);
    }
  }

  await removeAppBar();
  // ここまでに終了が始まっていることがある
  if (!alive()) return;

  const target = dockBounds(display);
  const cur = win.getBounds();
  if (cur.x !== target.x || cur.y !== target.y || cur.width !== target.width || cur.height !== target.height) {
    win.setBounds(target);
  }
  if (strip && !strip.isDestroyed()) strip.setBounds(stripBounds(display));
}

/* ------------------------------------------------------------------ *
 * 全画面アプリの検知
 * ------------------------------------------------------------------ */

function startFullscreenWatch() {
  stopFullscreenWatch();
  if (!win32.available) return;
  fullscreenPoll = setInterval(async () => {
    if (!state().hideOnFullscreen) return;
    let value = false;
    try {
      value = await win32.call('fullscreen', {}, { timeoutMs: 3000 });
    } catch {
      return;
    }
    if (value === fullscreenNow) return;
    fullscreenNow = value;

    if (value) {
      // 全画面のアプリが前に出ている間は完全に引っ込む
      if (alive() && win.isVisible()) {
        hiddenByFullscreen = true;
        hideDock({ releaseSpace: false });
        if (strip && !strip.isDestroyed()) strip.hide();
      }
    } else if (hiddenByFullscreen) {
      hiddenByFullscreen = false;
      showDock({ focus: false });
    }
  }, FULLSCREEN_POLL_MS);
}

/* ------------------------------------------------------------------ *
 * 更新が途絶えたときの再読み込み（保険）
 * ------------------------------------------------------------------ */

let stalePoll = null;

// 定期的なリロードはしない。ページは自前の接続で更新され続けるので、
// 定期リロードはむしろ生きた接続と読みかけの位置を捨てることになる。
// ここで見るのは「明らかに止まっている」ときだけ。
function startStaleWatch() {
  stopStaleWatch();
  stalePoll = setInterval(() => {
    const minutes = state().staleReloadMin;
    if (!minutes || !columns) return;
    const limit = minutes * 60 * 1000;
    const now = Date.now();

    for (const col of state().columns) {
      if (!col.live) continue;
      const since = now - (lastFreshAt.get(col.id) || appStartedAt);
      if (since < limit) continue;
      // 何度も繰り返さない
      if (now - (lastStaleReload.get(col.id) || 0) < limit) continue;

      lastStaleReload.set(col.id, now);
      lastFreshAt.set(col.id, now);
      console.log('[main] %d 分更新が無いので読み込み直します: %s', minutes, col.id);
      columns.reload(col.id);
    }
  }, 60000);
}

function stopStaleWatch() {
  if (stalePoll) clearInterval(stalePoll);
  stalePoll = null;
}

function stopFullscreenWatch() {
  if (fullscreenPoll) clearInterval(fullscreenPoll);
  fullscreenPoll = null;
}

/* ------------------------------------------------------------------ *
 * 表示 / 非表示
 * ------------------------------------------------------------------ */

function showDock({ focus = true } = {}) {
  if (!alive()) return;
  clearTimeout(hideTimer);
  hideTimer = null;
  if (strip && !strip.isDestroyed()) strip.hide();
  if (win.isMinimized()) win.restore();
  applyGeometry();
  if (focus) win.show();
  else win.showInactive();
}

/**
 * @param {boolean} releaseSpace 予約した作業領域も返すかどうか。
 *   ユーザーが明示的に隠したときは返す（画面に無駄な余白を残さないため）。
 *   マウスが離れた一時的な引っ込みや全画面アプリ中は、返すと他ウインドウが
 *   その都度リサイズされて煩わしいので保持したままにする。
 */
function hideDock({ releaseSpace = true } = {}) {
  if (!alive()) return;
  clearTimeout(hideTimer);
  hideTimer = null;
  win.hide();
  if (releaseSpace) removeAppBar();
  if (state().autoHide && strip && !strip.isDestroyed()) {
    strip.setBounds(stripBounds());
    strip.showInactive();
  }
}

function toggleDock() {
  if (!alive()) return;
  if (win.isVisible() && !win.isMinimized()) hideDock();
  else showDock();
}

/** ウインドウに触ってよい状態か。破棄済みに触ると例外で主プロセスが落ちる。 */
function alive() {
  return !quitting && !!win && !win.isDestroyed();
}

// ディスプレイの抜き差しで Windows がウインドウを最小化することがある。
// 表示しているつもりのときは戻し、位置も取り直す。
//
// 終了時に AppBar を解除すると作業領域が変わり、Windows がこの通知を出す。
// つまりウインドウを壊したあとにも届くので、必ず生死を確かめてから触る。
function handleDisplayChange() {
  if (!alive()) return;
  if (win.isVisible() && win.isMinimized()) win.restore();
  applyGeometry();
}

/** 終了時と再起動時に、遅れて届く通知を止める。 */
function stopDisplayWatch() {
  screen.removeListener('display-metrics-changed', handleDisplayChange);
  screen.removeListener('display-added', handleDisplayChange);
  screen.removeListener('display-removed', handleDisplayChange);
}

function pointInBounds(pt, b, pad = 0) {
  return pt.x >= b.x - pad && pt.x < b.x + b.width + pad && pt.y >= b.y - pad && pt.y < b.y + b.height + pad;
}

// マウスが乗っているかどうかは WebContentsView をまたぐため、DOM イベントでは
// 取りこぼす。メインプロセスでカーソル位置を監視するのが確実。
function startCursorWatch() {
  stopCursorWatch();
  cursorPoll = setInterval(() => {
    if (!alive() || !state().autoHide || fullscreenNow) return;
    const pt = screen.getCursorScreenPoint();

    if (win.isVisible()) {
      const inside = pointInBounds(pt, win.getBounds());
      if (inside || win.isFocused()) {
        clearTimeout(hideTimer);
        hideTimer = null;
      } else if (!hideTimer) {
        hideTimer = setTimeout(() => hideDock({ releaseSpace: false }), state().hideDelayMs);
      }
    } else if (!hiddenByFullscreen && pointInBounds(pt, stripBounds(), 1)) {
      showDock({ focus: false });
    }
  }, 200);
}

function stopCursorWatch() {
  if (cursorPoll) clearInterval(cursorPoll);
  cursorPoll = null;
  clearTimeout(hideTimer);
  hideTimer = null;
}

function applyAutoHide() {
  if (state().autoHide) {
    ensureStrip();
    startCursorWatch();
    if (alive() && !win.isVisible() && !hiddenByFullscreen) {
      strip.setBounds(stripBounds());
      strip.showInactive();
    }
  } else {
    stopCursorWatch();
    if (strip && !strip.isDestroyed()) strip.hide();
    if (alive() && !win.isVisible() && !hiddenByFullscreen) showDock();
  }
}

function ensureStrip() {
  if (strip && !strip.isDestroyed()) return strip;
  strip = new BrowserWindow({
    ...stripBounds(),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { sandbox: true },
  });
  strip.setAlwaysOnTop(true, 'screen-saver');
  strip.loadFile(path.join(__dirname, '..', 'renderer', 'strip.html'));
  strip.on('closed', () => {
    strip = null;
  });
  return strip;
}

/* ------------------------------------------------------------------ *
 * ウインドウ
 * ------------------------------------------------------------------ */

function createWindow() {
  const bounds = dockBounds(currentDisplay());
  win = new BaseWindow({
    ...bounds,
    minWidth: 200,
    frame: false,
    show: false,
    skipTaskbar: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0f1114',
    title: 'すみっこパネル',
  });

  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  chromeView.setBackgroundColor('#0f1114');
  win.contentView.addChildView(chromeView); // 最初に追加＝カラムより下のレイヤー
  fitChrome();

  columns = new ColumnManager(win, chromeWebContents);

  // UI 側のエラーはそのままでは見えないので、メインプロセスのログへ流す。
  chromeView.webContents.on('console-message', (event) => {
    if (event.level !== 'error' && event.level !== 'warning') return;
    console.log('[ui]', event.level, event.message, '@', `${event.sourceId}:${event.lineNumber}`);
  });

  chromeView.webContents.on('did-finish-load', () => {
    broadcastState();
    columns.sync(state().columns);
  });
  chromeView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  chromeView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.on('resize', fitChrome);
  win.on('resized', () => {
    if (!alive() || isSnapping()) return;
    const b = win.getBounds();
    store.patch({ width: b.width });
    applyGeometry();
    broadcastState();
  });
  // 別のディスプレイへドラッグしたら、そこを表示先として覚えて端に吸着し直す。
  win.on('moved', () => {
    if (!alive() || isSnapping()) return;
    const dropped = screen.getDisplayMatching(win.getBounds());
    store.patch({ displayId: dropped.id });
    applyGeometry(dropped);
    broadcastState();
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hideDock();
  });

  if (process.env.TLDOCK_DEBUG) {
    for (const ev of ['show', 'hide', 'minimize', 'restore', 'blur', 'focus', 'moved', 'resized']) {
      win.on(ev, () => {
        if (!alive()) return;
        console.log('[debug]', ev, JSON.stringify(win.getBounds()), 'min=' + win.isMinimized(), 'vis=' + win.isVisible());
      });
    }
  }

  win.setAlwaysOnTop(state().alwaysOnTop, 'floating');
  if (startHidden) hideDock();
  else win.show();
}

function fitChrome() {
  if (!alive() || !chromeView) return;
  const { width, height } = win.getContentBounds();
  chromeView.setBounds({ x: 0, y: 0, width, height });
}

/* ------------------------------------------------------------------ *
 * トレイ / ショートカット
 * ------------------------------------------------------------------ */

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('すみっこパネル');
  tray.on('click', toggleDock);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const s = state();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '表示 / 非表示', click: toggleDock },
      ...(updater.get().status === 'ready'
        ? [
            { type: 'separator' },
            {
              label: `新しい版 ${updater.get().newVersion || ''} を適用して再起動`,
              click: () => updater.installNow(),
            },
          ]
        : []),
      { type: 'separator' },
      {
        label: '画面の領域を予約する（他ウインドウが避ける）',
        type: 'checkbox',
        checked: s.reserveSpace,
        click: (item) => updateState({ reserveSpace: item.checked }),
      },
      {
        label: '全画面アプリ中は隠す',
        type: 'checkbox',
        checked: s.hideOnFullscreen,
        click: (item) => updateState({ hideOnFullscreen: item.checked }),
      },
      {
        label: '常に最前面',
        type: 'checkbox',
        checked: s.alwaysOnTop,
        click: (item) => updateState({ alwaysOnTop: item.checked }),
      },
      {
        label: 'マウスが離れたら隠す',
        type: 'checkbox',
        checked: s.autoHide,
        click: (item) => updateState({ autoHide: item.checked }),
      },
      {
        label: '新着で音を鳴らす',
        type: 'checkbox',
        checked: s.sound.enabled,
        click: (item) => updateState({ sound: { ...s.sound, enabled: item.checked } }),
      },
      {
        label: 'Windows の起動時に開始',
        type: 'checkbox',
        checked: s.launchAtLogin,
        click: (item) => updateState({ launchAtLogin: item.checked }),
      },
      { type: 'separator' },
      { label: '左端に配置', type: 'radio', checked: s.edge === 'left', click: () => updateState({ edge: 'left' }) },
      { label: '右端に配置', type: 'radio', checked: s.edge === 'right', click: () => updateState({ edge: 'right' }) },
      { type: 'separator' },
      {
        label: '設定を開く',
        click: () => {
          showDock();
          sendToUi('ui:openSettings');
        },
      },
      { label: '設定ファイルの場所を開く', click: () => shell.showItemInFolder(store.configPath()) },
      { type: 'separator' },
      {
        label: '終了',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  const accel = state().toggleShortcut;
  if (!accel) return true;
  try {
    return globalShortcut.register(accel, toggleDock);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 状態更新
 * ------------------------------------------------------------------ */

// 保存先を変えたときなど、自分で自分を入れ替えるための再起動。
// app.exit() は before-quit を通らないので、後始末はここで自前で行う。
async function relaunchApp() {
  quitting = true;
  stopDisplayWatch();
  stopCursorWatch();
  stopFullscreenWatch();
  stopStaleWatch();
  globalShortcut.unregisterAll();
  try {
    await removeAppBar();
  } catch {
    // ヘルパーが死んでいても、stdin が閉じれば向こうで解除される
  }
  win32.stop();
  if (columns) columns.destroyAll();
  app.relaunch();
  app.exit(0);
}

function applyLaunchAtLogin(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ['--hidden'] });
  } catch (err) {
    console.error('[main] 自動起動の設定に失敗:', err);
  }
}

function updateState(partial) {
  const before = state();
  const next = store.patch(partial);

  if (before.alwaysOnTop !== next.alwaysOnTop && win) {
    win.setAlwaysOnTop(next.alwaysOnTop, 'floating');
  }
  if (['edge', 'width', 'displayId', 'reserveSpace'].some((k) => before[k] !== next[k])) {
    applyGeometry();
  }
  if (before.autoHide !== next.autoHide) applyAutoHide();
  if (before.toggleShortcut !== next.toggleShortcut) registerShortcut();
  if (before.launchAtLogin !== next.launchAtLogin) applyLaunchAtLogin(next.launchAtLogin);
  if (partial.columns && columns) columns.sync(next.columns);

  refreshTrayMenu();
  broadcastState();
  return next;
}

/* ------------------------------------------------------------------ *
 * カラムからの通知（新着 / ログイン状態）
 * ------------------------------------------------------------------ */

// 自動ログインの途中経過を、設定パネルのログ欄へ流す。
function loginStep(service, message) {
  sendToUi('login:step', { service, message });
  if (process.env.TLDOCK_DEBUG) console.log('[debug] login-step', service, message);
}

function handleNewPost(event, payload) {
  if (!columns) return;
  const found = columns.findByWebContents(event.sender);
  if (!found || !found.col.watch) return;
  lastFreshAt.set(found.id, Date.now());
  if (process.env.TLDOCK_DEBUG) console.log('[debug] new-post', found.id, JSON.stringify(payload));
  sendToUi('notify:new-post', { id: found.id, count: Math.max(1, Number(payload?.count) || 1) });
}

function handleAuthState(event, payload) {
  if (!columns) return;
  const found = columns.findByWebContents(event.sender);
  if (!found) return;

  const service = found.col.service;
  const loggedOut = !!payload?.loggedOut;
  if (process.env.TLDOCK_DEBUG) console.log('[debug] auth-state', found.id, JSON.stringify(payload));
  columns.status(found.id, { loggedOut });

  // 同じ状態を何度も報告してくるので、変化したときだけログに出す。
  if (lastAuthState.get(found.id) !== loggedOut) {
    lastAuthState.set(found.id, loggedOut);
    if (!loggedOut) loginStep(service, 'ログイン済みです。');
  }
  if (!loggedOut) return;

  // 送信はしない。空欄に入れるだけ（パスワードマネージャと同じ振る舞い）。
  // 機能が無効な配布版では credentials 自体を読み込んでいないので何もしない。
  if (!features.credentials || !credentials || !state().autoFill) return;

  const creds = credentials.get(service);
  if (creds) {
    columns.send(found.id, 'col:autofill', creds);
    return;
  }

  // 「未保存」と「保存済みだが復号できない」は対処が違うので区別して伝える。
  if (!filledNotified.has(service)) {
    filledNotified.add(service);
    loginStep(
      service,
      credentials.status(service) === 'undecryptable'
        ? '保存されたパスワードを復号できませんでした。設定から入力し直してください。'
        : 'ログイン情報が保存されていません。'
    );
  }
}

// ページ内から「新着が待っている」と知らせが来たら、実際のキー入力を送る。
// 合成イベントでは X が反応しないため、送信はメインプロセスからしか行えない。
function handleLiveReady(event, payload) {
  if (!columns) return;
  const found = columns.findByWebContents(event.sender);
  if (!found || !found.col.live) return;

  const now = Date.now();
  const info = livePress.get(found.id) || { at: 0, top: null, misses: 0 };

  // X のピルは新着が無くても出たままのことがある。そのまま一定間隔で押し続けると
  // 意味のないキーを送り続けることになるので、空振りが続いたら間隔を延ばす。
  const base = state().liveMinIntervalMs;
  const wait = Math.min(base * Math.pow(2, info.misses), LIVE_MAX_INTERVAL_MS);
  if (now - info.at < wait) return;

  // 前回押したあと先頭が変わったか＝効いたかどうか
  if (info.at > 0) {
    const worked = payload?.top && payload.top !== info.top;
    info.misses = worked ? 0 : Math.min(info.misses + 1, LIVE_MAX_MISSES);
  }

  info.at = now;
  info.top = payload?.top || null;
  livePress.set(found.id, info);

  columns.sendKey(found.id, String(payload?.key || '.'));
  if (process.env.TLDOCK_DEBUG) {
    console.log('[debug] live-press %s 次は %d 秒後 (空振り %d 回)',
      found.id, Math.round(Math.min(base * Math.pow(2, info.misses), LIVE_MAX_INTERVAL_MS) / 1000), info.misses);
  }
}

/* ------------------------------------------------------------------ *
 * 自動更新
 * ------------------------------------------------------------------ */

function onUpdateState(st) {
  sendToUi('update:state', st);
  refreshTrayMenu(); // 「今すぐ再起動して更新」の出し入れ
  if (process.env.TLDOCK_DEBUG) console.log('[debug] update', st.status, st.message);
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('features:get', () => ({ credentials: features.credentials }));
  ipcMain.handle('update:get', () => updater.get());
  ipcMain.handle('update:check', () => {
    updater.check();
    return updater.get();
  });
  ipcMain.handle('update:install', () => updater.installNow());
  ipcMain.handle('services:list', () => services.list());
  ipcMain.handle('state:get', () => state());
  ipcMain.handle('state:patch', (_e, partial) => updateState(partial || {}));

  ipcMain.handle('displays:get', () => {
    const primaryId = screen.getPrimaryDisplay().id;
    const active = currentDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      index: i + 1,
      label: `${d.size.width}×${d.size.height}`,
      isPrimary: d.id === primaryId,
      isActive: d.id === active,
    }));
  });

  ipcMain.handle('datadir:get', () => ({
    dir: app.getPath('userData'),
    defaultDir: dataLocation.defaultDir(),
    isDefault: dataInfo.isDefault,
    movedFrom: dataInfo.moved,
    error: dataInfo.error,
    pointer: dataLocation.pointerPath(),
  }));

  ipcMain.handle('datadir:choose', async () => {
    const result = await dialog.showOpenDialog({
      title: 'データの保存先を選ぶ',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: app.getPath('userData'),
    });
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
  });

  ipcMain.handle('datadir:set', (_e, { target, move }) => {
    const result = dataLocation.scheduleChange(target, app.getPath('userData'), !!move);
    if (result.ok) setTimeout(relaunchApp, 300); // 応答を返してから再起動する
    return result;
  });

  // 認証情報の口は、機能が有効なときだけ開ける。
  // 無効な配布版では handler 自体が存在せず、UI からも呼べない。
  if (features.credentials && credentials) {
    ipcMain.handle('credentials:list', () => credentials.list());
    ipcMain.handle('credentials:set', (_e, { service, username, password }) => {
      const result = credentials.set(service, username, password);
      if (result.ok) filledNotified.delete(service);
      return result;
    });
    ipcMain.handle('credentials:clear', (_e, service) => {
      filledNotified.delete(service);
      return credentials.clear(service);
    });
  }

  ipcMain.on('layout:set', (_e, rects) => {
    if (columns && Array.isArray(rects)) columns.applyRects(rects);
  });

  ipcMain.on('col:action', (_e, { id, action }) => {
    if (!columns) return;
    switch (action) {
      case 'reload': columns.reload(id); break;
      case 'home': columns.goHome(id); break;
      case 'back': columns.goBack(id); break;
      case 'top': columns.scrollTop(id); break;
      case 'devtools': columns.openDevTools(id); break;
      case 'external': columns.openExternal(id); break;
      default: break;
    }
  });

  ipcMain.on('dock:action', (_e, action) => {
    switch (action) {
      case 'hide': hideDock(); break;
      case 'quit': quitting = true; app.quit(); break;
      case 'openStyles': shell.openPath(path.join(app.getPath('userData'), 'styles')); break;
      case 'openConfig': shell.showItemInFolder(store.configPath()); break;
      default: break;
    }
  });

  ipcMain.handle('session:clear', async (_e, service) => {
    if (columns) await columns.clearSession(service);
    filledNotified.delete(service);
    return true;
  });

  ipcMain.handle('shortcut:test', (_e, accel) => {
    globalShortcut.unregisterAll();
    let ok = false;
    try {
      ok = globalShortcut.register(accel, toggleDock);
    } catch {
      ok = false;
    }
    if (!ok) registerShortcut();
    return ok;
  });

  // カラムのページ（column-preload.js）から届くもの
  ipcMain.on('col:new-post', handleNewPost);
  ipcMain.on('col:auth-state', handleAuthState);
  ipcMain.on('col:live-ready', handleLiveReady);
  ipcMain.on('col:autofill-done', (event, payload) => {
    if (!columns) return;
    const found = columns.findByWebContents(event.sender);
    if (found) loginStep(found.col.service, String(payload?.message || ''));
  });
}

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showDock());

  app.whenReady().then(() => {
    registerIpc();

    win32.on('ready', () => {
      applyGeometry();
      startFullscreenWatch();
    });
    win32.start();

    createWindow();
    buildTray();
    applyAutoHide();
    applyLaunchAtLogin(state().launchAtLogin);
    services.seed();
    startStaleWatch();
    updater.start(onUpdateState);

    // 読み込み時に補われた既定値（新項目や移行結果）をファイルにも書き戻す。
    // これをしないと、設定ファイルの中身と実際の動作が食い違って混乱のもとになる。
    store.patch({});

    if (!registerShortcut()) {
      console.warn('[main] グローバルショートカットを登録できませんでした:', state().toggleShortcut);
    }

    // 起動直後は画面情報が確定しておらず、別モニタの座標が返ってくることがある。
    // 少し待ってからもう一度吸着させて、正しい位置に落ち着かせる。
    setTimeout(() => {
      applyGeometry();
      const d = currentDisplay();
      console.log('[main] 表示先ディスプレイ id=%s workArea=%o scale=%s', d.id, d.workArea, d.scaleFactor);
    }, 900);

    screen.on('display-metrics-changed', handleDisplayChange);
    screen.on('display-added', handleDisplayChange);
    screen.on('display-removed', handleDisplayChange);

    app.on('activate', () => {
      if (!win) createWindow();
      else showDock();
    });
  });

  // 予約した作業領域は必ず返してから終わる。返し損ねると画面が狭いままになる。
  app.on('before-quit', (e) => {
    quitting = true;
    stopDisplayWatch();
    stopCursorWatch();
    stopFullscreenWatch();
    stopStaleWatch();
    updater.stop();
    globalShortcut.unregisterAll();

    if (appbarActive && win32.available) {
      e.preventDefault();
      removeAppBar().finally(() => {
        win32.stop();
        if (columns) columns.destroyAll();
        app.exit(0);
      });
      return;
    }

    win32.stop();
    if (columns) columns.destroyAll();
  });

  // トレイ常駐アプリなので、ウインドウが無くなっても勝手に終了しない。
  // 終了はトレイの「終了」か設定パネルからだけにする。
  // （ディスプレイの抜き差しなどでウインドウが失われたときに、
  //   黙って落ちてしまうのを防ぐ。）
  let lastRecreate = 0;
  app.on('window-all-closed', () => {
    if (quitting) return;
    console.warn('[main] ウインドウが失われました。トレイに常駐したまま復帰させます。');
    // 再生成した端から壊れる状況で無限ループしないよう、間隔を空ける。
    if (Date.now() - lastRecreate < 10000) {
      console.error('[main] 復帰を繰り返しています。これ以上は再生成しません。');
      return;
    }
    lastRecreate = Date.now();
    if (!win || win.isDestroyed()) createWindow();
  });
}
