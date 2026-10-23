#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_FILE="/tmp/omoide_tunnel.log"
ENDPOINT_JSON="docs/tunnel_endpoint.json"
CLOUDFLARED_BIN="/media/k3and4/For_AI_Data/Antigravity/TestApp/Nursing_facility/cloudflared"

if [ ! -x "$CLOUDFLARED_BIN" ]; then
    CLOUDFLARED_BIN="cloudflared"
fi

echo "=========================================================="
echo "  🎨 おもいでキャンバス Cloudflare トンネル ＆ GitHub 自動同期"
echo "=========================================================="

pkill -f "cloudflared tunnel --url http://localhost:8000" 2>/dev/null || true
rm -f "$LOG_FILE"

"$CLOUDFLARED_BIN" tunnel --url http://localhost:8000 > "$LOG_FILE" 2>&1 &
TUNNEL_PID=$!

echo "トンネルURLの発行を待機中..."
TUNNEL_URL=""
for i in {1..30}; do
    sleep 1
    if [ -f "$LOG_FILE" ]; then
        FOUND_URL=$(grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' "$LOG_FILE" | head -n 1 || true)
        if [ -n "$FOUND_URL" ]; then
            TUNNEL_URL="$FOUND_URL"
            break
        fi
    fi
done

if [ -z "$TUNNEL_URL" ]; then
    echo "❌ トンネルURLの取得に失敗しました:"
    cat "$LOG_FILE"
    kill "$TUNNEL_PID" 2>/dev/null || true
    exit 1
fi

echo "✅ トンネルURLを発行しました: $TUNNEL_URL"

UPDATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat <<EOF > "$ENDPOINT_JSON"
{
  "backend_url": "$TUNNEL_URL",
  "status": "online",
  "updated_at": "$UPDATED_AT"
}
EOF

git add "$ENDPOINT_JSON" docs/index.html
if ! git diff --staged --quiet; then
    git commit -m "chore: update public tunnel endpoint [skip ci]"
    git push origin main
    echo "🚀 GitHub への同期が完了しました！"
fi

echo "=========================================================="
echo "  🎉 外部HTTPS公開URL（スマホ・タブレットから警告なしで即接続可能）:"
echo "  👉 直接URL: $TUNNEL_URL"
echo "  👉 固定URL: https://k3and4ai-sudo.github.io/omoide-canvas/"
echo "=========================================================="

wait "$TUNNEL_PID"
