const { app } = require('electron');

/**
 * 自動更新。
 *
 * このアプリはサービス側の DOM に依存しているので、いつか必ず壊れる。
 * 直したものを届ける手段が無いと「動かないアプリ」として放置されるため、
 * 配布より前にこれを入れておく必要がある。
 *
 * 常駐アプリなので、勝手に再起動はしない。
 * 裏で落としておいて「次に終了したときに適用される」と伝えるだけにする。
 * すぐ入れたい人のために、トレイと設定から再起動の口も出す。
 */

const CHECK_DELAY_MS = 30 * 1000;        // 起動直後は画面の読み込みを優先する
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 常駐しっぱなしなので定期的に見る

let updater = null;   // electron-updater の autoUpdater
let timer = null;
let notify = () => {};

// UI とトレイへ渡す状態
const state = {
  supported: false,   // パッケージ版でなければ更新の仕組みは動かない
  status: 'idle',     // idle | checking | available | downloading | ready | uptodate | error
  version: app.getVersion(),
  newVersion: null,
  percent: 0,
  message: '',
};

function set(patch) {
  Object.assign(state, patch);
  try {
    notify({ ...state });
  } catch {
    // UI が居なくても続行する
  }
}

/** 現在の状態の写し。 */
function get() {
  return { ...state };
}

/**
 * @param {(s: object) => void} onChange 状態が変わったときに呼ばれる
 */
function start(onChange) {
  notify = typeof onChange === 'function' ? onChange : () => {};

  // 開発中（パッケージされていない）は更新情報が無く、呼ぶと例外になる。
  if (!app.isPackaged) {
    set({ supported: false, status: 'idle', message: '開発中は更新を確認しません。' });
    return;
  }

  try {
    updater = require('electron-updater').autoUpdater;
  } catch (err) {
    set({ supported: false, status: 'error', message: '更新の仕組みを読み込めませんでした: ' + err.message });
    return;
  }

  state.supported = true;

  // 落とすところまでは自動。適用は終了時（既定）に任せる。
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = null;

  updater.on('checking-for-update', () => set({ status: 'checking', message: '更新を確認しています…' }));

  updater.on('update-available', (info) => {
    set({ status: 'downloading', newVersion: info?.version || null, percent: 0,
      message: `新しい版 ${info?.version || ''} を受け取っています…` });
  });

  updater.on('update-not-available', () => {
    set({ status: 'uptodate', newVersion: null, message: '最新の状態です。' });
  });

  updater.on('download-progress', (p) => {
    set({ status: 'downloading', percent: Math.round(p?.percent || 0),
      message: `受け取り中 ${Math.round(p?.percent || 0)}%` });
  });

  updater.on('update-downloaded', (info) => {
    set({ status: 'ready', newVersion: info?.version || null, percent: 100,
      message: `新しい版 ${info?.version || ''} の準備ができました。次に終了したときに適用されます。` });
  });

  updater.on('error', (err) => {
    // 更新の失敗でアプリを止めない。ネットが繋がっていないだけのことも多い。
    set({ status: 'error', message: '更新を確認できませんでした: ' + (err?.message || String(err)) });
  });

  setTimeout(check, CHECK_DELAY_MS);
  timer = setInterval(check, CHECK_INTERVAL_MS);
}

/** 手動でも呼べる。設定パネルの「更新を確認」から。 */
function check() {
  if (!updater) return;
  // 落とし終わっているのに何度も確認しても意味がない
  if (state.status === 'downloading' || state.status === 'ready') return;
  updater.checkForUpdates().catch((err) => {
    set({ status: 'error', message: '更新を確認できませんでした: ' + (err?.message || String(err)) });
  });
}

/** 受け取り済みの更新を今すぐ適用して再起動する。 */
function installNow() {
  if (!updater || state.status !== 'ready') return false;
  // 第1引数 isSilent=false: インストーラの画面を出す（署名が無いので黙って進めない）
  setImmediate(() => updater.quitAndInstall(false, true));
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, check, installNow, get };
