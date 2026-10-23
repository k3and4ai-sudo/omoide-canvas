"""
データモデル定義 (backend/models.py)
仕様書 3.7 データモデル設計に基づく Pydantic モデル群
"""

from datetime import datetime, date
from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, Field


class DementiaLevel(str, Enum):
    """認知症進行度レベル"""
    MCI = "mci"             # 予防・軽度認知障害
    MILD = "mild"           # 軽度認知症
    MODERATE = "moderate"   # 中等度認知症


class SceneType(str, Enum):
    """情景の種別"""
    PAST_MEMORY = "past_memory"   # 過去の思い出
    FUTURE_DREAM = "future_dream" # これからの夢・行きたい場所


class MediaFormat(str, Enum):
    """メディアの出力フォーマット"""
    IMAGE = "image" # 静止画（水彩画調）
    VIDEO = "video" # 動画（シネマグラフ・スローモーション）


class AmbientSoundType(str, Enum):
    """懐かしの環境音タイプ"""
    AUTUMN_INSECTS = "autumn_insects" # 秋の虫の声
    GENTLE_WAVES = "gentle_waves"     # 穏やかな波の音
    WIND_CHIME = "wind_chime"         # 風鈴の音
    FESTIVAL_MUSIC = "festival_music" # お祭りの囃子
    TRAIN_STEAM = "train_steam"       # 汽車の汽笛・電車の走行音
    BIRDS_FOREST = "birds_forest"     # 小鳥のさえずり
    NONE = "none"                     # なし


class EmergencyContact(BaseModel):
    """緊急連絡先設定"""
    family_name: str = Field(default="ご家族", description="連絡先氏名")
    relationship: str = Field(default="長男", description="続柄")
    phone_number: Optional[str] = Field(default=None, description="電話番号（Twilio自動架電用）")
    line_notify_token: Optional[str] = Field(default=None, description="LINE Notify / Messaging API トークン")
    email: Optional[str] = Field(default=None, description="通知先メールアドレス")


class PartnerProfile(BaseModel):
    """AI対話パートナーのプロフィール・性格設定"""
    name: str = Field(default="さくら", description="パートナーの名前（例: さくら、けんじ）")
    age_setting: str = Field(default="30代", description="パートナーの年齢設定（例: 20代、30代、40代）")
    gender: str = Field(default="女性", description="パートナーの性別（女性 / 男性）")
    personality: str = Field(
        default="優しく穏やかで聞き上手、いつも笑顔で褒め上手",
        description="パートナーの性格・話し方の特徴"
    )
    voice_name: str = Field(
        default="Aoede",
        description="Gemini Live 音声タイプ（女性: Aoede, Kore / 男性: Puck, Charon, Fenrir）"
    )


class UserProfile(BaseModel):
    """対象者（ご本人・会話相手）およびAIパートナーの統合プロフィール"""
    user_id: str = Field(default="default_user", description="一意識別ID")
    call_name: str = Field(default="お父さん", description="AIからの呼び方・お名前")
    age_group: str = Field(default="80代", description="年齢・年代（例: 78歳、80代）")
    gender: str = Field(default="男性", description="性別（男性 / 女性 / その他）")
    personality: str = Field(
        default="温厚で家族思い、昔の仕事に誇りを持っている、少し照れ屋",
        description="ご本人の性格・人柄"
    )
    dementia_level: DementiaLevel = Field(default=DementiaLevel.MILD, description="進行度レベル")
    former_occupation: str = Field(default="小学校の先生", description="昔の仕事・得意だったこと")
    hobbies: List[str] = Field(default_factory=lambda: ["園芸", "リンゴ栽培", "将棋"], description="趣味・好きなこと")
    hometown: str = Field(default="長野県松本市", description="ゆかりの地・故郷")
    trigger_words: List[str] = Field(
        default_factory=lambda: ["リンゴ畑", "北アルプス", "紅玉", "黒板"],
        description="思い出を呼び覚ますキーワード"
    )
    ng_topics: List[str] = Field(
        default_factory=lambda: ["最近のニュース", "家族の不幸・逝去", "金銭管理", "物忘れの指摘"],
        description="絶対に触れてはいけないNG話題"
    )
    partner: PartnerProfile = Field(default_factory=PartnerProfile, description="AIパートナーの設定")
    emergency_contact: EmergencyContact = Field(default_factory=EmergencyContact, description="緊急連絡先")


class MemoryArtifact(BaseModel):
    """生成された思い出・夢の視覚化データ"""
    memory_id: str = Field(..., description="思い出一意ID")
    user_id: str = Field(default="default_user", description="ユーザーID")
    created_at: datetime = Field(default_factory=datetime.now, description="生成日時")
    scene_type: SceneType = Field(default=SceneType.PAST_MEMORY, description="思い出か夢か")
    title: str = Field(..., description="絵のタイトル（例：夕暮れの松本とリンゴ畑）")
    visual_description: str = Field(..., description="会話から抽出された情景描写")
    applied_prompt: str = Field(..., description="安全ラッパー適用後の最終画像生成プロンプト")
    media_format: MediaFormat = Field(default=MediaFormat.IMAGE, description="画像または動画")
    media_url: str = Field(..., description="生成メディアの公開パスまたはURL")
    ambient_sound_type: AmbientSoundType = Field(default=AmbientSoundType.NONE, description="連動する環境音")
    refine_history: List[str] = Field(default_factory=list, description="共同描画による修正履歴")


class DailyConditionReport(BaseModel):
    """心のコンディション日報"""
    report_id: str = Field(..., description="日報一意ID")
    user_id: str = Field(default="default_user", description="ユーザーID")
    session_date: date = Field(default_factory=date.today, description="セッション実施日")
    duration_minutes: int = Field(default=0, description="対話時間（分）")
    smile_score_summary: str = Field(default="穏やかな笑顔が多く見られました", description="笑顔度・表情の総合所見")
    topics_discussed: List[str] = Field(default_factory=list, description="盛り上がった話題・キーワード")
    generated_memory_ids: List[str] = Field(default_factory=list, description="生成された思い出ID一覧")
    caregiver_feedback_note: str = Field(default="", description="ご家族・介護者への共有メッセージ")
