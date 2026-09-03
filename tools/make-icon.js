// 依存なしで assets/ のアイコン一式（PNG と ICO）を生成する。
//
//   tray.png / tray@2x.png   トレイ用
//   icon-64 / -128 / -256    アプリ用 PNG
//   icon.ico                 ショートカットとインストーラ用（Vista 以降は PNG 埋め込みでよい）
//
// 図柄は「画面端のドックに 2 本のカラムが横に並んでいる」ところ。
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * PNG 書き出し
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, painter) {
  const px = Buffer.alloc(size * size * 4, 0);
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
  };
  painter(set, size);

  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    px.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * ICO 書き出し（各サイズの PNG をそのまま格納する形式）
 * ------------------------------------------------------------------ */

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(images.length, 4);  // count

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;  // 256 は 0 で表す
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;                       // パレット数（真彩色なので 0）
    e[3] = 0;                       // reserved
    e.writeUInt16LE(1, 4);          // color planes
    e.writeUInt16LE(32, 6);         // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

/* ------------------------------------------------------------------ *
 * 図柄
 * ------------------------------------------------------------------ */

function inRoundRect(x, y, rx, ry, rw, rh, r) {
  if (x < rx || y < ry || x >= rx + rw || y >= ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - 1 - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.5;
}

// 32x32 を基準に設計し、他のサイズへは倍率で伸ばす。
function paint(set, size) {
  const s = size / 32;
  const small = size <= 20; // 小さいサイズでは線が潰れるので余白を詰める
  const pad = small ? 1 : 3;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // ドック本体（画面端の暗い板）
      if (inRoundRect(x, y, pad * s, 2 * s, (28 - pad * 2 + 2) * s, 28 * s, 4 * s)) {
        set(x, y, 24, 28, 35, 255);
      }
      // 左のカラム
      if (inRoundRect(x, y, (pad + 2) * s, 5 * s, 10 * s, 22 * s, 2 * s)) {
        set(x, y, 96, 165, 250, 255);
      }
      // 右のカラム
      if (inRoundRect(x, y, (pad + 14) * s, 5 * s, 10 * s, 22 * s, 2 * s)) {
        set(x, y, 148, 163, 184, 255);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 出力
 * ------------------------------------------------------------------ */

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const written = [];
function write(name, buf) {
  fs.writeFileSync(path.join(outDir, name), buf);
  written.push(`${name} (${buf.length} bytes)`);
}

write('tray.png', png(16, paint));
write('tray@2x.png', png(32, paint));
write('icon-64.png', png(64, paint));
write('icon-128.png', png(128, paint));
write('icon-256.png', png(256, paint));

// ICO には Windows が使う代表的なサイズを詰めておく。
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
write('icon.ico', ico(icoSizes.map((size) => ({ size, data: png(size, paint) }))));

console.log('assets へ出力しました:');
for (const line of written) console.log('  ' + line);
