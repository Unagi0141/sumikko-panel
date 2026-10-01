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
 * 失敗の報告
 * ------------------------------------------------------------------ */

// このファイルの処理はページの中で動くので、ここで失敗しても主プロセスの
// error.log には何も残らなかった（2026-09-16、画像の拡大が止まった件で、
// どの段で止まったのかを確かめられなかった）。
// 失敗した「段の名前」と形の手がかりだけをメインへ送る。URL や本文は送らない。
// 書くかどうか・何回まで書くかはメイン側（page-failure.js）が決める。
function reportFailure(stage, detail) {
  try {
    ipcRenderer.send('col:diag', { stage, detail: detail || null });
  } catch {
    // 破棄済みなら無視
  }
}

function errorMessage(err) {
  return (err && err.message) || String(err);
}

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
  } catch (err) {
    // 汎用の定義で動き続けるが、サービス専用の判定（画像・新着）は効かなくなる
    reportFailure('definition.parse-failed', { message: errorMessage(err) });
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
    } catch (err) {
      // 定義が合わなくなっても落とさない。ただし記録は残す
      reportFailure('scan.error', { message: errorMessage(err) });
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
/**
 * 画像の中から、実際に見えている URL を取り出す。
 * img が無ければ背景画像も見る（サービスによってはそちらで出している）。
 */
function mediaSource(el) {
  const img = el.matches('img') ? el : el.querySelector('img');
  if (img && (img.currentSrc || img.src)) return img.currentSrc || img.src;

  const bg = getComputedStyle(el).backgroundImage;
  const m = bg && bg.match(/url\(["']?(.+?)["']?\)/);
  return m ? m[1] : null;
}

/**
 * 開く候補の URL を、良い順に並べて返す。
 *
 * サービスは同じ画像をいくつもの大きさで配っている。表示に使われているのは
 * たいてい縮小版なので、そのまま開くと粗い。定義の image.candidates を
 * 上から当てて候補を作り、最後に元の URL を置く。
 * 実際にどれを使うかは、開ける最初のものを表示側が選ぶ。
 */
function imageCandidates(src) {
  const rules = (SERVICE.image && SERVICE.image.candidates) || [];
  const out = [];

  for (const [pattern, replacement] of rules) {
    try {
      const url = src.replace(new RegExp(pattern), replacement);
      if (url !== src && !out.includes(url)) out.push(url);
    } catch {
      // 定義側が壊れていても、他の候補で続ける
    }
  }

  out.push(src); // どれも開けなければ、表示されているものをそのまま
  return out;
}

/**
 * その要素が属する投稿の、恒久リンクを返す。
 *
 * 投稿を見分ける鍵として既に使っている post.key（X なら /status/ を含む
 * リンク）をそのまま使う。相対パスで書かれているので絶対 URL に直す。
 */
function postPermalink(el) {
  let post = null;
  try {
    post = el.closest ? el.closest(postSelector()) : null;
  } catch {
    return null;
  }
  if (!post) return null;

  const rule = (SERVICE.post && SERVICE.post.key) || {};
  if (!rule.selector || !rule.attr) return null;

  let href = null;
  try {
    const target = post.querySelector(rule.selector);
    href = target && target.getAttribute(rule.attr);
  } catch {
    return null;
  }
  if (!href) return null;

  try {
    const url = new URL(href, location.href).href;
    return /^https?:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** その要素と祖先に付いている data-testid を、近い順に集める（サービス側の部品名。本文は含まない）。 */
function testidsAround(el, stop) {
  const out = [];
  for (let node = el, depth = 0; node && node !== stop && depth < 10; node = node.parentElement, depth += 1) {
    const id = node.getAttribute && node.getAttribute('data-testid');
    if (id) out.push(id.slice(0, 40));
  }
  return out;
}

// 利用者が押した画像のうち、この大きさに満たないもの（アイコン・絵文字）は見ない
const UNMATCHED_MIN_PX = 80;

/**
 * 画像らしいものが押されたのに、定義の media に当たらなかったときに記録する。
 *
 * サービスがページの作りを変えると、拡大は何も言わずに起動しなくなる。
 * そのときにこの記録が出る。投稿の中の、ある程度大きい画像だけを対象にする。
 * リンクカードの画像なども拾うので、testids を見て見分ける。
 */
function noteUnmatchedImageClick(target) {
  if (!target || !target.closest) return;

  let post = null;
  try {
    post = target.closest(postSelector());
  } catch {
    post = null;
  }
  // 投稿の目印そのものが外れたときにも気づけるよう、一般的な記事の枠も見る
  const scope = post || target.closest('article, [role="article"]');
  if (!scope) return;

  let img = null;
  for (let node = target, depth = 0; node && node !== scope && depth < 5; node = node.parentElement, depth += 1) {
    img = node.matches('img') ? node : node.querySelector('img');
    if (img) break;
  }
  if (!img || !/^https?:/.test(img.currentSrc || img.src || '')) return;

  const r = img.getBoundingClientRect();
  if (r.width < UNMATCHED_MIN_PX || r.height < UNMATCHED_MIN_PX) return;

  reportFailure('media.unmatched', {
    postMatched: !!post,
    testids: testidsAround(img, scope.parentElement),
    size: Math.round(r.width) + 'x' + Math.round(r.height),
  });
}

function onMediaClick(e) {
  let media = null;
  try {
    media = e.target && e.target.closest ? e.target.closest(SERVICE.media) : null;
  } catch (err) {
    reportFailure('media.selector-invalid', { message: errorMessage(err) });
    return;
  }
  if (!media) {
    noteUnmatchedImageClick(e.target);
    return;
  }

  // 画像なら、ドックの外に大きく開く。
  // カラムは細いので、この中で開いても大きくならないため。
  const src = mediaSource(media);
  if (src && !/^blob:/.test(src)) {
    e.preventDefault();
    e.stopPropagation();
    try {
      ipcRenderer.send('col:image', {
        sources: imageCandidates(src),
        post: postPermalink(media),
      });
    } catch (err) {
      reportFailure('media.send-failed', { message: errorMessage(err) });
    }
    return;
  }

  // 画像の枠に当たったのに、表示中の画像を取り出せなかった（動画は除く）
  if (!src && !media.querySelector('video')) {
    reportFailure('media.no-source', {
      tag: media.tagName.toLowerCase(),
      hasImg: !!media.querySelector('img'),
      testids: testidsAround(media, null),
    });
  }

  // 画像を取り出せないもの（動画など）は、これまで通りその場で開く。
  if (media.hasAttribute('data-tld-expanded')) return;
  // 実際に切り詰められている場合だけ横取りする。
  // そうでないときは投稿を開くなど本来の動作を邪魔しない。
  if (media.scrollHeight <= media.clientHeight + 4) return;
  e.preventDefault();
  e.stopPropagation();
  media.setAttribute('data-tld-expanded', '1');
}

function setupMediaExpand() {
  if (!SERVICE.media) return;
  document.addEventListener(
    'click',
    (e) => {
      try {
        onMediaClick(e);
      } catch (err) {
        reportFailure('media.handler-error', { message: errorMessage(err) });
      }
    },
    true
  );
}

/* ------------------------------------------------------------------ *
 * 表示するタブの固定
 * ------------------------------------------------------------------ */

// X のホームは開くたび「おすすめ」に戻る。定義に tab があれば、
// **開いたときに 1 回だけ**、指定された見出しのタブへ切り替える。
//
// 「開いたとき」＝ページの読み込み・読み込み直し（プリロードが作り直される）と、
// 別の画面からその画面へ移ったとき（SPA なので pathname の変化で見る）。
// 一度目的のタブになったら、同じ画面にいる間は触らない。利用者が自分で
// 「おすすめ」を選び直しても押し戻さない（2026-09-16 CEO 室裁定。公開した記載
// 「フォロー中で開く」より強い動きにしない）。
//
// 押しても変わらない作りに変わっていた場合に叩き続けないよう、回数で打ち切る。
const TAB_MAX_TRIES = 5;
let tabTries = 0;
let tabPath = null;
let tabDone = false;          // この画面では済んだ（切り替え成立／打ち切り／利用者が選んだ）
let tabSwitched = false;      // 私たちの切り替えが一度でも効いた。以後の別タブ選択は利用者の操作
let tabWatchRoot = null;      // いま選択変化を見張っているタブ帯
let tabWatcher = null;

function tabLabel(el) {
  return el ? (el.innerText || el.getAttribute('aria-label') || '').trim() : '';
}

function isTabTarget(el, rule) {
  const text = tabLabel(el);
  if (!text || text.length > 40) return false;
  return rule.labels.some((l) => text === l || text.includes(l));
}

// 目的のタブが選ばれた「瞬間」を取りこぼさないための見張り。
//
// 5 秒ごとのポーリングだけだと、私たちが切り替えた直後に利用者が元のタブへ戻した
// 場合、ポーリングの隙間で「切り替わった」事実が見えないまま「選択＝元のタブ」しか
// 観測できず、切り替え失敗と読み違えて押し戻してしまう（2026-09-16 判定 指摘1、
// T6・T7。読み込み直後 1〜2 秒・画面移動後 最大 5 秒の窓）。
// 選択属性の変化をその場で拾い、一度でも目的タブになったら tabSwitched を立てておく。
function watchTabSelection(root, rule) {
  if (!root || root === tabWatchRoot) return;
  if (tabWatcher) tabWatcher.disconnect();
  tabWatchRoot = root;
  const selectedAttr = rule.selected || 'aria-selected';
  const item = rule.item || '[role="tab"]';
  tabWatcher = new MutationObserver(() => {
    if (tabSwitched) return;
    let items;
    try {
      items = root.querySelectorAll(item);
    } catch {
      return;
    }
    for (const el of items) {
      if (el.getAttribute(selectedAttr) !== 'true') continue;
      if (isTabTarget(el, rule)) tabSwitched = true;
      break; // 選択は 1 つだけ
    }
  });
  try {
    tabWatcher.observe(root, { attributes: true, attributeFilter: [selectedAttr], subtree: true });
  } catch {
    tabWatcher = null;
    tabWatchRoot = null;
  }
}

function keepTab() {
  const rule = SERVICE.tab;
  if (!rule || !rule.labels || !rule.labels.length) return;

  // 画面を移ったら「開いたとき」として数え直す（SPA なのでプリロードは作り直されない）
  if (tabPath !== location.pathname) {
    tabPath = location.pathname;
    tabTries = 0;
    tabDone = false;
    tabSwitched = false;
  }

  // タイムライン以外（個別の投稿や設定画面）では触らない
  if (rule.paths && rule.paths.length && !anyPathMatch(rule.paths)) return;

  // この画面ではもう済んでいる。利用者の選んだタブをそのままにする
  if (tabDone) return;

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
    if (isTabTarget(el, rule)) target = el;
  }

  if (!target) return;          // まだ出ていない、または見出しが変わった

  // このタブ帯の選択変化を見張る（私たちの切り替えが効いた瞬間を取りこぼさないため）
  watchTabSelection(list, rule);

  if (target === selected) {    // 目的のタブになった。この画面ではもう触らない
    tabDone = true;
    return;
  }

  // 一度でも切り替えが効いていれば、目的でない選択は利用者が自分でしたもの。
  // 同じページを開いている間は押し戻さない（2026-09-16 CEO 室裁定 十の3の1）。
  if (tabSwitched) {
    tabDone = true;
    return;
  }

  // ここまで来て目的タブが選ばれていないのは、まだ一度も切り替わっていないため。
  // 押しても変わらない作りに変わっていた場合に叩き続けないよう、回数で打ち切る。
  if (tabTries >= TAB_MAX_TRIES) {
    tabDone = true;
    return;
  }

  tabTries += 1;
  target.click();
  // 同期で選択が変わる作りなら、この場で切り替え成立を確定する（見張りの取りこぼし対策）。
  if (target.getAttribute(selectedAttr) === 'true') {
    tabSwitched = true;
    tabDone = true;
  }
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

/**
 * 右クリックしたときに、その場所にある投稿・リンク・画像をメインへ伝える。
 * 埋め込んだページには既定のメニューが出ないので、こちらで用意する。
 */
function setupContextMenu() {
  document.addEventListener(
    'contextmenu',
    (e) => {
      const t = e.target;
      if (!t || !t.closest) return;

      let link = null;
      try {
        const a = t.closest('a[href]');
        const href = a && a.getAttribute('href');
        if (href) {
          const url = new URL(href, location.href).href;
          if (/^https?:\/\//.test(url)) link = url;
        }
      } catch {
        link = null;
      }

      let image = null;
      try {
        const media = t.closest(SERVICE.media || 'img');
        const src = media ? mediaSource(media) : null;
        if (src && /^https?:\/\//.test(src)) image = imageCandidates(src)[0];
      } catch {
        image = null;
      }

      e.preventDefault();
      try {
        ipcRenderer.send('col:context', { post: postPermalink(t), link, image });
      } catch (err) {
        reportFailure('context.send-failed', { message: errorMessage(err) });
      }
    },
    true
  );
}

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
  } catch (err) {
    reportFailure('scan.error', { message: errorMessage(err) });
  }
  setTimeout(() => {
    armed = true;
  }, 5000);

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // CSS だけで出入りする要素は MutationObserver で拾えないので、取りこぼし用に低頻度で見る。
  setInterval(scheduleScan, 15000);

  setupMediaExpand();
  setupContextMenu();

  // 描画が遅いサイトがあるので、間隔を空けて数回報告する。
  reportAuthState();
  for (const delay of [3000, 10000]) setTimeout(reportAuthState, delay);

  // タブは描き終わるまで出てこないので、最初だけ短い間隔でも試す
  for (const delay of [800, 2500, 6000]) {
    setTimeout(() => {
      try {
        keepTab();
      } catch (err) {
        reportFailure('tab.error', { message: errorMessage(err) });
      }
    }, delay);
  }

  // 5 秒ごとに回るので、同じ失敗が続いても記録はメイン側で数回に抑える
  setInterval(() => {
    try {
      checkLive();
    } catch (err) {
      reportFailure('live.error', { message: errorMessage(err) });
    }
    try {
      keepTab();
    } catch (err) {
      reportFailure('tab.error', { message: errorMessage(err) });
    }
  }, 5000);

  ipcRenderer.on('col:autofill', (_e, creds) => {
    if (creds && creds.username && creds.password) {
      try {
        fillOnly(creds);
      } catch (err) {
        // 画面構造が想定と違っても落とさない。入力値は送らない
        reportFailure('autofill.error', { message: errorMessage(err) });
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
