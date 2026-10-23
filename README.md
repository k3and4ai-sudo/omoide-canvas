---
title: Omoide Canvas
emoji: 🎨
colorFrom: green
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

# 🎨 おもいでキャンバス (omoide-canvas) v2.0
**〜 Gemini Live × 生成AI × マルチモーダル見守りによる認知症予防・回想法対話システム 〜**

ご本人（高齢者）の昔話や夢を優しく引き出し、その場で温かい『水彩画・映像・環境音』にして一緒に楽しむ対話パートナーアプリケーションです。
詳細な設計・医療安全基準については [`docs/specification.md`](docs/specification.md) をご参照ください。

---

## 🚀 24時間無料クラウド公開手順（方式B：GitHub連携）

手元のPCの電源を切っていても24時間いつでもスマートフォン・タブレットからアクセスできるよう、以下の2つの無料クラウド環境に完全対応しています。

### ルート①：Hugging Face Spaces（完全無料・クレジットカード登録不要）
1. [Hugging Face Spaces](https://huggingface.co/spaces) で **「Create new Space」** をクリックします。
2. Space名（例: `omoide-canvas`）を入力し、**Select the Space SDK** で **`Docker`**（Blank）を選択して作成します。
3. 作成した Space の **Settings** タブ ➔ **Variables and secrets** にて、**New secret** を押し、以下を登録します：
   - Name: `GEMINI_API_KEY`
   - Value: あなたの Gemini API キー
4. GitHub リポジトリと連携するか、このリポジトリをそのまま Space に Push します（`.github/workflows/deploy.yml` による GitHub 自動同期にも対応しています）。
5. 自動的にコンテナがビルドされ、`https://<ユーザー名>-omoide-canvas.hf.space` の固定URLで24時間公開されます！

### ルート②：Google Cloud Run（Google公式・常時無料枠・超低遅延）
1. [Google Cloud Console (Cloud Run)](https://console.cloud.google.com/run) を開きます。
2. **「サービスを作成」** ➔ **「ソースリポジトリから継続的にデプロイする（GitHub連携）」** を選択し、GitHub の `omoide-canvas` リポジトリを選択します（ビルドタイプ：`Dockerfile`）。
3. **「変数とシークレット」** タブで環境変数 `GEMINI_API_KEY` を設定します。
4. デプロイ完了後、発行された `https://omoide-canvas-xxxx.a.run.app` のURLで世界中どこからでもスマホ・タブレットで音声対話が可能です。
