"""
Gemini Live API 双方向セッション管理モジュール (backend/live_session.py)
仕様書 FR-03, FR-04, 3.3.3, 4.3 に基づく
・フルデュプレックス双方向音声（PCM 16kHz 入力 / 24kHz 出力）
・1FPS カメラ映像フレームの送信
・Function Calling (generate_memory_visual, refine_memory_visual, trigger_emergency_alert)
・会話を止めない非同期バックグラウンドメディア生成
"""

import os
import time
import json
import base64
import asyncio
import logging
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

# Live API 対応モデル（デフォルト: 双方向オーディオ対応ネイティブモデル）
DEFAULT_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-2.5-flash-native-audio-latest")


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
        self.last_draw_time: float = 0.0                # 連続描画防止・クォータ保護用タイムスタンプ
        self.MIN_DRAW_INTERVAL_SEC: float = 120.0       # 描画間隔の最小時間（2分 = 120秒）

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

            # ノイズ・息遣いによる誤反応を抑止するため、VAD感度はBALANCED、沈黙判定は1200msに設定
            noise_mode = getattr(self.profile, "noise_gate_mode", "tv_cut") or "tv_cut"

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

            logger.info(f"Connecting to Gemini Live API ({DEFAULT_LIVE_MODEL}, voice={selected_voice}, noise_mode={noise_mode})...")
            async with client.aio.live.connect(model=DEFAULT_LIVE_MODEL, config=config) as session:
                logger.info("Connected to Gemini Live API successfully!")
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
                topic_for_resume = (self.last_art or self.recent_topic).strip()

                if self.is_resume and topic_for_resume:
                    initial_greeting_prompt = (
                        f"対話セッションが再開されました。あなたの名前は「{p_name}」です。"
                        f"直前まで{nickname}と「{topic_for_resume}」について楽しくお話ししていました。"
                        f"{nickname}に向かって、「{nickname}、先ほどの{topic_for_resume}のお話の続きをしましょうか！」や"
                        f"「{topic_for_resume}の続きを聞かせてくださいね」のように、"
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
                    await session.send(input=initial_greeting_prompt, end_of_turn=True)
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

                    elif msg_type == "eos":
                        # クライアント側VADが発話終了を検知した瞬間、Geminiへ即座に音声ストリーム区切りを通知して爆速返答させる
                        try:
                            await session.send_realtime_input(audio_stream_end=True)
                        except Exception as eos_err:
                            logger.debug(f"audio_stream_end notice: {eos_err}")

                    elif msg_type == "user_transcript":
                        # ブラウザ音声認識で確定した字幕テキスト（話題記録・情景抽出・音声フォールバック用）
                        user_text = data.get("text", "").strip()
                        if user_text:
                            logger.info(f"User transcript received (for history/scene): {user_text}")
                            # 挨拶やマイク確認以外の実質的な話題のみ履歴に追加
                            noise_words = ["聞こえてますか", "聞こえますか", "もしもし", "あーあー", "テスト", "こんにちは", "こんばんは", "おはよう"]
                            if not any(w in user_text for w in noise_words) and len(user_text) >= 2:
                                self.discussed_topics.append(user_text)

                            # マイクPCMが小さくGemini Liveの音声認識が反応していない場合、
                            # ブラウザ音声認識テキストをGeminiへ送り、さくらさんに確実に返答させる（音声不感帯・沈黙の完全防止）
                            if time.time() >= self.echo_guard_until and not self.current_ai_turn_text:
                                try:
                                    logger.info(f"Relaying browser speech transcript to Gemini to ensure response: {user_text}")
                                    await session.send(input=user_text, end_of_turn=True)
                                except Exception as txt_err:
                                    logger.warning(f"Failed to relay user transcript to Gemini: {txt_err}")

                    elif msg_type == "request_confirmed_draw":
                        # ユーザーが画面上で「🎨 今の話題を絵にする」または「🎨 はい、描いてください」を押した時のみ描画を実行
                        draw_topic = data.get("topic") or (self.discussed_topics[-1] if self.discussed_topics else "思い出の情景")
                        logger.info(f"User explicitly requested drawing for topic: {draw_topic}")
                        await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
                        asyncio.create_task(
                            self._handle_media_generation(session, None, {
                                "scene_type": "past_memory",
                                "japanese_title": draw_topic[:18],
                                "visual_elements": f"【ユーザーが語った情景（最優先）】: {draw_topic}",
                                "media_format": "image",
                                "ambient_sound": "autumn_insects"
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
                                    chunk_len = len(part.inline_data.data)
                                    chunk_sec = chunk_len / 48000.0
                                    self.ai_playback_until = max(self.ai_playback_until, now) + chunk_sec
                                    # スピーカーからの出音完了直後の微小余韻ガード（0.2秒）
                                    self.echo_guard_until = self.ai_playback_until + 0.2
                                    await self.websocket.send_bytes(part.inline_data.data)

                                # 文字起こしテキスト (字幕) ※内部思考テキスト（**...）は除外
                                if part.text and not part.text.strip().startswith("**"):
                                    await self.websocket.send_json({
                                        "type": "transcript",
                                        "role": "model",
                                        "text": part.text
                                    })

                        # Gemini 側での音声入力文字起こし（スマホでWeb Speech APIが使えない場合でも字幕を表示）
                        input_trans = getattr(server_content, "input_transcription", None)
                        if input_trans and getattr(input_trans, "text", None):
                            user_txt = input_trans.text.strip()
                            if user_txt:
                                self.current_user_turn_text += user_txt
                                logger.info(f"Gemini input_transcription: {user_txt}")
                                await self.websocket.send_json({
                                    "type": "transcript",
                                    "role": "user",
                                    "text": self.current_user_turn_text
                                })

                        # Gemini 側の返答音声文字起こし
                        output_trans = getattr(server_content, "output_transcription", None)
                        if output_trans and getattr(output_trans, "text", None):
                            if self.current_user_turn_text.strip():
                                full_user_utt = self.current_user_turn_text.strip()
                                noise_words = ["聞こえてますか", "聞こえますか", "もしもし", "あーあー", "テスト", "こんにちは"]
                                if not any(w in full_user_utt for w in noise_words) and len(full_user_utt) >= 2:
                                    self.discussed_topics.append(full_user_utt)
                                self.current_user_turn_text = ""
                                # ※毎ターンの勝手な自動描画は行わない（会話ストリームの継続とクォータを保護）

                            ai_txt = output_trans.text.strip()
                            if ai_txt:
                                self.current_ai_turn_text += ai_txt
                                logger.info(f"Gemini output_transcription: {ai_txt}")
                                await self.websocket.send_json({
                                    "type": "transcript",
                                    "role": "model",
                                    "text": ai_txt
                                })

                        if getattr(server_content, "turn_complete", False):
                            self.current_ai_turn_text = ""
                            await self.websocket.send_json({
                                "type": "avatar_state",
                                "state": "listening"
                            })
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
                                title = args.get("japanese_title") or args.get("title") or (self.discussed_topics[-1] if self.discussed_topics else "思い出の風景")
                                elements = args.get("visual_elements") or args.get("scene_description") or args.get("description", "")
                                logger.info(f"AI tool call: {func_name} for '{title}' (elements: '{elements}'). Generating visual artifact...")

                                # 1. Gemini側へ直ちにツール完了を返送（会話を継続させ、AIが自然にリアクションできるようにする）
                                try:
                                    await session.send(
                                        input=types.LiveClientToolResponse(
                                            function_responses=[
                                                types.FunctionResponse(
                                                    id=call_id,
                                                    name=func_name,
                                                    response={
                                                        "status": "success",
                                                        "title": title,
                                                        "message": f"「{title}」の情景をキャンバスに描きました。"
                                                    }
                                                )
                                            ]
                                        )
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
        try:
            scene_type = SceneType(args.get("scene_type", "past_memory"))
            title = args.get("japanese_title") or args.get("title") or (self.discussed_topics[-1] if self.discussed_topics else "思い出の風景")
            elements = args.get("visual_elements") or args.get("scene_description") or args.get("description", "")
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
                if call_id and not call_id.startswith(("auto_", "user_", "test_")):
                    try:
                        await session.send(input=types.LiveClientToolResponse(
                            function_responses=[types.FunctionResponse(
                                id=call_id,
                                response={"output": {"status": "cooldown_active", "remaining_seconds": wait_sec}}
                            )]
                        ))
                    except Exception as te:
                        logger.warning(f"Failed to return cooldown tool response: {te}")
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

            # クライアントへ新メディア表示通知（聞き取った情景ディテールを必ず同梱）
            is_blank = getattr(artifact, "is_fallback", False) and not artifact.media_url
            visual_desc = getattr(artifact, "visual_description", elements) or elements
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

            # 正規のGemini Live ツール呼び出しIDの場合のみツールレスポンスを返送
            if call_id and not call_id.startswith(("auto_", "user_", "test_")):
                try:
                    tool_output = {
                        "status": "displayed_on_canvas" if not is_blank else "quota_limited_canvas_blank",
                        "title": title,
                        "visual_elements": visual_desc
                    }
                    if is_blank:
                        tool_output["notice"] = "AIモデルの利用制限のため絵を描くことができず白紙となりました。キャンバスは白紙のままお話を楽しく続ける旨を伝えてください。"

                    await session.send(input=types.LiveClientToolResponse(
                        function_responses=[types.FunctionResponse(
                            id=call_id,
                            response={"output": tool_output}
                        )]
                    ))
                except Exception as t_err:
                    logger.debug(f"Tool response delivery notice: {t_err}")

        except Exception as e:
            logger.error(f"Error handling media generation: {e}", exc_info=True)
            await self.websocket.send_json({
                "type": "avatar_state",
                "state": "idle"
            })

    async def _handle_media_refinement(self, session, call_id: str, args: dict):
        """共同描画・修正処理"""
        try:
            original_id = args.get("original_memory_id", "")
            feedback = args.get("user_feedback", "")
            elements = args.get("updated_visual_elements", "")

            new_artifact = await refine_memory_visual_artifact(
                original_memory_id=original_id,
                user_feedback=feedback,
                updated_visual_elements=elements,
                dementia_level=self.profile.dementia_level,
                api_key=self.api_key
            )
            if new_artifact:
                self.generated_memories.append(new_artifact)
                await self.websocket.send_json({
                    "type": "new_media",
                    "memory_id": new_artifact.memory_id,
                    "title": new_artifact.title,
                    "media_url": new_artifact.media_url,
                    "media_format": new_artifact.media_format.value,
                    "ambient_sound": new_artifact.ambient_sound_type.value
                })

            await session.send(input=types.LiveClientToolResponse(
                function_responses=[types.FunctionResponse(
                    id=call_id,
                    response={"output": {"status": "refined_and_displayed"}}
                )]
            ))
        except Exception as e:
            logger.error(f"Error in media refinement: {e}")

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
            await session.send(input=types.LiveClientToolResponse(
                function_responses=[types.FunctionResponse(
                    id=call_id,
                    response={"output": res}
                )]
            ))
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
