#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# .env から GEMINI_API_KEY を読み込み
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

if [ -z "$GEMINI_API_KEY" ]; then
    echo "❌ .env に GEMINI_API_KEY が設定されていません。"
    exit 1
fi

echo "1. 必要な Google Cloud API (Cloud Run / Cloud Build / Artifact Registry) を有効化しています..."
gcloud services enable serviceusage.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --quiet

echo "2. Google Cloud Run (asia-northeast1) へ omoide-canvas をデプロイしています..."
gcloud run deploy omoide-canvas \
  --source . \
  --platform managed \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --session-affinity \
  --port 7860 \
  --set-env-vars GEMINI_API_KEY="${GEMINI_API_KEY}" \
  --quiet

SERVICE_URL=$(gcloud run services describe omoide-canvas --region asia-northeast1 --format='value(status.url)')
echo "=========================================================="
echo "🎉 Cloud Run 24時間公開デプロイが完了しました！"
echo "👉 公開URL: ${SERVICE_URL}"
echo "=========================================================="

# 固定ゲートウェイ (tunnel_endpoint.json) も Cloud Run URL に更新
UPDATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat <<EOF > docs/tunnel_endpoint.json
{
  "backend_url": "${SERVICE_URL}",
  "status": "online",
  "updated_at": "${UPDATED_AT}"
}
EOF
git add docs/tunnel_endpoint.json
if ! git diff --staged --quiet; then
    git commit -m "chore: point gateway to Cloud Run service URL [skip ci]"
    git push origin main
fi
