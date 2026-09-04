// SNS に貼られたときに出る横長の画像（1200x630）を作る。
//
//   npm run og
//
// tools/og-template.html を Electron でそのまま開いて写真に撮り、
// docs/og.png として保存します。配布ページと同じ CSS で描いているので、
// ページの見た目を変えたらここも撮り直してください。
//
// 画像編集ソフトは要りません。Electron はアプリ本体で既に使っています。

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, 'og-template.html');
const OUT = path.join(__dirname, '..', 'docs', 'og.png');
const WIDTH = 1200;
const HEIGHT = 630;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true, // 枠を含めない。ぴったり 1200x630 で撮るため
    show: false,
    frame: false,
    backgroundColor: '#f3f5f9',
    webPreferences: { backgroundThrottling: false },
  });

  try {
    await win.loadFile(TEMPLATE);

    // Web フォントが届く前に撮ると、別の書体で写ってしまう
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    await new Promise((r) => setTimeout(r, 400));

    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    if (png.length < 1000) throw new Error('撮れた画像が小さすぎます');

    fs.writeFileSync(OUT, png);
    const { width, height } = image.getSize();
    console.log(`docs/og.png を書きました（${width}x${height}, ${(png.length / 1024).toFixed(0)} KB）`);
  } catch (err) {
    console.error('作れませんでした:', err.message);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});
