#!/usr/bin/env python3
"""
auto_audio_echo_debugger.py
PCのスピーカーとマイクを使ったエコー干渉・発話中断の自動デバッグ＆検証スクリプト
"""

import os
import sys
import time
import math
import wave
import struct
import asyncio
import subprocess
import json
from pathlib import Path

# プロジェクトルート
BASE_DIR = Path(__file__).resolve().parent.parent

def load_api_key():
    env_file = BASE_DIR / ".env"
    if env_file.exists():
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("GEMINI_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.environ.get("GEMINI_API_KEY", "")

def calculate_rms(wav_path):
    """WAVファイルのRMS音量（0.0〜1.0）とデシベルを計算"""
    try:
        with wave.open(str(wav_path), "rb") as wf:
            n_channels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            n_frames = wf.getnframes()
            data = wf.readframes(n_frames)
            
            if sampwidth == 2:
                fmt = f"<{n_frames * n_channels}h"
                samples = struct.unpack(fmt, data)
                sum_sq = sum(s * s for s in samples)
                rms = math.sqrt(sum_sq / len(samples)) / 32768.0
                db = 20 * math.log10(max(rms, 1e-5))
                return rms, db
    except Exception as e:
        print(f"RMS calculation error: {e}")
    return 0.0, -100.0

def generate_test_tone_wav(out_path, duration_sec=1.5, freq=800.0, sample_rate=44100):
    """テスト用正弦波WAVの生成"""
    n_samples = int(duration_sec * sample_rate)
    with wave.open(str(out_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_samples):
            # フェードイン・アウト付き
            envelope = min(1.0, i / (0.05 * sample_rate), (n_samples - i) / (0.05 * sample_rate))
            sample = int(0.5 * 32767.0 * envelope * math.sin(2.0 * math.pi * freq * (i / sample_rate)))
            frames.extend(struct.pack("<h", sample))
        wf.writeframes(frames)

def test_physical_audio_loopback():
    """スピーカーとマイクの物理ループバック（音響結合・エコー）測定"""
    print("\n" + "=" * 60)
    print("【Step 1】スピーカー & マイクの物理ループバック・エコー強度測定")
    print("=" * 60)
    
    ambient_wav = "/tmp/ambient_test.wav"
    tone_wav = "/tmp/test_tone.wav"
    loopback_wav = "/tmp/loopback_test.wav"
    
    # 1. 環境音の測定
    print("1. 静止時の室内環境ノイズを測定中 (1.5秒)...")
    try:
        subprocess.run(
            ["arecord", "-q", "-f", "cd", "-t", "wav", "-d", "2", ambient_wav],
            check=True, timeout=5
        )
        amb_rms, amb_db = calculate_rms(ambient_wav)
        print(f"   -> 室内環境ノイズ: RMS = {amb_rms:.4f} ({amb_db:.1f} dB)")
    except Exception as e:
        print(f"   [警告] arecordの実行に失敗: {e}")
        return False

    # 2. テスト音の生成
    generate_test_tone_wav(tone_wav, duration_sec=1.5, freq=880.0)

    # 3. 再生と同時録音
    print("2. スピーカーからテスト音を再生し、マイクが拾うエコー音量を測定中...")
    try:
        rec_proc = subprocess.Popen(
            ["arecord", "-q", "-f", "cd", "-t", "wav", "-d", "3", loopback_wav]
        )
        time.sleep(0.3)
        # スピーカー再生
        subprocess.run(["aplay", "-q", tone_wav], timeout=3)
        rec_proc.wait(timeout=5)
        
        loop_rms, loop_db = calculate_rms(loopback_wav)
        echo_gain = loop_db - amb_db
        print(f"   -> スピーカー出音時のマイク入力: RMS = {loop_rms:.4f} ({loop_db:.1f} dB)")
        print(f"   -> エコー混入強度比: +{echo_gain:.1f} dB (環境音比)")
        
        if loop_rms > 0.02 or echo_gain > 6.0:
            print("   ★ [判定] スピーカー音がWebカメラマイクに高レベルで回り込んでいます（エコー発生環境）。")
            print("           → 従来のシステムではこの音をGeminiが「バージイン」と誤認して発話中断していました。")
        else:
            print("   -> エコー強度は比較的穏やかです。")
        return True
    except Exception as e:
        print(f"   [警告] 再生・録音テスト中にエラー: {e}")
        return False

async def test_websocket_live_session_echo_shield():
    """WebSocket Live Session に対する E2E 自動エコー遮断テスト"""
    print("\n" + "=" * 60)
    print("【Step 2】WebSocket Live Session エコー自動遮断・完走テスト")
    print("=" * 60)
    
    api_key = load_api_key()
    if not api_key:
        print("   [エラー] GEMINI_API_KEY が見つかりません。")
        return False
        
    try:
        import websockets
    except ImportError:
        print("   [エラー] websockets ライブラリがインストールされていません。")
        return False

    ws_url = f"ws://127.0.0.1:8000/ws/live?api_key={api_key}"
    print(f"1. サーバー WebSocket へ接続中: {ws_url[:40]}...")

    received_audio_bytes = 0
    received_transcripts = []
    received_interrupted = False
    is_session_active = True

    try:
        async with websockets.connect(ws_url) as ws:
            print("   -> WebSocket 接続成功！ Gemini Live セッション確立を待機しています...")

            # マイクからリアルタイムにPCM 16kHzをキャプチャしてサーバーに垂れ流すタスク
            # （スピーカーからAIが声を出している最中も容赦なくマイクが音を拾い続ける状況をシミュレート）
            mic_proc = subprocess.Popen(
                ["arecord", "-q", "-r", "16000", "-c", "1", "-f", "S16_LE", "-t", "raw"],
                stdout=subprocess.PIPE
            )

            async def mic_streamer():
                nonlocal is_session_active
                loop = asyncio.get_running_loop()
                while is_session_active and mic_proc.poll() is None:
                    try:
                        # 40ms チャンク (1280 bytes) ずつ送信
                        chunk = await loop.run_in_executor(None, mic_proc.stdout.read, 1280)
                        if chunk and len(chunk) > 0:
                            await ws.send(chunk)
                    except Exception:
                        break
                    await asyncio.sleep(0.01)

            streamer_task = asyncio.create_task(mic_streamer())

            # サーバーからのレスポンス受信ループ（最大15秒）
            start_t = time.time()
            timeout_sec = 15.0

            # 受信した音声をスピーカーから再生するパイプライン
            aplay_proc = subprocess.Popen(
                ["aplay", "-q", "-r", "24000", "-c", "1", "-f", "S16_LE", "-t", "raw"],
                stdin=subprocess.PIPE
            )

            try:
                while time.time() - start_t < timeout_sec:
                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    except asyncio.TimeoutError:
                        if received_audio_bytes > 0:
                            # 音声受信後に2秒間無音になったら挨拶完了と判定
                            break
                        continue

                    if isinstance(msg, bytes):
                        # PCM 24kHz 音声データ
                        received_audio_bytes += len(msg)
                        # 実際にスピーカーへ出力して部屋を鳴らす！
                        if aplay_proc.stdin:
                            try:
                                aplay_proc.stdin.write(msg)
                                aplay_proc.stdin.flush()
                            except Exception:
                                pass
                    elif isinstance(msg, str):
                        data = json.loads(msg)
                        msg_type = data.get("type")
                        if msg_type == "transcript" and data.get("role") == "model":
                            txt = data.get("text", "")
                            received_transcripts.append(txt)
                            print(f"   [AI字幕受信] {txt}")
                        elif msg_type == "ai_transcript":
                            txt = data.get("text", "")
                            received_transcripts.append(txt)
                            print(f"   [AI字幕受信] {txt}")
                        elif msg_type == "interrupted":
                            received_interrupted = True
                            print("   [警告] サーバーから interrupted イベントを受信しました！")
            finally:
                is_session_active = False
                streamer_task.cancel()
                if mic_proc.poll() is None:
                    mic_proc.terminate()
                if aplay_proc.poll() is None:
                    aplay_proc.stdin.close()
                    aplay_proc.terminate()

            # 挨拶の評価
            audio_sec = received_audio_bytes / 48000.0  # 24kHz 16bit mono = 48,000 bytes/sec
            full_text = "".join(received_transcripts)
            print("\n" + "-" * 60)
            print("【検証結果サマリー】")
            print(f"- 合計受信音声長: {audio_sec:.2f} 秒 ({received_audio_bytes} バイト)")
            print(f"- 取得テキスト: 「{full_text}」")
            print(f"- interrupted 受信有無: {'あり (中断発生)' if received_interrupted else 'なし (完走)'}")

            # 判定
            if audio_sec > 3.0 and ("さくら" in full_text or "こんにちは" in full_text):
                if not received_interrupted:
                    print("\n🎉 【成功】マイクがスピーカー音を拾い続ける過酷な環境下でも、")
                    print("         サーバー側エコーガードが正常にマイク入力を遮断し、")
                    print("         さくらさんの挨拶が「桜」で途切れることなく最後まで完走しました！")
                    return True
                else:
                    print("\n⚠️ 【注意】interrupted が通知されましたが、音声は一定量受信できました。")
                    return False
            else:
                print("\n❌ 【失敗】音声が途中で切れたか、十分な長さが取得できませんでした。")
                return False

    except Exception as e:
        print(f"   [エラー] WebSocket通信中に例外発生: {e}")
        return False

def main():
    print("=" * 60)
    print(" おもいでキャンバス：スピーカー・マイク自動エコーデバッグツール")
    print("=" * 60)
    
    # Step 1: 物理オーディオテスト
    loopback_ok = test_physical_audio_loopback()
    
    # Step 2: E2E WebSocketセッションエコー耐性テスト
    ws_ok = asyncio.run(test_websocket_live_session_echo_shield())
    
    print("\n" + "=" * 60)
    if ws_ok:
        print("【総合診断】自動デバッグ完了：エコー干渉問題は正常に防止・解決されています。")
    else:
        print("【総合診断】要追加調査・調整が必要です。")
    print("=" * 60)

if __name__ == "__main__":
    main()
