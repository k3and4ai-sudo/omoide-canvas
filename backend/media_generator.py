"""
メディア生成 ＆ 医療安全ラッパーモジュール (backend/media_generator.py)
仕様書 4.3 〜 4.4 に基づき、安全フィルタを適用して Imagen 3 / Veo で画像を非同期生成
"""

import os
import uuid
import json
import logging
import re
import concurrent.futures
import xml.etree.ElementTree as ET
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
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

# 保存ディレクトリ
MEDIA_DIR = Path("static/memories")
MEDIA_DIR.mkdir(parents=True, exist_ok=True)


def build_safe_prompt(
    dementia_level: DementiaLevel,
    scene_type: SceneType,
    visual_elements: str,
    media_format: MediaFormat = MediaFormat.IMAGE,
    art_style: str = "watercolor"
) -> str:
    """
    医療安全ガードレール（テレビサイン・幻覚防止）に基づくプロンプトラッパー
    Final Prompt = P_style(style, level) + P_era(scene_type) + visual_elements + P_safety_negative
    """
    # 1. P_style (画風プレフィックス)
    if art_style == "realistic":
        p_style = "A highly realistic and detailed fine art painting with photographic realism, lifelike natural lighting, sharp focus, rich depth of field, authentic textures. "
    elif art_style == "oil_painting":
        p_style = "A classic, richly textured oil painting, impressionist brushstrokes, deep vibrant colors, classical chiaroscuro lighting. "
    elif art_style == "colored_pencil":
        p_style = "A delicate hand-drawn colored pencil sketch, soft hatching lines, natural paper texture, warm and intimate. "
    else:  # watercolor
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
        " Do NOT render photorealistic human faces. No modern skyscrapers, no smartphones, "
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


