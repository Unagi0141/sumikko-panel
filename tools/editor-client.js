// 配布ページを見たまま編集するための、ページ側の仕掛け。
// preview-page.js が ?edit=1 のときだけ差し込む。
//
// できること
//   ・文字をその場で書き換える（印の付いた要素だけ）
//   ・段落ごとに 揃え と 上下の余白 を変える
//   ・太字にする / 戻す
//   ・保存すると docs/index.html に書き戻す
//
// 構造（section や div）は触れないようにしてある。壊れると直すのが大変なため。

(() => {
  const changed = new Map(); // key -> { html, align, space }
  let current = null;

  /* ---------------- 見た目 ---------------- */

  const style = document.createElement('style');
  style.textContent = `
    /* 下端のツールバーがページの中身に被らないよう、その分だけ余白を足す */
    body { padding-bottom: 96px; }

    [data-k] { outline: 1px dashed transparent; outline-offset: 3px; transition: outline-color .12s; }
    [data-k]:hover { outline-color: rgba(120,160,255,.55); cursor: text; }
    [data-k].tp-on { outline: 2px solid #4b7bec; outline-offset: 3px; }

    #tp-bar {
      position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 6px; z-index: 2147483647;
      padding: 8px 10px; border-radius: 10px;
      background: #12161d; color: #e6eaf2; border: 1px solid #2c3542;
      box-shadow: 0 12px 34px -12px rgba(0,0,0,.7);
      font: 500 12px/1.4 "Yu Gothic UI", system-ui, sans-serif;
      max-width: calc(100vw - 24px); flex-wrap: wrap; justify-content: center;
    }
    #tp-bar button {
      appearance: none; border: 1px solid #2c3542; background: #1b212b; color: #dbe2ee;
      border-radius: 6px; padding: 5px 9px; font: inherit; cursor: pointer; white-space: nowrap;
    }
    #tp-bar button:hover { background: #262f3c; }
    #tp-bar button.on { background: #2f5fd0; border-color: #2f5fd0; color: #fff; }
    #tp-bar button.save { background: #1f8a52; border-color: #1f8a52; color: #fff; font-weight: 700; }
    #tp-bar button.save:disabled { opacity: .45; cursor: default; }
    #tp-bar .sep { width: 1px; height: 20px; background: #2c3542; margin: 0 3px; }
    #tp-bar .lbl { color: #8d97a6; padding: 0 2px; }
    #tp-msg { color: #8d97a6; min-width: 8em; }

    /* 揃えと余白。保存時にこのクラスごと書き出す */
    .tp-al-left   { text-align: left !important; }
    .tp-al-center { text-align: center !important; }
    .tp-al-right  { text-align: right !important; }
    .tp-al-just   { text-align: justify !important; text-justify: inter-character; }
    .tp-sp-0 { margin-top: 0 !important; margin-bottom: 0 !important; }
    .tp-sp-1 { margin-top: .4rem !important; margin-bottom: .4rem !important; }
    .tp-sp-2 { margin-top: 1rem !important; margin-bottom: 1rem !important; }
    .tp-sp-3 { margin-top: 2rem !important; margin-bottom: 2rem !important; }
  `;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'tp-bar';
  bar.innerHTML = `
    <span class="lbl">揃え</span>
    <button data-al="left">左</button>
    <button data-al="center">中央</button>
    <button data-al="right">右</button>
    <button data-al="just">両端</button>
    <span class="sep"></span>
    <span class="lbl">余白</span>
    <button data-sp="0">なし</button>
    <button data-sp="1">小</button>
    <button data-sp="2">中</button>
    <button data-sp="3">大</button>
    <span class="sep"></span>
    <button data-cmd="bold">太字</button>
    <span class="sep"></span>
    <button class="save" id="tp-save" disabled>保存</button>
    <span id="tp-msg">文字をクリックすると直せます</span>
  `;
  document.body.appendChild(bar);

  const msg = bar.querySelector('#tp-msg');
  const saveBtn = bar.querySelector('#tp-save');

  /* ---------------- 編集の受け付け ---------------- */

  const targets = [...document.querySelectorAll('[data-k]')];

  // 入れ子の内側だけを編集対象にする（外側を編集すると中の印ごと壊れるため）
  const editable = targets.filter((el) => !el.querySelector('[data-k]'));

  for (const el of editable) {
    // plaintext-only は Chrome が white-space: pre-wrap を強制するため、
    // 原文の字下げがそのまま表示されてしまう（CSS では上書きできない）。
    // true にしたうえで、貼り付けを平文に落として構造の混入を防ぐ。
    el.setAttribute('contenteditable', 'true');

    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text.replace(/\s+/g, ' '));
    });
    el.addEventListener('focus', () => select(el));
    el.addEventListener('input', () => mark(el));
    el.addEventListener('keydown', (e) => {
      // Enter で段落が増えると構造が崩れるので、改行は入れさせない
      if (e.key === 'Enter') e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    });
  }

  // 太字だけはリッチな編集を許す
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });

  function select(el) {
    if (current) current.classList.remove('tp-on');
    current = el;
    el.classList.add('tp-on');
    syncBar(el);
  }

  function mark(el) {
    const key = el.getAttribute('data-k');
    changed.set(key, {
      html: el.innerHTML,
      cls: classesOf(el),
    });
    saveBtn.disabled = false;
    msg.textContent = `${changed.size} 箇所を編集中`;
  }

  function classesOf(el) {
    // tp-on は「いま選んでいる」目印なので保存してはいけない。
    // 書き出すのは揃え（tp-al-）と余白（tp-sp-）だけ。
    return [...el.classList]
      .filter((c) => c.startsWith('tp-al-') || c.startsWith('tp-sp-'))
      .join(' ');
  }

  function syncBar(el) {
    for (const b of bar.querySelectorAll('button[data-al]')) {
      b.classList.toggle('on', el.classList.contains('tp-al-' + b.dataset.al));
    }
    for (const b of bar.querySelectorAll('button[data-sp]')) {
      b.classList.toggle('on', el.classList.contains('tp-sp-' + b.dataset.sp));
    }
  }

  bar.addEventListener('mousedown', (e) => {
    // ボタンを押しても編集中の場所を失わないようにする
    if (e.target.tagName === 'BUTTON') e.preventDefault();
  });

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.id === 'tp-save') return save();

    if (btn.dataset.cmd === 'bold') {
      document.execCommand('bold');
      if (current) mark(current);
      return;
    }

    if (!current) {
      msg.textContent = '先に直したい文字をクリックしてください';
      return;
    }

    if (btn.dataset.al) {
      for (const c of ['left', 'center', 'right', 'just']) current.classList.remove('tp-al-' + c);
      current.classList.add('tp-al-' + btn.dataset.al);
    }
    if (btn.dataset.sp) {
      for (const c of ['0', '1', '2', '3']) current.classList.remove('tp-sp-' + c);
      current.classList.add('tp-sp-' + btn.dataset.sp);
    }
    syncBar(current);
    mark(current);
  });

  /* ---------------- 保存 ---------------- */

  async function save() {
    if (!changed.size) return;
    saveBtn.disabled = true;
    msg.textContent = '保存しています…';

    const edits = [...changed.entries()].map(([key, v]) => ({ key, html: v.html, cls: v.cls }));

    try {
      const res = await fetch('/__save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits }),
      });
      const out = await res.json();
      if (out.ok) {
        changed.clear();
        msg.textContent = `保存しました（${out.applied} 箇所）`;
      } else {
        msg.textContent = '保存できません: ' + (out.error || '不明');
        saveBtn.disabled = false;
      }
    } catch (err) {
      msg.textContent = '保存できません: ' + err.message;
      saveBtn.disabled = false;
    }
  }

  // 保存していない編集があるまま閉じようとしたら止める
  addEventListener('beforeunload', (e) => {
    if (changed.size) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  console.log(`[編集モード] ${editable.length} 箇所が編集できます。Ctrl+S で保存。`);
})();
