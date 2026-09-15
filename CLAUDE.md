# 工事写真台帳アプリ — CLAUDE.md

株式会社光陽の工事写真帳を作成・メール送付するためのアプリ。

## 1. 目的

iPhone に保存済みの「黒板が焼き込まれた工事写真」を選択し、アプリ上で並べ替え・テキスト付与を行い、
写真3枚/ページの工事写真帳PDFを自動生成して、メールで送付する。

- **やること**: 写真選択 → 並べ替え → 写真ごとのテキスト入力 → 表紙付きPDF生成 → 共有シートでメール送付
- **やらないこと**: 撮影、黒板合成、写真の長期保存

黒板は別アプリで撮影時に焼き込み済み。このアプリは「資料作成とメール送信に特化」する。

## 2. 技術方針

- **PWA**（iPhone Safari で開きホーム画面に追加）。
- **バニラ HTML / CSS / JavaScript のみ**。ビルドツール・フレームワーク不使用。
- 外部ライブラリは **PDF生成（pdf-lib + fontkit、日本語フォント埋め込み）のみ**許可。それ以外は使わない。
- 設定・軽量データは **localStorage**。写真は溜め込まず、作業セッション内でのみ保持。
- デザインは **Apple風ミニマル**（白〜薄グレー背景、アクセント1色 = `#007AFF`）。
- スマホ前提: viewport メタタグ、タップ領域 **最低44px**、**横スクロールなし**。

## 3. フォルダ構成

```
koujikanri/
├── index.html          # エントリ（タイトル + ホーム画面）
├── manifest.json       # PWA マニフェスト（standalone / テーマカラー）
├── sw.js               # Service Worker（App Shell オフラインキャッシュ）
├── CLAUDE.md           # このファイル
├── css/
│   └── style.css       # グローバルスタイル（CSS変数でテーマ管理）
├── js/
│   ├── app.js          # アプリ本体（写真/工事情報/設定/PDF生成/メール送付・保存/クリア）
│   ├── pdf.js          # PDF生成（pdf-lib + fontkit、表紙＋3枚/ページ）
│   └── lib/
│       ├── pdf-lib.min.js        # ローカル同梱（オフライン対応）
│       └── fontkit.umd.min.js    # ローカル同梱
├── fonts/
│   └── MPLUS1p-Regular.ttf       # 日本語フォント（TrueType/glyf、全埋め込み）
└── icons/
    ├── icon-192.png         # アプリアイコン（青背景＋写真カード＋紙飛行機）
    ├── icon-512.png         # 同 512px
    └── apple-touch-icon.png # iOSホーム画面用 180px
```

アイコンは `.claude/makeicon.js`（pdf-lib描画→poppler `pdftocairo`でPNG化）で生成。
デザインは「工事写真帳PDFをメール送付」を表す：青背景＋白い写真カード（山/太陽＋PDFタグ）＋紙飛行機（送信）。

PDF: `window.KojiPDF.generate({ job, company, photos, onProgress })` → Uint8Array。
写真は canvas 経由で JPEG 化（HEIC/EXIF回転/サイズ最適化, 最大1600px）してから `embedJpg`。
レイアウトは `perPage`（2/3/4）で切替: 2・3枚=写真左＋文言右（行）、4枚=2列2段で写真下に文言（グリッド）。
写真ページに出すのは**施工区分と撮影日のみ**（工事件名・工事場所は表紙にあるため出さない）。
日本語は **M PLUS 1p（TrueType/glyf）を `embedFont(bytes, { subset:false })` で全埋め込み**。
- 重要: pdf-lib(1.17.1)+@pdf-lib/fontkit(1.1.1) の**サブセット機能はグリフ欠落のバグ**があり、
  さらに CFF/OTTO フォント（Noto Sans JP 等）はサブセット埋め込みが壊れて iPhone で文字化けする。
  そのため TrueType フォント＋`subset:false`（全埋め込み, 約1MB/PDF）で確実に埋め込む。
ファイル名: `工事写真帳_{工事名}_{YYYY-MM-DD}.pdf`。

## 4. 段階的開発計画（Phase 0〜4）

