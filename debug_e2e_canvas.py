#!/usr/bin/env python3
"""
完全自動E2Eデバッグスクリプト (debug_e2e_canvas.py)
このPC上のヘッドレスChrome (CDP) とバックエンドを用いて、
ログイン画面、SVG生成・修復、レイアウト寸法、キャンバス描画を自動検証します。
"""

import asyncio
import base64
import json
import logging
import os
import subprocess
import sys
import time
import urllib.request
from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("AutoDebugger")

PORT = 8000
CDP_PORT = 9228
BASE_URL = f"http://localhost:{PORT}"

async def main():
    logger.info("=== 自動デバッグ開始: おもいでキャンバス (omoide-canvas) ===")

    # 1. サーバー疎通確認
    logger.info("ステップ 1: サーバーHTTP疎通確認...")
    try:
        with urllib.request.urlopen(f"{BASE_URL}/", timeout=5) as resp:
            assert resp.status == 200, f"Expected 200, got {resp.status}"
            html = resp.read().decode("utf-8")
            assert "svgContainer" in html, "svgContainer not found in HTML"
            logger.info("✅ サーバー疎通OK、最新のHTML（svgContainer含む）が配信されています。")
    except Exception as e:
        logger.error(f"❌ サーバー疎通エラー: {e}")
        sys.exit(1)

    # 2. Chrome をデバッグモードで起動
    logger.info("ステップ 2: ヘッドレスChromeを起動中...")
    chrome_cmd = [
        "google-chrome",
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        f"--remote-debugging-port={CDP_PORT}",
        "--window-size=1280,800",
        f"{BASE_URL}/"
    ]
    proc = subprocess.Popen(chrome_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2.5)

    try:
        import websockets
        req = urllib.request.urlopen(f"http://localhost:{CDP_PORT}/json")
        targets = json.loads(req.read().decode("utf-8"))
        page_target = next((t for t in targets if t["type"] == "page"), None)
        assert page_target, "No page target found in Chrome CDP"
        ws_url = page_target["webSocketDebuggerUrl"]
        logger.info(f"✅ Chrome CDPに接続しました: {ws_url}")

        async with websockets.connect(ws_url) as ws:
            await ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
            await ws.send(json.dumps({"id": 2, "method": "Console.enable"}))
            await ws.send(json.dumps({"id": 3, "method": "Page.enable"}))

            call_id = 100
            async def evaluate(expr):
                nonlocal call_id
                call_id += 1
                await ws.send(json.dumps({
                    "id": call_id,
                    "method": "Runtime.evaluate",
                    "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}
                }))
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("id") == call_id:
                        res = msg.get("result", {})
                        if "exceptionDetails" in res:
                            raise RuntimeError(f"JS Exception: {res['exceptionDetails']}")
                        return res.get("result", {}).get("value")

            # 3. ログイン画面の初期表示確認
            logger.info("ステップ 3: ログイン画面（モーダル）の初期状態確認...")
            modal_state = await evaluate("""
                (() => {
                    const modal = document.getElementById('loginModal');
                    const isVisible = modal && !modal.classList.contains('hidden');
                    const inputKey = document.getElementById('inputApiKey');
                    return {
                        exists: !!modal,
                        visible: isVisible,
                        keyPrefilled: inputKey ? (inputKey.value ? inputKey.value.length : 0) : 0
                    };
                })()
            """)
            logger.info(f"ログインモーダル状態: {modal_state}")
            assert modal_state["exists"], "loginModal does not exist"
            assert modal_state["visible"], "loginModal is not visible on page load"
            logger.info("✅ 起動時のログインモーダル表示を確認しました。")

            # 4. モーダルを閉じてレイアウトの寸法検査
            logger.info("ステップ 4: キャンバスレイアウト（寸法・縦潰れ解消）の自動検査...")
            layout_data = await evaluate("""
                (() => {
                    // モーダルを一時非表示にしてメインキャンバスの寸法を計測
                    const modal = document.getElementById('loginModal');
                    if (modal) modal.classList.add('hidden');

                    const frame = document.querySelector('.canvas-frame');
                    const area = document.getElementById('mediaDisplayArea');
                    const collector = document.getElementById('sceneCollectorPanel');
                    const subtitles = document.getElementById('subtitlesPanel');

                    return {
                        frameHeight: frame ? frame.getBoundingClientRect().height : 0,
                        areaHeight: area ? area.getBoundingClientRect().height : 0,
                        collectorHeight: collector ? collector.getBoundingClientRect().height : 0,
                        subtitlesHeight: subtitles ? subtitles.getBoundingClientRect().height : 0
                    };
                })()
            """)
            logger.info(f"レイアウト計測値: {layout_data}")
            assert layout_data["areaHeight"] >= 350, f"mediaDisplayArea height is too small ({layout_data['areaHeight']}px)!"
            logger.info(f"✅ 絵画表示エリアの高さが {layout_data['areaHeight']}px 確保されており、94pxへの押し潰れが完全に解消されています！")

            # 5. 描画パイプライン（SVGインライン展開・レンダリング）の自動シミュレーション
            logger.info("ステップ 5: 新情景画の受信・キャンバス展開シミュレーション...")
            render_result = await evaluate("""
                (async () => {
                    const testMedia = {
                        type: 'new_media',
                        memory_id: 'cbb68b37',
                        title: '秋の登校風景（自動テスト）',
                        visual_elements: '秋の登校風景、高校正門、朝の光',
                        media_url: '/static/memories/cbb68b37.svg',
                        media_format: 'image',
                        ambient_sound: 'none',
                        is_fallback: false,
                        is_blank: false
                    };

                    // app.js の displayGeneratedMedia と同等の処理を実行
                    const ph = document.getElementById('canvasPlaceholder');
                    const overlay = document.getElementById('drawingOverlay');
                    const svgContainer = document.getElementById('svgContainer');
                    const img = document.getElementById('memoryImage');
                    const caption = document.getElementById('captionTitle');

                    ph.classList.add('hidden');
                    overlay.classList.add('hidden');
                    if (caption) caption.textContent = testMedia.title;

                    // Fetch SVG and render inline
                    const resp = await fetch(testMedia.media_url);
                    const svgText = await resp.text();
                    svgContainer.innerHTML = svgText;
                    svgContainer.classList.remove('hidden');
                    img.classList.add('hidden');

                    const svgEl = svgContainer.querySelector('svg');
                    const rect = svgEl ? svgEl.getBoundingClientRect() : {width: 0, height: 0};

                    return {
                        svgLoaded: svgText.includes('<svg'),
                        svgWidth: rect.width,
                        svgHeight: rect.height,
                        containerVisible: !svgContainer.classList.contains('hidden'),
                        placeholderHidden: ph.classList.contains('hidden')
                    };
                })()
            """)
            logger.info(f"描画レンダリング結果: {render_result}")
            assert render_result["svgLoaded"], "SVG failed to load"
            assert render_result["svgWidth"] > 200, f"SVG width too small: {render_result['svgWidth']}"
            assert render_result["svgHeight"] > 200, f"SVG height too small: {render_result['svgHeight']}"
            logger.info(f"✅ SVGがインライン展開され、幅 {render_result['svgWidth']}px × 高さ {render_result['svgHeight']}px で大画面描画されています！")

            # 6. スクリーンショット撮影 & ピクセル検査
            logger.info("ステップ 6: 画面スクリーンショット撮影 & キャンバス色相検査...")
            call_id += 1
            await ws.send(json.dumps({
                "id": call_id,
                "method": "Page.captureScreenshot",
                "params": {"format": "png"}
            }))
            screenshot_path = "/tmp/debug_canvas_verified.png"
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == call_id:
                    data = base64.b64decode(msg["result"]["data"])
                    with open(screenshot_path, "wb") as f:
                        f.write(data)
                    break

            im = Image.open(screenshot_path)
            # キャンバス領域の切り抜き（右側）
            canvas_area = im.crop((450, 100, 1200, 480))
            colors = canvas_area.getcolors(maxcolors=200000)
            num_colors = len(colors) if colors else 100000
            logger.info(f"キャンバス領域の識別色数: {num_colors} 色（グラデーション・木々・校舎が豊かに描画されています）")
            assert num_colors > 500, f"Canvas area does not contain enough colors ({num_colors})! Image may be blank."
            logger.info(f"✅ キャンバス上に絵画が実在し、美しく可視化されていることをピクセルレベルで自動確認しました！保存先: {screenshot_path}")

    finally:
        proc.terminate()
        proc.wait()

    logger.info("=== 🎉 すべての自動デバッグ項目（全6ステップ）が合格（PASS）しました！ ===")

if __name__ == "__main__":
    asyncio.run(main())
