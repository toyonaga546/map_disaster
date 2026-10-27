# Firebase接続

2026-10-27にFirebase CLIで確認:

- プロジェクト: `adv-ex2-map-diseater`
- データベース: `(default)`
- ロケーション: `asia-northeast1`（東京）
- エディション: Standard / Native mode
- 写真バケット: `adv-ex2-map-diseater.firebasestorage.app`
- バケットのロケーション: `US-EAST1`（既存バケット）

## 接続手順

1. `.env.example`を`.env`にコピーする。
2. `.env`の`DB_DRIVER=firestore`、`FIREBASE_PROJECT_ID=adv-ex2-map-diseater`、`STORAGE_DRIVER=firebase`、`FIREBASE_STORAGE_BUCKET=adv-ex2-map-diseater.firebasestorage.app`を設定する。
3. 以下のいずれかの方法でサーバー認証を設定する。
4. `npm run check:firebase`と`npm run check:storage`で読み取り専用の接続確認をする。
5. 成功後に`npm start`で起動する。

Firebase CLIでのログインは、アプリのAdmin SDKのログインとは別。CLIで一覧を取得できても、アプリが接続できることにはならない。

### サーバー認証

Google Cloud CLIがある開発環境では`gcloud auth application-default login`でADCを設定できる。プロジェクトに必要なFirestore読み書き権限を持つアカウントを使う。

サービスアカウントJSONを使う場合は、Firebase Consoleの「プロジェクトの設定 → サービスアカウント」から認証情報を用意する。ファイルをリポジトリ外に保存し、`.env`に`GOOGLE_APPLICATION_CREDENTIALS=/絶対パス/秘密鍵.json`を設定する。秘密鍵の中身をコードやチャット、GitHubに貼らない。Google Cloud上では、サービスアカウントを実行環境に割り当てる方法を優先する。

サーバーのIAM権限にFirestoreの読み書きとStorageオブジェクトの作成/読み取り/削除、バケット情報の読み取りを設定する。Admin SDKはクライアント向けRulesを経由しないため、APIで管理トークンの検証と公開項目の制限を行う。

## データ構造

| コレクション | 内容 |
| --- | --- |
| `posts/{id}` | 説明、投稿地点、サーバー日時、GPS評価、AI評価、公開用メタデータ、写真の相対URL、保存先の識別子 |
| `postPrivate/{id}` | GPS生データ、管理トークンのハッシュ、AI送信同意 |

公開・非公開の2ドキュメントはバッチで一緒に作成/削除する。説明とAI評価はトランザクションで必要なフィールドだけ更新し、同時更新による上書きを防ぐ。削除済みの投稿をAI結果で再作成しない。

## 写真の保存

`STORAGE_DRIVER=firebase`では、EXIF除去・縮小・JPEG化した写真をバケット内の`posts/{id}.jpg`へ保存する。公開URLはアプリ内の`/images/{id}.jpg`のままで、サーバーが投稿の存在を確認してStorageから配信する。直接の公開設定やダウンロードトークンは不要。AIには同意のある過去写真をStorageからBufferとして読み出して渡す。

投稿削除時は写真を削除してからFirestoreの公開・非公開データを削除する。写真削除に失敗した場合はエラーとして投稿を残し、管理リンクから再試行できる。StorageとFirestoreをまたぐ原子的な削除はできないため、写真削除後にDB削除が失敗した場合も再試行する（写真の既削除は許容する）。写真保存後に投稿のDB保存が失敗した場合はアップロードした写真を片付ける。

写真の保存先を示す`image_storage`がない既存投稿はローカル保存として扱い、移行前も`data/images/`から表示する。既存Firestore投稿のローカル写真の移行手順:

```sh
npm run migrate:images
npm run migrate:images -- --apply
```

最初のコマンドは確認のみ。`--apply`では写真をStorageへコピーしてから投稿の保存先識別子を更新する。ローカル原本は残す。同じIDの画像がすでにStorageにある場合は内容が同一であることを確認して再開し、異なる画像は上書きしない。既存SQLiteの投稿自体は自動移行しない。

## ルールとインデックス

`firestore.rules`と`storage.rules`はブラウザSDKからの直接の読み書きを全て拒否する。APIサーバーだけがAdmin SDKで接続する構成。GPSの配列と管理トークンのハッシュのインデックスは無効化する。

接続先と差分を確認後、次のCLIコマンドで反映する。

```sh
npx --yes firebase-tools deploy --only firestore --project adv-ex2-map-diseater
npx --yes firebase-tools deploy --only storage --project adv-ex2-map-diseater
```

`firebase.json`はFirestoreとStorageのルール用。現在のNode.jsサーバーをFirebase Hostingへそのままデプロイする設定ではない。今回の設定では既存バケットを使い、課金プランやHostingの設定は変更していない。Cloud Storageのプラン要件は[公式説明](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024)を参照。

## 動作検証の範囲

`npm test`は15件成功。SQLite統合テスト、Firestore/Storageアダプターのモック、写真保存失敗・DB保存失敗時の後始末、削除再試行、従来写真の表示、ローカル未保存、AIへのBuffer入力を検証する。

2026-10-27に実環境でも次を確認した。架空のテスト投稿と写真は検証後に削除済み。

- Firestoreの投稿保存・編集・削除、公開APIからGPS履歴・管理トークンを除外
- Cloud Storageの写真保存・読み取り・削除と、配信写真のEXIF除去
- サーバー経由での写真表示と、ローカル保存ディレクトリを作らないこと
- Storage Rulesのコンパイルとデプロイ成功、未認証のFirebase Storage直接アクセスを拒否
- 既存Firestore投稿のローカル写真の移行対象は0件

Google SDKとの実通信とルール適用はモックだけでは検証できないため、環境変更後は接続確認と実機テストを行う。

一覧・履歴の実装は授業用の少数データを想定して全件取得する。公開運用前には地理検索・ページング・更新頻度を見直すこと。Firestore/Storage構成では新規投稿にローカル永続ディスクは不要。移行前の写真を残す場合は、その写真にアクセスするサーバーにローカル原本が必要。

参考: [Admin SDK](https://firebase.google.com/docs/admin/setup)、[トランザクション](https://firebase.google.com/docs/firestore/manage-data/transactions)、[セキュリティルール](https://firebase.google.com/docs/firestore/security/rules-structure)