def repair_and_validate_svg(raw_svg: str) -> Optional[str]:
    """
    Geminiが生成したSVGの構文（未クローズタグ、viewBox、xmlns、幅・高さ）を自動修復し、
    ブラウザの <img> およびインラインDOMで確実にレンダリングできる整形式(Well-formed) XMLを保証する。
    """
    if not raw_svg or "<svg" not in raw_svg:
        return None

    # <svg より前の不要な文字列・解説文をトリミング
    start_pos = raw_svg.find("<svg")
    svg_part = raw_svg[start_pos:]

    # ルート <svg> タグの属性（viewBox, xmlns, width, height）を正規化
    svg_tag_match = re.search(r"<svg[^>]*>", svg_part)
    if not svg_tag_match:
        return None

    old_tag = svg_tag_match.group(0)
    attrs = {}
    if "viewBox=" not in old_tag:
        attrs["viewBox"] = '"0 0 800 600"'
    if "xmlns=" not in old_tag:
        attrs["xmlns"] = '"http://www.w3.org/2000/svg"'
    if "width=" not in old_tag:
        attrs["width"] = '"800"'
    if "height=" not in old_tag:
        attrs["height"] = '"600"'

    new_tag = old_tag[:-1]
    for k, v in attrs.items():
        new_tag += f" {k}={v}"
    new_tag += ">"
    svg_part = new_tag + svg_part[len(old_tag):]

    # 最後の完全なタグ（>）以降の途切れた不完全文字列やマークダウン記号（```）を確実にカット
    last_gt = svg_part.rfind(">")
    if last_gt != -1:
        svg_part = svg_part[:last_gt + 1]

    # 一旦末尾の </svg> を除去し、開いたタグのスタックを解析して未クローズの親タグをすべて逆順に補完
    svg_body = re.sub(r"</svg\s*>", "", svg_part, flags=re.IGNORECASE)

    tag_regex = re.compile(r"<(/?)(\w+)([^>]*)>")
    stack = []
    # 自己完結型（単独で完結し終了タグ不要な要素）
    self_closing_tags = {
        "circle", "ellipse", "line", "path", "polygon", "polyline",
        "rect", "stop", "use", "image", "feturbulence", "fedisplacementmap",
        "fegaussianblur", "feoffset", "feblend", "fecolormatrix", "fecomposite",
        "feflood", "femergenode"
    }

    for match in tag_regex.finditer(svg_body):
        is_closing = bool(match.group(1))
        tag_name = match.group(2).lower()
        full_tag = match.group(0)
        is_self_closing = full_tag.endswith("/>") or tag_name in self_closing_tags

        if is_closing:
            if stack and stack[-1] == tag_name:
                stack.pop()
            elif tag_name in stack:
                while stack and stack[-1] != tag_name:
                    stack.pop()
                if stack:
                    stack.pop()
        elif not is_self_closing:
            stack.append(tag_name)

    closing_tags = []
    while stack:
        t = stack.pop()
        if t != "svg":
            closing_tags.append(f"</{t}>")

    repaired = svg_body + "\n" + "\n".join(closing_tags) + "\n</svg>"

    # xml.etree.ElementTree による整形式パース検証
    try:
        ET.fromstring(repaired)
        return repaired
    except Exception as e:
        logger.warning(f"SVG XML parsing failed after auto-repair: {e}")
        # 二次修復：途中で途切れた最後の要素をさらに1階層巻き戻して再検証
        try:
            prev_gt = svg_body.rfind("<", 0, svg_body.rfind(">"))
            if prev_gt > start_pos:
                fallback_body = svg_body[:prev_gt]
                fallback_repaired = fallback_body + "\n" + "\n".join(closing_tags) + "\n</svg>"
                ET.fromstring(fallback_repaired)
                logger.info("SVG XML parsing succeeded via secondary rollback auto-repair!")
                return fallback_repaired
        except Exception:
            pass
        return None


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

    clean_elements_list = []
    if isinstance(elements, list):
        for elem in elements:
            e = str(elem)
            for p in noise_patterns:
                e = e.replace(p, "")
            e = e.strip(" 、。？！!?")
            if e and len(e) >= 2:
                clean_elements_list.append(e)
        clean_elements = "、".join(clean_elements_list)
    else:
        clean_elements = str(elements)
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
    api_key: Optional[str] = None,
    art_style: str = "watercolor"
) -> MemoryArtifact:
    """
    情景から安全プロンプトを構築し、Imagen 3 / Gemini 3.8 Flash SVG / 水彩フォールバックで生成して保存する（同期実行版）。
    メインの asyncio イベントループを止めないよう、asyncio.to_thread から呼び出される。
    """
    import re
    clean_title, clean_elements = sanitize_scene_elements(japanese_title, visual_elements)
    memory_id = str(uuid.uuid4())[:8]
    final_prompt = build_safe_prompt(dementia_level, scene_type, clean_elements, media_format, art_style=art_style)

    file_name = f"{memory_id}.png"
    file_path = MEDIA_DIR / file_name
    effective_api_key = (api_key or os.environ.get("GEMINI_API_KEY") or "").strip()

    logger.info(f"Generating visual artifact (sync): {clean_title} (ID: {memory_id})")
    logger.info(f"Applied Prompt: {final_prompt}")

    image_generated = False
    is_fallback = False
    model_attempts = []
    used_model_name = ""

    if effective_api_key and effective_api_key != "your_gemini_api_key_here":
        try:
            client = genai.Client(api_key=effective_api_key)

            # 1. Flash Image (gemini-2.5-flash-image) を試行
            try:
                logger.info("Attempting Image generation with gemini-2.5-flash-image...")
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
                            used_model_name = "gemini-2.5-flash-image"
                            model_attempts.append("✅ gemini-2.5-flash-image: 画像生成成功")
                            logger.info(f"Flash Image generation succeeded: {file_path}")
                            break
            except Exception as nb_err:
                err_str = str(nb_err)
                if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
                    model_attempts.append("❌ gemini-2.5-flash-image: 429 クォータ超過（Free Tier 日次上限到達 / 本日17:00リセット予定）")
                else:
                    model_attempts.append(f"❌ gemini-2.5-flash-image: エラー ({err_str[:60]})")
                logger.warning(f"Flash Image skipped ({nb_err}). Proceeding to Gemini 3.8 Flash SVG generation.")

            # 2. オーダーメイドSVG情景画生成（水彩・リアル・油絵・色鉛筆に対応）
            if not image_generated:
                style_desc = "写実的でリアルな情景（精密な光と影、被写界深度、立体感）" if art_style == "realistic" else (
                    "重厚な油絵風（力強い筆跡、深い陰影）" if art_style == "oil_painting" else (
                        "素朴で繊細な色鉛筆スケッチ風" if art_style == "colored_pencil" else "温かい水彩画風"
                    )
                )
                svg_prompt = f"""あなたは高齢者・回想法ケアのための情景画専門アーティストです。ユーザーが語った思い出やお話に合わせて、指定された情景の【{style_desc}】SVGイラスト（viewBox="0 0 800 600"）を1枚描いてください。

【描く情景・ユーザーの言葉（最優先遵守）】:
{clean_elements}

【画風方針】:
{style_desc}。モチーフの質感、奥行き、光と影のグラデーションや細部の描き込みを豊かに、丁寧かつ緻密に表現してください。

【最重要造形ルール】
1. ユーザーがお話しした具体的なモチーフ・特徴・造形（山、夕焼け、海、学校、校門、並木道、教室、喫茶店、花、木製テーブル、窓、雪、川など）を100%忠実に、細部まで丁寧に描き込んでください。
   - 建物・校門・並木道について語られている場合：レンガや木目の質感、屋根瓦や窓枠、木々の枝葉や木漏れ日、地面の陰影や落ち葉まで細かく表現してください。
   - 山について語られている場合：鋭角な三角形・ギザギザの険しい岩峰・切り立った山頂・陰影・雪渓をシャープなポリゴンやパス（<polygon>, <path>）でダイナミックに描いてください。
   - 庭やバラについて語られている場合：青空、木漏れ日、緑の芝生、白いウッドフェンス、鮮やかな真紅のバラ（立体的な花びら・蕾・葉）を豊かに描いてください。
   - 喫茶店や店内について語られている場合：木目テーブル、コーヒー、クリームソーダ、ペンダントライト、窓などを描いてください。
2. 背景やモチーフにはグラデーション（<linearGradient>, <radialGradient>）や柔らかいフィルターを効果的に使い、立体感と深みを与えてください。
3. 【人物・にぎわいの描写ルール】情景に「生徒」「友達」「人」「大勢」などの人物が含まれる場合は、背景だけで終わらせず、必ず前景〜中景の道や校門・広場に【複数の人物（大勢なら8〜15人以上）】を後ろ姿・横向き・遠景の温かいイラスト調ではっきり大きく描いてください（制服・カバン・歩いている動き等も表現し、1つの `<g id="people-layer">` にまとめて描くと簡潔です）。
4. <svg width="800" height="600" viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg"> で始まり </svg> で終わる完全な整形式SVGコードのみを出力してください。余計な解説文やマークダウン枠（```xml 等）は一切含めないでください。"""

                candidate_svg_models = [
                    "gemini-3.5-flash",       # 高精細・緻密な描画を最優先
                    "gemini-3.5-flash-lite"   # フォールバック
                ]
                for model_candidate in candidate_svg_models:
                    executor = None
                    try:
                        logger.info(f"Attempting SVG generation with {model_candidate} for '{clean_title}' (max 180s timeout)...")

                        def _call_model(target_model=model_candidate):
                            return client.models.generate_content(
                                model=target_model,
                                contents=svg_prompt,
                                config=types.GenerateContentConfig(
                                    temperature=0.3,
                                    max_output_tokens=16384
                                )
                            )

                        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
                        future = executor.submit(_call_model)
                        try:
                            svg_res = future.result(timeout=180.0)
                        except concurrent.futures.TimeoutError:
                            model_attempts.append(f"⏱️ {model_candidate}: 180秒タイムアウト（Googleサーバー応答遅延）")
                            logger.warning(f"SVG generation with {model_candidate} timed out after 180s. Trying next model...")
                            if executor:
                                executor.shutdown(wait=False, cancel_futures=True)
                            continue

                        if svg_res and svg_res.text:
                            raw_text = svg_res.text
                            # 構文修復 & 整形式XMLバリデーションを実行
                            valid_svg = repair_and_validate_svg(raw_text)
                            if valid_svg:
                                svg_name = f"{memory_id}.svg"
                                svg_path = MEDIA_DIR / svg_name
                                with open(svg_path, "w", encoding="utf-8") as f:
                                    f.write(valid_svg)
                                file_name = svg_name
                                image_generated = True
                                is_fallback = False
                                used_model_name = model_candidate
                                model_attempts.append(f"✅ {model_candidate}: SVG生成成功")
                                logger.info(f"SVG generation & XML validation succeeded with {model_candidate}: {svg_path}")
                                if executor:
                                    executor.shutdown(wait=False, cancel_futures=True)
                                break
                            else:
                                model_attempts.append(f"⚠️ {model_candidate}: SVG構文不整合（タグ未完結またはXMLパース失敗）")
                                logger.warning(f"SVG validation failed for {model_candidate}. Trying next model...")
                    except Exception as svg_err:
                        err_str = str(svg_err)
                        if "429" in err_str:
                            model_attempts.append(f"❌ {model_candidate}: 429 クォータ制限")
                        else:
                            model_attempts.append(f"❌ {model_candidate}: エラー ({err_str[:50]})")
                        logger.warning(f"SVG generation with {model_candidate} failed: {svg_err}. Trying next model...")
                    finally:
                        if executor:
                            executor.shutdown(wait=False, cancel_futures=True)
        except Exception as client_err:
            model_attempts.append(f"❌ API Client エラー: {str(client_err)[:50]}")
            logger.warning(f"GenAI Client setup or generation error: {client_err}")

    if not image_generated:
        # AIクラウド生成がクォータ上限(429)やGoogleサーバー高負荷(503/タイムアウト)で失敗した場合、
        # お父さんの語った思い出情景に合わせた温かい水彩画風情景スケッチを確約生成してキャンバスにお届けする
        try:
            generate_fallback_image(clean_title, file_path, clean_elements)
            file_name = f"{memory_id}.png"
            image_generated = True
            is_fallback = True
            used_model_name = "情景スケッチ水彩画（※AI画像クォータ上限のため温かい水彩画を生成）"
            model_attempts.append("🎨 情景スケッチ水彩画: 生成完了")
            logger.info(f"Generated guaranteed storyboard watercolor sketch for '{clean_title}': {file_path}")
        except Exception as fb_err:
            logger.error(f"Fallback sketch failed: {fb_err}")
            file_name = ""
            is_fallback = True
            logger.info(f"AI models and fallback could not draw '{clean_title}'. Canvas will remain blank.")

    error_summary = "\n".join(model_attempts) if model_attempts else "利用可能な画像生成モデルがありませんでした。"

    artifact = MemoryArtifact(
        memory_id=memory_id,
        user_id=user_id,
        created_at=datetime.now(),
        scene_type=scene_type,
        title=clean_title,
        visual_description=clean_elements,
        applied_prompt=final_prompt,
        media_format=media_format,
        media_url=f"/static/memories/{file_name}" if file_name else "",
        ambient_sound_type=ambient_sound,
        refine_history=[],
        is_fallback=is_fallback,
        error_details=error_summary,
        model_summary=used_model_name or "なし (全モデル試行失敗)"
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
        # Geminiが架空のIDを指定した場合や直前メモリを探す場合のセーフティネットフォールバック
        json_files = sorted(MEDIA_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        if json_files:
            meta_path = json_files[0]
            logger.info(f"Original memory '{original_memory_id}' not found. Falling back to latest memory: {meta_path.stem}")
        else:
            meta_path = None

    if meta_path and meta_path.exists():
        with open(meta_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        orig_title = data.get("title", "思い出の風景")
        orig_desc = data.get("visual_description", "")
        scene_type_str = data.get("scene_type", SceneType.PAST_MEMORY.value)
    else:
        data = {}
        orig_title = "思い出の情景"
        orig_desc = updated_visual_elements or user_feedback
        scene_type_str = SceneType.PAST_MEMORY.value

    # 【情景要素の完全マージ（要素の省かれを100%防止）】
    # 以前の情景（orig_desc）、バックエンドやGeminiから送られた情景（updated_visual_elements）、
    # ユーザーの修正指示（user_feedback）を重複なく結合する
    elements_parts = []
    if orig_desc and orig_desc.strip():
        elements_parts.append(orig_desc.strip(" 、。"))
    if updated_visual_elements and updated_visual_elements.strip():
        clean_upd = updated_visual_elements.strip(" 、。")
        if clean_upd not in (orig_desc or ""):
            elements_parts.append(clean_upd)
    if user_feedback and user_feedback.strip():
        clean_fb = user_feedback.strip(" 、。")
        if clean_fb not in (orig_desc or "") and clean_fb not in (updated_visual_elements or ""):
            elements_parts.append(f"【修正追加】{clean_fb}")

    new_visual_elements = "、".join(elements_parts) if elements_parts else (user_feedback or updated_visual_elements or "思い出の情景")
    new_title = f"{orig_title.replace(' (修正版)', '')} (修正版)"

    # 【元絵の完全継承（SVGベース描き直し）】
    # 元絵がSVGファイルである場合、元のSVGソースコード自体をGeminiに渡して直接要素を追加・編集させることで、
    # 背景・校舎・木々・色合いなどの既存の構図がリセット・単純化されるのを100%防ぐ！
    orig_media_url = data.get("media_url", "")
    orig_svg_path = None
    if orig_media_url and orig_media_url.endswith(".svg"):
        candidate_path = Path(orig_media_url.lstrip("/"))
        if candidate_path.exists():
            orig_svg_path = candidate_path
        elif (MEDIA_DIR / Path(orig_media_url).name).exists():
            orig_svg_path = MEDIA_DIR / Path(orig_media_url).name

    if orig_svg_path and orig_svg_path.exists():
        import asyncio
        def _refine_svg_sync():
            try:
                orig_svg_code = orig_svg_path.read_text(encoding="utf-8")
                effective_key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
                if not effective_key or effective_key == "your_gemini_api_key_here":
                    return None
                client = genai.Client(api_key=effective_key)
                refine_svg_prompt = (
                    f"以下は、ご本人の大切な思い出を描いた既存のSVGイラストコード（viewBox=\"0 0 800 600\"）です。\n"
                    f"この元のSVGイラストの背景・建物・風景・色調・構図は【100%そのまま残し】、\n"
                    f"ご本人からの修正要望：「{user_feedback}」だけを既存のSVGに重ねて描き加えるための【追加レイヤー <g id=\"refinement-layer\">...</g>】のみを出力してください。\n\n"
                    f"【元のSVGコード（座標・構図・背景の参照用）】\n{orig_svg_code}\n\n"
                    f"【絶対厳守ルール】\n"
                    f"1. 元のSVGを書き直す必要はありません。既存の地面・道・校門・背景の座標（viewBox 800x600）に合わせて、新しく描き加える要素だけを含む `<g id=\"refinement-layer\"> ... </g>` を1つ出力してください。\n"
                    f"2. 「{user_feedback}」が大勢の生徒や人物に関する指示である場合は、校門や通学路・前景〜中景の歩道上に、制服姿やカバンを持った人物（大勢なら10〜15人程度、遠近感をつけて）をはっきり視認できるサイズ（高さ40〜110px程度）と色彩で複数描画してください。\n"
                    f"3. 人物を描く場合は、温かみのある親しみやすいイラスト表現（後ろ姿・横向き・シンプルなシルエットやデフォルメ）で描いてください。\n"
                    f"4. `<g id=\"refinement-layer\">` で始まり `</g>` で終わる整形式SVGグループ要素のみを出力してください。解説やマークダウン枠（```）は一切不要です。"
                )
                for m_name in ("gemini-3.5-flash-lite", "gemini-3.5-flash"):
                    try:
                        logger.info(f"Refining existing SVG ({orig_svg_path.name}) with {m_name} for feedback: '{user_feedback}'...")
                        res = client.models.generate_content(
                            model=m_name,
                            contents=refine_svg_prompt,
                            config=types.GenerateContentConfig(temperature=0.25, max_output_tokens=8192)
                        )
                        raw_out = (res.text or "").strip()
                        raw_out = re.sub(r'^```[a-zA-Z]*\s*', '', raw_out)
                        raw_out = re.sub(r'\s*```$', '', raw_out).strip()

                        candidate_svg = None
                        full_svg_match = re.search(r"<svg[\s\S]*?</svg>", raw_out, re.IGNORECASE)
                        if full_svg_match:
                            candidate_svg = full_svg_match.group(0)
                        else:
                            g_match = re.search(r"<g[\s\S]*?</g>", raw_out, re.IGNORECASE)
                            if g_match and "</svg>" in orig_svg_code:
                                layer_code = g_match.group(0)
                                candidate_svg = orig_svg_code.replace("</svg>", f"\n  {layer_code}\n</svg>")

                        if candidate_svg:
                            refined_svg_code = repair_and_validate_svg(candidate_svg)
                        else:
                            refined_svg_code = None

                        if refined_svg_code:
                            new_id = str(uuid.uuid4())[:8]
                            new_svg_filename = f"{new_id}.svg"
                            new_svg_path = MEDIA_DIR / new_svg_filename
                            new_svg_path.write_text(refined_svg_code, encoding="utf-8")
                            art = MemoryArtifact(
                                memory_id=new_id,
                                user_id=data.get("user_id", "default_user"),
                                title=new_title,
                                scene_type=SceneType(scene_type_str),
                                visual_description=new_visual_elements,
                                applied_prompt=refine_svg_prompt[:600],
                                media_format=MediaFormat.IMAGE,
                                media_url=f"/static/memories/{new_svg_filename}",
                                ambient_sound_type=AmbientSoundType(data.get("ambient_sound_type", AmbientSoundType.NONE.value)),
                                is_fallback=False,
                                refine_history=data.get("refine_history", []) + [user_feedback]
                            )
                            with open(MEDIA_DIR / f"{new_id}.json", "w", encoding="utf-8") as jf:
                                json.dump(art.model_dump(mode="json"), jf, ensure_ascii=False, indent=2)
                            logger.info(f"Successfully refined SVG preserving original composition: {new_svg_filename}")
                            return art
                        else:
                            logger.warning(f"SVG refinement output with {m_name} failed XML validation (len={len(raw_out)}). Trying next model...")
                    except Exception as svg_err:
                        logger.warning(f"SVG refinement with {m_name} failed: {svg_err}")
            except Exception as outer_err:
                logger.warning(f"Failed to refine SVG directly: {outer_err}")
            return None

        refined_art = await asyncio.to_thread(_refine_svg_sync)
        if refined_art:
            return refined_art

    new_artifact = await generate_memory_visual_artifact(
        user_id=data.get("user_id", "default_user"),
        dementia_level=dementia_level,
        scene_type=SceneType(scene_type_str),
        japanese_title=new_title,
        visual_elements=new_visual_elements,
        media_format=MediaFormat(data.get("media_format", MediaFormat.IMAGE.value)),
        ambient_sound=AmbientSoundType(data.get("ambient_sound_type", AmbientSoundType.NONE.value)),
        api_key=api_key
    )

    if new_artifact:
        # 履歴引き継ぎ
        new_artifact.refine_history = data.get("refine_history", []) + [user_feedback]
        with open(MEDIA_DIR / f"{new_artifact.memory_id}.json", "w", encoding="utf-8") as f:
            json.dump(new_artifact.model_dump(mode="json"), f, ensure_ascii=False, indent=2)

    return new_artifact
