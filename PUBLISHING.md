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

## 手順 4 — 最初のリリースを出す

インストーラを作ります。

```bash
npm run dist
```

`dist/` に次の 3 つができます。**3 つとも Releases に上げてください。**

| ファイル | 役割 |
| --- | --- |
| `SumikkoPanel-Setup-0.9.0.exe` | インストーラ本体 |
| `latest.yml` | **自動更新がこれを見ます。忘れると更新が動きません** |
| `SumikkoPanel-Setup-0.9.0.exe.blockmap` | 差分更新に使われます |

上げ方:

1. リポジトリの **Releases** → **Create a new release**
2. **Choose a tag** に `v0.9.0` と入力し、**Create new tag** を選ぶ
3. Release title: `v0.9.0（ベータ）`
4. 説明に、まだベータであること・SmartScreen の警告が出ることを書く
5. 上の 3 ファイルをドラッグして添付
6. **Set as a pre-release** にチェック（ベータのうちは付けておく）
7. **Publish release**

> **`latest.yml` を上げ忘れると自動更新が動きません。** いちばんやりがちな失敗です。

---

## 手順 5 — 動作確認

1. 配布ページ <https://unagi0141.github.io/sumikko-panel/> を開く
2. ダウンロードボタンから実際に落とす
3. 別の場所（できれば別の PC）でインストールしてみる
4. SmartScreen の警告が、ページに書いた手順どおりに回避できるか確かめる

---

## 2 回目以降のリリース

```bash
# 1. package.json の version を上げる（例: 0.9.0 → 0.9.1）
# 2. ビルド
npm run dist

# 3. コミットして送る
git add .
git commit -m "v0.9.1"
git push
```

そのあと GitHub で新しい Release を作り、`v0.9.1` タグで 3 ファイルを添付します。

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
: `latest.yml` を Releases に添付し忘れていないか確認してください。
  また、pre-release にしたものは既定では配信されません。ベータの間だけ配りたい場合は
  `package.json` の `build.publish` に `"allowPrerelease": true` を足します。

**`Author identity unknown` と出る**
: 手順 2-a の名前とメールの設定が済んでいません。設定してから `git commit` をやり直してください。
  コミットは失敗しているだけで、`git add` の結果は残っています。

**`error: unknown option 'global'` と出る**
: 2 つのコマンドが 1 行に繋がっています。`git push ...` と `git config ...` を
  別々の行で実行してください。

**「発行元が不明」と出る**
: コード署名をしていないためです。想定どおりの挙動で、配布ページに手順を書いてあります。
