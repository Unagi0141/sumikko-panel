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

/**
 * 画像を大きく開くときの候補の規則（image.candidates）を読む。
 *
 * [パターン, 置換] の組を上から当て、表示中の縮小版から大きい版の URL を作る。
 * v0.9.2 で services.json に規則を足したが、ここで拾っていなかったため、
 * カラムに渡る定義から落ちていて、どのサービスでも一度も効いていなかった
 * （2026-09-16、mixi2 の「拡大しても小さい」で判明）。
 * 正規表現として読めない組は、その組だけ読み飛ばす。
 */
function imageRules(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.candidates) ? raw.candidates : [];
  const candidates = [];
  for (const pair of list) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue;
    try {
      new RegExp(pair[0]);
    } catch {
      console.warn('[services] image.candidates のパターンが読めないので読み飛ばします:', pair[0]);
      continue;
    }
    candidates.push([pair[0], pair[1]]);
  }
  return candidates.length ? { candidates } : null;
}

/**
 * 表示するタブの固定（tab）を読む。X のホームを「フォロー中」で開くためのもの。
 *
 * image と同じく、ここで拾っていなかったためカラムに渡る定義から落ちていて、
 * v0.9.4 で公開した「フォロー中で開く」は一度も効いていなかった（2026-09-16 判明）。
 *
 * 安全弁を正規化で崩さないこと:
 *   - paths は「このページでだけ押す」という制限。書いてあるのに 1 つも読めなければ、
 *     制限の無い規則（どのページでも押す）に化けるので、規則ごと捨てる
 *   - 押す回数の打ち切り（5 回）はプリロード側にあり、ここでは触らない
 */
function tabRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []);

  const labels = strings(raw.labels);
  if (!labels.length) return null;

  const given = strings(raw.paths);
  const paths = given.filter((p) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      console.warn('[services] tab.paths のパターンが読めないので読み飛ばします:', p);
      return false;
    }
  });
  if (Array.isArray(raw.paths) && raw.paths.length && !paths.length) {
    console.warn('[services] tab.paths が 1 つも読めないため、タブの固定を無効にします');
    return null;
  }

  const text = (v) => (typeof v === 'string' && v ? v : null);
  return {
    paths,
    container: text(raw.container),
    item: text(raw.item),
    selected: text(raw.selected),
    labels,
  };
}

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
    image: imageRules(raw.image),
    tab: tabRule(raw.tab),
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
