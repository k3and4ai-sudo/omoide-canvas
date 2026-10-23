# Dockerfile (Google Cloud Run / Hugging Face Spaces 24時間クラウド稼働対応)
FROM python:3.12-slim

# 日本語フォント (Noto Sans CJK) のインストール（水彩画の和紙短冊タイトル描画用）
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# 作業ディレクトリ設定
WORKDIR /app

# 依存パッケージインストール
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# アプリケーションコードコピー
COPY . .

# ポート環境変数（Cloud Run: 8080 / Hugging Face Spaces: 7860 両対応）
ENV PORT=7860

# 保存ディレクトリの書き込み権限確保（Hugging Face Spacesの非rootユーザー1000番対応）
RUN mkdir -p static/memories static/reports && chmod -R 777 static

# サーバー起動コマンド
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-7860}"]
