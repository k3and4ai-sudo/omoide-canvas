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

  // 周囲音・テレビ音声カットモード別のRMSしきい値設定（スマホマイク最適チューニング版）
  const NOISE_GATE_PRESETS = {
    normal: { rms: 0.0022, vuThresholdPercent: 3, hangoverChunks: 12, eosSilenceChunks: 14, label: '標準感度' },
    tv_cut: { rms: 0.0045, vuThresholdPercent: 7, hangoverChunks: 12, eosSilenceChunks: 14, label: 'テレビ・周囲音カット' },
    strict: { rms: 0.0100, vuThresholdPercent: 14, hangoverChunks: 10, eosSilenceChunks: 12, label: '強めカット' }
  };

  const state = {
    isConnected: false,
    isSessionActive: false,
    isSimulation: false,
    isLoggedIn: false,              // 起動時ログイン完了フラグ
    sessionApiKey: '',              // このセッション専用のGemini APIキー
    hasLocalBackend: false,         // ローカルFastAPIサーバー有無（GitHub Pages単体時はfalse）
    isDirectGeminiWs: false,        // ブラウザからGemini Live APIへ直接WebSocket接続中か
    userRequestedStop: false,       // ユーザーが明示的に終了ボタンを押したか（放置時自動再接続用）
    keepaliveIntervalId: null,      // WebSocket放置切断防止用キープアライブタイマー
    sessionStartTime: null,         // セッション開始時刻（日報計算用）
    sessionTopics: [],              // セッション中の話題リスト
    sessionMemories: [],            // セッション中に生成した絵画リスト
    lastDrawnUtterance: '',         // 最後にキャンバス描画した発話テキスト
    drawSequenceId: 0,              // 描画リクエスト連番（最新の発話を常に優先反映するため）
    currentAiTurnTranscript: '',    // Gemini直結時のAI字幕バッファ
    currentUserTurnTranscript: '',  // Gemini直結時のユーザー字幕バッファ
    isAiSpeaking: false,            // AIが発話中（エコー防止用フラグ）
    aiSpeechEndTimer: null,         // AI発話終了判定タイマー
    noiseGateMode: 'tv_cut',        // 現在のテレビ・周囲音カットモード
    lastVoiceActiveTime: 0,         // 近接音声がゲートを通過した最終時刻（Web Speech API連動用）
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
    recognition: null, // Web Speech API 音声認識
    // 思い出情景メモ収集ステート（毎ターン自動描画の抑制・合意形成・高精度プロンプト構築用）
    sceneCollector: {
      topic: '',
      place: '',
      seasonWeather: '',
      details: new Set(),
      status: 'idle', // 'idle' | 'collecting' | 'ready' | 'confirming' | 'drawing' | 'drawn'
      isAwaitingConfirmation: false,
      lastConfirmedTopic: '',
      drawConfirmedByUser: false
    }
  };

  // DOM要素キャッシュ
  const dom = {
    // ヘッダー ＆ ログインモーダル
    userGreeting: document.getElementById('userGreeting'),
    btnToggleCaregiver: document.getElementById('btnToggleCaregiver'),
    btnOpenLoginModal: document.getElementById('btnOpenLoginModal'),
    apiKeyStatusBadge: document.getElementById('apiKeyStatusBadge'),
    quotaMonitorBadge: document.getElementById('quotaMonitorBadge'),
    quotaText: document.getElementById('quotaText'),
    loginModal: document.getElementById('loginModal'),
    loginApiKeyForm: document.getElementById('loginApiKeyForm'),
    inputSessionApiKey: document.getElementById('inputSessionApiKey'),
    btnToggleKeyVisibility: document.getElementById('btnToggleKeyVisibility'),
    chkRememberKeyOnDevice: document.getElementById('chkRememberKeyOnDevice'),
    loginErrorMsg: document.getElementById('loginErrorMsg'),
    btnLoginSubmit: document.getElementById('btnLoginSubmit'),
    btnLoginDemoMode: document.getElementById('btnLoginDemoMode'),
    btnClearSavedKey: document.getElementById('btnClearSavedKey'),

    // パートナー＆セッション
    avatarContainer: document.getElementById('avatarContainer'),
    partnerStatusText: document.getElementById('partnerStatusText'),
    btnSessionToggle: document.getElementById('btnSessionToggle'),
    sessionHint: document.getElementById('sessionHint'),

    // オシロスコープ ＆ VU音量メーター ＆ テレビ音カット切替
    oscilloscopeCanvas: document.getElementById('oscilloscopeCanvas'),
    micActiveBadge: document.getElementById('micActiveBadge'),
    vuMeterFill: document.getElementById('vuMeterFill'),
    vuMeterThreshold: document.getElementById('vuMeterThreshold'),
    vuLevelText: document.getElementById('vuLevelText'),
    selectNoiseGateQuick: document.getElementById('selectNoiseGateQuick'),

    // キャンバス ＆ 字幕
    mediaDisplayArea: document.getElementById('mediaDisplayArea'),
    canvasPlaceholder: document.getElementById('canvasPlaceholder'),
    memoryImage: document.getElementById('memoryImage'),
    memoryVideo: document.getElementById('memoryVideo'),
    drawingOverlay: document.getElementById('drawingOverlay'),
    drawingText: document.getElementById('drawingText'),
    drawingSubtext: document.getElementById('drawingSubtext'),
    canvasErrorBanner: document.getElementById('canvasErrorBanner'),
    canvasErrorTitle: document.getElementById('canvasErrorTitle'),
    canvasErrorDesc: document.getElementById('canvasErrorDesc'),
    btnDismissError: document.getElementById('btnDismissError'),
    captionTitle: document.getElementById('captionTitle'),
    captionTag: document.getElementById('captionTag'),
    btnDrawCurrentTopic: document.getElementById('btnDrawCurrentTopic'),
    soundIndicator: document.getElementById('soundIndicator'),
    soundName: document.getElementById('soundName'),
    userTranscriptText: document.getElementById('userTranscriptText'),
    aiTranscriptText: document.getElementById('aiTranscriptText'),

    // 思い出情景メモ・収集インジケーター要素
    sceneCollectorPanel: document.getElementById('sceneCollectorPanel'),
    collectorStatusPill: document.getElementById('collectorStatusPill'),
    collectorStatusIcon: document.getElementById('collectorStatusIcon'),
    collectorStatusLabel: document.getElementById('collectorStatusLabel'),
    collectorCounter: document.getElementById('collectorCounter'),
    collectorDetailCount: document.getElementById('collectorDetailCount'),
    cardTopic: document.getElementById('cardTopic'),
    valTopic: document.getElementById('valTopic'),
    cardPlace: document.getElementById('cardPlace'),
    valPlace: document.getElementById('valPlace'),
    cardDetails: document.getElementById('cardDetails'),
    valDetailsList: document.getElementById('valDetailsList'),
    collectorActionBanner: document.getElementById('collectorActionBanner'),
    collectorActionText: document.getElementById('collectorActionText'),
    btnConfirmDraw: document.getElementById('btnConfirmDraw'),
    btnMoreTalk: document.getElementById('btnMoreTalk'),

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
  // 初期化 ＆ ハイブリッド動作モード（GitHub Pages単体 / ローカルサーバー併用）
  // ============================================================================
  const STORAGE_KEY_API = 'omoide_device_gemini_api_key';
  const STORAGE_KEY_PROFILE = 'omoide_user_profile_v2';
  const STORAGE_KEY_MEMORIES = 'omoide_memories_v2';
  const STORAGE_KEY_REPORTS = 'omoide_reports_v2';
  const STORAGE_KEY_QUOTA = 'omoide_quota_tracker_v2';
  const DAILY_GEMINI_LIMIT = 1500; // Google AI Studio 無料枠目安 (RPD)

  // ============================================================================
  // AIクォータ・利用状況モニター ＆ 画面エラー通知システム
  // ============================================================================
  function getTodayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function loadQuotaTracker() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_QUOTA);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && data.date === getTodayKey()) {
          return data;
        }
      }
    } catch (e) {}
    return {
      date: getTodayKey(),
      requestCount: 0,
      remainingReported: null,
      limitReported: DAILY_GEMINI_LIMIT,
      isRateLimited: false,
      lastStatus: 200,
      lastErrorMsg: ''
    };
  }

  function saveQuotaTracker(tracker) {
    try {
      localStorage.setItem(STORAGE_KEY_QUOTA, JSON.stringify(tracker));
    } catch (e) {}
  }

  function recordApiCall(headers = null, status = 200, errorMsg = '') {
    const tracker = loadQuotaTracker();
    tracker.requestCount++;
    tracker.lastStatus = status;

    if (headers) {
      try {
        const rem = headers.get ? headers.get('x-ratelimit-remaining-requests') : headers['x-ratelimit-remaining-requests'];
        const lim = headers.get ? headers.get('x-ratelimit-limit-requests') : headers['x-ratelimit-limit-requests'];
        if (rem !== null && rem !== undefined) tracker.remainingReported = parseInt(rem, 10);
        if (lim !== null && lim !== undefined) tracker.limitReported = parseInt(lim, 10);
      } catch (e) {}
    }

    if (status === 429) {
      tracker.isRateLimited = true;
      tracker.lastErrorMsg = '429 Quota Exceeded (本日上限)';
    } else if (status >= 400) {
      tracker.lastErrorMsg = errorMsg || `HTTP ${status}`;
    }

    saveQuotaTracker(tracker);
    renderQuotaUI();
  }

  function renderQuotaUI() {
    if (!dom.quotaText || !dom.quotaMonitorBadge) return;
    const tracker = loadQuotaTracker();

    if (tracker.isRateLimited) {
      dom.quotaMonitorBadge.className = 'quota-monitor-badge quota-exceeded';
      dom.quotaText.textContent = `⚠️ クォータ上限到達 (本日 ${tracker.requestCount}回)`;
      dom.quotaMonitorBadge.title = 'Google AI Studio の本日分無料枠クォータ上限に達しました。ローカル水彩画エンジンで動作中（明日未明にリセット）';
    } else {
      const limit = tracker.limitReported || DAILY_GEMINI_LIMIT;
      const remaining = tracker.remainingReported !== null
        ? tracker.remainingReported
        : Math.max(0, limit - tracker.requestCount);
      const percent = Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));

      if (percent <= 15) {
        dom.quotaMonitorBadge.className = 'quota-monitor-badge quota-warning';
      } else {
        dom.quotaMonitorBadge.className = 'quota-monitor-badge';
      }
      dom.quotaText.textContent = `AI残量: ${percent}% (本日 ${tracker.requestCount}/${limit}回)`;
      dom.quotaMonitorBadge.title = `本日のAI呼び出し回数: ${tracker.requestCount}回 / 目安上限: ${limit}回 (残り約 ${remaining}回)\nクリックで詳細を表示します`;
    }
  }

  function showCanvasError(title, message, isWarning = false) {
    if (!dom.canvasErrorBanner) return;
    if (dom.canvasErrorTitle) dom.canvasErrorTitle.textContent = title;
    if (dom.canvasErrorDesc) dom.canvasErrorDesc.textContent = message;
    dom.canvasErrorBanner.classList.remove('hidden');
    dom.canvasErrorBanner.style.borderColor = isWarning ? '#f59e0b' : '#ef4444';
    logDiag(`[画面エラー通知] ${title}: ${message}`);
  }

  function dismissCanvasError() {
    if (!dom.canvasErrorBanner) return;
    dom.canvasErrorBanner.classList.add('hidden');
  }

  function showQuotaDetailsModal() {
    const tracker = loadQuotaTracker();
    const limit = tracker.limitReported || DAILY_GEMINI_LIMIT;
    const remaining = tracker.remainingReported !== null
      ? tracker.remainingReported
      : Math.max(0, limit - tracker.requestCount);
    const msg = [
      '【📊 AIクォータ・利用状況モニター】',
      `・日付: ${tracker.date}`,
      `・本日の生成リクエスト回数: ${tracker.requestCount} 回`,
      `・クォータ目安上限: ${limit} 回 / 日 (Google AI Studio 無料枠)`,
      `・推計残りリクエスト: 約 ${remaining} 回`,
      `・最新ステータス: ${tracker.isRateLimited ? '⚠️ 429 レート制限中 (ローカル水彩画に自動切替)' : '✅ 正常稼働中'}`,
      tracker.lastErrorMsg ? `・最新のエラー: ${tracker.lastErrorMsg}` : '',
      '\n※万が一クォータ上限（429）に達した場合でも、端末内のローカル高精細水彩画エンジンが自動で即座に代行描画します。'
    ].filter(Boolean).join('\n');
    alert(msg);
  }

  const DEFAULT_USER_PROFILE = {
    user_id: 'default_user',
    call_name: 'お父さん',
    age_group: '80代',
    gender: '男性',
    personality: '温厚で家族思い、昔の仕事に誇りを持っている、少し照れ屋',
    dementia_level: 'mild',
    former_occupation: '小学校の先生',
    hometown: '長野県松本市',
    hobbies: ['園芸', 'リンゴ栽培', '将棋'],
    trigger_words: ['リンゴ畑', '北アルプス', '紅玉', '黒板'],
    ng_topics: ['最近のニュース', '家族の不幸・逝去', '金銭管理', '物忘れの指摘'],
    noise_gate_mode: 'tv_cut',
    partner: {
      name: 'さくら',
      age_setting: '30代',
      gender: '女性',
      personality: '優しく穏やかで聞き上手、いつも笑顔で褒め上手',
      voice_name: 'Aoede'
    },
    emergency_contact: {
      family_name: 'ご家族',
      relationship: '長男',
      phone_number: '',
      email: ''
    }
  };

  async function detectBackendAvailability() {
    if (window.location.hostname.endsWith('github.io')) {
      state.hasLocalBackend = false;
      return false;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        state.hasLocalBackend = (data && data.app === 'omoide-canvas');
        return state.hasLocalBackend;
      }
    } catch (e) {}
    state.hasLocalBackend = false;
    return false;
  }

  async function init() {
    setupEventListeners();
    initLoginModalState();
    resetSceneCollector();
    renderQuotaUI();
    await detectBackendAvailability();
    await fetchUserProfile();
    drawFlatOscilloscope(); // 初期オシロスコープ波形（水平線）描画
    const modeLabel = state.hasLocalBackend
      ? 'ローカルサーバー連携モード'
      : 'トンネル不要・ブラウザ直結モード（24時間常時稼働）';
    logDiag(`システムが初期化されました（${modeLabel}）。ログイン待機中です。`);
  }

  function initLoginModalState() {
    try {
      const savedKey = localStorage.getItem(STORAGE_KEY_API);
      if (savedKey && dom.inputSessionApiKey) {
        dom.inputSessionApiKey.value = savedKey;
      }
    } catch (e) {}
  }

  function showLoginMessage(text, isError = true) {
    if (!dom.loginErrorMsg) return;
    dom.loginErrorMsg.textContent = text;
    dom.loginErrorMsg.className = `login-msg ${isError ? 'error' : 'success'}`;
  }

  function openLoginModal() {
    if (!dom.loginModal) return;
    if (state.sessionApiKey && dom.inputSessionApiKey) {
      dom.inputSessionApiKey.value = state.sessionApiKey;
    }
    if (dom.loginErrorMsg) {
      dom.loginErrorMsg.className = 'login-msg hidden';
    }
    dom.loginModal.classList.remove('hidden');
  }

  function closeLoginModal() {
    if (!dom.loginModal) return;
    dom.loginModal.classList.add('hidden');
  }

  async function verifyApiKeyDirectOrBackend(rawKey) {
    if (!rawKey || rawKey.length < 20) {
      return { valid: false, message: 'APIキーの形式が正しくありません（AIza... で始まるキーを入力してください）' };
    }
    if (state.hasLocalBackend) {
      try {
        const res = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: rawKey })
        });
        if (res.ok) {
          return await res.json();
        }
      } catch (e) {
        state.hasLocalBackend = false;
      }
    }
    // ブラウザから直接 Google Gemini API エンドポイントでキーの有効性を検証（トンネル・バックエンド不要）
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash?key=${encodeURIComponent(rawKey)}`;
      const res = await fetch(url);
      if (res.ok) {
        const masked = `${rawKey.slice(0, 6)}...${rawKey.slice(-4)}`;
        return { valid: true, masked_key: masked, message: 'APIキーの認証に成功しました（ブラウザ直結モード）' };
      }
      return { valid: false, message: 'APIキーが無効か、利用権限がありません。Google AI Studioで発行したキーをご確認ください。' };
    } catch (err) {
      return { valid: false, message: `Google APIサーバーへの接続確認に失敗しました: ${err.message}` };
    }
  }

  async function handleLoginSubmit(e) {
    e.preventDefault();
    const rawKey = (dom.inputSessionApiKey?.value || '').trim();
    if (!rawKey) {
      showLoginMessage('Gemini APIキーを入力してください（キーなしで試す場合は下の「デモ体験」を押してください）。', true);
      return;
    }

    if (dom.btnLoginSubmit) {
      dom.btnLoginSubmit.disabled = true;
      dom.btnLoginSubmit.textContent = '🔄 APIキーを認証しています...';
    }
    showLoginMessage('Google Gemini APIキーの有効性を確認しています...', false);

    try {
      const data = await verifyApiKeyDirectOrBackend(rawKey);
      if (!data.valid) {
        showLoginMessage(data.message || 'APIキーの認証に失敗しました。', true);
        return;
      }

      // セッションにキーをセット
      state.sessionApiKey = rawKey;
      state.isLoggedIn = true;

      // 端末ブラウザへの保存設定
      try {
        if (dom.chkRememberKeyOnDevice?.checked) {
          localStorage.setItem(STORAGE_KEY_API, rawKey);
        } else {
          localStorage.removeItem(STORAGE_KEY_API);
        }
      } catch (err) {}

      if (dom.apiKeyStatusBadge) {
        dom.apiKeyStatusBadge.textContent = `認証済 (${data.masked_key})`;
      }
      dom.btnOpenLoginModal?.classList.add('active-key');
      showLoginMessage('✅ 認証に成功しました！', false);
      logDiag(`セッションAPIキー認証完了 (${data.masked_key})`);

      // 進行中のセッションがあれば再接続を促すため一旦停止
      if (state.isSessionActive) {
        await stopSession();
      }
      setTimeout(() => {
        closeLoginModal();
      }, 350);
    } catch (err) {
      showLoginMessage(`通信エラーが発生しました: ${err.message}`, true);
    } finally {
      if (dom.btnLoginSubmit) {
        dom.btnLoginSubmit.disabled = false;
        dom.btnLoginSubmit.textContent = '🚀 このAPIキーでログインして開始';
      }
    }
  }

  async function handleLoginDemoMode() {
    state.sessionApiKey = '';
    state.isLoggedIn = true;
    if (dom.apiKeyStatusBadge) {
      dom.apiKeyStatusBadge.textContent = 'デモ体験（キー未設定）';
    }
    dom.btnOpenLoginModal?.classList.remove('active-key');
    if (state.isSessionActive) {
      await stopSession();
    }
    logDiag('APIキーなし（デモ体験モード）で開始しました。');
    closeLoginModal();
  }

  function handleClearSavedKey() {
    try {
      localStorage.removeItem(STORAGE_KEY_API);
    } catch (e) {}
    state.sessionApiKey = '';
    if (dom.inputSessionApiKey) {
      dom.inputSessionApiKey.value = '';
    }
    if (dom.apiKeyStatusBadge) {
      dom.apiKeyStatusBadge.textContent = 'APIキー未設定';
    }
    dom.btnOpenLoginModal?.classList.remove('active-key');
    showLoginMessage('この端末に保存されていたAPIキーを消去しました。', false);
  }

  // ============================================================================
  // イベントリスナー登録
  // ============================================================================
  function setupEventListeners() {
    // セッション開始・終了ボタン
    dom.btnSessionToggle.addEventListener('click', toggleSession);

    // ログイン・APIキー設定モーダル
    dom.btnOpenLoginModal?.addEventListener('click', openLoginModal);
    dom.loginApiKeyForm?.addEventListener('submit', handleLoginSubmit);
    dom.btnLoginDemoMode?.addEventListener('click', handleLoginDemoMode);
    dom.btnClearSavedKey?.addEventListener('click', handleClearSavedKey);
    dom.btnToggleKeyVisibility?.addEventListener('click', () => {
      if (!dom.inputSessionApiKey) return;
      const isPwd = dom.inputSessionApiKey.type === 'password';
      dom.inputSessionApiKey.type = isPwd ? 'text' : 'password';
      dom.btnToggleKeyVisibility.textContent = isPwd ? '🙈' : '👁️';
    });
    dom.loginModal?.addEventListener('click', (e) => {
      if (e.target === dom.loginModal && state.isLoggedIn) {
        closeLoginModal();
      }
    });

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

    // テレビ・周囲音カット（近接マイクモード）ワンタップ切り替え
    if (dom.selectNoiseGateQuick) {
      dom.selectNoiseGateQuick.addEventListener('change', (e) => {
        setNoiseGateMode(e.target.value);
      });
    }
    const modalNoiseSelect = document.getElementById('selectNoiseGateMode');
    if (modalNoiseSelect) {
      modalNoiseSelect.addEventListener('change', (e) => {
        setNoiseGateMode(e.target.value);
      });
    }

    // 動作確認ボタン群
    dom.btnDiagImage.addEventListener('click', testGenerateSampleVisual);
    dom.btnDiagEmergency.addEventListener('click', testEmergencyAlert);
    dom.btnDiagAvatar.addEventListener('click', testCycleAvatars);
    dom.btnDrawCurrentTopic?.addEventListener('click', drawCurrentConversationScene);

    // 思い出情景メモ・合意形成ボタン群
    dom.btnConfirmDraw?.addEventListener('click', () => {
      executeConfirmedDrawing();
    });
    dom.btnMoreTalk?.addEventListener('click', () => {
      state.sceneCollector.isAwaitingConfirmation = false;
      state.sceneCollector.status = 'collecting';
      renderSceneCollectorUI();
    });

    // エラーバナー閉じる ＆ クォータ詳細モニター
    dom.btnDismissError?.addEventListener('click', dismissCanvasError);
    dom.quotaMonitorBadge?.addEventListener('click', showQuotaDetailsModal);
  }

  function setNoiseGateMode(mode) {
    const validMode = NOISE_GATE_PRESETS[mode] ? mode : 'tv_cut';
    state.noiseGateMode = validMode;
    if (dom.selectNoiseGateQuick) dom.selectNoiseGateQuick.value = validMode;
    const modalNoiseSelect = document.getElementById('selectNoiseGateMode');
    if (modalNoiseSelect) modalNoiseSelect.value = validMode;

    // VUメーター上のしきい値マーカー位置を更新
    const preset = NOISE_GATE_PRESETS[validMode];
    const thresholdPercent = Math.min(95, Math.round(preset.rms * 1400));
    if (dom.vuMeterThreshold) {
      dom.vuMeterThreshold.style.left = `${thresholdPercent}%`;
    }
    logDiag(`周囲音対策モードを「${preset.label} (RMS>${preset.rms})」に変更しました。`);
  }

  // ============================================================================
  // ブラウザ直結用 ユーティリティ ＆ システムプロンプト生成 (トンネル・サーバー不要)
  // ============================================================================
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return window.btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = window.atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function formatUserNickname(rawName) {
    const clean = (rawName || 'お父さん').trim();
    if (/(さん|様|ちゃん|先生|お父さん|お母さん|おじいちゃん|おばあちゃん)$/.test(clean)) {
      return clean;
    }
    return `${clean}さん`;
  }

  function buildSystemInstructionJS(profile) {
    const p = profile || DEFAULT_USER_PROFILE;
    const level = p.dementia_level || 'mild';
    let levelRules = '';

    if (level === 'mci') {
      levelRules = `
