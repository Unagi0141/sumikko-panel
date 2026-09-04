// 配布ページの「文章として直したい要素」に印（data-k）を付ける。
//
//   node tools/tag-editable.js
//
// 何度実行しても安全です。すでに印が付いているものは触らず、
// 新しく増えた要素にだけ番号を振ります。番号が変わらないので、
// 編集ツールが保存先を見失いません。

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'docs', 'index.html');

// 文章として直す対象。構造（div や section）には付けない。
const TAGS = ['h1', 'h2', 'h3', 'p', 'li', 'dt', 'dd', 'figcaption', 'small', 'span'];

function run() {
  let html = fs.readFileSync(FILE, 'utf8');

  const bodyStart = html.indexOf('<body>');
  const bodyEnd = html.indexOf('</body>');
  if (bodyStart === -1 || bodyEnd === -1) {
    console.error('body が見つかりません。');
    process.exit(1);
  }

  const head = html.slice(0, bodyStart);
  let body = html.slice(bodyStart, bodyEnd);
  const tail = html.slice(bodyEnd);

  // すでに使われている番号を拾い、続きから振る
  let next = 1;
  for (const m of body.matchAll(/data-k="e(\d+)"/g)) {
    next = Math.max(next, Number(m[1]) + 1);
  }

  let added = 0;
  const opening = new RegExp(`<(${TAGS.join('|')})(\\s[^>]*?)?>`, 'g');

  body = body.replace(opening, (full, tag, attrs = '') => {
    if (attrs && attrs.includes('data-k=')) return full;      // すでに印がある
    if (attrs && attrs.includes('data-no-edit')) return full;  // 明示的に対象外
    added += 1;
    const key = `e${next++}`;
    return `<${tag}${attrs || ''} data-k="${key}">`;
  });

  if (added === 0) {
    console.log('新しく印を付ける要素はありませんでした。');
    return;
  }

  fs.writeFileSync(FILE, head + body + tail, 'utf8');
  console.log(`${added} 個の要素に印を付けました（e1〜e${next - 1}）。`);
}

run();
