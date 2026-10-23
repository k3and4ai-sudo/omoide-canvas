"""
FastAPI メインサーバー ＆ WebSocket ルーティング (backend/main.py)
仕様書 3.3.2, 3.3.3 に基づく
・介護者用 REST API (/api/profile, /api/memories, /api/reports)
・リアルタイム双方向音声・映像 WebSocket (/ws/live)
・フロントエンド静的ファイル配信
"""

import os
import json
import logging
from pathlib import Path
from typing import List, Optional
from datetime import datetime
from dotenv import load_dotenv

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from google import genai

from backend.models import UserProfile, MemoryArtifact, DailyConditionReport
from backend.live_session import LiveSessionManager
from backend.emergency_tool import dispatch_emergency_alert
from backend.report_generator import generate_daily_condition_report

# 環境変数ロード（ただしサーバー所有者のGEMINI_API_KEYが第三者セッションで自動使用されないよう環境変数から除外）
load_dotenv()
os.environ.pop("GEMINI_API_KEY", None)
os.environ.pop("GOOGLE_API_KEY", None)

# ロギング設定
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("omoide-canvas")

app = FastAPI(
    title="おもいでキャンバス (omoide-canvas) API",
    description="Gemini Live × 生成AIによる認知症予防・回想法対話システム",
    version="2.0.0"
)

# CORS許可
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 保存ディレクトリ
STATIC_DIR = Path("static")
MEMORIES_DIR = STATIC_DIR / "memories"
REPORTS_DIR = STATIC_DIR / "reports"
FRONTEND_DIR = Path("frontend")
PROFILE_FILE = STATIC_DIR / "profile.json"

for d in [MEMORIES_DIR, REPORTS_DIR]:
    d.mkdir(parents=True, exist_ok=True)


