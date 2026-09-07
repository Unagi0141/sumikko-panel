/* Timeline Dock の UI レイヤー。
 *
 * 実際のタイムラインはメインプロセス側の WebContentsView が描画するので、
 * ここが担うのは (1) ヘッダーなどの枠 (2) 各カラムの表示位置の計算
 * (3) 設定画面 (4) 新着のバッジと通知音。
 * (2) はこのレンダラーが唯一の情報源で、計算した矩形をメインへ送って
 * ネイティブビューを重ねてもらう。 */

// サービス定義はメインから受け取る（services.json 由来）。
// ここに書き足さなくても、JSON にサービスを増やせば選択肢に出る。
let SERVICES = [];
const serviceLabel = (id) => (SERVICES.find((s) => s.id === id) || {}).label || id;
const serviceHome = (id) => (SERVICES.find((s) => s.id === id) || {}).home || 'https://example.com/';
let FEATURES = { credentials: false };
const MIN_COL_SIZE = 100;

let state = null;
const statuses = new Map(); // id -> { loading, error, login, loggedOut }
const unread = new Map();   // id -> 未読件数
let editorSignature = '';
let credentialInfo = { available: false, entries: {} };
let layoutQueued = false;
let lastSoundAt = 0;

const el = {
  columns: document.getElementById('columns'),
  settings: document.getElementById('settings'),
  columnEditor: document.getElementById('column-editor'),
  credentialEditor: document.getElementById('credential-editor'),
  credentialsNote: document.getElementById('credentials-note'),
};

const isRow = () => !state || state.layout === 'row';

/* ------------------------------------------------------------------ *
 * レイアウト送出
 * ------------------------------------------------------------------ */

function pushLayout() {
  layoutQueued = false;
  if (!state) return;

  // 設定パネルを開いている間はネイティブビューを全部引っ込める。
  if (!el.settings.hidden) {
    window.dock.setLayout([]);
    return;
  }

  const rects = [];
  for (const col of state.columns) {
    const body = el.columns.querySelector(`.col-body[data-id="${cssEscape(col.id)}"]`);
    if (!body || col.collapsed) continue;
    const r = body.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    rects.push({ id: col.id, x: r.x, y: r.y, width: r.width, height: r.height });
  }
  window.dock.setLayout(rects);
}

function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(pushLayout);
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '_');
}

/* ------------------------------------------------------------------ *
 * 通知音
 * ------------------------------------------------------------------ */

let audioCtx = null;

function playChime(volume) {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const t = audioCtx.currentTime;
    const gain = audioCtx.createGain();
    gain.connect(audioCtx.destination);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(volume, 0.0001), t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);

    // 短い 2 音。長く尾を引かせないことで、常駐していても邪魔にならないようにする。
    for (const [freq, delay] of [[988, 0], [1319, 0.085]]) {
      const osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + delay);
      osc.connect(gain);
      osc.start(t + delay);
      osc.stop(t + delay + 0.3);
    }
  } catch {
    // 音が出せない環境でも動作は続ける
  }
}

function notifyNewPost({ id, count }) {
  unread.set(id, (unread.get(id) || 0) + count);
  applyStatuses();

  if (!state || !state.sound.enabled) return;
  const now = Date.now();
  if (now - lastSoundAt < state.sound.minIntervalMs) return;
  lastSoundAt = now;
  playChime(state.sound.volume);
}

/* ------------------------------------------------------------------ *
 * カラムの描画
 * ------------------------------------------------------------------ */

function renderColumns() {
  document.body.classList.toggle('layout-row', isRow());
  document.body.classList.toggle('layout-column', !isRow());
  document.body.classList.toggle('compact', !!state.compact);

  el.columns.replaceChildren();
  state.columns.forEach((col, index) => {
    if (index > 0) el.columns.appendChild(makeSplitter(index));
    el.columns.appendChild(makeColumn(col));
  });

  applyStatuses();
  scheduleLayout();
}

function makeColumn(col) {
  const section = document.createElement('section');
  section.className = 'col' + (col.collapsed ? ' collapsed' : '');
  section.dataset.id = col.id;
  section.style.flex = col.collapsed ? '' : `${col.flex} 1 0`;

  const head = document.createElement('header');
  head.className = 'col-head';

  const collapse = iconButton(col.collapsed ? '▸' : '▾', col.collapsed ? '展開' : '折りたたむ', () =>
    patchColumn(col.id, { collapsed: !col.collapsed })
  );

  const title = document.createElement('div');
  title.className = 'col-title';
  title.textContent = col.title;
  title.title = 'クリックで先頭までスクロール（未読もクリアします）';
  title.addEventListener('click', () => {
    window.dock.columnAction(col.id, 'top');
    unread.set(col.id, 0);
    applyStatuses();
  });

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.hidden = true;
  badge.title = 'クリックで未読をクリア';
  badge.addEventListener('click', () => {
    unread.set(col.id, 0);
    applyStatuses();
  });

  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'col-actions';
  actions.append(
    iconButton('‹', '戻る', () => window.dock.columnAction(col.id, 'back')),
    iconButton('⌂', 'このカラムのホームへ', () => window.dock.columnAction(col.id, 'home')),
    iconButton('⟳', '再読み込み（CSSの変更もここで反映）', () => window.dock.columnAction(col.id, 'reload')),
    iconButton('↗', 'ブラウザで開く', () => window.dock.columnAction(col.id, 'external'))
  );

  head.append(collapse, title, badge, spinner, actions);

  const body = document.createElement('div');
  body.className = 'col-body';
  body.dataset.id = col.id;

  section.append(head, body);
  return section;
}

