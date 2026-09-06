// 画像を大きく開くウインドウの中で動く。橋渡しだけの薄いもの。

const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('viewer', {
  /** 閉じる。 */
  close: () => ipcRenderer.send('image:close'),
  /** 表示する画像が差し替わったときに呼ばれる。 */
  onShow: (fn) => ipcRenderer.on('image:show', (_e, payload) => fn(payload)),
});
