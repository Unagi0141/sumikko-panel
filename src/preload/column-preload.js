/* 各カラムのページ内で動くプリロード。
 *
 * やること:
 *   1. 新着投稿の検知 → メインへ通知（音とバッジのため）
 *   2. 新着が待っているときの合図 → メインが実際のキーを送る
 *   3. ログアウト状態の検知 → メインへ通知
 *   4. 画像の折りたたみを開く
 *   5. （有効なときだけ）ログイン欄への入力
 *
 * かつてはサービスごとの判定をこのファイルに直書きしていたが、サービスを
 * 1 つ増やすたびにここを書き換える必要があった。今は定義を JSON から受け取り、
 * このファイルは「定義をどう解釈するか」だけを持つ。 */

const { ipcRenderer } = require('electron');

/* ------------------------------------------------------------------ *
 * サービス定義の受け取り
 * ------------------------------------------------------------------ */

// メイン側が additionalArguments で渡してくる。
// sandbox 下ではファイルを読めないので、この経路しかない。
function loadDefinition() {
  const fallback = {
    id: 'generic',
    label: 'Web',
    textBase: 15,
    post: { selector: 'article, [role="article"]', key: { text: true } },
    media: 'article img, [role="article"] img, main img',
    live: null,
    loggedOut: { loggedIn: [], paths: [], present: ['input[type="password"]'], texts: [] },
  };

  try {
    const arg = (process.argv || []).find((a) => a.startsWith('--tld-service='));
    if (!arg) return fallback;
    const parsed = JSON.parse(decodeURIComponent(arg.slice('--tld-service='.length)));
    return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : fallback;
  } catch {
    return fallback;
  }
}

const SERVICE = loadDefinition();

/* ------------------------------------------------------------------ *
 * 定義を読むための小道具
 * ------------------------------------------------------------------ */

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function anyPresent(selectors) {
  return (selectors || []).some((sel) => {
    try {
      return !!document.querySelector(sel);
    } catch {
      return false; // 定義側のセレクタが壊れていても落とさない
    }
  });
}

function anyPathMatch(patterns) {
  return (patterns || []).some((p) => {
    try {
      return new RegExp(p).test(location.pathname);
    } catch {
      return false;
    }
  });
}

// 表示されているボタン / リンクから文言で探す。
// 未ログインのトップページでは「ログイン」が <a> のことがあるためリンクも見る。
function findByText(labels) {
  if (!labels || !labels.length) return null;
  const candidates = document.querySelectorAll('a, button, [role="button"], input[type="submit"]');
  for (const el of candidates) {
    if (!visible(el)) continue;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    if (!text || text.length > 40) continue;
    if (labels.some((l) => text === l || text.includes(l))) return el;
  }
  return null;
}

/** 定義の loggedOut に従って判定する。 */
function isLoggedOut() {
  const rule = SERVICE.loggedOut || {};
  // ログイン後にしか出ないものが見えていれば、そこで打ち切る。
  if (anyPresent(rule.loggedIn)) return false;
  if (anyPathMatch(rule.paths)) return true;
  if (anyPresent(rule.present)) return true;
  return !!findByText(rule.texts);
}

function postSelector() {
  return (SERVICE.post && SERVICE.post.selector) || 'article, [role="article"]';
}

/** 投稿を見分けるための鍵。定義の post.key に従う。 */
function postKey(el) {
  const rule = (SERVICE.post && SERVICE.post.key) || { text: true };
  if (rule.selector) {
    try {
      const target = el.querySelector(rule.selector);
      if (target) {
        const v =
          (rule.attr && target.getAttribute(rule.attr)) ||
          (rule.fallbackAttr && target.getAttribute(rule.fallbackAttr));
        if (v) return v;
      }
    } catch {
      // セレクタが壊れていれば本文にフォールバック
    }
  }
  return (el.textContent || '').trim().slice(0, 120) || null;
}

/* ------------------------------------------------------------------ *
 * 新着検知
 * ------------------------------------------------------------------ */