function iconButton(label, tooltip, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.textContent = label;
  b.title = tooltip;
  b.addEventListener('click', onClick);
  return b;
}

function makeSplitter(index) {
  const s = document.createElement('div');
  s.className = 'splitter';
  s.dataset.index = String(index); // index 番目のカラムと、その 1 つ前の境界
  s.addEventListener('pointerdown', startSplitterDrag);
  return s;
}

/* ------------------------------------------------------------------ *
 * 仕切りのドラッグ（横並び / 縦積みのどちらでも同じ計算）
 * ------------------------------------------------------------------ */

function startSplitterDrag(event) {
  const index = Number(event.currentTarget.dataset.index);
  const first = state.columns[index - 1];
  const second = state.columns[index];
  if (!first || !second || first.collapsed || second.collapsed) return;

  const firstEl = el.columns.querySelector(`.col[data-id="${cssEscape(first.id)}"]`);
  const secondEl = el.columns.querySelector(`.col[data-id="${cssEscape(second.id)}"]`);
  if (!firstEl || !secondEl) return;

  const row = isRow();
  const startPos = row ? event.clientX : event.clientY;
  const size = (node) => {
    const r = node.getBoundingClientRect();
    return row ? r.width : r.height;
  };

  const s0 = size(firstEl);
  const s1 = size(secondEl);
  const flexTotal = first.flex + second.flex;
  const pxToFlex = flexTotal / (s0 + s1);

  event.currentTarget.setPointerCapture(event.pointerId);
  document.body.classList.add(row ? 'resizing-row' : 'resizing-column');

  let nextFirst = first.flex;
  let nextSecond = second.flex;

  const onMove = (e) => {
    const delta = (row ? e.clientX : e.clientY) - startPos;
    const newFirst = Math.min(Math.max(s0 + delta, MIN_COL_SIZE), s0 + s1 - MIN_COL_SIZE);
    nextFirst = Math.max(0.15, newFirst * pxToFlex);
    nextSecond = Math.max(0.15, flexTotal - nextFirst);
    firstEl.style.flex = `${nextFirst} 1 0`;
    secondEl.style.flex = `${nextSecond} 1 0`;
    scheduleLayout();
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.body.classList.remove('resizing-row', 'resizing-column');
    first.flex = nextFirst;
    second.flex = nextSecond;
    saveColumns();
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/* ------------------------------------------------------------------ *
 * 状態の更新
 * ------------------------------------------------------------------ */

async function saveColumns() {
  state = await window.dock.patchState({ columns: state.columns });
}

function patchColumn(id, partial) {
  const col = state.columns.find((c) => c.id === id);
  if (!col) return;
  Object.assign(col, partial);
  saveColumns().then(() => {
    renderColumns();
    renderSettings();
  });
}

function applyStatuses() {
  for (const col of state.columns) {
    const section = el.columns.querySelector(`.col[data-id="${cssEscape(col.id)}"]`);
    if (!section) continue;

    const st = statuses.get(col.id) || {};
    const spinner = section.querySelector('.spinner');
    if (spinner) spinner.hidden = !st.loading;

    const badge = section.querySelector('.badge');
    const count = unread.get(col.id) || 0;
    if (badge) {
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? '99+' : String(count);
    }

    const title = section.querySelector('.col-title');
    if (title) {
      const notes = [];
      if (st.error) notes.push(`読み込みに失敗しました: ${st.error}`);
      if (st.login === 'trying') notes.push('自動ログインを試しています…');
      if (st.login === 'stopped' && st.loginNote) notes.push(`自動ログイン中断: ${st.loginNote}`);
      else if (st.loggedOut) notes.push('ログアウト状態です');
      title.title = notes.length ? notes.join(' / ') : 'クリックで先頭までスクロール（未読もクリアします）';
      title.textContent = (st.error ? '⚠ ' : st.loggedOut ? '· ' : '') + col.title;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 設定パネル
 * ------------------------------------------------------------------ */

const s = {
  display: document.getElementById('set-display'),
  edge: document.getElementById('set-edge'),
  layout: document.getElementById('set-layout'),
  width: document.getElementById('set-width'),
  widthOut: document.getElementById('set-width-out'),
  compact: document.getElementById('set-compact'),
  accent: document.getElementById('set-accent'),
  accentPresets: document.getElementById('accent-presets'),
  rainbow: document.getElementById('set-rainbow'),
  rainbowSpeed: document.getElementById('set-rainbow-speed'),
  rainbowSpeedOut: document.getElementById('set-rainbow-speed-out'),
  rainbowSpeedRow: document.getElementById('row-rainbow-speed'),
  rainbowWarn: document.getElementById('rainbow-warn'),
  reserve: document.getElementById('set-reserve'),
  fullscreen: document.getElementById('set-fullscreen'),
  onTop: document.getElementById('set-ontop'),
  autoHide: document.getElementById('set-autohide'),
  hideDelay: document.getElementById('set-hidedelay'),
  hideDelayOut: document.getElementById('set-hidedelay-out'),
  hideDelayRow: document.getElementById('row-hidedelay'),
  launch: document.getElementById('set-launch'),
  shortcut: document.getElementById('set-shortcut'),
  shortcutStatus: document.getElementById('shortcut-status'),
  sound: document.getElementById('set-sound'),
  volume: document.getElementById('set-volume'),
  volumeOut: document.getElementById('set-volume-out'),
  soundInterval: document.getElementById('set-sound-interval'),
  soundIntervalOut: document.getElementById('set-sound-interval-out'),
  autoFill: document.getElementById('set-autofill'),
  liveInterval: document.getElementById('set-live-interval'),
  liveIntervalOut: document.getElementById('set-live-interval-out'),
  stale: document.getElementById('set-stale'),
  staleOut: document.getElementById('set-stale-out'),
};

async function renderDisplays() {
  const displays = await window.dock.getDisplays();
  s.display.replaceChildren();

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '主ディスプレイ（既定）';
  s.display.appendChild(auto);

  for (const d of displays) {
    const opt = document.createElement('option');
    opt.value = String(d.id);
    opt.textContent = `${d.index}: ${d.label}${d.isPrimary ? '（メイン）' : ''}${d.isActive ? ' ←表示中' : ''}`;
    s.display.appendChild(opt);
  }
  s.display.value = state.displayId === null ? '' : String(state.displayId);
}

// よく使いそうな色を並べておく。色の選択画面を開かずに済ませるため。
const ACCENT_PRESETS = [
  ['#60a5fa', '青'],
  ['#4ade80', '緑'],
  ['#f472b6', '桃'],
  ['#fb923c', '橙'],
  ['#a78bfa', '紫'],
  ['#e2e8f0', '白'],
];

/** テーマを画面に当てる。虹色のときは CSS のアニメーションに任せる。 */
function applyTheme(theme) {
  const t = theme || {};
  const root = document.documentElement;
  const rainbow = t.mode === 'rainbow';

  root.classList.toggle('rainbow', rainbow);
  root.style.setProperty('--rainbow-sec', (Number(t.speedSec) || 8) + 's');

  // 虹色のときに直接指定を残すと、どちらが勝つか読みにくい。外しておく。
  if (rainbow) root.style.removeProperty('--accent');
  else root.style.setProperty('--accent', t.accent || '#60a5fa');
}

function renderAccentPresets() {
  if (s.accentPresets.childElementCount) return;
  for (const [color, label] of ACCENT_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.style.background = color;
    b.addEventListener('click', () => patchGlobal({ theme: { ...state.theme, accent: color } }));
    s.accentPresets.appendChild(b);
  }
}

function renderSettings() {
  if (!state) return;
  renderDisplays();
  renderAccentPresets();

  const theme = state.theme || {};
  const rainbow = theme.mode === 'rainbow';
  s.accent.value = theme.accent || '#60a5fa';
  s.accent.disabled = rainbow;
  s.rainbow.checked = rainbow;
  s.rainbowSpeed.value = String(theme.speedSec || 8);
  s.rainbowSpeedOut.textContent = `${theme.speedSec || 8} 秒`;
  s.rainbowSpeedRow.hidden = !rainbow;
  s.rainbowWarn.textContent = rainbow
    ? '色が変わり続けるあいだ、画面を塗り直し続けます。実測で CPU 1 コアの 5% ほどを使い続けます（単色なら 0.5%）。常駐アプリなので、ノート PC を電池で使うときは切っておくのが無難です。'
    : '';
  applyTheme(theme);

  s.edge.value = state.edge;
  s.layout.value = state.layout;
  s.width.value = String(state.width);
  s.widthOut.textContent = `${state.width} px`;
  s.compact.checked = state.compact;
  s.reserve.checked = state.reserveSpace;
  s.fullscreen.checked = state.hideOnFullscreen;
  s.onTop.checked = state.alwaysOnTop;
  s.autoHide.checked = state.autoHide;
  s.hideDelay.value = String(state.hideDelayMs);
  s.hideDelayOut.textContent = `${(state.hideDelayMs / 1000).toFixed(1)} 秒`;
  s.hideDelayRow.style.opacity = state.autoHide ? '1' : '0.45';
  s.launch.checked = state.launchAtLogin;
  if (document.activeElement !== s.shortcut) s.shortcut.value = state.toggleShortcut;

  s.sound.checked = state.sound.enabled;
  s.volume.value = String(Math.round(state.sound.volume * 100));
  s.volumeOut.textContent = `${Math.round(state.sound.volume * 100)}%`;
  s.soundInterval.value = String(state.sound.minIntervalMs);
  s.soundIntervalOut.textContent = `${(state.sound.minIntervalMs / 1000).toFixed(1)} 秒`;
  s.autoFill.checked = state.autoFill;
  s.liveInterval.value = String(state.liveMinIntervalMs);
  s.liveIntervalOut.textContent = `${(state.liveMinIntervalMs / 1000).toFixed(0)} 秒`;
  s.stale.value = String(state.staleReloadMin);
  s.staleOut.textContent = state.staleReloadMin === 0 ? '無効' : `${state.staleReloadMin} 分`;

  const soundBtn = document.getElementById('btn-sound');
  soundBtn.classList.toggle('off', !state.sound.enabled);

  const signature = state.columns.map((c) => `${c.id}:${c.service}`).join('|');
  if (signature !== editorSignature) {
    editorSignature = signature;
    renderColumnEditor();
    renderCredentialEditor();
  } else {
    for (const col of state.columns) {
      const item = el.columnEditor.querySelector(`.card[data-id="${cssEscape(col.id)}"]`);
      if (!item) continue;
      const zoom = item.querySelector('.zoom');
      if (zoom && document.activeElement !== zoom) zoom.value = String(Math.round(col.zoom * 100));
      const watch = item.querySelector('.watch');
      if (watch) watch.checked = col.watch;
      const textScale = item.querySelector('.textscale');
      if (textScale && document.activeElement !== textScale) textScale.value = String(Math.round(col.textScale * 100));
      const media = item.querySelector('.collapse-media');
      if (media) media.checked = col.collapseMedia;
      const live = item.querySelector('.live');
      if (live) live.checked = col.live;
    }
  }
}

function renderColumnEditor() {
  el.columnEditor.replaceChildren();

  state.columns.forEach((col, index) => {
    const item = document.createElement('div');
    item.className = 'card';
    item.dataset.id = col.id;

    const top = document.createElement('div');
    top.className = 'top';

    const title = document.createElement('input');
    title.type = 'text';
    title.value = col.title;
    title.placeholder = 'カラム名';
    title.addEventListener('change', () =>
      patchColumn(col.id, { title: title.value.trim() || serviceLabel(col.service) })
    );

    top.append(
      title,
      iconButton(isRow() ? '←' : '↑', '前へ', () => moveColumn(index, -1)),
      iconButton(isRow() ? '→' : '↓', '次へ', () => moveColumn(index, 1)),
      iconButton('✕', 'このカラムを削除', () => removeColumn(col.id))
    );

    const url = document.createElement('input');
    url.type = 'text';
    url.className = 'url';
    url.value = col.url;
    url.spellcheck = false;
    url.placeholder = 'URL';
    url.addEventListener('change', () => {
      const next = normalizeUrl(url.value, col.service);
      url.value = next;
      patchColumn(col.id, { url: next });
    });

    const meta = document.createElement('div');
    meta.className = 'meta';

    const service = document.createElement('span');
    service.className = 'service';
    service.textContent = serviceLabel(col.service);

    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'service';
    zoomLabel.textContent = '倍率';

    const zoom = document.createElement('input');
    zoom.type = 'number';
    zoom.className = 'zoom';
    zoom.min = '30';
    zoom.max = '200';
    zoom.step = '5';
    zoom.style.width = '56px';
    zoom.value = String(Math.round(col.zoom * 100));
    zoom.addEventListener('change', () => {
      const pct = Math.min(Math.max(Number(zoom.value) || 100, 30), 200);
      zoom.value = String(pct);
      patchColumn(col.id, { zoom: pct / 100 });
    });

    const watchLabel = document.createElement('label');
    watchLabel.className = 'service';
    watchLabel.style.display = 'flex';
    watchLabel.style.alignItems = 'center';
    watchLabel.style.gap = '4px';
    const watch = document.createElement('input');
    watch.type = 'checkbox';
    watch.className = 'watch';
    watch.checked = col.watch;
    watch.addEventListener('change', () => patchColumn(col.id, { watch: watch.checked }));
    watchLabel.append(watch, document.createTextNode('新着音'));

    const devtools = document.createElement('button');
    devtools.className = 'text-btn';
    devtools.textContent = '開発者ツール';
    devtools.title = '注入する CSS や検知用セレクタを調べるときに使います';
    devtools.addEventListener('click', () => window.dock.columnAction(col.id, 'devtools'));

    const spacer = document.createElement('span');
    spacer.className = 'grow';

    // 文字倍率。zoom と違い、本文だけを拡大してレイアウトは動かさない。
    const textLabel = document.createElement('span');
    textLabel.className = 'service';
    textLabel.textContent = '文字';

    const textScale = document.createElement('input');
    textScale.type = 'number';
    textScale.className = 'textscale';
    textScale.min = '80';
    textScale.max = '250';
    textScale.step = '5';
    textScale.style.width = '56px';
    textScale.title = '本文だけを拡大します（余白や画像の大きさは変わりません）';
    textScale.value = String(Math.round(col.textScale * 100));
    textScale.addEventListener('change', () => {
      const pct = Math.min(Math.max(Number(textScale.value) || 100, 80), 250);
      textScale.value = String(pct);
      patchColumn(col.id, { textScale: pct / 100 });
    });

    const mediaLabel = document.createElement('label');
    mediaLabel.className = 'service';
    mediaLabel.style.display = 'flex';
    mediaLabel.style.alignItems = 'center';
    mediaLabel.style.gap = '4px';
    mediaLabel.title = '画像を低く畳んで場所を空けます。クリックで開けます。';
    const media = document.createElement('input');
    media.type = 'checkbox';
    media.className = 'collapse-media';
    media.checked = col.collapseMedia;
    media.addEventListener('change', () => patchColumn(col.id, { collapseMedia: media.checked }));
    mediaLabel.append(media, document.createTextNode('画像を畳む'));

    const liveLabel = document.createElement('label');
    liveLabel.className = 'service';
    liveLabel.style.display = 'flex';
    liveLabel.style.alignItems = 'center';
    liveLabel.style.gap = '4px';
    liveLabel.title = '先頭にいるとき、待機中の新着を自動で流し込みます。';
    const live = document.createElement('input');
    live.type = 'checkbox';
    live.className = 'live';
    live.checked = col.live;
    live.addEventListener('change', () => patchColumn(col.id, { live: live.checked }));
    liveLabel.append(live, document.createTextNode('流し込み'));

    meta.append(service, spacer, zoomLabel, zoom, textLabel, textScale, mediaLabel, watchLabel, liveLabel, devtools);
    item.append(top, url, meta);
    el.columnEditor.appendChild(item);
  });
}

/* ------------------------------------------------------------------ *
 * ログイン情報
 * ------------------------------------------------------------------ */

async function refreshCredentials() {
  if (!FEATURES.credentials) return;
  credentialInfo = await window.dock.listCredentials();
  el.credentialsNote.textContent = credentialInfo.available
    ? 'パスワードは Windows の資格情報保護（DPAPI）で暗号化して保存します。この PC のこの Windows ユーザーでのみ復号できます。'
    : 'この環境では OS による暗号化が使えないため、パスワードは保存できません。';
  el.credentialsNote.className = credentialInfo.available ? 'hint' : 'hint warn';
  renderCredentialEditor();
}

function renderCredentialEditor() {
  if (!state || !FEATURES.credentials) return;
  el.credentialEditor.replaceChildren();

  const services = [...new Set(state.columns.map((c) => c.service))];
  for (const service of services) {
    const entry = credentialInfo.entries?.[service] || { username: '', hasPassword: false };

    const card = document.createElement('div');
    card.className = 'card';

    const heading = document.createElement('div');
    heading.className = 'service';
    heading.style.marginBottom = '6px';
    heading.textContent = serviceLabel(service);

    const userField = document.createElement('label');
    userField.className = 'field';
    const userInput = document.createElement('input');
    userInput.type = 'text';
    userInput.spellcheck = false;
    userInput.value = entry.username;
    userInput.placeholder = 'ユーザー名 / メールアドレス';
    userField.append(labelSpan('ユーザー名'), userInput);

    const broken = entry.status === 'undecryptable';

    const passField = document.createElement('label');
    passField.className = 'field';
    const passInput = document.createElement('input');
    passInput.type = 'password';
    passInput.placeholder = broken
      ? '入力し直してください'
      : entry.hasPassword
        ? '保存済み（変更する場合のみ入力）'
        : 'パスワード';
    passField.append(labelSpan('パスワード'), passInput);

    // 「保存済みだが復号できない」を黙って放置すると、自動ログインが
    // 動かない理由が分からなくなる。ここではっきり出す。
    const warn = document.createElement('p');
    warn.className = 'hint warn';
    warn.textContent = '⚠ 保存されたパスワードを復号できません。入力し直してください。';
    warn.hidden = !broken;

    const row = document.createElement('div');
    row.className = 'button-row';

    const status = document.createElement('span');
    status.className = 'status';

    const save = document.createElement('button');
    save.className = 'text-btn';
    save.textContent = '保存';
    save.disabled = !credentialInfo.available;
    save.addEventListener('click', async () => {
      save.disabled = true;
      const result = await window.dock.setCredentials(service, userInput.value.trim(), passInput.value);
      save.disabled = false;
      status.textContent = result.ok ? '保存しました' : result.error;
      status.className = 'status ' + (result.ok ? 'ok' : 'ng');
      passInput.value = '';
      if (result.ok) await refreshCredentials();
    });

    const remove = document.createElement('button');
    remove.className = 'text-btn danger';
    remove.textContent = '削除';
    remove.disabled = !entry.username && !entry.hasPassword;
    remove.addEventListener('click', async () => {
      await window.dock.clearCredentials(service);
      await refreshCredentials();
    });

    row.append(save, remove, status);
    card.append(heading, userField, passField, warn, row);
    el.credentialEditor.appendChild(card);
  }
}

function labelSpan(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

/* ------------------------------------------------------------------ *
 * 自動ログインの経過ログ
 * ------------------------------------------------------------------ */

const loginLog = document.getElementById('login-log');
let logEmpty = true;

function appendLoginLog(service, message) {
  if (!message) return;
  if (logEmpty) {
    loginLog.replaceChildren();
    logEmpty = false;
  }
  const line = document.createElement('div');
  const time = document.createElement('span');
  time.className = 't';
  time.textContent = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  line.append(time, document.createTextNode(`[${serviceLabel(service)}] ${message}`));
  loginLog.appendChild(line);
  loginLog.scrollTop = loginLog.scrollHeight;

  while (loginLog.childElementCount > 200) loginLog.removeChild(loginLog.firstChild);
}

document.getElementById('btn-clear-log').addEventListener('click', () => {
  loginLog.replaceChildren(document.createTextNode('まだ何も試していません。'));
  logEmpty = true;
});

/* ------------------------------------------------------------------ *
 * データの保存先
 * ------------------------------------------------------------------ */

const dataDir = {
  current: document.getElementById('datadir-current'),
  note: document.getElementById('datadir-note'),
  move: document.getElementById('datadir-move'),
  choose: document.getElementById('btn-datadir-choose'),
  toDefault: document.getElementById('btn-datadir-default'),
};

let dataDirInfo = null;

async function refreshDataDir() {
  dataDirInfo = await window.dock.getDataDir();
  dataDir.current.value = dataDirInfo.dir;
  dataDir.toDefault.disabled = dataDirInfo.isDefault;

  const notes = [];
  if (dataDirInfo.isDefault) notes.push('既定の場所を使っています。');
  else notes.push('既定の場所: ' + dataDirInfo.defaultDir);
  if (dataDirInfo.movedFrom) notes.push('前回の起動で ' + dataDirInfo.movedFrom + ' から移動しました（元のフォルダは残してあります）。');
  if (dataDirInfo.error) notes.push('⚠ ' + dataDirInfo.error);
  notes.push('保存先を記録したファイル: ' + dataDirInfo.pointer);
  dataDir.note.textContent = notes.join(' ');
  dataDir.note.className = dataDirInfo.error ? 'hint warn' : 'hint';
}

async function changeDataDir(target) {
  if (!target) return;
  const result = await window.dock.setDataDir(target, dataDir.move.checked);
  if (!result.ok) {
    dataDir.note.textContent = '⚠ ' + result.error;
    dataDir.note.className = 'hint warn';
    return;
  }
  dataDir.note.textContent = '保存先を変更しました。再起動しています…';
  dataDir.note.className = 'hint';
}

dataDir.choose.addEventListener('click', async () => {
  const picked = await window.dock.chooseDataDir();
  if (picked) changeDataDir(picked);
});

dataDir.toDefault.addEventListener('click', () => {
  if (dataDirInfo) changeDataDir(dataDirInfo.defaultDir);
});

/* ------------------------------------------------------------------ *
 * カラムの追加・削除・並べ替え
 * ------------------------------------------------------------------ */

function normalizeUrl(value, service) {
  const raw = value.trim();
  if (!raw) return serviceHome(service);
  if (/^https?:\/\//i.test(raw)) return raw;
  return 'https://' + raw;
}

function rerenderAll() {
  renderColumns();
  renderSettings();
}

function moveColumn(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.columns.length) return;
  const [col] = state.columns.splice(index, 1);
  state.columns.splice(target, 0, col);
  editorSignature = '';
  saveColumns().then(rerenderAll);
}

function removeColumn(id) {
  if (state.columns.length <= 1) return;
  state.columns = state.columns.filter((c) => c.id !== id);
  editorSignature = '';
  saveColumns().then(rerenderAll);
}

function addColumn(service, url) {
  state.columns.push({
    id: `${service}-${Date.now().toString(36)}`,
    service,
    title: serviceLabel(service),
    url: normalizeUrl(url, service),
    zoom: 0.85,
    textScale: 1.3,
    collapseMedia: true,
    flex: 1,
    collapsed: false,
    watch: true,
    live: true,
  });
  editorSignature = '';
  saveColumns().then(rerenderAll);
}

/* ------------------------------------------------------------------ *
 * 設定パネルの入力
 * ------------------------------------------------------------------ */

async function patchGlobal(partial) {
  state = await window.dock.patchState(partial);
  renderSettings();
  scheduleLayout();
}

s.display.addEventListener('change', () =>
  patchGlobal({ displayId: s.display.value === '' ? null : Number(s.display.value) })
);
s.edge.addEventListener('change', () => patchGlobal({ edge: s.edge.value }));
s.layout.addEventListener('change', async () => {
  await patchGlobal({ layout: s.layout.value });
  editorSignature = '';
  rerenderAll();
});
s.width.addEventListener('input', () => {
  s.widthOut.textContent = `${s.width.value} px`;
});
s.width.addEventListener('change', () => patchGlobal({ width: Number(s.width.value) }));
s.accent.addEventListener('input', () => {
  // つまみを動かしている最中は画面だけ追従させ、保存は離したときに 1 回。
  applyTheme({ ...state.theme, mode: 'solid', accent: s.accent.value });
});
s.accent.addEventListener('change', () =>
  patchGlobal({ theme: { ...state.theme, mode: 'solid', accent: s.accent.value } })
);
s.rainbow.addEventListener('change', () =>
  patchGlobal({ theme: { ...state.theme, mode: s.rainbow.checked ? 'rainbow' : 'solid' } })
);
s.rainbowSpeed.addEventListener('input', () => {
  s.rainbowSpeedOut.textContent = `${s.rainbowSpeed.value} 秒`;
  applyTheme({ ...state.theme, speedSec: Number(s.rainbowSpeed.value) });
});
s.rainbowSpeed.addEventListener('change', () =>
  patchGlobal({ theme: { ...state.theme, speedSec: Number(s.rainbowSpeed.value) } })
);

s.compact.addEventListener('change', async () => {
  await patchGlobal({ compact: s.compact.checked });
  renderColumns();
});
s.reserve.addEventListener('change', () => patchGlobal({ reserveSpace: s.reserve.checked }));
s.fullscreen.addEventListener('change', () => patchGlobal({ hideOnFullscreen: s.fullscreen.checked }));
s.onTop.addEventListener('change', () => patchGlobal({ alwaysOnTop: s.onTop.checked }));
s.autoHide.addEventListener('change', () => patchGlobal({ autoHide: s.autoHide.checked }));
s.hideDelay.addEventListener('input', () => {
  s.hideDelayOut.textContent = `${(Number(s.hideDelay.value) / 1000).toFixed(1)} 秒`;
});
s.hideDelay.addEventListener('change', () => patchGlobal({ hideDelayMs: Number(s.hideDelay.value) }));
s.launch.addEventListener('change', () => patchGlobal({ launchAtLogin: s.launch.checked }));
s.autoFill.addEventListener('change', () => patchGlobal({ autoFill: s.autoFill.checked }));
s.liveInterval.addEventListener('input', () => {
  s.liveIntervalOut.textContent = `${(Number(s.liveInterval.value) / 1000).toFixed(0)} 秒`;
});
s.liveInterval.addEventListener('change', () => patchGlobal({ liveMinIntervalMs: Number(s.liveInterval.value) }));
s.stale.addEventListener('input', () => {
  const v = Number(s.stale.value);
  s.staleOut.textContent = v === 0 ? '無効' : `${v} 分`;
});
s.stale.addEventListener('change', () => patchGlobal({ staleReloadMin: Number(s.stale.value) }));

s.sound.addEventListener('change', () => patchGlobal({ sound: { ...state.sound, enabled: s.sound.checked } }));
s.volume.addEventListener('input', () => {
  s.volumeOut.textContent = `${s.volume.value}%`;
});
s.volume.addEventListener('change', () =>
  patchGlobal({ sound: { ...state.sound, volume: Number(s.volume.value) / 100 } })
);
s.soundInterval.addEventListener('input', () => {
  s.soundIntervalOut.textContent = `${(Number(s.soundInterval.value) / 1000).toFixed(1)} 秒`;
});
s.soundInterval.addEventListener('change', () =>
  patchGlobal({ sound: { ...state.sound, minIntervalMs: Number(s.soundInterval.value) } })
);
document.getElementById('btn-test-sound').addEventListener('click', () =>
  playChime(Number(s.volume.value) / 100)
);

s.shortcut.addEventListener('change', async () => {
  const accel = s.shortcut.value.trim();
  const ok = await window.dock.testShortcut(accel);
  s.shortcutStatus.textContent = ok ? '登録しました' : '使えない組み合わせです';
  if (ok) await patchGlobal({ toggleShortcut: accel });
  else s.shortcut.value = state.toggleShortcut;
  setTimeout(() => {
    s.shortcutStatus.textContent = '';
  }, 2500);
});

function renderServiceOptions() {
  const select = document.getElementById('add-service');
  const keep = select.value;
  select.replaceChildren();
  for (const svc of SERVICES) {
    const opt = document.createElement('option');
    opt.value = svc.id;
    opt.textContent = svc.label;
    select.appendChild(opt);
  }
  if (keep && SERVICES.some((s) => s.id === keep)) select.value = keep;
}

document.getElementById('btn-add-column').addEventListener('click', () => {
  const service = document.getElementById('add-service').value;
  const urlInput = document.getElementById('add-url');
  addColumn(service, urlInput.value);
  urlInput.value = '';
});

for (const btn of document.querySelectorAll('[data-clear]')) {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    await window.dock.clearSession(btn.dataset.clear);
    btn.disabled = false;
  });
}

document.getElementById('btn-open-styles').addEventListener('click', () => window.dock.dockAction('openStyles'));
document.getElementById('btn-open-config').addEventListener('click', () => window.dock.dockAction('openConfig'));
document.getElementById('btn-quit').addEventListener('click', () => window.dock.dockAction('quit'));

/* ------------------------------------------------------------------ *
 * バージョンと更新
 * ------------------------------------------------------------------ */

const updateEls = {
  version: document.getElementById('app-version'),
  status: document.getElementById('update-status'),
  check: document.getElementById('btn-check-update'),
  install: document.getElementById('btn-install-update'),
};

function renderUpdate(st) {
  if (!st) return;
  updateEls.version.textContent = st.version + (st.supported ? '' : '（開発中）');
  updateEls.status.textContent = st.message || '未確認';
  updateEls.status.className =
    'status' + (st.status === 'ready' ? ' ok' : st.status === 'error' ? ' ng' : '');
  updateEls.check.disabled = !st.supported || st.status === 'checking' || st.status === 'downloading';
  updateEls.install.hidden = st.status !== 'ready';
}

updateEls.check.addEventListener('click', async () => {
  renderUpdate(await window.dock.checkUpdate());
});

updateEls.install.addEventListener('click', () => window.dock.installUpdate());

window.dock.onUpdateState(renderUpdate);

/* ------------------------------------------------------------------ *
 * ツールバー
 * ------------------------------------------------------------------ */

function setSettingsOpen(open) {
  el.settings.hidden = !open;
  pushLayout(); // 開いた瞬間にネイティブビューを隠したいので即時に送る
  if (open) {
    renderSettings();
    refreshCredentials();
    refreshDataDir();
  }
}

document.getElementById('btn-settings').addEventListener('click', () => setSettingsOpen(el.settings.hidden));
document.getElementById('btn-close-settings').addEventListener('click', () => setSettingsOpen(false));
document.getElementById('btn-hide').addEventListener('click', () => window.dock.dockAction('hide'));
document.getElementById('btn-reload-all').addEventListener('click', () => {
  for (const col of state.columns) {
    window.dock.columnAction(col.id, 'reload');
    unread.set(col.id, 0);
  }
  applyStatuses();
});
document.getElementById('btn-sound').addEventListener('click', () =>
  patchGlobal({ sound: { ...state.sound, enabled: !state.sound.enabled } })
);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.settings.hidden) setSettingsOpen(false);
});

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */

window.dock.onState((next) => {
  const structural =
    !state ||
    next.layout !== state.layout ||
    next.compact !== state.compact ||
    JSON.stringify(next.columns) !== JSON.stringify(state.columns);
  state = next;
  if (structural) renderColumns();
  else scheduleLayout();
  renderSettings();
});

window.dock.onColumnStatus((payload) => {
  const prev = statuses.get(payload.id) || {};
  statuses.set(payload.id, { ...prev, ...payload });
  applyStatuses();
});

window.dock.onNewPost(notifyNewPost);
window.dock.onLoginStep(({ service, message }) => appendLoginLog(service, message));
window.dock.onOpenSettings(() => setSettingsOpen(true));

new ResizeObserver(scheduleLayout).observe(el.columns);
window.addEventListener('resize', scheduleLayout);

(async () => {
  [SERVICES, FEATURES] = await Promise.all([window.dock.listServices(), window.dock.getFeatures()]);
  renderUpdate(await window.dock.getUpdate());
  renderServiceOptions();

  // ログイン情報の機能を積んでいない配布版では、その節ごと隠す。
  if (!FEATURES.credentials) {
    const section = document.getElementById('credentials-section');
    if (section) section.hidden = true;
  }

  state = await window.dock.getState();
  renderColumns();
  renderSettings();
})();
