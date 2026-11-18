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
        self.echo_guard_until: float = 0.0               # セッション開始時は0（AI音声受信時に動的設定）
        self.ai_playback_until: float = 0.0              # AI返答音声の推定再生完了時刻
        self.echo_dropped_packets: int = 0               # エコーガードにより遮断したマイクパケット数
        self.last_keepalive_pcm_time: float = 0.0        # エコー遮断中のストリーム維持キープアライブ送信時刻
        self.last_ai_output_time: float = 0.0            # Geminiが最後に返答音声/字幕を出力した時刻
        self.last_gemini_input_time: float = 0.0         # Geminiが最後にinput_transcriptionを出力した時刻
        self.last_user_transcript_time: float = 0.0      # ブラウザ音声認識からuser_transcriptを受信した時刻
        self.user_transcript_seq: int = 0                # user_transcript受信シーケンス番号（無応答時フォールバック用）
        self.input_trans_seq: int = 0                    # Gemini input_transcription シーケンス番号
        self.collector_status: str = "idle"              # フロントエンドの6ステップ収集状態 ('idle'|'collecting'|'confirming'|'ready'|'drawing'|'drawn')
        self.collector_active_step: str = "topic"        # 現在聞き取り中のステップ
        self.collector_completed_count: int = 0          # 6ステップのうち完了（入力済またはスキップ済）した数
        self.collector_summary: str = ""                 # 6ステップの要約文字列
        self.confirmed_summary_text: str = ""           # AIが確認質問時に発話した情景要約テキスト（最優先プロンプト用）
        self.ai_asked_confirmation: bool = False         # AIが「一通りお話を伺いました〜よろしいでしょうか？」と最終確認を尋ねたか
        self.user_confirmed_drawing: bool = False        # 最終確認に対してご本人が「はい・描いてください」と承認したか
        self.is_generating_media: bool = False           # 現在バックエンドで画像生成が進行中か
        self.is_triggering_draw: bool = False            # 描画タスクの起動処理中排他ロック（多重起動防止）
        self.drawing_announced: bool = False             # 描画開始案内（「今から描いてみますね」）を発話済みか
        self.last_ai_utterance: str = ""                 # 直前のAI発話テキスト
        self.last_draw_time: float = 0.0                # 連続描画防止・クォータ保護用タイムスタンプ
        self.last_completion_notice_time: float = 0.0  # 描画完了通知発話の重複防止タイムスタンプ
        self.conversation_history: List[Dict[str, str]] = []  # 直近の会話ターン履歴 [{'role': 'user'|'model', 'text': '...'}]
        self.last_user_utterance: str = ""                    # 直前のユーザー発話（通信切断・再接続時の文脈復元用）
        self.last_ai_prompt_time: float = 0.0                 # 直近の催促プロンプト送信時刻（重複催促・二重発話防止）

    def _add_to_conversation_history(self, role: str, text: str):
        """直近の会話履歴（最大15件）を安全に蓄積し、通信切断時の文脈復元に活用する"""
        clean_text = (text or "").strip()
        if not clean_text:
            return
        # 同一発話の重複追加を防止
        if self.conversation_history and self.conversation_history[-1]["role"] == role and self.conversation_history[-1]["text"] == clean_text:
            return
        self.conversation_history.append({"role": role, "text": clean_text})
        if len(self.conversation_history) > 15:
            self.conversation_history = self.conversation_history[-15:]
        if role == "user":
            self.last_user_utterance = clean_text
        self.last_drawing_finished_time: float = 0.0   # 絵画モード終了時のタイムスタンプ（沈黙タイマー誤爆防止用）
        self.MIN_DRAW_INTERVAL_SEC: float = 30.0        # 描画間隔の最小時間（30秒）
        self.ai_asked_refine: bool = False              # 絵画完了後、AIが修正確認を発言したか
        self.user_agreed_refine: bool = False           # AIの修正確認に対してユーザーが合意したか
        self.recent_ai_utterances: list[str] = []       # 直近のAI発話履歴（エコー遮断判定用）
        self.current_live_session = None                 # 現在接続中の Gemini Live セッション

    def _is_echo_of_ai(self, user_text: str) -> bool:
        """
        マイクから拾われたユーザー発話テキストが、スピーカーから再生されたさくらさんの
        発話の跳ね返り（エコー）であるかを判定する。
        【超重要】
        - AIが音声をスピーカーから出力している最中（is_playing）以外は、
          完全一致（clean_user == clean_ai）を除き、絶対にユーザーの肉声をドロップしてはならない！
        - 「いました」「でした」等の短い共通語句による誤爆ドロップを完全根絶する。
        """
        if not user_text:
            return True
        clean_user = re.sub(r'[\s。、！？・?!\n\r]', '', user_text.strip())
        if len(clean_user) == 0:
            return True

        # ユーザー様からの返答・相槌・情景ワードは絶対にエコー判定しない
        pure_approval_words = ("はい", "うん", "ええ", "そう", "お願い", "お願いします", "いいよ", "いいですよ", "描いて", "書いて", "秋", "春", "夏", "冬")
        if clean_user in pure_approval_words:
            return False

        now = time.time()
        is_playing = (now < getattr(self, "ai_playback_until", 0.0) + 0.4) or (now < getattr(self, "echo_guard_until", 0.0))

        # AIが発話していない（再生中でない）場合、完全一致以外はすべて正当なユーザー発話！
        if not is_playing:
            for ai_raw in getattr(self, "recent_ai_utterances", []):
                clean_ai = re.sub(r'[\s。、！？・?!\n\r]', '', (ai_raw or "").strip())
                if clean_user == clean_ai:
                    logger.info(f"[EchoGuard] Exact match dropped when not playing: '{clean_user}'")
                    return True
            return False

        # --- 以下はAI音声再生中（is_playing == True）の場合のみチェック ---
        candidates = []
        if getattr(self, "current_ai_turn_text", ""):
            candidates.append(self.current_ai_turn_text)
        if getattr(self, "last_ai_utterance", ""):
            candidates.append(self.last_ai_utterance)
        for hist in getattr(self, "recent_ai_utterances", []):
            if hist and hist not in candidates:
                candidates.append(hist)

        for ai_raw in candidates:
            clean_ai = re.sub(r'[\s。、！？・?!\n\r]', '', ai_raw.strip())
            if not clean_ai:
                continue

            # 1. 完全一致（AIが喋った内容と一字一句同じ）
            if clean_user == clean_ai:
                logger.info(f"[EchoGuard] Exact match during playback dropped: '{clean_user}'")
                return True

            # 2. ユーザーテキストがAI発話の大部分（75%以上）を占める長い文字列（AIの声の直接録音）
            if len(clean_user) >= 8 and clean_user in clean_ai:
                logger.info(f"[EchoGuard] Substring of AI dropped during playback: '{clean_user}' in '{clean_ai[:30]}...'")
                return True

            # 3. AIの確認定型句がそのまま丸ごと入ってきた場合（7文字以上）
            for phrase in ("この内容で絵を描いてもよろしいでしょうか", "一通りお話を伺いました", "どんな思い出の絵を描きましょうか"):
                if phrase in clean_user and len(clean_user) <= len(phrase) + 3:
                    logger.info(f"[EchoGuard] Template phrase dropped: '{clean_user}'")
                    return True

        return False

    def _check_user_utterance_for_refine_approval(self, user_text: str) -> bool:
        """
        絵画完了後（drawn）において、さくらさんが「〜のように直しますか？」「描き直してみますか？」等と
        確認を発言した後に、ユーザー様が「はい」「直して」「お願い」「うん」と回答・合意されたかを判定する。
        """
        if not user_text or self.collector_status != "drawn":
            return False
        clean = re.sub(r"\s+", "", user_text.strip())
        if len(clean) < 1:
            return False

        # 修正拒否・現在の絵で満足・保存希望の場合は合意にしない
        reject_words = ("いいえ", "いや", "このままでいい", "このままでよい", "これでいい", "気に入った", "保存", "結構です")
        if any(rw in clean for rw in reject_words):
            return False

        # ユーザー様からの明確な回答・承認（「はい」「直して」「描き直して」「お願いします」「うん」等）
        refine_agree_regex = re.compile(
            r"^(?:はい|うん|ええ|そう|そうして|お願い|お願いします|直して|なおして|描き直して|書き直して|やってみて|いいよ|いいですよ|ぜひ)"
            r"|(?:直して|なおして|描き直して|書き直して|変更して|変えて|修正して)"
        )
        if refine_agree_regex.search(clean):
            self.user_agreed_refine = True
            logger.info(f"User approved refinement: '{clean}'")
            return True
        return False

    def _check_user_utterance_for_draw_approval(self, user_text: str) -> bool:
        """
        6ステップ聞き取り完了後の最終確認（confirming / ready）に対して、
        ご本人が明確に「はい」「その内容でいいです」「描いてください」と承認されたかを判定する。
        """
        if not user_text:
            return False
        clean = re.sub(r"\s+", "", user_text.strip())
        if len(clean) < 1:
            return False
        # 実際に画像生成が実行中（is_generating_media）の場合は新規描画承認にしない
        if self.is_generating_media:
            return False

        modify_or_reject_words = (
            "修正", "直して", "変えて", "変更", "やり直し", "もう一度", "もう一回",
            "聞き取り", "聞いて", "違う", "ちがう", "まだ", "いいえ", "いや", "待って"
        )
        if any(mw in clean for mw in modify_or_reject_words):
            return False

        # 【超厳格ガード1】新規描画の承認は、必ず一通りの聞き取りが終わった確認フェーズ（confirming / ready）においてのみ受け付ける！
        # idle（通常会話）, collecting（聞き取り中）では絶対に新規描画承認にしない！
        if self.collector_status not in ("confirming", "ready"):
            return False

        # 【超厳格ガード2】さくらさんが実際に「一通りお話を伺いました...この内容で絵を描いてもよろしいでしょうか？」と
        # 確認質問を口頭で問いかけた後でなければ、日常会話の相槌（うん、はい）を絶対に絵画承認とみなさない！
        recent_ai = (self.current_ai_turn_text + " " + getattr(self, "last_ai_utterance", "")).strip()
        has_confirm_question_in_ai = any(
            kw in recent_ai for kw in (
                "よろしいですか", "よろしいでしょうか", "描いてよろしい", "描いてもよろしい",
                "描きましょうか", "絵にしてよろしい", "絵を描いてみましょうか"
            )
        )
        if not (self.ai_asked_confirmation or has_confirm_question_in_ai):
            return False

        # 【ユーザー直接指示の承認（確認フェーズ中）】
        # 最終確認フェーズにおいて「絵を描いてください」「描いて」「絵にして」と指示された場合は承認とする
        direct_draw_regex = re.compile(
            r"(?:絵を?[描書]いて(?:ください|ちょうだい|みて)?|絵にして|お絵描きして|[描書]いてください|[描書]いてちょうだい|[描書]いてほしい|[描書]いて)"
        )
        if direct_draw_regex.search(clean):
            self.user_confirmed_drawing = True
            logger.info(f"User explicitly requested drawing with direct command in {self.collector_status}: '{clean}'")
            return True

        # 最終確認フェーズにおける明確な合意言葉（正規表現による網羅的マッチング）
        approval_regex = re.compile(
            r"(?:この内容|その内容|これ|それ|このまま|そのままで?)"
            r".*(?:[描書]いて|いい|良い|よい|お?願い|よろしく|結構|お?k|オーケー|そうして|進めて|やって)"
            r"|(?:お?願い(?:します|いたします)?|いいですよ?|良いですよ?|大丈夫です?|結構です|問題(?:ない|ありません))"
        )
        if approval_regex.search(clean):
            self.user_confirmed_drawing = True
            logger.info(f"User confirmed 6-step summary for drawing with pattern match: '{clean}'")
            return True

        # 単独の返答のみ（前後に会話が続いていない、単独の「はい」「いいですよ」）
        clean_stripped = clean.strip("。、！! ")
        if clean_stripped in ("はい", "いいですよ", "いいよ", "ok", "オッケー", "うん") and len(clean_stripped) <= 5:
            self.user_confirmed_drawing = True
            logger.info(f"User confirmed 6-step summary for drawing with short approval: '{clean}'")
            return True

        return False

    async def _handle_user_utterance_after_drawn(self, session, user_text: str) -> bool:
        """
        絵画完了後（drawn / save_confirming）におけるユーザー発話を解析し、
        保存完了・終了、保存確認への移行、または描き直し指示へのルーティングを確実に処理する。
        （ユーザーが「これでいいです」と満足したのに勝手に絵を再描画してしまう暴走を完全阻止）
        """
        if not user_text or self.collector_status not in ("drawn", "save_confirming"):
            return False
        if not session:
            session = self.current_live_session
        if not session:
            return False

        clean = re.sub(r"\s+", "", user_text.strip())
        if len(clean) < 1:
            return False

        raw_name = (self.profile.call_name or "お父さん").strip()
        nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"

        # 1. 保存する（保存して絵画モード終了・通常会話へ）
        save_affirm_words = (
            "保存して", "保存する", "保存します", "保存お願い", "残して", "アルバムに",
            "取っておいて", "とっておいて"
        )
        is_save_request = any(sw in clean for sw in save_affirm_words)
        # すでに保存確認中（save_confirming）で、ご本人が肯定（はい、うん、お願い等）した場合
        if not is_save_request and self.collector_status == "save_confirming":
            short_yes = clean.strip("。、！! ")
            if short_yes in ("はい", "うん", "ええ", "お願い", "お願いします", "そうして", "いいよ", "いいですよ", "ぜひ", "ok", "オッケー"):
                is_save_request = True

        if is_save_request:
            logger.info(f"💾 User requested/confirmed saving drawn image ('{clean}'). Finishing drawing mode.")
            self.collector_status = "idle"
            self.user_confirmed_drawing = False
            self.ai_asked_confirmation = False
            self.ai_asked_refine = False
            self.user_agreed_refine = False
            self.confirmed_summary_text = ""
            self.collector_summary = ""
            self.last_drawing_finished_time = time.time()

            # フロントエンドへ保存完了・通常会話移行を通知
            try:
                await self.websocket.send_json({
                    "type": "collector_sync",
                    "status": "idle",
                    "action": "saved",
                    "is_awaiting_save_confirmation": False
                })
            except Exception as ws_err:
                logger.warning(f"Failed to send saved collector_sync: {ws_err}")

            # ※重要: Geminiはユーザーの「保存します」を聞いてプロンプト指示により自発的に
            # 「絵を大切に保存しましたよ！それでは普通のおしゃべりをしましょうね」と返答するため、
            # ここで send_client_content を送ると同じセリフが2回繰り返される！
            # そのため即時プロンプトは送らず、Geminiの自発的発話をそのまま尊重する。
            return True

        # 2. 保存しない（保存せず絵画モード終了・通常会話へ）
        cancel_save_words = ("保存しない", "保存しなくていい", "保存はいいです", "保存は結構です", "保存は不要", "結構です")
        if any(cw in clean for cw in cancel_save_words):
            logger.info(f"💬 User declined saving image ('{clean}'). Finishing drawing mode without save.")
            self.collector_status = "idle"
            self.user_confirmed_drawing = False
            self.ai_asked_confirmation = False
            self.ai_asked_refine = False
            self.user_agreed_refine = False
            self.confirmed_summary_text = ""
            self.collector_summary = ""
            self.last_drawing_finished_time = time.time()

            try:
                await self.websocket.send_json({
                    "type": "collector_sync",
                    "status": "idle",
                    "action": "finished_without_save",
                    "is_awaiting_save_confirmation": False
                })
            except Exception as ws_err:
                logger.warning(f"Failed to send finished_without_save collector_sync: {ws_err}")

            return True

        # 3. 絵の雰囲気への満足・肯定（「これでいい」「この雰囲気でよい」「いいですね」など）
        # ※修正指示の言葉が含まれていない場合のみ保存確認フェーズへ移行！
        modify_words = (
            "直して", "変えて", "変更", "修正", "描き直", "書き直",
            "追加", "足して", "入れて", "置いて", "消して", "なくして",
            "もっと", "違う", "ちがう", "やり直し", "もう一度"
        )
        has_modify = any(mw in clean for mw in modify_words)
        approval_words = (
            "このまま", "これでいい", "これで良い", "この雰囲気", "こんな感じ",
            "いいです", "良いです", "よいです", "いいよ", "良いよ", "バッチリ", "ばっちり",
            "大丈夫", "問題ない", "変えなくていい", "修正なし", "直さなくていい",
            "気に入", "素敵", "いいですね", "良いですね", "はい", "うん", "ええ",
            "オッケー", "ok", "これでお願い", "これで頼む"
        )
        if not has_modify and any(aw in clean for aw in approval_words):
            if self.collector_status == "drawn":
                logger.info(f"✨ User approved drawn image ('{clean}'). Advancing to save confirmation phase.")
                self.collector_status = "save_confirming"

                # フロントエンドへ保存確認バーの表示を通知
                try:
                    await self.websocket.send_json({
                        "type": "collector_sync",
                        "status": "save_confirming",
                        "is_awaiting_save_confirmation": True
                    })
                except Exception as ws_err:
                    logger.warning(f"Failed to send save_confirming collector_sync: {ws_err}")

                # ※重要: Geminiはユーザーの「これでいいです」を聞いてプロンプト指示により自発的に
                # 「気に入っていただけて嬉しいです！この絵を保存しますか？」と返答するため、
                # ここで send_client_content を送ると同じセリフが2回繰り返される！
                # 状態のみ更新し、Geminiの自然な1回の発話に任せる。
                return True

        return False

    async def _trigger_drawing_if_confirmed(self, session, reason: str = ""):
        """
        ご本人からの最終確認の承認を検知した際、Geminiのツール呼び出し待ちに依存せず、
        即座かつ確実にバックエンド側でメディア生成タスクを起動するセーフティネット。
        """
        if not self.user_confirmed_drawing or self.is_generating_media:
            return
        if not session:
            session = self.current_live_session
        if not session:
            return

        logger.info(f"🚀 Activating guaranteed drawing pipeline triggered by user approval (reason='{reason}').")
        self.collector_status = "drawing"
        self.user_confirmed_drawing = False

        # フロントエンドを描画中状態に遷移
        try:
            await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
        except Exception:
            pass

        # さくらさんに「今からキャンバスに描いてみますね！少し待っていてくださいね」と一言だけ発話させる（多重発話防止: 1回限り）
        # ※直前または現在進行形でAI自身が描画宣言を喋っている場合、または現在AIが発話中の場合は絶対にプロンプトを送らない（二重発話完全防止）
        recent_ai = (self.current_ai_turn_text + " " + getattr(self, "last_ai_utterance", "")).strip()
        draw_words_check = ["今からキャンバスに描", "今から描いてみます", "キャンバスに描きますね", "描いてみますね", "絵にしてみますね", "いま一生懸命描"]
        already_spoken_draw = any(w in recent_ai for w in draw_words_check)
        is_ai_currently_talking = (time.time() < self.ai_playback_until) or (time.time() - self.last_ai_output_time < 1.2) or bool(self.current_ai_turn_text.strip())
        if not self.drawing_announced and not already_spoken_draw and not is_ai_currently_talking:
            self.drawing_announced = True
            try:
                raw_name = (self.profile.call_name or "お父さん").strip()
                nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                draw_notice = (
                    f"{nickname}から「この内容で描いてください」とお返事をいただきました。"
                    f"{nickname}に向かって、「かしこまりました！今からキャンバスに描いてみますね。少しだけ待っていてくださいね」と優しく1文で伝えてください。"
                    f"※まだ絵は完成していません。「描きましたよ」や「どうですか？」と先走って嘘をつくのは厳禁です。"
                    f"※【最重要】この発話の後は、絵が完成するまで絶対に同じ言葉を繰り返さず、静かに待機してください。"
                )
                self.echo_guard_until = time.time() + 4.5
                await session.send_client_content(
                    turns=[types.Content(role="user", parts=[types.Part.from_text(text=draw_notice)])],
                    turn_complete=True
                )
            except Exception as notice_err:
                logger.warning(f"Error sending drawing speech prompt to Gemini: {notice_err}")

        # バックグラウンドで画像生成を実行（_handle_media_generation側で排他制御）
        # 【最重要】さくらさんが確認質問時に要約した情景（self.confirmed_summary_text）または
        # 収集した情景サマリー（self.collector_summary）を100%最優先の情景プロンプトとして採用！
        visual_desc = (self.confirmed_summary_text or self.collector_summary or "").strip()
        topic = "思い出の風景"
        if self.confirmed_summary_text:
            m = re.search(r'([^\s、。]{2,15}(?:の思い出|の情景|の風景|の絵|の様子))', self.confirmed_summary_text)
            if m:
                topic = m.group(1)
            elif self.discussed_topics:
                topic = self.discussed_topics[-1][:18]
        elif self.collector_summary:
            lines = [l.strip(" ・-") for l in self.collector_summary.split("\n") if l.strip(" ・-")]
            for l in lines:
                if any(k in l for k in ("主題", "話題", "テーマ", "情景", "見えた")):
                    parts = l.split("：", 1) if "：" in l else l.split(":", 1)
                    if len(parts) > 1 and len(parts[1].strip()) >= 2:
                        topic = parts[1].strip()
                        break
            if topic == "思い出の風景" and lines:
                topic = lines[0].split("：")[-1].strip()[:18]

        if not visual_desc:
            if topic == "思い出の風景" and self.discussed_topics:
                fillers = ("ですね", "そうですね", "はい", "いいえ", "お願いします", "ありがとう", "うん", "これでいいです")
                for t in reversed(self.discussed_topics):
                    clean_t = t.strip(" 。、！!?")
                    if not any(f == clean_t for f in fillers) and len(clean_t) >= 2:
                        topic = clean_t
                        break
            visual_desc = f"【ユーザーが語った情景（最優先）】: {topic}"

        logger.info(f"🎨 Triggering media generation with visual description: '{visual_desc}' (title: '{topic[:18]}')")
        asyncio.create_task(
            self._handle_media_generation(session, None, {
                "scene_type": "past_memory",
                "japanese_title": topic[:18],
                "visual_elements": visual_desc,
                "media_format": "image",
                "ambient_sound": "autumn_insects"
            })
        )

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
                user_feedback: str,
                updated_visual_elements: str = "",
                original_memory_id: str = ""
            ) -> str:
                """
                対象者からの修正希望（描き直しフィードバック）を反映して絵を再描画するツール。
                
                【最重要警告】相手が「この雰囲気でよい」「これでいい」「このままでいい」「はい」「いいですね」などと満足・肯定された場合は、絶対にこのツールを呼び出してはいけません！
                相手が満足された場合は、絵を保存するかどうかを声で確認してください（ツールは一切呼びません）。
                このツールは「夕焼けにして」「赤い花を追加して」等の具体的な変更要望があり、あなたが「〇〇のように直しましょうか？」と口頭確認して相手が「はい」と合意した場合にのみ呼び出してください。
                
                Args:
                    user_feedback: 相手が言った具体的な修正指示（例: '夕焼け空にして', '窓際に赤いバラを置いて', '大勢の生徒が歩いている様子にして'）
                    updated_visual_elements: 修正指示を反映した新しい全体情景の具体的描写（省略可能）
                    original_memory_id: 直前の絵のID（省略可能）
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

            reconnect_attempts = 0
            max_reconnects = 3
            while self.is_active and reconnect_attempts < max_reconnects:
                try:
                    # 再接続時は最新の is_resume / recent_topic を反映した system_instruction を動的再構築
                    current_topic = (self.last_art or self.recent_topic or (self.discussed_topics[-1] if self.discussed_topics else "")).strip()
                    current_system_instruction = build_system_instruction(
                        self.profile,
                        recent_topic=current_topic,
                        last_art=self.last_art,
                        is_resume=self.is_resume
                    )

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
                        # 音声区間検出（VAD）：話し始めは機敏に検知し、途切れ・言い淀みでも遮らず最後までじっくり聞く（1600ms無音判定）
                        realtime_input_config=types.RealtimeInputConfig(
                            automatic_activity_detection=types.AutomaticActivityDetection(
                                disabled=False,
                                start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
                                end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW,
                                prefix_padding_ms=500,
                                silence_duration_ms=2200
                            )
                        ),
                        system_instruction=current_system_instruction,
                        output_audio_transcription=types.AudioTranscriptionConfig(),
                        input_audio_transcription=types.AudioTranscriptionConfig(),
                        tools=[generate_memory_visual, refine_memory_visual, trigger_emergency_alert]
                    )

                    logger.info(f"Connecting to Gemini Live API ({DEFAULT_LIVE_MODEL}, voice={selected_voice}, noise_mode={noise_mode}, attempt={reconnect_attempts + 1})...")
                    async with client.aio.live.connect(model=DEFAULT_LIVE_MODEL, config=config) as session:
                        self.current_live_session = session
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

                        # セッション開始直後または復旧時にAIパートナーから適切な第一声を発話させる
                        raw_name = (self.profile.call_name or "お父さん").strip()
                        nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                        p_name = partner.name if (partner and partner.name) else "さくら"
                        topic_for_resume = current_topic

                        if self.is_resume:
                            # 【再接続・復旧時：初対面の挨拶は100%厳禁！】
                            ctx_desc = f"「{topic_for_resume}」" if topic_for_resume else "先ほど"
                            if self.is_generating_media or self.collector_status == "drawing":
                                initial_greeting_prompt = (
                                    f"対話セッションが自動復旧しました。あなたの名前は「{p_name}」です。"
                                    f"現在キャンバスに絵を描いている最中ですので、「画面に絵が浮かびましたよ」とは絶対に言わず、"
                                    f"{nickname}に向かって「いま丁寧に描いていますので、もう少々お待ちくださいね」と短く一言だけ伝えてください。"
                                )
                            elif self.collector_status == "drawn" or len(self.generated_memories) > 0:
                                last_art_title = self.generated_memories[-1].title if self.generated_memories else (topic_for_resume or "思い出の絵")
                                if self.last_completion_notice_time > 0:
                                    # すでに完了確認を1回発話済みの場合は、確認の重複発話を防ぐ
                                    initial_greeting_prompt = (
                                        f"対話セッションが自動復旧しました。あなたの名前は「{p_name}」です。"
                                        f"すでに「{last_art_title}」の絵について確認済みですので、「画面に絵が浮かびましたよ」という完了報告は絶対に繰り返さず、"
                                        f"「お待たせいたしました。このまま絵を大切にお話ししましょうか」と自然につなげてください。"
                                    )
                                else:
                                    initial_greeting_prompt = (
                                        f"対話セッションが自動復旧しました。あなたの名前は「{p_name}」です。"
                                        f"直前に「{last_art_title}」の絵が完成し、すでに{nickname}の画面に表示されています！"
                                        f"{nickname}に向かって、「{nickname}、画面に絵が浮かびましたよ！こんな雰囲気でよろしいでしょうか？」と温かく声に出して問いかけてください。"
                                        f"※「どんな思い出がありましたか？」等の過去の聞き取り質問は絶対に繰り返さないでください。"
                                    )
                            elif self.collector_status in ("collecting", "confirming", "ready"):
                                step_label_map = {
                                    "topic": "テーマや話題", "place": "場所や舞台", "weather": "季節やお天気、時間帯",
                                    "people": "登場人物（どなたがいらっしゃったか）", "details": "周りの様子や見えたもの", "mood": "その時のお気持ちや雰囲気"
                                }
                                cur_step_name = step_label_map.get(self.collector_active_step, "思い出の情景")
                                history_context = ""
                                if len(self.conversation_history) > 0:
                                    history_context = "【直前の対話履歴】\n" + "\n".join([f"- {t['role']}: {t['text']}" for t in self.conversation_history[-4:]]) + "\n"
                                
                                if self.last_user_utterance:
                                    initial_greeting_prompt = (
                                        f"対話セッションが自動復旧しました。あなたの名前は「{p_name}」です。\n"
                                        f"{history_context}"
                                        f"直前まで{nickname}と「{ctx_desc}」の絵を描くための聞き取りを行っていました。\n"
                                        f"直前に{nickname}が「{self.last_user_utterance}」とお話しくださいました。\n"
                                        f"最初から聞き直すことは厳禁です！\n"
                                        f"{nickname}のお話に短く優しく共感した上で、次の項目（{cur_step_name}など）について1文で自然に問いかけてください。"
                                    )
                                else:
                                    initial_greeting_prompt = (
                                        f"対話セッションが自動復旧しました。あなたの名前は「{p_name}」です。\n"
                                        f"{history_context}"
                                        f"直前まで{nickname}と「{ctx_desc}」の絵を描くための聞き取りを行っていました。\n"
                                        f"すでに伺った項目を最初から聞き直すことは絶対に厳禁です！\n"
                                        f"{nickname}に向かって、「{nickname}、先ほどの続きですね！{cur_step_name}はどうでしたか？」と、直前の続きを1文で端的に伺ってください。"
                                    )
                            elif self.last_user_utterance:
                                # ユーザーが話した直後に切断・再接続された場合、その発話を拾って返答する
                                history_context = ""
                                if len(self.conversation_history) > 1:
                                    history_context = "【直前の対話履歴】\n" + "\n".join([f"- {t['role']}: {t['text']}" for t in self.conversation_history[-4:]]) + "\n"
                                initial_greeting_prompt = (
                                    f"対話セッションが自動復旧しました。あなたの名前は「{p_name}」です。\n"
                                    f"{history_context}"
                                    f"直前に{nickname}が「{self.last_user_utterance}」とおっしゃいました。\n"
                                    f"初対面の挨拶（こんにちは、今日もお元気でしたか等）は絶対に言わないでください！\n"
                                    f"{nickname}の「{self.last_user_utterance}」という言葉に自然に応答し、温かく会話をそのまま続けてください。"
                                )
                            elif topic_for_resume:
                                initial_greeting_prompt = (
                                    f"対話セッションが再開されました。あなたの名前は「{p_name}」です。"
                                    f"直前まで{nickname}と{ctx_desc}について楽しくお話ししていました。"
                                    f"{nickname}に向かって、「{nickname}、先ほどの{ctx_desc}のお話の続きをしましょうか！」のように、"
                                    f"初対面の挨拶（こんにちは等）は完全に省略して、直前のお話の続きを自然に促す温かい第一声を声に出して話しかけてください。"
                                )
                            else:
                                initial_greeting_prompt = (
                                    f"対話セッションが復旧しました。あなたの名前は「{p_name}」です。"
                                    f"初対面の挨拶（こんにちは、はじめまして等）は言わず、"
                                    f"{nickname}に向かって、「{nickname}、お待たせいたしました！何か気になることはありましたか？」のように温かく短く呼びかけてください。"
                                )
                        else:
                            # 完全な初回接続時のみ初対面挨拶を行う
                            initial_greeting_prompt = (
                                f"対話セッションが開始されました。あなたの名前は「{p_name}」です。"
                                f"{nickname}に向かって、「こんにちは、{nickname}！{p_name}です。今日も気持ちのいい日ですね。お元気でしたか？」のように、"
                                f"あなたの性格（{partner.personality if partner else '優しく穏やか'}）らしく、短く温かく最初の挨拶を声に出して話しかけてください。"
                            )
                        try:
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
                    # クライアントが切断した場合は再接続ループを即座に終了
                    err_str = str(e)
                    if "close message has been sent" in err_str or "ClientDisconnected" in err_str or "WebSocketDisconnect" in err_str or not self.is_active:
                        logger.info("Client websocket is closed. Aborting live session reconnect loop.")
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
                        try:
                            await self.websocket.send_json({"type": "error", "message": f"Gemini接続エラー: {e}"})
                        except Exception:
                            pass
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
                    # AI発話中（スピーカー出音期間）またはメディア描画中（is_generating_media / drawing）は
                    # スピーカー音のエコーによる自己中断を防ぐため無音PCM（ゼロバイト）に置き換えて送信。
                    # ※重要: パケット送信自体をスキップ（continue）するとGemini Live APIが入力ストリーム途絶とみなし
                    #   1011 Deadline expired でクラッシュ・切断するため、無音PCMフレームを継続送信してWebSocket接続を維持する！
                    now_ts = time.time()
                    is_ai_playing = (now_ts < self.ai_playback_until) or (now_ts < self.echo_guard_until)
                    pcm_data = message["bytes"]
                    if is_ai_playing or self.is_generating_media or self.collector_status == "drawing":
                        self.echo_dropped_packets += 1
                        if self.echo_dropped_packets % 50 == 1:
                            logger.info(f"[EchoGuard/DrawingGuard] Shielding mic ({self.echo_dropped_packets} chunks, generating={self.is_generating_media}, status={self.collector_status})")
                        # 毎秒50回の連続ゼロバイト送信による1011 Internal Error衝突を防ぎつつ、
                        # 2秒に1回だけ極小ディザフレーム（10ms）を送り1011 Deadline expiredも防止する
                        if now_ts - self.last_keepalive_pcm_time < 2.0:
                            continue
                        self.last_keepalive_pcm_time = now_ts
                        pcm_data = b'\x01\x00' * 160

                    # Raw PCM 16kHz 音声ストリーム（常に送信を維持してDeadline expiredを完全根絶）
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
                        incoming_step = data.get("active_step", self.collector_active_step)
                        step_order = {"topic": 0, "place": 1, "weather": 2, "people": 3, "details": 4, "mood": 5, "confirm": 6}
                        if new_status == "idle" or self.collector_status != "collecting":
                            self.collector_active_step = incoming_step
                        elif step_order.get(incoming_step, -1) >= step_order.get(self.collector_active_step, -1):
                            self.collector_active_step = incoming_step
                        self.collector_completed_count = int(data.get("completed_count", self.collector_completed_count))
                        self.collector_summary = (data.get("summary") or "").strip()
                        if data.get("draw_confirmed") is True or new_status == "drawing":
                            # 【厳格ガード】さくらさんが聞き取りの確認質問を発話していない段階では、
                            # collector_sync で status=drawing が届いても絶対に描画を開始させない！
                            if self.ai_asked_confirmation and self.collector_status in ("confirming", "ready", "drawing"):
                                self.user_confirmed_drawing = True
                                self.collector_status = "drawing"
                                if not self.is_generating_media:
                                    await self._trigger_drawing_if_confirmed(session, reason="collector_sync_confirmed")
                            else:
                                logger.warning(
                                    f"Ignored collector_sync drawing request before AI confirmation question "
                                    f"(status={self.collector_status}, ai_asked={self.ai_asked_confirmation})"
                                )
                        elif new_status in ("idle", "collecting"):
                            self.user_confirmed_drawing = False
                            self.ai_asked_confirmation = False

                    elif msg_type == "eos":
                        # 文字起こし完了に基づく発話区切り通知
                        if self.current_user_turn_text.strip():
                            full_user_utt = re.sub(r'(?<=[\u3040-\u30ff\u4e00-\u9faf])\s+(?=[\u3040-\u30ff\u4e00-\u9faf])', '', self.current_user_turn_text.strip())
                            is_echo = self._is_echo_of_ai(full_user_utt)
                            if is_echo:
                                logger.info(f"[EchoGuard] Completely dropped echoed utterance in eos: '{full_user_utt}'")
                                self.current_user_turn_text = ""
                            else:
                                is_approved = self._check_user_utterance_for_draw_approval(full_user_utt)
                                noise_words = [
                                    "聞こえてますか", "聞こえますか", "もしもし", "あーあー", "テスト",
                                    "こんにちは", "こんばんは", "おはよう", "元気でした", "元気です",
                                    "さくらさんは", "お天気は", "いい天気", "悪くない", "何もしてない", "ブラブラ",
                                    "絵を描いてみたい", "絵を描きたい", "絵を書きたい", "描いてみたい", "聞き取り"
                                ]
                                if not any(w in full_user_utt for w in noise_words) and len(full_user_utt) >= 2 and self.collector_status == "collecting":
                                    self.discussed_topics.append(full_user_utt)
                                await self.websocket.send_json({
                                    "type": "transcript",
                                    "role": "user",
                                    "text": full_user_utt,
                                    "turn_complete": True
                                })
                                # 情景メモカードへリアルタイム同期（※聞き取り中のみ）
                                if self.collector_status == "collecting":
                                    await self.websocket.send_json({
                                        "type": "scene_memory_update",
                                        "user_speech": full_user_utt
                                    })
                                self.current_user_turn_text = ""
                                self._add_to_conversation_history("user", full_user_utt)
                                self._check_user_utterance_for_refine_approval(full_user_utt)
                                await self._handle_user_utterance_after_drawn(session, full_user_utt)
                                if is_approved:
                                    await self._trigger_drawing_if_confirmed(session, reason=f"eos: {full_user_utt}")
                        # ※重要: リアルタイムマイクPCMストリーミング送信中に audio_stream_end を送ると
                        # Gemini Live API が 1011 Internal Error でクラッシュするため絶対に送信しない。
                        # 自然な発話終了はGemini側のVADが判定し、自動応答します。

                    elif msg_type == "start_listening":
                        # 画面上で「🎙️ 聞き取り開始」が押された時、さくらさんに6ステップ聞き取りの第一声を促す
                        # ※すでに聞き取り中（collecting）の場合はリセット・再送信せず進行を保護
                        if self.collector_status == "collecting":
                            logger.info("Already collecting scene elements; ignored duplicate start_listening.")
                            continue
                        logger.info("User triggered start_listening button.")
                        self.collector_status = "collecting"
                        self.collector_active_step = "topic"
                        self.ai_asked_confirmation = False
                        self.user_confirmed_drawing = False
                        try:
                            await session.send_client_content(
                                turns=[types.Content(role="user", parts=[types.Part.from_text(
                                    text="画面の「🎙️ 聞き取り開始」ボタンが押されました。「それでは絵画のための聞き取りをしますね。①テーマについてお聞きします。どんな思い出の絵を描きましょうか？テーマや話題を教えていただけますか？」と、必ず冒頭に『①テーマについてお聞きします。』と明確に声に出して尋ね、ステップ①の聞き取りを開始してください。※この時点では絶対に generate_memory_visual ツールを呼び出さないでください。"
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
                            "topic": "「①テーマについてお聞きします。どんな思い出のテーマに修正・変更しましょうか？」と必ず冒頭に『①テーマについてお聞きします。』と言って優しく声に出して尋ねてください。",
                            "place": "「②場所についてお聞きします。どんな場所や舞台だったか、もう一度教えていただけますか？」と必ず冒頭に『②場所についてお聞きします。』と言って優しく声に出して尋ねてください。",
                            "weather": "「③天候についてお聞きします。その時の季節やお天気、時間帯や明るさはどうだったか、教えていただけますか？」と必ず冒頭に『③天候についてお聞きします。』と言って優しく声に出して尋ねてください。",
                            "people": "「④登場人物についてお聞きします。そこにはどなたがいらっしゃったか、教えていただけますか？」と必ず冒頭に『④登場人物についてお聞きします。』と言って優しく声に出して尋ねてください。",
                            "details": "「⑤様子についてお聞きします。周りに見えたものやその時の様子について、追加や修正があれば教えていただけますか？」と必ず冒頭に『⑤様子についてお聞きします。』と言って優しく声に出して尋ねてください。",
                            "mood": "「⑥雰囲気についてお聞きします。その時はどんなお気持ちや雰囲気だったか、教えていただけますか？」と必ず冒頭に『⑥雰囲気についてお聞きします。』と言って優しく声に出して尋ねてください。",
                        }
                        if target_step in step_prompts:
                            rl_prompt = f"ご本人が項目の再聞き取り・修正を希望されました（現在のまとめ：{summary_str or '聞き取り中'}）。{step_prompts[target_step]} ※今はまだ再聞き取り中ですので generate_memory_visual ツールは呼ばないでください。"
                        else:
                            rl_prompt = (
                                f"ご本人が聞き取り内容の修正・再聞き取りを希望されました（現在のまとめ：{summary_str or 'なし'}）。"
                                f"「かしこまりました！もう一度聞き取りを行いますね。①テーマ、②場所、③天候、④登場人物、⑤様子、⑥雰囲気のうち、どの項目を修正・追加しましょうか？」と優しく声に出して尋ねてください。※今はまだ再聞き取り中ですので generate_memory_visual ツールは呼ばないでください。"
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
                        # ※【超重要】描画中（drawing）、描画完了後（drawn）は、
                        # 絵画生成中または絵画鑑賞中のため、フォローアップによる割り込みを100%完全遮断する。
                        # ただし、確認フェーズ（confirming/ready）での「20秒返答待ち催促（confirm_prompt_20s）」は許可する！
                        if self.is_generating_media or status in ("drawing", "drawn") or self.collector_status in ("drawing", "drawn"):
                            logger.info(f"Skipping prompt_followup during drawing/drawn phase.")
                            continue
                        if status in ("confirming", "ready") or self.collector_status in ("confirming", "ready"):
                            if reason != "confirm_prompt_20s":
                                logger.info(f"Skipping regular prompt_followup during '{status}/{self.collector_status}' (waiting for 20s prompt).")
                                continue

                        # 【二重発話完全防止】AIが現在発話中、または直前に返答を開始している場合はプロンプトを送らない
                        is_ai_talking = (time.time() < self.ai_playback_until) or (time.time() - self.last_ai_output_time < 2.5) or bool(self.current_ai_turn_text.strip())
                        if is_ai_talking:
                            logger.info(f"Skipping prompt_followup because AI is currently talking/responding (prevent double speech).")
                            continue

                        # バックエンドの監視・自動リカバリーとの二重発火を完全防止
                        if reason not in ("idle_silence", "listening_stall_20s", "confirm_prompt_20s"):
                            if (time.time() - self.last_ai_prompt_time < 10.0) or (time.time() - self.last_gemini_input_time < 5.0):
                                logger.info(f"Skipping prompt_followup (reason={reason}) to prevent double firing with backend.")
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

                        # 絵画モード終了直後（15秒以内）は、AIの終了挨拶や保存確認の余韻期間のため沈黙フォローアップをスキップ
                        if time.time() - self.last_drawing_finished_time < 15.0:
                            logger.info(f"Skipping silence follow-up during post-drawing cooldown period ({time.time() - self.last_drawing_finished_time:.1f}s < 15s).")
                            continue

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
                                    f"{empathy_prefix}そのお話に関連する優しい質問や共感を1つだけ声に出して問いかけて会話を続けてください。"
                                    f"※【絶対厳禁】まだ絵を描いてはいけません！「キャンバスに描いてみますね」「描いてみますね」と口走ることも絶対に禁止です。絵を描くツールも絶対に呼ばないでください。日常の会話の質問だけをしてください。"
                                )
                            else:
                                followup_prompt = (
                                    f"{empathy_prefix}{nickname}に日常の穏やかな質問（季節、最近の出来事、趣味など）や、先ほどのお話に関する感想を1つだけ優しく声に出して問いかけてください。"
                                    f"※【絶対厳禁】まだ絵を描いてはいけません！「キャンバスに描いてみますね」「描いてみますね」と口走ることも絶対に禁止です。絵画への積極的な誘導や generate_memory_visual ツールは絶対に呼ばないでください。"
                                )
                        elif status in ("confirming", "ready") or active_step == "confirm":
                            self.ai_asked_confirmation = True
                            brief_topic = (topic or place or "思い出").strip()
                            if reason == "confirm_prompt_20s":
                                followup_prompt = (
                                    f"聞き取り内容の確認（『{brief_topic}』）を提示してから約20秒間、{nickname}からのご返答をお待ちしています。\n"
                                    f"{nickname}に向かって、「{nickname}、こちらの内容で絵を描き始めてもよろしいでしょうか？もし気になる点があれば、いつでも描き直せますよ」と温かく優しく声に出して問いかけてください。"
                                    f"※ご本人の返答を待たずに勝手に描画ツール（generate_memory_visual）を呼び出すことは絶対に厳禁です。"
                                )
                            else:
                                followup_prompt = (
                                    f"6ステップの聞き取りが一通り完了しました。"
                                    f"【超重要・発話長制限】「①話題…②場所…」と項目番号を一つずつ全部読み上げる長文は絶対に禁止です（音声合成ストリームの上限に達して途中で切れてしまいます）。"
                                    f"{empathy_prefix}{nickname}に向かって、「『{brief_topic}』の素敵な思い出ですね！この内容でキャンバスに絵を描いてもよろしいでしょうか？」のように、"
                                    f"1〜2文（40文字以内）で短く温かく確認の質問を声に出して問いかけてください。"
                                    f"※【厳守】ご本人が「はい・描いて」と返答されるまでは、絶対に generate_memory_visual ツールを呼ばないでください。"
                                )
                        step_label_kanji = {
                            "topic": "①テーマ", "place": "②場所", "weather": "③季節やお天気",
                            "people": "④登場人物", "details": "⑤周りの様子", "mood": "⑥その時のお気持ち"
                        }.get(active_step, "この項目")

                        if reason == "listening_stall_20s":
                            followup_prompt = (
                                f"聞き取り項目（{step_label_kanji}）の質問をしてから約20秒間、{nickname}がお考えになっています。\n"
                                f"{nickname}に向かって、「{nickname}、{step_label_kanji}についてはいかがですか？思い浮かぶことがあればゆっくり教えてくださいね」と優しく温かく声に出して問いかけてください。"
                                f"※決して急かさず、generate_memory_visual ツールも絶対に呼ばないでください。"
                            )
                        elif active_step == "topic":
                            # すでに話題（topic）が収集されている場合は、最初からやり直さず次のステップ②（場所）へ進める！
                            if topic and topic not in ("未特定", "お話を聞いています"):
                                followup_prompt = (
                                    f"思い出聞き取り中（①話題：「{topic}」）です。"
                                    f"{empathy_prefix}「②場所についてお聞きします。その{topic}は、どんな場所や舞台でしたか？」と、必ず冒頭に『②場所についてお聞きします。』と声に出して質問してください。"
                                    f"※前の挨拶に戻ったり、聞き取りを最初からやり直したり、generate_memory_visual ツールを呼んではいけません。"
                                )
                            else:
                                followup_prompt = (
                                    f"絵画のための聞き取り・ステップ①【話題・テーマ】です。"
                                    f"{empathy_prefix}「①テーマについてお聞きします。どんな思い出の絵を描きましょうか？テーマや話題を教えていただけますか？」と、必ず冒頭に『①テーマについてお聞きします。』と声に出して質問してください。"
                                    f"※前の挨拶に戻ったり、generate_memory_visual ツールを呼び出したりしてはいけません。"
                                )
                        elif active_step == "place":
                            followup_prompt = (
                                f"思い出聞き取り中（①話題：「{topic}」）です。"
                                f"{empathy_prefix}「②場所についてお聞きします。その{topic or '思い出'}は、どんな場所や舞台でしたか？」と、必ず冒頭に『②場所についてお聞きします。』と声に出して質問してください。※まだ聞き取り途中ですので挨拶に戻ったり generate_memory_visual ツールを呼んではいけません。"
                            )
                        elif active_step == "weather":
                            followup_prompt = (
                                f"思い出聞き取り中（①話題：「{topic}」、②場所：「{place or 'スキップ'}」）です。"
                                f"{empathy_prefix}「③天候についてお聞きします。その時の季節やお天気、時間帯や明るさはどうでしたか？」と、必ず冒頭に『③天候についてお聞きします。』と声に出して質問してください。※まだ聞き取り途中ですので generate_memory_visual ツールは絶対に呼ばないでください。"
                            )
                        elif active_step == "people":
                            followup_prompt = (
                                f"思い出聞き取り中（①話題：「{topic}」、②場所：「{place or 'スキップ'}」、③天候：「{weather or 'スキップ'}」）です。"
                                f"{empathy_prefix}「④登場人物についてお聞きします。そこにはどなたがいらっしゃいましたか？」と、必ず冒頭に『④登場人物についてお聞きします。』と声に出して質問してください。※まだ聞き取り途中ですので generate_memory_visual ツールは絶対に呼ばないでください。"
                            )
                        elif active_step == "details":
                            followup_prompt = (
                                f"思い出聞き取り中（①話題：「{topic}」、②場所：「{place or 'スキップ'}」）です。"
                                f"{empathy_prefix}「⑤様子についてお聞きします。周りにどんなものが見えましたか？どんな様子でしたか？」と、必ず冒頭に『⑤様子についてお聞きします。』と声に出して質問してください。※まだ聞き取り途中ですので generate_memory_visual ツールは絶対に呼ばないでください。"
                            )
                        else:  # mood
                            followup_prompt = (
                                f"思い出聞き取り中（①話題：「{topic}」、⑤様子：「{'、'.join(details) if details else 'スキップ'}」）です。"
                                f"{empathy_prefix}「⑥雰囲気についてお聞きします。その時はどんなお気持ちや雰囲気でしたか？」と、必ず冒頭に『⑥雰囲気についてお聞きします。』と声に出して質問してください。※まだ聞き取り途中ですので generate_memory_visual ツールは絶対に呼ばないでください。"
                            )

                        logger.info(f"Triggering silence follow-up (reason={reason}, step={active_step}, status={status}, last_user='{last_user_text}')")
                        try:
                            self.last_ai_prompt_time = time.time()
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
                            self.last_user_transcript_time = time.time()
                            logger.info(f"User transcript received: {user_text}")
                            is_echo = self._is_echo_of_ai(user_text)
                            if is_echo:
                                logger.info(f"[EchoGuard] Completely dropped echoed utterance in user_transcript: '{user_text}'")
                            else:
                                is_approved = self._check_user_utterance_for_draw_approval(user_text)
                                self._check_user_utterance_for_refine_approval(user_text)
                                await self._handle_user_utterance_after_drawn(session, user_text)
                                noise_words = [
                                    "聞こえてますか", "聞こえますか", "もしもし", "あーあー", "テスト",
                                    "こんにちは", "こんばんは", "おはよう", "元気でした", "元気です",
                                    "さくらさんは", "お天気は", "いい天気", "悪くない", "何もしてない", "ブラブラ",
                                    "絵を描いてみたい", "絵を描きたい", "絵を書きたい", "描いてみたい", "聞き取り"
                                ]
                                if not any(w in user_text for w in noise_words) and len(user_text) >= 2 and self.collector_status == "collecting":
                                    self.discussed_topics.append(user_text)

                                # 情景メモカードへリアルタイム同期（※聞き取り中のみ）
                                if self.collector_status == "collecting":
                                    await self.websocket.send_json({
                                        "type": "scene_memory_update",
                                        "user_speech": user_text
                                    })

                                self.user_transcript_seq += 1
                                if is_approved:
                                    await self._trigger_drawing_if_confirmed(session, reason=f"user_transcript: {user_text}")
                                elif not self.is_generating_media and self.collector_status != "drawing":
                                    # Geminiがマイク音声を拾えなかった場合の迅速フォールバック（1.8秒後判定）
                                    asyncio.create_task(
                                        self._fallback_if_gemini_missed_audio(
                                            session, user_text, self.user_transcript_seq, time.time()
                                        )
                                    )
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
                        self.drawing_announced = False
                        self.is_triggering_draw = False

                        time_since_last_ai = time.time() - self.last_ai_output_time
                        is_ai_active = (time.time() < self.echo_guard_until) or (time_since_last_ai < 6.0) or already_spoken
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

                    elif msg_type == "request_ask_confirmation":
                        # 6ステップの聞き取りが一通り完了した際、さくらさんから必ず「一通りお話を伺いました...」と声で確認させる
                        # ※【二重発話の完全防止】AI自身がすでに直前の発話で確認を問いかけている場合は絶対にプロンプトを再送しない！
                        recent_ai = (self.current_ai_turn_text + " " + getattr(self, "last_ai_utterance", "")).strip()
                        confirm_words_check = ["一通りお話を伺いました", "一通りお伺いしました", "一通り伺いました", "この内容で絵を描いてもよろしい", "この内容で描いてよろしい", "この内容でよろしい"]
                        already_asked_confirm = any(w in recent_ai for w in confirm_words_check)
                        is_ai_talking = (time.time() < self.ai_playback_until) or (time.time() - self.last_ai_output_time < 1.2) or bool(self.current_ai_turn_text.strip())

                        if self.ai_asked_confirmation or already_asked_confirm:
                            logger.info(f"Skipping duplicate request_ask_confirmation prompt because AI already asked confirmation in speech.")
                            self.collector_status = "confirming"
                            self.ai_asked_confirmation = True
                            continue

                        if is_ai_talking:
                            logger.info(f"Skipping request_ask_confirmation prompt because AI is currently talking (prevent double speech).")
                            self.collector_status = "confirming"
                            self.ai_asked_confirmation = True
                            continue

                        self.collector_status = "confirming"
                        self.ai_asked_confirmation = True
                        summary_text = correct_japanese_homophones((data.get("summary") or self.collector_summary or "思い出のお話").strip())
                        raw_name = (self.profile.call_name or "お父さん").strip()
                        nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                        confirm_prompt = (
                            f"6ステップの聞き取りが一通り完了しました（情景内容: {summary_text}）。"
                            f"{nickname}に向かって、「一通りお話を伺いました。」から始めて、聞き取った各項目（話題、場所、天候、人物、様子、雰囲気）を順に復唱してください。"
                            f"※【重要】各項目ごとに復唱し、1文が30文字を超える場合は30文字以内の複数の短い文に適切に分解して復唱してください。"
                            f"復唱の最後に必ず『この内容で絵を描いてもよろしいでしょうか？』と確認してください。"
                            f"※このターンでは絶対に generate_memory_visual は呼ばず、確認の問いかけのみを行って{nickname}のお返事を静かに待ってください。"
                        )
                        self.echo_guard_until = time.time() + 4.5
                        try:
                            logger.info(f"Sending ask_confirmation voice prompt to Gemini Live for '{summary_text[:30]}'")
                            await session.send_client_content(
                                turns=[types.Content(role="user", parts=[types.Part.from_text(text=confirm_prompt)])],
                                turn_complete=True
                            )
                        except Exception as ce:
                            logger.warning(f"Error sending confirm prompt: {ce}")

                    elif msg_type == "request_confirmed_draw":
                        # ユーザーが6ステップ最終確認に対して「はい・このまま描いてください」と合意、または「🎨 今の話題を絵にする」を押した時のみ描画を実行
                        draw_topic = correct_japanese_homophones(data.get("topic") or (self.discussed_topics[-1] if self.discussed_topics else "思い出の情景"))
                        summary_arg = correct_japanese_homophones((data.get("summary") or "").strip())
                        art_style_arg = data.get("art_style") or "watercolor"
                        if summary_arg:
                            self.collector_summary = summary_arg

                        # 実際にバックグラウンド画像生成タスクが走っている最中（is_generating_media）、または直前15秒以内の再実行のみスキップ
                        if self.is_generating_media or (self.last_draw_time > 0 and (time.time() - self.last_draw_time) < 15.0):
                            logger.info(f"Skipping duplicate request_confirmed_draw for '{draw_topic}' (already generating).")
                            continue

                        self.collector_status = "drawing"
                        self.user_confirmed_drawing = False
                        logger.info(f"User explicitly confirmed drawing for topic: {draw_topic}")
                        await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})

                        # さくらさんに「今からキャンバスに描いてみますね！少し待っていてくださいね」と一言だけ発話させる（多重発話防止: 1回限り）
                        # ※直前または現在進行形でAI自身が描画宣言を喋っている場合は絶対にプロンプトを送らない
                        recent_ai = (self.current_ai_turn_text + " " + getattr(self, "last_ai_utterance", "")).strip()
                        draw_words_check = ["今からキャンバスに描", "今から描いてみます", "キャンバスに描きますね", "描いてみますね", "絵にしてみますね", "いま一生懸命描"]
                        already_spoken_draw = any(w in recent_ai for w in draw_words_check)
                        if not self.drawing_announced and not already_spoken_draw:
                            self.drawing_announced = True
                            try:
                                raw_name = (self.profile.call_name or "お父さん").strip()
                                nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                                draw_notice = (
                                    f"{nickname}から「この内容で描いてください」とお返事をいただきました。"
                                    f"{nickname}に向かって、「かしこまりました！今からキャンバスに描いてみますね。少しだけ待っていてくださいね」と優しく1文で伝えてください。"
                                    f"※まだ絵は完成していません。「描きましたよ」や「どうですか？」と先走って嘘をつくのは厳禁です。"
                                    f"※【最重要】この発話の後は、絵が完成するまで絶対に同じ言葉を繰り返さず、静かに待機してください。"
                                )
                                self.echo_guard_until = time.time() + 4.5
                                await session.send_client_content(
                                    turns=[types.Content(role="user", parts=[types.Part.from_text(text=draw_notice)])],
                                    turn_complete=True
                                )
                            except Exception as notice_err:
                                logger.warning(f"Error sending drawing speech prompt to Gemini: {notice_err}")

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

                    elif msg_type == "request_refine_draw":
                        # ユーザーが画面の「🎨 この指示で描き直す」を押した、または修正発話を検知した時に描き直しを実行
                        feedback_arg = (data.get("feedback") or "修正・描き直し").strip()
                        summary_arg = (data.get("summary") or "").strip()
                        if summary_arg:
                            self.collector_summary = summary_arg

                        if self.is_generating_media:
                            logger.info(f"Skipping duplicate request_refine_draw (already generating).")
                            continue

                        self.collector_status = "drawing"
                        logger.info(f"User requested refine drawing: feedback='{feedback_arg}', summary='{summary_arg}'")
                        await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})

                        # さくらさんに「いま一生懸命描き直していますね！少し待っていてくださいね」と一言発話させる
                        try:
                            raw_name = (self.profile.call_name or "お父さん").strip()
                            nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                            refine_voice_prompt = (
                                f"{nickname}から「{feedback_arg}」という描き直し（修正）のご要望をいただきました。"
                                f"{nickname}に向かって、「かしこまりました！いま一生懸命描き直していますね。少しだけ待っていてくださいね」と優しく1文で伝えてください。"
                                f"※まだ絵は完成していません。「もう描き直しましたよ」や「どうですか？」と先走って嘘をつくのは厳禁です。"
                                f"※【最重要】この発話の後は、絵が完成するまで静かに待機してください。"
                            )
                            self.echo_guard_until = time.time() + 4.5
                            await session.send_client_content(
                                turns=[types.Content(role="user", parts=[types.Part.from_text(text=refine_voice_prompt)])],
                                turn_complete=True
                            )
                        except Exception as r_err:
                            logger.warning(f"Error sending refine voice prompt to Gemini: {r_err}")

                        asyncio.create_task(
                            self._handle_media_refinement(session, None, {
                                "user_feedback": feedback_arg,
                                "updated_visual_elements": self.collector_summary or feedback_arg
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

    async def _fallback_if_gemini_missed_audio(
        self,
        session,
        user_text: str,
        seq: int,
        start_time: float
    ):
        """
        ブラウザ音声認識でユーザー発話が確定したが、Gemini Live API が音声を検知しなかった
        （input_transcription が出力されず、かつ返答音声も出力されていない）場合、
        1.8秒待機後にバックエンドから Gemini へプロンプトを注入して確実に返答させる。
        """
        try:
            await asyncio.sleep(5.5)
            if not self.is_active or seq != self.user_transcript_seq:
                return

            # すでにAIが発話中、または直近3秒以内にAIが喋った場合は不要
            now = time.time()
            if (now < self.echo_guard_until) or (now < self.ai_playback_until) or (now - self.last_ai_output_time < 3.0):
                return

            # ユーザーが直近4.5秒以内にまだブラウザ音声認識で発話継続中であれば待機（長文の途中遮断を防止）
            if now - self.last_user_transcript_time < 4.5:
                return

            # 直近5.5秒の間にGemini側が input_transcription を検知していればGemini自身が返答生成中なので絶対に二重注入しない
            if now - self.last_gemini_input_time < 5.5:
                return

            # 現在AIのターン文字が出力中であれば不要
            if self.current_ai_turn_text.strip():
                return

            # 描画中または保存確認直後は不要
            if self.is_generating_media or self.collector_status in ("drawing", "save_confirming"):
                return

            logger.info(f"🎙️ Gemini missed audio input for user utterance: '{user_text}'. Injecting fallback prompt to trigger AI reply.")

            raw_name = (self.profile.call_name or "お父さん").strip()
            nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"

            if self.collector_status == "collecting":
                step_name_map = {
                    "topic": "①テーマ", "place": "②場所", "weather": "③季節・時間帯",
                    "people": "④人物", "details": "⑤情景・見えたもの", "mood": "⑥想い・雰囲気"
                }
                cur_step = step_name_map.get(self.collector_active_step, "お話の内容")
                fallback_prompt = (
                    f"{nickname}が「{user_text}」とお答えになりました。\n"
                    f"必ず「{cur_step}について復唱します。{user_text}ですね！」と前置きして優しく復唱し、"
                    f"カードへの格納を促した上で、次の質問へ進んでください。"
                )
            elif any(kw in user_text for kw in ("絵を描", "絵を書", "書いてみ", "描いてみ", "聞き取り")):
                self.collector_status = "collecting"
                self.collector_active_step = "topic"
                fallback_prompt = (
                    f"{nickname}が「{user_text}」とお話しになりました。\n"
                    f"「素敵ですね！それでは絵画のための聞き取りをしますね。①テーマについてお聞きします。どんな思い出の絵を描きましょうか？」と、"
                    f"必ず『①テーマについてお聞きします。どんな思い出の絵を描きましょうか？』まで省略せず最後まで声に出して尋ねてください。"
                )
            else:
                fallback_prompt = (
                    f"{nickname}が「{user_text}」とお話しになりました。\n"
                    f"{nickname}のお言葉に温かく短く共感して、自然にお返事をしてください。"
                )

            self.last_ai_prompt_time = time.time()
            await session.send_client_content(
                turns=[types.Content(role="user", parts=[types.Part.from_text(text=fallback_prompt)])],
                turn_complete=True
            )
        except Exception as e:
            logger.warning(f"Fallback prompt on missed audio failed: {e}")

    async def _ensure_gemini_input_turn_completed(
        self,
        session,
        seq: int,
        input_time: float
    ):
        """
        Gemini側の input_transcription（文字起こし）が0.9秒間更新されなくなったら、
        お父さんの発話完了（無音移行）と判定してフロントエンドへ turn_complete=True を送り、
        アバター直下の「聞き取った情景メモ」へ即時同期した上で、
        Geminiへ audio_stream_end を送って直ちに返答を出力させる。
        """
        try:
            await asyncio.sleep(0.9)
            if not self.is_active or seq != self.input_trans_seq:
                return
            if self.current_user_turn_text.strip():
                full_user_utt = re.sub(r'(?<=[\u3040-\u30ff\u4e00-\u9faf])\s+(?=[\u3040-\u30ff\u4e00-\u9faf])', '', self.current_user_turn_text.strip())
                is_echo = self._is_echo_of_ai(full_user_utt)
                if is_echo:
                    logger.info(f"[EchoGuard] Completely dropped echoed utterance from finalize: '{full_user_utt}'")
                    self.current_user_turn_text = ""
                    return

                is_approved = self._check_user_utterance_for_draw_approval(full_user_utt)
                noise_words = [
                    "聞こえてますか", "聞こえますか", "もしもし", "あーあー", "テスト",
                    "こんにちは", "こんばんは", "おはよう", "元気でした", "元気です",
                    "さくらさんは", "お天気は", "いい天気", "悪くない", "何もしてない", "ブラブラ",
                    "絵を描いてみたい", "絵を描きたい", "絵を書きたい", "描いてみたい", "聞き取り",
                    "ですね", "そうですね", "はい", "うん", "お願いします", "いいですよ", "これでいいです"
                ]
                if not any(w in full_user_utt for w in noise_words) and len(full_user_utt) >= 2 and self.collector_status == "collecting":
                    self.discussed_topics.append(full_user_utt)

                # 1. 字幕通知（確定）
                await self.websocket.send_json({
                    "type": "transcript",
                    "role": "user",
                    "text": full_user_utt,
                    "turn_complete": True
                })

                # 2. アバター直下の「📝 聞き取った情景メモ」ボックスへリアルタイム確実反映（※聞き取り中のみ）
                if self.collector_status == "collecting":
                    await self.websocket.send_json({
                        "type": "scene_memory_update",
                        "user_speech": full_user_utt
                    })

                self.current_user_turn_text = ""
                self._add_to_conversation_history("user", full_user_utt)
                await self._handle_user_utterance_after_drawn(session, full_user_utt)

                # 3. 絵画描画合意の場合は描画パイプラインを起動
                if is_approved or self.user_confirmed_drawing:
                    logger.info(f"Triggering confirmed drawing from user input turn completion: '{full_user_utt}'")
                    await self._trigger_drawing_if_confirmed(session, reason=f"input_turn_completed: {full_user_utt}")
                elif not self.is_generating_media and self.collector_status != "drawing":
                    # ※重要: リアルタイムマイクPCMストリーミング送信中に audio_stream_end を送ると
                    #   Gemini Live API が 1011 Internal Error でクラッシュするため送信しない。
                    #   Geminiの内蔵VADが自然に発話区切りを検知し返答します。
                    # 4. 万が一Geminiが沈黙した場合の自動フォローアップ（6.5秒無音監視タスク）
                    asyncio.create_task(
                        self._ensure_ai_response_after_user_speech(session, full_user_utt, time.time(), seq)
                    )
        except Exception as err:
            logger.debug(f"Input transcription completion check skipped: {err}")

    async def _ensure_ai_response_after_user_speech(
        self,
        session,
        user_utt: str,
        utt_time: float,
        seq: int = -1
    ):
        """
        お父さんの発話完了後、Geminiの正常な音声返答生成（通常2〜4秒）を十分に待機し、
        もし6.5秒経過してもAIが完全に沈黙している場合のみ、バックエンド側から応答を促すプロンプトを注入する。
        （※二重発話・同一質問の重複ループを100%完全防止）
        """
        try:
            await asyncio.sleep(6.5)
            if not self.is_active or not session:
                return
            # 発話が継続して新しいシーケンスに進んでいた場合は、後続の監視タスクに委ねる
            if seq != -1 and seq != self.input_trans_seq:
                logger.debug(f"Skipped stale AI silence follow-up (seq={seq} != current={self.input_trans_seq})")
                return
            # 描画中または描画完了後のテキスト確認中は割り込まない
            if self.is_generating_media or self.collector_status in ("drawing", "drawn", "save_confirming"):
                return

            now = time.time()
            # ユーザーが直近5.0秒以内にまだ発話していた場合はGeminiが処理中なので割り込まない
            if (now - self.last_gemini_input_time) < 5.0:
                logger.debug("User spoke recently within 5.0s. Skipping AI silence follow-up.")
                return
            # 直前8秒以内にすでに催促プロンプトを送っていたら重複送信しない
            if (now - self.last_ai_prompt_time) < 8.0:
                logger.info("Skipped duplicate AI silence follow-up (already prompted within 8.0s)")
                return

            # 発話時刻 utt_time 以降にAIがすでに出力を開始・完了している場合は絶対に割り込まない！
            if self.last_ai_output_time >= utt_time:
                logger.debug(f"AI already responded after user utterance (last_output={self.last_ai_output_time:.2f} >= utt={utt_time:.2f}). Skipping fallback.")
                return

            # AIが現在まさに音声を出力中（2.5秒以内に出力があり、またはスピーカー再生中）であれば待機
            is_actively_speaking = (now - self.last_ai_output_time < 2.5) or (now < self.ai_playback_until)
            if is_actively_speaking:
                logger.debug("AI is actively speaking/playing. Skipping fallback prompt.")
                return

            # AI発話テキストが生成中または完結済みかチェック
            ai_text = self.current_ai_turn_text.strip()
            if ai_text:
                # すでに完全な文（「〜ですか？」「〜ですね。」等）を出力中または完了していれば何もしない
                if re.search(r'[？?。！!]$', ai_text) or any(ai_text.endswith(kw) for kw in ("ですか", "でしょうか", "ますか", "ですね", "でした", "か")):
                    return
                logger.warning(f"⚠️ AI speech stalled midway: '{ai_text}'. Prompting Gemini to recover and continue.")

            logger.info(f"AI silence/stall detected (6.5s after user utterance '{user_utt}'). Prompting Gemini to respond immediately.")
            raw_name = (self.profile.call_name or "お父さん").strip()
            nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"

            # 聞き取りモード中のステップに応じた促し（復唱プレフィックス＋次質問プレフィックスの厳格指定）
            if self.collector_status == "collecting":
                step_patterns = {
                    "topic": ("①テーマについて復唱します", "②場所についてお聞きします。そこはどんな場所や舞台でしたか？"),
                    "place": ("②場所について復唱します", "③天候についてお聞きします。その時の季節やお天気、時間帯はどうでしたか？"),
                    "weather": ("③天候について復唱します", "④登場人物についてお聞きします。そこにはどなたがいらっしゃいましたか？"),
                    "people": ("④登場人物について復唱します", "⑤様子についてお聞きします。周りにどんなものが見えましたか？"),
                    "details": ("⑤様子について復唱します", "⑥雰囲気についてお聞きします。その時はどんなお気持ちや雰囲気でしたか？"),
                    "mood": ("⑥雰囲気について復唱します", "一通りお話を伺いました。この内容で絵を描いてもよろしいでしょうか？")
                }
                cur_pattern = step_patterns.get(self.collector_active_step, ("復唱します", "次の質問を"))
                echo_prefix, next_q = cur_pattern
                prefix = f"（直前のやり取り『{ai_text}』の続きです）" if ai_text else ""
                prompt_msg = (
                    f"{prefix}{nickname}から「{user_utt}」とお話しいただきました。\n"
                    f"さくらさん、必ず冒頭に『{echo_prefix}。{user_utt}ですね！』と声に出して復唱した上で、"
                    f"続けて『{next_q}』と優しく声に出して質問してください。"
                )
            else:
                prefix = f"（直前のやり取り『{ai_text}』の続きです）" if ai_text else ""
                prompt_msg = (
                    f"{prefix}{nickname}から「{user_utt}」とお話しいただきました。"
                    f"さくらさん、{nickname}のお話に優しく共感して、親しみやすい日常の返答と質問を1文で声に出してお話ししてください。"
                )

            self.last_ai_prompt_time = time.time()
            self.echo_guard_until = time.time() + 4.5
            await session.send_client_content(
                turns=[types.Content(role="user", parts=[types.Part.from_text(text=prompt_msg)])],
                turn_complete=True
            )
        except Exception as e:
            logger.debug(f"Ensure AI response fallback error: {e}")

    async def _recover_truncated_confirmation(self, session, truncated_text: str):
        """AIが要約の途中で言葉を詰まらせて確認質問まで言えずに沈黙した場合、即座に続きを促してリカバリーする"""
        try:
            await asyncio.sleep(0.6)
            if not self.is_active or not session:
                return
            if self.is_generating_media or self.collector_status in ("drawing", "drawn"):
                return
            raw_name = (self.profile.call_name or "お父さん").strip()
            nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
            logger.info(f"🔄 Executing automatic recovery for truncated AI confirmation: '{truncated_text}'")
            summary_context = self.collector_summary.strip() if self.collector_summary else "、".join(self.discussed_topics[-6:])
            recovery_prompt = (
                f"さくらさん、直前のまとめの復唱が途中で切れてしまいました。\n"
                f"これまで伺った全項目：\n{summary_context}\n\n"
                f"直前の発言「{truncated_text[-45:]}」の続きから、残りの項目（①〜⑥のうちまだ復唱していない項目）をすべて最後まで簡潔に声に出して復唱し、"
                f"そのあとで必ず{nickname}に向かって「この内容で絵を描いてもよろしいでしょうか？」と尋ねてください。"
            )
            self.last_ai_prompt_time = time.time()
            self.echo_guard_until = time.time() + 4.5
            await session.send_client_content(
                turns=[types.Content(role="user", parts=[types.Part.from_text(text=recovery_prompt)])],
                turn_complete=True
            )
        except Exception as e:
            logger.error(f"Error in _recover_truncated_confirmation: {e}")

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
                            # 【二重発話完全遮断ガード】描画中（drawing / is_generating_media）に
                            # ツール完了後などでGeminiが余計に喋り出す音声・字幕はブラウザへ流さず完全遮断！
                            is_drawing_silent_phase = self.is_generating_media or (self.collector_status == "drawing" and self.drawing_announced)

                            for part in model_turn.parts:
                                # 1. 合成音声データ (PCM 24kHz Mono: 1秒あたり48,000バイト)
                                if part.inline_data is not None:
                                    if is_drawing_silent_phase:
                                        # 描画中に追加で喋ろうとする音声を完全にドロップ（二重発話の根本根絶）
                                        continue
                                    now = time.time()
                                    self.last_ai_output_time = now
                                    chunk_len = len(part.inline_data.data)
                                    chunk_sec = chunk_len / 48000.0
                                    self.ai_playback_until = max(self.ai_playback_until, now) + chunk_sec
                                    # スピーカー再生完了＋ブラウザ側のWebAudioバッファ再生遅延（約350ms）を考慮した余韻ガード
                                    self.echo_guard_until = max(self.echo_guard_until, self.ai_playback_until + 0.35)
                                    await self.websocket.send_bytes(part.inline_data.data)

                                # 文字起こしテキスト (字幕) ※内部思考テキスト（**...）は除外
                                if part.text and not part.text.strip().startswith("**"):
                                    if is_drawing_silent_phase:
                                        continue
                                    self.last_ai_output_time = time.time()
                                    await self.websocket.send_json({
                                        "type": "transcript",
                                        "role": "model",
                                        "text": part.text,
                                        "turn_complete": False
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
                                is_echo = self._is_echo_of_ai(full_user_utt)
                                if is_echo:
                                    logger.info(f"[EchoGuard] Completely dropped echoed utterance in output_trans: '{full_user_utt}'")
                                    self.current_user_turn_text = ""
                                else:
                                    is_app = self._check_user_utterance_for_draw_approval(full_user_utt)
                                    noise_words = [
                                        "聞こえてますか", "聞こえますか", "もしもし", "あーあー", "テスト",
                                        "こんにちは", "こんばんは", "おはよう", "元気でした", "元気です",
                                        "さくらさんは", "お天気は", "いい天気", "悪くない", "何もしてない", "ブラブラ"
                                    ]
                                    if not any(w in full_user_utt for w in noise_words) and len(full_user_utt) >= 2 and self.collector_status == "collecting":
                                        self.discussed_topics.append(full_user_utt)
                                    await self.websocket.send_json({
                                        "type": "transcript",
                                        "role": "user",
                                        "text": full_user_utt,
                                        "turn_complete": True
                                    })
                                    # 情景メモカードへリアルタイム同期（※聞き取り中のみ）
                                    if self.collector_status == "collecting":
                                        await self.websocket.send_json({
                                            "type": "scene_memory_update",
                                            "user_speech": full_user_utt
                                        })
                                    self.current_user_turn_text = ""
                                    self._add_to_conversation_history("user", full_user_utt)
                                    await self._handle_user_utterance_after_drawn(session, full_user_utt)
                                    if is_app:
                                        await self._trigger_drawing_if_confirmed(session, reason=f"output_trans_user: {full_user_utt}")
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
                                is_echo = self._is_echo_of_ai(full_user_utt)
                                if is_echo:
                                    logger.info(f"[EchoGuard] Completely dropped echoed utterance in turn_complete: '{full_user_utt}'")
                                    self.current_user_turn_text = ""
                                else:
                                    is_app = self._check_user_utterance_for_draw_approval(full_user_utt)
                                    noise_words = [
                                        "聞こえてますか", "聞こえますか", "もしもし", "あーあー", "テスト",
                                        "こんにちは", "こんばんは", "おはよう", "元気でした", "元気です",
                                        "さくらさんは", "お天気は", "いい天気", "悪くない", "何もしてない", "ブラブラ"
                                    ]
                                    if not any(w in full_user_utt for w in noise_words) and len(full_user_utt) >= 2 and self.collector_status == "collecting":
                                        self.discussed_topics.append(full_user_utt)
                                    await self.websocket.send_json({
                                        "type": "transcript",
                                        "role": "user",
                                        "text": full_user_utt,
                                        "turn_complete": True
                                    })
                                    # 情景メモカードへリアルタイム同期（※聞き取り中のみ）
                                    if self.collector_status == "collecting":
                                        await self.websocket.send_json({
                                            "type": "scene_memory_update",
                                            "user_speech": full_user_utt
                                        })
                                    self.current_user_turn_text = ""
                                    self._add_to_conversation_history("user", full_user_utt)
                                    self._check_user_utterance_for_refine_approval(full_user_utt)
                                    await self._handle_user_utterance_after_drawn(session, full_user_utt)
                                    if is_app:
                                        await self._trigger_drawing_if_confirmed(session, reason=f"output_trans_user: {full_user_utt}")

                            completed_ai_turn = self.current_ai_turn_text.strip()
                            self.current_ai_turn_text = ""
                            if completed_ai_turn:
                                self.last_ai_prompt_time = 0.0  # AIが発話完了したため催促タイマーをリセット
                                self._add_to_conversation_history("model", completed_ai_turn)

                            # 【同一ターン内の二重確認発話の自動クレンジング】
                            # 万が一Geminiが1つの発話内で「一通りお話を伺いました...ですか？」を2回重複生成した場合、
                            # 最初の確認文までで切り詰めて、同じ確認の二重発話を完全に排除する
                            if (completed_ai_turn.count("一通りお話を伺いました") >= 2
                                or completed_ai_turn.count("一通り伺いました") >= 2
                                or completed_ai_turn.count("一通りお伺いしました") >= 2):
                                split_match = re.search(r'^(.*?よろしい(?:ですか|でしょうか)[？?]?)', completed_ai_turn)
                                if split_match:
                                    logger.info(f"Deduplicated repeated confirmation in AI turn: '{completed_ai_turn}' -> '{split_match.group(1)}'")
                                    completed_ai_turn = split_match.group(1)
                            # ※重要: Geminiのネットワーク送信完了(turn_complete)時点ではまだブラウザのスピーカーから
                            #   音声が再生中であるため、ここで self.echo_guard_until = 0.0 にしてはいけない！
                            #   （ai_playback_until またはブラウザからの ai_speech_ended で正確に解除される）
                            if completed_ai_turn:
                                if self.collector_status == "idle" and any(
                                    kw in completed_ai_turn for kw in (
                                        "聞き取りをします", "聞き取りをはじめ", "聞き取りを始め",
                                        "思い出の絵をキャンバスに描いてみませんか", "思い出の絵を描いてみませんか",
                                        "思い出の絵を描いてみましょう", "思い出の絵を描いていきましょう",
                                        "どんな思い出の絵を描", "どんな風景を思い浮かべますか",
                                        "①テーマ", "テーマについてお聞きします"
                                    )
                                ):
                                    self.collector_status = "collecting"
                                    self.collector_active_step = "topic"
                                    self.ai_asked_confirmation = False
                                    self.user_confirmed_drawing = False
                                elif self.collector_status == "drawn":
                                    refine_ask_keywords = (
                                        "直しますか", "直しましょうか", "描き直しますか", "描き直しましょうか",
                                        "手直ししますか", "手直ししましょうか", "描き足しますか", "描き足しましょうか",
                                        "修正しますか", "修正しましょうか", "変更しますか", "変更しましょうか"
                                    )
                                    if any(kw in completed_ai_turn for kw in refine_ask_keywords):
                                        self.ai_asked_refine = True
                                        self.user_agreed_refine = False
                                        logger.info(f"AI asked refine confirmation: '{completed_ai_turn}'")
                                    # 【ユーザー要件】さくらさんの「描き直します、〇〇ですね」をトリガーにして書き直し内容を抽出し、
                                    # 万が一ツールが呼ばれていない場合はバックエンドが自律的に描き直しを実行する
                                    refine_echo_match = re.search(
                                        r"描き直します[、。,\s]*(.+?)(?:ですね|のですね|ますね|ですね！|ですね。|$)",
                                        completed_ai_turn
                                    )
                                    if refine_echo_match and not self.is_generating_media and not self.tool_called_in_turn:
                                        extracted_feedback = refine_echo_match.group(1).strip(" 、。！？!?「」")
                                        if extracted_feedback and len(extracted_feedback) >= 2 and "か" not in extracted_feedback[-1:]:
                                            logger.info(f"🎨 Triggered refinement from AI echo '描き直します': '{extracted_feedback}'")
                                            orig_id = self.generated_memories[-1].memory_id if self.generated_memories else ""
                                            asyncio.create_task(
                                                self._handle_media_refinement(
                                                    session,
                                                    None,
                                                    {
                                                        "original_memory_id": orig_id,
                                                        "user_feedback": extracted_feedback,
                                                        "updated_visual_elements": self.collector_summary or extracted_feedback
                                                    }
                                                )
                                            )
                                if self.collector_status not in ("drawing", "drawn") and not self.is_generating_media:
                                    # さくらさんの発話（質問および復唱プレフィックス）からバックエンド側でも自律的に聞き取りステップを追跡・同期
                                    if self.collector_status == "collecting":
                                        # 【最重要】「〜についてお聞きします」（次の質問）を「〜について復唱します」（前の復唱）より最優先で判定する
                                        if any(k in completed_ai_turn for k in ("雰囲気についてお聞きします", "お気持ちについてお聞きします", "⑥雰囲気", "6. 雰囲気")):
                                            self.collector_active_step = "mood"
                                        elif any(k in completed_ai_turn for k in ("様子についてお聞きします", "見えたものについてお聞きします", "⑤様子", "5. 様子")):
                                            self.collector_active_step = "details"
                                        elif any(k in completed_ai_turn for k in ("登場人物についてお聞きします", "人物についてお聞きします", "④登場人物", "4. 登場人物")):
                                            self.collector_active_step = "people"
                                        elif any(k in completed_ai_turn for k in ("天候についてお聞きします", "季節についてお聞きします", "お天気についてお聞きします", "③天候", "3. 天候")):
                                            self.collector_active_step = "weather"
                                        elif any(k in completed_ai_turn for k in ("場所についてお聞きします", "舞台についてお聞きします", "②場所", "2. 場所")):
                                            self.collector_active_step = "place"
                                        elif any(k in completed_ai_turn for k in ("テーマについてお聞きします", "話題についてお聞きします", "①テーマ", "1. テーマ")):
                                            self.collector_active_step = "topic"
                                        elif any(k in completed_ai_turn for k in ("雰囲気について復唱します", "お気持ちについて復唱します")):
                                            self.collector_active_step = "mood"
                                        elif any(k in completed_ai_turn for k in ("様子について復唱します", "見えたものについて復唱します")):
                                            self.collector_active_step = "mood"
                                        elif any(k in completed_ai_turn for k in ("登場人物について復唱します", "人物について復唱します")):
                                            self.collector_active_step = "details"
                                        elif any(k in completed_ai_turn for k in ("天候について復唱します", "季節について復唱します", "お天気について復唱します")):
                                            self.collector_active_step = "people"
                                        elif any(k in completed_ai_turn for k in ("場所について復唱します", "舞台について復唱します")):
                                            self.collector_active_step = "weather"
                                        elif any(k in completed_ai_turn for k in ("テーマについて復唱します", "話題について復唱します")):
                                            self.collector_active_step = "place"
                                        logger.info(f"🔄 AI speech step tracker: active_step is now '{self.collector_active_step}' based on AI turn: '{completed_ai_turn}'")

                                    # 最終確認フレーズの厳格判定（文末や途中に「よろしいですか」「よろしいでしょうか」「描いてよろしい」などの結び疑問文が存在することを必須化）
                                    has_summary_preamble = any(
                                        kw in completed_ai_turn for kw in (
                                            "一通りお話を伺いました", "一通りお伺いしました", "一通り伺いました", "お話を伺いました"
                                        )
                                    )
                                    has_question_ending = any(
                                        kw in completed_ai_turn for kw in (
                                            "よろしいですか", "よろしいでしょうか", "描いてよろしい", "描いてもよろしい",
                                            "描きましょうか", "描いてみませんか", "絵にしてよろしい"
                                        )
                                    )
                                    is_clear_confirm_phrase = (
                                        (has_summary_preamble and has_question_ending) or
                                        any(kw in completed_ai_turn for kw in (
                                            "この内容で絵を描いてもよろしい", "この内容で描いてよろしい",
                                            "この内容でよろしいですか", "この内容でよろしいでしょうか",
                                            "描いてもよろしいでしょうか"
                                        ))
                                    )
                                    # 「〜いらっしゃいましたか」「どんな〜」「どうでしたか」等の聞き取り途中質問が含まれている場合は最終確認にしない
                                    is_mid_question = any(
                                        mq in completed_ai_turn for mq in (
                                            "いらっしゃいましたか", "どんな人", "どんな場所", "どんな様子",
                                            "どんなお気持ち", "どうでしたか", "教えていただけますか"
                                        )
                                    )
                                    if is_clear_confirm_phrase and not is_mid_question:
                                        self.ai_asked_confirmation = True
                                        self.collector_status = "confirming"
                                        self.confirmed_summary_text = completed_ai_turn
                                        logger.info(f"📝 Captured AI confirmation summary for media prompt: '{completed_ai_turn}'")
                                        # クライアントへ情景確認通知を送信し、テキストボックスを即座に開かせる
                                        summary_to_send = self.collector_summary or completed_ai_turn
                                        await self.websocket.send_json({
                                            "type": "scene_confirmation_prompt",
                                            "summary": summary_to_send,
                                            "topic": self.discussed_topics[-1] if self.discussed_topics else "思い出の風景"
                                        })
                                        # フロントエンドの情景メモカードへもリアルタイム全項目同期
                                        await self.websocket.send_json({
                                            "type": "scene_memory_full_sync",
                                            "title": self.discussed_topics[-1] if self.discussed_topics else "思い出の風景",
                                            "visual_elements": completed_ai_turn,
                                            "summary": completed_ai_turn,
                                            "status": "confirming"
                                        })
                                    elif has_summary_preamble and not has_question_ending and not is_mid_question:
                                        # 【発話途切れ検知 ＆ 自動リカバリー】
                                        # 「一通り伺いました」と言ったのに「よろしいですか？」を言えずに途中で切れてしまった場合（例: 「秋晴れの」で中断）
                                        logger.warning(f"⚠️ AI speech was truncated before confirmation question: '{completed_ai_turn}'. Triggering recovery prompt.")
                                        asyncio.create_task(
                                            self._recover_truncated_confirmation(session, completed_ai_turn)
                                        )
                                    elif self.collector_status == "collecting":
                                        # 【聞き取り中の発話途切れ自動リカバリー】
                                        # 「③天候についてお聞き」のように文末が質問にならず途中で途切れた場合は言い直しを促す
                                        ends_with_question = bool(re.search(r'(?:でしょうか|ますか|ましょうか|ですか|かな|教えて|聞かせて|ください|？|\?)[。！!\s]*$', completed_ai_turn))
                                        if not ends_with_question and (time.time() - self.last_ai_prompt_time > 8.0):
                                            self.last_ai_prompt_time = time.time()
                                            logger.warning(f"⚠️ AI collecting speech truncated mid-sentence: '{completed_ai_turn}'. Scheduling auto-recovery.")
                                            step_questions = {
                                                "topic": "「①テーマについてお聞きします。どんな思い出の絵を描きましょうか？」",
                                                "place": "「②場所についてお聞きします。そこはどんな場所や舞台でしたか？」",
                                                "weather": "「③天候についてお聞きします。その時の季節やお天気はどうでしたか？」",
                                                "people": "「④登場人物についてお聞きします。そこにはどなたがいらっしゃいましたか？」",
                                                "details": "「⑤様子についてお聞きします。周りにどんなものが見えましたか？」",
                                                "mood": "「⑥雰囲気についてお聞きします。その時はどんなお気持ちでしたか？」",
                                            }
                                            was_echo_truncated = ("復唱" in completed_ai_turn) and ("お聞きします" not in completed_ai_turn) and ("ですね" not in completed_ai_turn)
                                            next_step_map = {
                                                "topic": "place",
                                                "place": "weather",
                                                "weather": "people",
                                                "people": "details",
                                                "details": "mood",
                                                "mood": "confirm",
                                            }
                                            last_user_utt_snapshot = self.last_user_utterance
                                            summary_snapshot = self.collector_summary.strip() if self.collector_summary else "、".join(self.discussed_topics[-6:])
                                            scheduled_time = time.time()
                                            scheduled_step = self.collector_active_step
                                            async def _recover_collecting_q(
                                                s_time=scheduled_time,
                                                s_step=scheduled_step,
                                                echo_cut=was_echo_truncated,
                                                u_utt=last_user_utt_snapshot,
                                                s_ctx=summary_snapshot
                                            ):
                                                await asyncio.sleep(2.0)
                                                if not self.is_active or self.collector_status != "collecting":
                                                    logger.info(f"Skipped collecting auto-recovery (active={self.is_active}, status={self.collector_status})")
                                                    return
                                                if self.last_ai_output_time > s_time or self.current_ai_turn_text.strip() or (time.time() < self.ai_playback_until):
                                                    logger.info(f"Skipped collecting auto-recovery (AI already responding/speaking)")
                                                    return
                                                # collector_syncでステップが1つ先に進んでいる場合は、その進んだ先のステップを優先して質問する
                                                effective_step = self.collector_active_step
                                                if echo_cut and effective_step == s_step:
                                                    effective_step = next_step_map.get(s_step, s_step)
                                                q = step_questions.get(effective_step, step_questions["topic"])
                                                try:
                                                    self.last_ai_prompt_time = time.time()
                                                    logger.info(f"🔄 Executing collecting auto-recovery prompt (echo_cut={echo_cut}, s_step={s_step}, effective={effective_step}): {q}")
                                                    if effective_step == "confirm":
                                                        rec_msg = (
                                                            f"直前の⑥雰囲気の復唱が途中で切れてしまいました。\n"
                                                            f"お父さんの「{u_utt}」というお話を「〜ですね！」と短く復唱し終えてから、"
                                                            f"これまで伺った内容（{s_ctx}）を①〜⑥まで最後まで簡潔に復唱し、"
                                                            f"最後に「この内容で絵を描いてもよろしいでしょうか？」と尋ねてください。"
                                                        )
                                                    elif echo_cut and u_utt:
                                                        rec_msg = (
                                                            f"直前の復唱が途中で切れてしまいました。"
                                                            f"お父さんの「{u_utt}」というお話の続きを「〜ですね！」と20文字以内の短い文で最後まで復唱し終えてから、"
                                                            f"続けて {q} と声に出して尋ねてください。"
                                                        )
                                                    else:
                                                        rec_msg = f"続けて {q} と1文だけで短く声に出して尋ねてください。"
                                                    await session.send_client_content(
                                                        turns=[types.Content(role="user", parts=[types.Part.from_text(
                                                            text=rec_msg
                                                        )])],
                                                        turn_complete=True
                                                    )
                                                except Exception as rc_err:
                                                    logger.warning(f"Failed to recover collecting question: {rc_err}")
                                            asyncio.create_task(_recover_collecting_q())
                                await self.websocket.send_json({
                                    "type": "transcript",
                                    "role": "model",
                                    "text": completed_ai_turn,
                                    "turn_complete": True
                                })
                                # AIが描画開始セリフを喋った場合、重複発話防止フラグを即座にON
                                draw_words_check = [
                                    "今からキャンバスに描", "今から描いてみます", "キャンバスに描きますね",
                                    "描いてみますね", "絵にしてみますね", "いま一生懸命描", "少しだけ待っていてください"
                                ]
                                if any(w in completed_ai_turn for w in draw_words_check):
                                    self.drawing_announced = True
                                self.last_ai_utterance = completed_ai_turn
                                if not hasattr(self, "recent_ai_utterances"):
                                    self.recent_ai_utterances = []
                                self.recent_ai_utterances.append(completed_ai_turn)
                                if len(self.recent_ai_utterances) > 6:
                                    self.recent_ai_utterances.pop(0)

                                # 【聞き取り停滞・沈黙防止リカバリー】
                                # 聞き取りモード中に「はい、何でしょうか？」等の単発質問返しで停止してしまった場合、
                                # 直ちに現在の聞き取りステップの質問を促すリカバリープロンプトを注入する
                                if (
                                    self.collector_status == "collecting"
                                    and not self.is_generating_media
                                    and any(w in completed_ai_turn for w in ("何でしょうか", "何ですか", "もう一度お話", "聞こえません"))
                                    and not any(q in completed_ai_turn for q in ("どんな", "いらっしゃい", "様子", "お天気", "場所", "季節", "気持ち"))
                                ):
                                    logger.info(f"AI paused with clarification ('{completed_ai_turn}'). Triggering step advance prompt.")
                                    step_label_map = {
                                        "topic": "テーマや話題", "place": "場所や舞台", "weather": "季節やお天気、時間帯",
                                        "people": "登場人物（どなたがいらっしゃったか）", "details": "周りの様子や見えたもの", "mood": "その時のお気持ちや雰囲気"
                                    }
                                    step_text = step_label_map.get(self.collector_active_step, "情景の様子")
                                    adv_prompt = f"聞き取りの途中です。{nickname}に向かって、「先ほどの続きですね！{step_text}について教えていただけますか？」と優しく問いかけて聞き取りを進めてください。"
                                    asyncio.create_task(session.send_client_content(
                                        turns=[types.Content(role="user", parts=[types.Part.from_text(text=adv_prompt)])],
                                        turn_complete=True
                                    ))
                            await self.websocket.send_json({
                                "type": "avatar_state",
                                "state": "listening"
                            })

                            # 【セーフティネット】AIが「今から描いてみますね」と描画実行を宣言したのに
                            # tool_call が行われなかった場合、または先走って描画を口頭約束してしまった場合、
                            # 確約フォールバックとして直ちに描画タスクを起動する！
                            # （ユーザーが『さくらさんが描くと言ったのに絵が始まらない』デッドロックに陥るのを100%完全防止）
                            if (
                                not self.tool_called_in_turn
                                and completed_ai_turn
                                and not self.is_generating_media
                                and self.collector_status != "drawing"
                                and (self.collector_status in ("confirming", "ready", "collecting") or self.confirmed_summary_text or self.collector_summary or len(self.discussed_topics) >= 1)
                            ):
                                # AIの発話から描画宣言を検知した際の自動メディア生成（セーフティネット）
                                draw_exec_words = [
                                    "今からキャンバスに描いてみます", "今から描いてみます", "キャンバスに描きますね",
                                    "描いてみますね", "絵にしてみますね", "いま一生懸命描", "キャンバスに描いてみましょう",
                                    "絵を描いてみますね", "今から描いてみるね", "今からキャンバスに描",
                                    "少しだけ待っていてくださいね", "少し待っていてくださいね", "少しの間待っていてくださいね"
                                ]
                                non_draw_questions = [
                                    "描いてみましょうか", "描きましょうか", "描いてもよろしいでしょうか",
                                    "どんな思い出", "どんな絵", "どんな場所", "どんな様子",
                                    "お話を伺います", "聞き取りをします", "聞き取りを始め",
                                    "教えていただけますか", "いかがですか", "よろしいでしょうか",
                                    "直しましょうか", "描き直しましょうか", "修正しましょうか"
                                ]
                                is_draw_statement = any(w in completed_ai_turn for w in draw_exec_words)
                                is_question = any(q in completed_ai_turn for q in non_draw_questions) or completed_ai_turn.endswith(("？", "?", "でしょうか"))
                                # 【最重要多重描画防壁】
                                # すでに描画中、生成中、描画直後（30秒以内）、または描画完了（drawn）状態の場合は
                                # 音声文字起こしの遅延テキストによって勝手に再描画を起動することを100%完全遮断する！
                                can_fallback_draw = (
                                    not self.is_generating_media
                                    and self.collector_status not in ("drawing", "drawn")
                                    and (time.time() - self.last_draw_time > 30.0)
                                )
                                if is_draw_statement and not is_question:
                                    if can_fallback_draw:
                                        logger.info(f"🎨 AI expressed explicit drawing execution in speech: '{completed_ai_turn}'. Activating guaranteed fallback media generation.")
                                        topic = self.last_art or (self.discussed_topics[-1] if self.discussed_topics else "思い出の風景")
                                        self.collector_status = "drawing"
                                        self.user_confirmed_drawing = False
                                        await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
                                        asyncio.create_task(
                                            self._handle_media_generation(session, None, {
                                                "scene_type": "past_memory",
                                                "japanese_title": topic[:18],
                                                "visual_elements": self.confirmed_summary_text or self.collector_summary or f"【AIとご本人が語り合った情景】: {completed_ai_turn}（話題: {topic}）",
                                                "media_format": "image",
                                                "ambient_sound": "autumn_insects"
                                            })
                                        )
                                    else:
                                        logger.info(f"🛡️ Ignored delayed drawing speech trigger: '{completed_ai_turn}' (status={self.collector_status}, is_generating={self.is_generating_media}, elapsed={time.time() - self.last_draw_time:.1f}s)")

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

                                # 【厳格ガード2】描画完了後（drawn / save_confirming）にお父さんが「このままでいい」「保存して」「直さなくていい」と満足された際に
                                # Geminiが誤ってツールを呼んでしまう暴走をブロック（※ただし正規の描き直し refine_memory_visual は後続の修正パイプラインで即時実行！）
                                user_fb_arg = (args.get("user_feedback") or "").strip()
                                recent_user_utt = (self.discussed_topics[-1] if self.discussed_topics else "").strip()
                                pure_satisfaction_words = (
                                    "このままでいい", "このままで良い", "これでいい", "これで良い", "この雰囲気でよい",
                                    "変えなくていい", "修正なし", "直さなくていい", "保存して", "保存する", "保存お願い",
                                    "気に入った", "結構です", "直さない"
                                )
                                user_explicitly_satisfied = any(pw in recent_user_utt for pw in pure_satisfaction_words)

                                if self.collector_status in ("drawn", "save_confirming") and user_explicitly_satisfied:
                                    logger.warning(
                                        f"Blocked unwanted {func_name} because user is satisfied ('{recent_user_utt}'). Prompting save confirmation."
                                    )
                                    self.collector_status = "save_confirming"
                                    try:
                                        await self.websocket.send_json({
                                            "type": "collector_sync",
                                            "status": "save_confirming",
                                            "is_awaiting_save_confirmation": True
                                        })
                                    except Exception:
                                        pass
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
                                                            f"絶対に「今から描きますね」とは言わず、"
                                                            f"「気に入っていただけて嬉しいです！この絵を保存しますか？」と声に出して保存の確認をしてください。"
                                                        )
                                                    }
                                                )
                                            ]
                                        )
                                    except Exception as resp_err:
                                        logger.warning(f"Error sending approval tool rejection response: {resp_err}")
                                    continue

                                # 【厳格ガード】Geminiが確認フェーズ中にフライングでgenerate_memory_visualを呼び出しても、
                                # ユーザー本人の直接合意（user_confirmed_drawing == True）がない限り絶対に承認しない。
                                # （以前存在した「Geminiが呼んだらユーザー承認とみなす」過剰推測ロジックはフライング描画の原因となったため完全撤去済み）

                                # 【重複描画＆発話ループ防止＆二重確認完全遮断ガード】
                                # 1. すでに描画中（drawing / is_generating_media）にGeminiがgenerate_memory_visualを呼び出してきた場合
                                # 2. すでに描画完了（drawn / save_confirming）した後に遅延到着した古いgenerate_memory_visualを受信した場合
                                # これらを絶対に「未確認（confirmation_required）」として再処理せず、静かに正常応答して追加発話・二重確認を100%遮断する！
                                if func_name == "generate_memory_visual" and (
                                    self.collector_status in ("drawing", "drawn", "save_confirming")
                                    or self.is_generating_media
                                    or (len(self.generated_memories) > 0 and (time.time() - self.last_draw_time < 15.0))
                                ):
                                    logger.info(f"Gemini invoked generate_memory_visual while media is drawing or already drawn (status={self.collector_status}, title='{raw_title_arg}'). Acknowledging cleanly without prompt.")
                                    if raw_title_arg and raw_title_arg not in generic_titles:
                                        self.last_art = raw_title_arg
                                    try:
                                        msg = (
                                            f"すでに{nickname}の絵「{raw_title_arg or '思い出の絵'}」は完成して画面に表示されています。追加の発話や再描画は不要です。"
                                            if self.collector_status in ("drawn", "save_confirming") else
                                            f"現在{nickname}の思い出「{raw_title_arg or '思い出の風景'}」をキャンバスに描画中です。追加の発話は絶対にせず、絵が完成して画面に浮かび上がるまで静かにお待ちください。"
                                        )
                                        await session.send_tool_response(
                                            function_responses=[
                                                types.FunctionResponse(
                                                    id=call_id,
                                                    name=func_name,
                                                    response={
                                                        "status": "drawing_in_progress" if self.collector_status == "drawing" else "already_completed",
                                                        "message": msg
                                                    }
                                                )
                                            ]
                                        )
                                    except Exception as resp_err:
                                        logger.warning(f"Error sending drawing status response: {resp_err}")
                                    continue

                                # 【最重要要件1】日常会話中（idle）の勝手な描画ツールの呼び出しを100%完全遮断！
                                if self.collector_status == "idle":
                                    logger.warning(f"⛔ Blocking premature generate_memory_visual in 'idle' status. Conversation is in normal chat.")
                                    try:
                                        await session.send_tool_response(
                                            function_responses=[
                                                types.FunctionResponse(
                                                    id=call_id,
                                                    name=func_name,
                                                    response={
                                                        "status": "rejected_idle",
                                                        "message": (
                                                            f"現在はお父様と穏やかな日常会話を楽しんでいる段階です。"
                                                            f"お父様から絵画の指示や合意はありませんので、絵を描くツールは絶対に呼べません。"
                                                            f"ツールを使わず、お父様のお話に優しく共感して日常会話を続けてください。"
                                                        )
                                                    }
                                                )
                                            ]
                                        )
                                    except Exception as resp_err:
                                        logger.warning(f"Error sending idle tool rejection: {resp_err}")
                                    continue

                                # 【最重要要件2】聞き取り途中（collecting）のフライング呼び出しを100%完全遮断！
                                if self.collector_status == "collecting":
                                    logger.warning(f"⛔ Blocking premature generate_memory_visual in 'collecting' status before completion.")
                                    try:
                                        await session.send_tool_response(
                                            function_responses=[
                                                types.FunctionResponse(
                                                    id=call_id,
                                                    name=func_name,
                                                    response={
                                                        "status": "rejected_collecting",
                                                        "message": (
                                                            f"まだ思い出の聞き取りの途中です。"
                                                            f"すべての項目の聞き取りが完了し、お父様から『描いてください』と合意をもらうまでは絵を描くツールは呼べません。"
                                                            f"現在質問している項目のお話を優しく声に出して続けてください。"
                                                        )
                                                    }
                                                )
                                            ]
                                        )
                                    except Exception as resp_err:
                                        logger.warning(f"Error sending collecting tool rejection: {resp_err}")
                                    continue

                                # 【描き直し・情景修正要求 (refine_memory_visual) の専用処理】
                                if func_name == "refine_memory_visual":
                                    if self.is_generating_media:
                                        logger.info(f"refine_memory_visual received while already generating/refining media. Awaiting completion.")
                                        try:
                                            await session.send_tool_response(
                                                function_responses=[
                                                    types.FunctionResponse(
                                                        id=call_id,
                                                        name=func_name,
                                                        response={
                                                            "status": "refining_in_progress",
                                                            "message": (
                                                                "現在キャンバスで一生懸命描き直している最中です。"
                                                                "描き直しが完了して画面に絵が出るまで少々お待ちください。"
                                                            )
                                                        }
                                                    )
                                                ]
                                            )
                                        except Exception:
                                            pass
                                        continue

                                    logger.info(f"🎨 User requested redraw/refinement of drawn image: '{raw_title_arg}'. Executing refinement pipeline now!")
                                    self.collector_status = "drawing"
                                    self.user_agreed_refine = False
                                    self.ai_asked_refine = False
                                    await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
                                    try:
                                        await session.send_tool_response(
                                            function_responses=[
                                                types.FunctionResponse(
                                                    id=call_id,
                                                    name=func_name,
                                                    response={
                                                        "status": "refining_in_progress",
                                                        "message": (
                                                            f"「{raw_title_arg or '思い出の絵'}」の描き直し（情景修正）をいまキャンバスで開始しました。"
                                                            f"現在バックグラウンドで一生懸命描き直している最中です。"
                                                            f"描き直しが完了して画面に表示されるまで、余計な発話は一切せず、静かにお待ちください。"
                                                        )
                                                    }
                                                )
                                            ]
                                        )
                                    except Exception as r_err:
                                        logger.warning(f"Error sending refine tool response: {r_err}")
                                    asyncio.create_task(
                                        self._handle_media_refinement(session, call_id, args)
                                    )
                                    continue

                                # 【絵画完成後の勝手な新規描画の遮断】
                                if self.collector_status in ("drawn", "save_confirming"):
                                    if func_name == "generate_memory_visual":
                                        logger.info("Blocking generate_memory_visual in 'drawn' status. Awaiting save confirmation or refinement.")
                                        try:
                                            await session.send_tool_response(
                                                function_responses=[
                                                    types.FunctionResponse(
                                                        id=call_id,
                                                        name=func_name,
                                                        response={
                                                            "status": "already_drawn",
                                                            "message": (
                                                                f"絵はすでに完成しています。勝手に最初から描き直すことはできません。"
                                                                f"修正がある場合は refine_memory_visual を呼び出すか、"
                                                                f"{nickname}に『この絵を保存しますか？』と確認してください。"
                                                            )
                                                        }
                                                    )
                                                ]
                                            )
                                        except Exception:
                                            pass
                                        continue

                                # 【超重要】Geminiが要約・情景データを集め終えて確認フェーズに入った場合のみ、情景データを同期
                                visual_elements_arg = (args.get("visual_elements") or "").strip()
                                if visual_elements_arg:
                                    self.confirmed_summary_text = visual_elements_arg
                                if raw_title_arg and raw_title_arg not in generic_titles:
                                    self.last_art = raw_title_arg

                                # 【最重要要件3】お父様ご本人からの明確な描画承認（「はい」「描いて」）がある場合のみ描画パイプラインを実行！
                                if self.user_confirmed_drawing and self.collector_status in ("confirming", "ready"):
                                    logger.info(f"🎨 User explicit approval verified for drawing: title='{raw_title_arg}'. Executing generation now!")
                                    self.collector_status = "drawing"
                                    self.user_confirmed_drawing = False
                                    await self.websocket.send_json({"type": "avatar_state", "state": "drawing"})
                                    asyncio.create_task(
                                        self._handle_media_generation(session, call_id, args)
                                    )
                                    continue

                                # まだユーザーご本人の確認が得られていない場合：
                                # 絵を描く前に、必ずお父様に「この内容で絵を描いてもよろしいでしょうか？」と確認を促す
                                logger.info(
                                    f"generate_memory_visual received before user approval; prompting AI to ask user confirmation "
                                    f"(title='{raw_title_arg}')."
                                )
                                self.collector_status = "confirming"
                                self.ai_asked_confirmation = True
                                self.echo_guard_until = time.time() + 3.0
                                reject_msg = (
                                    f"思い出の情景「{visual_elements_arg or raw_title_arg}」を受け取りました！"
                                    f"まだ{nickname}から絵を描く合意をもらっていませんので、絵を描く前に必ず{nickname}に向かって「一通りお話を伺いました！この内容で絵を描いてもよろしいでしょうか？」と優しく声に出して確認してください。"
                                    f"※【絶対厳守】先走って『今から描きますね』と言ってはいけません。必ず{nickname}が『はい』と答えるのを静かに待ってください。"
                                )
                                try:
                                    await session.send_tool_response(
                                        function_responses=[
                                            types.FunctionResponse(
                                                id=call_id,
                                                name=func_name,
                                                response={
                                                    "status": "confirmation_required",
                                                    "message": reject_msg
                                                }
                                            )
                                        ]
                                    )
                                except Exception as resp_err:
                                    logger.warning(f"Error sending premature tool rejection response: {resp_err}")
                                continue

                                # 【ユーザー要件・絶対厳守】絵が完成した後に勝手に再描画しようとするのを完全遮断！
                                # さくらさんが「〜のように直しますか？」と発言し、ユーザーが回答（「はい」「直して」等）を聞くまでは絶対に実行しない！
                                if self.collector_status == "drawn":
                                    if func_name == "generate_memory_visual":
                                        logger.info("Blocking generate_memory_visual in 'drawn' status. Awaiting save confirmation or new topic.")
                                        try:
                                            await session.send_tool_response(
                                                function_responses=[
                                                    types.FunctionResponse(
                                                        id=call_id,
                                                        name=func_name,
                                                        response={
                                                            "status": "already_drawn",
                                                            "message": (
                                                                f"絵はすでに完成しています。"
                                                                f"勝手に絵を描き直すことは絶対に禁止です。"
                                                                f"{nickname}に『この絵を保存しますか？』と確認してください。"
                                                            )
                                                        }
                                                    )
                                                ]
                                            )
                                        except Exception:
                                            pass
                                        continue


                                title = args.get("japanese_title") or args.get("title") or (self.discussed_topics[-1] if self.discussed_topics else "思い出の風景")
                                raw_elements = args.get("visual_elements") or args.get("scene_description") or args.get("description", "")
                                # 【最重要】さくらさんが聞き取ってまとめた確認要約文がある場合はそれを最優先プロンプトとする！
                                if self.confirmed_summary_text:
                                    elements = self.confirmed_summary_text
                                    args["visual_elements"] = elements
                                elif func_name == "generate_memory_visual" and self.collector_summary:
                                    elements = self.collector_summary
                                    args["visual_elements"] = elements
                                else:
                                    elements = raw_elements
                                logger.info(f"AI tool call: {func_name} for '{title}' (elements: '{elements}'). Generating visual artifact...")

                                # 連続描画クールダウン中の重複呼び出し、またはすでに生成実行中の場合は「今から描きますね」を二度言わせない（refineは30秒制限除外）
                                elapsed_draw = time.time() - self.last_draw_time
                                is_refine_call = (func_name == "refine_memory_visual")
                                if (self.is_generating_media or (not is_refine_call and self.last_draw_time > 0 and elapsed_draw < self.MIN_DRAW_INTERVAL_SEC)):
                                    wait_sec = max(1, int(self.MIN_DRAW_INTERVAL_SEC - elapsed_draw))
                                    logger.info(f"Skipping duplicate {func_name} tool response during active generation/cooldown for '{title}' (wait={wait_sec}s).")
                                    try:
                                        await session.send_tool_response(
                                            function_responses=[
                                                types.FunctionResponse(
                                                    id=call_id,
                                                    name=func_name,
                                                    response={
                                                        "status": "already_drawing",
                                                        "message": (
                                                            f"クォータ保護のため、前回の描画から30秒間お待ちいただいています（残り約{wait_sec}秒）。"
                                                            f"{nickname}に少しお待ちいただくようお伝えし、静かにお待ちください。"
                                                            f"※追加でツールを呼び出すことは絶対に禁止です。"
                                                        )
                                                    }
                                                )
                                            ]
                                        )
                                    except Exception:
                                        pass
                                    continue

                                self.collector_status = "drawing"
                                self.drawing_announced = True

                                # 1. Gemini側へ直ちにツール応答を返送（「現在描画進行中」であることを伝え、描き上がる前に「描きました」と嘘をつかせない）
                                # ※【二重発話の根本根絶】AIはツール呼び出しターンですでに「かしこまりました！今からキャンバスに描いてみますね」と発話しています。
                                # ツール応答のメッセージ内で再度「〇〇と伝えてください」と指示すると、モデルがツール完了後に全く同じセリフを二重発話してしまいます。
                                # そのため、ツール応答では「静かに待機する」指示のみを返し、追加発話を一切行わせません。
                                if func_name == "refine_memory_visual":
                                    tool_msg = (
                                        f"「{title}」の描き直し（情景修正）をいまキャンバスで開始しました。"
                                        f"現在バックグラウンドで一生懸命描き直している最中です。"
                                        f"描き直しが完了して画面に表示されるまで、余計な発話は一切せず、完全に静かに待機してください。"
                                        f"※まだ絵は完成していません。「もう描き直しましたよ」や「どうですか？」と先走って嘘をつくのは厳禁です。"
                                        f"※追加でツールを呼び出すことは絶対に禁止です。"
                                    )
                                else:
                                    tool_msg = (
                                        f"「{title}」の情景の描画をいまキャンバスで開始しました。"
                                        f"現在バックグラウンドで一生懸命描いている最中です。"
                                        f"絵が完成して画面に表示されるまで、余計な発話は一切せず、完全に静かに待機してください。"
                                        f"※まだ絵は完成していません。「描きましたよ」や「どうですか？」と先走って嘘をつくのは厳禁です。"
                                        f"※追加でツールを呼び出すことは絶対に禁止です。"
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

            # 【最重要】さくらさんが聞き取ってまとめた要約文（self.confirmed_summary_text）から純粋な情景描写を抽出
            summary_clean = ""
            if self.confirmed_summary_text:
                s = self.confirmed_summary_text
                # 前置きや挨拶の除去
                s = re.sub(r'^(?:[^\s、。]{2,10}さん[、\s]*)?(?:一通りお話を伺いました[。！、\s]*|お話を伺いました[。！、\s]*)?', '', s)
                # 末尾の質問・確認フレーズの除去
                s = re.sub(r'(?:この内容でよろしいでしょうか|この内容で絵を描いてもよろしいでしょうか|描いてもよろしいでしょうか|描いてみましょうか|よろしいでしょうか|描いてみますね)[？?。！\s]*$', '', s)
                summary_clean = s.strip(" 、。！!?")

            # 【最重要・ユーザー要件】描画エンジンへのプロンプトは①〜⑥の抽出内容をつなぎ合わせて作成
            raw_elements = (args.get("visual_elements") or args.get("scene_description") or "").strip()
            if self.collector_summary and len(self.collector_summary) >= 3:
                elements = self.collector_summary
            elif summary_clean:
                elements = summary_clean
            elif raw_elements:
                elements = raw_elements
            else:
                elements = title

            # タイトルの抽出・決定（「この内容で書いてください」等のユーザー指示文を排除し、思い出のテーマ名を抽出）
            raw_title = (args.get("japanese_title") or args.get("title") or "").strip()
            filter_titles = ("この内容で書いてください", "この内容で描いてください", "書いてください", "描いてください", "お願いします", "思い出の絵", "お父さんの思い出の絵", "思い出の風景")
            title = ""
            if raw_title and not any(ft in raw_title for ft in filter_titles):
                title = raw_title
            elif summary_clean:
                m = re.search(r'([^\s、。]{2,15}(?:の思い出|の情景|の風景|の絵|の様子))', summary_clean)
                if m:
                    title = m.group(1)
            elif self.confirmed_summary_text:
                m = re.search(r'([^\s、。]{2,15}(?:の思い出|の情景|の風景|の絵|の様子))', self.confirmed_summary_text)
                if m:
                    title = m.group(1)
            if not title and self.discussed_topics:
                for t in reversed(self.discussed_topics):
                    clean_t = t.strip(" 。、！!?")
                    if not any(ft in clean_t for ft in filter_titles) and len(clean_t) >= 2:
                        title = clean_t[:18]
                        break
            if not title:
                title = "懐かしい思い出の情景"

            media_format = MediaFormat(args.get("media_format", "image"))
            ambient_sound = AmbientSoundType(args.get("ambient_sound", "none"))

            # 連続描画防止チェック（最小描画間隔: 30秒）
            now = time.time()
            elapsed = now - self.last_draw_time
            if self.last_draw_time > 0 and elapsed < self.MIN_DRAW_INTERVAL_SEC:
                wait_sec = int(self.MIN_DRAW_INTERVAL_SEC - elapsed)
                logger.info(f"Cooldown active: skipping media generation for '{title}' ({wait_sec}s remaining)")
                # クールダウン待機時はステータスを描画完了（drawn）に復元してマイクシールドを直ちに解除
                self.collector_status = "drawn"
                self.is_generating_media = False
                reset_time_str = get_pacific_reset_time_jst()
                await self.websocket.send_json({
                    "type": "cooldown_notice",
                    "remaining_seconds": wait_sec,
                    "message": f"前回の描画から30秒間はクォータ保護のため待機中です（残り約{wait_sec}秒 / 本日{reset_time_str}リセット）"
                })
                return

            self.last_draw_time = time.time()

            art_style = args.get("art_style", "watercolor")

            # 描画開始時にクライアントへ使用モデル情報と試行フローを送信
            await self.websocket.send_json({
                "type": "drawing_models_info",
                "primary_model": "gemini-2.5-flash-image",
                "fallback_models": ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.8-flash"],
                "message": "高精細画像生成（gemini-2.5-flash-image）および高速SVGフォールバック（gemini-3.5-flash-lite）を実行中..."
            })

            # メディア生成実行（最大75秒タイムアウト保証。SVG生成60秒タイムアウトに対応）
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
                    timeout=75.0
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
            self.ai_asked_refine = False
            self.user_agreed_refine = False

            # クライアントへ新メディア表示通知（聞き取った情景ディテールを必ず同梱）
            is_blank = getattr(artifact, "is_fallback", False) and not artifact.media_url
            visual_desc = self.collector_summary or getattr(artifact, "visual_description", elements) or elements

            # 【重要】描画失敗（クォータ枯渇・サービス混雑・キャンバス空白）時の正直な通知と嘘の完全防止
            if is_blank or not artifact.media_url:
                logger.warning(f"Media generation could not produce image for '{artifact.title}'. Notifying user honestly.")
                self.collector_status = "idle"
                reset_time_jst = get_pacific_reset_time_jst()
                detail_lines = getattr(artifact, "error_details", "") or "全モデルでの描画が失敗しました。"
                error_msg = (
                    f"AI画像生成サービスの制限・タイムアウトが発生しました。\n\n"
                    f"【各モデルの試行結果・エラー詳細】\n{detail_lines}\n\n"
                    f"※Google API (Free Tier) の画像生成クォータは本日 {reset_time_jst}（日本時間）に全量リセットされます。"
                )
                await self.websocket.send_json({
                    "type": "canvas_error",
                    "title": "絵の描画制限・エラー詳細",
                    "message": error_msg,
                    "error_details": detail_lines,
                    "reset_time": reset_time_jst,
                    "models_tried": ["gemini-2.5-flash-image", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]
                })
                await self.websocket.send_json({
                    "type": "avatar_state",
                    "state": "listening"
                })

                # さくらさんには「絵が浮かびました」と嘘をつかせず、正直にお詫びして通常会話に戻す
                try:
                    raw_name = (self.profile.call_name or "お父さん").strip()
                    nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                    fail_notice = (
                        f"画像生成サービスの混雑または制限のため、絵を描くことができませんでした。"
                        f"{nickname}に向かって、「{nickname}、申し訳ありません。ただいま混雑のため、絵をうまくキャンバスに描くことができませんでした。少し時間をおいてからまた描いてみましょうね」と優しく正直に伝え、日常のおしゃべりに戻ってください。"
                        f"※絶対に「画面に絵が浮かびましたよ」「絵が完成しました」と嘘をついてはいけません。"
                    )
                    self.echo_guard_until = time.time() + 4.5
                    await session.send_client_content(
                        turns=[types.Content(role="user", parts=[types.Part.from_text(text=fail_notice)])],
                        turn_complete=True
                    )
                except Exception as ne:
                    logger.warning(f"Error sending fail notice: {ne}")
                return

            await self.websocket.send_json({
                "type": "new_media",
                "memory_id": artifact.memory_id,
                "title": artifact.title,
                "visual_elements": visual_desc,
                "media_url": artifact.media_url,
                "media_format": artifact.media_format.value,
                "ambient_sound": artifact.ambient_sound_type.value,
                "is_fallback": getattr(artifact, "is_fallback", False),
                "is_blank": False,
                "used_model": getattr(artifact, "model_summary", "")
            })

            # 絵が画面に出た瞬間にさくらさんに声で知らせる（画面表示のタイミングで初めて声かけ）
            try:
                self.last_completion_notice_time = time.time()
                raw_name = (self.profile.call_name or "お父さん").strip()
                nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                done_notice = (
                    f"【描画完了通知】「{artifact.title}」の絵が完成し、{nickname}の画面に表示されました！"
                    f"{nickname}に向かって、「{nickname}、画面に絵が浮かびましたよ！こんな雰囲気でよろしいでしょうか？」とだけ温かく声をかけてください。"
                    f"※「一通りお話を伺いました」等の聞き取り確認や「今から描きます」という過去の発話は絶対に繰り返さないでください。"
                    f"※これ以降は絵の感想を聞くフェーズです。generate_memory_visual は絶対に呼び出さないでください。"
                    f"※もしご本人が「この雰囲気でよい」「これでいいです」と答えられた場合は、絶対に refine_memory_visual（描き直し）を呼んではいけません。絵を保存するかどうかを確認してください。"
                    f"※【再描画ルール】もしご本人が「修正したい」「〇〇にして」「〇〇を追加して」「描き直して」など修正を希望された場合でも、いきなり勝手にツールを呼び出してはいけません。必ずまず『〇〇のように直しましょうか？』と優しく確認してください。そして{nickname}が『はい』『直して』『お願い』と答えてから初めて refine_memory_visual ツールを呼び出してください。"
                )
                logger.info(f"Sending visual completion voice prompt to Gemini Live for '{artifact.title}'...")
                # 描画完了と同時にマイクシールドを解除し、ユーザーの感想や修正発話を即座に受信可能にする
                self.is_generating_media = False
                self.echo_guard_until = 0.0
                await asyncio.sleep(0.05)
                try:
                    active_sess = self.current_live_session or session
                    await active_sess.send_client_content(
                        turns=[types.Content(role="user", parts=[types.Part.from_text(text=done_notice)])],
                        turn_complete=True
                    )
                except Exception as sc_err:
                    logger.debug(f"send_client_content error: {sc_err}")
            except Exception as notice_err:
                logger.warning(f"Done notice error: {notice_err}")

        except Exception as e:
            logger.error(f"Error handling media generation: {e}", exc_info=True)
            self.collector_status = "idle"
            err_detail = str(e)
            try:
                # 1. 画面上にエラーメッセージを表示し、ローディングオーバーレイを解除
                await self.websocket.send_json({
                    "type": "canvas_error",
                    "title": "絵の描画でエラーが発生しました",
                    "message": f"エラー内容: {err_detail}。通常のお話に戻ります。"
                })
                await self.websocket.send_json({
                    "type": "avatar_state",
                    "state": "listening"
                })

                # 2. さくらさんからエラーの発生と通常会話復帰を声で発話
                raw_name = (self.profile.call_name or "お父さん").strip()
                nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                p_name = self.profile.partner.name if (self.profile.partner and self.profile.partner.name) else "さくら"
                err_voice_prompt = (
                    f"絵の描画処理でエラー（{err_detail}）が発生しました。"
                    f"{nickname}に向かって、「{nickname}、申し訳ありません。絵を描く途中でエラーが発生してしまいました。通常のおしゃべりに戻りますね」と優しく声に出して伝え、通常会話に復帰してください。"
                )
                self.echo_guard_until = time.time() + 4.5
                await session.send_client_content(
                    turns=[types.Content(role="user", parts=[types.Part.from_text(text=err_voice_prompt)])],
                    turn_complete=True
                )
            except Exception as notify_err:
                logger.warning(f"Error notifying media error to client: {notify_err}")
        finally:
            self.is_generating_media = False
            self.is_triggering_draw = False

    async def _handle_media_refinement(self, session, call_id: Optional[str], args: dict):
        """共同描画・修正処理（非同期バックグラウンド実行）"""
        if self.is_generating_media:
            logger.info("Media generation/refinement already in progress; skipping duplicate call.")
            return
        self.is_generating_media = True
        try:
            original_id = args.get("original_memory_id", "")
            feedback = args.get("user_feedback", "")
            elements = args.get("updated_visual_elements", "")

            # 直前のメモリIDがあればそれを優先
            if not original_id and self.generated_memories:
                original_id = self.generated_memories[-1].memory_id

            # 【最重要】聞き取り済みの情景要素（collector_summary / confirmed_summary_text）を100%保持・統合
            base_elements = (self.collector_summary or self.confirmed_summary_text or "").strip()
            if base_elements:
                if elements and elements not in base_elements:
                    combined_elements = f"{base_elements}、{elements}"
                else:
                    combined_elements = base_elements
            else:
                combined_elements = elements

            logger.info(f"Executing media refinement: original_id='{original_id}', feedback='{feedback}', combined_elements='{combined_elements}'")
            new_artifact = await refine_memory_visual_artifact(
                original_memory_id=original_id,
                user_feedback=feedback,
                updated_visual_elements=combined_elements,
                dementia_level=self.profile.dementia_level,
                api_key=self.api_key
            )
            if new_artifact:
                self.generated_memories.append(new_artifact)
                self.collector_status = "drawn"
                self.last_draw_time = time.time()
                self.ai_asked_refine = False
                self.user_agreed_refine = False
                is_blank = getattr(new_artifact, "is_fallback", False) and not new_artifact.media_url
                visual_desc = self.collector_summary or getattr(new_artifact, "visual_description", combined_elements) or combined_elements
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
                    self.last_completion_notice_time = time.time()
                    raw_name = (self.profile.call_name or "お父さん").strip()
                    nickname = raw_name if raw_name.endswith(("さん", "様", "ちゃん", "先生", "お父さん", "お母さん", "おじいちゃん", "おばあちゃん")) else f"{raw_name}さん"
                    done_notice = (
                        f"【描画完了通知】「{new_artifact.title}」の描き直しが完了し、{nickname}の画面に表示されました！"
                        f"{nickname}に向かって、「{nickname}、描き直した絵が画面に出ましたよ！こんな雰囲気でよろしいでしょうか？」と温かく声をかけてください。"
                        f"※もしご本人が「この雰囲気でよい」「これでいいです」と答えられた場合は、絶対に refine_memory_visual（描き直し）を呼ばず、絵を保存するかどうかを確認してください。"
                        f"※【再描画ルール】もしさらに修正を希望された場合でも、いきなり勝手にツールを呼び出してはいけません。必ずまず『〇〇のように直しましょうか？』と優しく確認してください。そして{nickname}が『はい』『直して』『お願い』と答えてから初めて refine_memory_visual ツールを呼び出してください。"
                    )
                    # 描き直し完了と同時にマイクシールドを解除し、ユーザーの修正・感想発話を即座に受信可能にする
                    self.is_generating_media = False
                    self.echo_guard_until = 0.0
                    await asyncio.sleep(0.05)
                    active_sess = self.current_live_session or session
                    await active_sess.send_client_content(
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
            logger.error(f"Error in media refinement: {e}", exc_info=True)
            await self.websocket.send_json({
                "type": "avatar_state",
                "state": "listening"
            })
        finally:
            self.is_generating_media = False

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