const seenKeys = new Set();
// 先頭からこの位置までに現れたものだけを「新着」とみなす。
// 下へスクロールして過去の投稿が読み込まれたときに鳴らさないため。
const TOP_WINDOW = 3;

let armed = false; // 初回読み込み分は鳴らさない
let scanTimer = null;

function scan() {
  let nodes = [];
  try {
    nodes = document.querySelectorAll(postSelector());
  } catch {
    return;
  }

  let fresh = 0;
  let index = 0;
  for (const el of nodes) {
    index += 1;
    const key = postKey(el);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (armed && index <= TOP_WINDOW) fresh += 1;
  }

  // 覚えすぎないよう、古い分を捨てる
  if (seenKeys.size > 800) {
    const keys = [...seenKeys];
    for (const k of keys.slice(0, keys.length - 400)) seenKeys.delete(k);
  }

  if (fresh > 0) ipcRenderer.send('col:new-post', { count: fresh });
}

function scheduleScan() {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    try {
      scan();
    } catch {
      // 定義が合わなくなっても落とさない
    }
  }, 400);
}

/* ------------------------------------------------------------------ *
 * 新着の流し込み
 * ------------------------------------------------------------------ */

// 押してよい状況かを判断してメインへ知らせる。実際のキー送信はメインが行う
// （ページ内から出す合成イベントでは X が反応しないことを実測済み）。
function checkLive() {
  const live = SERVICE.live;
  if (!live || !live.key) return;

  if (live.pending) {
    let pill = null;
    try {
      pill = document.querySelector(live.pending);
    } catch {
      return;
    }
    if (!pill || !visible(pill)) return;
  }

  // 読んでいる最中に差し込むと位置が飛ぶので、先頭にいるときだけ。
  const scroller = document.scrollingElement || document.documentElement;
  if (scroller.scrollTop > 200) return;

  // 入力中にキーを送ると本文に紛れ込むので避ける。
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;

  // 先頭の投稿も送る。押した結果これが変われば効いた、変わらなければ空振り。
  let top = null;
  try {
    const first = document.querySelector(postSelector());
    top = first ? postKey(first) : null;
  } catch {
    top = null;
  }

  try {
    ipcRenderer.send('col:live-ready', { key: live.key, top });
  } catch {
    // 破棄済みなら無視
  }
}

/* ------------------------------------------------------------------ *
 * 画像の折りたたみを開く
 * ------------------------------------------------------------------ */

// CSS 側で max-height を掛けてあるので、はみ出しているものだけが対象。
function setupMediaExpand() {
  if (!SERVICE.media) return;
  document.addEventListener(
    'click',
    (e) => {
      let media = null;
      try {
        media = e.target && e.target.closest ? e.target.closest(SERVICE.media) : null;
      } catch {
        return;
      }
      if (!media || media.hasAttribute('data-tld-expanded')) return;
      // 実際に切り詰められている場合だけ横取りする。
      // そうでないときは投稿を開くなど本来の動作を邪魔しない。
      if (media.scrollHeight <= media.clientHeight + 4) return;
      e.preventDefault();
      e.stopPropagation();
      media.setAttribute('data-tld-expanded', '1');
    },
    true
  );
}

/* ------------------------------------------------------------------ *
 * 表示するタブの固定
 * ------------------------------------------------------------------ */

// X のホームは開くたび「おすすめ」に戻る。定義に tab があれば、
// 指定された見出しのタブが選ばれていないときだけ押して戻す。
// 押しても変わらない作りに変わっていた場合に叩き続けないよう、回数で打ち切る。
const TAB_MAX_TRIES = 5;
let tabTries = 0;
let tabPath = null;

