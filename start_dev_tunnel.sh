#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_FILE="/tmp/omoide_dev_tunnel.log"
SERVER_LOG="/tmp/omoide_dev_server.log"
CLOUDFLARED_BIN="/media/k3and4/For_AI_Data/Antigravity/TestApp/Nursing_facility/cloudflared"

if [ ! -x "$CLOUDFLARED_BIN" ]; then
    CLOUDFLARED_BIN="cloudflared"
fi

echo "=========================================================="
echo "  📱 おもいでキャンバス 開発用スマホ接続トンネル (develop)"
echo "=========================================================="

# 1. サーバー (Port 8000) の確認・自動起動
if ! curl -s http://localhost:8000/api/health >/dev/null 2>&1; then
    echo "⚡ バックエンドサーバー (uvicorn) を起動しています..."
    "$SCRIPT_DIR/.venv/bin/uvicorn" backend.main:app --host 0.0.0.0 --port 8000 > "$SERVER_LOG" 2>&1 &
    sleep 3
    if ! curl -s http://localhost:8000/api/health >/dev/null 2>&1; then
        echo "❌ サーバーの起動に失敗しました。ログを確認してください:"
        cat "$SERVER_LOG"
        exit 1
    fi
    echo "✅ サーバーが起動しました (Port 8000)"
else
    echo "✅ サーバーは既に起動しています (Port 8000)"
fi

# 2. 既存の cloudflared プロセスを停止
pkill -f "cloudflared tunnel --url http://localhost:8000" 2>/dev/null || true
rm -f "$LOG_FILE"

# 3. トンネルの起動
echo "🌐 Cloudflare トンネルを起動しています..."
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

echo ""
echo "=========================================================="
echo "  🎉 開発用 HTTPS URL 発行完了！ (スマホから直接接続可能)"
echo "  👉 スマホアクセス用URL: $TUNNEL_URL"
echo "=========================================================="
echo "※ GitHub Pages (main) には影響を与えず、このPCの開発版に直結します。"
echo "※ 終了するには Ctrl+C を押してください。"
echo ""

wait "$TUNNEL_PID"
