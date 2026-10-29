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
    API未設定時またはクォータ制限時でも、会話テーマ（喫茶店・教室・海・桜・雪・夕焼け・山里）に応じた水彩画風イラストを動的生成・保存する
    """
    width, height = 1024, 768

    # 最新の描きたい情景を最優先でテーマ判定する
    import re
    latest_match = re.search(r"【最新の描きたい情景（最優先）】:\s*([^/]+)", elements or "")
    primary_topic = latest_match.group(1).strip() if latest_match else (title or elements or "")
    combined = f"{primary_topic} {title} {elements}"

    cafe_keywords = ["喫茶店", "カフェ", "コーヒー", "珈琲", "紅茶", "クリームソーダ", "ホットケーキ", "ナポリタン", "パフェ", "模擬店の中", "店内", "テーブル", "カップ", "茶店", "純喫茶", "お茶", "注文", "メニュー", "カウンター"]
    is_cafe = any(k in primary_topic for k in cafe_keywords) or (any(k in combined for k in cafe_keywords) and not any(k in primary_topic for k in ["校舎の外", "学校全体", "グラウンド", "校門"]))
    is_classroom = (not is_cafe) and (any(k in primary_topic for k in ["教室の中", "教室", "黒板", "机", "教壇", "授業", "窓際"]) or any(k in combined for k in ["教室の中", "黒板", "教壇"]))
    is_mountain = (not is_cafe and not is_classroom) and (
        any(k in primary_topic for k in ["山", "アルプス", "連峰", "峰", "岳", "頂", "鋭い", "尖", "険しい", "登山", "岩山", "富士山", "北アルプス", "南アルプス", "八ヶ岳", "岩峰", "稜線"]) or
        (any(k in combined for k in ["山", "アルプス", "連峰", "峰", "岳", "頂", "鋭い", "尖", "険しい", "登山", "岩山", "富士山", "岩峰", "稜線"]) and not any(k in combined for k in ["校舎", "学校", "教室", "喫茶店", "カフェ", "海"]))
    )
    is_school = (not is_cafe and not is_classroom and not is_mountain) and any(k in combined for k in ["高校", "文化祭", "学園祭", "学校", "校舎", "中学", "小学校", "先生", "生徒", "部活", "運動会", "体育祭", "青春", "合唱", "模擬店"])
    is_pet = (not is_cafe and not is_classroom and not is_mountain and not is_school) and any(k in combined for k in ["犬", "いぬ", "イヌ", "マルチーズ", "柴犬", "ポメラニアン", "プードル", "わんちゃん", "ワンちゃん", "子犬", "猫", "ねこ", "ペット", "座敷", "畳"])
    is_walk = (not is_cafe and not is_classroom and not is_mountain and not is_school and not is_pet) and any(k in combined for k in ["散歩", "歩く", "お散歩", "買い物", "お買い物", "商店街", "市場", "食材", "八百屋", "魚屋", "道端", "路地", "並木道", "遊歩道", "通り", "夕方の道", "買い物袋"])
    garden_keywords = ["庭", "庭園", "バラ", "薔薇", "バラ園", "花壇", "ガーデン", "花畑", "赤い花", "お花", "ひまわり", "チューリップ", "カーネーション", "フラワー"]
    is_garden = (not is_cafe and not is_classroom and not is_mountain and not is_school and not is_pet and not is_walk) and any(k in combined for k in garden_keywords)
    is_sea = (not is_mountain and not is_walk and not is_garden) and any(k in combined for k in ["海", "浜", "波", "砂浜", "船", "港", "沖縄", "ハワイ", "夏", "泳", "魚", "潮"])
    is_sakura = (not is_mountain and not is_walk and not is_garden) and any(k in combined for k in ["桜", "春", "花見", "ピンク"])
    is_snow = (not is_mountain and not is_walk and not is_garden) and any(k in combined for k in ["雪", "冬", "スキー", "こたつ", "正月", "北国", "白", "氷", "北海道", "新潟"])
    is_sunset = any(k in combined for k in ["夕焼け", "夕方", "夕日", "秋", "赤とんぼ", "紅葉", "もみじ", "祭り", "花火"])

    base_image = Image.new("RGB", (width, height), color=(253, 248, 242))
    draw = ImageDraw.Draw(base_image)

    if is_mountain:
        # 高山の青空
        draw.rectangle([0, 0, width, height], fill=(190, 227, 248))
        # 遠景の険しい連峰
        draw.polygon([(0, 560), (90, 310), (170, 370), (280, 230), (370, 320), (512, 130), (630, 270), (760, 170), (860, 300), (960, 210), (1024, 280), (1024, 620), (0, 620)], fill=(101, 119, 142))
        # 中景の鋭利な主峰（左：日向、右：険しい影）
        draw.polygon([(180, 590), (500, 120), (500, 590)], fill=(148, 163, 184))
        draw.polygon([(500, 120), (780, 590), (500, 590)], fill=(51, 65, 85))
        # 鋭い第二峰
        draw.polygon([(610, 580), (810, 180), (810, 580)], fill=(124, 139, 161))
        draw.polygon([(810, 180), (990, 580), (810, 580)], fill=(30, 41, 59))
        # 山頂の尖った雪渓
        draw.polygon([(500, 120), (470, 220), (490, 200), (500, 240), (520, 210), (540, 230)], fill=(255, 255, 255))
        draw.polygon([(810, 180), (785, 250), (800, 235), (810, 270), (830, 245)], fill=(255, 255, 255))
        # 麓の針葉樹林
        draw.rectangle([0, 570, width, height], fill=(30, 41, 59))
        for tx in range(15, 1010, 34):
            th = 55 + (tx % 19) * 4
            ty = 560 + (tx % 13) * 2
            draw.polygon([(tx, ty), (tx - 16, ty + th), (tx + 16, ty + th)], fill=(45, 106, 79))
    elif is_cafe:
        draw.rectangle([0, 0, width, 460], fill=(243, 229, 216))
        draw.rectangle([0, 460, width, height], fill=(176, 137, 104))
        # アーチ窓
        draw.rounded_rectangle([640, 130, 910, 410], radius=90, fill=(216, 243, 220), outline=(127, 85, 57), width=6)
        # ペンダントライト
        for lx in [320, 550]:
            draw.line([(lx, 0), (lx, 170)], fill=(92, 61, 46), width=4)
            draw.polygon([(lx - 55, 215), (lx, 165), (lx + 55, 215)], fill=(244, 162, 97))
        # 白い丸テーブルとコーヒー＆クリームソーダ
        draw.ellipse([180, 470, 820, 660], fill=(255, 253, 249), outline=(212, 163, 115), width=5)
        draw.rectangle([340, 500, 405, 555], fill=(255, 255, 255), outline=(108, 88, 76), width=3)
        draw.polygon([(580, 450), (630, 450), (620, 555), (590, 555)], fill=(82, 183, 136))
        draw.ellipse([585, 430, 625, 470], fill=(255, 250, 224))
    elif is_classroom:
        draw.rectangle([0, 0, width, 520], fill=(253, 248, 240))
        draw.rectangle([0, 520, width, height], fill=(200, 159, 120))
        draw.rectangle([180, 160, 844, 430], fill=(45, 90, 67), outline=(164, 113, 72), width=10)
    elif is_school:
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
    elif is_pet:
        # 和室・座敷の温かい光と、楽しそうに遊ぶ白いマルチーズ
        # 1. 部屋の壁と障子
        draw.rectangle([0, 0, width, 440], fill=(247, 241, 227))
        # 障子（格子の枠）
        draw.rectangle([100, 80, 520, 440], fill=(255, 253, 245), outline=(139, 94, 60), width=6)
        for gx in range(160, 520, 60):
            draw.line([(gx, 80), (gx, 440)], fill=(139, 94, 60), width=2)
        for gy in range(130, 440, 50):
            draw.line([(100, gy), (520, gy)], fill=(139, 94, 60), width=2)
        # 2. 畳（座敷）
        draw.rectangle([0, 440, width, height], fill=(197, 209, 155))
        # 畳の目・縁（へり）
        draw.line([(0, 580), (width, 580)], fill=(47, 79, 79), width=8) # 畳の縁
        for ty in [480, 530, 640, 700]:
            draw.line([(0, ty), (width, ty)], fill=(180, 192, 140), width=1)
        # 3. 座敷を元気に駆け回る白いマルチーズ
        # 体
        draw.ellipse([450, 480, 590, 570], fill=(255, 255, 255), outline=(225, 225, 225), width=2)
        # 頭
        draw.ellipse([410, 430, 490, 510], fill=(255, 255, 255), outline=(225, 225, 225), width=2)
        # 垂れたふわふわの耳
        draw.ellipse([395, 450, 425, 520], fill=(250, 245, 240))
        draw.ellipse([475, 450, 505, 520], fill=(250, 245, 240))
        # つぶらな黒い目と鼻
        draw.ellipse([430, 460, 442, 472], fill=(30, 30, 30))
        draw.ellipse([460, 460, 472, 472], fill=(30, 30, 30))
        draw.ellipse([445, 478, 457, 488], fill=(30, 30, 30))
        # ちょこんとした足
        draw.ellipse([430, 550, 460, 585], fill=(255, 255, 255))
        draw.ellipse([480, 550, 510, 585], fill=(255, 255, 255))
        draw.ellipse([540, 550, 570, 585], fill=(255, 255, 255))
        # 楽しそうなふわふわのしっぽ（上を向いている）
        draw.ellipse([570, 460, 610, 510], fill=(255, 255, 255))
        # お父さんの座布団
        draw.rounded_rectangle([720, 500, 880, 620], radius=16, fill=(158, 71, 79), outline=(120, 45, 52), width=3)
    elif is_walk:
        # 買い物帰りの散歩道・商店街・並木道
        draw.rectangle([0, 0, width, 480], fill=(219, 237, 243) if not is_sunset else (244, 162, 97))
        if is_sunset:
            draw.ellipse([700, 100, 840, 240], fill=(231, 111, 81))
        else:
            draw.ellipse([700, 90, 810, 200], fill=(255, 238, 173))
        # 遠景の家並み
        for h in range(7):
            hx = 40 + h * 140
            hy = 360 + (h % 3) * 16
            draw.rectangle([hx, hy, hx + 110, 500], fill=(188, 140, 110) if is_sunset else (156, 142, 128))
            draw.polygon([(hx - 10, hy), (hx + 55, hy - 45), (hx + 120, hy)], fill=(92, 61, 46) if is_sunset else (74, 85, 104))
            draw.rectangle([hx + 20, hy + 25, hx + 50, hy + 55], fill=(255, 227, 168) if is_sunset else (226, 241, 255))
        # 地面と散歩道
        draw.rectangle([0, 500, width, height], fill=(147, 129, 112) if is_sunset else (140, 179, 105))
        # 手前に広がる散歩道
        draw.polygon([(460, 490), (560, 490), (840, height), (300, height)], fill=(213, 189, 175) if is_sunset else (240, 235, 216))
        # レトロ木製電柱
        draw.rectangle([200, 200, 218, 580], fill=(111, 78, 55))
        draw.rectangle([160, 240, 260, 250], fill=(111, 78, 55))
        draw.line([(0, 220), (200, 245), (1024, 210)], fill=(60, 40, 30), width=2)
        # 並木
        for tx in [90, 340, 820, 940]:
            draw.rectangle([tx - 8, 430, tx + 8, 530], fill=(107, 76, 53))
            draw.ellipse([tx - 55, 340, tx + 55, 460], fill=(127, 79, 36) if is_sunset else (45, 106, 79))
        # 買い物袋（クラフト紙袋からネギ・パン）
        draw.rounded_rectangle([180, 600, 270, 710], radius=8, fill=(221, 184, 146), outline=(176, 137, 104), width=3)
        draw.polygon([(190, 600), (175, 520), (190, 515), (205, 600)], fill=(82, 183, 136)) # ネギ
        draw.polygon([(215, 600), (235, 510), (255, 518), (242, 600)], fill=(200, 159, 120)) # パン
    elif is_garden:
        # 明るい庭園と満開の赤いバラ
        draw.rectangle([0, 0, width, 480], fill=(186, 227, 247))
        # 太陽
        draw.ellipse([780, 80, 920, 220], fill=(255, 248, 200))
        # 遠景の緑の木々
        for i in range(8):
            bx = i * 140 - 30
            draw.ellipse([bx, 320, bx + 190, 520], fill=(167, 201, 87))
        # 白いウッドフェンス
        draw.rectangle([0, 420, width, 435], fill=(255, 255, 255), outline=(200, 200, 200), width=2)
        draw.rectangle([0, 465, width, 480], fill=(255, 255, 255), outline=(200, 200, 200), width=2)
        for fx in range(20, width, 70):
            draw.polygon([(fx, 500), (fx, 380), (fx + 12, 365), (fx + 24, 380), (fx + 24, 500)], fill=(255, 255, 255), outline=(190, 190, 190))
        # 芝生
        draw.rectangle([0, 480, width, height], fill=(56, 102, 65))
        # バラの茂み
        for cx in [160, 320, 520, 720, 900]:
            draw.ellipse([cx - 90, 520, cx + 90, 680], fill=(40, 54, 24))
            draw.ellipse([cx - 70, 500, cx + 70, 640], fill=(56, 102, 65))
            draw.ellipse([cx - 50, 480, cx + 50, 610], fill=(106, 153, 78))
        # 咲き誇る赤いバラ（外側の深紅、中心の鮮やかな赤、花芯）
        rose_coords = [
            (160, 480, 36), (250, 540, 30), (340, 470, 40), (440, 530, 32),
            (540, 460, 46), (640, 520, 34), (740, 470, 38), (860, 520, 32),
            (410, 600, 28), (620, 610, 30)
        ]
        for rx, ry, rr in rose_coords:
            # 葉
            draw.ellipse([rx - rr - 14, ry + 4, rx - rr + 14, ry + 22], fill=(45, 106, 79))
            draw.ellipse([rx + rr - 14, ry + 4, rx + rr + 14, ry + 22], fill=(45, 106, 79))
            # 外側の深紅
            draw.ellipse([rx - rr, ry - rr, rx + rr, ry + rr], fill=(155, 17, 30))
            # 内側の赤
            draw.ellipse([rx - int(rr * 0.7), ry - int(rr * 0.7), rx + int(rr * 0.7), ry + int(rr * 0.7)], fill=(217, 4, 41))
            # 花芯
            draw.ellipse([rx - int(rr * 0.35), ry - int(rr * 0.35), rx + int(rr * 0.35), ry + int(rr * 0.35)], fill=(239, 35, 60))
            draw.ellipse([rx - 4, ry - 4, rx + 4, ry + 4], fill=(255, 117, 143))
        # 風に舞う花びら
        for i in range(25):
            px = (i * 41 + 60) % 980
            py = 180 + (i * 29) % 450
            draw.ellipse([px, py, px + 14, py + 8], fill=(239, 35, 60))
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
    font_small = get_japanese_font(13)

    badge_x, badge_y = 40, 40
    badge_w, badge_h = 520, 96
    draw.rounded_rectangle(
        [badge_x, badge_y, badge_x + badge_w, badge_y + badge_h],
        radius=12,
        fill=(255, 255, 255, 240),
        outline=(245, 158, 11),
        width=2
    )

    clean_title = title.replace("\n", " ")
    if len(clean_title) > 18:
        clean_title = clean_title[:17] + "…"

    draw.text((badge_x + 16, badge_y + 10), "🎨 おもいでキャンバス（※簡易水彩画・制限中）", fill=(217, 119, 6), font=font_sub)
    draw.text((badge_x + 16, badge_y + 36), clean_title, fill=(44, 94, 79), font=font_title)
    draw.text((badge_x + 16, badge_y + 70), "※AIクォータ制限のため簡易イラストです。会話内容と異なる場合があります。", fill=(180, 83, 9), font=font_small)

    base_image.save(file_path, "PNG")
    logger.info(f"Dynamic theme watercolor image generated for '{title}' at {file_path}")


def sanitize_scene_elements(title: str, elements: str) -> Tuple[str, str]:
    """
    挨拶やマイクテストなどのノイズ単語を除去し、絵画にふさわしい情景タイトルと要素に整形する
    """
    noise_patterns = [
        "聞こえてますか", "聞こえますか", "聞こえる", "もしもし", "あーあー", "テスト",
        "マイク", "こんにちは", "こんばんは", "おはよう", "ありがとう", "はい", "いいえ"
    ]
    clean_title = title
    for p in noise_patterns:
        clean_title = clean_title.replace(p, "")
    clean_title = clean_title.strip(" 、。？！!?")
    if not clean_title or len(clean_title) < 2:
        clean_title = "懐かしい思い出の情景"

    clean_elements = elements
    for p in noise_patterns:
        clean_elements = clean_elements.replace(p, "")
    clean_elements = clean_elements.strip(" 、。？！!?")
    if not clean_elements or len(clean_elements) < 3:
        clean_elements = f"{clean_title}、心温まる水彩画の風景"

    return clean_title, clean_elements


def generate_memory_visual_artifact_sync(
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
    情景から安全プロンプトを構築し、Imagen 3 / Gemini 3.8 Flash SVG / 水彩フォールバックで生成して保存する（同期実行版）。
    メインの asyncio イベントループを止めないよう、asyncio.to_thread から呼び出される。
    """
    import re
    clean_title, clean_elements = sanitize_scene_elements(japanese_title, visual_elements)
    memory_id = str(uuid.uuid4())[:8]
    final_prompt = build_safe_prompt(dementia_level, scene_type, clean_elements, media_format)

    file_name = f"{memory_id}.png"
    file_path = MEDIA_DIR / file_name
    effective_api_key = (api_key or "").strip()

    logger.info(f"Generating visual artifact (sync): {clean_title} (ID: {memory_id})")
    logger.info(f"Applied Prompt: {final_prompt}")

    image_generated = False
    is_fallback = False
    if effective_api_key and effective_api_key != "your_gemini_api_key_here":
        try:
            client = genai.Client(api_key=effective_api_key)

            # 1. Flash Image (gemini-2.5-flash-image) を試行
            try:
                nb_res = client.models.generate_content(
                    model="gemini-2.5-flash-image",
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
                            is_fallback = False
                            logger.info(f"Flash Image generation succeeded: {file_path}")
                            break
            except Exception as nb_err:
                logger.warning(f"Flash Image skipped ({nb_err}). Proceeding to Gemini 3.8 Flash SVG generation.")

            # 2. オーダーメイドSVG水彩画生成（503高負荷・クォータ制限時も即座に代替する多段モデルフォールバック）
            if not image_generated:
                svg_prompt = f"""あなたはプロの情景水彩画・童話イラストの画家です。高齢者・回想法ケアのため、ユーザーが語った思い出やお話に合わせて、指定された情景のSVGイラスト（viewBox="0 0 800 600"）を1枚描いてください。

【描く情景・ユーザーの言葉（最優先遵守）】:
{clean_elements}

【最重要造形ルール】
1. ユーザーがお話しした具体的なモチーフ・特徴・造形（山、夕焼け、海、学校、教室、喫茶店、花、木製テーブル、窓、雪、川など）を100%忠実に描いてください。
   - 山について語られている場合：鋭角な三角形・ギザギザの険しい岩峰・切り立った山頂・陰影・雪渓をシャープなポリゴンやパス（<polygon>, <path>）でダイナミックに描いてください！
   - 庭やバラについて語られている場合：青空、木漏れ日、緑の芝生、白いウッドフェンス、鮮やかな真紅のバラ（立体的な花びら・蕾・葉）を豊かに描いてください！
   - 喫茶店や店内について語られている場合：木目テーブル、コーヒー、クリームソーダ、ペンダントライト、窓などを描いてください。
   - 学校や教室、海、季節など、会話に出てきた情景を主役として具体的に配置してください。
2. 背景には美しいグラデーション（<linearGradient>, <radialGradient>）を使い、温かく情緒的な水彩画の雰囲気にしてください。
3. 人物のリアルな顔は描かず、後ろ姿や遠景、あるいは情景・静物を美しく描いてください。
4. <svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg"> で始まり </svg> で終わる完全なSVGコードのみを出力してください。余計な解説文やマークダウン枠（```xml 等）は一切含めないでください。"""

                candidate_svg_models = ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.8-flash"]
                for model_candidate in candidate_svg_models:
                    try:
                        logger.info(f"Attempting SVG generation with {model_candidate} for '{clean_title}'...")
                        svg_res = client.models.generate_content(
                            model=model_candidate,
                            contents=svg_prompt,
                            config=types.GenerateContentConfig(
                                temperature=0.3,
                                max_output_tokens=6000
                            )
                        )
                        if svg_res and svg_res.text:
                            raw_text = svg_res.text
                            svg_match = re.search(r"<svg[\s\S]*?</svg>", raw_text, re.IGNORECASE)
                            if not svg_match and "<svg" in raw_text:
                                start_idx = raw_text.find("<svg")
                                svg_match = re.search(r"<svg[\s\S]*", raw_text)
                                if svg_match:
                                    repaired_svg = svg_match.group(0) + "\n</svg>"
                                    svg_name = f"{memory_id}.svg"
                                    svg_path = MEDIA_DIR / svg_name
                                    with open(svg_path, "w", encoding="utf-8") as f:
                                        f.write(repaired_svg)
                                    file_name = svg_name
                                    image_generated = True
                                    is_fallback = False
                                    logger.info(f"SVG generation succeeded (repaired) with {model_candidate}: {svg_path}")
                                    break
                            elif svg_match:
                                svg_name = f"{memory_id}.svg"
                                svg_path = MEDIA_DIR / svg_name
                                with open(svg_path, "w", encoding="utf-8") as f:
                                    f.write(svg_match.group(0))
                                file_name = svg_name
                                image_generated = True
                                is_fallback = False
                                logger.info(f"SVG generation succeeded with {model_candidate}: {svg_path}")
                                break
                    except Exception as svg_err:
                        logger.warning(f"SVG generation with {model_candidate} failed: {svg_err}. Trying next model...")
        except Exception as client_err:
            logger.warning(f"GenAI Client setup or generation error: {client_err}")

    if not image_generated:
        generate_fallback_image(clean_title, file_path, clean_elements)
        is_fallback = True

    artifact = MemoryArtifact(
        memory_id=memory_id,
        user_id=user_id,
        created_at=datetime.now(),
        scene_type=scene_type,
        title=clean_title,
        visual_description=clean_elements,
        applied_prompt=final_prompt,
        media_format=media_format,
        media_url=f"/static/memories/{file_name}",
        ambient_sound_type=ambient_sound,
        refine_history=[],
        is_fallback=is_fallback
    )

    # メタデータ保存
    meta_path = MEDIA_DIR / f"{memory_id}.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(artifact.model_dump(mode="json"), f, ensure_ascii=False, indent=2)

    return artifact


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
    非同期ラッパー関数（内部で asyncio.to_thread を使用してブロッキングを完全排除）
    """
    import asyncio
    return await asyncio.to_thread(
        generate_memory_visual_artifact_sync,
        user_id=user_id,
        dementia_level=dementia_level,
        scene_type=scene_type,
        japanese_title=japanese_title,
        visual_elements=visual_elements,
        media_format=media_format,
        ambient_sound=ambient_sound,
        api_key=api_key
    )


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
