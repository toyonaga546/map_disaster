# 開発とGitHubへの反映

要件原文は requirements.md。最初の実装は授業向けの単一サーバープロトタイプとする。

## アップロード制限（2026-10-20確認）

| 方法 | 上限 |
| --- | --- |
| GitHubブラウザ | 1ファイル25 MiB = 26,214,400 bytes、一度に100ファイル |
| 通常のGit | 1ファイル100 MiB = 104,857,600 bytes（50 MiB超で警告） |
| git push | 1回2 GiB = 2,147,483,648 bytes |

公式資料:
- https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository
- https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github
- https://docs.github.com/en/get-started/using-git/troubleshooting-the-2-gb-push-limit

利用者の希望に合わせ、各回の追加・変更ファイルの総容量を10,000,000 bytes以内にする。圧縮前のファイルサイズを測る保守的な運用値であり、GitHubの公式上限ではない。依存パッケージ・投稿画像・DB・秘密鍵はアップロードしない。

## 段階

1. 要件と開発方針を保存。
2. 地図、写真投稿、GPS検証、投稿管理、同一地点の履歴、メタデータを実装し検証。
3. APIキーが用意できた環境で、過去投稿画像を使ったAI比較を実機検証。
4. HTTPSの公開環境、DB・Storageのクラウド移行、濫用対策を整備。

## 初期設計

- Node.js 22.15以降・SQLiteによるサーバー保存。ブラウザはLeafletとOpenStreetMap。
- ログイン不要。編集・削除用のランダムトークンはハッシュで保存。
- GPSの生データは非公開。公開APIは評価結果のみ返す。
- 同一地点は半径100m。GPS整合性の仮基準は距離300m＋測位精度、測位精度1,000m超は判定不可。実機検証後に調整する。
- 最新3件と、GPS・AI結果からの補助スコア上位3件を重複なく表示。未検証は整合性確認済みとして扱わない。
- AIの実行はサーバーAPIキーを設定した場合のみ。キー未設定・比較画像不足は判定不可として理由を表示する。
- Googleストリートビューの画像はAIに渡さない。まず利用者がGoogle Maps上で確認するリンクを提供する。規約確認と埋め込み用設定が整ってから拡張する。
- 運用画像・DBはdata/に保存し、Gitでは管理しない。SQLiteの永続ディスクが必要であり、そのままVercelには配置しない。
