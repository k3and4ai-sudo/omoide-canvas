"""
Gemini Live API 双方向セッション管理モジュール (backend/live_session.py)
仕様書 FR-03, FR-04, 3.3.3, 4.3 に基づく
・フルデュプレックス双方向音声（PCM 16kHz 入力 / 24kHz 出力）
・1FPS カメラ映像フレームの送信
・Function Calling (generate_memory_visual, refine_memory_visual, trigger_emergency_alert)
・会話を止めない非同期バックグラウンドメディア生成
"""

import os
import re
import time
import json
import base64
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional, List
from fastapi import WebSocket

from google import genai
from google.genai import types

from backend.models import (
    UserProfile,
    DementiaLevel,
    SceneType,
    MediaFormat,
    AmbientSoundType,
    MemoryArtifact
)
from backend.prompt_builder import build_system_instruction
from backend.media_generator import (
    generate_memory_visual_artifact,
    generate_memory_visual_artifact_sync,
    refine_memory_visual_artifact
)
from backend.emergency_tool import dispatch_emergency_alert

logger = logging.getLogger(__name__)

def get_pacific_reset_time_jst() -> str:
    """米太平洋時間の午前0時（Google APIクォータリセット時刻）に対応する日本時間を動的算出（夏時間16:00 / 冬時間17:00）"""
    try:
        from zoneinfo import ZoneInfo
        now_utc = datetime.now(timezone.utc)
        pt_now = now_utc.astimezone(ZoneInfo("America/Los_Angeles"))
        return "16:00" if pt_now.tzname() == "PDT" else "17:00"
    except Exception:
        return "16:00"

def correct_japanese_homophones(text: str) -> str:
    """音声認識で頻出する同音異義語の誤変換を文脈に応じて補正する（例: ペットの『買って』→『飼って』）"""
    if not text:
        return ""
    import re
    t = text
    # ペット・動物の「買って」→「飼って」補正
    t = re.sub(r'(昔|家|実家|子供の頃|子どもの頃|幼い頃|若い頃|以前|前)?\s*(買っていた|買ってました|買ってた|買っていたの|買っていたんだ|買ってたんだ)\s*(犬|猫|ペット|小鳥|柴犬|ワンちゃん|わんちゃん|ネコ|ねこ|子犬|子猫)', r'\1飼っていた\3', t)
    t = re.sub(r'(犬|猫|ペット|小鳥|柴犬|ワンちゃん|わんちゃん|ネコ|ねこ|子犬|子猫)\s*を?\s*(買っていた|買ってました|買ってた)', r'\1を飼っていた', t)
    t = re.sub(r'(買っていた|買ってました|買ってた)\s*(犬|猫|ペット|小鳥|柴犬|ワンちゃん|わんちゃん|ネコ|ねこ|子犬|子猫)', r'飼っていた\2', t)
    t = re.sub(r'(犬|猫|ペット|小鳥|柴犬|ワンちゃん|わんちゃん|ネコ|ねこ|子犬|子猫)\s*を?\s*(買|か)う', r'\1を飼う', t)
    t = re.sub(r'(犬|猫|ペット|小鳥|柴犬|ワンちゃん|わんちゃん|ネコ|ねこ|子犬|子猫)\s*を?\s*(買|か)った', r'\1を飼った', t)
    t = re.sub(r'(犬|猫|ペット|小鳥|柴犬|ワンちゃん|わんちゃん|ネコ|ねこ|子犬|子猫)\s*を?\s*(買|か)って', r'\1を飼って', t)
    t = re.sub(r'(犬|猫|ペット|小鳥|柴犬|ワンちゃん|わんちゃん|ネコ|ねこ|子犬|子猫)\s*を?\s*(買|か)いたい', r'\1を飼いたい', t)
    return t

# Live API 対応モデル（デフォルト: 双方向オーディオ対応ネイティブモデル）
DEFAULT_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-2.5-flash-native-audio-preview-09-2025")


