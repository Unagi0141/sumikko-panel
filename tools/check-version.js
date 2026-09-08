// 配布ページの版表記が、実際に配る版と合っているかを確かめる。
//
//   node tools/check-version.js      （npm run check:version）
//
// npm run dist の前に自動で走ります（package.json の predist）。
// 食い違っていればビルドを始めずに止まります。
//
// なぜこれがあるか:
//   配布ページのダウンロードボタンは releases/latest を指しています。
//   つまりリリースした瞬間、ボタンは新しい版を渡します。
//   ページの版表記だけが古いままだと、「v0.9.13 と書いてあるボタンが
//   v0.9.14 を渡す」状態になります。ページが、配っている物について
//   事実と違うことを言う——これは 2026-09-08 に実際に起きた事故と同じ形です。
//   人が覚えている限り必ずまた忘れるので、機械に見張らせます。
//
// このスクリプトは docs/index.html を読むだけで、書き換えません。
// （docs/ は事業開発部の所有です。直すのは人の判断で行ってください。）

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const PKG = path.join(root, 'package.json');
const PAGE = path.join(root, 'docs', 'index.html');
const SETUP = path.join(root, 'dist', 'SumikkoPanel-Setup.exe');
const LATEST = path.join(root, 'dist', 'latest.yml');

// 「v0.9.14 ベータ · 約 106 MB」のような表記を拾う
const VERSION_RE = /v(\d+\.\d+\.\d+)/g;
const SIZE_RE = /約\s*(\d+)\s*MB/;

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function run() {
  const expected = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
  const html = fs.readFileSync(PAGE, 'utf8');

  const found = [];
  let m;
  while ((m = VERSION_RE.exec(html)) !== null) {
    found.push({ version: m[1], line: lineOf(html, m.index) });
  }

  // 1 つも見つからないのは「合っている」ではなく「見失った」。
  // 黙って通すと、この検査そのものが意味を失う。
  if (found.length === 0) {
    console.error('版表記が docs/index.html に 1 つも見つかりませんでした。');
    console.error('ページの書き方が変わったか、表記が消えています。');
    console.error('この検査が空振りしている状態なので、tools/check-version.js を見直してください。');
    process.exit(1);
  }

  const wrong = found.filter((f) => f.version !== expected);
  if (wrong.length > 0) {
    console.error(`版表記が package.json と食い違っています（package.json は ${expected}）。`);
    for (const f of wrong) {
      console.error(`  docs/index.html:${f.line}  v${f.version} → v${expected} に直してください`);
    }
    console.error('');
    console.error('配布ページのボタンは releases/latest を指すので、直さずに公開すると');
    console.error(`「v${wrong[0].version} と書いてあるボタンが v${expected} を渡す」状態になります。`);
    process.exit(1);
  }

  console.log(`版表記は一致しています: v${expected}（docs/index.html の ${found.length} 箇所）`);

  // ここから先は参考。止めはしない。
  if (fs.existsSync(SETUP)) {
    const mb = Math.round(fs.statSync(SETUP).size / 1024 / 1024);
    const s = html.match(SIZE_RE);
    if (s && Math.abs(Number(s[1]) - mb) > 2) {
      console.log('');
      console.log(`参考: ページの大きさの表記は 約 ${s[1]} MB ですが、手元の`);
      console.log(`      dist/SumikkoPanel-Setup.exe は 約 ${mb} MB です。`);
      console.log('      （npm run dist の前に走った場合、手元の exe は 1 つ前の版です）');
    }
  }
  if (fs.existsSync(LATEST)) {
    const y = fs.readFileSync(LATEST, 'utf8').match(/^version:\s*(\S+)/m);
    if (y && y[1] !== expected) {
      console.log('');
      console.log(`参考: dist/latest.yml は v${y[1]} です。リリースに添付する前に`);
      console.log('      npm run dist でビルドし直してください。');
    }
  }
}

run();
