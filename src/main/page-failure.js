/* ページ側（カラムのプリロード・画像の表示窓）で起きた失敗を記録する決まり。
 *
 * 主プロセスの例外は error.log に残るが、クリックを拾う処理などはページの中で
 * 動いていて、そこで失敗しても何も残らなかった。2026-09-16 の「画像の拡大が
 * 止まっている」では、どの段で止まったのかを後から確かめる手がかりが無かった。
 *
 * ここは electron に依存させない（node だけで確かめられるように）。
 *
 * 決まり:
 *   - 同じ段の失敗は、1 回の起動につき最初の数回だけ書く。
 *     常駐アプリなので、クリックや定期処理のたびに記録を太らせない。
 *   - 記録は「不具合を報告する」から公開の場所へ貼られる。
 *     URL や本文は載せない。載せるのは段の名前と、形の手がかり（数・真偽・短い識別子）だけ。
 */

const MAX_KEYS = 8;
const MAX_STRING = 120;

/** 段の名前。英数字と . : - _ / だけにする（ページ側から任意の文字列を書かせない）。 */
function cleanStage(stage) {
  const s = String(stage == null ? '' : stage).replace(/[^\w.:/-]/g, '').slice(0, 60);
  return s || 'unknown';
}

function cleanString(value) {
  return String(value)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<URL>') // 投稿やアカウントが分かる URL を残さない
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, MAX_STRING);
}

/** 手がかりを、数・真偽・短い文字列だけの 1 行にする。入れ子は捨てる。 */
function cleanDetail(detail) {
  if (detail == null) return '';
  if (typeof detail !== 'object') return cleanString(detail);

  const parts = [];
  for (const key of Object.keys(detail).slice(0, MAX_KEYS)) {
    const name = cleanStage(key);
    const value = detail[key];
    let text = null;
    if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
    else if (typeof value === 'string') text = JSON.stringify(cleanString(value));
    else if (Array.isArray(value)) {
      text = JSON.stringify(cleanString(value.filter((v) => ['string', 'number', 'boolean'].includes(typeof v)).join(',')));
    }
    if (text !== null) parts.push(name + '=' + text);
  }
  return parts.join(' ');
}

/**
 * @param {(kind: string, text: string) => void} write 実際に書く関数（main.js の recordError）
 * @param {{ perStage?: number }} [options]
 */
function createPageFailureRecorder(write, { perStage = 3 } = {}) {
  const counts = new Map();

  return function recordPageFailure(source, stage, detail) {
    const key = cleanStage(source) + '/' + cleanStage(stage);
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > perStage) return false;

    const extra = cleanDetail(detail);
    const tail = n === perStage ? '（この起動中、同じ段の記録はここまで）' : '';
    write('page', key + (extra ? ' ' + extra : '') + tail);
    return true;
  };
}

module.exports = { createPageFailureRecorder, cleanDetail, cleanStage };
