const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

/**
 * ログイン情報のローカル保存。
 *
 * パスワードは Electron の safeStorage（Windows では DPAPI）で暗号化して保存する。
 * 暗号文は「この Windows ユーザーアカウント」に紐づくので、ファイルを他の PC や
 * 他ユーザーへコピーしても復号できない。
 *
 * 暗号化が使えない環境では、平文で保存せず保存自体を断る。
 */

const FILE_NAME = 'credentials.json';

let cache = null;

function file() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function loadRaw() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!cache || typeof cache !== 'object') cache = {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[credentials] 保存に失敗:', err.message);
    return false;
  }
  return true;
}

function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * 保存状態を調べる。
 *   'none'          … 何も保存されていない
 *   'ok'            … 保存されていて復号できる
 *   'undecryptable' … 保存されているが復号できない（鍵が変わった等）
 *
 * 「保存されていない」と「復号できない」を混同すると、入れ直せば直る状況を
 * 見落とすので、必ず区別する。
 */
function status(service) {
  const entry = loadRaw()[service];
  if (!entry || !entry.username || !entry.secret) return 'none';
  try {
    safeStorage.decryptString(Buffer.from(entry.secret, 'base64'));
    return 'ok';
  } catch {
    return 'undecryptable';
  }
}

/** UI に返す一覧。パスワードそのものは決して返さない。 */
function list() {
  const raw = loadRaw();
  const out = {};
  for (const [service, entry] of Object.entries(raw)) {
    out[service] = {
      username: typeof entry?.username === 'string' ? entry.username : '',
      hasPassword: !!entry?.secret,
      status: status(service),
    };
  }
  return { available: isAvailable(), entries: out };
}

function set(service, username, password) {
  if (!isAvailable()) {
    return { ok: false, error: 'この環境では OS による暗号化が使えないため、保存しません。' };
  }
  const raw = loadRaw();
  const entry = { username: String(username || '') };

  if (password) {
    try {
      const secret = safeStorage.encryptString(String(password)).toString('base64');
      // 暗号化した直後に復号し直して確かめる。
      // 何らかの理由で一時的な鍵が使われると、その場では成功したように見えて
      // 次の起動で復号できなくなる。保存する前にここで弾く。
      if (safeStorage.decryptString(Buffer.from(secret, 'base64')) !== String(password)) {
        return { ok: false, error: '暗号化の検証に失敗しました。保存を中止しました。' };
      }
      entry.secret = secret;
    } catch (err) {
      return { ok: false, error: '暗号化に失敗しました: ' + err.message };
    }
  } else if (raw[service]?.secret) {
    entry.secret = raw[service].secret; // パスワード欄が空なら既存のものを残す
  }

  raw[service] = entry;
  if (!persist()) return { ok: false, error: 'ファイルに書き込めませんでした。' };
  return { ok: true };
}

function clear(service) {
  const raw = loadRaw();
  delete raw[service];
  persist();
  return { ok: true };
}

/** メインプロセス内でのみ使う。復号したパスワードを返す。 */
function get(service) {
  const entry = loadRaw()[service];
  if (!entry || !entry.username || !entry.secret) return null;
  try {
    const password = safeStorage.decryptString(Buffer.from(entry.secret, 'base64'));
    if (!password) return null;
    return { username: entry.username, password };
  } catch (err) {
    console.error('[credentials] 復号に失敗しました（別のユーザー/PC で作られた可能性）:', err.message);
    return null;
  }
}

module.exports = { list, set, clear, get, status, isAvailable, filePath: file };