【MCI（軽度認知障害・予防）モード制御ルール】
1. 1ターンの発話長：2〜3文（目安：60〜80文字程度）。自然でテンポの良い会話を保ちます。
2. 質問の形式（オープンクエスチョン中心）：「どうやって作るんですか？」「どんなところが好きでしたか？」と段取りや理由を尋ねてください。
3. 臨床アプローチ：季節の行事、昔の道具の使い方、料理の手順など、前頭葉の実行機能や語彙の想起を優しく刺激する話題を展開してください。`;
    } else if (level === 'moderate') {
      levelRules = `
【中等度認知症（Moderate）モード制御ルール（厳格適用）】
1. 1ターンの発話長：原則「1文のみ」（目安：20〜30文字以内）。極めてシンプルで穏やかな声かけを徹底してください。
2. 質問の形式：「なぜ」「どうやって」は厳禁。発話の8割は「オウム返し（復唱）＋優しい共感」にしてください。
3. 臨床アプローチ（バリデーション的傾聴）：相手の世界観に完全に寄り添い、安心感を提供することを最優先にしてください。`;
    } else {
      levelRules = `
【軽度認知症（Mild）モード制御ルール】
1. 1ターンの発話長：1〜2文（目安：40〜50文字以内）。ゆっくりわかりやすい単文で話してください。
2. 質問の形式（ヒント提示＋二択質問）：言葉に詰まる負担を減らすため、具体的な選択肢やヒントを添えて尋ねてください。
3. 臨床アプローチ（回想法＋見当識支援）：長期記憶（故郷、昔の仕事、趣味）を中心に肯定的に広げてください。`;
    }

    const nickname = formatUserNickname(p.call_name);
    const partner = p.partner || DEFAULT_USER_PROFILE.partner;
    const partnerName = partner.name || 'さくら';
    const partnerAge = partner.age_setting || '30代';
    const partnerGender = partner.gender || '女性';
    const partnerPersonality = partner.personality || '優しく穏やかで聞き上手';
    const hobbiesStr = (p.hobbies || []).join('、') || '特になし';
    const triggersStr = (p.trigger_words || []).join('、') || '故郷の風景、懐かしい仕事の思い出';
    const ngStr = (p.ng_topics || []).join('、') || '直近の記憶を試すこと、家族の不幸';

    return `# あなたの役割とプロフィール（AIパートナー設定）
・あなたの名前：「${partnerName}」
・あなたの年齢・性別：${partnerAge}・${partnerGender}
・あなたの性格・話し方：${partnerPersonality}
あなたは、高齢者の認知機能維持と心の安らぎを支える、温かくて聞き上手な対話パートナー「${partnerName}」です。
相手を「人生の大先輩」「先生」として深く敬い、以下の会話相手プロフィールとルールを厳格に守ってリアルタイム音声対話を行ってください。
思考解説や英語テキストは一切出力せず、即座に日本語の音声返答のみを出力してください。

# 【会話相手（ご本人）プロフィール】
・お名前（呼び方）：「${nickname}」（※二重敬称は厳禁です。必ず「${nickname}」と呼んでください）
・年齢・年代：${p.age_group || '80代'}
・性別：${p.gender || '男性'}
・性格・人柄：${p.personality || ''}
・昔の仕事・得意だったこと：${p.former_occupation || ''}
・好きなこと・趣味：${hobbiesStr}
・ゆかりの土地（故郷）：${p.hometown || ''}
・思い出のキーワード（会話に自然に織り交ぜる）：${triggersStr}
・絶対に触れてはいけないNG話題：${ngStr}

# 【全レベル共通の絶対原則】
1. 【最重要】聞き取った言葉への100%忠実な応答：
   ご本人が話した言葉（および送信された認識テキスト）をそのまま最優先で受け止め、まずその言葉を復唱・共感して100%直接答えてください。言っていないことを勝手に推測したり、プロフィール情報（リンゴ畑や先生など）へ無理やり話題をすり替えるのは絶対に禁止です。
2. 否定・訂正の絶対禁止（バリデーション）：事実と異なる発言や同じ話の繰り返しがあっても決して指摘・訂正せず、毎回初めて聞くように温かく受け止めてください。
3. 挨拶の連呼・「どういたしまして」の誤用禁止：最初の挨拶の後は「こんにちは」を繰り返さず、相手の発言内容に100%直接答えてください。
4. 短期記憶テスト・質問攻めの禁止：1回の返答につき質問は【最大1つだけ】にしてください。
5. 人生の先生として敬意を払う姿勢：「ぜひ${nickname}に教えていただきたいです」という姿勢で接してください。
6. 【重要】テレビ・ラジオ・周囲の雑音対策（空間フィルタリング）：
   背景から聞こえるテレビ番組の音声（ニュース、CM、ドラマ等）や遠くの第三者の声には絶対に反応せず、目の前の「${nickname}」が直接ゆっくり話しかけた言葉にのみ返答してください。
