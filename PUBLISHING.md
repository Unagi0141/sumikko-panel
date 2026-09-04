# 公開の手順

初回だけの作業です。以降のリリースは「[2 回目以降](#2-回目以降のリリース)」だけで済みます。

---

## 手順 1 — GitHub にリポジトリを作る

ブラウザで <https://github.com/new> を開き、次のように作ります。

| 項目 | 値 |
| --- | --- |
| Repository name | `sumikko-panel` |
| Description | 画面の端に居座る Web パネル（Windows） |
| Public / Private | **Public** |
| Add a README file | **チェックしない** |
| Add .gitignore | **None**（既にあります） |
| Choose a license | **None**（既に `LICENSE` があります） |

> README や .gitignore を GitHub 側で作ると、こちらの内容と衝突して最初の push が弾かれます。
> **必ず空のまま作ってください。**

---

## 手順 2 — 手元のコードを送る

### 2-a. 先に名前とメールを設定する（初回だけ）

**これを先にやってください。** 後回しにすると `git commit` が途中で止まります。

```bash
git config --global user.name "Unagi0141"
```

```bash
git config --global user.email "kto28.p.choro@gmail.com"
```

設定できたか確認します。**両方に値が出ていること。**

```bash
git config --global --list
```

### 2-b. 送る

プロジェクトのフォルダ で、**1 行ずつ**実行します。

> まとめて貼ると行が繋がって `maingit config ...` のような妙なコマンドになります。
> 1 行ずつ、Enter を押しながら進めてください。

```bash
git init
```

```bash
git add .
```

```bash
git commit -m "すみっこパネル v0.9.0"
```

```bash
git branch -M main
```

```bash
git remote add origin https://github.com/Unagi0141/sumikko-panel.git
```

```bash
git push -u origin main
```

初回の push でブラウザが開き、GitHub へのログインを求められます。許可すれば以降は聞かれません。

### 送る前に一度だけ確認

```bash
git status
```

`node_modules/` と `dist/` が**一覧に出ていないこと**を確かめてください。`.gitignore` で
除外してありますが、念のためです。

設定やログイン情報は `%APPDATA%\Sumikko Panel` にあり、**リポジトリには入りません**。

---

## 配布ページの文章を直す

### 見たまま直す（おすすめ）

```bash
npm run page:edit
```

ブラウザが開き、下に道具箱が出ます。**直したい文をクリックすると、その場で打ち直せます。**

| 道具 | すること |
| --- | --- |
| 揃え | 左 / 中央 / 右 / 両端（両端は日本語の行末が揃います） |
| 余白 | その段落の上下の空きを なし / 小 / 中 / 大 で変える |
| 太字 | 選んだ文字を太くする / 戻す |
| 保存 | `docs/index.html` に書き戻す（**Ctrl+S** でも同じ） |

決まりごと:

- 直せるのは**文章だけ**です。枠組み（段の並びや箱）はクリックしても反応しません。壊れると直すのが大変なためです。
- **Enter で改行はできません。** 段落を増やしたいときは `docs/index.html` を直接いじってください。
- 保存すると、書き換える前の中身が `docs/index.html.bak` に残ります。おかしくなったら戻せます。
- 保存していない状態で閉じようとすると引き止められます。

止めるときは Ctrl+C。

> 新しく文章を足したときは、一度だけこれを実行して印を付け直してください。
> 番号は振り直されないので、既に直した場所がずれることはありません。
>
> ```bash
> npm run tag
> ```

### 直接いじる

```bash
npm run page
```

こちらは編集の道具箱が出ない代わりに、**`docs/index.html` を保存するたびに自動で再読み込み**されます。
スクロール位置もそのまま保たれるので、構造ごと書き換えたいときはこちらが向いています。

### 直したら送る

```bash
git add docs/index.html
git commit -m "文章を調整"
```

```bash
git push
```

反映まで 1〜2 分かかります。

---

## 手順 3 — 配布ページを公開する

1. リポジトリの **Settings** を開く
2. 左の **Pages** を選ぶ
3. **Build and deployment** の Source を **Deploy from a branch** にする
4. Branch を **main**、フォルダを **/docs** にして **Save**

数分で次の URL が生きます。

```
https://unagi0141.github.io/sumikko-panel/
```

---

## 手順 4 — リリースを出す

`gh`（GitHub CLI）が入っていれば、コマンド 1 つで済みます。入っていない場合は
`winget install --id GitHub.cli -e` のあと `gh auth login` を一度だけ実行してください。

まずインストーラを作ります。

```bash
npm run dist
```

`dist/` に 3 つできます。**3 つとも添付してください。**

| ファイル | 役割 |
| --- | --- |
| `SumikkoPanel-Setup-0.9.0.exe` | インストーラ本体 |
| `latest.yml` | **自動更新がこれを見ます。忘れると更新が動きません** |
| `SumikkoPanel-Setup-0.9.0.exe.blockmap` | 差分更新に使われます |

そして次のように出します（`0.9.0` の部分は毎回そのときの版に読み替えてください）。

```bash
gh release create v0.9.0 --title "v0.9.0（ベータ）" --notes-file notes.md dist/SumikkoPanel-Setup-0.9.0.exe dist/latest.yml dist/SumikkoPanel-Setup-0.9.0.exe.blockmap
```

`notes.md` は変更点を書いた普通のテキストです。用意しないときは `--notes-file notes.md` を
`--notes "変更点なし"` に置き換えてください。

### pre-release にしないこと

`--prerelease` を付けると、**自動更新が誰にも届かなくなります。** electron-updater は既定で
pre-release を無視するためです。すみっこパネルはまだ全体がベータで、別に安定版があるわけでも
ないので、通常のリリースとして出します。ベータであることは配布ページとリリース本文に書いてあります。

どうしても pre-release として配りたくなったときは、`package.json` の `build.publish` に
`"allowPrerelease": true` を足してから付けてください。

---

## 手順 5 — 動作確認

1. 配布ページ <https://unagi0141.github.io/sumikko-panel/> を開く
2. ダウンロードボタンから実際に落とす
3. 別の場所（できれば別の PC）でインストールしてみる
4. SmartScreen の警告が、ページに書いた手順どおりに回避できるか確かめる

---

## 2 回目以降のリリース

1. `package.json` の `version` を上げる（例: 0.9.0 → 0.9.1）

2. ビルドする

```bash
npm run dist
```

3. コミットして送る

```bash
git add -A
git commit -m "v0.9.1"
```

```bash
git push
```

4. リリースを出す

```bash
gh release create v0.9.1 --title "v0.9.1" --notes "変更点を書く" dist/SumikkoPanel-Setup-0.9.1.exe dist/latest.yml dist/SumikkoPanel-Setup-0.9.1.exe.blockmap
```

利用者のアプリは起動から 30 秒後と、以降 6 時間ごとに新しい版を探します。
見つかると裏で受け取り、**次にアプリを終了したときに適用**されます。
常駐アプリなので、作業中に勝手に再起動することはありません。

---

## つまずきやすいところ

**push が `rejected` で弾かれる**
: GitHub 側で README などを作ってしまっています。`git pull --rebase origin main` で取り込むか、
  リポジトリを作り直してください。

**Pages が 404 のまま**
: Source が `/docs` になっているか確認してください。反映に数分かかることがあります。

**更新が降ってこない**
: まず `latest.yml` を添付し忘れていないか確認してください。次に、そのリリースが
  pre-release になっていないか確認してください。**pre-release は既定で配信されません。**

**`Author identity unknown` と出る**
: 手順 2-a の名前とメールの設定が済んでいません。設定してから `git commit` をやり直してください。
  コミットは失敗しているだけで、`git add` の結果は残っています。

**`error: unknown option 'global'` と出る**
: 2 つのコマンドが 1 行に繋がっています。`git push ...` と `git config ...` を
  別々の行で実行してください。

**「発行元が不明」と出る**
: コード署名をしていないためです。想定どおりの挙動で、配布ページに手順を書いてあります。
