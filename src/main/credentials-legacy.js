const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');

/**
 * 以前の配布版が保存したログイン情報の後始末。
 *
 * v0.9.4 から v0.9.13 までの配布版は、features.js の既定が反転していたため
 * ログイン情報の保存機能を積んだ状態で配られていた。配布ページと README には
 * 「保存しません」と書いてある。書いてあるほうを正とし、実装を戻した。
 *
 * ただし既定を戻しただけでは足りない。credentials.js を読み込まなくなるので、
 * 既に保存されたファイルは「誰も触らないまま、利用者の PC に残り続ける」。
 * 機能が消えたので UI からも消せない。**預からないと書いておいて、預かったまま
 * 手が届かなくなる**のがいちばん悪い。だからここで後始末をする。
 *
 * 黙って消さない。消すのは利用者のデータで、取り消せないからである。
 * 断られたら残すが、そのまま忘れない。次の起動でまた尋ねる。
 * **黙って持ち続ける状態を作らない**のがこのモジュールの目的である。
 *
 * 中身は読まない。読めない（暗号文の復号は safeStorage が要る）し、読む理由も無い。
 * サービス名（JSON のキー）だけを、何が残っているかを伝えるために見る。
 */

const FILE_NAME = 'credentials.json'; // credentials.js が使っていたのと同じ名前

function file() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

/** 残骸があるか。無ければ何もしない。 */
function exists() {
  try {
    return fs.statSync(file()).isFile();
  } catch {
    return false;
  }
}

/** 何のサービスの分が残っているか。パスワードには触れない。 */
function serviceNames() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!raw || typeof raw !== 'object') return [];
    return Object.keys(raw).filter((k) => typeof k === 'string');
  } catch {
    return []; // 壊れていても、ファイルがある以上は消す対象になる
  }
}

function remove() {
  try {
    fs.unlinkSync(file());
    console.log('[credentials-legacy] 以前の版が保存したログイン情報を削除しました。');
    return true;
  } catch (err) {
    console.error('[credentials-legacy] 削除に失敗しました:', err.message);
    return false;
  }
}

/**
 * 残骸があれば尋ね、同意が取れたら消す。
 * 機能を積んでいない（features.credentials === false）ときだけ呼ぶこと。
 *
 * @param {import('electron').BrowserWindow|null} parent 親ウインドウ（無くてもよい）
 */
async function offerRemoval(parent) {
  if (!exists()) return { asked: false, removed: false };

  const names = serviceNames();
  const target = names.length ? names.join('、') : '（読み取れませんでした）';

  const detail = [
    'v0.9.4 から v0.9.13 までの配布版には、ログイン情報（ID とパスワード）を',
    'この PC に保存する機能が入っていました。配布ページと README には',
    '「保存しません」と書いてありました。書いてあるほうが正しく、実装のほうが',
    '誤りでしたので、この版で保存の機能を取り外しました。',
    '',
    '以前に保存されたものが、この PC に残っています。',
    '  場所: ' + file(),
    '  対象: ' + target,
    '',
    '削除してよろしいですか。',
    '',
    '削除しても、いま開いているタイムラインのログイン状態は切れません。',
    '次にログイン画面が出たときに、ID とパスワードを手で入力していただくことに',
    'なります。「今回は残す」を選んだ場合は、次の起動でまたお尋ねします。',
  ].join('\n');

  const options = {
    type: 'warning',
    noLink: true,
    title: 'すみっこパネル',
    message: '以前の版が保存したログイン情報が残っています',
    detail,
    buttons: ['削除する（おすすめ）', '今回は残す'],
    defaultId: 0,
    cancelId: 1,
  };

  let response = 1;
  try {
    const result = parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    response = result.response;
  } catch (err) {
    // 尋ねられなかったときに勝手に消さない。次の起動でまた尋ねる。
    console.error('[credentials-legacy] 確認の表示に失敗しました:', err.message);
    return { asked: false, removed: false };
  }

  if (response !== 0) {
    console.log('[credentials-legacy] 利用者が保留を選びました。次の起動でまた尋ねます。');
    return { asked: true, removed: false };
  }

  return { asked: true, removed: remove() };
}

module.exports = { exists, serviceNames, offerRemoval, filePath: file };