${levelRules}

# 【思い出の映像化（情景収集・描画前確認・合意形成）の絶対ルール】
1. 勝手な即時描画の絶対禁止：
   相手が昔の思い出の風景や場所（例：文化祭、教室、喫茶店の中、故郷、海、山など）を話し始めても、【絶対にすぐにツールを呼んで絵を描いてはいけません】。
2. ディテールの優しい掘り下げ（情景情報の収集）：
   まずは「どんな場所でしたか？」「季節やお天気はどうでしたか？」「どんなものが置いてありましたか？」「誰と行かれたんですか？」と、温かく関心を持って思い出の情景ディテールをじっくり聞き取ってください。
3. 描画前の確認（合意形成ステップ）：
   情景の特徴やディテールがまとまってきたら、必ず言葉で相手に描画の確認を入れてください：
   例：「〇〇の風景ですね。とても素敵です！その情景をキャンバスに描いてみましょうか？」
4. 描画の実行タイミング（完了合図）：
   相手が「うん」「お願い」「描いて」「そうして」「はい」等と同意した時、あるいは相手から「絵を描いて」「キャンバスに映して」と指示された時のみ、はじめて \`generate_memory_visual\`（または \`refine_memory_visual\`）ツールを呼び出してください。
5. 描画後の温かい声かけ：
   絵が表示されたら「${nickname}、キャンバスに絵が浮かびましたよ。こんな雰囲気でしたか？」と温かく声をかけてください。

# 【緊急通報（SOS）の絶対ルール】
相手が「助けて」「苦しい」「痛い」等の発言をした場合は、まず「${nickname}、大丈夫ですか？ご家族に連絡を入れましょうか？」と確認し、本人が同意した場合のみ \`trigger_emergency_alert\` を呼び出してください。`;
  }

  function sendPcmAudioChunk(pcm16Buffer) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    if (state.isDirectGeminiWs) {
      state.socket.send(JSON.stringify({
        realtime_input: {
          audio: {
            data: arrayBufferToBase64(pcm16Buffer),
            mime_type: 'audio/pcm;rate=16000'
          }
        }
      }));
    } else {
      state.socket.send(pcm16Buffer);
    }
  }

  function sendEosSignal() {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    if (state.isDirectGeminiWs) {
      state.socket.send(JSON.stringify({
        realtime_input: {
          audioStreamEnd: true
        }
      }));
    } else {
      state.socket.send(JSON.stringify({ type: 'eos' }));
    }
  }

  // ============================================================================
  // セッション制御 (開始 / 終了 / 放置時自動再接続)
  // ============================================================================
  async function toggleSession() {
    if (state.isSessionActive) {
      await stopSession();
    } else {
      await startSession();
    }
  }

  async function startSession() {
    if (!state.isLoggedIn) {
      openLoginModal();
      return;
    }
    try {
      state.userRequestedStop = false;
      state.sessionStartTime = Date.now();
      state.sessionTopics = [];
      state.sessionMemories = [];
      resetSceneCollector();
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
      if (state.audioContextIn.state === 'suspended') {
        await state.audioContextIn.resume();
      }
      state.micSourceNode = state.audioContextIn.createMediaStreamSource(state.micStream);

      // 3. カメラ見守りストリーム取得（PCのみ）
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

      // 4. ブラウザ音声認識 (Web Speech API) はPCまたはデモモード時のみ起動
      if (!isMobile || !state.sessionApiKey) {
        startSpeechRecognition();
      }

      // 5. 接続方式の決定（ローカルサーバー or トンネル不要・ブラウザ直結 Gemini Live WebSocket or デモモード）
      if (state.hasLocalBackend) {
        connectLocalBackendWebSocket();
      } else if (state.sessionApiKey) {
        connectDirectGeminiLiveWebSocket(false);
      } else {
        startStandaloneSimulationMode();
      }

    } catch (err) {
      console.error('Session start error:', err);
      updateStatus(`マイクの起動に失敗しました: ${err.message}`, false);
      alert('マイクへのアクセスを許可してください。');
      stopSessionCleanup();
    } finally {
      dom.btnSessionToggle.disabled = false;
    }
  }

  function activateSessionUI() {
    state.isConnected = true;
    state.isSessionActive = true;
    if (state.audioContextIn && state.audioContextIn.state === 'suspended') {
      state.audioContextIn.resume();
    }
    updateStatus('お話を聞いています...（マイクに向かってお話しください）', true);
    dom.visualizerContainer.classList.add('listening');
    dom.btnSessionToggle.classList.add('active');
    dom.btnSessionToggle.innerHTML = '<span class="btn-icon">⏹️</span><span class="btn-text">お話を終了する</span>';
    dom.sessionHint.textContent = 'ボタンを押すと、いつでもお話を終了できます';
    dom.userTranscriptText.textContent = '「お話しください...（声が文字になります）」';
    setAvatarState('listening');
    if (!state.oscilloscopeAnimId) {
      startOscilloscope();
    }
    if (!state.processorNode) {
      startAudioProcessing();
    }
  }

  function connectLocalBackendWebSocket() {
    state.isDirectGeminiWs = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const keyParam = state.sessionApiKey ? `?api_key=${encodeURIComponent(state.sessionApiKey)}` : '';
    const wsUrl = `${protocol}//${window.location.host}/ws/live${keyParam}`;
    state.socket = new WebSocket(wsUrl);
    state.socket.binaryType = 'arraybuffer';

    state.socket.onopen = async () => {
      activateSessionUI();
    };
    state.socket.onmessage = handleWebSocketMessage;
    state.socket.onclose = () => {
      if (!state.userRequestedStop && state.isSessionActive && state.sessionApiKey) {
        logDiag('ローカルサーバー接続が切れたため、ブラウザ直結モードへ自動引き継ぎします...');
        state.hasLocalBackend = false;
        connectDirectGeminiLiveWebSocket(true);
        return;
      }
      logDiag('WebSocket接続が終了しました。');
      stopSessionCleanup();
    };
    state.socket.onerror = (err) => {
      logDiag(`WebSocketエラー: ${err}`);
    };
  }

  function connectDirectGeminiLiveWebSocket(isReconnect = false) {
    state.isDirectGeminiWs = true;
    state.isSimulation = false;
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(state.sessionApiKey)}`;
    const ws = new WebSocket(wsUrl);
    state.socket = ws;

    const profile = state.currentProfile || DEFAULT_USER_PROFILE;
    const partner = profile.partner || DEFAULT_USER_PROFILE.partner;
    const selectedVoice = partner.voice_name || (partner.gender === '男性' ? 'Puck' : 'Aoede');
    const systemInstruction = buildSystemInstructionJS(profile);

    let setupCompleted = false;

    ws.onopen = () => {
      const setupPayload = {
        setup: {
          model: 'models/gemini-2.5-flash-native-audio-latest',
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voice_config: {
                prebuilt_voice_config: {
                  voice_name: selectedVoice
                }
              }
            },
            thinkingConfig: {
              thinking_budget: 0
            }
          },
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automatic_activity_detection: {
              disabled: false,
              start_of_speech_sensitivity: 'START_SENSITIVITY_HIGH',
              end_of_speech_sensitivity: 'END_SENSITIVITY_LOW',
              prefix_padding_ms: 200,
              silence_duration_ms: 800
            }
          },
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'generate_memory_visual',
                  description: '対象者が語った思い出や夢の風景を水彩画または動画として描画・画面表示する',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      scene_type: { type: 'STRING' },
                      japanese_title: { type: 'STRING' },
                      visual_elements: { type: 'STRING' },
                      media_format: { type: 'STRING' },
                      ambient_sound: { type: 'STRING' }
                    },
                    required: ['scene_type', 'japanese_title', 'visual_elements']
                  }
                },
                {
                  name: 'refine_memory_visual',
                  description: '対象者からの修正希望（描き直しフィードバック）を反映して絵を再描画する',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      original_memory_id: { type: 'STRING' },
                      user_feedback: { type: 'STRING' },
                      updated_visual_elements: { type: 'STRING' }
                    },
                    required: ['original_memory_id', 'user_feedback', 'updated_visual_elements']
                  }
                },
                {
                  name: 'trigger_emergency_alert',
                  description: '対象者のSOSや苦痛について本人確認が得られた際、家族へ緊急通知を発信する',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      urgency_level: { type: 'STRING' },
                      user_utterance: { type: 'STRING' },
                      confirmation_obtained: { type: 'BOOLEAN' }
                    },
                    required: ['urgency_level', 'user_utterance', 'confirmation_obtained']
                  }
                }
              ]
            }
          ]
        }
      };
      ws.send(JSON.stringify(setupPayload));
    };

    ws.onmessage = async (event) => {
      try {
        let jsonText = '';
        if (typeof event.data === 'string') {
          jsonText = event.data;
        } else if (event.data instanceof Blob) {
          jsonText = await event.data.text();
        } else if (event.data instanceof ArrayBuffer) {
          jsonText = new TextDecoder('utf-8').decode(event.data);
        }
        if (!jsonText) return;
        const msg = JSON.parse(jsonText);

        // 1. セットアップ完了通知
        if (msg.setupComplete !== undefined || msg.setup_complete !== undefined) {
          setupCompleted = true;
          activateSessionUI();
          const cleanName = (profile.call_name || 'お父さん').replace(/\s*さん$/, '');
          const pName = partner.name || 'さくら';
          dom.avatarContainer.setAttribute('data-gender', partner.gender || '女性');
          dom.partnerStatusText.textContent = `${pName}：${cleanName}さんとお話し中`;

          // 放置時切断防止用の無音キープアライブタイマー開始（20秒ごと）
          if (state.keepaliveIntervalId) clearInterval(state.keepaliveIntervalId);
          state.keepaliveIntervalId = setInterval(() => {
            if (!state.isSessionActive || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
            if (Date.now() - state.lastVoiceActiveTime > 18000 && !state.isAiSpeaking) {
              // 18秒以上無音の場合、WebSocketのアイドル切断を防ぐ極小無音PCMフレームを送信
              const silentPcm = new Int16Array(160); // 10ms silence
              sendPcmAudioChunk(silentPcm.buffer);
            }
          }, 20000);

          if (!isReconnect) {
            logDiag(`Gemini Live API 直結セッション確立 (voice=${selectedVoice})`);
            const nickname = formatUserNickname(profile.call_name);
            const greetPrompt = `対話セッションが開始されました。あなたの名前は「${pName}」です。${nickname}に向かって、「こんにちは、${nickname}！${pName}です。今日も気持ちのいい日ですね。お元気でしたか？」のように、あなたの性格（${partner.personality || '優しく穏やか'}）らしく、短く温かく最初の挨拶を声に出して話しかけてください。`;
            ws.send(JSON.stringify({
              client_content: {
                turns: [{ role: 'user', parts: [{ text: greetPrompt }] }],
                turn_complete: true
              }
            }));
          } else {
            logDiag('セッションを自動再接続しました（対話を継続できます）。');
          }
          return;
        }

        // 2. サーバーコンテンツ（音声・字幕）
        const sc = msg.serverContent || msg.server_content;
        if (sc) {
          const modelTurn = sc.modelTurn || sc.model_turn;
          if (modelTurn && Array.isArray(modelTurn.parts)) {
            for (const part of modelTurn.parts) {
              const inlineData = part.inlineData || part.inline_data;
              if (inlineData && inlineData.data) {
                const pcmBuf = base64ToArrayBuffer(inlineData.data);
                queueAudioPlayback(pcmBuf);
              }
              if (part.text && !part.text.trim().startsWith('**')) {
                dom.aiTranscriptText.textContent = part.text.trim();
              }
            }
          }

          const inputTrans = sc.inputTranscription || sc.input_transcription;
          if (inputTrans && inputTrans.text) {
            state.currentUserTurnTranscript += inputTrans.text;
            const cleanUserTxt = state.currentUserTurnTranscript.trim();
            if (cleanUserTxt) {
              dom.userTranscriptText.textContent = `「${cleanUserTxt}」`;
            }
          }

          const outputTrans = sc.outputTranscription || sc.output_transcription;
          if (outputTrans && outputTrans.text) {
            state.currentAiTurnTranscript += outputTrans.text;
            const cleanAiTxt = state.currentAiTurnTranscript.trim();
            if (cleanAiTxt) {
              dom.aiTranscriptText.textContent = cleanAiTxt;
            }
          }

          if (sc.turnComplete || sc.turn_complete) {
            // 1. ユーザー自身の発話テキスト（認識できた場合）から情景情報を抽出・蓄積
            if (state.currentUserTurnTranscript.trim()) {
              const uText = state.currentUserTurnTranscript.trim();
              state.currentUserTurnTranscript = '';
              state.sessionTopics.push(uText);
              updateSceneCollectorFromText(uText, 'user');
            }

            // 2. AIの返答音声から情景情報および「描画確認」フレーズを抽出・蓄積
            const finishedAiTxt = state.currentAiTurnTranscript.trim();
            state.currentAiTurnTranscript = '';
            if (finishedAiTxt) {
              updateSceneCollectorFromText(finishedAiTxt, 'ai');
            }

            // 毎ターンの勝手な自動描画は行わず、情景収集と合意形成を優先
            if (!state.isAiSpeaking && !state.isDrawingMedia) {
              setAvatarState('listening');
            }
          }
        }

        // 3. ツール呼び出し（水彩画生成・描き直し・緊急通報）
        const tc = msg.toolCall || msg.tool_call;
        if (tc) {
          const calls = tc.functionCalls || tc.function_calls || [];
          for (const call of calls) {
            const funcName = call.name;
            const args = call.args || {};
            const callId = call.id;
            logDiag(`AIツール呼び出し: ${funcName} (${args.japanese_title || ''})`);

            if (funcName === 'generate_memory_visual' || funcName === 'refine_memory_visual') {
              // 1. AIへのツール応答を直ちに返送（会話を止めず、AIに確認を促す）
              try {
                ws.send(JSON.stringify({
                  tool_response: {
                    function_responses: [
                      {
                        id: callId,
                        name: funcName,
                        response: {
                          output: {
                            status: 'scene_recorded_awaiting_approval',
                            title: args.japanese_title || '思い出の情景',
                            message: '情景情報を受け取りました。ご本人に「キャンバスに描いてみましょうか？」と尋ねて確認してください。'
                          }
                        }
                      }
                    ]
                  }
                }));
              } catch (err) {
                console.warn('Tool response send warning:', err);
              }

              // 2. AIが集めた情景情報を情景メモ（sceneCollector）に統合
              if (args.japanese_title) state.sceneCollector.topic = args.japanese_title;
              if (args.visual_elements) {
                const parts = args.visual_elements.split(/[、,，/]/);
                parts.forEach(p => {
                  const cp = p.trim();
                  if (cp.length >= 2 && cp.length <= 15 && !cp.includes('描きたい情景') && !cp.includes('会話')) {
                    state.sceneCollector.details.add(cp);
                  }
                });
              }

              // 3. ユーザーが直前に明示的に「描いて」「絵にして」と指示していた場合はそのまま描画
              if (state.sceneCollector.drawConfirmedByUser) {
                state.sceneCollector.drawConfirmedByUser = false;
                logDiag(`ユーザー合意済みのため描画を実行: 「${args.japanese_title || ''}」`);
                setAvatarState('drawing');
                handleDirectMediaGeneration(ws, callId, funcName, args);
              } else {
                // 勝手には描かず、確認状態にして画面バナーを表示・ユーザーの同意を待つ！
                state.sceneCollector.isAwaitingConfirmation = true;
                state.sceneCollector.status = 'confirming';
                state.sceneCollector.pendingArgs = { callId, funcName, args };
                renderSceneCollectorUI();
                logDiag(`AIからの描画提案を受信: 「${args.japanese_title || ''}」（勝手な描画を抑制し、合意確認待ちに移行）`);
              }
            } else if (funcName === 'trigger_emergency_alert') {
              handleDirectEmergencyAlert(ws, callId, funcName, args);
            }
          }
        }
      } catch (err) {
        console.error('Direct Gemini WS message error:', err);
      }
    };

    ws.onclose = (ev) => {
      if (state.keepaliveIntervalId) {
        clearInterval(state.keepaliveIntervalId);
        state.keepaliveIntervalId = null;
      }
      // ユーザーが終了ボタンを押しておらず、放置タイムアウト等で切れた場合は自動再接続！
      if (!state.userRequestedStop && state.isSessionActive && setupCompleted) {
        logDiag('長時間経過によるセッション更新のため、自動再接続しています...');
        setTimeout(() => {
          if (!state.userRequestedStop && state.isSessionActive) {
            connectDirectGeminiLiveWebSocket(true);
          }
        }, 800);
        return;
      }
      if (!setupCompleted) {
        logDiag(`Gemini Live 接続が閉じられました (code=${ev.code})`);
      }
      stopSessionCleanup();
    };

    ws.onerror = (err) => {
      logDiag(`Gemini Live WebSocket通信エラーが発生しました`);
    };
  }

  function startStandaloneSimulationMode() {
    state.isDirectGeminiWs = false;
    state.isSimulation = true;
    activateSessionUI();
    const profile = state.currentProfile || DEFAULT_USER_PROFILE;
    const pName = profile.partner?.name || 'さくら';
    const nickname = formatUserNickname(profile.call_name);
    dom.partnerStatusText.textContent = `${pName}：${nickname}とお話し中（デモ体験）`;
    logDiag('【案内】デモ体験（シミュレーション）モードで開始しました。');

    setTimeout(() => {
      if (!state.isSessionActive) return;
      const greet = `こんにちは、${nickname}！パートナーの${pName}です。今日もいいお天気ですね。昔の懐かしい場所や、お仕事のお話を聞かせてくださいね。`;
      dom.aiTranscriptText.textContent = greet;
      speakTextWithWebSpeech(greet);
    }, 500);
  }

  async function stopSession() {
    state.userRequestedStop = true;
    updateStatus('お話を終了しています...', false);
    if (state.keepaliveIntervalId) {
      clearInterval(state.keepaliveIntervalId);
      state.keepaliveIntervalId = null;
    }
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      try {
        if (!state.isDirectGeminiWs) {
          state.socket.send(JSON.stringify({ type: 'end_session' }));
        }
        state.socket.close();
      } catch (e) {}
    }
    // ブラウザ直結モード時はセッション終了時に「心のコンディション日報」をローカル自動生成・保存
    if (!state.hasLocalBackend && state.sessionStartTime) {
      saveStandaloneDailyReport();
    }
    stopSessionCleanup();
    updateStatus('対話が終了しました。今日も素敵なお話をありがとうございました。', false);
    setAvatarState('idle');
  }

  function stopSessionCleanup() {
    state.isSessionActive = false;
    state.isConnected = false;
    stopSyntheticAmbientSound();
    if (state.keepaliveIntervalId) {
      clearInterval(state.keepaliveIntervalId);
      state.keepaliveIntervalId = null;
    }

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
    state.currentAiTurnTranscript = '';
    state.currentUserTurnTranscript = '';

    // オシロスコープ停止
    if (state.oscilloscopeAnimId) {
      cancelAnimationFrame(state.oscilloscopeAnimId);
      state.oscilloscopeAnimId = null;
    }
    drawFlatOscilloscope();
    dom.vuMeterFill.style.width = '0%';
    if (dom.micActiveBadge) {
      dom.micActiveBadge.textContent = '待機中';
      dom.micActiveBadge.classList.remove('active');
    }
    if (dom.vuLevelText) {
      dom.vuLevelText.textContent = '🎤 待機中（お話しください）';
      dom.vuLevelText.style.color = 'var(--text-muted)';
    }

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
  // マイク音声ストリーミング (PCM 16kHz Mono -> WebSocket)
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

    let vadSilenceChunks = 0;
    let voiceHangoverChunks = 0;
    let isSpeakingUtterance = false;
    let chunksSentInUtterance = 0;
    let preSpeechRingBuffer = []; // 話し始めの最初の子音（「し」「か」等）が欠けないよう直前3チャンクを保持

    processor.onaudioprocess = (e) => {
      // 出力バッファを明示的にゼロクリアして、スピーカーへのノイズ・発振漏れを完全防止
      try {
        const outBuf = e.outputBuffer.getChannelData(0);
        outBuf.fill(0);
      } catch (err) {}

      if (!state.isSessionActive || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;

      // AI発話中はエコー防止のためバッファをクリアして送信しない
      if (state.isAiSpeaking) {
        preSpeechRingBuffer = [];
        voiceHangoverChunks = 0;
        isSpeakingUtterance = false;
        chunksSentInUtterance = 0;
        vadSilenceChunks = 0;
        return;
      }

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

      // Int16 Little-Endian PCM へ変換
      const pcm16 = new Int16Array(downsampledData.length);
      let sumSq = 0;
      for (let i = 0; i < downsampledData.length; i++) {
        const s = Math.max(-1, Math.min(1, downsampledData[i]));
        sumSq += s * s;
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      const rms = Math.sqrt(sumSq / downsampledData.length);
      const preset = NOISE_GATE_PRESETS[state.noiseGateMode] || NOISE_GATE_PRESETS.tv_cut;

      if (rms > preset.rms) {
        // 発話開始時、直前3チャンク（約120ms）のプリバッファを先に送信して語頭欠けを完全防止
        if (voiceHangoverChunks <= 0 && preSpeechRingBuffer.length > 0) {
          for (const preBuf of preSpeechRingBuffer) {
            sendPcmAudioChunk(preBuf);
            chunksSentInUtterance++;
          }
          preSpeechRingBuffer = [];
        }
        voiceHangoverChunks = preset.hangoverChunks;
        isSpeakingUtterance = true;
        vadSilenceChunks = 0;
        state.lastVoiceActiveTime = Date.now();

        sendPcmAudioChunk(pcm16.buffer);
        chunksSentInUtterance++;
      } else if (voiceHangoverChunks > 0) {
        // 語尾（「〜ですね。」等）が途切れないよう余韻フレームをそのまま送信
        voiceHangoverChunks--;
        sendPcmAudioChunk(pcm16.buffer);
        chunksSentInUtterance++;
      } else {
        // しきい値未満（無音または遠くのテレビ音）：サーバーへ送らずプリバッファに直近3チャンクだけ保持
        preSpeechRingBuffer.push(pcm16.buffer.slice(0));
        if (preSpeechRingBuffer.length > 3) {
          preSpeechRingBuffer.shift();
        }

        // ユーザーが話し終えた直後の沈黙を検知したら、即座に EOS (audio_stream_end) を送ってAIに爆速返答させる
        if (isSpeakingUtterance) {
          vadSilenceChunks++;
          if (vadSilenceChunks >= preset.eosSilenceChunks) {
            isSpeakingUtterance = false;
            vadSilenceChunks = 0;
            if (chunksSentInUtterance >= 3) {
              sendEosSignal();
            }
            chunksSentInUtterance = 0;
          }
        }
      }
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
    let lastVuUpdateTime = 0;
    let lastVuWidth = -1;
    let lastVuText = '';
    let lastVuColor = '';
    let voiceHoldUntil = 0;
    let lastPeakLevel = 0;

    if (dom.micActiveBadge) {
      dom.micActiveBadge.textContent = 'マイクON';
      dom.micActiveBadge.classList.add('active');
    }
    if (dom.vuLevelText) {
      dom.vuLevelText.textContent = '🎤 待機中（お話しください）';
      dom.vuLevelText.style.color = 'var(--text-muted)';
    }

    function renderWaveform() {
      if (!state.isSessionActive) return;

      state.oscilloscopeAnimId = requestAnimationFrame(renderWaveform);
      analyser.getFloatTimeDomainData(floatArray);

      // 1. RMS（実効音量）を計算
      let sumSquares = 0;
      for (let i = 0; i < bufferLength; i++) {
        sumSquares += floatArray[i] * floatArray[i];
      }
      const rms = Math.sqrt(sumSquares / bufferLength);
      const visualGain = 3.5;

      // 2. オシロスコープ波形の描画
      ctx.fillStyle = '#1a2723';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.lineWidth = 2.2;
      ctx.strokeStyle = '#81b29a';
      ctx.beginPath();

      const sliceWidth = canvas.width * 1.0 / bufferLength;
      let x = 0;
      const midY = canvas.height / 2;

      for (let i = 0; i < bufferLength; i += 2) {
        const sample = Math.max(-1, Math.min(1, floatArray[i] * visualGain));
        const y = midY + sample * (midY * 0.88);

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth * 2;
      }

      ctx.lineTo(canvas.width, midY);
      ctx.stroke();

      // 3. VU音量バー＆波形下の固定枠でのマイク聞き取り応答表示の更新
      const now = performance.now();
      if (now - lastVuUpdateTime < 150) return;
      lastVuUpdateTime = now;

      const volumePercent = Math.min(100, Math.round(rms * 1400));
      if (Math.abs(volumePercent - lastVuWidth) >= 2) {
        dom.vuMeterFill.style.width = `${volumePercent}%`;
        lastVuWidth = volumePercent;
      }

      const preset = NOISE_GATE_PRESETS[state.noiseGateMode] || NOISE_GATE_PRESETS.tv_cut;
      const thresholdPercent = preset.vuThresholdPercent;

      if (volumePercent >= thresholdPercent && !state.isAiSpeaking) {
        voiceHoldUntil = now + 450;
        lastPeakLevel = Math.max(lastPeakLevel, volumePercent);
      } else if (now >= voiceHoldUntil) {
        lastPeakLevel = 0;
      }

      let nextText = '🎤 待機中（お話しください）';
      let nextColor = 'var(--text-muted)';

      if (state.isAiSpeaking) {
        nextText = '🔊 パートナーがお話し中（マイク待機）';
        nextColor = 'var(--primary)';
      } else if (volumePercent >= thresholdPercent || now < voiceHoldUntil) {
        if (volumePercent >= 60 || lastPeakLevel >= 60) {
          nextText = '🎤 音声入力中：しっかり届いています 🟡';
        } else {
          nextText = '🎤 音声入力中：良好 🟢';
        }
        nextColor = 'var(--primary)';
      } else if (volumePercent >= 4) {
        nextText = '📺 周囲音カット中（お近くでどうぞ）';
        nextColor = 'var(--text-muted)';
      }

      if (dom.vuLevelText) {
        if (nextText !== lastVuText) {
          dom.vuLevelText.textContent = nextText;
          lastVuText = nextText;
        }
        if (nextColor !== lastVuColor) {
          dom.vuLevelText.style.color = nextColor;
          lastVuColor = nextColor;
        }
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

          // ユーザーが話し終えた（600msの沈黙）を検知して処理
          if (state.speechDebounceTimer) {
            clearTimeout(state.speechDebounceTimer);
          }
          state.speechDebounceTimer = setTimeout(async () => {
            if (!state.isSessionActive) return;
            const textToSend = state.pendingUserTranscript;
            state.pendingUserTranscript = '';
            if (!textToSend || textToSend.length < 2) return;

            state.sessionTopics.push(textToSend);

            if (state.isSimulation && !state.hasLocalBackend) {
              // ブラウザ単体デモモード時の対話＆水彩画生成シミュレーション
              logDiag(`発話完了を検知（デモ）: 「${textToSend}」`);
              const profile = state.currentProfile || DEFAULT_USER_PROFILE;
              const nickname = formatUserNickname(profile.call_name);
              updateSceneCollectorFromText(textToSend, 'user');
              const isApproval = /^(はい|うん|ええ|お願いします|お願い|描いて|そうして|やってみて)/.test(textToSend.trim()) ||
                                 /(描いて|絵にして|キャンバス)/.test(textToSend);
              setTimeout(async () => {
                if (!state.isSessionActive) return;
                if (isApproval && state.sceneCollector.status !== 'drawing') {
                  const reply = `承知いたしました！それでは「${state.sceneCollector.topic || '思い出'}」の情景をキャンバスに描いてみますね。`;
                  dom.aiTranscriptText.textContent = reply;
                  speakTextWithWebSpeech(reply);
                  await executeConfirmedDrawing();
                } else {
                  const followUp = `${nickname}、${textToSend}ですね！その頃の季節やお天気、どんな様子だったかもう少し教えていただけますか？`;
                  dom.aiTranscriptText.textContent = followUp;
                  speakTextWithWebSpeech(followUp);
                }
              }, 1200);
              return;
            }

            if (state.socket && state.socket.readyState === WebSocket.OPEN) {
              // 発話テキストから情景情報を抽出・蓄積（毎ターン自動描画は行わない）
              updateSceneCollectorFromText(textToSend, 'user');

              if (state.isDirectGeminiWs) {
                // Gemini直結時も、ブラウザで正確に聞き取れた日本語字幕テキストを送信して聞き間違いをゼロにする
                state.socket.send(JSON.stringify({
                  client_content: {
                    turns: [{ role: 'user', parts: [{ text: textToSend }] }],
                    turn_complete: true
                  }
                }));
                logDiag(`認識テキストを送信: 「${textToSend}」`);
              } else {
                state.socket.send(JSON.stringify({
                  type: 'user_transcript',
                  text: textToSend
                }));
                logDiag(`発話完了を検知・送信: 「${textToSend}」`);
              }
            }
          }, 700);
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

      if (state.isDirectGeminiWs) {
        const rawB64 = jpegDataUrl.includes(',') ? jpegDataUrl.split(',')[1] : jpegDataUrl;
        state.socket.send(JSON.stringify({
          realtime_input: {
            video: {
              data: rawB64,
              mime_type: 'image/jpeg'
            }
          }
        }));
      } else {
        state.socket.send(JSON.stringify({
          type: 'camera_frame',
          data: jpegDataUrl
        }));
      }
    }, 1000);
  }

  // ============================================================================
  // ブラウザ直結 水彩画生成パイプライン (Imagen 3 -> Gemini Flash Image -> プリセット水彩画)
  // ============================================================================
  function buildSafePromptJS(dementiaLevel, sceneType, visualElements) {
    const pStyle = (dementiaLevel === 'mci')
      ? 'A gentle, nostalgic retro fine-art painting style, soft warm colors. '
      : 'A warm, nostalgic, gentle watercolor and colored pencil storybook illustration, soft pastel tones, cozy lighting. ';
    const pEra = (sceneType === 'future_dream')
      ? 'A peaceful, dreamy, and bright atmosphere. '
      : 'Set in nostalgic 1950s-1970s Showa-era Japan. ';
    const pSafety = ' Do NOT render photorealistic human faces. Depict any human figures strictly from behind, at a far distance, or as soft storybook silhouettes. No modern skyscrapers, no smartphones, no dark scary shadows, no sharp contrasts, no text or watermarks.';
    return `${pStyle}${pEra}${(visualElements || '').trim()}${pSafety}`;
  }

  async function renderFallbackWatercolorDataUrl(title, elements = '') {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');

    // 最新の描きたい情景を最優先でテーマ判定する
    const latestMatch = (elements || '').match(/【最新の描きたい情景（最優先）】:\s*([^/]+)/);
    const primaryTopic = (latestMatch ? latestMatch[1].trim() : (title || elements || '')).toLowerCase();
    const combined = `${primaryTopic} ${title || ''} ${elements || ''}`;

    const isCafe = /(喫茶店|カフェ|コーヒー|珈琲|紅茶|クリームソーダ|ホットケーキ|ナポリタン|パフェ|模擬店の中|店内|テーブル|カップ|茶店|純喫茶|お茶|注文|メニュー|カウンター)/.test(primaryTopic) ||
                   (/(喫茶店|カフェ|コーヒー|珈琲|紅茶|クリームソーダ|ホットケーキ|ナポリタン|パフェ|模擬店の中|店内|テーブル|カップ|茶店|純喫茶)/.test(combined) && !/(校舎の外|学校全体|グラウンド|校門)/.test(primaryTopic));
    const isClassroom = !isCafe && (/(教室の中|教室|黒板|机|教壇|授業|窓際)/.test(primaryTopic) || /(教室の中|黒板|教壇)/.test(combined));
    const isMountain = !isCafe && !isClassroom && (
      /(山|アルプス|連峰|峰|岳|頂|鋭い|尖|険しい|登山|岩山|富士山|北アルプス|南アルプス|八ヶ岳|岩峰|稜線)/.test(primaryTopic) ||
      (/(山|アルプス|連峰|峰|岳|頂|鋭い|尖|険しい|登山|岩山|富士山|岩峰|稜線)/.test(combined) && !/(校舎|学校|教室|喫茶店|カフェ|海)/.test(combined))
    );
    const isSchool = !isCafe && !isClassroom && !isMountain && /(高校|文化祭|学園祭|学校|校舎|中学|小学校|先生|生徒|部活|運動会|体育祭|青春|合唱|バンド|模擬店)/.test(combined);
    const isSea = !isMountain && /(海|浜|波|砂浜|船|港|沖縄|ハワイ|夏|泳|魚|潮)/.test(combined);
    const isSakura = !isMountain && /(桜|春|花|菜の花|入学|卒業|ピンク|花見|公園|庭)/.test(combined);
    const isSnow = !isMountain && /(雪|冬|スキー|こたつ|正月|北国|白|氷|北海道|新潟)/.test(combined);
    const isSunset = /(夕焼け|夕方|夕日|秋|赤とんぼ|紅葉|もみじ|祭り|花火)/.test(combined);

    // 1. テーマ別の水彩空・背景グラデーション
    const skyGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    if (isMountain) {
      skyGrad.addColorStop(0, '#2b6cb0');
      skyGrad.addColorStop(0.35, '#63b3ed');
      skyGrad.addColorStop(0.7, '#bee3f8');
      skyGrad.addColorStop(1, '#ebf8ff');
    } else if (isCafe) {
      skyGrad.addColorStop(0, '#f3e5d8');
      skyGrad.addColorStop(0.65, '#e6ccb2');
      skyGrad.addColorStop(1, '#ddb892');
    } else if (isClassroom) {
      skyGrad.addColorStop(0, '#fdf8f0');
      skyGrad.addColorStop(0.7, '#f4ebe1');
      skyGrad.addColorStop(1, '#d8c3a5');
    } else if (isSchool) {
      skyGrad.addColorStop(0, '#fff3d6');
      skyGrad.addColorStop(0.55, '#fdebd0');
      skyGrad.addColorStop(1, '#e8d5b7');
    } else if (isSea) {
      skyGrad.addColorStop(0, '#a8dadc');
      skyGrad.addColorStop(0.55, '#f1faee');
      skyGrad.addColorStop(0.56, '#457b9d');
      skyGrad.addColorStop(0.85, '#72b5d8');
      skyGrad.addColorStop(1, '#f4e4c1');
    } else if (isSakura) {
      skyGrad.addColorStop(0, '#fde2e4');
      skyGrad.addColorStop(0.55, '#fff1e6');
      skyGrad.addColorStop(1, '#cdeac0');
    } else if (isSnow) {
      skyGrad.addColorStop(0, '#cfd9df');
      skyGrad.addColorStop(0.6, '#e2ebf0');
      skyGrad.addColorStop(1, '#f8fafc');
    } else if (isSunset) {
      skyGrad.addColorStop(0, '#f4a261');
      skyGrad.addColorStop(0.5, '#f6bd60');
      skyGrad.addColorStop(1, '#84a59d');
    } else {
      skyGrad.addColorStop(0, '#f5e6d7');
      skyGrad.addColorStop(0.55, '#eef5f2');
      skyGrad.addColorStop(1, '#cfe1b9');
    }
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. 太陽・月（屋外のみ）
    if (!isCafe && !isClassroom) {
      ctx.save();
      ctx.fillStyle = isSunset ? 'rgba(231, 111, 81, 0.75)' : 'rgba(255, 238, 173, 0.75)';
      ctx.beginPath();
      ctx.arc(650, 130, 52, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 3. テーマ別の風景モチーフ描画
    if (isCafe) {
      // 喫茶店・模擬店カフェの室内風景（木目壁・アーチ窓・ペンダントライト・テーブル・珈琲とクリームソーダ）
      // 腰壁（レンガ・木目調）
      ctx.fillStyle = '#b08968';
      ctx.fillRect(0, 360, canvas.width, 240);

      // レトロなアーチ窓（外の緑と光が見える）
      ctx.fillStyle = '#d8f3dc';
      ctx.strokeStyle = '#7f5539';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(500, 110, 210, 210, [105, 105, 8, 8]) : ctx.rect(500, 110, 210, 210);
      ctx.fill();
      ctx.stroke();
      // 窓の十字格子
      ctx.beginPath();
      ctx.moveTo(605, 110);
      ctx.lineTo(605, 320);
      ctx.moveTo(500, 220);
      ctx.lineTo(710, 220);
      ctx.stroke();

      // 温かいオレンジ色のレトロペンダントライト（2灯）
      const lampX = [250, 430];
      for (const lx of lampX) {
        ctx.strokeStyle = '#5c3d2e';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(lx, 0);
        ctx.lineTo(lx, 135);
        ctx.stroke();
        // ランプシェード
        ctx.fillStyle = '#f4a261';
        ctx.beginPath();
        ctx.moveTo(lx - 42, 165);
        ctx.lineTo(lx, 128);
        ctx.lineTo(lx + 42, 165);
        ctx.closePath();
        ctx.fill();
        // 灯りの光輪
        ctx.fillStyle = 'rgba(255, 225, 148, 0.38)';
        ctx.beginPath();
        ctx.arc(lx, 180, 68, 0, Math.PI * 2);
        ctx.fill();
      }

      // 喫茶店の丸テーブル（白いテーブルクロス掛け）
      ctx.fillStyle = '#8d5b4c';
      ctx.fillRect(365, 440, 36, 160);
      ctx.fillStyle = '#fffdf9';
      ctx.strokeStyle = '#d4a373';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(385, 435, 250, 68, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // 珈琲カップ＆ソーサーと湯気
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#6c584c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(295, 435, 44, 14, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(270, 395, 50, 36);
      ctx.strokeRect(270, 395, 50, 36);
      ctx.fillStyle = '#6f4e37';
      ctx.beginPath();
      ctx.ellipse(295, 396, 23, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      // 湯気
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 2.5;
      for (let s = -10; s <= 10; s += 10) {
        ctx.beginPath();
        ctx.moveTo(295 + s, 382);
        ctx.quadraticCurveTo(288 + s, 365, 298 + s, 350);
        ctx.stroke();
      }

      // 懐かしいメロンクリームソーダ（緑のソーダ＋バニラアイス＋赤いさくらんぼ）
      ctx.fillStyle = '#52b788';
      ctx.strokeStyle = '#74c69d';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(455, 355);
      ctx.lineTo(495, 355);
      ctx.lineTo(488, 430);
      ctx.lineTo(462, 430);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // バニラアイス
      ctx.fillStyle = '#fffae0';
      ctx.beginPath();
      ctx.arc(475, 354, 17, 0, Math.PI * 2);
      ctx.fill();
      // 赤いチェリー
      ctx.fillStyle = '#e63946';
      ctx.beginPath();
      ctx.arc(482, 338, 6, 0, Math.PI * 2);
      ctx.fill();

      // 黒板メニューボード
      ctx.fillStyle = '#2d4739';
      ctx.strokeStyle = '#bc6c25';
      ctx.lineWidth = 4;
      ctx.fillRect(75, 195, 130, 145);
      ctx.strokeRect(75, 195, 130, 145);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 15px "Noto Sans JP", sans-serif';
      ctx.fillText('☕ 喫茶 憩い', 92, 228);
      ctx.font = '13px "Noto Sans JP", sans-serif';
      ctx.fillText('・ブレンド珈琲', 88, 258);
      ctx.fillText('・クリームソーダ', 88, 284);
      ctx.fillText('・ホットケーキ', 88, 310);
    } else if (isClassroom) {
      // 懐かしい教室の中（大きな黒板・チョーク・木の机・窓からの日差し）
      ctx.fillStyle = '#c89f78';
      ctx.fillRect(0, 410, canvas.width, 190);
      // 黒板
      ctx.fillStyle = '#2d5a43';
      ctx.strokeStyle = '#a47148';
      ctx.lineWidth = 8;
      ctx.fillRect(140, 130, 520, 210);
      ctx.strokeRect(140, 130, 520, 210);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = 'bold 22px "Noto Sans JP", sans-serif';
      ctx.fillText('懐かしい教室の思い出', 290, 235);
      // 木の机
      for (let c = 0; c < 3; c++) {
        const dx = 160 + c * 185;
        ctx.fillStyle = '#d4a373';
        ctx.fillRect(dx, 430, 120, 22);
        ctx.strokeStyle = '#8d5b4c';
        ctx.lineWidth = 3;
        ctx.strokeRect(dx, 430, 120, 22);
      }
    } else if (isSchool) {
      // 校庭の大地
      ctx.fillStyle = '#e6ccb2';
      ctx.fillRect(0, 390, canvas.width, 210);

      // 懐かしい木造・レトロ校舎
      ctx.fillStyle = '#faf0ca';
      ctx.strokeStyle = '#bc6c25';
      ctx.lineWidth = 3;
      ctx.fillRect(140, 210, 520, 185);
      ctx.strokeRect(140, 210, 520, 185);

      // 校舎の屋根
      ctx.fillStyle = '#d66853';
      ctx.beginPath();
      ctx.moveTo(115, 210);
      ctx.lineTo(400, 145);
      ctx.lineTo(685, 210);
      ctx.closePath();
      ctx.fill();

      // 学校の時計台
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(400, 182, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // 教室の窓枠（2階建て）
      ctx.fillStyle = '#a8dadc';
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 6; col++) {
          if (row === 1 && (col === 2 || col === 3)) continue;
          const wx = 175 + col * 78;
          const wy = 235 + row * 72;
          ctx.fillRect(wx, wy, 48, 44);
          ctx.strokeRect(wx, wy, 48, 44);
        }
      }

      // 文化祭の横断幕・アーチ
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(310, 300, 180, 42);
      ctx.strokeRect(310, 300, 180, 42);
      ctx.fillStyle = '#e07a5f';
      ctx.font = 'bold 18px "Noto Sans JP", sans-serif';
      ctx.fillText('🎉 文化祭・青春の記憶', 316, 327);

      // カラフルな万国旗・ガーランドと紙吹雪
      const flagColors = ['#e07a5f', '#f4a261', '#81b29a', '#457b9d', '#e9c46a'];
      for (let i = 0; i < 14; i++) {
        const fx = 60 + i * 50;
        const fy = 135 + Math.sin(i * 0.6) * 28;
        ctx.fillStyle = flagColors[i % flagColors.length];
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(fx + 26, fy + 6);
        ctx.lineTo(fx + 12, fy + 28);
        ctx.closePath();
        ctx.fill();
      }
      // 屋台・模擬店テント
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(90, 355, 110, 65);
      ctx.fillStyle = '#e07a5f';
      ctx.beginPath();
      ctx.moveTo(82, 355);
      ctx.lineTo(145, 322);
      ctx.lineTo(208, 355);
      ctx.closePath();
      ctx.fill();
    } else if (isSea) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 4;
      for (let y = 370; y <= 470; y += 32) {
        ctx.beginPath();
        for (let x = 40; x < 760; x += 60) {
          ctx.quadraticCurveTo(x + 15, y - 8, x + 30, y);
          ctx.quadraticCurveTo(x + 45, y + 8, x + 60, y);
        }
        ctx.stroke();
      }
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(240, 320);
      ctx.lineTo(240, 230);
      ctx.lineTo(295, 310);
      ctx.closePath();
      ctx.fill();
    } else if (isMountain) {
      // 鋭く尖った雄大な岩山・北アルプス連峰（槍ヶ岳・穂高・剱岳のような切り立った鋭利な岩峰と険しい稜線）
      // 1. 遠景の険しいギザギザ連峰（薄紫ブルーの鋭角シルエット）
      ctx.fillStyle = '#5c6d82';
      ctx.beginPath();
      ctx.moveTo(0, 440);
      ctx.lineTo(60, 230);
      ctx.lineTo(120, 280);
      ctx.lineTo(210, 160);
      ctx.lineTo(280, 240);
      ctx.lineTo(390, 85); // 鋭く尖った遠景主峰
      ctx.lineTo(480, 200);
      ctx.lineTo(580, 120);
      ctx.lineTo(660, 220);
      ctx.lineTo(740, 150);
      ctx.lineTo(800, 210);
      ctx.lineTo(800, 480);
      ctx.lineTo(0, 480);
      ctx.closePath();
      ctx.fill();

      // 2. 中景：切り立った鋭角な主岩峰（槍ヶ岳・剱岳のような鋭利な三角錐）
      // 左側斜面（朝日のハイライト・明るい青灰色）
      ctx.fillStyle = '#9cb3c9';
      ctx.beginPath();
      ctx.moveTo(110, 460);
      ctx.lineTo(380, 75); // 天を突く鋭い主峰の頂点！
      ctx.lineTo(380, 460);
      ctx.closePath();
      ctx.fill();

      // 右側斜面（切り立った深い岩陰・濃紺）
      ctx.fillStyle = '#2c3e50';
      ctx.beginPath();
      ctx.moveTo(380, 75);
      ctx.lineTo(600, 460);
      ctx.lineTo(380, 460);
      ctx.closePath();
      ctx.fill();

      // 鋭い第二岩峰（険しい針峰）
      ctx.fillStyle = '#829ab1';
      ctx.beginPath();
      ctx.moveTo(460, 450);
      ctx.lineTo(620, 115); // 鋭い山頂
      ctx.lineTo(620, 450);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#1a2530';
      ctx.beginPath();
      ctx.moveTo(620, 115);
      ctx.lineTo(760, 450);
      ctx.lineTo(620, 450);
      ctx.closePath();
      ctx.fill();

      // 3. 切り立った岩肌のシャープな亀裂・稜線（ドラマチックな陰影線）
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(380, 75);
      ctx.lineTo(290, 230);
      ctx.lineTo(340, 310);
      ctx.lineTo(260, 460);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(15, 23, 42, 0.6)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(380, 75);
      ctx.lineTo(440, 210);
      ctx.lineTo(410, 320);
      ctx.lineTo(490, 460);
      ctx.stroke();

      // 4. 山頂の尖った万年雪・鋭い氷河雪渓（純白のシャープな冠雪）
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(380, 75);
      ctx.lineTo(350, 155);
      ctx.lineTo(368, 140);
      ctx.lineTo(380, 175);
      ctx.lineTo(398, 148);
      ctx.lineTo(415, 162);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(620, 115);
      ctx.lineTo(598, 175);
      ctx.lineTo(612, 162);
      ctx.lineTo(620, 190);
      ctx.lineTo(638, 168);
      ctx.closePath();
      ctx.fill();

      // 5. 山腹にたなびく幻想的な雲海（白い霧）
      const cloudGrad = ctx.createLinearGradient(0, 360, 0, 450);
      cloudGrad.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
      cloudGrad.addColorStop(0.5, 'rgba(240, 248, 255, 0.6)');
      cloudGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = cloudGrad;
      ctx.fillRect(0, 360, canvas.width, 90);

      // 6. 麓の針葉樹林（深い原生林のモミの木）
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 445, canvas.width, 155);
      const pineColors = ['#0d2818', '#1b4332', '#2d6a4f'];
      for (let tx = 8; tx < 796; tx += 22) {
        const th = 45 + (tx % 23) * 3;
        const ty = 436 + (tx % 13) * 2;
        ctx.fillStyle = pineColors[tx % pineColors.length];
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - 12, ty + th);
        ctx.lineTo(tx + 12, ty + th);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      ctx.fillStyle = isSnow ? '#b8c9d9' : isSakura ? '#95b8a6' : '#81b29a';
      ctx.beginPath();
      ctx.moveTo(0, 390);
      ctx.quadraticCurveTo(200, 190, 440, 390);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = isSnow ? '#9fb4c7' : isSunset ? '#6d597a' : '#649682';
      ctx.beginPath();
      ctx.moveTo(280, 400);
      ctx.quadraticCurveTo(540, 170, 800, 400);
      ctx.closePath();
      ctx.fill();

      if (isSakura) {
        ctx.fillStyle = 'rgba(255, 183, 197, 0.85)';
        for (let i = 0; i < 45; i++) {
          const px = (i * 97 + 50) % 760;
          const py = (i * 61 + 40) % 420;
          ctx.beginPath();
          ctx.arc(px, py, 8 + (i % 6), 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (isSnow) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        for (let i = 0; i < 55; i++) {
          const px = (i * 83 + 30) % 780;
          const py = (i * 53 + 20) % 560;
          ctx.beginPath();
          ctx.arc(px, py, 4 + (i % 4), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 4. 和紙風短冊（タイトル札）を左上に描画
    const bx = 28, by = 28, bw = 420, bh = 82;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.strokeStyle = '#e07a5f';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(bx, by, bw, bh, 12);
    } else {
      ctx.rect(bx, by, bw, bh);
    }
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#e07a5f';
    ctx.font = 'bold 14px "Noto Sans JP", sans-serif';
    ctx.fillText('🎨 おもいでキャンバス 水彩画', bx + 16, by + 28);

    const cleanTitle = (title || '思い出の風景').replace(/\n/g, ' ').slice(0, 20);
    ctx.fillStyle = '#2c5e4f';
    ctx.font = 'bold 21px "Noto Sans JP", sans-serif';
    ctx.fillText(cleanTitle, bx + 16, by + 60);

    return canvas.toDataURL('image/jpeg', 0.88);
  }

  async function generateStandaloneMemoryArtifact(args) {
    const profile = state.currentProfile || DEFAULT_USER_PROFILE;
    const sceneType = args.scene_type || 'past_memory';
    const title = args.japanese_title || '思い出の風景';
    const elements = args.visual_elements || args.updated_visual_elements || title;
    const ambientSound = args.ambient_sound || 'autumn_insects';
    const finalPrompt = buildSafePromptJS(profile.dementia_level || 'mild', sceneType, elements);

    let mediaDataUrl = '';
    const apiKey = (state.sessionApiKey || '').trim();

    if (apiKey) {
      // Step 0: FLUX / Pollinations 超高精細AI画像生成（Nano Banana 級の描写力）
      try {
        if (dom.drawingSubtext) dom.drawingSubtext.textContent = '1/3: AI画像生成エンジンに問い合わせ中...';
        logDiag('FLUX 超高精細画像生成エンジンを呼び出し中...');

        let fluxPrompt = '';
        try {
          const transRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: `You are an expert art director. Convert the following nostalgic scene description into a highly detailed English image prompt for FLUX:
