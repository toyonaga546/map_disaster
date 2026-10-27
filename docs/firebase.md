# Firebase接続

2026-10-27にFirebase CLIで確認:

- プロジェクト: `adv-ex2-map-diseater`
- データベース: `(default)`
- ロケーション: `asia-northeast1`（東京）
- エディション: Standard / Native mode

## 接続手順

1. `.env.example`を`.env`にコピーする。
2. `.env`の`DB_DRIVER=firestore`と`FIREBASE_PROJECT_ID=adv-ex2-map-diseater`を設定する。
3. 以下のいずれかの方法でサーバー認証を設定する。
4. `npm run check:firebase`で読み取り専用の接続確認をする。
5. 成功後に`npm start`で起動する。

Firebase CLIでのログインは、アプリのAdmin SDKのログインとは別。CLIで一覧を取得できても、アプリが接続できることにはならない。

### サーバー認証

Google Cloud CLIがある開発環境では`gcloud auth application-default login`でADCを設定できる。プロジェクトに必要なFirestore読み書き権限を持つアカウントを使う。

サービスアカウントJSONを使う場合は、Firebase Consoleの「プロジェクトの設定 → サービスアカウント」から認証情報を用意する。ファイルをリポジトリ外に保存し、`.env`に`GOOGLE_APPLICATION_CREDENTIALS=/絶対パス/秘密鍵.json`を設定する。秘密鍵の中身をコードやチャット、GitHubに貼らない。Google Cloud上では、サービスアカウントを実行環境に割り当てる方法を優先する。

サーバーのIAM権限を設定する。Admin SDKはFirestore Rulesを経由しないため、APIで管理トークンの検証と公開項目の制限を行う。

## データ構造

| コレクション | 内容 |
| --- | --- |
| `posts/{id}` | 説明、投稿地点、サーバー日時、GPS評価、AI評価、公開用メタデータ、写真の相対URL |
| `postPrivate/{id}` | GPS生データ、管理トークンのハッシュ、AI送信同意 |

公開・非公開の2ドキュメントはバッチで一緒に作成/削除する。説明とAI評価はトランザクションで必要なフィールドだけ更新し、同時更新による上書きを防ぐ。削除済みの投稿をAI結果で再作成しない。

画像は引き続き`data/images/`に保存する。Cloud Storageはこの変更では有効にしない。Firestoreへの切り替えは既存SQLiteデータの自動移行を行わない。既存データを移行するときは専用の移行作業と画像の保存先の整理が必要。

## ルールとインデックス

`firestore.rules`はブラウザSDKからの読み書きを全て拒否する。APIサーバーだけがAdmin SDKで接続する構成。GPSの配列と管理トークンのハッシュのインデックスは無効化する。

接続先と差分を確認後、次のCLIコマンドで反映する。

```sh
npx --yes firebase-tools deploy --only firestore --project adv-ex2-map-diseater
```

`firebase.json`はFirestore専用。現在のNode.jsサーバーをFirebase Hostingへそのままデプロイする設定ではない。課金プランやStorage、Hostingの設定は変更しない。

## 動作検証の範囲

`npm test`でSQLiteの統合テストとFirestoreアダプターのモックテストを行う。Google SDKとの実通信、Firestoreルールの適用はモックでは検証できない。`npm run check:firebase`で実環境への読み取り接続を確認し、認証後に投稿・編集・削除の実機確認が必要。

一覧・履歴の実装は授業用の少数データを想定して全件取得する。公開運用前には地理検索・ページング・更新頻度を見直すこと。写真がローカル保存のため、複数サーバーでの運用には画像ストレージの共有が必要。

参考: [Admin SDK](https://firebase.google.com/docs/admin/setup)、[トランザクション](https://firebase.google.com/docs/firestore/manage-data/transactions)、[セキュリティルール](https://firebase.google.com/docs/firestore/security/rules-structure)
