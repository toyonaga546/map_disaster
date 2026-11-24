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

Cloud Storageのプラン要件は[公式説明](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024)を参照。

## Cloud FunctionsとFirebase Hostingへのデプロイ

Node.jsサーバーはCloud Functions（第2世代）の`app`（`asia-northeast1`）で動かし、Firebase Hostingの`**`リライトで`https://adv-ex2-map-diseater.web.app`から公開する。ページ、API、写真を同じFunctionが配信し、Hosting自体は静的ファイルを持たない。Functionsではローカルディスクが永続しないため、`DB_DRIVER=firestore`と`STORAGE_DRIVER=firebase`に固定する（`src/functions-runtime.js`）。

```sh
npx firebase-tools login
./scripts/deploy.sh
```

`scripts/deploy.sh`は、確認後に`.env`の`OPENAI_API_KEY`と`GOOGLE_MAPS_API_KEY`（設定がある場合のみ）をSecret Managerへ登録し、`firebase deploy --only functions,hosting`を実行する。`.env`は読み取るだけで、`functions/`に置かないためデプロイされない（Functionsは自身のソース内の`.env`を環境変数として公開してしまうので、`functions/`を別ディレクトリにしている）。デプロイ前に`scripts/prepare-functions.js`が`src/`と`public/`を`functions/`へコピーする。コピーは生成物でGit管理しない。

- 投稿APIは写真保存までを応答前に行う。AI比較はレスポンス後にCPUが絞られるため行わず、Firestoreの`posts/{id}`作成をきっかけに`analyzePost`が実行する。写真とストリートビュー画像はStorageから読み出す。
- Secretの結び付けは`functions/deploy-secrets.json`（`deploy.sh`が作る。Git管理しない）に載った名前だけ行う。Firebase CLIは関数の解析プロセスに任意の環境変数を渡さないため、環境変数では指定できない。このファイルがないまま`firebase deploy`を実行すると、Secretなしで配備され、AIとストリートビューは「APIキー未設定」になる。
- FunctionのサービスアカウントにFirestoreとStorageの権限が必要（デフォルトのサービスアカウントが十分な権限を持つ場合が多い）。
- Functions、Hosting、Secret Managerの利用にはBlazeプランが必要。
- 認証なしで公開し、台数は最大3台に制限している。投稿頻度の制限はないため、OpenAIとストリートビューの利用料金に上限を設定すること。
- HostingからFunctionへのリクエストは60秒で打ち切られる。投稿処理（ストリートビュー4枚の取得を含む）はこの範囲に収める。
- 配備後の動作確認は未実施。テストはモックとローカルで、Functionsの実行環境、Hostingのリライト、Firestoreトリガーは実環境で検証していない。

## GitHub Actionsによる自動デプロイ

`main`へマージ（push）されると、`.github/workflows/deploy.yml`がテストを実行し、成功したら`scripts/deploy.sh`と同じ内容でCloud FunctionsとFirebase Hostingへデプロイする。ActionsタブのRun workflowから手動実行もできる。このワークフローは未実行で、初回設定後の動作は未検証。

### 初回設定

1. Google Cloudでデプロイ用のサービスアカウントを作り、次のロールを付与する。
   - Firebase Admin（`roles/firebase.admin`）
   - Cloud Functions Admin（`roles/cloudfunctions.admin`）
   - Secret Manager Admin（`roles/secretmanager.admin`）
   - Service Account User（`roles/iam.serviceAccountUser`）
   - Cloud Build EditorとArtifact Registry管理者（Functionsのビルド用）
2. そのサービスアカウントのJSONキーを発行する。
3. GitHubリポジトリのSettings → Secrets and variables → Actionsに登録する。

| Secret | 必須 | 内容 |
| --- | --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` | 必須 | サービスアカウントのJSONキー全文 |
| `OPENAI_API_KEY` | 任意 | 未設定ならAI比較は「APIキー未設定」になる |
| `GOOGLE_MAPS_API_KEY` | 任意 | 未設定ならストリートビュー画像は取得されない |

JSONキーはリポジトリやチャットに貼らない。キーを持たない運用にする場合は、`google-github-actions/auth`のWorkload Identity Federationへ切り替える。

OpenAIとGoogle Mapsのキーは、デプロイのたびにGitHub SecretsからSecret Managerへ上書き登録する。GitHub側に登録しない場合、`.env`の値は使われないので、手元の`scripts/deploy.sh`で入れたSecretは次回の自動デプロイ時にFunctionへ結び付けられなくなる。

mainへのマージでデプロイが走るため、Branch protectionで`Test`ワークフローの成功を必須にしておくと安全。

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
