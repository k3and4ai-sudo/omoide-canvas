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
    refine_memory_visual_artifact
)
from backend.emergency_tool import dispatch_emergency_alert

logger = logging.getLogger(__name__)

# Live API 対応モデル（デフォルト: 双方向オーディオ対応ネイティブモデル）
DEFAULT_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-2.5-flash-native-audio-latest")


class LiveSessionManager:
    """
    1クライアントと Gemini Live API 間の双方向リアルタイム接続を統括するマネージャー
    """

    def __init__(self, websocket: WebSocket, profile: UserProfile, api_key: Optional[str] = None):
        self.websocket = websocket
        self.profile = profile
        self.api_key = (api_key or "").strip()
        self.is_active = False
        self.session_task: Optional[asyncio.Task] = None
        self.generated_memories: List[MemoryArtifact] = []
        self.discussed_topics: List[str] = []
        self.start_time: Optional[float] = None
        self.current_ai_turn_text: str = ""
        self.current_user_turn_text: str = ""
        self.last_drawn_topic: str = ""
        self.tool_called_in_turn: bool = False

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
            system_instruction = build_system_instruction(self.profile)

            # Function Calling ツール定義
            def generate_memory_visual(
                scene_type: str,
                japanese_title: str,
                visual_elements: str,
                media_format: str = "image",
                ambient_sound: str = "none"
            ) -> str:
                """対象者が語った思い出や夢の風景を水彩画または動画として描画・画面表示する"""
                # 実体は非同期タスクとしてディスパッチされる
                return "Media generation started in background."

            def refine_memory_visual(
                original_memory_id: str,
                user_feedback: str,
                updated_visual_elements: str
            ) -> str:
                """対象者からの修正希望（描き直しフィードバック）を反映して絵を再描画する"""
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

            # テレビ・周囲音カットはフロントエンドの近接ノイズゲート＋プリバッファで精密遮断するため、
            # Gemini側のVADは常に最高感度（HIGH）＆ 無音判定 300ms に設定して返答レスポンスを最速化する
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
                # 音声区間検出（VAD）：文の途中の息継ぎで切れないよう800msの余裕を持たせる
                realtime_input_config=types.RealtimeInputConfig(
                    automatic_activity_detection=types.AutomaticActivityDetection(
                        disabled=False,
                        start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
                        end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW,
                        prefix_padding_ms=200,
                        silence_duration_ms=800
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

                # セッション開始直後にAIパートナーから温かい第一声（挨拶）を発話させる
                raw_name = (self.profile.call_name or "お父さん").strip()
                nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                p_name = partner.name if (partner and partner.name) else "さくら"
                initial_greeting_prompt = (
                    f"対話セッションが開始されました。あなたの名前は「{p_name}」です。"
                    f"{nickname}に向かって、「こんにちは、{nickname}！{p_name}です。今日も気持ちのいい日ですね。お元気でしたか？」のように、"
                    f"あなたの性格（{partner.personality if partner else '優しく穏やか'}）らしく、短く温かく最初の挨拶を声に出して話しかけてください。"
                )
                try:
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

                    elif msg_type == "eos":
                        # クライアント側VADが発話終了を検知した瞬間、Geminiへ即座に音声ストリーム区切りを通知して爆速返答させる
                        try:
                            await session.send_realtime_input(audio_stream_end=True)
                        except Exception as eos_err:
                            logger.debug(f"audio_stream_end notice: {eos_err}")

                    elif msg_type == "user_transcript":
                        # ブラウザ音声認識で確定した字幕テキストをGeminiへも補足通知し、聞き間違いを防止
                        user_text = data.get("text", "").strip()
                        if user_text:
                            logger.info(f"User transcript received: {user_text}")
                            self.discussed_topics.append(user_text)
                            try:
                                await session.send(input=f"（ユーザーの発言：「{user_text}」※この発言内容にそのまま直接答えてください）", end_of_turn=True)
                            except Exception as tr_err:
                                logger.debug(f"Transcript forward notice: {tr_err}")

                    elif msg_type == "test_generate_visual":
                        await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
                        asyncio.create_task(
                            self._handle_media_generation(session, "test_call", {
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
                        model_turn = server_content.model_turn
                        if model_turn is not None:
                            for part in model_turn.parts:
                                # 1. 合成音声データ (PCM 24kHz)
                                if part.inline_data is not None:
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
                                self.discussed_topics.append(full_user_utt)
                                self.current_user_turn_text = ""
                                # ユーザーの発話が完了しAIが返答を開始した時点で、会話内容に合わせてキャンバスを更新
                                if len(full_user_utt) >= 3 and full_user_utt != self.last_drawn_topic and not self.tool_called_in_turn:
                                    self.last_drawn_topic = full_user_utt
                                    recent_ctx = "、".join(self.discussed_topics[-3:])
                                    await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
                                    asyncio.create_task(
                                        self._handle_media_generation(session, "auto_call", {
                                            "scene_type": "past_memory",
                                            "japanese_title": full_user_utt[:18],
                                            "visual_elements": f"【最新の描きたい情景（最優先）】: {full_user_utt} / 【会話の文脈】: {recent_ctx}",
                                            "media_format": "image",
                                            "ambient_sound": "autumn_insects"
                                        })
                                    )

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
                            turn_txt = self.current_ai_turn_text
                            self.current_ai_turn_text = ""
                            if not self.tool_called_in_turn and any(kw in turn_txt for kw in ["描いてみます", "描きますね", "キャンバスに", "絵にしてみます"]):
                                last_topic = self.discussed_topics[-1] if self.discussed_topics else "思い出の風景"
                                logger.info(f"Auto-triggering visual generation from AI speech for topic: {last_topic}")
                                await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
                                asyncio.create_task(
                                    self._handle_media_generation(session, "auto_call", {
                                        "scene_type": "past_memory",
                                        "japanese_title": f"{last_topic[:16]}の風景",
                                        "visual_elements": f"{last_topic}、温かい水彩画の風景",
                                        "media_format": "image",
                                        "ambient_sound": "autumn_insects"
                                    })
                                )
                            else:
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

                            if func_name == "generate_memory_visual":
                                # アバターをお絵描き中に変更
                                await self.websocket.send_json({
                                    "type": "avatar_state",
                                    "state": "drawing"
                                })

                                # 会話を止めないようバックグラウンドで画像生成を実行
                                asyncio.create_task(
                                    self._handle_media_generation(session, call_id, args)
                                )

                            elif func_name == "refine_memory_visual":
                                await self.websocket.send_json({
                                    "type": "avatar_state",
                                    "state": "drawing"
                                })
                                asyncio.create_task(
                                    self._handle_media_refinement(session, call_id, args)
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

    async def _handle_media_generation(self, session, call_id: str, args: dict):
        """裏側での画像生成と結果通知"""
        try:
            scene_type = SceneType(args.get("scene_type", "past_memory"))
            title = args.get("japanese_title", "思い出の風景")
            elements = args.get("visual_elements", "")
            media_format = MediaFormat(args.get("media_format", "image"))
            ambient_sound = AmbientSoundType(args.get("ambient_sound", "none"))

            # メディア生成実行（安全ラッパー適用・セッション専用APIキーを使用）
            artifact = await generate_memory_visual_artifact(
                user_id=self.profile.user_id,
                dementia_level=self.profile.dementia_level,
                scene_type=scene_type,
                japanese_title=title,
                visual_elements=elements,
                media_format=media_format,
                ambient_sound=ambient_sound,
                api_key=self.api_key
            )
            self.generated_memories.append(artifact)
            self.discussed_topics.append(title)

            # クライアントへ新メディア表示通知
            await self.websocket.send_json({
                "type": "new_media",
                "memory_id": artifact.memory_id,
                "title": artifact.title,
                "media_url": artifact.media_url,
                "media_format": artifact.media_format.value,
                "ambient_sound": artifact.ambient_sound_type.value
            })

            # Gemini へツール完了を返答し、AIから「絵が浮かびましたよ」と話させる
            if call_id != "auto_call" and call_id != "test_call":
                await session.send(input=types.LiveClientToolResponse(
                    function_responses=[types.FunctionResponse(
                        id=call_id,
                        response={"output": {"status": "displayed_on_canvas", "title": title}}
                    )]
                ))

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

        # 擬似挨拶
        await asyncio.sleep(0.5)
        greeting_text = f"こんにちは、{self.profile.call_name}さん！今日もいいお天気ですね。昔の懐かしい場所や、お仕事のお話を聞かせてくださいね。"
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
                        
                        # AIの共感返答を送信
                        await self.websocket.send_json({"type": "avatar_state", "state": "speaking"})
                        ai_reply = f"{user_text}ですか、とても素敵ですね！その頃の情景をキャンバスに描いてみますね。"
                        await self.websocket.send_json({
                            "type": "transcript",
                            "role": "model",
                            "text": ai_reply
                        })
                        await asyncio.sleep(2.0)

                        # 絵を描く
                        await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
                        art = await generate_memory_visual_artifact(
                            user_id=self.profile.user_id,
                            dementia_level=self.profile.dementia_level,
                            scene_type=SceneType.PAST_MEMORY,
                            japanese_title=f"{user_text}の思い出",
                            visual_elements=f"{user_text}、懐かしい風景、温かい日差し",
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
