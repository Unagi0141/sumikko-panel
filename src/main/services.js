const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

/**
 * 対応サービスの定義。
 *
 * 以前はコード（store.js の SERVICES と column-preload.js の SITES）に
 * 直接書いていたため、サービスを 1 つ増やすのに 3 か所を書き換える必要があった。
 * ここでは定義を JSON に外へ出し、追加は「JSON に 1 項目 + CSS を 1 枚」で済むようにする。
 *
 * ファイルはユーザーデータ側へ複製され、以降はそちらが優先される。
 * 更新の扱いは注入 CSS と同じで、手つかずなら最新へ入れ替え、編集済みなら残す。
 */

const BUNDLED = path.join(__dirname, '..', 'services', 'services.json');
const FILE_NAME = 'services.json';

let cache = null;

function hash(text) {
  return crypto.createHash('sha256').update(String(text).split('\r\n').join('\n')).digest('hex');
}

function userFile() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

/** 既定の定義をユーザーデータ側へ置く（手を加えていなければ更新する）。 */
function seed() {
  const dest = userFile();
  const manifestPath = path.join(app.getPath('userData'), '.services-seed.json');

  let seededHash = null;
  try {
    seededHash = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).hash;
  } catch {
    seededHash = null;
  }

  try {
    const bundled = fs.readFileSync(BUNDLED, 'utf8');
    let current = null;
    try {
      current = fs.readFileSync(dest, 'utf8');
    } catch {
      current = null;
    }

    if (current === null || hash(current) === seededHash) {
      if (current !== bundled) fs.writeFileSync(dest, bundled, 'utf8');
      fs.writeFileSync(manifestPath, JSON.stringify({ hash: hash(bundled) }, null, 2), 'utf8');
    } else if (seededHash === null) {
      // この仕組みより前から置かれていた場合。控えを取ってから最新にする。
      const backup = dest + '.bak';
      try {
        if (!fs.existsSync(backup)) fs.copyFileSync(dest, backup);
      } catch {
        // 控えが作れなくても続行する
      }
      fs.writeFileSync(dest, bundled, 'utf8');
      fs.writeFileSync(manifestPath, JSON.stringify({ hash: hash(bundled) }, null, 2), 'utf8');
    } else if (hash(bundled) !== seededHash) {
      console.warn('[services] 編集済みのため services.json は更新しませんでした:', dest);
    }
  } catch (err) {
    console.error('[services] 定義の初期配置に失敗:', err.message);
  }
}

function readRaw() {
  for (const file of [userFile(), BUNDLED]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && Array.isArray(parsed.services)) return parsed.services;
    } catch {
      // 次の候補へ
    }
  }
  return [];
}

const ID_OK = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** 足りない項目を埋め、おかしな値を弾く。壊れている定義はその 1 件だけ読み飛ばす。 */
function normalizeOne(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!ID_OK.test(id)) {
    console.warn('[services] id が不正なので読み飛ばします:', raw.id);
    return null;
  }

  const post = raw.post && typeof raw.post === 'object' ? raw.post : {};
  const live = raw.live && typeof raw.live === 'object' ? raw.live : null;
  const out = raw.loggedOut && typeof raw.loggedOut === 'object' ? raw.loggedOut : {};
  const arr = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []);

  return {
    id,
    label: String(raw.label || id),
    home: /^https?:\/\//i.test(raw.home || '') ? raw.home : 'https://example.com/',
    hosts: arr(raw.hosts),
    // セッションはサービスごとに分ける。id をそのまま使う。
    partition: `persist:${id}`,
    textBase: Number.isFinite(Number(raw.textBase)) ? Number(raw.textBase) : 15,
    post: {
      selector: String(post.selector || 'article, [role="article"]'),
      key: post.key && typeof post.key === 'object' ? post.key : { text: true },
    },
    media: String(raw.media || 'article img, [role="article"] img'),
    live: live && live.key ? { key: String(live.key), pending: String(live.pending || '') } : null,
    loggedOut: {
      loggedIn: arr(out.loggedIn),
      paths: arr(out.paths),
      present: arr(out.present),
      texts: arr(out.texts),
    },
  };
}

/** id -> 定義。読み込み済みならそれを返す。 */
function all() {
  if (cache) return cache;
  const list = readRaw().map(normalizeOne).filter(Boolean);

  cache = {};
  for (const s of list) cache[s.id] = s;

  // 未知のサービスに落ちるための受け皿は必ず用意する。
  if (!cache.generic) {
    cache.generic = normalizeOne({ id: 'generic', label: 'その他のWeb', home: 'https://example.com/' });
  }
  return cache;
}

function get(id) {
  const map = all();
  return map[id] || map.generic;
}

function has(id) {
  return Object.prototype.hasOwnProperty.call(all(), id);
}

/** 設定画面の選択肢用。generic は最後に回す。 */
function list() {
  const map = all();
  return Object.values(map)
    .map((s) => ({ id: s.id, label: s.label, home: s.home }))
    .sort((a, b) => (a.id === 'generic' ? 1 : b.id === 'generic' ? -1 : 0));
}

function reload() {
  cache = null;
  return all();
}

module.exports = { seed, all, get, has, list, reload, filePath: userFile };
