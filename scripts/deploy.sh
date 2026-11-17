#!/usr/bin/env bash
# Cloud FunctionsとFirebase Hostingへデプロイする。事前に `npx firebase-tools login` が必要。
# .envは読み取るだけで、デプロイするソースには含めない。APIキーはSecret Manager経由で渡す。
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${FIREBASE_PROJECT_ID:-adv-ex2-map-diseater}"
echo "プロジェクト: $PROJECT / 公開URL: https://${PROJECT}.web.app"
echo "Cloud Functions(公開・認証なし)、Secret Manager、Firebase Hostingを使います。Blazeプランが必要で、料金が発生します。"
read -r -p "続けますか？ [y/N] " answer
[ "$answer" = "y" ] || { echo "中止しました。"; exit 1; }

# .envはsourceせず、必要なキーだけを取り出す。
env_value() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/' || true; }

(cd functions && npm install --no-audit --no-fund)

secrets=()
for name in OPENAI_API_KEY GOOGLE_MAPS_API_KEY; do
  value="$(env_value "$name")"
  [ -n "$value" ] || { echo "$name は.envに未設定のため渡しません。"; continue; }
  printf '%s' "$value" | npx --yes firebase-tools functions:secrets:set "$name" --data-file - --force --project "$PROJECT"
  secrets+=("$name")
done

# functions/index.jsが、ここに挙げた名前のSecretだけをFunctionへ結び付ける。
# --force: コンテナイメージの古いものを自動で削除するクリーンアップポリシーを設定する（未設定だとデプロイがエラー終了する）。
DEPLOY_SECRETS="$(IFS=,; echo "${secrets[*]:-}")" npx --yes firebase-tools deploy --only functions,hosting --force --project "$PROJECT"
echo "公開しました: https://${PROJECT}.web.app"
