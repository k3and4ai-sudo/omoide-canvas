"""
メディア生成 ＆ 医療安全ラッパーモジュール (backend/media_generator.py)
仕様書 4.3 〜 4.4 に基づき、安全フィルタを適用して Imagen 3 / Veo で画像を非同期生成
"""

import os
import uuid
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple
from PIL import Image, ImageDraw, ImageFont

from google import genai
from google.genai import types

from backend.models import (
    DementiaLevel,
    SceneType,
    MediaFormat,
    AmbientSoundType,
    MemoryArtifact
)

logger = logging.getLogger(__name__)

# 保存ディレクトリ
MEDIA_DIR = Path("static/memories")
MEDIA_DIR.mkdir(parents=True, exist_ok=True)


def build_safe_prompt(
    dementia_level: DementiaLevel,
    scene_type: SceneType,
    visual_elements: str,
    media_format: MediaFormat = MediaFormat.IMAGE
) -> str:
    """
    医療安全ガードレール（テレビサイン・幻覚防止）に基づくプロンプトラッパー
    Final Prompt = P_style(level) + P_era(scene_type) + visual_elements + P_safety_negative
    """
    # 1. P_style (画風プレフィックス)
    if dementia_level in (DementiaLevel.MILD, DementiaLevel.MODERATE):
        p_style = "A warm, nostalgic, gentle watercolor and colored pencil storybook illustration, soft pastel tones, cozy lighting. "
    else:  # MCI
        p_style = "A gentle, nostalgic retro fine-art painting style, soft warm colors. "

    # 2. P_era (時代背景)
    if scene_type == SceneType.PAST_MEMORY:
        p_era = "Set in nostalgic 1950s-1970s Showa-era Japan. "
    else:  # FUTURE_DREAM
        p_era = "A peaceful, dreamy, and bright atmosphere. "

    # 3. P_safety_negative (安全制約サフィックス)
    p_safety_negative = (
        " Do NOT render photorealistic human faces. Depict any human figures strictly from behind, "
        "at a far distance, or as soft storybook silhouettes. No modern skyscrapers, no smartphones, "
        "no dark scary shadows, no sharp contrasts, no text or watermarks."
    )

    if media_format == MediaFormat.VIDEO:
        p_safety_negative += (
            " Fixed static tripod camera shot, cinemagraph style, peaceful and extremely subtle "
            "slow-motion movements (e.g. gentle breeze through tree leaves, soft ripples on a pond). "
            "No camera zoom, no panning, no fast motions."
        )

    final_prompt = f"{p_style}{p_era}{visual_elements.strip()}{p_safety_negative}"
    return final_prompt