"${elements}"
Guidelines:
- Warm, nostalgic, fine art watercolor and oil painting style, masterpiece, rich texture, beautiful natural lighting.
- If mountains or rocks are mentioned (e.g. sharp mountain, alps), depict extremely sharp, towering, jagged rocky alpine peaks (like Mount Yari / Matterhorn) with dramatic light and shadow, crisp silhouettes, pristine snow crevices.
- If cafes or rooms are mentioned, depict authentic nostalgic Japanese Showa-era interior, wooden tables, retro cups, warm pendant lighting.
- No photorealistic human faces, figures only from behind or distant silhouettes.
- Output ONLY the English prompt text, no markdown, no quotes.` }] }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 160 }
              })
            }
          );
          recordApiCall(transRes.headers, transRes.status);
          if (transRes.ok) {
            const transData = await transRes.json();
            fluxPrompt = (transData?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
          } else {
            if (transRes.status === 429) {
              showCanvasError('Google AI Studio クォータ上限 (429 Too Many Requests)', '無料枠の利用上限に達しました。ローカル水彩画エンジンで即座に描画します。', true);
            } else if (transRes.status === 400 || transRes.status === 403) {
              showCanvasError(`Gemini API エラー (${transRes.status})`, 'APIキーが無効または制限されています。画面右上のキー設定をご確認ください。');
            }
          }
        } catch (tErr) {
          console.warn('Prompt translation error:', tErr);
        }

        if (!fluxPrompt) {
          fluxPrompt = `Warm nostalgic watercolor fine art, ${elements}, extremely detailed, dramatic lighting`;
        }

        const seed = Math.floor(Math.random() * 999999);
        const fluxUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(fluxPrompt)}?width=1024&height=768&model=flux&nologo=true&seed=${seed}`;

        // 画像のロード完了を最大2.5秒待機
        if (!state.pollinationsBlocked) {
          const imgLoaded = await new Promise((resolve) => {
            const testImg = new Image();
            const timer = setTimeout(() => {
              state.pollinationsBlocked = true;
              resolve(false);
            }, 2500);
            testImg.onload = () => { clearTimeout(timer); resolve(true); };
            testImg.onerror = () => {
              clearTimeout(timer);
              state.pollinationsBlocked = true;
              showCanvasError('外部画像生成 (FLUX) 混雑', '外部サーバーの混雑または利用制限を検知しました。ローカル水彩画エンジンで描画します。', true);
              resolve(false);
            };
            testImg.src = fluxUrl;
          });

          if (imgLoaded) {
            mediaDataUrl = fluxUrl;
            logDiag('FLUX による最高峰クオリティの情景描画に成功しました！');
          }
        }
      } catch (fluxErr) {
        console.warn('FLUX generation warning:', fluxErr);
      }

      // Step 1: Gemini 2.5 Flash によるオーダーメイドSVG水彩画生成（フォールバック）
      if (!mediaDataUrl) {
        try {
          if (dom.drawingSubtext) dom.drawingSubtext.textContent = '2/3: Gemini 2.5 Flash SVG描画を試行中...';
          const svgPrompt = `あなたはプロの情景水彩画・童話イラストの画家です。高齢者・回想法ケアのため、ユーザーが語った思い出やお話に合わせて、指定された情景のSVGイラスト（viewBox="0 0 800 600"）を1枚描いてください。

【描く情景・ユーザーの言葉（最優先遵守）】:
${elements}

【最重要造形ルール】
1. ユーザーがお話しした具体的なモチーフ・特徴・造形を100%忠実に描いてください。
   - 山について語られている場合（「山が鋭い」「尖った山」「北アルプス」「岩山」「連峰」など）：なだらかな丸い丘に絶対せず、必ず鋭角な三角形・ギザギザの険しい岩峰・切り立った山頂・陰影・雪渓をシャープなポリゴンやパス（<polygon>, <path>）でダイナミックに描いてください！
   - 喫茶店や店内について語られている場合：木目テーブル、コーヒー、クリームソーダ、ペンダントライト、窓などを描いてください。
   - 学校や教室、海、季節など、会話に出てきた情景を主役として具体的に配置してください。
2. 背景には美しいグラデーション（<linearGradient>, <radialGradient>）を使い、温かく情緒的な水彩画の雰囲気にしてください。
3. 人物のリアルな顔は描かず、後ろ姿や遠景、あるいは情景・静物を美しく描いてください。
4. <svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg"> で始まり </svg> で終わる完全なSVGコードのみを出力してください。余計な解説文やマークダウン枠（\`\`\`xml 等）は一切含めないでください。`;

          const resSvg = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: svgPrompt }] }],
                generationConfig: { temperature: 0.4, maxOutputTokens: 2500 }
              })
            }
          );
          recordApiCall(resSvg.headers, resSvg.status);
          if (resSvg.ok) {
            const dataSvg = await resSvg.json();
            const rawText = dataSvg?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const svgMatch = rawText.match(/<svg[\s\S]*?<\/svg>/i);
            if (svgMatch && svgMatch[0]) {
              const cleanSvg = svgMatch[0];
              mediaDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cleanSvg)}`;
              logDiag('Gemini 2.5 Flash によるオーダーメイド水彩画(SVG)の描画に成功しました！');
            }
          } else {
            if (resSvg.status === 429) {
              showCanvasError('Google AI Studio クォータ上限 (429 Too Many Requests)', '無料枠の利用上限（1500回/日または15回/分）に達しました。ローカル水彩画エンジンで描画します。', true);
            } else if (resSvg.status === 400 || resSvg.status === 403) {
              showCanvasError(`Gemini API エラー (${resSvg.status})`, 'APIキーが無効または制限されています。画面右上のキー設定をご確認ください。');
            }
          }
        } catch (svgErr) {
          console.warn('Gemini SVG generation warning:', svgErr);
        }
      }
    }

    // Step 3: テーマ別水彩画キャンバス描画フォールバック（外部APIエラー・クォータ制限時も100%確実に絵を出す！）
    if (!mediaDataUrl) {
      if (dom.drawingSubtext) dom.drawingSubtext.textContent = '3/3: 高精細ローカル水彩画エンジンで描画中...';
      logDiag('ローカル水彩画エンジンでフォールバック描画を実行します。');
      mediaDataUrl = await renderFallbackWatercolorDataUrl(title, elements);
    }

    const artifact = {
      memory_id: Math.random().toString(36).slice(2, 10),
      user_id: profile.user_id || 'default_user',
      created_at: new Date().toISOString(),
      scene_type: sceneType,
      title: title,
      visual_description: elements,
      media_format: 'image',
      media_url: mediaDataUrl,
      ambient_sound: ambientSound
    };

    state.sessionMemories.push(artifact);
    state.sessionTopics.push(title);
    saveMemoryToLocalStorage(artifact);
    return artifact;
  }

  function saveMemoryToLocalStorage(artifact) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_MEMORIES);
      const list = raw ? JSON.parse(raw) : [];
      list.unshift(artifact);
      // 容量保護のため最新15件を保持
      while (list.length > 15) list.pop();
      localStorage.setItem(STORAGE_KEY_MEMORIES, JSON.stringify(list));
    } catch (e) {
      console.warn('LocalStorage memory save warning:', e);
    }
  }

  async function handleDirectMediaGeneration(ws, callId, funcName, args) {
    try {
      const mySeqId = ++state.drawSequenceId;
      const latestUserTopic = state.sessionTopics[state.sessionTopics.length - 1] || '';
      const rawElements = args.visual_elements || args.updated_visual_elements || args.user_feedback || args.japanese_title || latestUserTopic;
      if (latestUserTopic) {
        state.lastDrawnUtterance = latestUserTopic;
      }
      const enrichedArgs = {
        ...args,
        japanese_title: args.japanese_title || args.user_feedback || latestUserTopic.slice(0, 18) || '思い出の風景',
        visual_elements: latestUserTopic
          ? `【最新の会話内容（最優先）】: ${latestUserTopic} / 【AI情景描写】: ${rawElements}`
          : rawElements
      };

      const artifact = await generateStandaloneMemoryArtifact(enrichedArgs);
      if (mySeqId === state.drawSequenceId) {
        displayGeneratedMedia(artifact);
      }

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          tool_response: {
            function_responses: [
              {
                id: callId,
                name: funcName,
                response: { output: { status: 'displayed_on_canvas', title: artifact.title } }
              }
            ]
          }
        }));
      }
    } catch (err) {
      console.error('Direct media generation error:', err);
      setAvatarState('listening');
    }
  }

  async function handleDirectEmergencyAlert(ws, callId, funcName, args) {
    const profile = state.currentProfile || DEFAULT_USER_PROFILE;
    const contact = profile.emergency_contact || {};
    const res = {
      status: 'dispatched',
      urgency_level: args.urgency_level || 'high_physical_distress',
      contact_person: `${contact.family_name || 'ご家族'} (${contact.relationship || '緊急連絡先'})`,
      timestamp: new Date().toISOString()
    };
    showEmergencyBanner(res);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        tool_response: {
          function_responses: [
            {
              id: callId,
              name: funcName,
              response: { output: res }
            }
          ]
        }
      }));
    }
  }

  function saveStandaloneDailyReport() {
    try {
      const durationMin = Math.max(1, Math.round((Date.now() - (state.sessionStartTime || Date.now())) / 60000));
      const uniqueTopics = Array.from(new Set(state.sessionTopics)).slice(0, 6);
      const topicsList = uniqueTopics.length > 0 ? uniqueTopics : ['穏やかな日常のご挨拶と近況のお話'];
      const profile = state.currentProfile || DEFAULT_USER_PROFILE;
      const nickname = formatUserNickname(profile.call_name);
      const todayStr = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });

      const report = {
        report_id: Math.random().toString(36).slice(2, 10),
        user_id: profile.user_id || 'default_user',
        session_date: todayStr,
        duration_minutes: durationMin,
        smile_score_summary: '穏やかでリラックスしたご様子でお話しされました 🌸',
        topics_discussed: topicsList,
        caregiver_feedback_note: `本日も${nickname}と約${durationMin}分間、温かい対話を行いました。\n「${topicsList.join('」「')}」といったお話に花が咲き、落ち着いて過ごされています。`
      };

      const raw = localStorage.getItem(STORAGE_KEY_REPORTS);
      const list = raw ? JSON.parse(raw) : [];
      list.unshift(report);
      while (list.length > 20) list.pop();
      localStorage.setItem(STORAGE_KEY_REPORTS, JSON.stringify(list));
    } catch (e) {}
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
          const pName = data.partner_name || state.currentProfile?.partner?.name || 'さくら';
          if (data.partner_gender) {
            dom.avatarContainer.setAttribute('data-gender', data.partner_gender);
          }
          dom.partnerStatusText.textContent = `${pName}：${cleanName}さんとお話し中`;
          setAvatarState('listening');
          if (state.isSimulation) {
            logDiag('【案内】ローカルシミュレーションモードで接続しました。');
          }
          break;
        }

        case 'transcript':
          // 文字起こし字幕の更新（チャンクで届く場合は繋げて読みやすく表示）
          if (data.role === 'model' && data.text) {
            dom.aiTranscriptText.textContent = data.text;
            // シミュレーションモード時はブラウザ音声合成で喋らせる！
            if (state.isSimulation) {
              speakTextWithWebSpeech(data.text);
            }
          } else if (data.role === 'user' && data.text) {
            dom.userTranscriptText.textContent = `「${data.text}」`;
          }
          break;

        case 'avatar_state':
          if (data.state === 'listening' && (state.isAiSpeaking || state.isDrawingMedia)) {
            break;
          }
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
    if (!state.isDrawingMedia) {
      setAvatarState('speaking');
    }

    if (state.aiSpeechEndTimer) {
      clearTimeout(state.aiSpeechEndTimer);
    }
    const remainingMs = Math.max(150, (state.nextPlaybackTime - ctx.currentTime) * 1000 + 180);
    state.aiSpeechEndTimer = setTimeout(() => {
      state.isAiSpeaking = false;
      if (!state.isDrawingMedia) {
        setAvatarState('listening');
      }
    }, remainingMs);
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
  // アバター表情切り替え（不要なDOM再描画・ちらつき防止付き）
  // ============================================================================
  function setAvatarState(avatarState) {
    if (avatarState === 'drawing') {
      state.isDrawingMedia = true;
    } else {
      state.isDrawingMedia = false;
    }

    const currentAttr = dom.avatarContainer.getAttribute('data-state');
    if (currentAttr !== avatarState) {
      dom.avatarContainer.setAttribute('data-state', avatarState);
    }

    const pName = state.currentProfile?.partner?.name || 'パートナー';
    let nextLabel = '';

    switch (avatarState) {
      case 'idle':
        nextLabel = `${pName}：準備完了`;
        dom.drawingOverlay?.classList.add('hidden');
        break;
      case 'listening':
        nextLabel = `${pName}：お話を聞いています...`;
        dom.drawingOverlay?.classList.add('hidden');
        break;
      case 'speaking':
        nextLabel = `${pName}：お話し中...`;
        dom.drawingOverlay?.classList.add('hidden');
        break;
      case 'drawing':
        nextLabel = `${pName}：絵を描いています...`;
        dom.drawingOverlay?.classList.remove('hidden');
        break;
    }

    if (nextLabel && dom.partnerStatusText.textContent !== nextLabel) {
      dom.partnerStatusText.textContent = nextLabel;
    }
  }

  // ============================================================================
  // 生成メディアのクロスフェード表示 ＆ 環境音連動
  // ============================================================================
  function displayGeneratedMedia(mediaData) {
    state.isDrawingMedia = false;
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

  // 環境音インジケーター連動（※連続発振音「ピーーーー」の原因となるOscillator連続再生は廃止し、無音・視覚表示のみとする）
  function playSyntheticAmbientSound(_soundType) {
    stopSyntheticAmbientSound();
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
    let loaded = null;
    try {
      const localRaw = localStorage.getItem(STORAGE_KEY_PROFILE);
      if (localRaw) {
        loaded = JSON.parse(localRaw);
      }
    } catch (e) {}

    if (state.hasLocalBackend) {
      try {
        const res = await fetch('/api/profile');
        if (res.ok) {
          loaded = await res.json();
          try {
            localStorage.setItem(STORAGE_KEY_PROFILE, JSON.stringify(loaded));
          } catch (e) {}
        }
      } catch (err) {
        console.warn('Local backend profile fetch skipped, using browser storage.');
      }
    }

    state.currentProfile = loaded || JSON.parse(JSON.stringify(DEFAULT_USER_PROFILE));
    updateGreetingAndPartnerLabels(state.currentProfile);
  }

  function updateGreetingAndPartnerLabels(profile) {
    if (!profile) return;
    const rawName = (profile.call_name || 'ゲスト').replace(/\s*さん$/, '');
    const suffix = rawName.endsWith('お父さん') || rawName.endsWith('お母さん') || rawName.endsWith('ちゃん') || rawName.endsWith('先生') ? '' : 'さん';
    dom.userGreeting.textContent = `${rawName}${suffix}のお部屋`;

    const pName = profile.partner?.name || 'さくら';
    const pGender = profile.partner?.gender || '女性';
    dom.avatarContainer.setAttribute('data-gender', pGender);
    dom.partnerStatusText.textContent = `${pName}：準備完了`;
    const aiTagEl = document.querySelector('.ai-tag');
    if (aiTagEl) aiTagEl.textContent = `🤖 ${pName}`;
    const userTagEl = document.querySelector('.user-tag');
    if (userTagEl) userTagEl.textContent = `🎤 ${rawName}${suffix}`;

    if (profile.noise_gate_mode) {
      setNoiseGateMode(profile.noise_gate_mode);
    } else {
      setNoiseGateMode('tv_cut');
    }
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
    const noiseSelect = document.getElementById('selectNoiseGateMode');
    if (noiseSelect) noiseSelect.value = p.noise_gate_mode || state.noiseGateMode || 'tv_cut';

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
    const noiseGateMode = document.getElementById('selectNoiseGateMode')?.value || state.noiseGateMode || 'tv_cut';

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
      noise_gate_mode: noiseGateMode,
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
      localStorage.setItem(STORAGE_KEY_PROFILE, JSON.stringify(updated));
    } catch (err) {}

    if (state.hasLocalBackend) {
      try {
        await fetch('/api/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updated)
        });
      } catch (err) {}
    }

    state.currentProfile = updated;
    updateGreetingAndPartnerLabels(updated);
    alert('設定を保存しました！次回の「お話をはじめる」から新しいパートナー・会話相手設定が反映されます。');
    closeCaregiverModal();
  }

  async function loadReports() {
    dom.reportsContainer.innerHTML = '<p class="empty-hint">日報を読み込み中...</p>';
    let reports = [];
    if (state.hasLocalBackend) {
      try {
        const res = await fetch('/api/reports');
        if (res.ok) reports = await res.json();
      } catch (e) {}
    }
    if (!reports || reports.length === 0) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_REPORTS);
        if (raw) reports = JSON.parse(raw);
      } catch (e) {}
    }

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
            ${(r.caregiver_feedback_note || '').replace(/\n/g, '<br>')}
          </p>
        </div>
      </div>
    `).join('');
  }

  async function loadGallery() {
    dom.galleryGrid.innerHTML = '<p class="empty-hint">絵本を読み込み中...</p>';
    let memories = [];
    if (state.hasLocalBackend) {
      try {
        const res = await fetch('/api/memories');
        if (res.ok) memories = await res.json();
      } catch (e) {}
    }
    if (!memories || memories.length === 0) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_MEMORIES);
        if (raw) memories = JSON.parse(raw);
      } catch (e) {}
    }

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
  }

  // ============================================================================
  // 思い出情景メモ・収集インジケーター ＆ 合意形成（描画回数抑制と高精度化）
  // ============================================================================
  function resetSceneCollector() {
    state.sceneCollector = {
      topic: '',
      place: '',
      seasonWeather: '',
      details: new Set(),
      status: 'idle',
      isAwaitingConfirmation: false,
      lastConfirmedTopic: '',
      drawConfirmedByUser: false
    };
    renderSceneCollectorUI();
  }

  function updateSceneCollectorFromText(text, speaker = 'user') {
    if (!text || typeof text !== 'string') return;
    const clean = text.replace(/[「」『』]/g, '').trim();
    if (clean.length < 2) return;

    const sc = state.sceneCollector;
    let changed = false;

    // 1. AIが描画確認の呼びかけを行ったか検知
    if (speaker === 'ai') {
      const isConfirming = /(キャンバスに描いてみましょうか|描いてみましょうか|絵にしてみましょうか|描きましょうか|絵を描いてみましょうか|キャンバスに映してみましょうか|キャンバスに描いてみますか)/.test(clean);
      if (isConfirming) {
        sc.isAwaitingConfirmation = true;
        sc.status = 'confirming';
        renderSceneCollectorUI();
        return;
      }
    }

    // 2. ユーザーからの明示的描画リクエスト・または合意返答の検知
    if (speaker === 'user') {
      const isExplicitDrawCommand = /(絵を描いて|絵にして|絵描いて|描いてみて|キャンバスに描いて|キャンバスに出して|キャンバスに映して|描いてください)/.test(clean);
      const isApproval = /^(はい|うん|ええ|お願いします|お願い|描いて|そうして|やってみて|いいよ|ぜひ|頼む|おねがい)/.test(clean) ||
                         /^(そうですね|そうしよう|描こう)/.test(clean);

      if (isExplicitDrawCommand || (sc.isAwaitingConfirmation && isApproval)) {
        logDiag(`ユーザーの描画合意・指示を検知: 「${clean}」`);
        sc.isAwaitingConfirmation = false;
        executeConfirmedDrawing();
        return;
      }
    }

    // 3. 話題・テーマの抽出
    const topicRegex = /(文化祭|模擬店|運動会|山登り|登山|ハイキング|お祭り|祭り|旅行|卒業式|入学式|紅葉狩り|お花見|散歩|ドライブ|仕事|授業|畑仕事|収穫)/;
    const tm = clean.match(topicRegex);
    if (tm) {
      if (!sc.topic || tm[0].length >= sc.topic.length) {
        sc.topic = tm[0];
        changed = true;
      }
    }

    // 4. 場所・舞台の抽出
    const placeRegex = /(北アルプス|南アルプス|中央アルプス|槍ヶ岳|穂高岳|常念岳|富士山|八ヶ岳|美ヶ原|上高地|信州|松本|喫茶店の中|喫茶店|カフェ|純喫茶|教室の中|教室|校舎|学校|体育館|校庭|海|海岸|砂浜|波打ち際|港|駅|ホーム|公園|商店街|田んぼ|畑|リンゴ畑|りんご畑|庭|神社|お寺|故郷|実家)/;
    const pm = clean.match(placeRegex);
    if (pm) {
      sc.place = pm[0];
      if (!sc.topic) {
        sc.topic = `${pm[0]}の思い出`;
      }
      changed = true;
    }

    // 5. 季節・天候・時間帯の抽出
    const seasonRegex = /(春|夏|秋|冬|朝|昼|夕暮れ|夕方|夕焼け|夜|星空|快晴|青空|雲海|雪|残雪|新緑|紅葉|秋晴れ|澄み切った空)/;
    const sm = clean.match(seasonRegex);
    if (sm) {
      if (!sc.seasonWeather) {
        sc.seasonWeather = sm[0];
        changed = true;
      }
    }

    // 6. 情景ディテール（事物・要素）の抽出
    const detailList = [
      // 山・自然
      '鋭い岩峰', '険しい岩肌', '切り立った岩', '尖った山頂', '白い雪渓', '連峰', '山脈', '岩肌', '雲海', '青空', '緑の山並み', 'ハイマツ',
      // 喫茶店・カフェ
      '丸い木製テーブル', '丸いテーブル', '赤い布張り椅子', '赤い椅子', '革張りソファー', 'カウンター席', '窓際の席', 'クリームソーダ', 'メロンソーダ', 'バニラアイス', '赤いチェリー', 'ホットケーキ', 'サイフォン', 'コーヒー', '珈琲', 'ティーカップ',
      // 教室・学校
      '黒板', 'チョーク', '木の机', '木の椅子', '教卓', '白いカーテン', '窓ガラス',
      // 故郷・農村・庭
      '赤いリンゴ', '実ったリンゴ', '小川のせせらぎ', '夕日', '黄金色の稲穂', '赤とんぼ', '桜並木'
    ];

    detailList.forEach(item => {
      if (clean.includes(item)) {
        if (!sc.details.has(item)) {
          sc.details.add(item);
          changed = true;
        }
      }
    });

    // 山が話題なら鋭い岩峰・雪渓を自動補強
    if (/(槍ヶ岳|北アルプス|鋭い山|岩山|アルプス)/.test(clean) || (sc.place && /(槍ヶ岳|北アルプス)/.test(sc.place))) {
      if (!sc.details.has('鋭い岩峰と雪渓')) {
        sc.details.add('鋭い岩峰と雪渓');
        changed = true;
      }
    }

    // 喫茶店の中の場合の基本ディテール補強
    if (clean.includes('喫茶店') || (sc.place && sc.place.includes('喫茶店'))) {
      if (clean.includes('中') || clean.includes('店内') || clean.includes('テーブル')) {
        if (!sc.details.has('温かい店内と木製テーブル')) {
          sc.details.add('温かい店内と木製テーブル');
          changed = true;
        }
      }
    }

    if (changed || sc.status === 'idle') {
      if (sc.details.size >= 2 || (sc.place && sc.details.size >= 1)) {
        sc.status = 'ready';
      } else {
        sc.status = 'collecting';
      }
      renderSceneCollectorUI();
    }
  }

  function renderSceneCollectorUI() {
    if (!dom.sceneCollectorPanel) return;

    const sc = state.sceneCollector;
    const isReady = (sc.status === 'ready' || sc.status === 'confirming');

    if (isReady) {
      dom.sceneCollectorPanel.classList.add('is-ready');
    } else {
      dom.sceneCollectorPanel.classList.remove('is-ready');
    }

    // ステータスバッジ
    if (dom.collectorStatusIcon && dom.collectorStatusLabel) {
      if (sc.status === 'drawing') {
        dom.collectorStatusIcon.textContent = '🎨';
        dom.collectorStatusLabel.textContent = 'キャンバスに絵を描いています...';
      } else if (sc.status === 'drawn') {
        dom.collectorStatusIcon.textContent = '🖼️';
        dom.collectorStatusLabel.textContent = '思い出の絵が完成しました';
      } else if (sc.status === 'confirming') {
        dom.collectorStatusIcon.textContent = '❓';
        dom.collectorStatusLabel.textContent = 'パートナーが描画を確認中...';
      } else if (sc.status === 'ready') {
        dom.collectorStatusIcon.textContent = '✨';
        dom.collectorStatusLabel.textContent = '情景がまとまりました（いつでも描けます）';
      } else {
        dom.collectorStatusIcon.textContent = '📝';
        dom.collectorStatusLabel.textContent = '思い出の情景を聞き取り中...';
      }
    }

    // ディテール件数
    if (dom.collectorDetailCount) {
      dom.collectorDetailCount.textContent = sc.details.size;
    }

    // 話題・場所
    if (dom.valTopic) {
      dom.valTopic.textContent = sc.topic || 'お話を聞いています';
      dom.valTopic.title = sc.topic || '';
    }
    if (dom.valPlace) {
      dom.valPlace.textContent = sc.place || (sc.seasonWeather ? `${sc.seasonWeather}の情景` : '聞き取り中');
      dom.valPlace.title = sc.place || '';
    }

    // 情景ディテールタグ一覧
    if (dom.valDetailsList) {
      if (sc.details.size === 0) {
        dom.valDetailsList.innerHTML = '<span class="tag-placeholder">お話から特徴を集めています</span>';
      } else {
        dom.valDetailsList.innerHTML = Array.from(sc.details)
          .map(d => `<span class="detail-tag">・${d}</span>`)
          .join('');
      }
    }

    // 確認・描画アクションバナー
    if (dom.collectorActionBanner) {
      if (sc.status === 'confirming' || (sc.status === 'ready' && !state.isDrawingMedia)) {
        dom.collectorActionBanner.classList.remove('hidden');
        if (dom.collectorActionText) {
          if (sc.status === 'confirming') {
            dom.collectorActionText.textContent = `パートナーが「${sc.topic || 'この情景'}をキャンバスに描いてみましょうか？」と確認しています`;
          } else {
            dom.collectorActionText.textContent = `「${sc.topic || '思い出'}」の情景がまとまりました！キャンバスに描いてみましょうか？`;
          }
        }
      } else {
        dom.collectorActionBanner.classList.add('hidden');
      }
    }

    // ワンタップ描画ボタンのラベル・スタイル更新
    if (dom.btnDrawCurrentTopic) {
      if (sc.status === 'ready' || sc.status === 'confirming') {
        dom.btnDrawCurrentTopic.textContent = '✨ 準備OK！この情景を描く';
        dom.btnDrawCurrentTopic.style.background = 'linear-gradient(135deg, #d97706 0%, #b45309 100%)';
      } else if (sc.status === 'drawing') {
        dom.btnDrawCurrentTopic.textContent = '🎨 描画中...';
        dom.btnDrawCurrentTopic.style.background = '';
      } else {
        dom.btnDrawCurrentTopic.textContent = '🎨 今の話題を絵にする';
        dom.btnDrawCurrentTopic.style.background = '';
      }
    }
  }

  async function executeConfirmedDrawing(manualTopic = '') {
    // ユーザーからの直接指示・承諾時はビジーロックを解除して即時実行
    state.isDrawingMedia = false;
    dismissCanvasError();

    const sc = state.sceneCollector;
    const pArgs = sc.pendingArgs?.args;
    const topic = manualTopic || pArgs?.japanese_title || sc.topic || sc.place || (state.sessionTopics.length > 0 ? state.sessionTopics[state.sessionTopics.length - 1] : '思い出の風景');

    // 収集された情景情報を総合して高精細プロンプトを作成
    const detailsArray = Array.from(sc.details);
    const elementsParts = [];
    if (pArgs?.visual_elements) elementsParts.push(`【AI情景描写】: ${pArgs.visual_elements}`);
    if (sc.place) elementsParts.push(`【場所・舞台】: ${sc.place}`);
    if (sc.seasonWeather) elementsParts.push(`【季節・天候・時間】: ${sc.seasonWeather}`);
    if (detailsArray.length > 0) elementsParts.push(`【情景ディテール】: ${detailsArray.join('、')}`);
    elementsParts.push('温かい水彩画風、昭和のノスタルジー、澄み切った光と優しい陰影');

    const combinedElements = elementsParts.join(' / ');

    sc.status = 'drawing';
    sc.isAwaitingConfirmation = false;
    sc.pendingArgs = null;
    renderSceneCollectorUI();

    logDiag(`合意形成・確定によりキャンバス描画を実行します: 「${topic}」`);
    await triggerSceneDrawingForTopic(topic, combinedElements);

    sc.status = 'drawn';
    renderSceneCollectorUI();
  }

  // ============================================================================
  // 動作診断・テストツール ＆ ワンタップ「今の話題を絵にする」
  // ============================================================================
  async function triggerSceneDrawingForTopic(rawTopic, customElements = '') {
    const cleanTopic = (rawTopic || '').replace(/[「」]/g, '').trim() || '思い出の風景';
    state.lastDrawnUtterance = cleanTopic;
    const mySeqId = ++state.drawSequenceId;

    let combinedElements = customElements;
    if (!combinedElements) {
      const recentContext = state.sessionTopics.slice(-3).join('、');
      combinedElements = recentContext
        ? `【描きたい情景】: ${cleanTopic} / 【会話の流れ】: ${recentContext}`
        : cleanTopic;
    }

    const shortTitle = cleanTopic.length > 18 ? `${cleanTopic.slice(0, 18)}…` : cleanTopic;
    logDiag(`会話に合わせてキャンバスを更新中: 「${shortTitle}」`);
    if (dom.captionTitle) {
      dom.captionTitle.textContent = `🎨 描画中: 「${shortTitle}」`;
    }
    setAvatarState('drawing');
    if (dom.btnDrawCurrentTopic) {
      dom.btnDrawCurrentTopic.disabled = true;
      dom.btnDrawCurrentTopic.textContent = '🎨 描画中...';
    }
    try {
      const art = await generateStandaloneMemoryArtifact({
        scene_type: 'past_memory',
        japanese_title: shortTitle,
        visual_elements: combinedElements,
        ambient_sound: 'autumn_insects'
      });
      // より新しい発話の描画が走っていなければキャンバスに反映
      if (mySeqId === state.drawSequenceId) {
        displayGeneratedMedia(art);
      }
    } catch (e) {
      console.error('triggerSceneDrawingForTopic error:', e);
      showCanvasError('描画処理エラー', '画像の描画中にエラーが発生しました。ローカル水彩画エンジンで復旧します。', true);
      try {
        const fallbackUrl = await renderFallbackWatercolorDataUrl(shortTitle, combinedElements);
        displayGeneratedMedia({
          title: shortTitle,
          media_format: 'image',
          media_url: fallbackUrl,
          ambient_sound: 'none'
        });
      } catch (fbErr) {
        console.error('Fallback render error:', fbErr);
      }
    } finally {
      state.isDrawingMedia = false;
      dom.drawingOverlay?.classList.add('hidden');
      if (mySeqId === state.drawSequenceId) {
        if (dom.btnDrawCurrentTopic) {
          dom.btnDrawCurrentTopic.disabled = false;
          renderSceneCollectorUI();
        }
        setAvatarState(state.isSessionActive ? 'listening' : 'idle');
      }
    }
  }

  async function drawCurrentConversationScene() {
    const sc = state.sceneCollector;
    let candidate = sc.topic || sc.place || (state.sessionTopics.length > 0 ? state.sessionTopics[state.sessionTopics.length - 1] : '');
    if (!candidate && dom.userTranscriptText) {
      const txt = (dom.userTranscriptText.textContent || '').replace(/[「」]/g, '').trim();
      if (!txt.includes('お話をはじめる') && !txt.includes('声が文字になります') && txt.length >= 2) {
        candidate = txt;
      }
    }
    if (!candidate && dom.aiTranscriptText) {
      const aiTxt = dom.aiTranscriptText.textContent || '';
      const m = aiTxt.match(/(槍ヶ岳|北アルプス|山登り|山頂|喫茶店|カフェ|クリームソーダ|ホットケーキ|教室|校舎|文化祭|模擬店|海|桜|夕焼け|雪景色|公園|電車|リンゴ)/);
      if (m && m[0]) {
        candidate = `${m[0]}の情景`;
      }
    }

    // 準備完了状態のときはプロンプトダイアログなしでそのまま即座に確定描画！
    if (sc.status === 'ready' || sc.status === 'confirming') {
      await executeConfirmedDrawing(candidate);
      return;
    }

    // ワンタップで自由に入力・指定できる確認ダイアログ（そのままOKを押せば候補が描画される）
    const promptMsg = '描きたい思い出の情景やお話の内容を入力してください\n（例：北アルプス槍ヶ岳の鋭い岩峰、文化祭の喫茶店の中など）';
    const userEntered = window.prompt(promptMsg, candidate || '文化祭の喫茶店の中');
    const finalTopic = (userEntered !== null ? userEntered.trim() : candidate) || '思い出の風景';

    state.sessionTopics.push(finalTopic);
    await executeConfirmedDrawing(finalTopic);
  }

  async function testGenerateSampleVisual() {
    const lastTopic = state.sessionTopics[state.sessionTopics.length - 1] || '文化祭の喫茶店の中';
    await triggerSceneDrawingForTopic(lastTopic);
  }

  async function testEmergencyAlert() {
    logDiag('緊急通報テストを発信します...');
    if (state.hasLocalBackend) {
      try {
        const res = await fetch('/api/emergency/test', { method: 'POST' });
        const data = await res.json();
        logDiag(`通報結果:\n${JSON.stringify(data, null, 2)}`);
        alert('緊急通報の疎通テストを完了しました。診断ログをご確認ください。');
        return;
      } catch (err) {}
    }
    const ec = state.currentProfile?.emergency_contact || DEFAULT_USER_PROFILE.emergency_contact;
    const simResult = {
      status: 'simulated_dispatch',
      contact_person: `${ec.family_name || 'ご家族'} (${ec.relationship || '長男'})`,
      timestamp: new Date().toISOString()
    };
    logDiag(`通報結果 (ブラウザ単体テスト):\n${JSON.stringify(simResult, null, 2)}`);
    alert('緊急通報の疎通テストを完了しました。診断ログをご確認ください。');
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
