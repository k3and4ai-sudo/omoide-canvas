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

# 1. 既存のトンネル確認（接続中なら既存URLを維持・再利用）
TUNNEL_URL=""
if pgrep -f "cloudflared tunnel --url http://localhost:8000" >/dev/null 2>&1 && [ -f "$LOG_FILE" ]; then
    FOUND_URL=$(grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' "$LOG_FILE" | head -n 1 || true)
    if [ -n "$FOUND_URL" ]; then
        TUNNEL_URL="$FOUND_URL"
        TUNNEL_PID=$(pgrep -f "cloudflared tunnel --url http://localhost:8000" | head -n 1)
        echo "✅ 既存の Cloudflare トンネルを継続利用します（URL変更なし: $TUNNEL_URL）"
    fi
fi

# 2. トンネルが動いていない場合のみ新規起動
if [ -z "$TUNNEL_URL" ]; then
    pkill -f "cloudflared tunnel --url http://localhost:8000" 2>/dev/null || true
    rm -f "$LOG_FILE"

    "$CLOUDFLARED_BIN" tunnel --url http://localhost:8000 > "$LOG_FILE" 2>&1 &
    TUNNEL_PID=$!

    echo "トンネルURLの発行を待機中..."
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
echo ""

if [ -x "$SCRIPT_DIR/.venv/bin/python" ]; then
    echo "📱 スマホ接続用 QR コード (カメラでスキャンして接続できます):"
    "$SCRIPT_DIR/.venv/bin/python" -c "
import qrcode
qr = qrcode.QRCode(border=2)
qr.add_data('$TUNNEL_URL')
qr.print_ascii(invert=True)
try:
    img = qr.make_image(fill_color='black', back_color='white')
    img.save('/tmp/omoide_tunnel_qr.png')
    print('🖼️  QRコード画像も保存しました: /tmp/omoide_tunnel_qr.png')
except Exception:
    pass
"
    echo ""
fi

if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    while kill -0 "$TUNNEL_PID" 2>/dev/null; do
        sleep 1
    done
fi
