# C2PA・SynthIDによる画像来歴の確認

## 判定

| 証拠 | 投稿詳細の表示 |
| --- | --- |
| 信頼できるC2PA署名とAI生成アクション | AI生成の記録あり |
| 信頼できるC2PA署名とAI編集・生成素材の記録 | AI編集・生成素材の使用記録あり |
| OpenAI検証APIが対応するSynthIDを検出 | AI生成・編集のシグナルあり |
| 未検出・無効署名・信頼性不明・未設定・未同意・API失敗 | 判定不可 |

C2PAとSynthIDを独立に表示する。一方の検証が使えなくても、もう一方の確認済みの証拠は表示する。署名があるだけ、メタデータにソフト名があるだけ、写真の見た目が不自然という理由ではAI生成としない。C2PAにAI利用の記録がなくても、実写と断定しない。既存投稿に検証結果がない場合も判定不可とする。

## 処理

1. JPEG・PNG・WebPの元画像をサーバーで読み込む。
2. 元のバイト列を既存C2PAライブラリでローカル検証する。外部マニフェストの自動取得は無効。
3. `provenance_consent === true`の場合のみ、元のバイト列を`POST https://api.openai.com/v1/content_provenance_checks`のmultipart `file`として送信する。公開用のJPEGやファイル名・ローカルパスは使わない。
4. APIのC2PA/SynthID結果は`results`の各項目から個別に読む。OpenAI C2PAの`detected`は署名状態と発行元も確認する。空・重複・不正な結果を生成の証拠にしない。
5. `posts/{id}.provenance`に総合結果・C2PA・SynthID・検証日時を保存する。原本は追加保存しない。
6. 公開写真にはEXIF除去・縮小済みJPEGを使う。元画像の送信同意は`postPrivate/{id}.provenance_consent`に保存する（SQLiteも非公開列で保持）。

外部検証は最大8秒で打ち切り、キーなし・組織の利用権限なし（404）・制限（429）・通信失敗・不正応答を判定不可へ変換する。API失敗を理由に投稿を拒否しない。APIキーやエラー応答の原文、原本データを公開結果やログへ記録しない。画像をFiles APIへ別途登録する処理はない。

## 既存投稿と公開環境

既存のC2PA結果はそのまま表示できる。原本の来歴情報は公開用画像への変換時に失われている場合があるため、既存画像を自動再検証しない。新機能導入後に投稿された元画像が対象。

Firebase Functionsでは既存の`OPENAI_API_KEY`のSecret参照を使用する。既存の場所の画像比較・危険度解析・投稿管理・保存先を変更しない。投稿時の元画像検証はHTTPリクエスト内で完了するため、応答後に停止するFunctionsでも原本を別途保存する必要はない。

## テスト

`npm test`で以下を含む38件を検証。

- 署名済み生成/編集記録・通常来歴・無効署名・来歴なし
- SynthID検出・未検出、各結果を独立に扱うこと
- 元バイト列をそのままmultipartで送ること
- 未同意・キーなしでは外部通信しないこと
- API 400/401/403/404/429/500、タイムアウト、通信・JSON・形式エラー
- 不明な新旧投稿を「判定不可」と表示し、発行元や理由のHTMLをエスケープすること
- 投稿APIを通した保存、同意の非公開保存、公開写真のEXIF除去

検出成功のAPI応答はモックで検証している。実際の生成原本・スクリーンショットに対する検出精度は別途実測する。検出なしは実写の証拠ではなく、来歴情報も災害投稿の内容の真偽を保証しない。

参考: [OpenAI Content Provenance API](https://developers.openai.com/api/docs/guides/content-provenance)、[API仕様](https://developers.openai.com/api/reference/resources/content_provenance_checks/methods/create)
