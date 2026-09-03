// 開発中のまま使うためのデスクトップショートカットを作る。
//
// electron.exe を直接指すので、コンソール窓は出ない。
// インストーラ（npm run dist）で入れた場合は NSIS 側がショートカットを作るので、
// これは「まだパッケージしていないが、とりあえずアイコンから起動したい」用。
//
//   node tools/make-shortcut.js            デスクトップに作る
//   node tools/make-shortcut.js --remove   消す
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const NAME = 'すみっこパネル (開発版).lnk';
const root = path.resolve(__dirname, '..');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const icon = path.join(root, 'assets', 'icon.ico');
const desktop = path.join(os.homedir(), 'Desktop');
const linkPath = path.join(desktop, NAME);

if (process.platform !== 'win32') {
  console.error('このスクリプトは Windows 専用です。');
  process.exit(1);
}

if (process.argv.includes('--remove')) {
  if (fs.existsSync(linkPath)) {
    fs.unlinkSync(linkPath);
    console.log('削除しました:', linkPath);
  } else {
    console.log('ショートカットはありません:', linkPath);
  }
  process.exit(0);
}

if (!fs.existsSync(electronExe)) {
  console.error('electron が見つかりません。先に npm install を実行してください:', electronExe);
  process.exit(1);
}
if (!fs.existsSync(icon)) {
  console.error('アイコンがありません。先に npm run icon を実行してください:', icon);
  process.exit(1);
}
if (!fs.existsSync(desktop)) {
  console.error('デスクトップフォルダが見つかりません:', desktop);
  process.exit(1);
}

// PowerShell の WScript.Shell でショートカットを作る。
// パスに ' が含まれても壊れないよう、'' にエスケープしてから渡す。
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const script = [
  '$ws = New-Object -ComObject WScript.Shell',
  `$sc = $ws.CreateShortcut(${q(linkPath)})`,
  `$sc.TargetPath = ${q(electronExe)}`,
  `$sc.Arguments = ${q('"' + root + '"')}`,
  `$sc.WorkingDirectory = ${q(root)}`,
  `$sc.IconLocation = ${q(icon)}`,
  "$sc.Description = 'X / mixi2 のタイムラインを画面端に常駐させる'",
  '$sc.Save()',
].join('; ');

try {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'inherit',
    windowsHide: true,
  });
  console.log('作成しました:', linkPath);
  console.log('  起動対象:', electronExe);
  console.log('  引数    :', root);
} catch (err) {
  console.error('ショートカットの作成に失敗しました:', err.message);
  process.exit(1);
}
