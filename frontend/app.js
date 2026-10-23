/**
 * おもいでキャンバス (omoide-canvas) フロントエンド制御スクリプト v2.0
 * ・WebAudio API: PCM 16kHz マイク入力 ＆ 24kHz スピーカー再生
 * ・リアルタイム・オシロスコープ波形描画 (AnalyserNode Canvas)
 * ・マイク入力音量レベルメーター (VUメーター)
 * ・リアルタイム音声認識 ＆ 文字起こし字幕 (Web Speech API ＆ Gemini Transcription)
 * ・Web Speech API による確実な日本語音声合成フォールバック（APIキー未設定でも喋る）
 * ・WebRTC 1FPS 見守りカメラフレームキャプチャ
 * ・WebSocket (/ws/live) 全二重リアルタイム通信
 * ・AIパートナーイラストアバター 4状態遷移 (idle, listening, speaking, drawing)
 * ・介護者用ダッシュボード（設定・日報・絵本ギャラリー・動作診断）
 */

(() => {
  'use strict';

  // ============================================================================
  // 定数・ステート管理
  // ============================================================================
  const SAMPLE_RATE_IN = 16000;   // マイク入力サンプリングレート
  const SAMPLE_RATE_OUT = 24000;  // Gemini返答音声サンプリングレート

  const state = {
    isConnected: false,
    isSessionActive: false,
    isSimulation: false,
    isAiSpeaking: false,            // AIが発話中（エコー防止用フラグ）
    speechDebounceTimer: null,      // 発話終了待ちデバウンスタイマー
    pendingUserTranscript: '',      // 送信待ちの発話テキスト
    audioContextIn: null,
    audioContextOut: null,
    analyserNode: null,
    micStream: null,
    cameraStream: null,
    processorNode: null,
    socket: null,
    cameraIntervalId: null,
    oscilloscopeAnimId: null,
    audioPlaybackQueue: [],
    nextPlaybackTime: 0,
    currentProfile: null,
    ambientSoundNode: null,
    recognition: null // Web Speech API 音声認識
  };

  // DOM要素キャッシュ
  const dom = {
    // ヘッダー
    userGreeting: document.getElementById('userGreeting'),
    btnToggleCaregiver: document.getElementById('btnToggleCaregiver'),

    // パートナー＆セッション
    avatarContainer: document.getElementById('avatarContainer'),
    partnerStatusText: document.getElementById('partnerStatusText'),
    btnSessionToggle: document.getElementById('btnSessionToggle'),
    sessionHint: document.getElementById('sessionHint'),

    // オシロスコープ ＆ VU音量メーター
    oscilloscopeCanvas: document.getElementById('oscilloscopeCanvas'),
    vuMeterFill: document.getElementById('vuMeterFill'),
    vuLevelText: document.getElementById('vuLevelText'),

    // キャンバス ＆ 字幕
    mediaDisplayArea: document.getElementById('mediaDisplayArea'),
    canvasPlaceholder: document.getElementById('canvasPlaceholder'),
    memoryImage: document.getElementById('memoryImage'),
    memoryVideo: document.getElementById('memoryVideo'),
    drawingOverlay: document.getElementById('drawingOverlay'),
    captionTitle: document.getElementById('captionTitle'),
    captionTag: document.getElementById('captionTag'),
    soundIndicator: document.getElementById('soundIndicator'),
    soundName: document.getElementById('soundName'),
    userTranscriptText: document.getElementById('userTranscriptText'),
    aiTranscriptText: document.getElementById('aiTranscriptText'),

    // ステータスバー
    statusDot: document.getElementById('statusDot'),
    statusMessage: document.getElementById('statusMessage'),
    visualizerContainer: document.getElementById('visualizerContainer'),
    visionCamera: document.getElementById('visionCamera'),
    visionCanvas: document.getElementById('visionCanvas'),

    // 介護者モーダル
    caregiverModal: document.getElementById('caregiverModal'),
    btnCloseModal: document.getElementById('btnCloseModal'),
    profileForm: document.getElementById('profileForm'),
    reportsContainer: document.getElementById('reportsContainer'),
    galleryGrid: document.getElementById('galleryGrid'),
    diagLog: document.getElementById('diagLog'),
    btnDiagImage: document.getElementById('btnDiagImage'),
    btnDiagEmergency: document.getElementById('btnDiagEmergency'),
    btnDiagAvatar: document.getElementById('btnDiagAvatar')
  };

  // ============================================================================
  // 初期化
  // ============================================================================
  async function init() {
    setupEventListeners();
    await fetchUserProfile();
    drawFlatOscilloscope(); // 初期オシロスコープ波形（水平線）描画
    logDiag('システムが初期化されました。');
  }

  // ============================================================================
  // イベントリスナー登録
  // ============================================================================
  function setupEventListeners() {
    // セッション開始・終了ボタン
    dom.btnSessionToggle.addEventListener('click', toggleSession);

    // 介護者モーダル開閉
    dom.btnToggleCaregiver.addEventListener('click', openCaregiverModal);
    dom.btnCloseModal.addEventListener('click', closeCaregiverModal);
    dom.caregiverModal.addEventListener('click', (e) => {
      if (e.target === dom.caregiverModal) closeCaregiverModal();
    });

    // モーダルタブ切り替え
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const targetId = btn.getAttribute('data-tab');
        document.getElementById(targetId)?.classList.add('active');

        // タブ切り替え時のデータ更新
        if (targetId === 'tabReports') loadReports();
        if (targetId === 'tabGallery') loadGallery();
      });
    });

    // プロフィール保存
    dom.profileForm.addEventListener('submit', handleProfileSubmit);

    // パートナーの性別変更時にデフォルトの声質を連動切り替え
    const partnerGenderEl = document.getElementById('selectPartnerGender');
    const partnerVoiceEl = document.getElementById('selectPartnerVoice');
    if (partnerGenderEl && partnerVoiceEl) {
      partnerGenderEl.addEventListener('change', (e) => {
        if (e.target.value === '男性' && (partnerVoiceEl.value === 'Aoede' || partnerVoiceEl.value === 'Kore')) {
          partnerVoiceEl.value = 'Puck';
        } else if (e.target.value === '女性' && ['Puck', 'Charon', 'Fenrir'].includes(partnerVoiceEl.value)) {
          partnerVoiceEl.value = 'Aoede';
        }
      });
    }

    // 動作確認ボタン群
    dom.btnDiagImage.addEventListener('click', testGenerateSampleVisual);
    dom.btnDiagEmergency.addEventListener('click', testEmergencyAlert);
    dom.btnDiagAvatar.addEventListener('click', testCycleAvatars);
  }

  // ============================================================================
  // セッション制御 (開始 / 終了)
  // ============================================================================
  async function toggleSession() {
    if (state.isSessionActive) {
      await stopSession();
    } else {
      await startSession();
    }
  }

  async function startSession() {
    try {
      updateStatus('マイクと接続を準備しています...', true);
      dom.btnSessionToggle.disabled = true;

      // 1. AudioContextの初期化（スマホ対応: 入出力を1つのAudioContextに統合し、タップ直後にアンロック）
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!state.audioContextOut) {
        state.audioContextOut = new AudioCtx();
      }
      if (state.audioContextOut.state === 'suspended') {
        await state.audioContextOut.resume();
      }
      state.audioContextIn = state.audioContextOut;

      // スマホ（iOS/Android）の音声再生ロック解除用・無音バッファ即時再生
      try {
        const unlockBuffer = state.audioContextOut.createBuffer(1, 1, 22050);
        const unlockSource = state.audioContextOut.createBufferSource();
        unlockSource.buffer = unlockBuffer;
        unlockSource.connect(state.audioContextOut.destination);
        unlockSource.start(0);
      } catch (e) {}

      // 2. マイクストリーム取得（スマホで Web Speech API と競合しないよう WebAudio 1本に統合）
      state.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      // スマホ（Android/iOS）の仕様：getUserMedia 完了後に AudioContext が suspended になるため再 resume 必須
      if (state.audioContextIn.state === 'suspended') {
        await state.audioContextIn.resume();
      }
      // 単一の MediaStreamSource を共有（スマホで複数作ると片方が無音になるバグを防止）
      state.micSourceNode = state.audioContextIn.createMediaStreamSource(state.micStream);

      // 3. カメラ見守りストリーム取得（スマホのマイク帯域・権限を邪魔しないようPCまたは明示時のみ）
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (!isMobile) {
        try {
          state.cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 320, height: 240, frameRate: 1 }
          });
          dom.visionCamera.srcObject = state.cameraStream;
          dom.visionCamera.play();
          startCameraMonitoring();
        } catch (camErr) {
          logDiag('カメラへのアクセスはスキップされました（音声のみで動作します）。');
        }
      }

      // 4. ブラウザ音声認識 (Web Speech API) はスマホではマイクを排他ロックしてしまうためPCのみ起動
      if (!isMobile) {
        startSpeechRecognition();
      }

      // 5. WebSocket 接続確立
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/live`;
      state.socket = new WebSocket(wsUrl);
      state.socket.binaryType = 'arraybuffer';

      state.socket.onopen = async () => {
        state.isConnected = true;
        state.isSessionActive = true;
        if (state.audioContextIn && state.audioContextIn.state === 'suspended') {
          await state.audioContextIn.resume();
        }
        updateStatus('お話を聞いています...（マイクに向かってお話しください）', true);
        dom.visualizerContainer.classList.add('listening');
        dom.btnSessionToggle.classList.add('active');
        dom.btnSessionToggle.innerHTML = '<span class="btn-icon">⏹️</span><span class="btn-text">お話を終了する</span>';
        dom.sessionHint.textContent = 'ボタンを押すと、いつでもお話を終了できます';
        dom.userTranscriptText.textContent = '「お話しください...（声が文字になります）」';
        setAvatarState('listening');
        // isSessionActive = true になった後にオシロスコープ波形描画と音声処理を開始！
        startOscilloscope();
        startAudioProcessing();
      };

      state.socket.onmessage = handleWebSocketMessage;

      state.socket.onclose = () => {
        logDiag('WebSocket接続が切断されました。');
        stopSessionCleanup();
      };

      state.socket.onerror = (err) => {
        logDiag(`WebSocketエラー: ${err}`);
      };

    } catch (err) {
      console.error('Session start error:', err);
      updateStatus(`マイクの起動に失敗しました: ${err.message}`, false);
      alert('マイクへのアクセスを許可してください。');
      stopSessionCleanup();
    } finally {
      dom.btnSessionToggle.disabled = false;
    }
  }

  async function stopSession() {
    updateStatus('お話を終了しています...', false);
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      try {
        state.socket.send(JSON.stringify({ type: 'end_session' }));
        state.socket.close();
      } catch (e) {}
    }
    stopSessionCleanup();
    updateStatus('対話が終了しました。今日も素敵なお話をありがとうございました。', false);
    setAvatarState('idle');
  }

  function stopSessionCleanup() {
    state.isSessionActive = false;
    state.isConnected = false;

    // 音声認識停止
    if (state.recognition) {
      try { state.recognition.stop(); } catch (e) {}
      state.recognition = null;
    }
    if (state.speechDebounceTimer) {
      clearTimeout(state.speechDebounceTimer);
      state.speechDebounceTimer = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    state.isAiSpeaking = false;
    state.pendingUserTranscript = '';

    // オシロスコープ停止
    if (state.oscilloscopeAnimId) {
      cancelAnimationFrame(state.oscilloscopeAnimId);
      state.oscilloscopeAnimId = null;
    }
    drawFlatOscilloscope();
    dom.vuMeterFill.style.width = '0%';
    dom.vuLevelText.textContent = '待機中';

    // マイク停止
    if (state.micStream) {
      state.micStream.getTracks().forEach(t => t.stop());
      state.micStream = null;
    }

    // カメラ停止
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach(t => t.stop());
      state.cameraStream = null;
    }
    if (state.cameraIntervalId) {
      clearInterval(state.cameraIntervalId);
      state.cameraIntervalId = null;
    }

    // ノード解放
    if (state.micSourceNode) {
      try { state.micSourceNode.disconnect(); } catch (e) {}
      state.micSourceNode = null;
    }
    if (state.processorNode) {
      try { state.processorNode.disconnect(); } catch (e) {}
      state.processorNode = null;
    }
    if (state.analyserNode) {
      try { state.analyserNode.disconnect(); } catch (e) {}
      state.analyserNode = null;
    }

    dom.visualizerContainer.classList.remove('listening');
    dom.btnSessionToggle.classList.remove('active');
    dom.btnSessionToggle.innerHTML = '<span class="btn-icon">🎙️</span><span class="btn-text">お話をはじめる</span>';
    dom.sessionHint.textContent = 'ボタンを押して、マイクに向かってゆっくりお話しください';
  }

  // ============================================================================
  // マイク音声ストリーミング (PCM 16kHz Mono -> WebSocket Binary)
  // ※スマホの48kHz/44.1kHzマイクでも確実に16kHzへダウンサンプリングして送信
  // ============================================================================
  function startAudioProcessing() {
    const audioContext = state.audioContextIn;
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
    const source = state.micSourceNode || audioContext.createMediaStreamSource(state.micStream);
    const actualSampleRate = audioContext.sampleRate;

    // バッファサイズ 1024 サンプル（約21ms〜64ms毎）で超低遅延ストリーミング
    const bufferSize = 1024;
    const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

    let silenceChunks = 0;
    let isUserCurrentlySpeaking = false;
    const NOISE_FLOOR_RMS = 0.004; // 部屋の環境ノイズをカットする閾値

    processor.onaudioprocess = (e) => {
      if (!state.isSessionActive || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;

      const inputData = e.inputBuffer.getChannelData(0);

      // デバイスのサンプルレート（例: 48000Hz）から 16000Hz へダウンサンプリング
      let downsampledData = inputData;
      if (actualSampleRate !== SAMPLE_RATE_IN) {
        const ratio = actualSampleRate / SAMPLE_RATE_IN;
        const newLength = Math.round(inputData.length / ratio);
        downsampledData = new Float32Array(newLength);
        for (let i = 0; i < newLength; i++) {
          const idx = Math.min(inputData.length - 1, Math.floor(i * ratio));
          downsampledData[i] = inputData[idx];
        }
      }

      // 音量（RMS）計測によるノイズゲート処理
      // ※話し終えた後のわずかな環境ノイズでGeminiが「まだ話している」と勘違いして返答が遅れるのを防ぐ
      let sumSq = 0;
      for (let i = 0; i < downsampledData.length; i++) {
        sumSq += downsampledData[i] * downsampledData[i];
      }
      const rms = Math.sqrt(sumSq / downsampledData.length);

      if (rms > NOISE_FLOOR_RMS) {
        isUserCurrentlySpeaking = true;
        silenceChunks = 0;
      } else {
        silenceChunks++;
        if (silenceChunks > 6) {
          isUserCurrentlySpeaking = false;
        }
      }

      // Float32 (-1.0 ~ 1.0) を Int16 (-32768 ~ 32767) の Little-Endian PCM に変換
      // AIが発話中、またはユーザーが黙っている環境ノイズ時は完全なゼロ（無音）を送ることでGeminiの返答を爆速化
      const pcm16 = new Int16Array(downsampledData.length);
      if (!state.isAiSpeaking && isUserCurrentlySpeaking) {
        for (let i = 0; i < downsampledData.length; i++) {
          const s = Math.max(-1, Math.min(1, downsampledData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
      }

      state.socket.send(pcm16.buffer);
    };

    // マイクスルー（ハウリング）防止用の無音GainNodeを介してdestinationへ接続
    const zeroGain = audioContext.createGain();
    zeroGain.gain.value = 0;
    source.connect(processor);
    processor.connect(zeroGain);
    zeroGain.connect(audioContext.destination);
    state.processorNode = processor;
  }

  // ============================================================================
  // オシロスコープ波形 ＆ VUメーター描画 (AnalyserNode)
  // ============================================================================
  function startOscilloscope() {
    if (!state.audioContextIn || !state.micStream) return;

    const audioContext = state.audioContextIn;
    const source = state.micSourceNode || audioContext.createMediaStreamSource(state.micStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    state.analyserNode = analyser;

    const bufferLength = analyser.frequencyBinCount;
    const floatArray = new Float32Array(bufferLength);
    const canvas = dom.oscilloscopeCanvas;
    const ctx = canvas.getContext('2d');

    function renderWaveform() {
      if (!state.isSessionActive) return;

      state.oscilloscopeAnimId = requestAnimationFrame(renderWaveform);
      analyser.getFloatTimeDomainData(floatArray);

      // 1. RMS（実効音量）を先に計算し、スマホの小音量でも見やすいよう波形ゲインを自動増幅
      let sumSquares = 0;
      for (let i = 0; i < bufferLength; i++) {
        sumSquares += floatArray[i] * floatArray[i];
      }
      const rms = Math.sqrt(sumSquares / bufferLength);
      const visualGain = 3.5; // スマホマイクの波形がはっきり振れるよう3.5倍に視覚増幅

      // 2. オシロスコープ波形の描画
      ctx.fillStyle = '#1a2723';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#81b29a'; // 和の青磁色
      ctx.shadowBlur = 4;
      ctx.shadowColor = '#a8dadc';
      ctx.beginPath();

      const sliceWidth = canvas.width * 1.0 / bufferLength;
      let x = 0;
      const midY = canvas.height / 2;

      for (let i = 0; i < bufferLength; i++) {
        const sample = Math.max(-1, Math.min(1, floatArray[i] * visualGain));
        const y = midY + sample * (midY * 0.9);

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }

      ctx.lineTo(canvas.width, midY);
      ctx.stroke();

      // 3. VU音量レベルメーターの計算と反映
      const volumePercent = Math.min(100, Math.round(rms * 650)); // スマホ向けに感度向上

      dom.vuMeterFill.style.width = `${volumePercent}%`;

      if (volumePercent < 4) {
        dom.vuLevelText.textContent = '待機中（お話しください）';
        dom.vuLevelText.style.color = 'var(--text-muted)';
      } else if (volumePercent < 55) {
        dom.vuLevelText.textContent = '音声入力中：良好 🟢';
        dom.vuLevelText.style.color = 'var(--primary)';
      } else {
        dom.vuLevelText.textContent = '音声入力中：しっかり届いています 🟡';
        dom.vuLevelText.style.color = '#e07a5f';
      }
    }

    renderWaveform();
  }

  function drawFlatOscilloscope() {
    const canvas = dom.oscilloscopeCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a2723';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(129, 178, 154, 0.4)';
    ctx.beginPath();
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }

  // ============================================================================
  // Web Speech API 音声認識 (リアルタイム文字起こし)
  // ============================================================================
  function startSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      logDiag('このブラウザはWeb Speech API音声認識に対応していません。');
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = 'ja-JP';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event) => {
        // AIがスピーカーから発話中の場合、そのスピーカー音を自分の発話と誤認しないよう破棄
        if (state.isAiSpeaking) return;

        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }

        const displayText = (finalTranscript || interimTranscript).trim();
        if (displayText) {
          dom.userTranscriptText.textContent = `「${displayText}」`;
          
          if (finalTranscript) {
            state.pendingUserTranscript = (state.pendingUserTranscript + ' ' + finalTranscript).trim();
          } else if (!state.pendingUserTranscript) {
            state.pendingUserTranscript = interimTranscript.trim();
          }

          // ユーザーが話し終えた（1.2秒間の沈黙）を検知してサーバーへ送信
          if (state.speechDebounceTimer) {
            clearTimeout(state.speechDebounceTimer);
          }
          state.speechDebounceTimer = setTimeout(() => {
            if (!state.isSessionActive || state.isAiSpeaking) return;
            const textToSend = state.pendingUserTranscript;
            state.pendingUserTranscript = '';

            if (textToSend && textToSend.length >= 2 && state.socket && state.socket.readyState === WebSocket.OPEN) {
              state.socket.send(JSON.stringify({
                type: 'user_transcript',
                text: textToSend
              }));
              logDiag(`発話完了を検知・送信: 「${textToSend}」`);
            }
          }, 1200);
        }
      };

      recognition.onerror = (e) => {
        if (e.error !== 'no-speech') {
          console.warn('SpeechRecognition error:', e.error);
        }
      };

      recognition.onend = () => {
        // セッション中なら自動再起動
        if (state.isSessionActive) {
          try { recognition.start(); } catch (e) {}
        }
      };

      recognition.start();
      state.recognition = recognition;
    } catch (err) {
      console.warn('Failed to start speech recognition:', err);
    }
  }

  // ============================================================================
  // 1FPS 見守りカメラフレームキャプチャ
  // ============================================================================
  function startCameraMonitoring() {
    const video = dom.visionCamera;
    const canvas = dom.visionCanvas;
    const ctx = canvas.getContext('2d');

    state.cameraIntervalId = setInterval(() => {
      if (!state.isSessionActive || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
      if (video.videoWidth === 0) return;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.5);

      state.socket.send(JSON.stringify({
        type: 'camera_frame',
        data: jpegDataUrl
      }));
    }, 1000);
  }

  // ============================================================================
  // WebSocket メッセージ受信ハンドラ
  // ============================================================================
  async function handleWebSocketMessage(event) {
    // 1. バイナリ受信：Geminiからの返答PCM音声 (24kHz Mono)
    if (event.data instanceof ArrayBuffer) {
      queueAudioPlayback(event.data);
      return;
    }

    // 2. JSONメッセージ受信
    try {
      const data = JSON.parse(event.data);
      const msgType = data.type;

      switch (msgType) {
        case 'session_ready': {
          state.isSimulation = !!data.simulation;
          const cleanName = (data.call_name || '').replace(/\s*さん$/, '');
          dom.partnerStatusText.textContent = `${cleanName}さんとお話し中`;
          setAvatarState('listening');
          if (state.isSimulation) {
            logDiag('【案内】ローカルシミュレーションモードで接続しました。');
          }
          break;
        }

        case 'transcript':
          // 文字起こし字幕の更新（チャンクで届く場合は繋げて読みやすく表示）
          if (data.role === 'model' && data.text) {
            if (dom.aiTranscriptText.textContent.includes('こんにちは！今日もよろしくお願いします')) {
              dom.aiTranscriptText.textContent = data.text;
            } else {
              dom.aiTranscriptText.textContent = data.text;
            }
            // シミュレーションモード時はブラウザ音声合成で喋らせる！
            if (state.isSimulation) {
              speakTextWithWebSpeech(data.text);
            }
          } else if (data.role === 'user' && data.text) {
            dom.userTranscriptText.textContent = `「${data.text}」`;
          }
          break;

        case 'avatar_state':
          setAvatarState(data.state);
          break;

        case 'new_media':
          displayGeneratedMedia(data);
          break;

        case 'emergency_dispatched':
          showEmergencyBanner(data.result);
          break;

        case 'error':
          logDiag(`サーバーエラー: ${data.message}`);
          break;
      }
    } catch (err) {
      console.error('Error parsing JSON message:', err);
    }
  }

  // ============================================================================
  // 音声再生（Gemini PCM 24kHz スピーカー再生）
  // ============================================================================
  function queueAudioPlayback(arrayBuffer) {
    const ctx = state.audioContextOut;
    if (!ctx) return;

    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);

    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    const audioBuffer = ctx.createBuffer(1, float32Array.length, SAMPLE_RATE_OUT);
    audioBuffer.getChannelData(0).set(float32Array);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const currentTime = ctx.currentTime;
    if (state.nextPlaybackTime < currentTime) {
      state.nextPlaybackTime = currentTime;
    }

    source.start(state.nextPlaybackTime);
    state.nextPlaybackTime += audioBuffer.duration;

    // AI発話中フラグをONにしてマイクエコーを遮断
    state.isAiSpeaking = true;
    setAvatarState('speaking');

    source.onended = () => {
      if (ctx.currentTime >= state.nextPlaybackTime - 0.05) {
        // スピーカーからの残響が消えるまで300ms待ってからマイクを即再開（レスポンス向上）
        setTimeout(() => {
          state.isAiSpeaking = false;
          setAvatarState('listening');
        }, 300);
      }
    };
  }

  // ============================================================================
  // Web Speech API による日本語音声合成（シミュレーション時フォールバック）
  // ============================================================================
  function speakTextWithWebSpeech(text) {
    if (!('speechSynthesis' in window)) return;

    window.speechSynthesis.cancel(); // 前の音声をキャンセル
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ja-JP';
    utter.rate = 0.95; // 高齢者に聞き取りやすいように少しゆっくり
    utter.pitch = 1.05;

    // 日本語の優しい声を探す
    const voices = window.speechSynthesis.getVoices();
    const jaVoice = voices.find(v => v.lang === 'ja-JP' || v.lang.startsWith('ja'));
    if (jaVoice) utter.voice = jaVoice;

    utter.onstart = () => {
      // AI発話中フラグをON（スピーカー音のマイク拾い・ループを完全防止）
      state.isAiSpeaking = true;
      setAvatarState('speaking');
    };
    utter.onend = () => {
      // 発話終了後、スピーカーの余韻がマイクに拾われないよう800ms待ってからマイクを再開
      setTimeout(() => {
        state.isAiSpeaking = false;
        setAvatarState('listening');
      }, 800);
    };
    utter.onerror = () => {
      state.isAiSpeaking = false;
      setAvatarState('listening');
    };

    window.speechSynthesis.speak(utter);
  }

  // ============================================================================
  // アバター表情切り替え
  // ============================================================================
  function setAvatarState(avatarState) {
    dom.avatarContainer.setAttribute('data-state', avatarState);
    const pName = state.currentProfile?.partner?.name || 'パートナー';

    switch (avatarState) {
      case 'idle':
        dom.partnerStatusText.textContent = `${pName}：準備完了`;
        dom.drawingOverlay.classList.add('hidden');
        break;
      case 'listening':
        dom.partnerStatusText.textContent = `${pName}：お話を聞いています...`;
        dom.drawingOverlay.classList.add('hidden');
        break;
      case 'speaking':
        dom.partnerStatusText.textContent = `${pName}：お話し中...`;
        dom.drawingOverlay.classList.add('hidden');
        break;
      case 'drawing':
        dom.partnerStatusText.textContent = `${pName}：絵を描いています...`;
        dom.drawingOverlay.classList.remove('hidden');
        break;
    }
  }

  // ============================================================================
  // 生成メディアのクロスフェード表示 ＆ 環境音連動
  // ============================================================================
  function displayGeneratedMedia(mediaData) {
    dom.canvasPlaceholder.classList.add('hidden');
    dom.drawingOverlay.classList.add('hidden');

    dom.captionTitle.textContent = mediaData.title || '思い出の情景';
    dom.captionTag.textContent = mediaData.media_format === 'video' ? '動く絵本' : '水彩画';

    if (mediaData.media_format === 'video') {
      dom.memoryImage.classList.add('hidden');
      dom.memoryVideo.src = mediaData.media_url;
      dom.memoryVideo.classList.remove('hidden');
      dom.memoryVideo.play();
    } else {
      dom.memoryVideo.classList.add('hidden');
      dom.memoryImage.src = mediaData.media_url;
      dom.memoryImage.classList.remove('hidden');
    }

    // 環境音の再生
    if (mediaData.ambient_sound && mediaData.ambient_sound !== 'none') {
      dom.soundIndicator.classList.remove('hidden');
      dom.soundName.textContent = getSoundLabel(mediaData.ambient_sound);
      playSyntheticAmbientSound(mediaData.ambient_sound);
    } else {
      dom.soundIndicator.classList.add('hidden');
      stopSyntheticAmbientSound();
    }

    logDiag(`新しい情景を表示しました: ${mediaData.title}`);
  }

  function getSoundLabel(type) {
    const labels = {
      autumn_insects: '秋の虫の声 ♪',
      gentle_waves: '穏やかな波の音 ♪',
      wind_chime: '風鈴の音 ♪',
      festival_music: 'お祭りの囃子 ♪',
      train_steam: '電車の汽笛 ♪',
      birds_forest: '小鳥のさえずり ♪'
    };
    return labels[type] || '懐かしい音 ♪';
  }

  // 優しい環境音シンセサイザー（外部音源ファイル不要のWebAudio生成）
  function playSyntheticAmbientSound(soundType) {
    stopSyntheticAmbientSound();
    if (!state.audioContextOut) return;

    try {
      const ctx = state.audioContextOut;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      if (soundType === 'autumn_insects') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(4500, ctx.currentTime);
        gain.gain.setValueAtTime(0.015, ctx.currentTime);
      } else if (soundType === 'wind_chime') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(2200, ctx.currentTime);
        gain.gain.setValueAtTime(0.02, ctx.currentTime);
      } else {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        gain.gain.setValueAtTime(0.01, ctx.currentTime);
      }

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      state.ambientSoundNode = { osc, gain };
    } catch (e) {
      console.warn('Ambient sound play error:', e);
    }
  }

  function stopSyntheticAmbientSound() {
    if (state.ambientSoundNode) {
      try {
        state.ambientSoundNode.osc.stop();
        state.ambientSoundNode.osc.disconnect();
      } catch (e) {}
      state.ambientSoundNode = null;
    }
  }

  // ============================================================================
  // 介護者モーダル ＆ REST API 連携
  // ============================================================================
  function openCaregiverModal() {
    dom.caregiverModal.classList.remove('hidden');
    loadProfileIntoForm();
  }

  function closeCaregiverModal() {
    dom.caregiverModal.classList.add('hidden');
  }

  async function fetchUserProfile() {
    try {
      const res = await fetch('/api/profile');
      if (res.ok) {
        state.currentProfile = await res.json();
        updateGreetingAndPartnerLabels(state.currentProfile);
      }
    } catch (err) {
      console.error('Failed to fetch profile:', err);
    }
  }

  function updateGreetingAndPartnerLabels(profile) {
    if (!profile) return;
    const rawName = (profile.call_name || 'ゲスト').replace(/\s*さん$/, '');
    const suffix = rawName.endsWith('お父さん') || rawName.endsWith('お母さん') || rawName.endsWith('ちゃん') || rawName.endsWith('先生') ? '' : 'さん';
    dom.userGreeting.textContent = `${rawName}${suffix}のお部屋`;

    const pName = profile.partner?.name || 'さくら';
    dom.partnerStatusText.textContent = `${pName}：準備完了`;
    const aiTagEl = document.querySelector('.ai-tag');
    if (aiTagEl) aiTagEl.textContent = `🤖 ${pName}`;
    const userTagEl = document.querySelector('.user-tag');
    if (userTagEl) userTagEl.textContent = `🎤 ${rawName}${suffix}`;
  }

  function loadProfileIntoForm() {
    if (!state.currentProfile) return;
    const p = state.currentProfile;
    document.getElementById('inputCallName').value = p.call_name || '';
    document.getElementById('inputAgeGroup').value = p.age_group || '80代';
    document.getElementById('selectUserGender').value = p.gender || '男性';
    document.getElementById('inputUserPersonality').value = p.personality || '';
    document.getElementById('selectDementiaLevel').value = p.dementia_level || 'mild';
    document.getElementById('inputOccupation').value = p.former_occupation || '';
    document.getElementById('inputHometown').value = p.hometown || '';
    document.getElementById('inputHobbies').value = (p.hobbies || []).join(', ');
    document.getElementById('inputTriggerWords').value = (p.trigger_words || []).join(', ');
    document.getElementById('inputNgTopics').value = (p.ng_topics || []).join(', ');

    const partner = p.partner || {};
    document.getElementById('inputPartnerName').value = partner.name || 'さくら';
    document.getElementById('inputPartnerAge').value = partner.age_setting || '30代';
    document.getElementById('selectPartnerGender').value = partner.gender || '女性';
    document.getElementById('selectPartnerVoice').value = partner.voice_name || 'Aoede';
    document.getElementById('inputPartnerPersonality').value = partner.personality || '';

    const ec = p.emergency_contact || {};
    document.getElementById('inputFamilyName').value = ec.family_name || '';
    document.getElementById('inputRelationship').value = ec.relationship || '';
    document.getElementById('inputPhoneNumber').value = ec.phone_number || '';
    document.getElementById('inputEmail').value = ec.email || '';
  }

  async function handleProfileSubmit(e) {
    e.preventDefault();
    const partnerGender = document.getElementById('selectPartnerGender').value;
    let partnerVoice = document.getElementById('selectPartnerVoice').value;

    const updated = {
      user_id: state.currentProfile?.user_id || 'default_user',
      call_name: document.getElementById('inputCallName').value.trim(),
      age_group: document.getElementById('inputAgeGroup').value.trim() || '80代',
      gender: document.getElementById('selectUserGender').value,
      personality: document.getElementById('inputUserPersonality').value.trim(),
      dementia_level: document.getElementById('selectDementiaLevel').value,
      former_occupation: document.getElementById('inputOccupation').value.trim(),
      hometown: document.getElementById('inputHometown').value.trim(),
      hobbies: document.getElementById('inputHobbies').value.split(',').map(s => s.trim()).filter(Boolean),
      trigger_words: document.getElementById('inputTriggerWords').value.split(',').map(s => s.trim()).filter(Boolean),
      ng_topics: document.getElementById('inputNgTopics').value.split(',').map(s => s.trim()).filter(Boolean),
      partner: {
        name: document.getElementById('inputPartnerName').value.trim() || 'さくら',
        age_setting: document.getElementById('inputPartnerAge').value.trim() || '30代',
        gender: partnerGender,
        personality: document.getElementById('inputPartnerPersonality').value.trim() || '優しく穏やかで聞き上手',
        voice_name: partnerVoice
      },
      emergency_contact: {
        family_name: document.getElementById('inputFamilyName').value.trim(),
        relationship: document.getElementById('inputRelationship').value.trim(),
        phone_number: document.getElementById('inputPhoneNumber').value.trim(),
        email: document.getElementById('inputEmail').value.trim()
      }
    };

    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
      if (res.ok) {
        state.currentProfile = updated;
        updateGreetingAndPartnerLabels(updated);
        alert('設定を保存しました！次回の「お話をはじめる」から新しいパートナー・会話相手設定が反映されます。');
        closeCaregiverModal();
      }
    } catch (err) {
      alert(`保存に失敗しました: ${err.message}`);
    }
  }

  async function loadReports() {
    dom.reportsContainer.innerHTML = '<p class="empty-hint">日報を読み込み中...</p>';
    try {
      const res = await fetch('/api/reports');
      const reports = await res.json();
      if (!reports || reports.length === 0) {
        dom.reportsContainer.innerHTML = '<p class="empty-hint">まだ対話日報がありません。対話セッションを完了すると自動生成されます。</p>';
        return;
      }

      dom.reportsContainer.innerHTML = reports.map(r => `
        <div class="report-card">
          <div class="report-header">
            <span class="report-date">📅 ${r.session_date} のご様子</span>
            <span class="report-duration">対話時間: 約 ${r.duration_minutes} 分</span>
          </div>
          <div class="report-body">
            <p><strong>【表情・笑顔】</strong> ${r.smile_score_summary}</p>
            <p><strong>【話題になった思い出】</strong> ${(r.topics_discussed || []).join('、')}</p>
            <p style="margin-top: 8px; color: #2c5e4f; background: #eef5f2; padding: 10px; border-radius: 6px;">
              ${r.caregiver_feedback_note.replace(/\n/g, '<br>')}
            </p>
          </div>
        </div>
      `).join('');
    } catch (err) {
      dom.reportsContainer.innerHTML = `<p class="empty-hint text-danger">日報の取得に失敗しました: ${err.message}</p>`;
    }
  }

  async function loadGallery() {
    dom.galleryGrid.innerHTML = '<p class="empty-hint">絵本を読み込み中...</p>';
    try {
      const res = await fetch('/api/memories');
      const memories = await res.json();
      if (!memories || memories.length === 0) {
        dom.galleryGrid.innerHTML = '<p class="empty-hint">まだ絵画がありません。お話の中で思い出の風景が語られると描かれます。</p>';
        return;
      }

      dom.galleryGrid.innerHTML = memories.map(m => `
        <div class="gallery-card">
          <img src="${m.media_url}" alt="${m.title}" loading="lazy">
          <div class="gallery-card-body">
            <div class="gallery-card-title">${m.title}</div>
            <div class="gallery-card-date">${new Date(m.created_at).toLocaleDateString('ja-JP')}</div>
          </div>
        </div>
      `).join('');
    } catch (err) {
      dom.galleryGrid.innerHTML = `<p class="empty-hint text-danger">ギャラリー取得エラー: ${err.message}</p>`;
    }
  }

  // ============================================================================
  // 動作診断・テストツール
  // ============================================================================
  async function testGenerateSampleVisual() {
    logDiag('水彩画生成テストを開始します...');
    setAvatarState('drawing');
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: 'test_generate_visual' }));
    } else {
      setTimeout(() => {
        displayGeneratedMedia({
          title: '夕暮れの信州松本とりんご畑 (診断テスト)',
          media_url: '/static/memories/placeholder.png',
          media_format: 'image',
          ambient_sound: 'autumn_insects'
        });
        setAvatarState('idle');
      }, 1500);
    }
  }

  async function testEmergencyAlert() {
    logDiag('緊急通報テストを発信します...');
    try {
      const res = await fetch('/api/emergency/test', { method: 'POST' });
      const data = await res.json();
      logDiag(`通報結果:\n${JSON.stringify(data, null, 2)}`);
      alert('緊急通報の疎通テストを完了しました。診断ログをご確認ください。');
    } catch (err) {
      logDiag(`通報テストエラー: ${err.message}`);
    }
  }

  let avatarIndex = 0;
  function testCycleAvatars() {
    const states = ['idle', 'listening', 'speaking', 'drawing'];
    avatarIndex = (avatarIndex + 1) % states.length;
    setAvatarState(states[avatarIndex]);
    logDiag(`アバター状態を手動変更: ${states[avatarIndex]}`);
  }

  function showEmergencyBanner(result) {
    alert(`🚨 【緊急通報が発信されました】\nご家族（${result.contact_person}）へ一斉通知を送信しました。`);
  }

  function updateStatus(message, isActive) {
    dom.statusMessage.textContent = message;
    if (isActive) {
      dom.statusDot.classList.add('active');
    } else {
      dom.statusDot.classList.remove('active');
    }
  }

  function logDiag(text) {
    const timestamp = new Date().toLocaleTimeString();
    dom.diagLog.textContent = `[${timestamp}] ${text}\n` + dom.diagLog.textContent;
  }

  // 起動実行
  document.addEventListener('DOMContentLoaded', init);
})();
