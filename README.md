# まちのしるべ — さくちゃんず

災害時の写真付き投稿を地図に集約し、GPS・画像比較・写真メタデータを独立した判断材料として表示する、授業用Webアプリのプロトタイプです。

## 起動

Node.js 22.15以降が必要です（SQLiteの実験的APIを使用）。

```sh
npm ci
npm start
```

http://localhost:3000 を開きます。スマートフォンなど別端末から使う場合は、HTTPS対応の環境に配置してください。GPSは利用者の許可が必要です。

Firestoreにも対応しています。`DB_DRIVER=firestore`で保存先を切り替えます。プロジェクトは`adv-ex2-map-diseater`（東京）です。サーバー認証と実接続確認の手順は[Firebase接続](docs/firebase.md)を参照してください。画像は引き続きローカル保存です。未設定時はSQLiteで起動します。

## 実装済み

- 地図の移動・拡大縮小・現在地と投稿ピン・投稿詳細
- 写真と説明文の投稿、地図クリックまたは緯度経度での場所指定
- 最大30秒のGPS取得、サーバーでの距離評価と非公開履歴の保存
- サーバー時刻・写真・投稿内容のSQLite/ファイル保存
- ハッシュ化した管理トークンを使う専用リンクで説明文編集・投稿削除
- 同一地点（100m以内）の写真履歴、最新3件と整合性上位3件の重複排除
- EXIFの撮影日時・カメラ・編集ソフトの確認、日時・撮影地点の矛盾に関する注意表示
- 公開写真の再エンコードとEXIF除去。元画像は保存しません
- 任意のOpenAI画像比較（同意した投稿と同一地点の過去写真）。未設定・比較不足・接続失敗を区別
- レスポンシブ画面、説明文検索、15秒ごとの投稿一覧更新

投稿時に一度だけ表示される管理リンクを保管してください。ログインやリンク再発行はありません。初期版の編集対象は説明文です。写真や場所の変更は削除して再投稿します。

## AIの設定（任意）

`.env.example`を`.env`へコピーして`OPENAI_API_KEY`を設定します。キーを設定すると外部APIの利用料金が発生する可能性があります。モデルは`gpt-6-luna`に固定しています。

両方の投稿に写真送信の同意がある場合のみ、メタデータ除去・縮小済みの公開写真2枚を送ります。GPSの生データは送りません。API呼び出しの正常応答はモックで検証しており、実APIでの評価精度と課金・利用可能モデルの実機検証は未実施です。

AI評価は詳細画面の「評価を更新」で再取得できます。Googleストリートビューは外部リンクで確認します。画像の自動取得・AI入力と画面内埋め込みは未実装です。

## 保存と運用

SQLiteモードでは`data/posts.sqlite`と`data/images/`が永続データです。Firestoreモードでは投稿と非公開GPS情報をFirestoreへ保存しますが、画像は`data/images/`に残ります。ローカルデータはGit管理対象外です。サーバー移行時はサーバーを停止して`data/`全体を安全にバックアップしてください。画像用の永続ディスクが必要で、Vercelへの直接配置には対応していません。画像のクラウド保存は次段階です。

本番公開前にはHTTPS、投稿頻度・容量制限、モデレーション、運用者による削除手順、GPS履歴の保持期間と削除方針、バックアップ、ページング、実機GPS検証を追加してください。現状はlocalhost待受の授業用です。GPSとEXIFは利用者側で変更でき、真偽の証明には使えません。判定距離・同一地点・優先順位の基準は暫定です。

地図には[Leaflet](https://leafletjs.com/)と[OpenStreetMap](https://www.openstreetmap.org/copyright)を使用します。タイルは[利用ポリシー](https://operations.osmfoundation.org/policies/tiles/)に従い、ブラウザから通常閲覧のみを行います。配信保証はありません。大量アクセス・オフライン用途では別途対応した配信元が必要です。画像解析は[exifr](https://github.com/MikeKovarik/exifr)と[sharp](https://sharp.pixelplumbing.com/)です。AI連携は[OpenAI公式API仕様](https://developers.openai.com/api/reference/resources/chat)に従います。

## 検証とアップロード

```sh
npm test
git add README.md package.json package-lock.json .env.example src public scripts test .github
npm run check:upload
git commit -m "feat: add disaster map prototype"
git push origin main
```

`check:upload`はステージ済み追加・変更ファイルの圧縮前総容量を計測し、10,000,000 bytesを超えると失敗します。削除ファイルは合計しません。各アップロード前に実行します。依存パッケージを含む`node_modules/`は送信せず、`package-lock.json`から再現します。

[要件原文](docs/requirements.md) / [段階的な開発方針・GitHubの公式制限](docs/development.md)