def get_japanese_font(size: int = 28) -> ImageFont.ImageFont:
    """Ubuntu Linux上の日本語フォントを自動検出してロード"""
    font_candidates = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc",
        "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    ]
    for p in font_candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def generate_fallback_image(title: str, file_path: Path, elements: str = "") -> None:
    """
    API未設定時またはクォータ制限時でも、会話テーマ（海・桜・雪・夕焼け・山里）に応じた水彩画風イラストを動的生成・保存する
    """
    width, height = 1024, 768
    combined = f"{title} {elements}"
    is_school = any(k in combined for k in ["高校", "文化祭", "学園祭", "学校", "教室", "黒板", "校舎", "中学", "小学校", "先生", "生徒", "部活", "運動会", "体育祭", "青春", "合唱", "模擬店"])
    is_sea = any(k in combined for k in ["海", "浜", "波", "砂浜", "船", "港", "沖縄", "ハワイ", "夏", "泳", "魚", "潮"])
    is_sakura = any(k in combined for k in ["桜", "春", "花", "菜の花", "入学", "卒業", "ピンク", "花見", "公園", "庭"])
    is_snow = any(k in combined for k in ["雪", "冬", "スキー", "こたつ", "正月", "北国", "白", "氷", "北海道", "新潟"])
    is_sunset = any(k in combined for k in ["夕焼け", "夕方", "夕日", "秋", "赤とんぼ", "紅葉", "もみじ", "祭り", "花火"])

    base_image = Image.new("RGB", (width, height), color=(253, 248, 242))
    draw = ImageDraw.Draw(base_image)

    if is_school:
        draw.rectangle([0, 0, width, 490], fill=(255, 243, 214))
        draw.rectangle([0, 490, width, height], fill=(230, 204, 178))
        # 校舎本体と屋根
        draw.rectangle([180, 260, 844, 490], fill=(250, 240, 202), outline=(188, 108, 37), width=4)
        draw.polygon([(150, 260), (512, 175), (874, 260)], fill=(214, 104, 83))
        # 窓
        for r in range(2):
            for c in range(6):
                wx = 220 + c * 98
                wy = 290 + r * 90
                draw.rectangle([wx, wy, wx + 60, wy + 55], fill=(168, 218, 220), outline=(188, 108, 37), width=2)
        # 万国旗
        flag_colors = [(224, 122, 95), (244, 162, 97), (129, 178, 154), (69, 123, 157), (233, 196, 106)]
        for i in range(14):
            fx = 80 + i * 64
            fy = 160 + (i % 3) * 14
            draw.polygon([(fx, fy), (fx + 34, fy + 8), (fx + 16, fy + 36)], fill=flag_colors[i % 5])
    elif is_sea:
        draw.rectangle([0, 0, width, 420], fill=(168, 218, 220))
        draw.ellipse([740, 80, 860, 200], fill=(255, 243, 176))
        draw.rectangle([0, 420, width, 640], fill=(69, 123, 157))
        draw.rectangle([0, 640, width, height], fill=(244, 228, 193))
        draw.polygon([(300, 410), (300, 290), (370, 395)], fill=(255, 255, 255))
    elif is_sakura:
        draw.rectangle([0, 0, width, 440], fill=(253, 226, 228))
        draw.polygon([(0, 460), (280, 250), (580, 460)], fill=(149, 184, 166))
        draw.polygon([(400, 460), (720, 230), (1024, 460)], fill=(129, 178, 154))
        draw.rectangle([0, 460, width, height], fill=(205, 234, 192))
        for i in range(45):
            px = (i * 113 + 60) % 960
            py = (i * 71 + 40) % 420
            draw.ellipse([px, py, px + 16, py + 16], fill=(255, 183, 197))
    elif is_snow:
        draw.rectangle([0, 0, width, 460], fill=(207, 217, 223))
        draw.polygon([(0, 460), (280, 240), (580, 460)], fill=(184, 201, 217))
        draw.polygon([(380, 460), (700, 210), (1024, 460)], fill=(159, 180, 199))
        draw.rectangle([0, 460, width, height], fill=(248, 250, 252))
        for i in range(60):
            px = (i * 97 + 30) % 980
            py = (i * 67 + 20) % 720
            draw.ellipse([px, py, px + 10, py + 10], fill=(255, 255, 255))
    elif is_sunset:
        draw.rectangle([0, 0, width, 450], fill=(244, 162, 97))
        draw.ellipse([720, 140, 860, 280], fill=(231, 111, 81))
        draw.polygon([(0, 450), (280, 250), (580, 450)], fill=(109, 89, 122))
        draw.polygon([(380, 450), (700, 220), (1024, 450)], fill=(86, 71, 102))
        draw.rectangle([0, 450, width, height], fill=(132, 165, 157))
    else:
        draw.rectangle([0, 0, width, 440], fill=(245, 230, 215))
        draw.ellipse([740, 90, 850, 200], fill=(255, 238, 173))
        draw.polygon([(0, 440), (260, 230), (540, 440)], fill=(129, 178, 154))
        draw.polygon([(360, 450), (680, 200), (1024, 450)], fill=(100, 150, 130))
        draw.rectangle([0, 440, width, height], fill=(207, 225, 185))

    # 左上に上品な和紙風短冊（タイトル札）を合成
    font_title = get_japanese_font(26)
    font_sub = get_japanese_font(16)

    badge_x, badge_y = 40, 40
    badge_w, badge_h = 440, 84
    draw.rounded_rectangle(
        [badge_x, badge_y, badge_x + badge_w, badge_y + badge_h],
        radius=12,
        fill=(255, 255, 255, 235),
        outline=(224, 122, 95),
        width=2
    )

    clean_title = title.replace("\n", " ")
    if len(clean_title) > 18:
        clean_title = clean_title[:17] + "…"

    draw.text((badge_x + 16, badge_y + 12), "🎨 おもいでキャンバス 水彩画", fill=(224, 122, 95), font=font_sub)
    draw.text((badge_x + 16, badge_y + 38), clean_title, fill=(44, 94, 79), font=font_title)

    base_image.save(file_path, "PNG")
    logger.info(f"Dynamic theme watercolor image generated for '{title}' at {file_path}")


