// 配布ページを見ながら書き換えるための簡易サーバー。
//
//   npm run page
//
// ブラウザが開き、docs/ の中を保存するたびに自動で再読み込みされます。
// 追加のパッケージは要りません（この方針でここまで作っているため）。
//
// 止めるときは Ctrl+C。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..', 'docs');
const PAGE = path.join(ROOT, 'index.html');
const PORT = Number(process.env.PORT) || 4173;
// --edit を付けると、ページ上で文章を直せるようになる
const EDIT = process.argv.includes('--edit');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// 保存を検知したら、開いているブラウザへ知らせるための口
const listeners = new Set();

// HTML の末尾に差し込む再読み込み用の小さなスクリプト
const RELOAD_SNIPPET = `
<script>
(() => {
  // 保存されたら再読み込みする。スクロール位置は覚えておく。
  const KEY = '__page_scroll__';
  const saved = sessionStorage.getItem(KEY);
  if (saved !== null) {
    sessionStorage.removeItem(KEY);
    addEventListener('load', () => window.scrollTo(0, Number(saved)));
  }
  const es = new EventSource('/__reload');
  es.onmessage = () => {
    sessionStorage.setItem(KEY, String(window.scrollY));
    location.reload();
  };
})();
</script>
`;

/**
 * data-k="キー" が付いた要素の中身とクラスを差し替える。
 *
 * DOM を丸ごと書き戻すと、ファイル内の説明コメントや整形が失われる。
 * ここでは目的の要素だけを、開きタグから対応する閉じタグまで数えて置き換える。
 */
function applyEdits(html, edits) {
  let applied = 0;

  for (const { key, html: inner, cls } of edits) {
    // 開きタグを探す
    const open = new RegExp('<([a-zA-Z0-9]+)([^>]*\\bdata-k="' + key + '"[^>]*)>');
    const m = html.match(open);
    if (!m) continue;

    const tag = m[1];
    const attrs = m[2];
    const startTag = m.index;
    const contentStart = startTag + m[0].length;

    // 同じタグの入れ子を数えながら、対応する閉じタグを探す
    const scan = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'g');
    scan.lastIndex = contentStart;
    let depth = 1;
    let contentEnd = -1;
    let after = -1;
    let t;
    while ((t = scan.exec(html))) {
      depth += t[1] === '/' ? -1 : 1;
      if (depth === 0) {
        contentEnd = t.index;
        after = t.index + t[0].length;
        break;
      }
    }
    if (contentEnd === -1) continue;

    // 揃えと余白のクラスを入れ替える（それ以外のクラスは残す）
    const keep = (attrs.match(/class="([^"]*)"/) || [, ''])[1]
      .split(/\s+/)
      .filter((c) => c && !c.startsWith('tp-'))
      .join(' ');
    const merged = [keep, cls].filter(Boolean).join(' ').trim();

    let newAttrs = attrs.replace(/\s*class="[^"]*"/, '');
    if (merged) newAttrs += ` class="${merged}"`;

    html =
      html.slice(0, startTag) +
      `<${tag}${newAttrs}>` +
      inner +
      html.slice(contentEnd, after) +
      html.slice(after);
    applied += 1;
  }

  return { html, applied };
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  // 再読み込みの通知路
  if (url === '/__reload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('\n');
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
    return;
  }

  // 編集内容の受け取り
  if (url === '/__save' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        const { edits } = JSON.parse(raw);
        if (!Array.isArray(edits) || !edits.length) throw new Error('編集内容が空です');

        const before = fs.readFileSync(PAGE, 'utf8');
        // 上書きする前に必ず控えを取る
        fs.writeFileSync(PAGE + '.bak', before, 'utf8');

        const { html, applied } = applyEdits(before, edits);
        fs.writeFileSync(PAGE, html, 'utf8');

        console.log(`  保存: ${applied} 箇所（控え: docs/index.html.bak）`);
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, applied }));
      } catch (err) {
        send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 編集ツール本体
  if (url === '/__editor.js') {
    return fs.readFile(path.join(__dirname, 'editor-client.js'), (err, data) =>
      err ? send(res, 404, 'text/plain', 'not found') : send(res, 200, MIME['.js'], data)
    );
  }

  // docs/ の外へ出させない
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 403, 'text/plain; charset=utf-8', '外は見せません');

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'text/plain; charset=utf-8', '見つかりません: ' + rel);

    const ext = path.extname(file).toLowerCase();
    if (ext === '.html') {
      let html = data.toString('utf8').replace('</body>', RELOAD_SNIPPET + '</body>');
      if (EDIT) html = html.replace('</body>', '<script src="/__editor.js"></script></body>');
      return send(res, 200, MIME['.html'], html);
    }
    send(res, 200, MIME[ext] || 'application/octet-stream', data);
  });
});

// 保存を検知する。エディタは一度の保存で何度もイベントを出すのでまとめる。
let debounce = null;
if (!EDIT) fs.watch(ROOT, { recursive: true }, (_event, filename) => {
  if (filename && filename.startsWith('.')) return; // 一時ファイルは無視
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    for (const res of listeners) res.write('data: reload\n\n');
    console.log('  再読み込み:', filename || '(不明)');
  }, 120);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log('配布ページを表示しています:', url);
  console.log('docs/ を保存すると自動で反映されます。止めるときは Ctrl+C。');
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], () => {});
  }
});
