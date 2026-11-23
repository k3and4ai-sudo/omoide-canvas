# Project: omoide-canvas (おもいでキャンバス)

## 概要
Gemini Multimodal Live API と画像・動画生成AI（Imagen 3 / Veo）を組み合わせた、認知症予防・回想法・夢の視覚化対話アプリケーション。
詳細な要件・設計・プロンプトの安全基準については必ず `@docs/specification.md` を参照すること。

## 技術スタック・規約
- **OS / Path**: Ubuntu Linux (`/media/k3and4/For_AI_Data/Antigravity/TestApp/omoide-canvas`)
- **Backend**: Python 3.11+, FastAPI, `google-genai` SDK, Pydantic, WebSockets, Asyncio
- **Frontend**: HTML5 / JavaScript, WebAudio API (PCM 16kHz/24kHz 双方向ストリーミング)
- **非同期設計**: 画像・動画生成の実行中も、Gemini Liveの音声対話ストリームを絶対にブロックしないこと。
- **トンネル接続維持規約**:
  コード修正（リプログラム）完了後、Cloudflare トンネル（`cloudflared`）が接続中であれば絶対にトンネルを停止・変更しないこと。
  バックエンド更新は uvicorn のホットリロード（`--reload`）または uvicorn 単体の再起動で行い、同一の接続URL・QRコードを維持すること。

## ブランチ・開発・リリース運用規約（GitHub Pages 本番運用）
- **本番環境**: GitHub Pages（`https://k3and4ai-sudo.github.io/omoide-canvas/` / `origin/main` の `docs/` フォルダ配信・バックエンドなしのブラウザ直結モード）を本番とする。
- **開発・検証ブランチ（`develop`）**:
  - すべてのコード改修（`frontend/` の編集および `docs/` への同期コピー）と動作検証は `develop` ブランチ上で行うこと。
  - 開発・テスト中は `main`（`origin/main`）へ勝手にマージ・プッシュしないこと。
  - ローカルでの動作検証時は Python バックエンド（`uvicorn`）を起動せず、**静的ファイルサーバー**（例：`python3 -m http.server 8080 -d docs` → `http://localhost:8080`）を用いて、GitHub Pages と完全同一の「ブラウザ直結モード」で検証すること。
- **本番リリース（`main`）**:
  - `develop` での検証が完了し、**ユーザーの明示的なリリース承認を得た後のみ** `develop` を `main` へマージして `origin/main` へプッシュし、GitHub Pages 本番へ反映すること。