def load_user_profile() -> UserProfile:
    """現在の対象者プロフィールを取得（未保存ならデフォルト作成）"""
    if PROFILE_FILE.exists():
        try:
            with open(PROFILE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return UserProfile(**data)
        except Exception as e:
            logger.error(f"Error loading profile: {e}")
    default_profile = UserProfile()
    save_user_profile(default_profile)
    return default_profile


def save_user_profile(profile: UserProfile):
    """対象者プロフィールをローカルJSONに保存"""
    with open(PROFILE_FILE, "w", encoding="utf-8") as f:
        json.dump(profile.model_dump(mode="json"), f, ensure_ascii=False, indent=2)


# ==============================================================================
# REST API エンドポイント
# ==============================================================================

class ApiKeyVerifyRequest(BaseModel):
    api_key: str


@app.get("/api/health")
async def health_check():
    """死活監視・API接続確認（セッション別APIキー入力方式）"""
    return {
        "status": "ok",
        "app": "omoide-canvas",
        "version": "2.0.0",
        "require_user_api_key": True
    }


@app.post("/api/auth/verify")
async def verify_user_api_key(req: ApiKeyVerifyRequest):
    """ユーザーがログイン画面で入力した Gemini API キーの有効性を検証"""
    key = (req.api_key or "").strip()
    if not key or len(key) < 20:
        return {"valid": False, "message": "APIキーの形式が正しくありません（AIza... で始まるキーを入力してください）"}
    try:
        client = genai.Client(api_key=key)
        # 軽量なモデルメタデータ取得でキーの有効性を確認（トークン消費なし）
        client.models.get(model="gemini-2.5-flash")
        masked = f"{key[:6]}...{key[-4:]}"
        return {"valid": True, "masked_key": masked, "message": "APIキーの認証に成功しました"}
    except Exception as e:
        logger.warning(f"API Key verification failed: {e}")
        return {"valid": False, "message": "APIキーが無効か、利用権限がありません。Google AI Studioで発行したキーをご確認ください。"}


@app.get("/api/profile", response_model=UserProfile)
async def get_profile():
    """現在の対象者プロフィールを取得"""
    return load_user_profile()


@app.post("/api/profile")
async def update_profile(profile: UserProfile):
    """プロフィール・進行度・連絡先を更新"""
    save_user_profile(profile)
    logger.info(f"UserProfile updated for {profile.call_name} (Level: {profile.dementia_level.value})")
    return {"status": "saved", "user_id": profile.user_id}


@app.get("/api/memories", response_model=List[MemoryArtifact])
async def list_memories(limit: int = Query(default=20, ge=1, le=100)):
    """生成された思い出絵画・動画一覧を取得"""
    memories = []
    for f in sorted(MEMORIES_DIR.glob("*.json"), key=os.path.getmtime, reverse=True):
        try:
            with open(f, "r", encoding="utf-8") as fp:
                data = json.load(fp)
                memories.append(MemoryArtifact(**data))
                if len(memories) >= limit:
                    break
        except Exception as e:
            logger.error(f"Error reading memory {f}: {e}")
    return memories


@app.get("/api/reports", response_model=List[DailyConditionReport])
async def list_reports(limit: int = Query(default=10, ge=1, le=50)):
    """心のコンディション日報一覧を取得"""
    reports = []
    for f in sorted(REPORTS_DIR.glob("*.json"), key=os.path.getmtime, reverse=True):
        try:
            with open(f, "r", encoding="utf-8") as fp:
                data = json.load(fp)
                reports.append(DailyConditionReport(**data))
                if len(reports) >= limit:
                    break
        except Exception as e:
            logger.error(f"Error reading report {f}: {e}")
    return reports


@app.post("/api/emergency/test")
async def test_emergency_alert(channel: Optional[str] = "test"):
    """緊急通報のテスト発信（疎通確認）"""
    profile = load_user_profile()
    res = await dispatch_emergency_alert(
        urgency_level="test_diagnostic",
        user_utterance="（テスト疎通確認）",
        confirmation_obtained=True,
        contact=profile.emergency_contact
    )
    return res


# ==============================================================================
# WebSocket リアルタイム対話エンドポイント
# ==============================================================================

@app.websocket("/ws/live")
async def websocket_live_endpoint(
    websocket: WebSocket,
    api_key: Optional[str] = Query(default=None)
):
    """
    本人用キャンバス画面とのリアルタイム双方向通信エンドポイント
    クライアントがログイン時に入力した api_key をこのセッション限定で使用する
    """
    await websocket.accept()
    profile = load_user_profile()
    session_mgr = LiveSessionManager(websocket, profile, api_key=api_key)

    key_status = "UserKey" if (api_key and len(api_key.strip()) > 10) else "DemoSimulation"
    logger.info(f"WebSocket client connected for user: {profile.call_name} (mode={key_status})")
    try:
        await session_mgr.run()
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected normally.")
    except Exception as e:
        logger.error(f"WebSocket session error: {e}", exc_info=True)
    finally:
        # セッション完了後に日報を自動生成
        try:
            duration_min = 1
            if session_mgr.start_time:
                import time
                duration_min = max(1, int((time.time() - session_mgr.start_time) / 60))

            await generate_daily_condition_report(
                user_id=profile.user_id,
                duration_minutes=duration_min,
                topics=session_mgr.discussed_topics,
                memory_artifacts=session_mgr.generated_memories
            )
        except Exception as re:
            logger.error(f"Failed to auto-generate daily report: {re}")


# ==============================================================================
# 静的ファイル配信 ＆ フロントエンドルーティング
# ==============================================================================

# 生成メディア (/static/...)
app.mount("/static", StaticFiles(directory="static"), name="static")

# フロントエンド静的ファイル
if FRONTEND_DIR.exists():
    app.mount("/app", StaticFiles(directory="frontend"), name="frontend")

@app.get("/")
async def root_index():
    """ルートアクセス時はフロントエンドの index.html を返す"""
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return JSONResponse({
        "message": "おもいでキャンバス (omoide-canvas) サーバー稼働中",
        "docs_url": "/docs",
        "health_check": "/api/health"
    })