async def generate_memory_visual_artifact(
    user_id: str,
    dementia_level: DementiaLevel,
    scene_type: SceneType,
    japanese_title: str,
    visual_elements: str,
    media_format: MediaFormat = MediaFormat.IMAGE,
    ambient_sound: AmbientSoundType = AmbientSoundType.NONE,
    api_key: Optional[str] = None
) -> MemoryArtifact:
    """
    情景から安全プロンプトを構築し、Imagen 3 (または Veo) で非同期生成して保存する。
    セッションで入力された api_key を優先使用する。
    """
    memory_id = str(uuid.uuid4())[:8]
    final_prompt = build_safe_prompt(dementia_level, scene_type, visual_elements, media_format)

    file_name = f"{memory_id}.png"
    file_path = MEDIA_DIR / file_name
    effective_api_key = (api_key or "").strip()

    logger.info(f"Generating visual artifact: {japanese_title} (ID: {memory_id})")
    logger.info(f"Applied Prompt: {final_prompt}")

    image_generated = False
    if effective_api_key and effective_api_key != "your_gemini_api_key_here":
        client = genai.Client(api_key=effective_api_key)

        # 1. Nano Banana 系 (Gemini Flash Image: gemini-2.5-flash-image / gemini-2.0-flash-exp-image-generation) を試行
        nano_banana_models = [
            "gemini-2.5-flash-image",
            "gemini-2.0-flash-exp-image-generation",
        ]
        for nb_model in nano_banana_models:
            if image_generated:
                break
            try:
                nb_res = client.models.generate_content(
                    model=nb_model,
                    contents=final_prompt,
                    config=types.GenerateContentConfig(
                        response_modalities=["TEXT", "IMAGE"]
                    ),
                )
                if nb_res and nb_res.candidates:
                    parts = nb_res.candidates[0].content.parts or []
                    for part in parts:
                        if part.inline_data and part.inline_data.data:
                            with open(file_path, "wb") as f:
                                f.write(part.inline_data.data)
                            image_generated = True
                            logger.info(f"Nano Banana ({nb_model}) generation succeeded: {file_path}")
                            break
            except Exception as nb_err:
                logger.warning(f"Nano Banana ({nb_model}) skipped: {nb_err}")

        # 2. Imagen 3 画像生成を試行
        if not image_generated:
            try:
                result = client.models.generate_images(
                    model="imagen-3.0-generate-002",
                    prompt=final_prompt,
                    config=types.GenerateImagesConfig(
                        number_of_images=1,
                        aspect_ratio="4:3",
                        output_mime_type="image/png",
                    ),
                )
                if result and result.generated_images:
                    generated_image = result.generated_images[0]
                    with open(file_path, "wb") as f:
                        f.write(generated_image.image.image_bytes)
                    image_generated = True
                    logger.info(f"Imagen 3 generation succeeded: {file_path}")
            except Exception as e:
                logger.error(f"Imagen 3 generation failed ({e}).")

    if not image_generated:
        generate_fallback_image(japanese_title, file_path, visual_elements)

    artifact = MemoryArtifact(
        memory_id=memory_id,
        user_id=user_id,
        created_at=datetime.now(),
        scene_type=scene_type,
        title=japanese_title,
        visual_description=visual_elements,
        applied_prompt=final_prompt,
        media_format=media_format,
        media_url=f"/static/memories/{file_name}",
        ambient_sound_type=ambient_sound,
        refine_history=[]
    )

    # メタデータ保存
    meta_path = MEDIA_DIR / f"{memory_id}.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(artifact.model_dump(mode="json"), f, ensure_ascii=False, indent=2)

    return artifact


async def refine_memory_visual_artifact(
    original_memory_id: str,
    user_feedback: str,
    updated_visual_elements: str,
    dementia_level: DementiaLevel = DementiaLevel.MILD,
    api_key: Optional[str] = None
) -> Optional[MemoryArtifact]:
    """
    対象者からの修正希望（共同描画）を反映して絵を再描画する。
    """
    meta_path = MEDIA_DIR / f"{original_memory_id}.json"
    if not meta_path.exists():
        logger.warning(f"Original memory {original_memory_id} not found.")
        return None

    with open(meta_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # 更新版プロンプト作成
    new_visual_elements = f"{data['visual_description']}, updated with detail: {updated_visual_elements}"
    new_artifact = await generate_memory_visual_artifact(
        user_id=data.get("user_id", "default_user"),
        dementia_level=dementia_level,
        scene_type=SceneType(data.get("scene_type", SceneType.PAST_MEMORY)),
        japanese_title=f"{data['title']} (修正版)",
        visual_elements=new_visual_elements,
        media_format=MediaFormat(data.get("media_format", MediaFormat.IMAGE)),
        ambient_sound=AmbientSoundType(data.get("ambient_sound_type", AmbientSoundType.NONE)),
        api_key=api_key
    )

    # 履歴引き継ぎ
    new_artifact.refine_history = data.get("refine_history", []) + [user_feedback]
    with open(MEDIA_DIR / f"{new_artifact.memory_id}.json", "w", encoding="utf-8") as f:
        json.dump(new_artifact.model_dump(mode="json"), f, ensure_ascii=False, indent=2)

    return new_artifact