function keepTab() {
  const rule = SERVICE.tab;
  if (!rule || !rule.labels || !rule.labels.length) return;

  // 画面を移ったら数え直す（SPA なのでプリロードは作り直されない）
  if (tabPath !== location.pathname) {
    tabPath = location.pathname;
    tabTries = 0;
  }

  // タイムライン以外（個別の投稿や設定画面）では触らない
  if (rule.paths && rule.paths.length && !anyPathMatch(rule.paths)) return;

  let list = document;
  if (rule.container) {
    list = document.querySelector(rule.container);
    if (!list) return; // まだ描かれていない
  }

  let items;
  try {
    items = list.querySelectorAll(rule.item || '[role="tab"]');
  } catch {
    return; // 定義側のセレクタが壊れていても落とさない
  }

  const selectedAttr = rule.selected || 'aria-selected';
  let target = null;
  let selected = null;

  for (const el of items) {
    if (!visible(el)) continue;
    if (el.getAttribute(selectedAttr) === 'true') selected = el;
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
    if (!text || text.length > 40) continue;
    if (rule.labels.some((l) => text === l || text.includes(l))) target = el;
  }

  if (!target) return;          // まだ出ていない、または見出しが変わった
  if (target === selected) {    // もう目的のタブ。数え直して次に備える
    tabTries = 0;
    return;
  }
  if (tabTries >= TAB_MAX_TRIES) return;

  tabTries += 1;
  target.click();
}

/* ------------------------------------------------------------------ *
 * ログイン欄への入力（送信はしない）
 * ------------------------------------------------------------------ */

const USER_SELECTOR =
  'input[autocomplete="username"], input[name="text"], input[type="email"], input[name="email"], input[name="username"]';
const PASS_SELECTOR = 'input[type="password"]';

// React 製のフォームは value を直接代入しても状態が更新されないので、
// ネイティブの setter を呼んでから input / change を発火させる。
function setValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) setter.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// パスワードマネージャと同じ振る舞い。空の欄にだけ入れ、ボタンは押さない。
function fillOnly({ username, password }) {
  const filled = [];
  const user = document.querySelector(USER_SELECTOR);
  if (user && visible(user) && !user.value) {
    setValue(user, username);
    filled.push('ユーザー名');
  }
  const pw = document.querySelector(PASS_SELECTOR);
  if (pw && visible(pw) && !pw.value) {
    setValue(pw, password);
    filled.push('パスワード');
  }
  if (filled.length) {
    try {
      ipcRenderer.send('col:autofill-done', {
        message: filled.join('と') + 'を入力しました。ログインボタンはご自分で押してください。',
      });
    } catch {
      // 破棄済みなら無視
    }
  }
}

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */

function reportAuthState() {
  try {
    let posts = 0;
    try {
      posts = document.querySelectorAll(postSelector()).length;
    } catch {
      posts = 0;
    }
    // posts が 0 のままなら、投稿セレクタが合っていない手がかりになる。
    ipcRenderer.send('col:auth-state', { loggedOut: !!isLoggedOut(), posts, service: SERVICE.id });
  } catch {
    // 破棄済みなら無視
  }
}

function boot() {
  // 最初に並んでいる投稿は「既読」として飲み込み、以降の増分だけを新着とする。
  try {
    scan();
  } catch {
    // 無視
  }
  setTimeout(() => {
    armed = true;
  }, 5000);

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // CSS だけで出入りする要素は MutationObserver で拾えないので、取りこぼし用に低頻度で見る。
  setInterval(scheduleScan, 15000);

  setupMediaExpand();

  // 描画が遅いサイトがあるので、間隔を空けて数回報告する。
  reportAuthState();
  for (const delay of [3000, 10000]) setTimeout(reportAuthState, delay);

  // タブは描き終わるまで出てこないので、最初だけ短い間隔でも試す
  for (const delay of [800, 2500, 6000]) {
    setTimeout(() => {
      try {
        keepTab();
      } catch {
        // 無視
      }
    }, delay);
  }

  setInterval(() => {
    try {
      checkLive();
    } catch {
      // 無視
    }
    try {
      keepTab();
    } catch {
      // 無視
    }
  }, 5000);

  ipcRenderer.on('col:autofill', (_e, creds) => {
    if (creds && creds.username && creds.password) {
      try {
        fillOnly(creds);
      } catch {
        // 画面構造が想定と違っても落とさない
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
