const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// PowerShell は asar の中のファイルを実行できないので、パッケージ後は
// asarUnpack で外に出された実体を指す（package.json の build.asarUnpack を参照）。
const HELPER = path.join(__dirname, 'win32-helper.ps1').replace(
  `app.asar${path.sep}`,
  `app.asar.unpacked${path.sep}`
);

/**
 * win32-helper.ps1 を常駐の子プロセスとして抱え、行単位の JSON で会話する。
 * Windows 以外、あるいは PowerShell の起動に失敗した場合は available=false になり、
 * 呼び出しは静かに失敗する（アプリ自体は動き続ける）。
 */
class Win32Bridge extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.available = false;
    this.ready = false;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
  }

  start() {
    if (process.platform !== 'win32' || this.proc) return;
    try {
      this.proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (err) {
      console.error('[win32] ヘルパーを起動できませんでした:', err.message);
      return;
    }

    this.available = true;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.consume(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (text) => {
      const trimmed = text.trim();
      if (trimmed) console.error('[win32]', trimmed);
    });
    this.proc.on('exit', (code) => {
      this.available = false;
      this.ready = false;
      this.proc = null;
      for (const { reject } of this.pending.values()) reject(new Error('ヘルパーが終了しました'));
      this.pending.clear();
      this.emit('exit', code);
    });
    this.proc.on('error', (err) => {
      console.error('[win32] ヘルパーのエラー:', err.message);
      this.available = false;
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        console.error('[win32] 解釈できない出力:', line);
        continue;
      }
      if (msg.event === 'ready') {
        this.ready = true;
        this.emit('ready');
      } else if (msg.event) {
        this.emit(msg.event, msg.value);
      } else if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error || '不明なエラー'));
      }
    }
  }

  call(cmd, args = {}, { timeoutMs = 5000 } = {}) {
    if (!this.available || !this.proc) return Promise.reject(new Error('ヘルパーが動いていません'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, cmd, ...args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd} がタイムアウトしました`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(payload + '\n');
    });
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.stdin.end(); // stdin が閉じるとヘルパー側が AppBar を解除して終了する
    } catch {
      // すでに閉じている
    }
  }
}

// BaseWindow の HWND（リトルエンディアンのバッファ）を数値に変換する。
function hwndOf(win) {
  try {
    const buf = win.getNativeWindowHandle();
    return buf.length === 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
  } catch {
    return 0;
  }
}

module.exports = { Win32Bridge, hwndOf };