| Phase | 内容 | ゴール | 状態 |
| :-- | :-- | :-- | :-- |
| Phase 0 | プロジェクト初期化・CLAUDE.md・PWA骨組み | ホーム画面に追加でき、空アプリが起動 | ✅ 完了 |
| Phase 1 | 写真の複数選択＋一覧表示＋並べ替え | 写真を選び、サムネを並べ替えできる | ✅ 完了 |
| Phase 2 | 工事情報入力＋写真ごとのテキスト入力＋設定画面 | 各写真に件名/場所/区分を付与でき、設定が保存される | ✅ 完了 |
| Phase 3 | 写真帳PDF生成（表紙＋3枚/ページ、日本語フォント埋め込み） | 現行報告書と同等のPDFが出力できる | ✅ 完了 |
| Phase 4 | 共有シート連携（宛先・件名の雛形反映）＋仕上げ | PDFをメールで送付でき、UIが整う | ✅ 完了 |

各Phaseは順に積み上げる。1つ完了 → iPhoneで確認 → 次へ。

## localStorage キー（Phase 2〜）

- `koji.jobInfo` … `{ orderNo, name, place }`（工事情報。表紙・写真初期値に使用）
- `koji.company` … `{ name, postal, address, tel, fax }`（自社情報。表紙下部）
- `koji.mail` … `{ to, subject }`（メール雛形。件名は `{工事名}` を差し込み）
- `koji.bodyTemplates` … `{ list:[string], selected:index }`（本文の定型句。複数登録・選択式）
- `koji.categories` … `string[]`（施工区分タグの候補。設定画面で▲▼並べ替え可。既定は「型式／シリアル／施工前／部材／施工中／完了」の5つ）
- `koji.recentTo` … `string[]`（直近に使ったメール宛先。送付時の候補表示）
- `koji.perPage` … `2|3|4`（1ページの写真枚数。既定3）
- `koji.session` … `{ order:[id], cats:{id:区分}, dates:{id:日付} }`（作業中の写真の並び順・区分・撮影日。本体は IndexedDB `koji-db/photos`）
- `koji.mig.buzai` … 既存ユーザーへ「部材」を一度だけ追加する移行フラグ（旧既定の名残）
- `koji.mig.cats_koyoh` … 施工区分の候補を光陽向けの5つへ一度だけ揃える移行フラグ

会社名は `株式会社光陽` に固定（`FIXED_COMPANY_NAME`）。設定画面では readonly にし、
起動のたびにコードで上書きする（localStorage はドメイン単位で共有されるため、
同じ端末で別の会社向けの版を開くと別の会社名が残ることがある）。

写真本体は **IndexedDB に一時退避**し、iOSのPWA再読み込み（プレビュー表示で背面化等）後も復元する。
これは「溜め込み」ではなく作業セッションの保全で、**クリアで IndexedDB ごと消去**する。

写真ごとに設定するのは **施工区分（`category`）のみ**。工事件名・工事場所は
工事情報（`koji.jobInfo` の name/place）の共通値を全写真で使う（写真ごとには持たない）。
**撮影日（`date`）は写真ファイルの `lastModified` から自動取得**しPDFに表示する。
`category`/`date` は state.photos の各要素に保持し、session（IndexedDB＋koji.session）で復元する。

メール送付（Phase 4）: iOSの共有シートは件名(title)を件名欄に入れず本文に混ぜるため、
共有は `{ files, text:本文定型句 }` のみ渡す（件名は「件名をコピー」で貼り付け、宛先は送付時に自動コピー）。
本文の定型句は `koji.bodyTemplates` の選択中の文章を `{工事名}{工事場所}{注文番号}{会社名}` 差し込みで挿入。

## 5. 留意点

- **黒板合成は不要**: 写真は無加工で扱う。
- **写真は溜め込まない**: 1工事ぶんの作業セッション内でのみ保持。終わったらクリア。
- **日本語PDF**: pdf-lib は標準で日本語非対応。fontkit で日本語フォントをサブセット埋め込み（Phase 3）。
- **メール送信は手動**: Web Share で共有シートに渡すところまで。宛先・件名の自動反映は iOS 側の制約あり（Phase 4 で最も確実な方法を選ぶ）。
- **アイコン**: 作成済み（`.claude/makeicon.js` で再生成可）。

## 6. 動作確認（ローカル）

PWA は `file://` では Service Worker が動かないため、簡易HTTPサーバ経由で確認する。
（この環境には Python/Node がないため、確認は別途サーバを用意するか、iPhone から同一LAN上のサーバで開く）
