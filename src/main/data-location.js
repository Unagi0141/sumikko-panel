const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * アプリのデータ保存先（userData）の切り替え。
 *
 * userData は「アプリが ready になる前」に確定させる必要があるので、
 * この仕組みだけは main.js の一番上で走らせる。
 *
 * 保存先そのものは動かせるが、「どこに置いたか」を書いた小さなポインタだけは
 * 既定の場所（%APPDATA%\Sumikko Panel\data-location.json）に残る。
 * ここが動かせないと、次の起動で行き先が分からなくなるため。
 *
 * ポインタの中身:
 *   { "path": "D:\\TimelineDock", "moveFrom": "C:\\Users\\...\\Timeline Dock" }
 *
 * moveFrom があるときは「次の起動でここから中身を運ぶ」という予約。
 * 実際のコピーは、まだどのファイルも開かれていない起動直後に行う。
 * （動作中はセッションの DB がロックされていて確実に運べない）
 */

const POINTER_NAME = 'data-location.json';

// データの置き場の名前。表示名（すみっこパネル）とは別に、ASCII で固定する。
// 日本語のフォルダ名は動きはするが、パスを扱う道具立てで面倒が出やすいため。
// また、表示名を変えたときにここが一緒に動くと、利用者の設定とログイン状態が
// まるごと迷子になる。名前と保存先は切り離しておく。
const APP_DIR_NAME = 'Sumikko Panel';

// 旧称のときに使っていた場所。見つかれば一度だけ引き継ぐ。
const LEGACY_DIR_NAMES = ['Timeline Dock'];

// コピーしてはいけない、あるいはコピーしても無意味なもの
const SKIP_NAMES = new Set([
  POINTER_NAME,
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'LOCK',
  'lockfile',
  'Crashpad',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'Code Cache',
  'Cache',
]);

function defaultDir() {
  return path.join(app.getPath('appData'), APP_DIR_NAME);
}

/**
 * 旧称で作られたデータがあれば、新しい場所へ一度だけ引き継ぐ。
 * 名前を変えただけで設定もログイン状態も消えた、という事故を防ぐため。
 * まだ何も開いていない起動直後にしか呼ばない（ロックされていると運べない）。
 */
function migrateLegacy() {
  const target = defaultDir();
  if (fs.existsSync(target)) return null;

  for (const legacy of LEGACY_DIR_NAMES) {
    const from = path.join(app.getPath('appData'), legacy);
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, target);
      console.log('[data-location] 以前のデータを引き継ぎました: %s → %s', from, target);
      return from;
    } catch (err) {
      // 別ドライブや権限で rename できないことがあるので、複製で代替する。
      try {
        copyTree(from, target);
        console.log('[data-location] 以前のデータを複製しました: %s → %s', from, target);
        return from;
      } catch (err2) {
        console.error('[data-location] 引き継ぎに失敗:', err2.message);
      }
    }
  }
  return null;
}

function pointerPath() {
  return path.join(defaultDir(), POINTER_NAME);
}

function readPointer() {
  try {
    const raw = JSON.parse(fs.readFileSync(pointerPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writePointer(value) {
  try {
    fs.mkdirSync(defaultDir(), { recursive: true });
    fs.writeFileSync(pointerPath(), JSON.stringify(value, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[data-location] 保存先の記録に失敗:', err.message);
    return false;
  }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 保存先として使えるかを確かめる。使えない理由があれば文字列で返す。 */
function validate(target, current) {
  if (!target || !path.isAbsolute(target)) return '絶対パスを指定してください。';
  if (isInside(target, current) && target !== current) {
    return '今の保存先の中は指定できません。';
  }
  if (isInside(current, target) && target !== current) {
    return '今の保存先を含むフォルダは指定できません。';
  }
  try {
    fs.mkdirSync(target, { recursive: true });
    const probe = path.join(target, '.tldock-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    return 'そのフォルダに書き込めません: ' + err.message;
  }
  return null;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
    // シンボリックリンクなどは無視する
  }
}

/**
 * main.js の先頭で呼ぶ。保存先を確定し、保留中の移動があれば実行して、
 * app の userData をそこへ向ける。
 * @returns {{ dir: string, isDefault: boolean, moved: string|null, error: string|null }}
 */
function applyAtStartup() {
  // 旧称のデータがあれば先に引き継ぐ。ポインタもその中に入っている。
  const migrated = migrateLegacy();

  const fallback = defaultDir();
  const pointer = readPointer();
  const target = pointer.path && path.isAbsolute(pointer.path) ? pointer.path : fallback;

  let moved = null;
  let error = null;

  if (pointer.moveFrom && pointer.moveFrom !== target) {
    try {
      if (fs.existsSync(pointer.moveFrom)) {
        copyTree(pointer.moveFrom, target);
        moved = pointer.moveFrom;
      }
    } catch (err) {
      error = 'データの移動に失敗しました: ' + err.message;
      console.error('[data-location]', error);
    }
    // 成否にかかわらず予約は消す。失敗したまま毎回やり直すと事故のもと。
    writePointer({ path: pointer.path || fallback });
  }

  try {
    fs.mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
  } catch (err) {
    error = '保存先を開けなかったので既定の場所を使います: ' + err.message;
    console.error('[data-location]', error);
    app.setPath('userData', fallback);
    return { dir: fallback, isDefault: true, moved, error, migrated };
  }

  return { dir: target, isDefault: target === fallback, moved, error, migrated };
}

/**
 * 次の起動から使う保存先を予約する。実際の切り替えは再起動時。
 * @param {string} target 新しい保存先
 * @param {string} current 現在の保存先
 * @param {boolean} move 今のデータを運ぶかどうか
 */
function scheduleChange(target, current, move) {
  const problem = validate(target, current);
  if (problem) return { ok: false, error: problem };
  if (target === current) return { ok: false, error: 'すでにその場所を使っています。' };

  const record = { path: target };
  if (move) record.moveFrom = current;
  if (!writePointer(record)) return { ok: false, error: '保存先を記録できませんでした。' };
  return { ok: true };
}

module.exports = { applyAtStartup, scheduleChange, validate, defaultDir, pointerPath };
