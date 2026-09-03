const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const services = require('./services');

const DEFAULTS = {
  edge: 'right',        // 'left' | 'right'
  width: 560,
  displayId: null,      // null なら主ディスプレイ。複数モニタ時に固定したい場合に使う。
  layout: 'row',        // 'row' = カラムを横に並べる / 'column' = 縦に積む
  compact: true,        // 文字と余白を詰める

  reserveSpace: true,   // AppBar として画面の作業領域を予約する（他ウインドウが避ける）
  hideOnFullscreen: true,
  alwaysOnTop: false,   // 領域を予約するので、既定では他ウインドウの上に出ない
  autoHide: false,
  hideDelayMs: 700,

  toggleShortcut: 'Alt+Shift+T',
  launchAtLogin: false,
  // 既定はオフ。実測の結果、X はログインフローがエラーになりやすく、
  // mixi2 はメール認証コード方式で自動化が完結しないため（README 参照）。
  autoLogin: false,
  // 保存済みの ID/PW を空欄に入れるだけ（送信はしない）。autoLogin とは別物。
  autoFill: true,

  // 新着の流し込み。X が案内しているピリオドキーを送る方式。
  liveMinIntervalMs: 20000,  // 連続で押さないための下限
  staleReloadMin: 30,        // 何分更新が無ければ再読み込みするか（0 で無効）

  sound: {
    enabled: true,
    volume: 0.4,
    minIntervalMs: 4000, // 連投で鳴り続けないための下限間隔
  },

  columns: [
    {
      id: 'x-home',
      service: 'x',
      title: 'X',
      url: 'https://x.com/home',
      zoom: 0.85,
      textScale: 1.3,    // 本文だけを拡大する倍率（レイアウトは動かさない）
      collapseMedia: true,
      flex: 1,
      collapsed: false,
      watch: true,       // 新着を検知して音を鳴らす
      live: true,        // 新着が来たら流し込む
    },
  ],
};


let cache = null;
let configPath = null;

function file() {
  if (!configPath) configPath = path.join(app.getPath('userData'), 'config.json');
  return configPath;
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = normalize({ ...DEFAULTS, ...raw });
  } catch {
    cache = normalize(structuredClone(DEFAULTS));
  }
  return cache;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

// `Number(v) || fallback` だと 0 が既定値に化けるので、数値かどうかで判定する。
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalize(state) {
  if (!Array.isArray(state.columns) || state.columns.length === 0) {
    state.columns = structuredClone(DEFAULTS.columns);
  }
  const seen = new Set();
  state.columns = state.columns.map((c, i) => {
    let id = String(c.id || `col-${i}`);
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    const service = services.has(c.service) ? c.service : 'generic';
    const def = services.get(service);

    // textScale が無いカラムは、文字倍率を導入する前に作られたもの。
    // 当時は zoom を下げて情報量を稼いでいたので文字が読みづらい。
    // 一度だけ、zoom を戻して文字倍率のほうで詰める設定へ移す。
    const isLegacy = c.textScale === undefined;
    const zoom = clamp(num(c.zoom, 1), 0.3, 2);

    return {
      id,
      service,
      title: String(c.title || def.label),
      url: String(c.url || def.home),
      zoom: isLegacy && zoom < 0.8 ? 0.85 : zoom,
      textScale: clamp(num(c.textScale, isLegacy ? 1.3 : 1), 0.8, 2.5),
      collapseMedia: c.collapseMedia === undefined ? true : !!c.collapseMedia,
      flex: clamp(num(c.flex, 1), 0.15, 20),
      collapsed: !!c.collapsed,
      watch: c.watch === undefined ? true : !!c.watch,
      live: c.live === undefined ? true : !!c.live,
    };
  });

  state.edge = state.edge === 'left' ? 'left' : 'right';
  state.layout = state.layout === 'column' ? 'column' : 'row';
  state.width = clamp(Math.round(num(state.width, DEFAULTS.width)), 200, 1600);
  state.compact = state.compact === undefined ? true : !!state.compact;

  state.reserveSpace = state.reserveSpace === undefined ? true : !!state.reserveSpace;
  state.hideOnFullscreen = state.hideOnFullscreen === undefined ? true : !!state.hideOnFullscreen;
  state.alwaysOnTop = !!state.alwaysOnTop;
  state.autoHide = !!state.autoHide;
  state.hideDelayMs = clamp(Math.round(num(state.hideDelayMs, DEFAULTS.hideDelayMs)), 0, 10000);

  state.toggleShortcut = String(state.toggleShortcut || DEFAULTS.toggleShortcut);
  state.launchAtLogin = !!state.launchAtLogin;
  state.autoLogin = !!state.autoLogin;
  state.autoFill = state.autoFill === undefined ? true : !!state.autoFill;
  state.liveMinIntervalMs = clamp(Math.round(num(state.liveMinIntervalMs, DEFAULTS.liveMinIntervalMs)), 5000, 300000);
  state.staleReloadMin = clamp(Math.round(num(state.staleReloadMin, DEFAULTS.staleReloadMin)), 0, 720);
  state.displayId = Number.isFinite(Number(state.displayId)) && state.displayId !== null ? Number(state.displayId) : null;

  const sound = state.sound && typeof state.sound === 'object' ? state.sound : {};
  state.sound = {
    enabled: sound.enabled === undefined ? true : !!sound.enabled,
    volume: clamp(num(sound.volume, DEFAULTS.sound.volume), 0, 1),
    minIntervalMs: clamp(Math.round(num(sound.minIntervalMs, DEFAULTS.sound.minIntervalMs)), 0, 60000),
  };

  return state;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
    } catch (err) {
      console.error('[store] 保存に失敗:', err);
    }
  }, 250);
}

function patch(partial) {
  cache = normalize({ ...load(), ...partial });
  save();
  return cache;
}

module.exports = { load, patch, save, normalize, DEFAULTS, configPath: file, clamp };
