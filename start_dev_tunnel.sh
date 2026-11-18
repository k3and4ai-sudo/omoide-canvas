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
    nohup "$SCRIPT_DIR/.venv/bin/uvicorn" backend.main:app --host 0.0.0.0 --port 8000 --reload > "$SERVER_LOG" 2>&1 &
    for i in {1..10}; do
        sleep 1
        if curl -s http://localhost:8000/api/health >/dev/null 2>&1; then
            break
        fi
    done
    if ! curl -s http://localhost:8000/api/health >/dev/null 2>&1; then
        echo "❌ サーバーの起動に失敗しました。ログを確認してください:"
        cat "$SERVER_LOG"
        exit 1
    fi
    echo "✅ サーバーが起動しました (Port 8000, hot-reload有効)"
else
    echo "✅ サーバーは既に起動しています (Port 8000)"
fi

# 2. トンネル (cloudflared) の確認（接続中なら既存URLを維持・再利用）
TUNNEL_URL=""
if pgrep -f "cloudflared tunnel --url http://localhost:8000" >/dev/null 2>&1 && [ -f "$LOG_FILE" ]; then
    FOUND_URL=$(grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' "$LOG_FILE" | head -n 1 || true)
    if [ -n "$FOUND_URL" ]; then
        TUNNEL_URL="$FOUND_URL"
        TUNNEL_PID=$(pgrep -f "cloudflared tunnel --url http://localhost:8000" | head -n 1)
        echo "✅ 既存の Cloudflare トンネルを継続利用します（URL変更なし）"
    fi
fi

# 3. トンネルが動いていない場合のみ新規起動
if [ -z "$TUNNEL_URL" ]; then
    pkill -f "cloudflared tunnel --url http://localhost:8000" 2>/dev/null || true
    rm -f "$LOG_FILE"
    echo "🌐 新規 Cloudflare トンネルを起動しています..."
    nohup "$CLOUDFLARED_BIN" tunnel --url http://localhost:8000 > "$LOG_FILE" 2>&1 &
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

echo ""
echo "=========================================================="
echo "  🎉 開発用 HTTPS URL 発行完了！ (スマホから直接接続可能)"
echo "  👉 スマホアクセス用URL: $TUNNEL_URL"
echo "=========================================================="
echo ""

if [ -x "$SCRIPT_DIR/.venv/bin/python" ]; then
    echo "📱 スマホ接続用 QR コード (カメラでスキャンして接続できます):"
    "$SCRIPT_DIR/.venv/bin/python" -c "
import qrcode
qr = qrcode.QRCode(
    version=1,
    error_correction=qrcode.constants.ERROR_CORRECT_M,
    box_size=12,
    border=4
)
qr.add_data('$TUNNEL_URL')
qr.make(fit=True)
qr.print_ascii(invert=True)
try:
    img = qr.make_image(fill_color='black', back_color='white')
    img.save('/tmp/omoide_tunnel_qr.png')
    # Antigravityのアーティファクトディレクトリがあれば自動コピー
    import glob, shutil
    for d in glob.glob('/home/k3and4/.gemini/antigravity/brain/*'):
        shutil.copy('/tmp/omoide_tunnel_qr.png', f'{d}/omoide_tunnel_qr.png')
    print('🖼️  高精細QRコード画像を保存・更新しました: /tmp/omoide_tunnel_qr.png')
except Exception as e:
    pass
"
    echo ""
fi

if [ "$1" = "--daemon" ] || [ "$1" = "--no-wait" ] || [ "$DAEMON" = "1" ]; then
    echo "🚀 デーモンモードで起動完了しました（プロセスはバックグラウンドで維持されます）。"
    exit 0
fi

echo "🛡️ 自動キープアライブ＆死活監視ループを開始しました（30秒間隔で通信維持ping送信中）"
echo "※ GitHub Pages (main) には影響を与えず、このPCの開発版に直結します。"
echo "※ 終了するには Ctrl+C を押してください。"
echo ""

FAIL_COUNT=0
while [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; do
    sleep 30

    # 公開トンネルURLにキープアライブpingを送信（通信をアクティブに保ちタイムアウトを防ぐ）
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$TUNNEL_URL/api/health" 2>/dev/null || echo "000")
    
    if [ "$HTTP_STATUS" = "200" ]; then
        FAIL_COUNT=0
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo "$(date '+%Y-%m-%d %H:%M:%S') ⚠️ キープアライブping失敗 (HTTP $HTTP_STATUS, 連続 $FAIL_COUNT 回)"
        
        # 連続3回失敗（約90秒通信途絶）した場合はトンネルを自動再起動して自己修復
        if [ "$FAIL_COUNT" -ge 3 ]; then
            echo "$(date '+%Y-%m-%d %H:%M:%S') 🔄 トンネル切断を検知しました。新規トンネルを自動再起動します..."
            kill "$TUNNEL_PID" 2>/dev/null || true
            sleep 2
            exec "$0" "$@"
        fi
    fi
done
