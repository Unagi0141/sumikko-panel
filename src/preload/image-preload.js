// 画像を大きく開くウインドウの中で動く。
// 画像の実寸をメインへ伝えて、窓の大きさを決めてもらうためだけのもの。

const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('viewer', {
  /** 読み込めた画像の実寸を伝える。メインがモニタに合わせて窓を整える。 */
  ready: (width, height) => ipcRenderer.send('image:ready', { width, height }),
  /** 読み込めなかったことを伝える。 */
  failed: () => ipcRenderer.send('image:failed'),
  /** 閉じる。 */
  close: () => ipcRenderer.send('image:close'),
  /** 表示する画像が差し替わったときに呼ばれる。 */
  onShow: (fn) => ipcRenderer.on('image:show', (_e, payload) => fn(payload)),
});