class LiveSessionManager:
    """
    1クライアントと Gemini Live API 間の双方向リアルタイム接続を統括するマネージャー
    """

    def __init__(
        self,
        websocket: WebSocket,
        profile: UserProfile,
        api_key: Optional[str] = None,
        recent_topic: str = "",
        last_art: str = "",
        is_resume: bool = False
    ):
        self.websocket = websocket
        self.profile = profile
        self.api_key = (api_key or "").strip()
        self.recent_topic = (recent_topic or "").strip()
        self.last_art = (last_art or "").strip()
        self.is_resume = bool(is_resume)
        self.is_active = False
        self.session_task: Optional[asyncio.Task] = None
        self.generated_memories: List[MemoryArtifact] = []
        self.discussed_topics: List[str] = [self.recent_topic] if self.recent_topic else []
        self.start_time: Optional[float] = None
        self.current_ai_turn_text: str = ""
        self.current_user_turn_text: str = ""
        self.last_drawn_topic: str = ""
        self.tool_called_in_turn: bool = False
        self.echo_guard_until: float = time.time() + 2.5  # セッション開始時〜最初の挨拶完了まで保護
        self.ai_playback_until: float = 0.0              # AI返答音声の推定再生完了時刻
        self.echo_dropped_packets: int = 0               # エコーガードにより遮断したマイクパケット数
        self.last_ai_output_time: float = 0.0            # Geminiが最後に返答音声/字幕を出力した時刻
        self.last_gemini_input_time: float = 0.0         # Geminiが最後にinput_transcriptionを出力した時刻
        self.user_transcript_seq: int = 0                # user_transcript受信シーケンス番号（無応答時フォールバック用）
        self.input_trans_seq: int = 0                    # Gemini input_transcription シーケンス番号
        self.collector_status: str = "idle"              # フロントエンドの6ステップ収集状態 ('idle'|'collecting'|'confirming'|'ready'|'drawing'|'drawn')
        self.collector_active_step: str = "topic"        # 現在聞き取り中のステップ
        self.collector_completed_count: int = 0          # 6ステップのうち完了（入力済またはスキップ済）した数
        self.collector_summary: str = ""                 # 6ステップの要約文字列
        self.ai_asked_confirmation: bool = False         # AIが「一通りお話を伺いました〜よろしいでしょうか？」と最終確認を尋ねたか
        self.user_confirmed_drawing: bool = False        # 最終確認に対してご本人が「はい・描いてください」と承認したか
        self.is_generating_media: bool = False           # 現在バックエンドで画像生成が進行中か
        self.last_draw_time: float = 0.0                # 連続描画防止・クォータ保護用タイムスタンプ
        self.MIN_DRAW_INTERVAL_SEC: float = 120.0       # 描画間隔の最小時間（2分 = 120秒）

    def _check_user_utterance_for_draw_approval(self, user_text: str) -> None:
        """
        6ステップ聞き取り完了後の最終確認（confirming / ready）に対して、
        ご本人が明確に「はい」「このままでいいです」「描いてください」と承認されたかを判定する。
        ※聞き取り確認の前にフライングで描画が始まるのを防ぐため、このフラグが True になるまで generate_memory_visual を許可しない。
        """
        if not user_text:
            return
        clean = re.sub(r"\s+", "", user_text.strip())
        if len(clean) < 2:
            return
        # すでに描画完了（drawn）または描画中（drawing）の場合は新規描画承認にしない
        if self.collector_status in ("drawing", "drawn") or self.is_generating_media:
            return

        modify_or_reject_words = (
            "修正", "直して", "変えて", "変更", "やり直し", "もう一度", "もう一回",
            "聞き取り", "聞いて", "違う", "ちがう", "まだ", "いいえ", "いや", "待って"
        )
        if any(mw in clean for mw in modify_or_reject_words):
            return

        # 明示的な即時描画指示（「このまま絵を描いてください」「今すぐ描いて」等）
        explicit_draw_cmds = (
            "今すぐ描いて", "今すぐ書いて", "このまま絵を描いて", "このまま絵を書いて",
            "このまま描いて", "このまま書いて", "絵を描いてください", "絵を書いてください",
            "キャンバスに描いて", "キャンバスに書いて", "この内容で描いて", "この内容で書いて"
        )
        if any(cmd in clean for cmd in explicit_draw_cmds) and (
            self.collector_status in ("confirming", "ready")
            or self.ai_asked_confirmation
            or self.collector_completed_count >= 5
        ):
            self.user_confirmed_drawing = True
            logger.info(f"User explicitly approved drawing command: '{clean}'")
            return

        # AIが最終確認（「一通りお話を伺いました〜よろしいでしょうか？」）を尋ねた後の肯定返答
        if self.collector_status in ("confirming", "ready") or self.ai_asked_confirmation:
            approval_words = (
                "はい", "うん", "ええ", "いいよ", "いいですよ", "いいです", "良いです", "よいです",
                "これでいい", "これで良い", "このまま", "大丈夫", "問題ない", "問題ありません",
                "間違いありません", "お願い", "描いて", "書いて", "そうして", "ぜひ", "よろしく",
                "OK", "オッケー"
            )
            if any(aw in clean for aw in approval_words):
                self.user_confirmed_drawing = True
                logger.info(f"User confirmed 6-step summary for drawing: '{clean}'")

    async def run(self):
        """セッションの開始・メインループ管理（ユーザー自身のセッションAPIキーを使用）"""
        self.is_active = True
        self.start_time = time.time()
        api_key = self.api_key

        if not api_key or api_key == "your_gemini_api_key_here":
            logger.warning("Session API Key is not provided. Running in local simulation mode.")
            await self._run_simulation_mode()
            return

        try:
            client = genai.Client(api_key=api_key)
            system_instruction = build_system_instruction(
                self.profile,
                recent_topic=self.recent_topic,
                last_art=self.last_art,
                is_resume=self.is_resume
            )

            # Function Calling ツール定義（引数の意味と具体性をGeminiに厳密に指示）
            def generate_memory_visual(
                scene_type: str,
                japanese_title: str,
                visual_elements: str,
                media_format: str = "image",
                ambient_sound: str = "none"
            ) -> str:
                """
                対象者が語った思い出や夢の風景を水彩画として描画するツール。
                
                Args:
                    scene_type: 風景の分類 ('past_memory' | 'dream_scenery')
                    japanese_title: 描く絵の具体的な題名（例: '庭いっぱいに咲く赤いバラ', '昭和30年代の信州松本駅'）。抽象的な題名は禁止。
                    visual_elements: 会話で聞き取った具体的な情景要素（事物、植物、花、建物、色、配置、天候）を詳細に列挙した文字列。
                                     【最重要】必ず会話の中でご本人が語った具体的な言葉（例: '真っ赤なバラの花壇、白い木製の柵、緑の芝生、降り注ぐ朝の光'）を漏れなく含めてください。抽象的な表現のみ（日差し、風など）は厳禁です。
                    media_format: メディア形式 ('image' のみ)
                    ambient_sound: 環境音 ('autumn_insects' | 'river' | 'waves' | 'none')
                """
                return "Media generation started in background."

            def refine_memory_visual(
                original_memory_id: str,
                user_feedback: str,
                updated_visual_elements: str
            ) -> str:
                """
                対象者からの修正希望（描き直しフィードバック）を反映して絵を再描画するツール。
                
                Args:
                    original_memory_id: 直前の絵のID
                    user_feedback: 相手が言った具体的な修正指示（例: '夕焼け空にして', '窓際に赤いバラを置いて'）
                    updated_visual_elements: 修正指示を反映した新しい全体情景の具体的描写（具体的な事物、色彩を必ず含むこと）
                """
                return "Media refinement started in background."

            def trigger_emergency_alert(
                urgency_level: str,
                user_utterance: str,
                confirmation_obtained: bool
            ) -> str:
                """対象者のSOSや苦痛について本人確認が得られた際、家族へ緊急通知を発信する"""
                return "Emergency alert dispatched."

            # パートナーの性別・音声設定に応じて Gemini Live の声を選択
            partner = self.profile.partner
            selected_voice = partner.voice_name if (partner and partner.voice_name) else (
                "Puck" if (partner and partner.gender == "男性") else "Aoede"
            )

            # ノイズ感度: 標準高感度（normal）をデフォルトにし、ご本人の小さな声やささやきも確実に拾う
            noise_mode = getattr(self.profile, "noise_gate_mode", "normal") or "normal"

            config = types.LiveConnectConfig(
                response_modalities=["AUDIO"],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(
                            voice_name=selected_voice
                        )
                    )
                ),
                # 思考トークン（Thinking）を0にして、話し終えた瞬間に即座に返答させる（超低遅延化）
                thinking_config=types.ThinkingConfig(
                    thinking_budget=0
                ),
                # 音声区間検出（VAD）：話し始めと話し終わりを機敏に検知し、自然な対話テンポ（650ms無音で返答）を実現
                realtime_input_config=types.RealtimeInputConfig(
                    automatic_activity_detection=types.AutomaticActivityDetection(
                        disabled=False,
                        start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
                        end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_HIGH,
                        prefix_padding_ms=300,
                        silence_duration_ms=650
                    )
                ),
                system_instruction=system_instruction,
                output_audio_transcription=types.AudioTranscriptionConfig(),
                input_audio_transcription=types.AudioTranscriptionConfig(),
                tools=[generate_memory_visual, refine_memory_visual, trigger_emergency_alert]
            )

            reconnect_attempts = 0
            max_reconnects = 3
            while self.is_active and reconnect_attempts < max_reconnects:
                try:
                    logger.info(f"Connecting to Gemini Live API ({DEFAULT_LIVE_MODEL}, voice={selected_voice}, noise_mode={noise_mode}, attempt={reconnect_attempts + 1})...")
                    async with client.aio.live.connect(model=DEFAULT_LIVE_MODEL, config=config) as session:
                        logger.info("Connected to Gemini Live API successfully!")
                        reconnect_attempts = 0
                        await self.websocket.send_json({
                            "type": "session_ready",
                            "call_name": self.profile.call_name,
                            "partner_name": partner.name if partner else "さくら",
                            "partner_gender": partner.gender if partner else "女性",
                            "noise_gate_mode": noise_mode,
                            "dementia_level": self.profile.dementia_level.value
                        })

                        # セッション開始直後にAIパートナーから温かい第一声（挨拶または前回の続き）を発話させる
                        raw_name = (self.profile.call_name or "お父さん").strip()
                        nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                        p_name = partner.name if (partner and partner.name) else "さくら"
                        topic_for_resume = (self.last_art or self.recent_topic or (self.discussed_topics[-1] if self.discussed_topics else "")).strip()

                        if self.is_resume and (topic_for_resume or self.collector_status != "idle"):
                            ctx_desc = f"「{topic_for_resume}」" if topic_for_resume else "先ほど"
                            if self.collector_status == "drawn" or len(self.generated_memories) > 0:
                                last_art_title = self.generated_memories[-1].title if self.generated_memories else (topic_for_resume or "思い出の絵")
                                initial_greeting_prompt = (
                                    f"対話セッションが自動復旧しました。あなたの名前は「{p_name}」です。"
                                    f"直前に「{last_art_title}」の絵が完成し、すでに{nickname}の画面に表示されています！"
                                    f"{nickname}に向かって、「{nickname}、画面に絵が浮かびましたよ！こんな雰囲気でよろしいでしょうか？」と温かく声に出して問いかけてください。"
                                    f"※「どんな思い出がありましたか？」等の過去の聞き取り質問は絶対に繰り返さないでください。"
                                )
                            elif self.collector_status in ("collecting", "confirming", "ready"):
                                initial_greeting_prompt = (
                                    f"対話セッションが自動復旧しました。あなたの名前は「{p_name}」です。"
                                    f"直前まで{nickname}と絵を描くための聞き取り（話題：{ctx_desc}、ステップ：{self.collector_active_step}）を行っていました。"
                                    f"{nickname}に向かって、「{nickname}、先ほどの{ctx_desc}のお話の続きを伺ってもよろしいですか？」のように、"
                                    f"初対面の挨拶（こんにちは、今日もお元気でしたか等）は絶対に言わず、直前の思い出聞き取りの続きを自然に促す温かい声かけをしてください。"
                                )
                            else:
                                initial_greeting_prompt = (
                                    f"対話セッションが再開されました。あなたの名前は「{p_name}」です。"
                                    f"直前まで{nickname}と{ctx_desc}について楽しくお話ししていました。"
                                    f"{nickname}に向かって、「{nickname}、先ほどの{ctx_desc}のお話の続きをしましょうか！」のように、"
                                    f"初対面の挨拶（こんにちは、今日もお元気でしたか等）は完全に省略して、直前のお話の続きを自然に促す温かい第一声を声に出して話しかけてください。"
                                )
                        else:
                            initial_greeting_prompt = (
                                f"対話セッションが開始されました。あなたの名前は「{p_name}」です。"
                                f"{nickname}に向かって、「こんにちは、{nickname}！{p_name}です。今日も気持ちのいい日ですね。お元気でしたか？」のように、"
                                f"あなたの性格（{partner.personality if partner else '優しく穏やか'}）らしく、短く温かく最初の挨拶を声に出して話しかけてください。"
                            )
                        try:
                            # 最初の挨拶を発話している間はスピーカー音をマイクが拾って中断しないよう一時保護
                            self.echo_guard_until = time.time() + 3.0
                            await session.send_client_content(
                                turns=[types.Content(role="user", parts=[types.Part.from_text(text=initial_greeting_prompt)])],
                                turn_complete=True
                            )
                        except Exception as greet_err:
                            logger.warning(f"Initial greeting trigger warning: {greet_err}")

                        # 上り（ブラウザ -> Gemini）と下り（Gemini -> ブラウザ）を並走
                        client_to_gemini = asyncio.create_task(self._relay_client_to_gemini(session))
                        gemini_to_client = asyncio.create_task(self._relay_gemini_to_client(session))

                        done, pending = await asyncio.wait(
                            [client_to_gemini, gemini_to_client],
                            return_when=asyncio.FIRST_COMPLETED
                        )

                        for task in pending:
                            task.cancel()

                        # タスク終了時のエラーログ
                        for task in done:
                            if not task.cancelled() and task.exception():
                                logger.warning(f"Relay task raised exception: {task.exception()}")

                        # クライアントとのWebSocketが生きていてリレーループを抜けた場合はGeminiの異常切断なので再接続準備
                        if self.is_active:
                            reconnect_attempts += 1
                            self.is_resume = True
                            if self.discussed_topics:
                                self.recent_topic = self.discussed_topics[-1]
                            if reconnect_attempts < max_reconnects:
                                logger.info(f"Reconnecting to Gemini Live API in 1.0s... ({reconnect_attempts}/{max_reconnects})")
                                await asyncio.sleep(1.0)
                            else:
                                logger.error(f"Exceeded max reconnect attempts ({max_reconnects}). Terminating session.")
                                await self.websocket.send_json({"type": "error", "message": "Gemini Live APIとの接続が連続して切断されました。"})
                                break

                except Exception as e:
                    logger.warning(f"Live session connection warning (attempt {reconnect_attempts + 1}): {e}")
                    if not self.is_active:
                        break
                    reconnect_attempts += 1
                    if reconnect_attempts < max_reconnects:
                        logger.info(f"Reconnecting to Gemini Live API in 1.0s... ({reconnect_attempts}/{max_reconnects})")
                        self.is_resume = True
                        if self.discussed_topics:
                            self.recent_topic = self.discussed_topics[-1]
                        await asyncio.sleep(1.0)
                    else:
                        logger.error(f"Exceeded max reconnect attempts ({max_reconnects}). Terminating session.")
                        await self.websocket.send_json({"type": "error", "message": f"Gemini接続エラー: {e}"})
                        break

        except Exception as e:
            logger.error(f"Live session encountered error: {e}", exc_info=True)
            try:
                await self.websocket.send_json({"type": "error", "message": str(e)})
            except Exception:
                pass
        finally:
            self.is_active = False
            logger.info("Live session ended.")

    async def _relay_client_to_gemini(self, session):
        """ブラウザからの音声・映像・制御イベントを Gemini Live へ中継"""
        while self.is_active:
            try:
                message = await self.websocket.receive()
                if "bytes" in message and message["bytes"]:
                    # AI発話中（スピーカー出音・部屋の残響期間）はマイクPCMをGeminiに絶対に送らない！
                    # （スピーカー音をマイクが拾ってAIが自己中断・バージインしてしまうエコー干渉を100%完全遮断）
                    if time.time() < self.echo_guard_until:
                        self.echo_dropped_packets += 1
                        if self.echo_dropped_packets % 50 == 1:
                            logger.info(f"[EchoGuard] Shielded mic input ({self.echo_dropped_packets} chunks dropped, {self.echo_guard_until - time.time():.1f}s remaining)")
                        continue
                    # Raw PCM 16kHz 音声ストリーム
                    pcm_data = message["bytes"]
                    await session.send_realtime_input(
                        audio=types.Blob(
                            data=pcm_data,
                            mime_type="audio/pcm;rate=16000"
                        )
                    )

                elif "text" in message and message["text"]:
                    data = json.loads(message["text"])
                    msg_type = data.get("type")

                    if msg_type == "camera_frame":
                        # 1FPS WebRTC カメラ画像フレーム (JPEG)
                        image_b64 = data.get("data", "")
                        if "," in image_b64:
                            image_b64 = image_b64.split(",")[1]
                        image_bytes = base64.b64decode(image_b64)
                        await session.send_realtime_input(
                            video=types.Blob(
                                data=image_bytes,
                                mime_type="image/jpeg"
                            )
                        )

                    elif msg_type == "ai_speech_ended":
                        # ブラウザ側でAI返答音声のスピーカー再生が完了した通知を受信
                        # 直ちにエコーガードを解除し、ユーザーの話し始めを1ミリ秒も逃さず拾う
                        self.echo_guard_until = 0.0
                        self.ai_playback_until = 0.0
                        logger.debug("Received ai_speech_ended: echo guard released immediately.")

                    elif msg_type == "collector_sync":
                        # フロントエンドの6ステップ聞き取り状態・進捗をリアルタイム同期
                        new_status = data.get("status", self.collector_status)
                        # すでに描画完了（drawn）または描画中（drawing）の時に、古い confirming 状態への巻き戻りを防ぐ
                        if self.collector_status == "drawn" and new_status == "confirming":
                            pass
                        elif self.is_generating_media and new_status in ("collecting", "confirming", "ready"):
                            pass
                        else:
                            self.collector_status = new_status
                        self.collector_active_step = data.get("active_step", self.collector_active_step)
                        self.collector_completed_count = int(data.get("completed_count", self.collector_completed_count))
                        self.collector_summary = (data.get("summary") or "").strip()
                        if data.get("draw_confirmed") is True:
                            self.user_confirmed_drawing = True
                            self.ai_asked_confirmation = True
                        elif new_status in ("idle", "collecting"):
                            self.user_confirmed_drawing = False
                            self.ai_asked_confirmation = False

                    elif msg_type == "eos":
                        # 文字起こし完了に基づく発話区切り通知
                        if self.current_user_turn_text.strip():
                            full_user_utt = re.sub(r'(?<=[\u3040-\u30ff\u4e00-\u9faf])\s+(?=[\u3040-\u30ff\u4e00-\u9faf])', '', self.current_user_turn_text.strip())
                            self._check_user_utterance_for_draw_approval(full_user_utt)
                            noise_words = [
                                "聞こえてますか", "聞こえますか", "もしもし", "あーあー", "テスト",
                                "こんにちは", "こんばんは", "おはよう", "元気でした", "元気です",
                                "さくらさんは", "お天気は", "いい天気", "悪くない", "何もしてない", "ブラブラ",
                                "絵を描いてみたい", "絵を描きたい", "絵を書きたい", "描いてみたい", "聞き取り"
                            ]
                            if not any(w in full_user_utt for w in noise_words) and len(full_user_utt) >= 2:
                                self.discussed_topics.append(full_user_utt)
                            await self.websocket.send_json({
                                "type": "transcript",
                                "role": "user",
                                "text": full_user_utt,
                                "turn_complete": True
                            })
                            self.current_user_turn_text = ""
                        try:
                            await session.send_realtime_input(audio_stream_end=True)
                        except Exception as eos_err:
                            logger.debug(f"audio_stream_end notice: {eos_err}")

                    elif msg_type == "start_listening":
                        # 画面上で「🎙️ 聞き取り開始」が押された時、さくらさんに6ステップ聞き取りの第一声を促す
                        logger.info("User triggered start_listening button.")
                        self.collector_status = "collecting"
                        self.collector_active_step = "topic"
                        self.ai_asked_confirmation = False
                        self.user_confirmed_drawing = False
                        try:
                            await session.send_client_content(
                                turns=[types.Content(role="user", parts=[types.Part.from_text(
                                    text="画面の「🎙️ 聞き取り開始」ボタンが押されました。「それでは絵画のための聞き取りをしますね。まず、どんな思い出の絵を描きましょうか？テーマや話題を教えていただけますか？」と優しく声に出して尋ね、ステップ①（話題・テーマ）の聞き取りを開始してください。※この時点では絶対に generate_memory_visual ツールを呼び出さないでください。"
                                )])],
                                turn_complete=True
                            )
                        except Exception as sl_err:
                            logger.warning(f"Failed to send start_listening prompt: {sl_err}")

                    elif msg_type == "re_listen":
                        # 一通りの聞き取り完了後、またはカード選択により再度聞き取り・修正を行う
                        target_step = data.get("target_step", "")
                        summary_str = (data.get("summary") or "").strip()
                        self.collector_status = "collecting"
                        self.ai_asked_confirmation = False
                        self.user_confirmed_drawing = False
                        if target_step:
                            self.collector_active_step = target_step
                        step_prompts = {
                            "topic": "ステップ①【話題・テーマ】について、「どんな思い出のテーマに修正・変更しましょうか？」と優しく声に出して尋ねてください。",
                            "place": "ステップ②【場所・舞台】について、「どんな場所や舞台だったか、もう一度教えていただけますか？」と優しく声に出して尋ねてください。",
                            "weather": "ステップ③【天候・明暗】について、「その時の季節やお天気、時間帯や明るさはどうだったか、教えていただけますか？」と優しく声に出して尋ねてください。",
                            "people": "ステップ④【登場人物】について、「そこにはどなたがいらっしゃったか、教えていただけますか？」と優しく声に出して尋ねてください。",
                            "details": "ステップ⑤【見えたもの・様子】について、「周りに見えたものやその時の様子について、追加や修正があれば教えていただけますか？」と優しく声に出して尋ねてください。",
                            "mood": "ステップ⑥【気分・雰囲気】について、「その時はどんなお気持ちや雰囲気だったか、教えていただけますか？」と優しく声に出して尋ねてください。",
                        }
                        if target_step in step_prompts:
                            rl_prompt = f"ご本人が項目の再聞き取り・修正を希望されました（現在のまとめ：{summary_str or '聞き取り中'}）。{step_prompts[target_step]} ※今はまだ再聞き取り中ですので generate_memory_visual ツールは呼ばないでください。"
                        else:
                            rl_prompt = (
                                f"ご本人が聞き取り内容の修正・再聞き取りを希望されました（現在のまとめ：{summary_str or 'なし'}）。"
                                f"「かしこまりました！もう一度聞き取りを行いますね。話題・場所・お天気・登場人物・見えた様子・雰囲気のうち、どの項目を修正・追加しましょうか？」と優しく声に出して尋ねてください。※今はまだ再聞き取り中ですので generate_memory_visual ツールは呼ばないでください。"
                            )
                        logger.info(f"User triggered re_listen (target_step={target_step})")
                        try:
                            await session.send_client_content(
                                turns=[types.Content(role="user", parts=[types.Part.from_text(text=rl_prompt)])],
                                turn_complete=True
                            )
                        except Exception as rl_err:
                            logger.warning(f"Failed to send re_listen prompt: {rl_err}")

                    elif msg_type == "prompt_followup":
                        # 会話が3秒以上途切れた際、直前の会話から関連する質問をするか、次の思い出聞き取り項目・最終確認の質問を促す
                        active_step = data.get("active_step", "topic")
                        status = data.get("status", "collecting")
                        reason = data.get("reason", "listening_next_step")
                        # 描画中または描画完了後は3秒無音フォローアップで聞き取り確認を繰り返させない！
                        if status in ("drawing", "drawn") or self.collector_status in ("drawing", "drawn") or self.is_generating_media:
                            logger.debug(f"Skipping prompt_followup because status is {status}/{self.collector_status}.")
                            continue

                        self.collector_status = status
                        self.collector_active_step = active_step
                        topic = (data.get("topic") or "").strip()
                        place = (data.get("place") or "").strip()
                        weather = (data.get("weather") or "").strip()
                        people = (data.get("people") or "").strip()
                        details = data.get("details") or []
                        mood = (data.get("mood") or "").strip()
                        summary = (data.get("summary") or "").strip()
                        if summary:
                            self.collector_summary = summary
                        last_user_text = (data.get("last_user_text") or "").strip() or (self.discussed_topics[-1] if self.discussed_topics else "")
                        last_ai_text = (data.get("last_ai_text") or "").strip()
                        raw_name = (self.profile.call_name or "お父さん").strip()
                        nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"

                        # お父さんの発話にまだAIが返答していない場合のみ「直前の発話への共感」を指示し、
                        # すでにAIが一度発話済み（ai_no_question / listening_next_step 等）の場合は過去の挨拶を繰り返させない！
                        if reason == "after_user_speech" and last_user_text:
                            empathy_prefix = f"直前に{nickname}が「{last_user_text}」と話されました。まずその言葉に短く温かく共感して答えた上で、"
                        else:
                            empathy_prefix = (
                                f"（※直前のやり取り「{last_ai_text[-40:] if last_ai_text else ''}」の続きです。"
                                f"すでに挨拶や直前の発話への相槌は済んでいますので、「私も元気です」「元気だったんですね」等の挨拶や過去の相槌は絶対に繰り返さず、そのまま続けて）"
                            )

                        if status == "idle":
                            if reason == "after_user_speech" and last_user_text:
                                followup_prompt = (
                                    f"{empathy_prefix}そのお話に関連する優しい質問を1つだけ声に出して問いかけて会話を続けてください。"
                                    f"※今は日常会話中ですので generate_memory_visual ツールは絶対に呼ばないでください。"
                                )
                            else:
                                followup_prompt = (
                                    f"{empathy_prefix}{nickname}に「ところで、何か懐かしい思い出の絵をキャンバスに描いてみませんか？」または日常の優しい質問を1つだけ声に出して問いかけてください。"
                                    f"※generate_memory_visual ツールは絶対に呼ばないでください。"
                                )
                        elif status in ("confirming", "ready") or active_step == "confirm":
                            self.ai_asked_confirmation = True
                            brief_topic = (topic or place or "思い出").strip()
                            followup_prompt = (
                                f"6ステップの聞き取りが一通り完了しました。"
                                f"【超重要・発話長制限】「①話題…②場所…」と項目番号を一つずつ全部読み上げる長文は絶対に禁止です（音声合成ストリームの上限に達して途中で切れてしまいます）。"
                                f"{empathy_prefix}{nickname}に向かって、「『{brief_topic}』の素敵な思い出ですね！この内容でキャンバスに絵を描いてもよろしいでしょうか？」のように、"
                                f"1〜2文（40文字以内）で短く温かく確認の質問を声に出して問いかけてください。"
                                f"※【厳守】ご本人が「はい・描いて」と返答されるまでは、絶対に generate_memory_visual ツールを呼ばないでください。"
                            )
                        elif active_step == "topic":
                            followup_prompt = (
                                f"現在は絵画のための6ステップ聞き取り・ステップ①【話題・テーマ】の段階です。"
                                f"{empathy_prefix}「それでは絵画のための聞き取りをしますね。まずステップ①として、どんな思い出の絵を描きましょうか？例えば昔の運動会やご旅行、故郷の風景など、テーマや話題を教えていただけますか？」と1つだけ優しく声に出して質問してください。"
                                f"※【厳守】今はステップ①の聞き取り中ですので、前の挨拶に戻ったり generate_memory_visual ツールを呼び出したりしてはいけません。"
                            )
                        elif active_step == "place":
                            followup_prompt = (
                                f"思い出聞き取り中（①話題：「{topic}」）です。"
                                f"{empathy_prefix}現在確認中のステップ②【場所・舞台】として「その{topic or '思い出'}は、どんな場所や舞台でしたか？」と1つだけテンポよく声に出して質問してください。※まだ聞き取り途中ですので挨拶に戻ったり generate_memory_visual ツールを呼んではいけません。"
                            )
                        elif active_step == "weather":
                            followup_prompt = (
                                f"思い出聞き取り中（①話題：「{topic}」、②場所：「{place or 'スキップ'}」）です。"
                                f"{empathy_prefix}現在確認中のステップ③【天候・明暗】として「その時の季節やお天気、時間帯や明るさはどうでしたか？例えば秋晴れの明るいお昼や、夕暮れ時など教えていただけますか？」と1つだけテンポよく声に出して質問してください。※まだ聞き取り途中ですので generate_memory_visual ツールは絶対に呼ばないでください。"
                            )
                        elif active_step == "people":
                            followup_prompt = (
                                f"思い出聞き取り中（①話題：「{topic}」、②場所：「{place or 'スキップ'}」、③天候：「{weather or 'スキップ'}」）です。"
                                f"{empathy_prefix}現在確認中のステップ④【登場人物】として「そこにはどなたがいらっしゃいましたか？お友達やご家族、それとも風景だけでしたか？」と1つだけテンポよく声に出して質問してください。※まだ聞き取り途中ですので generate_memory_visual ツールは絶対に呼ばないでください。"
                            )
                        elif active_step == "details":
                            followup_prompt = (
                                f"思い出聞き取り中（①話題：「{topic}」、②場所：「{place or 'スキップ'}」）です。"
                                f"{empathy_prefix}現在確認中のステップ⑤【見えたもの・様子】として「その時、周りにはどんなものが見えましたか？どんな様子だったか教えていただけますか？」と1つだけテンポよく声に出して質問してください。※まだ聞き取り途中ですので generate_memory_visual ツールは絶対に呼ばないでください。"
                            )
                        else:  # mood
                            followup_prompt = (
                                f"思い出聞き取り中（①話題：「{topic}」、⑤様子：「{'、'.join(details) if details else 'スキップ'}」）です。"
                                f"{empathy_prefix}最後の項目であるステップ⑥【気分・雰囲気】として「その時はどんなお気持ちや雰囲気でしたか？例えば賑やかで楽しかった、穏やかで懐かしかったなど教えていただけますか？」と1つだけテンポよく声に出して質問してください。※まだ聞き取り途中ですので generate_memory_visual ツールは絶対に呼ばないでください。"
                            )

                        logger.info(f"Triggering 3s silence follow-up (reason={reason}, step={active_step}, status={status}, last_user='{last_user_text}')")
                        try:
                            await session.send_client_content(
                                turns=[types.Content(role="user", parts=[types.Part.from_text(text=followup_prompt)])],
                                turn_complete=True
                            )
                        except Exception as fu_err:
                            logger.warning(f"Failed to send prompt_followup: {fu_err}")

                    elif msg_type == "user_transcript":
                        # ブラウザ音声認識（Web Speech API）または文字起こし確定テキスト
                        user_text = data.get("text", "").strip()
                        incoming_status = data.get("collector_status")
                        if incoming_status:
                            if not (self.collector_status == "drawn" and incoming_status == "confirming"):
                                self.collector_status = incoming_status

                        # AI発話中または再生直後のエコーガード期間中に届いたテキストのフィルタリング
                        now_ts = time.time()
                        if now_ts < self.echo_guard_until:
                            # AIが直前に喋ったフレーズ（または挨拶単語）が含まれる短いテキストはエコーと判定して破棄
                            last_ai = self.current_ai_turn_text or ""
                            echo_candidates = ["ありがとうございます", "ありがとう", "こんにちは", "こんばんは", "お元気でしたか", "お父さん", "さくら"]
                            if any(ec in user_text for ec in echo_candidates) or (last_ai and any(w in last_ai for w in user_text.split() if len(w) >= 2)):
                                logger.info(f"[EchoGuard] Dropped echo user_transcript: '{user_text}' during AI speech playback guard.")
                                continue

                        if user_text:
                            logger.info(f"User transcript received: {user_text}")
                            self._check_user_utterance_for_draw_approval(user_text)
                            noise_words = [
                                "聞こえてますか", "聞こえますか", "もしもし", "あーあー", "テスト",
                                "こんにちは", "こんばんは", "おはよう", "元気でした", "元気です",
                                "さくらさんは", "お天気は", "いい天気", "悪くない", "何もしてない", "ブラブラ",
                                "絵を描いてみたい", "絵を描きたい", "絵を書きたい", "描いてみたい", "聞き取り"
                            ]
                            if not any(w in user_text for w in noise_words) and len(user_text) >= 2:
                                self.discussed_topics.append(user_text)

                            self.user_transcript_seq += 1
                            # ※重要: リアルタイム音声ストリーム送信中に勝手に audio_stream_end や client_content を
                            #   送りつけると Gemini Live API が 1011 Internal Error でクラッシュするため送らない！
                            #   Gemini Live の内蔵VADが自然に発話区切りを判定し返答します。
                            #   沈黙時のフォローアップはフロントエンドからの prompt_followup（3秒タイマー）が担当。

                    elif msg_type == "ask_save_confirmation":
                        # 描画完了後にお父さんが「この雰囲気でよい」「これでいいです」と肯定された時、絵を保存するかどうかを確認する
                        raw_name = (self.profile.call_name or "お父さん").strip()
                        nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                        self.collector_status = "drawn"
                        self.user_confirmed_drawing = False
                        self.user_transcript_seq += 1
                        self.last_ai_output_time = time.time()
                        save_prompt = (
                            f"{nickname}が現在の絵について「この雰囲気でよい（これでいいです）」と満足されました！"
                            f"※【絶対厳守】描き直し（refine_memory_visual）や新規描画（generate_memory_visual）は絶対に呼ばないでください。"
                            f"{nickname}に向かって、「気に入っていただけて嬉しいです！この絵を保存しますか？保存する場合は保存してから絵画モードを終了し、また普通のおしゃべりに戻りますね」と優しく声に出して確認してください。"
                        )
                        logger.info("User approved drawn image; prompting save confirmation.")
                        try:
                            await session.send_client_content(
                                turns=[types.Content(role="user", parts=[types.Part.from_text(text=save_prompt)])],
                                turn_complete=True
                            )
                        except Exception as sc_err:
                            logger.warning(f"Failed to send ask_save_confirmation prompt: {sc_err}")

                    elif msg_type == "finish_drawing_mode":
                        # 絵の保存確認が完了（保存して終了、または保存せず終了）し、絵画モードを終了して通常会話（idle）へ移行
                        saved = bool(data.get("saved", True))
                        already_spoken = bool(data.get("already_spoken", False))
                        topic_done = correct_japanese_homophones((data.get("topic") or "").strip() or "思い出の絵")
                        raw_name = (self.profile.call_name or "お父さん").strip()
                        nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                        self.collector_status = "idle"
                        self.collector_active_step = "topic"
                        self.collector_completed_count = 0
                        self.collector_summary = ""
                        self.ai_asked_confirmation = False
                        self.user_confirmed_drawing = False
                        self.user_transcript_seq += 1

                        time_since_last_ai = time.time() - self.last_ai_output_time
                        is_ai_active = self.is_ai_speaking or (time_since_last_ai < 6.0) or already_spoken
                        self.last_ai_output_time = time.time()

                        logger.info(f"Drawing mode finished (saved={saved}, is_ai_active={is_ai_active}, elapsed={time_since_last_ai:.2f}s); returning to normal conversation.")

                        # AIがお父さんの「保存してください」を直接聞いてすでに喋っているか直近で喋り終えている場合は、二重発話を防ぐためプロンプト送信をスキップ
                        if is_ai_active:
                            logger.info("AI is already responding or finished speaking recently; skipping redundant finish_drawing_mode prompt.")
                        else:
                            if saved:
                                finish_prompt = (
                                    f"「{topic_done}」の絵を保存し、絵画モードを終了して通常会話モードに移行しました。"
                                    f"{nickname}に向かって、「絵を保存しましたよ！これで絵画モードを終了して、また普通のおしゃべりに戻りますね。先ほどのお話の続きや、他に楽しまれていたことなど、またゆっくりお話ししましょう！」と温かく伝え、日常の穏やかな質問を1つだけ声に出して問いかけてください。"
                                    f"※これ以降は通常会話モードですので generate_memory_visual や refine_memory_visual は呼ばないでください。"
                                )
                            else:
                                finish_prompt = (
                                    f"絵は保存せずに絵画モードを終了し、通常会話モードに移行しました。"
                                    f"{nickname}に向かって、「かしこまりました！これで絵画モードを終了して、また普通のおしゃべりに戻りますね。{nickname}、次はどんなお話をしましょうか？」と温かく声に出して問いかけてください。"
                                    f"※これ以降は通常会話モードですので generate_memory_visual や refine_memory_visual は呼ばないでください。"
                                )
                            try:
                                await session.send_client_content(
                                    turns=[types.Content(role="user", parts=[types.Part.from_text(text=finish_prompt)])],
                                    turn_complete=True
                                )
                            except Exception as fd_err:
                                logger.warning(f"Failed to send finish_drawing_mode prompt: {fd_err}")

                    elif msg_type == "request_confirmed_draw":
                        # ユーザーが6ステップ最終確認に対して「はい・このまま描いてください」と合意、または「🎨 今の話題を絵にする」を押した時のみ描画を実行
                        draw_topic = correct_japanese_homophones(data.get("topic") or (self.discussed_topics[-1] if self.discussed_topics else "思い出の情景"))
                        summary_arg = correct_japanese_homophones((data.get("summary") or "").strip())
                        art_style_arg = data.get("art_style") or "watercolor"
                        if summary_arg:
                            self.collector_summary = summary_arg
                        self.user_confirmed_drawing = True
                        if self.is_generating_media or self.collector_status == "drawn" or (self.last_draw_time > 0 and (time.time() - self.last_draw_time) < 15.0):
                            logger.info(f"Skipping duplicate request_confirmed_draw for '{draw_topic}' (already generating or just drawn).")
                            continue
                        self.collector_status = "drawing"
                        logger.info(f"User explicitly confirmed drawing for topic: {draw_topic}")
                        await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
                        asyncio.create_task(
                            self._handle_media_generation(session, None, {
                                "scene_type": "past_memory",
                                "japanese_title": draw_topic[:18],
                                "visual_elements": self.collector_summary or f"【ユーザーが語った情景（最優先）】: {draw_topic}",
                                "media_format": "image",
                                "ambient_sound": "autumn_insects",
                                "art_style": art_style_arg
                            })
                        )

                    elif msg_type == "test_generate_visual":
                        await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
                        asyncio.create_task(
                            self._handle_media_generation(session, None, {
                                "scene_type": "past_memory",
                                "japanese_title": "秋の信州松本とりんご畑",
                                "visual_elements": "夕暮れの信州松本のリンゴ畑、赤く実ったリンゴ、北アルプスの山並み",
                                "media_format": "image",
                                "ambient_sound": "autumn_insects"
                            })
                        )

                    elif msg_type == "end_session":
                        logger.info("Received end_session signal from client.")
                        self.is_active = False
                        break

            except Exception as e:
                logger.warning(f"Error in client to Gemini relay: {e}")
                break

    async def _ensure_gemini_replies_to_user_transcript(
        self,
        session,
        user_text: str,
        seq: int,
        transcript_time: float
    ):
        """（廃止: 音声ストリームとの競合・1011エラー防止のためGemini VADに一任）"""
        pass

    async def _ensure_gemini_input_turn_completed(
        self,
        session,
        seq: int,
        input_time: float
    ):
        """
        Gemini側の input_transcription（文字起こし）が0.9秒間更新されなくなったら、
        お父さんの発話完了（無音移行）と判定してフロントエンドへ turn_complete=True を送り、
        Geminiの返答がまだ始まっていなければ audio_stream_end を送って返答を促す。
        """
        try:
            await asyncio.sleep(0.9)
            if not self.is_active or seq != self.input_trans_seq:
                return
            if self.current_user_turn_text.strip():
                full_user_utt = re.sub(r'(?<=[\u3040-\u30ff\u4e00-\u9faf])\s+(?=[\u3040-\u30ff\u4e00-\u9faf])', '', self.current_user_turn_text.strip())
                self._check_user_utterance_for_draw_approval(full_user_utt)
                noise_words = [
                    "聞こえてますか", "聞こえますか", "もしもし", "あーあー", "テスト",
                    "こんにちは", "こんばんは", "おはよう", "元気でした", "元気です",
                    "さくらさんは", "お天気は", "いい天気", "悪くない", "何もしてない", "ブラブラ",
                    "絵を描いてみたい", "絵を描きたい", "絵を書きたい", "描いてみたい", "聞き取り"
                ]
                if not any(w in full_user_utt for w in noise_words) and len(full_user_utt) >= 2:
                    self.discussed_topics.append(full_user_utt)
                await self.websocket.send_json({
                    "type": "transcript",
                    "role": "user",
                    "text": full_user_utt,
                    "turn_complete": True
                })
                self.current_user_turn_text = ""
        except Exception as err:
            logger.debug(f"Input transcription completion check skipped: {err}")

    async def _relay_gemini_to_client(self, session):
        """Gemini Live からの返答音声・ツール呼び出しをハンドリングしてブラウザへ配信"""
        while self.is_active:
            try:
                async for response in session.receive():
                    if not self.is_active:
                        break

                    server_content = response.server_content
                    if server_content is not None:
                        # ユーザーによる発話割り込み（バージイン検知時）
                        if getattr(server_content, "interrupted", False):
                            # AIがまだスピーカーから声を出している最中の場合は、PCスピーカー音のエコー誤検知であるため無視して完走させる！
                            if time.time() < self.echo_guard_until:
                                logger.info("Ignored false-positive interruption during active AI speech output (echo protected).")
                                continue
                            logger.info("Gemini Live response interrupted by actual user speech.")
                            self.current_ai_turn_text = ""
                            await self.websocket.send_json({
                                "type": "interrupted"
                            })
                            continue

                        model_turn = server_content.model_turn
                        if model_turn is not None:
                            for part in model_turn.parts:
                                # 1. 合成音声データ (PCM 24kHz Mono: 1秒あたり48,000バイト)
                                if part.inline_data is not None:
                                    now = time.time()
                                    self.last_ai_output_time = now
                                    chunk_len = len(part.inline_data.data)
                                    chunk_sec = chunk_len / 48000.0
                                    self.ai_playback_until = max(self.ai_playback_until, now) + chunk_sec
                                    # スピーカーからの出音完了直後の余韻ガード（0.6秒）
                                    self.echo_guard_until = self.ai_playback_until + 0.6
                                    await self.websocket.send_bytes(part.inline_data.data)

                                # 文字起こしテキスト (字幕) ※内部思考テキスト（**...）は除外
                                if part.text and not part.text.strip().startswith("**"):
                                    self.last_ai_output_time = time.time()
                                    await self.websocket.send_json({
                                        "type": "transcript",
                                        "role": "model",
                                        "text": part.text
                                    })

                        # Gemini 側での音声入力文字起こし（スマホでWeb Speech APIが使えない場合でも字幕を表示）
                        input_trans = getattr(server_content, "input_transcription", None)
                        if input_trans and getattr(input_trans, "text", None):
                            user_txt = re.sub(r'(?<=[\u3040-\u30ff\u4e00-\u9faf])\s+(?=[\u3040-\u30ff\u4e00-\u9faf])', '', input_trans.text.strip())
                            if user_txt:
                                now_in = time.time()
                                self.last_gemini_input_time = now_in
                                self.current_user_turn_text = re.sub(r'(?<=[\u3040-\u30ff\u4e00-\u9faf])\s+(?=[\u3040-\u30ff\u4e00-\u9faf])', '', self.current_user_turn_text + user_txt)
                                self._check_user_utterance_for_draw_approval(self.current_user_turn_text)
                                logger.info(f"Gemini input_transcription: {user_txt}")
                                await self.websocket.send_json({
                                    "type": "transcript",
                                    "role": "user",
                                    "text": self.current_user_turn_text
                                })
                                self.input_trans_seq += 1
                                cur_in_seq = self.input_trans_seq
                                asyncio.create_task(
                                    self._ensure_gemini_input_turn_completed(session, cur_in_seq, now_in)
                                )

                        # Gemini 側の返答音声文字起こし
                        output_trans = getattr(server_content, "output_transcription", None)
                        if output_trans and getattr(output_trans, "text", None):
                            self.last_ai_output_time = time.time()
                            if self.current_user_turn_text.strip():
                                full_user_utt = re.sub(r'(?<=[\u3040-\u30ff\u4e00-\u9faf])\s+(?=[\u3040-\u30ff\u4e00-\u9faf])', '', self.current_user_turn_text.strip())
                                self._check_user_utterance_for_draw_approval(full_user_utt)
                                noise_words = [
                                    "聞こえてますか", "聞こえますか", "もしもし", "あーあー", "テスト",
                                    "こんにちは", "こんばんは", "おはよう", "元気でした", "元気です",
                                    "さくらさんは", "お天気は", "いい天気", "悪くない", "何もしてない", "ブラブラ"
                                ]
                                if not any(w in full_user_utt for w in noise_words) and len(full_user_utt) >= 2:
                                    self.discussed_topics.append(full_user_utt)
                                await self.websocket.send_json({
                                    "type": "transcript",
                                    "role": "user",
                                    "text": full_user_utt,
                                    "turn_complete": True
                                })
                                self.current_user_turn_text = ""
                                # ※毎ターンの勝手な自動描画は行わない（会話ストリームの継続とクォータを保護）

                            ai_txt = output_trans.text.strip()
                            if ai_txt:
                                self.current_ai_turn_text += ai_txt
                                logger.info(f"Gemini output_transcription: {ai_txt}")
                                await self.websocket.send_json({
                                    "type": "transcript",
                                    "role": "model",
                                    "text": self.current_ai_turn_text,
                                    "turn_complete": False
                                })

                        if getattr(server_content, "turn_complete", False):
                            if self.current_user_turn_text.strip():
                                full_user_utt = re.sub(r'(?<=[\u3040-\u30ff\u4e00-\u9faf])\s+(?=[\u3040-\u30ff\u4e00-\u9faf])', '', self.current_user_turn_text.strip())
                                self._check_user_utterance_for_draw_approval(full_user_utt)
                                noise_words = [
                                    "聞こえてますか", "聞こえますか", "もしもし", "あーあー", "テスト",
                                    "こんにちは", "こんばんは", "おはよう", "元気でした", "元気です",
                                    "さくらさんは", "お天気は", "いい天気", "悪くない", "何もしてない", "ブラブラ"
                                ]
                                if not any(w in full_user_utt for w in noise_words) and len(full_user_utt) >= 2:
                                    self.discussed_topics.append(full_user_utt)
                                await self.websocket.send_json({
                                    "type": "transcript",
                                    "role": "user",
                                    "text": full_user_utt,
                                    "turn_complete": True
                                })
                                self.current_user_turn_text = ""

                            completed_ai_turn = self.current_ai_turn_text.strip()
                            self.current_ai_turn_text = ""
                            # ※重要: Geminiのネットワーク送信完了(turn_complete)時点ではまだブラウザのスピーカーから
                            #   音声が再生中であるため、ここで self.echo_guard_until = 0.0 にしてはいけない！
                            #   （ai_playback_until またはブラウザからの ai_speech_ended で正確に解除される）
                            if completed_ai_turn:
                                if self.collector_status == "idle" and any(
                                    kw in completed_ai_turn for kw in (
                                        "聞き取りをします", "聞き取りをはじめ", "聞き取りを始め",
                                        "思い出の絵をキャンバスに描いてみませんか", "思い出の絵を描いてみませんか",
                                        "思い出の絵を描いてみましょう", "どんな思い出の絵を描", "どんな風景を思い浮かべますか"
                                    )
                                ):
                                    self.collector_status = "collecting"
                                    self.collector_active_step = "topic"
                                    self.ai_asked_confirmation = False
                                    self.user_confirmed_drawing = False
                                elif self.collector_status not in ("drawing", "drawn") and not self.is_generating_media and any(
                                    kw in completed_ai_turn for kw in (
                                        "一通りお話を伺いました", "内容でよろしいでしょうか",
                                        "描いてみましょうか", "描いてもよろしいでしょうか", "このまま絵を描"
                                    )
                                ):
                                    self.ai_asked_confirmation = True
                                    self.collector_status = "confirming"
                                await self.websocket.send_json({
                                    "type": "transcript",
                                    "role": "model",
                                    "text": completed_ai_turn,
                                    "turn_complete": True
                                })
                            await self.websocket.send_json({
                                "type": "avatar_state",
                                "state": "listening"
                            })

                            # 【セーフティネット】6ステップ聞き取り完了後、ご本人が最終確認に対して「はい・描いてください」と承認済み（user_confirmed_drawing==True）で、
                            # AIが明確に「今から描いてみますね」と描画実行を宣言したのに tool_call が行われなかった場合のみ描画を起動！
                            # ※聞き取り確認前（user_confirmed_drawing==False）や描画済み（drawn）には絶対に発火させない！
                            if (
                                not self.tool_called_in_turn
                                and completed_ai_turn
                                and self.user_confirmed_drawing
                                and not self.is_generating_media
                                and self.collector_status in ("confirming", "ready")
                                and len(self.discussed_topics) >= 1
                            ):
                                draw_exec_words = [
                                    "今からキャンバスに描いてみます", "今から描いてみます", "キャンバスに描きますね",
                                    "描いてみますね", "絵にしてみますね", "いま一生懸命描"
                                ]
                                non_draw_questions = [
                                    "描いてみましょうか", "描きましょうか", "描いてもよろしいでしょうか",
                                    "どんな思い出", "どんな絵", "どんな場所", "どんな様子",
                                    "お話を伺います", "聞き取りをします", "聞き取りを始め",
                                    "教えていただけますか", "いかがですか", "よろしいでしょうか"
                                ]
                                if any(w in completed_ai_turn for w in draw_exec_words) and not any(q in completed_ai_turn for q in non_draw_questions):
                                    logger.info(f"AI expressed explicit drawing execution in speech after user confirmation: '{completed_ai_turn}'. Activating fallback media generation.")
                                    topic = self.discussed_topics[-1] if self.discussed_topics else "思い出の風景"
                                    await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
                                    asyncio.create_task(
                                        self._handle_media_generation(session, None, {
                                            "scene_type": "past_memory",
                                            "japanese_title": topic[:18],
                                            "visual_elements": self.collector_summary or f"【AIとご本人が語り合った情景】: {completed_ai_turn}（話題: {topic}）",
                                            "media_format": "image",
                                            "ambient_sound": "autumn_insects"
                                        })
                                    )

                            self.tool_called_in_turn = False

                    # 2. ツール呼び出し（Function Call）
                    tool_call = response.tool_call
                    if tool_call is not None:
                        self.tool_called_in_turn = True
                        for call in tool_call.function_calls:
                            func_name = call.name
                            args = call.args or {}
                            call_id = call.id
                            logger.info(f"Tool call received: {func_name} with args: {args}")

                            if func_name in ("generate_memory_visual", "refine_memory_visual"):
                                raw_name = (self.profile.call_name or "お父さん").strip()
                                nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"

                                raw_title_arg = (args.get("japanese_title") or args.get("title") or "").strip()
                                generic_titles = {
                                    "お父さんの思い出の絵", "お母さんの思い出の絵", "思い出の絵", "思い出の風景",
                                    "懐かしい風景", "懐かしい思い出", "思い出", "風景", "絵"
                                }

                                # 【厳格ガード2（最優先）】描画完了後（drawn）にお父さんが「この雰囲気でよい」「これでいいです」「このままでいいです」と満足・肯定された際に
                                # Geminiが誤って refine_memory_visual や generate_memory_visual を呼んでしまう暴走を100%完全ブロック！
                                user_fb_arg = (args.get("user_feedback") or "").strip()
                                recent_user_utt = (self.discussed_topics[-1] if self.discussed_topics else "").strip()
                                combined_fb = f"{user_fb_arg} {recent_user_utt}"
                                approval_words = (
                                    "このまま", "これでいい", "これで良い", "この雰囲気", "こんな感じ",
                                    "いいです", "良いです", "よいです", "いいよ", "良いよ", "バッチリ",
                                    "大丈夫", "問題ない", "変えなくていい", "修正なし", "直さなくていい",
                                    "気に入", "保存", "終了", "はい", "うん"
                                )
                                explicit_mod_words = (
                                    "直して", "変えて", "変更", "修正", "描き直", "書き直",
                                    "追加", "足して", "入れて", "置いて", "消して", "なくして",
                                    "もっと", "違う", "ちがう"
                                )
                                if (func_name == "refine_memory_visual" or self.collector_status == "drawn") and (
                                    any(aw in combined_fb for aw in approval_words)
                                    and not any(mw in combined_fb for mw in explicit_mod_words)
                                ):
                                    logger.warning(
                                        f"Blocked unwanted {func_name} on user approval ('{user_fb_arg}' / '{recent_user_utt}'). Prompting save confirmation instead."
                                    )
                                    try:
                                        await session.send_tool_response(
                                            function_responses=[
                                                types.FunctionResponse(
                                                    id=call_id,
                                                    name=func_name,
                                                    response={
                                                        "status": "approved_no_redraw_needed",
                                                        "message": (
                                                            f"{nickname}は「現在の絵でよい（満足）」と回答されました。再描画・描き直しは一切不要ですのでキャンセルしました。"
                                                            f"絶対に「今から描きますね」「いま一生懸命描き直していますね」とは言わず、"
                                                            f"「気に入っていただけて嬉しいです！この絵を保存しますか？保存する場合は保存してから絵画モードを終了し、また普通のおしゃべりに戻りますね」と声に出して保存の確認をしてください。"
                                                        )
                                                    }
                                                )
                                            ]
                                        )
                                    except Exception as resp_err:
                                        logger.warning(f"Error sending approval tool rejection response: {resp_err}")
                                    continue

                                # 【厳格ガード1】6ステップの聞き取り完了 ＆ ご本人からの最終確認の承認（user_confirmed_drawing == True）が得られる前の
                                # フライング描画（generate_memory_visual）を100%完全ブロック！
                                if func_name == "generate_memory_visual" and (
                                    not self.user_confirmed_drawing
                                    or self.collector_status in ("idle", "collecting", "drawn")
                                    or len(self.discussed_topics) == 0
                                    or (raw_title_arg in generic_titles and not self.collector_summary)
                                ):
                                    logger.warning(
                                        f"Blocked premature generate_memory_visual call before user confirmation "
                                        f"(collector_status={self.collector_status}, user_confirmed={self.user_confirmed_drawing}, topics={len(self.discussed_topics)}, title='{raw_title_arg}')."
                                    )
                                    if self.collector_status in ("confirming", "ready") or self.ai_asked_confirmation:
                                        reject_msg = (
                                            f"まだ6ステップの聞き取り内容に対する{nickname}からの「はい（この内容で描いてください）」という確認のお返事をいただいていないため、描画はキャンセルされました。"
                                            f"絶対に「今からキャンバスに描いてみますね」「少し待っていてくださいね」等とは言わず、"
                                            f"もし既に「一通りお話を伺いました〜よろしいでしょうか？」と確認を尋ねた直後であれば、何も言わずに静かに{nickname}のお返事を待ってください。"
                                            f"まだ確認を尋ねていなければ、聞き取った内容をまとめて「この内容で絵を描いてもよろしいでしょうか？」とだけ確認してください。"
                                        )
                                    else:
                                        reject_msg = (
                                            f"まだ6ステップ（①話題〜⑥気分・雰囲気）の聞き取りと最終確認が完了していないため、今は絵を描くことはできません（描画はキャンセルされました）。"
                                            f"絶対に「今からキャンバスに描いてみますね」「少し待っていてくださいね」等とは言わず、"
                                            f"もし既に質問を発話済みであればそのまま何も言わずに{nickname}の返答を静かに待ってください。"
                                        )
                                    try:
                                        await session.send_tool_response(
                                            function_responses=[
                                                types.FunctionResponse(
                                                    id=call_id,
                                                    name=func_name,
                                                    response={
                                                        "status": "cancelled_awaiting_confirmation",
                                                        "message": reject_msg
                                                    }
                                                )
                                            ]
                                        )
                                    except Exception as resp_err:
                                        logger.warning(f"Error sending premature tool rejection response: {resp_err}")
                                    continue

                                title = args.get("japanese_title") or args.get("title") or (self.discussed_topics[-1] if self.discussed_topics else "思い出の風景")
                                raw_elements = args.get("visual_elements") or args.get("scene_description") or args.get("description", "")
                                # 【話していない事物の混入防止】フロントエンドで実際に聞き取った6ステップ要約（collector_summary）がある場合は、
                                # AIが勝手に「万国旗が飾られている様子」等を創作した raw_elements ではなく、ご本人が話した collector_summary を最優先する！
                                if func_name == "generate_memory_visual" and self.collector_summary:
                                    elements = self.collector_summary
                                    args["visual_elements"] = elements
                                else:
                                    elements = raw_elements
                                logger.info(f"AI tool call: {func_name} for '{title}' (elements: '{elements}'). Generating visual artifact...")

                                # 連続描画クールダウン中の重複呼び出し、またはすでに生成実行中の場合は「今から描きますね」を二度言わせない
                                if (self.is_generating_media or (self.last_draw_time > 0 and (time.time() - self.last_draw_time) < self.MIN_DRAW_INTERVAL_SEC)) and func_name == "generate_memory_visual":
                                    logger.info(f"Skipping duplicate generate_memory_visual tool response during active generation/cooldown for '{title}'.")
                                    try:
                                        await session.send_tool_response(
                                            function_responses=[
                                                types.FunctionResponse(
                                                    id=call_id,
                                                    name=func_name,
                                                    response={
                                                        "status": "already_drawing",
                                                        "message": "すでに描画処理を実行中です。重複して「今から描いてみますね」と繰り返さず、そのまま静かに完成をお待ちください。"
                                                    }
                                                )
                                            ]
                                        )
                                    except Exception:
                                        pass
                                    continue

                                self.collector_status = "drawing"

                                # 1. Gemini側へ直ちにツール応答を返送（「現在描画進行中」であることを伝え、描き上がる前に「描きました」と嘘をつかせない）
                                if func_name == "refine_memory_visual":
                                    tool_msg = (
                                        f"「{title}」の描き直し（情景修正）をいまキャンバスで開始しました。"
                                        f"現在一生懸命描き直している最中ですので、{nickname}に向かって"
                                        f"「いま一生懸命描き直していますね！少しだけ待っていてくださいね」と優しく伝えてください。"
                                        f"※まだ絵は完成していません。「もう描き直しましたよ」や「どうですか？」と先走って嘘をつくのは厳禁です。"
                                    )
                                else:
                                    tool_msg = (
                                        f"「{title}」の情景の描画をいまキャンバスで開始しました。"
                                        f"現在一生懸命描いている最中ですので、{nickname}に向かって"
                                        f"「今からキャンバスに描いてみますね！少しだけ待っていてくださいね」と優しく伝えてください。"
                                        f"※まだ絵は完成していません。「描きましたよ」や「どうですか？」と先走って嘘をつくのは厳禁です。"
                                    )

                                try:
                                    await session.send_tool_response(
                                        function_responses=[
                                            types.FunctionResponse(
                                                id=call_id,
                                                name=func_name,
                                                response={
                                                    "status": "drawing_in_progress",
                                                    "title": title,
                                                    "message": tool_msg
                                                }
                                            )
                                        ]
                                    )
                                except Exception as resp_err:
                                    logger.warning(f"Error sending tool response to Gemini: {resp_err}")

                                # 2. アバターを描画中状態に変更
                                await self.websocket.send_json({
                                    "type": "avatar_state",
                                    "state": "drawing"
                                })

                                # 3. 完全非同期（asyncio.to_thread）で絵画生成を実行しクライアントへ配信（音声ストリームを1ミリ秒も止めない）
                                if func_name == "refine_memory_visual":
                                    asyncio.create_task(
                                        self._handle_media_refinement(session, call_id, args)
                                    )
                                else:
                                    asyncio.create_task(
                                        self._handle_media_generation(session, call_id, args)
                                    )

                            elif func_name == "trigger_emergency_alert":
                                asyncio.create_task(
                                    self._handle_emergency_alert(session, call_id, args)
                                )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Error in Gemini receive loop: {e}")
                if not self.is_active:
                    break
                await asyncio.sleep(0.2)

    async def _handle_media_generation(self, session, call_id: Optional[str], args: dict):
        """
        裏側での画像生成と結果通知（完全非同期実行）
        ※Gemini Live の音声・字幕ストリームを絶対にブロックしない（asyncio.to_thread使用）
        ※連続描画防止: 前回の描画から2分間（120秒）はスキップしてクォータを保護
        """
        if self.is_generating_media:
            logger.info("Media generation already in progress; skipping duplicate _handle_media_generation call.")
            return
        self.is_generating_media = True
        try:
            scene_type = SceneType(args.get("scene_type", "past_memory"))
            title = args.get("japanese_title") or args.get("title") or (self.discussed_topics[-1] if self.discussed_topics else "思い出の風景")
            elements = self.collector_summary or args.get("visual_elements") or args.get("scene_description") or args.get("description", "")
            media_format = MediaFormat(args.get("media_format", "image"))
            ambient_sound = AmbientSoundType(args.get("ambient_sound", "none"))

            # 連続描画防止チェック（最小描画間隔: 2分 = 120秒）
            now = time.time()
            elapsed = now - self.last_draw_time
            if self.last_draw_time > 0 and elapsed < self.MIN_DRAW_INTERVAL_SEC:
                wait_sec = int(self.MIN_DRAW_INTERVAL_SEC - elapsed)
                logger.info(f"Cooldown active: skipping media generation for '{title}' ({wait_sec}s remaining)")
                reset_time_str = get_pacific_reset_time_jst()
                await self.websocket.send_json({
                    "type": "cooldown_notice",
                    "remaining_seconds": wait_sec,
                    "message": f"前回の描画から2分間はクォータ保護のため待機中です（残り約{wait_sec}秒 / 本日{reset_time_str}リセット）"
                })
                return

            self.last_draw_time = time.time()

            art_style = args.get("art_style", "watercolor")

            # メディア生成実行（最大50秒タイムアウト保証。万が一APIがハングしても必ずフォールバック描画を完了させる）
            try:
                artifact = await asyncio.wait_for(
                    asyncio.to_thread(
                        generate_memory_visual_artifact_sync,
                        user_id=self.profile.user_id,
                        dementia_level=self.profile.dementia_level,
                        scene_type=scene_type,
                        japanese_title=title,
                        visual_elements=elements,
                        media_format=media_format,
                        ambient_sound=ambient_sound,
                        api_key=self.api_key,
                        art_style=art_style
                    ),
                    timeout=50.0
                )
            except asyncio.TimeoutError:
                logger.warning(f"Media generation timed out for '{title}'. Falling back immediately to local watercolor engine.")
                artifact = await asyncio.to_thread(
                    generate_memory_visual_artifact_sync,
                    user_id=self.profile.user_id,
                    dementia_level=self.profile.dementia_level,
                    scene_type=scene_type,
                    japanese_title=title,
                    visual_elements=elements,
                    media_format=media_format,
                    ambient_sound=ambient_sound,
                    api_key="",
                    art_style=art_style
                )
            self.generated_memories.append(artifact)
            self.discussed_topics.append(title)
            self.collector_status = "drawn"
            self.user_confirmed_drawing = False
            self.ai_asked_confirmation = False

            # クライアントへ新メディア表示通知（聞き取った情景ディテールを必ず同梱）
            is_blank = getattr(artifact, "is_fallback", False) and not artifact.media_url
            visual_desc = self.collector_summary or getattr(artifact, "visual_description", elements) or elements
            await self.websocket.send_json({
                "type": "new_media",
                "memory_id": artifact.memory_id,
                "title": artifact.title,
                "visual_elements": visual_desc,
                "media_url": artifact.media_url,
                "media_format": artifact.media_format.value,
                "ambient_sound": artifact.ambient_sound_type.value,
                "is_fallback": getattr(artifact, "is_fallback", False),
                "is_blank": is_blank
            })

            # 絵が画面に出た瞬間にさくらさんに声で知らせる（画面表示のタイミングで初めて声かけ）
            try:
                raw_name = (self.profile.call_name or "お父さん").strip()
                nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                done_notice = (
                    f"【描画完了通知】「{artifact.title}」の絵が完成し、{nickname}の画面に表示されました！"
                    f"{nickname}に向かって、「{nickname}、画面に絵が浮かびましたよ！こんな雰囲気でよろしいでしょうか？」とだけ温かく声をかけてください。"
                    f"※「一通りお話を伺いました」等の聞き取り確認は絶対に繰り返さないでください。また、ご本人が「この雰囲気でよい」「これでいいです」と答えられた場合は、絶対に refine_memory_visual（描き直し）を呼ばず、絵を保存するかどうかを確認してください。"
                )
                # 音声PCMパケットとの内部競合による1011切断を完全に防ぐため、エコーガードをかけてから安全に完了通知を送信
                self.echo_guard_until = time.time() + 4.5
                await asyncio.sleep(0.15)
                logger.info(f"Sending visual completion voice prompt to Gemini Live for '{artifact.title}'...")
                await session.send_client_content(
                    turns=[types.Content(role="user", parts=[types.Part.from_text(text=done_notice)])],
                    turn_complete=True
                )
            except Exception as notice_err:
                logger.warning(f"Done notice error: {notice_err}")

        except Exception as e:
            logger.error(f"Error handling media generation: {e}", exc_info=True)
            await self.websocket.send_json({
                "type": "avatar_state",
                "state": "idle"
            })
        finally:
            self.is_generating_media = False

    async def _handle_media_refinement(self, session, call_id: str, args: dict):
        """共同描画・修正処理"""
        try:
            original_id = args.get("original_memory_id", "")
            feedback = args.get("user_feedback", "")
            elements = args.get("updated_visual_elements", "")

            # 直前のメモリIDがあればそれを優先
            if not original_id and self.generated_memories:
                original_id = self.generated_memories[-1].memory_id

            new_artifact = await refine_memory_visual_artifact(
                original_memory_id=original_id,
                user_feedback=feedback,
                updated_visual_elements=elements,
                dementia_level=self.profile.dementia_level,
                api_key=self.api_key
            )
            if new_artifact:
                self.generated_memories.append(new_artifact)
                self.collector_status = "drawn"
                is_blank = getattr(new_artifact, "is_fallback", False) and not new_artifact.media_url
                visual_desc = self.collector_summary or getattr(new_artifact, "visual_description", elements) or elements
                await self.websocket.send_json({
                    "type": "new_media",
                    "memory_id": new_artifact.memory_id,
                    "title": new_artifact.title,
                    "visual_elements": visual_desc,
                    "media_url": new_artifact.media_url,
                    "media_format": new_artifact.media_format.value,
                    "ambient_sound": new_artifact.ambient_sound_type.value,
                    "is_fallback": getattr(new_artifact, "is_fallback", False),
                    "is_blank": is_blank
                })

                # 絵が画面に出た瞬間にさくらさんに声で知らせる（描き上がったタイミングで初めて声かけ）
                try:
                    raw_name = (self.profile.call_name or "お父さん").strip()
                    nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                    done_notice = (
                        f"【描画完了通知】「{new_artifact.title}」の描き直しが完了し、{nickname}の画面に表示されました！"
                        f"{nickname}に向かって、「{nickname}、描き直した絵が画面に出ましたよ！こんな雰囲気でよろしいでしょうか？」と温かく声をかけてください。"
                        f"※もしご本人が「この雰囲気でよい」「これでいいです」と答えられた場合は、絶対に refine_memory_visual（描き直し）を呼ばず、絵を保存するかどうかを確認してください。"
                    )
                    await session.send_client_content(
                        turns=[types.Content(role="user", parts=[types.Part.from_text(text=done_notice)])],
                        turn_complete=True
                    )
                except Exception as notice_err:
                    logger.debug(f"Done notice error: {notice_err}")
            else:
                # 失敗時も必ず描画オーバーレイを解除
                await self.websocket.send_json({
                    "type": "avatar_state",
                    "state": "listening"
                })
        except Exception as e:
            logger.error(f"Error in media refinement: {e}")
            await self.websocket.send_json({
                "type": "avatar_state",
                "state": "listening"
            })

    async def _handle_emergency_alert(self, session, call_id: str, args: dict):
        """緊急通報処理"""
        try:
            res = await dispatch_emergency_alert(
                urgency_level=args.get("urgency_level", "high_physical_distress"),
                user_utterance=args.get("user_utterance", ""),
                confirmation_obtained=args.get("confirmation_obtained", False),
                contact=self.profile.emergency_contact
            )
            await self.websocket.send_json({
                "type": "emergency_dispatched",
                "result": res
            })
            await session.send_tool_response(
                function_responses=[types.FunctionResponse(
                    id=call_id,
                    name="trigger_emergency_alert",
                    response={"output": res}
                )]
            )
        except Exception as e:
            logger.error(f"Error handling emergency alert: {e}")

    async def _run_simulation_mode(self):
        """APIキー未設定時のためのローカル対話シミュレーション（UI/動作検証用）"""
        await self.websocket.send_json({
            "type": "session_ready",
            "call_name": self.profile.call_name,
            "dementia_level": self.profile.dementia_level.value,
            "simulation": True
        })

        # 擬似挨拶（再開時は前回の話題の続き）
        await asyncio.sleep(0.5)
        raw_name = (self.profile.call_name or "お父さん").strip()
        nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
        topic_for_resume = (self.last_art or self.recent_topic).strip()
        if self.is_resume and topic_for_resume:
            greeting_text = f"{nickname}、先ほどの{topic_for_resume}のお話の続きをしましょうか！"
        else:
            greeting_text = f"こんにちは、{nickname}！今日もいいお天気ですね。昔の懐かしい場所や、お仕事のお話を聞かせてくださいね。"
        await self.websocket.send_json({
            "type": "transcript",
            "role": "model",
            "text": greeting_text
        })
        await self.websocket.send_json({
            "type": "avatar_state",
            "state": "speaking"
        })
        await asyncio.sleep(2.5)
        await self.websocket.send_json({
            "type": "avatar_state",
            "state": "listening"
        })

        while self.is_active:
            try:
                msg = await self.websocket.receive()
                if "text" in msg and msg["text"]:
                    data = json.loads(msg["text"])
                    msg_type = data.get("type")

                    if msg_type == "user_transcript":
                        user_text = data.get("text", "")
                        self.discussed_topics.append(user_text)

                        # ユーザーが同意・描画指示を出したか判定
                        is_draw_confirmed = any(kw in user_text for kw in ["描いて", "お願い", "うん", "はい", "そうして", "絵にして", "キャンバス"])
                        
                        await self.websocket.send_json({"type": "avatar_state", "state": "speaking"})
                        
                        if is_draw_confirmed and len(self.discussed_topics) > 1:
                            # 合意・指示による描画実行
                            target_topic = self.discussed_topics[-2] if len(self.discussed_topics) >= 2 else user_text
                            ai_reply = f"承知いたしました！それでは「{target_topic}」の情景をキャンバスに描いてみますね。"
                            await self.websocket.send_json({
                                "type": "transcript",
                                "role": "model",
                                "text": ai_reply
                            })
                            await asyncio.sleep(1.5)

                            # 絵を描く
                            await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
                            art = await generate_memory_visual_artifact(
                                user_id=self.profile.user_id,
                                dementia_level=self.profile.dementia_level,
                                scene_type=SceneType.PAST_MEMORY,
                                japanese_title=f"{target_topic}の思い出",
                                visual_elements=f"{target_topic}、懐かしい風景、温かい日差し",
                                ambient_sound=AmbientSoundType.AUTUMN_INSECTS
                            )
                            self.generated_memories.append(art)
                            await self.websocket.send_json({
                                "type": "new_media",
                                "memory_id": art.memory_id,
                                "title": art.title,
                                "media_url": art.media_url,
                                "media_format": "image",
                                "ambient_sound": "autumn_insects"
                            })
                            await asyncio.sleep(1.0)
                            await self.websocket.send_json({
                                "type": "transcript",
                                "role": "model",
                                "text": f"{self.profile.call_name}さん、画面に絵が浮かびましたよ。こんな雰囲気でしたか？"
                            })
                            await self.websocket.send_json({"type": "avatar_state", "state": "speaking"})
                            await asyncio.sleep(2.0)
                            await self.websocket.send_json({"type": "avatar_state", "state": "listening"})
                        else:
                            # ディテール収集・確認返答
                            ai_reply = f"{user_text}ですね、とても素敵ですね！その頃の季節やお天気、どんな様子だったかもう少し教えていただけますか？まとまったらキャンバスに描いてみましょうね。"
                            await self.websocket.send_json({
                                "type": "transcript",
                                "role": "model",
                                "text": ai_reply
                            })
                            await asyncio.sleep(2.0)
                            await self.websocket.send_json({"type": "avatar_state", "state": "listening"})

                    elif msg_type == "test_generate_visual":
                        await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
                        art = await generate_memory_visual_artifact(
                            user_id=self.profile.user_id,
                            dementia_level=self.profile.dementia_level,
                            scene_type=SceneType.PAST_MEMORY,
                            japanese_title="秋の松本とりんご畑 (テスト)",
                            visual_elements="夕暮れの信州松本のリンゴ畑、赤く実ったリンゴ、北アルプスの山並み",
                            ambient_sound=AmbientSoundType.AUTUMN_INSECTS
                        )
                        self.generated_memories.append(art)
                        await self.websocket.send_json({
                            "type": "new_media",
                            "memory_id": art.memory_id,
                            "title": art.title,
                            "media_url": art.media_url,
                            "media_format": "image",
                            "ambient_sound": "autumn_insects"
                        })
                        await self.websocket.send_json({"type": "avatar_state", "state": "idle"})

                    elif msg_type == "end_session":
                        break
            except Exception as e:
                logger.error(f"Error in simulation loop: {e}")
                break
