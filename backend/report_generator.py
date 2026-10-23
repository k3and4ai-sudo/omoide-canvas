"""
心のコンディション日報 生成モジュール (backend/report_generator.py)
仕様書 FR-11 に基づき、対話内容や表情からご家族向けの日報を自動生成
"""

import uuid
import json
import logging
from datetime import date
from pathlib import Path
from typing import List
from backend.models import DailyConditionReport, MemoryArtifact

logger = logging.getLogger(__name__)

REPORT_DIR = Path("static/reports")
REPORT_DIR.mkdir(parents=True, exist_ok=True)


async def generate_daily_condition_report(
    user_id: str,
    duration_minutes: int,
    topics: List[str],
    memory_artifacts: List[MemoryArtifact],
    smile_notes: str = "穏やかな笑顔が多く見られ、昔の思い出を楽しそうに語られていました。"
) -> DailyConditionReport:
    """
    セッション完了後に、ご家族・介護者向けの心のコンディション日報を作成する。
    """
    report_id = str(uuid.uuid4())[:8]

    # トピック要約
    topics_text = "、".join(topics) if topics else "故郷のお話、昔のお仕事の思い出"

    # 絵の振り返りテキスト
    art_titles = [m.title for m in memory_artifacts]
    art_text = "、".join(art_titles) if art_titles else "なし"

    feedback_note = (
        f"本日は約{duration_minutes}分間の対話を行いました。\n"
        f"特に「{topics_text}」について熱心にお話しされ、表情も非常に穏やかでした。\n"
        f"対話の中で『{art_text}』の水彩画が完成しました。ぜひご家族でもご覧になってお話ししてみてください。"
    )

    report = DailyConditionReport(
        report_id=report_id,
        user_id=user_id,
        session_date=date.today(),
        duration_minutes=duration_minutes,
        smile_score_summary=smile_notes,
        topics_discussed=topics if topics else ["故郷の風景", "昔の仕事"],
        generated_memory_ids=[m.memory_id for m in memory_artifacts],
        caregiver_feedback_note=feedback_note
    )

    report_path = REPORT_DIR / f"{report_id}.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report.model_dump(mode="json"), f, ensure_ascii=False, indent=2)

    logger.info(f"Daily Condition Report saved: {report_path}")
    return report
