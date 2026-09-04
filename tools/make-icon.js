// アプリのアイコンを作る。
//
//   npm run icon
//
// tools/icon-template.html を Electron でサイズごとに開いて写真に撮り、
// assets/ へ PNG と ICO を書き出します。画像編集ソフトは要りません。
//
// 図柄を変えたいときは icon-template.html をいじってから実行してください。
// 小さいサイズでは細部を落とす作りにしてあります（16px で模様は潰れるため）。

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, 'icon-template.html');
const OUT_DIR = path.join(__dirname, '..', 'assets');
const PAGE_ICON = path.join(__dirname, '..', 'docs', 'icon-256.png');

// ICO には Windows が使う代表的なサイズを詰めておく。
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// 単体の PNG として要るもの（トレイと配布ページ）
const PNG_FILES = [
  ['tray.png', 16],
  ['tray@2x.png', 32],
  ['icon-64.png', 64],
  ['icon-128.png', 128],
  ['icon-256.png', 256],
];

app.disableHardwareAcceleration();

/**
 * 図柄を開いておく窓を 1 枚だけ作る。
 *
 * サイズごとに窓を作り直すと、2 枚目以降の読み込みが ERR_FAILED で落ちる
 * （透過窓を短い間隔で開け閉めしたときに起きる）。窓は使い回して、
 * 中身だけ入れ替える。
 *
 * 描くのは常に 256px。16px の窓に小さく描いても線が潰れるだけなので、
 * 大きく描いてから縮める。
 */
function makeWindow() {
  return new BrowserWindow({
    width: 256,
    height: 256,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true, // 角の外側を透過させる
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false },
  });
}

/** 目的のサイズ向けに 1 枚撮る。 */
async function shoot(win, size) {
  await win.loadFile(TEMPLATE, { search: 'detail=' + size });
  await new Promise((r) => setTimeout(r, 120));

  const shot = await win.webContents.capturePage();
  if (shot.isEmpty()) throw new Error(`${size}px を撮れませんでした`);
  return size === 256 ? shot : shot.resize({ width: size, height: size, quality: 'best' });
}

/** PNG を並べて ICO に詰める。Vista 以降は各面が PNG のままで通る。 */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 256 は 0 で表す
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // パレット数（真彩色なので 0）
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // 必要なサイズを一通り撮っておく
    const sizes = [...new Set([...ICO_SIZES, ...PNG_FILES.map(([, s]) => s)])].sort((a, b) => a - b);
    const shots = new Map();
    const win = makeWindow();
    try {
      for (const size of sizes) shots.set(size, await shoot(win, size));
    } finally {
      win.destroy();
    }

    const written = [];
    for (const [name, size] of PNG_FILES) {
      const data = shots.get(size).toPNG();
      fs.writeFileSync(path.join(OUT_DIR, name), data);
      written.push(`${name} (${data.length} bytes)`);
    }

    const icoData = ico(ICO_SIZES.map((size) => ({ size, data: shots.get(size).toPNG() })));
    fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), icoData);
    written.push(`icon.ico (${icoData.length} bytes)`);

    // 配布ページの favicon も同じ絵にしておく。別物だと落ち着かない。
    fs.copyFileSync(path.join(OUT_DIR, 'icon-256.png'), PAGE_ICON);
    written.push('docs/icon-256.png');

    console.log('書き出しました:');
    for (const line of written) console.log('  ' + line);
  } catch (err) {
    console.error('作れませんでした:', err.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
