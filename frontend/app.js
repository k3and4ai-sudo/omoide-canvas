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
  const MIN_DRAW_INTERVAL_MS = 120 * 1000; // 描画間隔の最小時間（2分 = 120秒）

  // 周囲音・テレビ音声カットモード別のRMSしきい値設定（アナログノイズ遮断 ＆ 話し終わり650msでの爆速返答）
  const NOISE_GATE_PRESETS = {
    normal: { rms: 0.0006, vuThresholdPercent: 2, hangoverMs: 400, eosSilenceMs: 650, label: '標準感度（おすすめ）' },
    tv_cut: { rms: 0.0016, vuThresholdPercent: 4, hangoverMs: 350, eosSilenceMs: 700, label: 'テレビ・周囲音カット' },
    strict: { rms: 0.0035, vuThresholdPercent: 8, hangoverMs: 300, eosSilenceMs: 750, label: '強めカット' }
  };

  // 画風スタイル定義（水彩画・リアル・油絵・色鉛筆スケッチ）
  const ART_STYLES = {
    watercolor: {
      key: 'watercolor',
      name: '優しい水彩画',
      badge: '🎨 優しい水彩画',
      promptModifier: '温かい水彩画風、昭和のノスタルジー、水彩絵の具の優しいにじみとグラデーション、柔らかな光と穏やかな陰影',
      svgRoleInstruction: '高齢者・回想法ケアのためのプロの水彩画家・絵本イラストレーター',
      svgStyleRules: `
1. 水彩画のような優しく深みのあるグラデーション（<linearGradient>, <radialGradient>）を空やモチーフに適用してください。
2. 昭和ノスタルジーの温もりある色彩（茜色、若草色、空色、木目調の茶）を基調とし、絵の具のにじみを感じさせる表現にしてください。
3. 人物のリアルな顔は描かず、情景・風景・静物の情緒を主役にしてください。`
    },
    realistic: {
      key: 'realistic',
      name: 'リアルな情景（写実）',
      badge: '📷 リアルな情景',
      promptModifier: '極めて写実的でリアルな情景、写真のような鮮やかさと精密なディテール、自然でドラマチックな光と影、被写界深度と立体的な質感',
      svgRoleInstruction: '写実主義（リアリズム）および超高精細な情景描写を専門とするプロのアーティスト',
      svgStyleRules: `
1. 写真のようにリアルで実在感のある光と影（ハイライト、反射光、深みのある濃淡シャドウ）を精密に描き込んでください。
2. モチーフの質感（木目の繊細なライン、ガラスや水のリアルな透明感・反射・屈折、植物の葉脈や果物のつややかな光沢、金属の輝き）を複数の階層レイヤーとグラデーションで立体的に描写してください。
3. 遠近感（パースペクティブ）と被写界深度（前景の鮮明なフォーカスと遠景のソフトなボケ味）を意識し、息をのむような美しいリアリズムを表現してください。
4. 人物の顔は描かず、情景・建築・自然・静物を写真のように鮮やかに描き出してください。`
    },
    oil_painting: {
      key: 'oil_painting',
      name: '重厚な油絵',
      badge: '🖌️ 重厚な油絵',
      promptModifier: '印象派・近代洋画のような重厚な油絵風、力強い筆跡（インパスト）、豊かで深みのある絵の具の重なり、重厚な陰影とクラシカルな質感',
      svgRoleInstruction: '印象派・近代油彩画を専門とする熟練の洋画家',
      svgStyleRules: `
1. 油彩画の絵の具の厚塗り（インパスト）やキャンバスの布目を思わせる、力強く重厚なタッチと豊かなテクスチャ感を表現してください。
2. 光と影のコントラスト（明暗対比・キアロスクーロ）を際立たせ、重みと気品のあるクラシカルな油彩画の風合いにしてください。
3. 深みのある重層的なグラデーションとリッチな色彩（深いバーントアンバー、コバルトブルー、クリムゾンなど）を多用してください。`
    },
    colored_pencil: {
      key: 'colored_pencil',
      name: '色鉛筆スケッチ',
      badge: '✏️ 色鉛筆スケッチ',
      promptModifier: '温もりあふれる手描きの色鉛筆画風、素朴で繊細なハッチング線、優しい紙の質感と柔らかなタッチ',
      svgRoleInstruction: '素朴で優しい色鉛筆画・ボタニカルアートの専門画家',
      svgStyleRules: `
1. 繊細な鉛筆のハッチング（斜線・クロスハッチング）や点描の質感を感じさせる、素朴で温かい手描き風タッチで描いてください。
2. 画用紙の温かい地色を活かし、色鉛筆を何色も重ねて生み出されるような優しい混色と透明感を表現してください。
3. 輪郭線には鉛筆らしい柔らかなストロークを施し、親しみやすく心安らぐスケッチ画に仕上げてください。`
    }
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
    currentArtStyle: 'watercolor',  // 選択中の画風スタイル (watercolor | realistic | oil_painting | colored_pencil)
    currentArtifact: null,          // 現在キャンバスに表示中の絵画オブジェクト（保存用）
    previousSessionContext: (() => {
      try {
        const saved = sessionStorage.getItem('omoide_previous_session');
        return saved ? JSON.parse(saved) : null;
      } catch (e) {
        return null;
      }
    })(),                           // セッション終了・再開時の話題継続用コンテキスト
    sessionTopics: [],              // セッション中の話題リスト
    sessionMemories: [],            // セッション中に生成した絵画リスト
    lastDrawnUtterance: '',         // 最後にキャンバス描画した発話テキスト
    drawSequenceId: 0,              // 描画リクエスト連番（最新の発話を常に優先反映するため）
    hasDrawnImage: false,           // キャンバスに1枚以上の絵が描画完了しているか
    lastUserModification: '',       // 直近で検知された修正指示テキスト
    pendingRefineTimer: null,       // AIツール呼び出しスキップ時の描き直し自動トリガータイマー
    currentAiTurnTranscript: '',    // Gemini直結時のAI字幕バッファ
    currentUserTurnTranscript: '',  // Gemini直結時のユーザー字幕バッファ
    isAiSpeaking: false,            // AIが発話中（エコー防止用フラグ）
    aiSpeechEndTimer: null,         // AI発話終了判定タイマー
    noiseGateMode: 'normal',        // 現在の周囲音対策モード（標準感度デフォルト）
    userSpeakingUntil: 0,           // 音声認識によるユーザー発話アクティブ終了予測時刻
    lastVoiceActiveTime: 0,         // 近接音声がゲートを通過した最終時刻（Web Speech API連動用）
    lastDrawTriggerTime: 0,         // 前回描画トリガー時刻（多重実行・クォータ枯渇防止用）
    lastDrawTime: 0,                // 最後に描画完了した時刻（最小描画間隔2分 = 120秒制限用）
    drawCooldownTimerId: null,      // 2分間カウントダウン更新タイマー
    hasWarnedLowQuota: false,       // クォータ10%以下警告表示済みフラグ
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
    btnPasteApiKey: document.getElementById('btnPasteApiKey'),
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
    canvasUpdateToast: document.getElementById('canvasUpdateToast'),
    canvasUpdateToastText: document.getElementById('canvasUpdateToastText'),
    canvasErrorBanner: document.getElementById('canvasErrorBanner'),
    canvasErrorTitle: document.getElementById('canvasErrorTitle'),
    canvasErrorDesc: document.getElementById('canvasErrorDesc'),
    btnDismissError: document.getElementById('btnDismissError'),
    captionTitle: document.getElementById('captionTitle'),
    captionTag: document.getElementById('captionTag'),
    captionFallbackBadge: document.getElementById('captionFallbackBadge'),
    captionFallbackNotice: document.getElementById('captionFallbackNotice'),
    selectArtStyle: document.getElementById('selectArtStyle'),
    btnSaveImage: document.getElementById('btnSaveImage'),
    btnClearCanvas: document.getElementById('btnClearCanvas'),
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
    collectorRefineBar: document.getElementById('collectorRefineBar'),
    btnRefineNow: document.getElementById('btnRefineNow'),
    refineHintText: document.getElementById('refineHintText'),

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
          // 429制限発生から15分以上経過していれば自動解除して再試行可能にする
          if (data.isRateLimited && data.rateLimitedAt && (Date.now() - data.rateLimitedAt > 15 * 60 * 1000)) {
            data.isRateLimited = false;
            data.lastErrorMsg = '';
          }
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
      rateLimitedAt: 0,
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
      tracker.rateLimitedAt = Date.now();
      tracker.lastErrorMsg = '429 Quota Exceeded (一時制限)';
    } else if (status >= 400) {
      tracker.lastErrorMsg = errorMsg || `HTTP ${status}`;
    }

    saveQuotaTracker(tracker);
    renderQuotaUI();
  }

  function getPacificResetTimeInfo() {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
        timeZoneName: 'short',
        hour12: false
      });
      const parts = formatter.formatToParts(now);
      const pt = {};
      parts.forEach(p => pt[p.type] = p.value);

      const ptHour = parseInt(pt.hour === '24' ? '0' : pt.hour, 10);
      const ptMin = parseInt(pt.minute, 10);
      const ptSec = parseInt(pt.second, 10);
      const tzName = pt.timeZoneName || (now.getMonth() >= 2 && now.getMonth() <= 10 ? 'PDT' : 'PST');

      const remainingSec = Math.max(0, (24 * 3600) - (ptHour * 3600 + ptMin * 60 + ptSec));
      const targetJST = new Date(now.getTime() + remainingSec * 1000);
      const jstH = String(targetJST.getHours()).padStart(2, '0');
      const jstM = String(targetJST.getMinutes()).padStart(2, '0');
      const isSummer = tzName.toUpperCase() === 'PDT';

      return {
        timeStr: `${jstH}:${jstM}`,
        tzName: tzName,
        isSummer: isSummer,
        seasonLabel: isSummer ? '夏時間(PDT)' : '冬時間(PST)',
        remainingHours: (remainingSec / 3600).toFixed(1)
      };
    } catch (e) {
      return { timeStr: '16:00', tzName: 'PDT', isSummer: true, seasonLabel: '夏時間(PDT)', remainingHours: '0' };
    }
  }

  function renderQuotaUI() {
    if (!dom.quotaText || !dom.quotaMonitorBadge) return;
    const tracker = loadQuotaTracker();
    const rInfo = getPacificResetTimeInfo();

    if (tracker.isRateLimited) {
      dom.quotaMonitorBadge.className = 'quota-monitor-badge quota-exceeded';
      dom.quotaText.textContent = `⚠️ クォータ上限 (リセット: ${rInfo.timeStr})`;
      dom.quotaMonitorBadge.title = `Google AI Studio の無料枠クォータ上限に達しました。本日${rInfo.timeStr}（米太平洋午前0時 / ${rInfo.seasonLabel}）に全量リセットされます。ローカル水彩画エンジンで動作中`;
    } else {
      const limit = tracker.limitReported || DAILY_GEMINI_LIMIT;
      const remaining = tracker.remainingReported !== null
        ? tracker.remainingReported
        : Math.max(0, limit - tracker.requestCount);
      const percent = Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));

      if (percent <= 10) {
        dom.quotaMonitorBadge.className = 'quota-monitor-badge quota-critical';
        dom.quotaText.textContent = `⚠️ 残量 ${percent}% (リセット: ${rInfo.timeStr})`;
        dom.quotaMonitorBadge.title = `⚠️ gemini-3.8-flash のクォータ残量が10%以下になりました（残り約${remaining}回）。本日${rInfo.timeStr}（${rInfo.seasonLabel}）にリセットされます。\nクリックで詳細を表示`;
        if (!state.hasWarnedLowQuota) {
          state.hasWarnedLowQuota = true;
          showCanvasError(
            `【クォータ残量警告】gemini-3.8-flash 残り${percent}%`,
            `クォータの残りが10%以下（残り約${remaining}回）になりました。本日${rInfo.timeStr}（日本時間 / 米国太平洋${rInfo.seasonLabel}）にリセットされます。連続描画を控え、必要に応じてローカル水彩画も活用されます。`,
            true
          );
        }
      } else if (percent <= 20) {
        dom.quotaMonitorBadge.className = 'quota-monitor-badge quota-warning';
        dom.quotaText.textContent = `AI残量: ${percent}% (本日 ${tracker.requestCount}/${limit}回)`;
        dom.quotaMonitorBadge.title = `本日のAI呼び出し回数: ${tracker.requestCount}回 / 目安上限: ${limit}回 (残り約 ${remaining}回)\nクリックで詳細を表示します`;
      } else {
        dom.quotaMonitorBadge.className = 'quota-monitor-badge';
        dom.quotaText.textContent = `AI残量: ${percent}% (本日 ${tracker.requestCount}/${limit}回)`;
        dom.quotaMonitorBadge.title = `本日のAI呼び出し回数: ${tracker.requestCount}回 / 目安上限: ${limit}回 (残り約 ${remaining}回)\nクリックで詳細を表示します`;
      }
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

  function getRemainingDrawCooldownSec() {
    if (!state.lastDrawTime) return 0;
    const elapsed = Date.now() - state.lastDrawTime;
    if (elapsed >= MIN_DRAW_INTERVAL_MS) return 0;
    return Math.ceil((MIN_DRAW_INTERVAL_MS - elapsed) / 1000);
  }

  function startDrawCooldownTimer() {
    if (state.drawCooldownTimerId) {
      clearInterval(state.drawCooldownTimerId);
      state.drawCooldownTimerId = null;
    }
    updateDrawButtonsCooldownUI();
    state.drawCooldownTimerId = setInterval(() => {
      const waitSec = getRemainingDrawCooldownSec();
      if (waitSec <= 0) {
        clearInterval(state.drawCooldownTimerId);
        state.drawCooldownTimerId = null;
        updateDrawButtonsCooldownUI();
      } else {
        updateDrawButtonsCooldownUI();
      }
    }, 1000);
  }

  function updateDrawButtonsCooldownUI() {
    const waitSec = getRemainingDrawCooldownSec();
    const rInfo = getPacificResetTimeInfo();
    if (dom.btnDrawCurrentTopic) {
      if (state.isDrawingMedia) {
        dom.btnDrawCurrentTopic.textContent = '🎨 描画中...';
        dom.btnDrawCurrentTopic.disabled = true;
      } else if (waitSec > 0) {
        dom.btnDrawCurrentTopic.textContent = `⏳ 次の描画まで (${waitSec}秒)`;
        dom.btnDrawCurrentTopic.title = `連続描画防止のため、前回の描画から2分間お待ちいただいています（残り${waitSec}秒 / 本日${rInfo.timeStr}リセット）`;
        dom.btnDrawCurrentTopic.disabled = true;
      } else {
        dom.btnDrawCurrentTopic.textContent = '🎨 今の話題を絵にする';
        dom.btnDrawCurrentTopic.title = '現在の会話内容から新しい情景を絵にします';
        dom.btnDrawCurrentTopic.disabled = false;
      }
    }
    if (dom.btnRefineNow) {
      if (state.isDrawingMedia) {
        dom.btnRefineNow.textContent = '🎨 描画中...';
        dom.btnRefineNow.disabled = true;
      } else if (waitSec > 0) {
        dom.btnRefineNow.textContent = `⏳ 待機中 (${waitSec}秒)`;
        dom.btnRefineNow.disabled = true;
      } else {
        dom.btnRefineNow.textContent = '🎨 この指示で描き直す';
        dom.btnRefineNow.disabled = false;
      }
    }
  }

  function showQuotaDetailsModal() {
    const tracker = loadQuotaTracker();
    const limit = tracker.limitReported || DAILY_GEMINI_LIMIT;
    const remaining = tracker.remainingReported !== null
      ? tracker.remainingReported
      : Math.max(0, limit - tracker.requestCount);
    const percent = Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));
    const waitSec = getRemainingDrawCooldownSec();
    const rInfo = getPacificResetTimeInfo();
    const msg = [
      '【📊 AIクォータ・利用状況モニター】',
      '・対象AIモデル: gemini-3.8-flash (情景描画・推論)',
      `・日付: ${tracker.date}`,
      `・本日の生成リクエスト回数: ${tracker.requestCount} 回`,
      `・クォータ目安上限: ${limit} 回 / 日 (Google AI Studio 無料枠)`,
      `・推計残りリクエスト: 約 ${remaining} 回 (残量: ${percent}%)`,
      `・次回クォータリセット時刻: 本日 ${rInfo.timeStr} (日本時間 / 米国太平洋午前0時 [${rInfo.seasonLabel}])`,
      `・最小描画間隔: 2分 (${waitSec > 0 ? `現在クールダウン中: 残り${waitSec}秒` : '現在すぐに描画可能'})`,
      `・最新ステータス: ${tracker.isRateLimited ? `⚠️ 429 レート制限中 (本日${rInfo.timeStr}リセット / ローカル水彩画に自動切替)` : (percent <= 10 ? `⚠️ クォータ残量10%以下（本日${rInfo.timeStr}リセット）` : '✅ 正常稼働中')}`,
      tracker.lastErrorMsg ? `・最新のエラー: ${tracker.lastErrorMsg}` : '',
      '\n※万が一クォータ上限（429）に達した場合でも、端末内のローカル高精細水彩画エンジンが自動で即座に代行描画します。',
      tracker.isRateLimited ? '\n【OK】を押すとクォータ制限表示をリセットして通常モードで再試行します。' : ''
    ].filter(Boolean).join('\n');

    if (tracker.isRateLimited) {
      if (confirm(msg)) {
        tracker.isRateLimited = false;
        tracker.rateLimitedAt = 0;
        tracker.lastErrorMsg = '';
        saveQuotaTracker(tracker);
        renderQuotaUI();
        logDiag('クォータ状態をリセットしました。');
      }
    } else {
      alert(msg);
    }
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
    noise_gate_mode: 'normal',
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
        if (data.server_has_api_key) {
          state.isLoggedIn = true;
          state.sessionApiKey = state.sessionApiKey || '';
          if (dom.apiKeyStatusBadge) {
            dom.apiKeyStatusBadge.textContent = `認証済 (${data.masked_key || 'サーバー設定済'})`;
          }
          dom.btnOpenLoginModal?.classList.add('active-key');
          dom.loginModal?.classList.add('hidden');
          logDiag(`サーバー設定済みのGemini APIキーを自動検出・認証完了 (${data.masked_key})`);
        }
        return state.hasLocalBackend;
      }
    } catch (e) {}
    state.hasLocalBackend = false;
    return false;
  }

  async function init() {
    setupEventListeners();
    initLoginModalState();
    clearCanvasState();
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
    if (!rawKey || rawKey.length < 15) {
      return { valid: false, message: 'APIキーの文字数が不足しています。正しいGemini APIキーを入力してください。' };
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

    // クリップボードからの貼り付けボタン
    dom.btnPasteApiKey?.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text && dom.inputSessionApiKey) {
          const cleanKey = text.trim().replace(/[\r\n\s]/g, '');
          dom.inputSessionApiKey.value = cleanKey;
          showLoginMessage('📋 クリップボードから貼り付けました', false);
        }
      } catch (err) {
        // クリップボード読み取り権限がない場合はペーストショートカットを案内
        showLoginMessage('Ctrl + V で入力枠に貼り付けてください', false);
      }
    });

    // ペースト時の改行・空白除去による消失・誤送信の完全防止
    dom.inputSessionApiKey?.addEventListener('paste', (e) => {
      const clipboardData = e.clipboardData || window.clipboardData;
      if (clipboardData) {
        e.preventDefault();
        const pastedText = clipboardData.getData('text') || '';
        const cleanKey = pastedText.trim().replace(/[\r\n\s]/g, '');
        dom.inputSessionApiKey.value = cleanKey;
      }
    });

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
    dom.btnClearCanvas?.addEventListener('click', clearCanvasState);
    dom.btnSaveImage?.addEventListener('click', saveCurrentCanvasImage);
    dom.selectArtStyle?.addEventListener('change', (e) => {
      setArtStyle(e.target.value);
    });

    // 思い出情景メモ・合意形成ボタン群
    dom.btnConfirmDraw?.addEventListener('click', () => {
      executeConfirmedDrawing();
    });
    dom.btnMoreTalk?.addEventListener('click', () => {
      state.sceneCollector.isAwaitingConfirmation = false;
      state.sceneCollector.status = 'collecting';
      renderSceneCollectorUI();
    });
    dom.btnRefineNow?.addEventListener('click', () => {
      executeRefineDrawing();
    });

    // エラーバナー閉じる ＆ クォータ詳細モニター
    dom.btnDismissError?.addEventListener('click', dismissCanvasError);
    dom.quotaMonitorBadge?.addEventListener('click', showQuotaDetailsModal);
  }

  function setNoiseGateMode(mode) {
    const validMode = NOISE_GATE_PRESETS[mode] ? mode : 'normal';
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

  function setArtStyle(styleKey) {
    if (!ART_STYLES[styleKey]) return;
    state.currentArtStyle = styleKey;
    if (dom.selectArtStyle) {
      dom.selectArtStyle.value = styleKey;
    }
    const style = ART_STYLES[styleKey];
    logDiag(`画風スタイルを「${style.badge}」に変更しました。`);
    if (dom.captionTag && !dom.captionTag.textContent.includes('白紙')) {
      dom.captionTag.textContent = style.name;
    }
  }

  async function saveCurrentCanvasImage() {
    const imgSrc = dom.memoryImage?.src || (state.currentArtifact && state.currentArtifact.media_url);
    if (!imgSrc || dom.memoryImage?.classList.contains('hidden')) {
      alert('保存できる絵がありません。');
      return;
    }

    const title = (dom.captionTitle?.textContent || '思い出の風景')
      .replace(/[🎨🖼️\s]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 20) || '思い出の絵';

    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const filename = `おもいでキャンバス_${title}_${dateStr}.png`;

    try {
      if (dom.btnSaveImage) {
        dom.btnSaveImage.disabled = true;
        dom.btnSaveImage.textContent = '⏳ 保存中...';
      }

      // 1. SVG (DataURL) の場合: オフスクリーン Canvas (1600x1200) に高精細描画して PNG 化
      if (imgSrc.startsWith('data:image/svg+xml')) {
        const svgImg = new Image();
        svgImg.crossOrigin = 'anonymous';
        await new Promise((resolve, reject) => {
          svgImg.onload = resolve;
          svgImg.onerror = reject;
          svgImg.src = imgSrc;
        });

        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = 1600;
        offscreenCanvas.height = 1200;
        const ctx = offscreenCanvas.getContext('2d');

        // 白背景を敷いて透明部を保護
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 1600, 1200);
        ctx.drawImage(svgImg, 0, 0, 1600, 1200);

        const blob = await new Promise(res => offscreenCanvas.toBlob(res, 'image/png'));
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 3000);
      } else {
        // 2. 通常の画像 (JPEG/PNG/Blob URL)
        const res = await fetch(imgSrc);
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 3000);
      }

      showCanvasUpdateToast(`「${title}」の絵を保存しました！`);
      logDiag(`絵の保存が完了しました: ${filename}`);

      if (dom.btnSaveImage) {
        dom.btnSaveImage.classList.add('saved-success');
        dom.btnSaveImage.textContent = '✅ 保存完了！';
        setTimeout(() => {
          dom.btnSaveImage.classList.remove('saved-success');
          dom.btnSaveImage.textContent = '💾 絵を保存する';
          dom.btnSaveImage.disabled = false;
        }, 2500);
      }
    } catch (err) {
      console.error('saveCurrentCanvasImage error:', err);
      logDiag(`絵の保存エラー: ${err.message}`);
      alert(`絵の保存中にエラーが発生しました: ${err.message}`);
      if (dom.btnSaveImage) {
        dom.btnSaveImage.textContent = '💾 絵を保存する';
        dom.btnSaveImage.disabled = false;
      }
    }
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

  function buildSystemInstructionJS(profile, resumeTopic = '', isResume = false) {
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

    let baseInstruction = `# あなたの役割とプロフィール（AIパートナー設定）
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
7. 【最重要】無音・マイクノイズ・息遣いへの無反応ルール（勝手な反応の完全禁止）：
   相手が何も話していない沈黙時間、呼吸音（吐息）、マイクの電気的ノイズや環境音に対しては、【絶対に勝手に相槌や発話をしないでください】。相手が明確に日本語の言葉を発した時のみ返答してください。
${levelRules}

# 【思い出の映像化（情景収集・描画前確認・合意形成）の絶対ルール】
0. 【最重要】ご本人の言葉に100%忠実な具体的ディテールの反映（抽象化・勝手な置き換えの禁止）：
   相手が語った具体的な事物（例：「赤いバラ」「白い柵」「庭」「コスモス」「信州松本駅」「丸いテーブル」など、花・植物・建物・色彩・道具の名称）を、必ずそのままツールの \`japanese_title\`（例：「庭いっぱいに咲く赤いバラ」）および \`visual_elements\`（例：「満開の赤いバラ、白い木製の柵、緑の芝生、晴れ渡る青空」）に漏れなく正確に指定してください。
   「日差しが降り注ぐ」「風が吹いている」といった抽象的なテンプレート表現だけで済ませるのは厳禁です。
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
6. 【最重要】絵の修正・描き直し（refine_memory_visual）ルール：
   相手が描かれた絵を見て、「もう少し〜にして」「〜を変えて」「〜を追加して」「夕焼けにして」「もっと鋭く」「〜を置いて」など、
   修正や変更の要望を口にしたら、相手の要望をそのまま復唱して「かしこまりました！〇〇ですね、早速描き直してみますね。」と温かく答えながら、
   直ちに \`refine_memory_visual\` ツールを呼び出してください。
   その際、\`user_feedback\` に相手の具体的な修正希望（例：「夕焼けの空にする」「窓際に赤い花を置く」など）を、
   \`updated_visual_elements\` に修正後の全体情景を詳しく指定してください。

# 【緊急通報（SOS）の絶対ルール】
相手が「助けて」「苦しい」「痛い」等の発言をした場合は、まず「${nickname}、大丈夫ですか？ご家族に連絡を入れましょうか？」と確認し、本人が同意した場合のみ \`trigger_emergency_alert\` を呼び出してください。`;

    if (isResume && resumeTopic) {
      baseInstruction += `

# 【直前の対話からの継続再開ルール（重要）】
・このセッションは直前の対話からの「継続再開」です。直前まで${nickname}と「${resumeTopic}」について楽しくお話ししていました。
・初回のような挨拶（「はじめまして」「今日もお元気でしたか」など）は決して行わず、直前の話題（${resumeTopic}）についての感想や質問から自然に会話を続けてください。
・すでに画面上には先ほどお話しした「${resumeTopic}」の思い出の絵が描かれています。相手が絵について感想を述べたり修正を希望した場合は、前回の絵を踏まえて優しく対応してください。`;
    }

    return baseInstruction;
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

  // ============================================================================
  // キャンバスの完全初期化（白紙に戻して、ゼロから新しいお話の絵を作る）
  // ============================================================================
  function clearCanvasState() {
    state.hasDrawnImage = false;
    state.currentArtifact = null;
    state.lastUserModification = '';
    state.lastDrawnUtterance = '';
    state.pollinationsBlocked = false;
    state.previousSessionContext = null;
    try { sessionStorage.removeItem('omoide_previous_session'); } catch (e) {}
    if (state.pendingRefineTimer) {
      clearTimeout(state.pendingRefineTimer);
      state.pendingRefineTimer = null;
    }

    dom.btnSaveImage?.classList.add('hidden');

    if (dom.memoryImage) {
      dom.memoryImage.src = '';
      dom.memoryImage.classList.add('hidden');
      dom.memoryImage.classList.remove('refreshing');
    }
    if (dom.memoryVideo) {
      try { dom.memoryVideo.pause(); } catch (e) {}
      dom.memoryVideo.src = '';
      dom.memoryVideo.classList.add('hidden');
    }
    if (dom.canvasPlaceholder) {
      dom.canvasPlaceholder.classList.remove('hidden');
    }
    if (dom.captionTitle) {
      dom.captionTitle.textContent = 'お話に出てきた風景をここに描きます';
    }
    if (dom.captionTag) {
      dom.captionTag.textContent = '思い出';
    }
    if (dom.captionFallbackBadge) {
      dom.captionFallbackBadge.classList.add('hidden');
    }
    if (dom.captionFallbackNotice) {
      dom.captionFallbackNotice.classList.add('hidden');
    }
    if (dom.btnDrawCurrentTopic) {
      dom.btnDrawCurrentTopic.textContent = '🎨 今の話題を絵にする';
      dom.btnDrawCurrentTopic.style.background = '';
      dom.btnDrawCurrentTopic.disabled = false;
    }
    if (dom.collectorRefineBar) {
      dom.collectorRefineBar.classList.add('hidden');
    }
    if (dom.canvasUpdateToast) {
      dom.canvasUpdateToast.classList.add('hidden');
    }
    dismissCanvasError();
    stopSyntheticAmbientSound();
    resetSceneCollector();
    logDiag('キャンバスを白紙（初期状態）にリセットしました。ゼロから新しいお話の絵を描く準備が整いました。');
  }

  async function startSession() {
    if (!state.isLoggedIn) {
      openLoginModal();
      return;
    }
    try {
      state.userRequestedStop = false;
      state.sessionStartTime = Date.now();

      // 直前のセッションからの再開（続き）かどうかの判定
      const hasPreviousContext = !!(state.previousSessionContext && (state.previousSessionContext.lastTopic || state.previousSessionContext.lastArtTitle));
      const hasExistingArt = state.hasDrawnImage || (dom.memoryImage && !dom.memoryImage.classList.contains('hidden') && dom.memoryImage.src);

      if (hasPreviousContext || hasExistingArt) {
        // 前の話の続きとして再開する：キャンバスと話題を維持！
        const resumeTopic = state.previousSessionContext?.lastArtTitle || state.previousSessionContext?.lastTopic || '前回の風景';
        logDiag(`【再開】前回の話題（${resumeTopic}）を引き継いで再開します。`);
        if (state.previousSessionContext?.topics && state.previousSessionContext.topics.length > 0) {
          state.sessionTopics = [...state.previousSessionContext.topics];
        }
      } else {
        // まったくの初回、または明示的に白紙に戻されている場合
        state.sessionTopics = [];
        state.sessionMemories = [];
        clearCanvasState();
      }

      state.isAiSpeaking = true; // 接続〜最初の挨拶完了までマイクを完全保護（エコー遮断ガード）
      if (state.aiSpeechEndTimer) clearTimeout(state.aiSpeechEndTimer);
      state.aiSpeechEndTimer = setTimeout(() => {
        // 5秒経過しても音声再生が始まらない場合の安全マイク解放
        if (state.isAiSpeaking && (!state.audioContextOut || state.nextPlaybackTime <= state.audioContextOut.currentTime)) {
          state.isAiSpeaking = false;
          if (!state.isDrawingMedia) setAvatarState('listening');
        }
      }, 5000);
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
    const params = new URLSearchParams();
    if (state.sessionApiKey) {
      params.set('api_key', state.sessionApiKey);
    }
    const topicForResume = state.previousSessionContext?.lastArtTitle || state.previousSessionContext?.lastTopic || (state.sessionTopics.length > 0 ? state.sessionTopics[state.sessionTopics.length - 1] : '');
    const isResume = !!(topicForResume && (state.hasDrawnImage || state.previousSessionContext));
    if (isResume && topicForResume) {
      params.set('recent_topic', topicForResume);
      params.set('last_art', state.previousSessionContext?.lastArtTitle || '');
      params.set('is_resume', 'true');
    }
    const queryString = params.toString() ? `?${params.toString()}` : '';
    const wsUrl = `${protocol}//${window.location.host}/ws/live${queryString}`;
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
    const topicForResume = state.previousSessionContext?.lastArtTitle || state.previousSessionContext?.lastTopic || (state.sessionTopics.length > 0 ? state.sessionTopics[state.sessionTopics.length - 1] : '');
    const isResume = !isReconnect && !!(topicForResume && (state.hasDrawnImage || state.previousSessionContext));
    const systemInstruction = buildSystemInstructionJS(profile, topicForResume, isResume);

    let setupCompleted = false;

    ws.onopen = () => {
      const setupPayload = {
        setup: {
          model: 'models/gemini-2.5-flash-native-audio-preview-09-2025',
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
              start_of_speech_sensitivity: 'START_SENSITIVITY_LOW',
              end_of_speech_sensitivity: 'END_SENSITIVITY_LOW',
              prefix_padding_ms: 200,
              silence_duration_ms: 1200
            }
          },
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'generate_memory_visual',
                  description: '対象者が語った思い出や夢の風景を水彩画として描画する。visual_elementsには会話で聞き取った具体的な事物（花・植物・建物・色彩等）を漏れなく詳細に指定すること',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      scene_type: { type: 'STRING' },
                      japanese_title: { type: 'STRING', description: '具体的な絵画タイトル（例: 庭いっぱいに咲く赤いバラ）' },
                      visual_elements: { type: 'STRING', description: '会話で聞き取った具体的な情景要素（例: 真っ赤なバラの花壇、白い木製の柵、青空）' },
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
                      user_feedback: { type: 'STRING', description: '相手の修正希望（例: 夕焼け空にして）' },
                      updated_visual_elements: { type: 'STRING', description: '修正を反映した新しい全体情景の具体的要素' }
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
          const topicForResume = state.previousSessionContext?.lastArtTitle || state.previousSessionContext?.lastTopic || '';
          if (topicForResume && (state.hasDrawnImage || state.previousSessionContext)) {
            dom.partnerStatusText.textContent = `${pName}：${cleanName}さんと「${topicForResume}」のお話を継続中`;
          } else {
            dom.partnerStatusText.textContent = `${pName}：${cleanName}さんとお話し中`;
          }

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
            let greetPrompt = '';
            if (isResume && topicForResume) {
              greetPrompt = `対話セッションが再開されました。あなたの名前は「${pName}」です。直前まで${nickname}と「${topicForResume}」について楽しくお話ししていました。「${nickname}、先ほどの${topicForResume}のお話の続きをしましょうか！」のように、初対面の挨拶（こんにちは、今日もお元気でしたか等）は省略して、直前のお話の続きを自然に促す温かい第一声を声に出して話しかけてください。`;
            } else {
              greetPrompt = `対話セッションが開始されました。あなたの名前は「${pName}」です。${nickname}に向かって、「こんにちは、${nickname}！${pName}です。今日も気持ちのいい日ですね。お元気でしたか？」のように、あなたの性格（${partner.personality || '優しく穏やか'}）らしく、短く温かく最初の挨拶を声に出して話しかけてください。`;
            }
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
              if (state.pendingRefineTimer) {
                clearTimeout(state.pendingRefineTimer);
                state.pendingRefineTimer = null;
              }
              const isRefinement = (funcName === 'refine_memory_visual');
              const feedback = args.user_feedback || '';
              if (feedback) {
                state.lastUserModification = feedback;
              }
              const rawTitle = args.japanese_title || (isRefinement && feedback ? `${feedback}に修正` : '') || state.sceneCollector.topic || '思い出の情景';
              const rawElements = args.updated_visual_elements || args.visual_elements || feedback || '';

              logDiag(`AIツール呼び出し(${funcName}): 「${rawTitle}」 / 修正指示: 「${feedback}」`);
              dismissCanvasError();

              // 情景情報を情景メモに統合
              state.sceneCollector.topic = rawTitle;
              if (feedback) {
                state.sceneCollector.details.add(`【修正指示】${feedback}`);
              }
              if (rawElements) {
                const parts = rawElements.split(/[、,，/]/);
                parts.forEach(p => {
                  const cp = p.trim();
                  if (cp.length >= 2 && cp.length <= 15 && !cp.includes('描きたい情景') && !cp.includes('会話')) {
                    state.sceneCollector.details.add(cp);
                  }
                });
              }

              // 【最重要安全ガード】ユーザーがまだ絵の描画を承諾していない場合、勝手な自動描画は絶対に禁止！
              // 確認バナー（「🎨 はい、描いてください」）を画面に出して、ご本人の意思を待つ。
              if (isRefinement && feedback) {
                // 修正指示の場合はユーザーが発言した直後なので即時描き直してOK
                state.sceneCollector.status = 'drawing';
                renderSceneCollectorUI();
                setAvatarState('drawing');
                handleDirectMediaGeneration(ws, callId, funcName, {
                  ...args,
                  japanese_title: rawTitle,
                  visual_elements: rawElements,
                  user_feedback: feedback,
                  is_refinement: true
                });
              } else {
                // 新規描画の場合は、勝手に即時描画せず確認待ちにしてループとクォータ浪費を根絶！
                state.sceneCollector.status = 'confirming';
                state.sceneCollector.isAwaitingConfirmation = true;
                state.sceneCollector.pendingArgs = { ws, callId, funcName, args: { ...args, japanese_title: rawTitle, visual_elements: rawElements } };
                renderSceneCollectorUI();

                // Gemini側には「情景を記録しました。確認をお待ちしています」を返送
                if (ws && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    tool_response: {
                      function_responses: [
                        {
                          id: callId,
                          name: funcName,
                          response: { output: { status: 'recorded_awaiting_user_confirmation', message: '情景をメモしました。ご本人の描画承諾をお待ちしています。' } }
                        }
                      ]
                    }
                  }));
                }
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
    const topicForResume = state.previousSessionContext?.lastArtTitle || state.previousSessionContext?.lastTopic || (state.sessionTopics.length > 0 ? state.sessionTopics[state.sessionTopics.length - 1] : '');
    const isResume = !!(topicForResume && (state.hasDrawnImage || state.previousSessionContext));

    if (isResume && topicForResume) {
      dom.partnerStatusText.textContent = `${pName}：${nickname}と「${topicForResume}」のお話を継続中`;
      logDiag(`【案内】前回の話題「${topicForResume}」を引き継いでデモ対話を再開しました。`);
    } else {
      dom.partnerStatusText.textContent = `${pName}：${nickname}とお話し中（デモ体験）`;
      logDiag('【案内】デモ体験（シミュレーション）モードで開始しました。');
    }

    setTimeout(() => {
      if (!state.isSessionActive) return;
      let greet = '';
      if (isResume && topicForResume) {
        greet = `${nickname}、先ほどの${topicForResume}のお話の続きをしましょうか！`;
      } else {
        greet = `こんにちは、${nickname}！パートナーの${pName}です。今日もいいお天気ですね。昔の懐かしい場所や、お仕事のお話を聞かせてくださいね。`;
      }
      dom.aiTranscriptText.textContent = greet;
      speakTextWithWebSpeech(greet);
    }, 500);
  }

  async function stopSession() {
    state.userRequestedStop = true;
    updateStatus('お話を終了しています...', false);

    // 直前の会話文脈（セッション再開時の継続用）を保存
    try {
      const lastTitle = (dom.captionTitle && dom.captionTitle.textContent && dom.captionTitle.textContent !== 'お話に出てきた風景をここに描きます')
        ? dom.captionTitle.textContent.trim() : '';
      const lastTopic = state.sceneCollector?.lastConfirmedTopic || state.sceneCollector?.topic || (state.sessionTopics.length > 0 ? state.sessionTopics[state.sessionTopics.length - 1] : '');
      if (lastTitle || lastTopic || state.sessionTopics.length > 0 || state.hasDrawnImage) {
        state.previousSessionContext = {
          lastTopic: lastTopic || lastTitle,
          lastArtTitle: lastTitle,
          topics: [...state.sessionTopics],
          hasDrawnImage: state.hasDrawnImage
        };
        sessionStorage.setItem('omoide_previous_session', JSON.stringify(state.previousSessionContext));
        logDiag(`【文脈保存】会話を一時終了しました（次回再開時の話題: ${state.previousSessionContext.lastTopic || state.previousSessionContext.lastArtTitle}）`);
      }
    } catch (e) {
      console.warn('Failed to save previous session context:', e);
    }

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
    if (state.pendingRefineTimer) {
      clearTimeout(state.pendingRefineTimer);
      state.pendingRefineTimer = null;
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
    const chunkMs = (bufferSize / actualSampleRate) * 1000;

    let vadSilenceChunks = 0;
    let voiceHangoverChunks = 0;
    let isSpeakingUtterance = false;
    let chunksSentInUtterance = 0;
    let preSpeechRingBuffer = []; // 話し始めの最初の子音（「し」「か」等）が欠けないよう直前6チャンク（約150ms）を保持

    processor.onaudioprocess = (e) => {
      // 出力バッファを明示的にゼロクリアして、スピーカーへのノイズ・発振漏れを完全防止
      try {
        const outBuf = e.outputBuffer.getChannelData(0);
        outBuf.fill(0);
      } catch (err) {}

      if (!state.isSessionActive || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;

      // AI発話中（および発話直後のエコー残響期間）はマイク入力を完全に破棄して送信しない（バージイン誤検知の完全遮断）
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
      const preset = NOISE_GATE_PRESETS[state.noiseGateMode] || NOISE_GATE_PRESETS.normal;
      const targetHangoverChunks = Math.max(4, Math.round((preset.hangoverMs || 400) / chunkMs));
      const targetEosChunks = Math.max(8, Math.round((preset.eosSilenceMs || 650) / chunkMs));
      const minChunksForUtterance = Math.max(2, Math.round(150 / chunkMs));

      const isVoice = (rms > preset.rms) || (Date.now() < (state.userSpeakingUntil || 0));

      if (isVoice) {
        // 発話開始時、直前6チャンク（約150ms）のプリバッファを先に送信して語頭欠けを完全防止
        if (voiceHangoverChunks <= 0 && preSpeechRingBuffer.length > 0) {
          for (const preBuf of preSpeechRingBuffer) {
            sendPcmAudioChunk(preBuf);
            chunksSentInUtterance++;
          }
          preSpeechRingBuffer = [];
        }
        voiceHangoverChunks = targetHangoverChunks;
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
        // しきい値未満（無音または遠くのテレビ音）：サーバーへ送らずプリバッファに直近6チャンクだけ保持
        preSpeechRingBuffer.push(pcm16.buffer.slice(0));
        if (preSpeechRingBuffer.length > 6) {
          preSpeechRingBuffer.shift();
        }

        // 発話直後の沈黙区間：Gemini側のリアルタイムVADに「無音になった」ことを正確に伝えるためゼロPCMを送信
        if (isSpeakingUtterance) {
          vadSilenceChunks++;
          // 無音フレームをGeminiに流すことでGeminiのリアルタイム沈黙検出（650ms）を確実に発火させる
          const zeroPcm = new Int16Array(downsampledData.length);
          sendPcmAudioChunk(zeroPcm.buffer);

          if (vadSilenceChunks >= targetEosChunks) {
            isSpeakingUtterance = false;
            vadSilenceChunks = 0;
            if (chunksSentInUtterance >= minChunksForUtterance) {
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

      recognition.onspeechstart = () => {
        state.userSpeakingUntil = Date.now() + 2500;
      };

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
          state.userSpeakingUntil = Date.now() + 1800;
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
              const mod = detectModificationIntent(textToSend);
              const isApproval = /^(はい|うん|ええ|お願いします|お願い|描いて|そうして|やってみて)/.test(textToSend.trim()) ||
                                 /(描いて|絵にして|キャンバス)/.test(textToSend);
              setTimeout(async () => {
                if (!state.isSessionActive) return;
                if (mod) {
                  const reply = `かしこまりました！「${mod}」ですね、早速描き直してみますね。`;
                  dom.aiTranscriptText.textContent = reply;
                  speakTextWithWebSpeech(reply);
                  await executeRefineDrawing(mod);
                } else if (isApproval && state.sceneCollector.status !== 'drawing') {
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

    // 最優先の修正指示または最新の会話内容を最優先でテーマ判定する
    const refineMatch = (elements || '').match(/【最優先の修正指示[^】]*】:\s*([^/]+)/);
    const latestMatch = (elements || '').match(/【最新の会話内容[^】]*】:\s*([^/]+)/);
    const feedbackText = refineMatch ? refineMatch[1].trim() : '';
    const primaryTopic = (feedbackText || (latestMatch ? latestMatch[1].trim() : (title || elements || ''))).toLowerCase();
    const combined = `${feedbackText} ${primaryTopic} ${title || ''} ${elements || ''}`.toLowerCase();

    const isSunset = /(夕焼け|夕暮れ|夕方|夕日|茜色|夕刻|赤く染ま|モルゲンロート|アーベントロート|秋|赤とんぼ|紅葉|もみじ)/.test(combined);
    const isFlower = /(花|バラ|薔薇|カーネーション|ひまわり|チューリップ|花瓶|一輪挿し|赤い花)/.test(combined);
    const isCoffee = /(コーヒー|珈琲|ブレンド|エスプレッソ|カップ)/.test(combined);
    const isCreamSoda = /(クリームソーダ|ソーダ|メロンソーダ)/.test(combined);

    const isCafe = /(喫茶店|カフェ|コーヒー|珈琲|紅茶|クリームソーダ|ホットケーキ|ナポリタン|パフェ|模擬店の中|店内|テーブル|カップ|茶店|純喫茶|お茶|注文|メニュー|カウンター)/.test(primaryTopic) ||
                   (/(喫茶店|カフェ|コーヒー|珈琲|紅茶|クリームソーダ|ホットケーキ|ナポリタン|パフェ|模擬店の中|店内|テーブル|カップ|茶店|純喫茶)/.test(combined) && !/(校舎の外|学校全体|グラウンド|校門)/.test(primaryTopic));
    const isClassroom = !isCafe && (/(教室の中|教室|黒板|机|教壇|授業|窓際)/.test(primaryTopic) || /(教室の中|黒板|教壇)/.test(combined));
    const isMountain = !isCafe && !isClassroom && (
      /(山|アルプス|連峰|峰|岳|頂|鋭い|尖|険しい|登山|岩山|富士山|北アルプス|南アルプス|八ヶ岳|岩峰|稜線)/.test(primaryTopic) ||
      (/(山|アルプス|連峰|峰|岳|頂|鋭い|尖|険しい|登山|岩山|富士山|岩峰|稜線)/.test(combined) && !/(校舎|学校|教室|喫茶店|カフェ|海)/.test(combined))
    );
    const isSchool = !isCafe && !isClassroom && !isMountain && /(高校|文化祭|学園祭|学校|校舎|中学|小学校|先生|生徒|部活|運動会|体育祭|青春|合唱|バンド|模擬店)/.test(combined);
    const isPetDog = !isCafe && !isClassroom && !isMountain && !isSchool && /(犬|いぬ|イヌ|マルチーズ|柴犬|ポメラニアン|プードル|わんちゃん|ワンちゃん|子犬|猫|ねこ|ペット|座敷|畳)/.test(combined);
    const isWalkShopping = !isCafe && !isClassroom && !isMountain && !isSchool && !isPetDog && /(散歩|歩く|お散歩|買い物|お買い物|商店街|市場|食材|八百屋|魚屋|道端|路地|並木道|遊歩道|通り|夕方の道|買い物袋)/.test(combined);
    const isGarden = !isCafe && !isClassroom && !isMountain && !isSchool && !isPetDog && !isWalkShopping && /(庭|庭園|バラ|薔薇|バラ園|花壇|ガーデン|花畑|赤い花|お花|ひまわり|チューリップ|カーネーション|フラワー|公園)/.test(combined);
    const isSea = !isMountain && !isWalkShopping && !isGarden && /(海|浜|波|砂浜|船|港|沖縄|ハワイ|夏|泳|魚|潮)/.test(combined);
    const isSakura = !isMountain && !isWalkShopping && !isGarden && /(桜|春|花見|ピンク)/.test(combined);
    const isSnow = !isMountain && !isWalkShopping && !isGarden && /(雪|冬|スキー|こたつ|正月|北国|白|氷|北海道|新潟)/.test(combined);

    // 1. テーマ別の水彩空・背景グラデーション
    const skyGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    if (isMountain && isSunset) {
      // 夕日に燃える山（アーベントロート）のドラマチックな茜色・黄昏グラデーション
      skyGrad.addColorStop(0, '#4a154b');
      skyGrad.addColorStop(0.3, '#c84b31');
      skyGrad.addColorStop(0.65, '#f4a261');
      skyGrad.addColorStop(1, '#ffdda1');
    } else if (isMountain) {
      skyGrad.addColorStop(0, '#2b6cb0');
      skyGrad.addColorStop(0.35, '#63b3ed');
      skyGrad.addColorStop(0.7, '#bee3f8');
      skyGrad.addColorStop(1, '#ebf8ff');
    } else if (isGarden) {
      // 陽光あふれる庭園の爽やかな青空と暖かな光のグラデーション
      skyGrad.addColorStop(0, '#70b8eb');
      skyGrad.addColorStop(0.45, '#bfe3f7');
      skyGrad.addColorStop(0.75, '#fefae0');
      skyGrad.addColorStop(1, '#ccd5ae');
    } else if (isPetDog) {
      skyGrad.addColorStop(0, '#fbf7ee');
      skyGrad.addColorStop(0.55, '#f5ebe0');
      skyGrad.addColorStop(1, '#e3d5ca');
    } else if (isWalkShopping) {
      if (isSunset) {
        skyGrad.addColorStop(0, '#e76f51');
        skyGrad.addColorStop(0.4, '#f4a261');
        skyGrad.addColorStop(0.7, '#e9c46a');
        skyGrad.addColorStop(1, '#faedcd');
      } else {
        skyGrad.addColorStop(0, '#64b5f6');
        skyGrad.addColorStop(0.45, '#bbdefb');
        skyGrad.addColorStop(0.75, '#e3f2fd');
        skyGrad.addColorStop(1, '#d8f3dc');
      }
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
      skyGrad.addColorStop(0, '#e76f51');
      skyGrad.addColorStop(0.45, '#f4a261');
      skyGrad.addColorStop(0.75, '#e9c46a');
      skyGrad.addColorStop(1, '#84a59d');
    } else {
      skyGrad.addColorStop(0, '#f5e6d7');
      skyGrad.addColorStop(0.55, '#eef5f2');
      skyGrad.addColorStop(1, '#cfe1b9');
    }
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. 太陽・夕日（屋外のみ）
    if (!isCafe && !isClassroom) {
      ctx.save();
      if (isSunset) {
        // 大きく真っ赤に染まる夕日と光輪
        ctx.fillStyle = 'rgba(235, 75, 45, 0.88)';
        ctx.beginPath();
        ctx.arc(680, 185, 62, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(244, 162, 97, 0.38)';
        ctx.beginPath();
        ctx.arc(680, 185, 96, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(255, 238, 173, 0.75)';
        ctx.beginPath();
        ctx.arc(650, 130, 52, 0, Math.PI * 2);
        ctx.fill();
      }
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

      // 窓際・テーブルの花瓶と赤いお花（ユーザーの修正指示「お花を置いて」に忠実に対応）
      if (isFlower) {
        // テーブル上の花瓶
        ctx.fillStyle = 'rgba(230, 245, 255, 0.85)';
        ctx.strokeStyle = '#457b9d';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(385, 415, 12, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillRect(377, 385, 16, 30);
        ctx.strokeRect(377, 385, 16, 30);
        // 緑の茎
        ctx.strokeStyle = '#2d6a4f';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(385, 385);
        ctx.lineTo(385, 352);
        ctx.stroke();
        // 赤いバラ・カーネーションの花
        ctx.fillStyle = '#e63946';
        ctx.beginPath();
        ctx.arc(385, 348, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#d90429';
        ctx.beginPath();
        ctx.arc(382, 345, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ff758f';
        ctx.beginPath();
        ctx.arc(387, 344, 5, 0, Math.PI * 2);
        ctx.fill();
      }

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
      // 夕焼け（アーベントロート）と青空の動的カラーパレット
      const distantColor = isSunset ? '#6a2c4e' : '#5c6d82';
      const mainLeftColor = isSunset ? '#e76f51' : '#9cb3c9'; // 夕日に赤く燃える主峰
      const mainRightColor = isSunset ? '#3a102a' : '#2c3e50'; // 深い岩陰
      const subLeftColor = isSunset ? '#d9480f' : '#829ab1';
      const subRightColor = isSunset ? '#29091e' : '#1a2530';
      const snowColor = isSunset ? '#ffcad4' : '#ffffff';     // 夕照に淡いピンクに染まる雪渓
      const forestColor = isSunset ? '#230c22' : '#1e293b';

      // 1. 遠景の険しいギザギザ連峰（シルエット）
      ctx.fillStyle = distantColor;
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
      // 左側斜面（ハイライト）
      ctx.fillStyle = mainLeftColor;
      ctx.beginPath();
      ctx.moveTo(110, 460);
      ctx.lineTo(380, 75); // 天を突く鋭い主峰の頂点！
      ctx.lineTo(380, 460);
      ctx.closePath();
      ctx.fill();

      // 右側斜面（切り立った深い岩陰）
      ctx.fillStyle = mainRightColor;
      ctx.beginPath();
      ctx.moveTo(380, 75);
      ctx.lineTo(600, 460);
      ctx.lineTo(380, 460);
      ctx.closePath();
      ctx.fill();

      // 鋭い第二岩峰（険しい針峰）
      ctx.fillStyle = subLeftColor;
      ctx.beginPath();
      ctx.moveTo(460, 450);
      ctx.lineTo(620, 115); // 鋭い山頂
      ctx.lineTo(620, 450);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = subRightColor;
      ctx.beginPath();
      ctx.moveTo(620, 115);
      ctx.lineTo(760, 450);
      ctx.lineTo(620, 450);
      ctx.closePath();
      ctx.fill();

      // 3. 切り立った岩肌のシャープな亀裂・稜線（ドラマチックな陰影線）
      ctx.strokeStyle = isSunset ? 'rgba(255, 220, 180, 0.55)' : 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(380, 75);
      ctx.lineTo(290, 230);
      ctx.lineTo(340, 310);
      ctx.lineTo(260, 460);
      ctx.stroke();

      ctx.strokeStyle = isSunset ? 'rgba(40, 10, 30, 0.7)' : 'rgba(15, 23, 42, 0.6)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(380, 75);
      ctx.lineTo(440, 210);
      ctx.lineTo(410, 320);
      ctx.lineTo(490, 460);
      ctx.stroke();

      // 4. 山頂の尖った万年雪・鋭い氷河雪渓（純白または夕照ピンクのシャープな冠雪）
      ctx.fillStyle = snowColor;
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

      // 5. 山腹にたなびく幻想的な雲海
      const cloudGrad = ctx.createLinearGradient(0, 360, 0, 450);
      if (isSunset) {
        cloudGrad.addColorStop(0, 'rgba(255, 210, 170, 0.85)');
        cloudGrad.addColorStop(0.5, 'rgba(244, 162, 97, 0.6)');
        cloudGrad.addColorStop(1, 'rgba(244, 162, 97, 0)');
      } else {
        cloudGrad.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
        cloudGrad.addColorStop(0.5, 'rgba(240, 248, 255, 0.6)');
        cloudGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      }
      ctx.fillStyle = cloudGrad;
      ctx.fillRect(0, 360, canvas.width, 90);

      // 6. 麓の針葉樹林（深い原生林のモミの木）
      ctx.fillStyle = forestColor;
      ctx.fillRect(0, 445, canvas.width, 155);
      const pineColors = isSunset ? ['#1e0a1b', '#2c1028', '#381632'] : ['#0d2818', '#1b4332', '#2d6a4f'];
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
    } else if (isPetDog) {
      // 和室・座敷の温かい光と、元気に遊ぶ白いマルチーズ
      // 1. 部屋の壁と障子（左奥）
      ctx.fillStyle = '#f7f1e3';
      ctx.fillRect(0, 0, canvas.width, 360);

      // 障子
      ctx.fillStyle = '#fffdf5';
      ctx.fillRect(80, 50, 320, 290);
      ctx.strokeStyle = '#8b5e3c';
      ctx.lineWidth = 4;
      ctx.strokeRect(80, 50, 320, 290);

      // 格子
      ctx.lineWidth = 1.5;
      for (let gx = 130; gx < 400; gx += 50) {
        ctx.beginPath();
        ctx.moveTo(gx, 50);
        ctx.lineTo(gx, 340);
        ctx.stroke();
      }
      for (let gy = 90; gy < 340; gy += 45) {
        ctx.beginPath();
        ctx.moveTo(80, gy);
        ctx.lineTo(400, gy);
        ctx.stroke();
      }

      // 障子から差し込む温かい陽光
      const sunLight = ctx.createLinearGradient(120, 50, 480, 550);
      sunLight.addColorStop(0, 'rgba(255, 248, 220, 0.45)');
      sunLight.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = sunLight;
      ctx.beginPath();
      ctx.moveTo(80, 340);
      ctx.lineTo(400, 340);
      ctx.lineTo(580, 600);
      ctx.lineTo(0, 600);
      ctx.closePath();
      ctx.fill();

      // 2. 畳（座敷）
      ctx.fillStyle = '#c5d19b';
      ctx.fillRect(0, 340, canvas.width, 260);

      // 畳の縁（へり）
      ctx.fillStyle = '#2f4f4f';
      ctx.fillRect(0, 450, canvas.width, 8);
      ctx.fillRect(0, 570, canvas.width, 8);

      // 畳の目
      ctx.strokeStyle = 'rgba(180, 192, 140, 0.6)';
      ctx.lineWidth = 1;
      for (let ty = 360; ty < 600; ty += 20) {
        if (ty === 450 || ty === 570) continue;
        ctx.beginPath();
        ctx.moveTo(0, ty);
        ctx.lineTo(canvas.width, ty);
        ctx.stroke();
      }

      // 3. お父さんの温かい座布団（右奥）
      ctx.fillStyle = '#9e474f';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(560, 380, 140, 95, [14, 14, 14, 14]) : ctx.rect(560, 380, 140, 95);
      ctx.fill();
      ctx.strokeStyle = '#782d34';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      // 座布団の四隅の房（ふさ）
      ctx.fillStyle = '#f4a261';
      for (const [fx, fy] of [[560, 380], [700, 380], [560, 475], [700, 475]]) {
        ctx.beginPath();
        ctx.arc(fx, fy, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // 4. 座敷の中央で元気に走る・立つ愛らしい白いマルチーズ
      const dogX = 380;
      const dogY = 410;

      // ふわふわの白い胴体
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#e2e2e2';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(dogX + 50, dogY + 45, 55, 38, -0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // ふわふわの頭
      ctx.beginPath();
      ctx.arc(dogX, dogY + 15, 34, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // 垂れた愛らしい耳
      ctx.fillStyle = '#faf6f0';
      ctx.beginPath();
      ctx.ellipse(dogX - 24, dogY + 22, 12, 24, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(dogX + 24, dogY + 22, 12, 24, -0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // つぶらな黒い瞳（ハイライト入り）
      ctx.fillStyle = '#222222';
      ctx.beginPath();
      ctx.arc(dogX - 10, dogY + 12, 4.5, 0, Math.PI * 2);
      ctx.arc(dogX + 10, dogY + 12, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(dogX - 11.5, dogY + 10.5, 1.5, 0, Math.PI * 2);
      ctx.arc(dogX + 8.5, dogY + 10.5, 1.5, 0, Math.PI * 2);
      ctx.fill();

      // 小さな黒い鼻とお口
      ctx.fillStyle = '#222222';
      ctx.beginPath();
      ctx.ellipse(dogX, dogY + 22, 4, 3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#444444';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(dogX - 3, dogY + 26, 3, 0, Math.PI);
      ctx.arc(dogX + 3, dogY + 26, 3, 0, Math.PI);
      ctx.stroke();

      // 元気な足（トコトコ走る・立つポーズ）
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#e2e2e2';
      ctx.lineWidth = 1.5;
      for (const [lx, ly] of [[dogX - 8, dogY + 70], [dogX + 22, dogY + 72], [dogX + 68, dogY + 68], [dogX + 92, dogY + 66]]) {
        ctx.beginPath();
        ctx.ellipse(lx, ly, 8, 14, 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // ピンと立った嬉しいふわふわのしっぽ
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(dogX + 105, dogY + 20, 14, 22, 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // 首元の赤いリボン
      ctx.fillStyle = '#e63946';
      ctx.beginPath();
      ctx.arc(dogX, dogY + 42, 6, 0, Math.PI * 2);
      ctx.fill();
    } else if (isWalkShopping) {
      // 買い物帰りののどかな散歩道・商店街・並木道
      // 1. 遠景：昭和レトロな街並み・瓦屋根・優しい家並み
      const houseBaseColor = isSunset ? '#b07d62' : '#9c8e80';
      const roofColor = isSunset ? '#5c3d2e' : '#4a5568';
      for (let h = 0; h < 7; h++) {
        const hx = 30 + h * 115;
        const hy = 290 + (h % 3) * 12;
        const hw = 95;
        const hh = 120;
        ctx.fillStyle = houseBaseColor;
        ctx.fillRect(hx, hy, hw, hh);
        // 三角屋根
        ctx.fillStyle = roofColor;
        ctx.beginPath();
        ctx.moveTo(hx - 8, hy);
        ctx.lineTo(hx + hw / 2, hy - 40);
        ctx.lineTo(hx + hw + 8, hy);
        ctx.closePath();
        ctx.fill();
        // 優しい明かりの窓
        ctx.fillStyle = isSunset ? '#ffe3a8' : '#e2f1ff';
        ctx.fillRect(hx + 18, hy + 22, 28, 28);
        ctx.fillRect(hx + 52, hy + 22, 28, 28);
      }

      // 2. 地面・草地（散歩道の両脇）
      ctx.fillStyle = isSunset ? '#938170' : '#8cb369';
      ctx.fillRect(0, 390, canvas.width, 210);

      // 3. 散歩道（奥から手前へゆるやかに広がる遠近感のある道）
      ctx.fillStyle = isSunset ? '#d5bdaf' : '#f0ebd8';
      ctx.beginPath();
      ctx.moveTo(420, 385);
      ctx.quadraticCurveTo(440, 470, 720, 600);
      ctx.lineTo(240, 600);
      ctx.quadraticCurveTo(360, 480, 370, 385);
      ctx.closePath();
      ctx.fill();

      // 道の陰影・石畳風テクスチャ
      ctx.strokeStyle = isSunset ? 'rgba(141, 110, 99, 0.45)' : 'rgba(188, 160, 130, 0.45)';
      ctx.lineWidth = 2;
      for (let step = 0; step < 7; step++) {
        const sy = 405 + step * 27;
        const sw = 55 + step * 48;
        const sx = 400 - sw / 2 + step * 16;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + sw, sy + 3);
        ctx.stroke();
      }

      // 4. レトロな木製電柱と電線・温かい街灯
      ctx.fillStyle = '#6f4e37';
      ctx.fillRect(160, 160, 14, 300);
      // 腕木
      ctx.fillRect(130, 190, 75, 8);
      ctx.fillRect(140, 225, 55, 6);
      // 電線
      ctx.strokeStyle = 'rgba(60, 40, 30, 0.65)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(0, 175);
      ctx.quadraticCurveTo(80, 205, 165, 190);
      ctx.quadraticCurveTo(450, 240, 800, 170);
      ctx.stroke();
      // 街灯の丸いランプ
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(195, 230, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = isSunset ? 'rgba(255, 200, 80, 0.55)' : 'rgba(255, 240, 150, 0.4)';
      ctx.beginPath();
      ctx.arc(195, 230, 32, 0, Math.PI * 2);
      ctx.fill();

      // 5. 並木道（散歩道の脇の緑豊かなケヤキ・桜・イチョウの木々）
      const treeColors = isSunset ? ['#582f0e', '#7f4f24', '#936639'] : ['#2d6a4f', '#40916c', '#52b788'];
      const treeX = [70, 280, 680, 770];
      for (let i = 0; i < treeX.length; i++) {
        const tx = treeX[i];
        const ty = 340 + (i % 2) * 20;
        // 幹
        ctx.fillStyle = '#6b4c35';
        ctx.fillRect(tx - 6, ty, 14, 85);
        // 葉の茂み（水彩タッチのふんわりとした丸み）
        ctx.fillStyle = treeColors[i % treeColors.length];
        ctx.beginPath();
        ctx.arc(tx, ty - 25, 48, 0, Math.PI * 2);
        ctx.arc(tx - 26, ty - 10, 36, 0, Math.PI * 2);
        ctx.arc(tx + 26, ty - 10, 36, 0, Math.PI * 2);
        ctx.fill();
      }

      // 6. 道端の可愛らしい草花（タンポポ・シロツメクサ・レンゲ）
      const flowerColors = ['#f4a261', '#e76f51', '#e9c46a', '#ffffff', '#ffb5a7'];
      for (let f = 0; f < 32; f++) {
        const fx = 30 + (f * 24) % 740;
        const fy = 410 + (f * 17) % 170;
        // 散歩道の真ん中を避けて両脇に咲かせる
        if (fx > 310 && fx < 580 && fy > 440) continue;
        ctx.fillStyle = flowerColors[f % flowerColors.length];
        ctx.beginPath();
        ctx.arc(fx, fy, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // 7. 手前の温かいモチーフ（買い物袋と食材・お散歩の温もり）
      // クラフト紙袋
      ctx.fillStyle = '#ddb892';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(140, 480, 72, 85, [6, 6, 8, 8]) : ctx.rect(140, 480, 72, 85);
      ctx.fill();
      ctx.strokeStyle = '#b08968';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      // 買い物袋からのぞく新鮮な食材（青ネギとバゲット）
      // ネギ
      ctx.fillStyle = '#52b788';
      ctx.beginPath();
      ctx.moveTo(150, 480);
      ctx.lineTo(135, 420);
      ctx.lineTo(146, 415);
      ctx.lineTo(158, 480);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(146, 455, 12, 28);
      // フランスパン・バゲット
      ctx.fillStyle = '#c89f78';
      ctx.beginPath();
      ctx.moveTo(170, 480);
      ctx.lineTo(185, 410);
      ctx.lineTo(202, 415);
      ctx.lineTo(192, 480);
      ctx.closePath();
      ctx.fill();
    } else if (isGarden) {
      // 陽光あふれる庭園と満開の赤いバラ（緑の芝生・白い木製フェンス・真紅のバラの花壇・木漏れ日）
      // 1. 遠景の柔らかな緑の木々（ソフトフォーカス）
      ctx.fillStyle = '#a7c957';
      for (let i = 0; i < 7; i++) {
        const bx = i * 130 - 30;
        ctx.beginPath();
        ctx.arc(bx + 70, 310, 85, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2. 背景の木漏れ日・光の筋（サンビーム）
      const sunRays = ctx.createLinearGradient(650, 100, 200, 600);
      sunRays.addColorStop(0, 'rgba(255, 255, 220, 0.45)');
      sunRays.addColorStop(1, 'rgba(255, 255, 220, 0)');
      ctx.fillStyle = sunRays;
      ctx.beginPath();
      ctx.moveTo(650, 100);
      ctx.lineTo(100, 600);
      ctx.lineTo(400, 600);
      ctx.closePath();
      ctx.fill();

      // 3. 白いガーデンウッドフェンス
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.strokeStyle = '#c9cba3';
      ctx.lineWidth = 1.5;
      ctx.fillRect(0, 320, canvas.width, 10);
      ctx.strokeRect(0, 320, canvas.width, 10);
      ctx.fillRect(0, 355, canvas.width, 10);
      ctx.strokeRect(0, 355, canvas.width, 10);
      for (let fx = 20; fx < canvas.width; fx += 55) {
        ctx.beginPath();
        ctx.moveTo(fx, 380);
        ctx.lineTo(fx, 290);
        ctx.lineTo(fx + 10, 278);
        ctx.lineTo(fx + 20, 290);
        ctx.lineTo(fx + 20, 380);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      // 4. 青々とした芝生の大地
      const lawnGrad = ctx.createLinearGradient(0, 380, 0, 600);
      lawnGrad.addColorStop(0, '#6a994e');
      lawnGrad.addColorStop(1, '#386641');
      ctx.fillStyle = lawnGrad;
      ctx.fillRect(0, 380, canvas.width, 220);

      // 5. 豊かなバラの茂み（オリーブグリーンとエメラルドグリーン）
      const bushCenters = [130, 260, 420, 580, 720];
      for (const cx of bushCenters) {
        ctx.fillStyle = '#283618';
        ctx.beginPath();
        ctx.arc(cx, 440, 75, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#386641';
        ctx.beginPath();
        ctx.arc(cx - 20, 430, 65, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#6a994e';
        ctx.beginPath();
        ctx.arc(cx + 20, 420, 55, 0, Math.PI * 2);
        ctx.fill();
      }

      // 6. 満開の美しい赤いバラ（立体的な花びらの重なり・真紅・クリムゾン・ローズピンク）
      const roses = [
        { x: 140, y: 400, r: 28 },
        { x: 220, y: 440, r: 24 },
        { x: 300, y: 390, r: 32 },
        { x: 390, y: 450, r: 26 },
        { x: 470, y: 385, r: 35 }, // 中央の主役の大きな赤いバラ
        { x: 550, y: 430, r: 28 },
        { x: 640, y: 395, r: 30 },
        { x: 730, y: 440, r: 25 },
        { x: 360, y: 500, r: 22 },
        { x: 520, y: 505, r: 24 }
      ];

      for (const rose of roses) {
        // 外側の花びら（深紅）
        ctx.fillStyle = '#9b111e';
        ctx.beginPath();
        ctx.arc(rose.x, rose.y, rose.r, 0, Math.PI * 2);
        ctx.fill();

        // 中間の花びら（鮮やかな赤）
        ctx.fillStyle = '#d90429';
        for (let p = 0; p < 5; p++) {
          const angle = (p * Math.PI * 2) / 5;
          const px = rose.x + Math.cos(angle) * (rose.r * 0.45);
          const py = rose.y + Math.sin(angle) * (rose.r * 0.45);
          ctx.beginPath();
          ctx.arc(px, py, rose.r * 0.55, 0, Math.PI * 2);
          ctx.fill();
        }

        // 花の中心（ベルベットレッド）
        ctx.fillStyle = '#ef233c';
        ctx.beginPath();
        ctx.arc(rose.x, rose.y, rose.r * 0.48, 0, Math.PI * 2);
        ctx.fill();

        // 渦巻き状の花芯（ハイライト）
        ctx.fillStyle = '#ff758f';
        ctx.beginPath();
        ctx.arc(rose.x - 2, rose.y - 2, rose.r * 0.22, 0, Math.PI * 2);
        ctx.fill();

        // バラの緑の葉（左右）
        ctx.fillStyle = '#2d6a4f';
        ctx.beginPath();
        ctx.ellipse(rose.x - rose.r * 0.9, rose.y + rose.r * 0.4, 14, 7, -0.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(rose.x + rose.r * 0.9, rose.y + rose.r * 0.4, 14, 7, 0.6, 0, Math.PI * 2);
        ctx.fill();
      }

      // 7. 風に舞う優しい赤い花びら（そよ風の表現）
      ctx.fillStyle = 'rgba(239, 35, 60, 0.75)';
      for (let i = 0; i < 18; i++) {
        const px = (i * 47 + 70) % 760;
        const py = 160 + (i * 23) % 360;
        ctx.beginPath();
        ctx.ellipse(px, py, 9, 5, 0.8, 0, Math.PI * 2);
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
    const bx = 28, by = 28, bw = 480, bh = 94;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(bx, by, bw, bh, 12);
    } else {
      ctx.rect(bx, by, bw, bh);
    }
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#d97706';
    ctx.font = 'bold 13px "Noto Sans JP", sans-serif';
    ctx.fillText('🎨 おもいでキャンバス（※簡易水彩画・制限中）', bx + 16, by + 24);

    const cleanTitle = (title || '思い出の風景').replace(/\n/g, ' ').slice(0, 18);
    ctx.fillStyle = '#2c5e4f';
    ctx.font = 'bold 20px "Noto Sans JP", sans-serif';
    ctx.fillText(cleanTitle, bx + 16, by + 52);

    ctx.fillStyle = '#b45309';
    ctx.font = '11px "Noto Sans JP", sans-serif';
    ctx.fillText('※AIクォータ制限のため簡易イラストです。会話内容と異なる場合があります。', bx + 16, by + 78);

    return canvas.toDataURL('image/jpeg', 0.88);
  }

  async function generateStandaloneMemoryArtifact(args) {
    const profile = state.currentProfile || DEFAULT_USER_PROFILE;
    const sceneType = args.scene_type || 'past_memory';
    const title = args.japanese_title || '思い出の風景';
    const elements = args.visual_elements || args.updated_visual_elements || title;
    const ambientSound = args.ambient_sound || 'autumn_insects';
    const feedback = (args.user_feedback || '').trim();
    const isRefinement = !!args.is_refinement || !!feedback;
    const finalPrompt = buildSafePromptJS(profile.dementia_level || 'mild', sceneType, elements);

    const artStyleKey = args.art_style || state.currentArtStyle || 'watercolor';
    const artStyle = ART_STYLES[artStyleKey] || ART_STYLES.watercolor;

    let mediaDataUrl = '';
    const apiKey = (state.sessionApiKey || '').trim();

    if (apiKey) {
      // Step 0: Gemini 3.8 Flash によるオーダーメイド情景画（SVG）生成
      // 外部画像サービスの Artists limit・レート制限に一切依存せず、Google公式APIで100%確実に話の内容を描画！
      try {
        if (dom.drawingSubtext) dom.drawingSubtext.textContent = `AI画家が「${artStyle.name}」でお話の情景を描いています（約2〜4秒）...`;
        logDiag(`AI情景描画を開始します: 「${title}」 (画風: ${artStyle.name}) - 内容: 「${elements}」`);

        const svgPrompt = `あなたは高齢者・回想法ケアのための${artStyle.svgRoleInstruction}です。
ユーザーが語った思い出のお話に合わせて、指定された情景の【${artStyle.name}】風SVGイラスト（viewBox="0 0 800 600"）を1枚描いてください。

【描く情景・ユーザーの言葉（最優先遵守）】:
${elements}

【画風スタイル（最重要厳守）】:
画風：${artStyle.name}
表現方針：${artStyle.promptModifier}

${isRefinement && feedback ? `【最重要：ユーザーからの絵の修正・変更指示（絶対厳守！）】
ユーザーは直前の絵に対して「${feedback}」という明確な修正を求めています。
前回の絵と矛盾する要素（例：青空から夕焼けへの変更、花の追加、特定モチーフの変更など）がある場合は、必ずこの修正指示を最優先で上書き・反映してください！
夕焼けなら空全体を燃えるような茜色・黄金色のグラデーション（アーベントロート）にし、花ならテーブルや窓際に美しい花瓶とお花をはっきりと描いてください。` : ''}

【画風特化造形ルール（${artStyle.name}）】
${artStyle.svgStyleRules}

【必須造形ルール】
1. ユーザーがお話しした具体的なモチーフ（山、夕焼け、海、学校、教室、喫茶店、花、柿、木製テーブル、窓、雪、川など）を省略せず、すべて目に見える形で魅力的に描いてください。
   - 喫茶店が話題の場合：木目のテーブル、カップ、花瓶、温かい照明、窓際の光と影を豊かに描いてください。
   - 柿が話題の場合：鮮やかなオレンジ色の柿の実、つややかな質感、葉、枝、澄んだ秋の青空を生き生きと描いてください。
   - 山が話題の場合：鋭角な三角形やポリゴン（<polygon>）を使い、険しい岩肌や尖った山頂、雪渓をダイナミックに描いてください。
2. <defs> 内に <linearGradient> や <radialGradient> を効果的に定義し、${artStyle.name}らしい深みのあるグラデーションを背景やモチーフに適用してください。
3. 人物のリアルな顔は描かず、情景・静物・風景を主役にしてください。
4. 必ず <svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg"> で始まり </svg> で終わる完全なSVGコードのみを出力してください。解説文やマークダウンのコード枠（\`\`\`xml 等）は一切含めないでください。`;

        // 503高負荷やクォータ制限時も即座に代替できるよう多段モデルフォールバックを適用
        const candidateModels = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'];
        for (const modelName of candidateModels) {
          try {
            logDiag(`AI情景描画を試行中 (${modelName}): 「${title}」`);
            const resSvg = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: svgPrompt }] }],
                  generationConfig: { temperature: 0.3, maxOutputTokens: 6000 }
                }),
                signal: AbortSignal.timeout ? AbortSignal.timeout(28000) : undefined
              }
            );
            recordApiCall(resSvg.headers, resSvg.status);
            if (resSvg.ok) {
              const dataSvg = await resSvg.json();
              const rawText = dataSvg?.candidates?.[0]?.content?.parts?.[0]?.text || '';
              let svgMatch = rawText.match(/<svg[\s\S]*?<\/svg>/i);
              // 万が一末尾タグ手前で切れていた場合の自己修復
              if (!svgMatch && rawText.includes('<svg')) {
                const startIdx = rawText.indexOf('<svg');
                svgMatch = [rawText.slice(startIdx) + '\n</svg>'];
              }
              if (svgMatch && svgMatch[0]) {
                const cleanSvg = svgMatch[0];
                mediaDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cleanSvg)}`;
                dismissCanvasError();
                logDiag(`Gemini (${modelName}) によるオーダーメイド情景水彩画(SVG)の描画に成功しました！`);
                break;
              }
            } else {
              logDiag(`モデル ${modelName} 応答ステータス: ${resSvg.status}。次の候補モデルを試行します。`);
            }
          } catch (mErr) {
            logDiag(`モデル ${modelName} エラー: ${mErr.message}。次の候補モデルを試行します。`);
          }
        }
      } catch (svgErr) {
        logDiag(`Gemini SVG API応答なし/タイムアウト: 即座にローカル水彩画エンジンで描画します (${svgErr.message})`);
      }
    }

    // AIモデルで描画できなかった場合の処理（ユーザー指示: 過去の映像やダミー絵を出さず、白紙のまま報告する）
    let isFallback = false;
    let isBlank = false;
    if (!mediaDataUrl) {
      logDiag('AIモデルで画像生成できませんでした（クォータ制限等）。指示に従いキャンバスは白紙のままとします。');
      isFallback = true;
      isBlank = true;
      mediaDataUrl = '';
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
      ambient_sound: ambientSound,
      is_fallback: isFallback,
      is_blank: isBlank
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
      const isRefinement = (funcName === 'refine_memory_visual') || !!args.user_feedback;
      const feedback = (args.user_feedback || '').trim();
      const latestUserTopic = state.sessionTopics[state.sessionTopics.length - 1] || '';
      const rawElements = args.visual_elements || args.updated_visual_elements || feedback || latestUserTopic;

      let combinedElements = '';
      if (isRefinement && feedback) {
        // 修正指示がある場合は、前回の絵に対する変更点を絶対最優先で明記！
        combinedElements = `【最優先の修正指示（直前の絵をこの通りに変更・描き直し）】: ${feedback} / 【修正後の全体情景】: ${rawElements}`;
        state.lastDrawnUtterance = feedback;
      } else {
        combinedElements = latestUserTopic
          ? `【最新の会話内容（最優先）】: ${latestUserTopic} / 【情景描写】: ${rawElements}`
          : rawElements;
        if (latestUserTopic) state.lastDrawnUtterance = latestUserTopic;
      }

      const finalTitle = args.japanese_title || (isRefinement && feedback ? `${feedback}に修正` : '') || latestUserTopic.slice(0, 18) || '思い出の風景';

      const enrichedArgs = {
        ...args,
        japanese_title: finalTitle,
        visual_elements: combinedElements,
        user_feedback: feedback,
        is_refinement: isRefinement
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
          const topicForResume = state.previousSessionContext?.lastArtTitle || state.previousSessionContext?.lastTopic || '';
          if (topicForResume && (state.hasDrawnImage || state.previousSessionContext)) {
            dom.partnerStatusText.textContent = `${pName}：${cleanName}さんと「${topicForResume}」のお話を継続中`;
          } else {
            dom.partnerStatusText.textContent = `${pName}：${cleanName}さんとお話し中`;
          }
          setAvatarState('listening');
          if (state.isSimulation) {
            logDiag('【案内】ローカルシミュレーションモードで接続しました。');
          }
          break;
        }

        case 'transcript':
          // 文字起こし字幕の更新 ＆ リアルタイム情景ディテール抽出
          if (data.role === 'model' && data.text) {
            dom.aiTranscriptText.textContent = data.text;
            updateSceneCollectorFromText(data.text, 'ai');
            // シミュレーションモード時はブラウザ音声合成で喋らせる！
            if (state.isSimulation) {
              speakTextWithWebSpeech(data.text);
            }
          } else if (data.role === 'user' && data.text) {
            dom.userTranscriptText.textContent = `「${data.text}」`;
            updateSceneCollectorFromText(data.text, 'user');
          }
          break;

        case 'avatar_state':
          if (data.state === 'listening' && (state.isAiSpeaking || state.isDrawingMedia)) {
            break;
          }
          setAvatarState(data.state);
          break;

        case 'interrupted':
          // Gemini側で割り込みを検知した場合でも、スピーカー再生キューに残っている音声は途中で破棄せず最後まで温かく話し切らせる（エコー誤検知による発話中断の完全防止）
          logDiag('Gemini割り込み通知を受信（再生キュー終了後に自然に待機状態へ移行します）');
          break;

        case 'cooldown_notice':
          logDiag(`サーバー待機通知: ${data.message}`);
          showCanvasError('描画待機中（クォータ保護）', data.message, true);
          if (data.remaining_seconds) {
            state.lastDrawTime = Date.now() - (MIN_DRAW_INTERVAL_MS - data.remaining_seconds * 1000);
            startDrawCooldownTimer();
          }
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

    // ハードウェアレベルでの再生完了イベント（タイマーと二重で保護し、最後のチャンク終了時に即座にマイクを解放）
    source.onended = () => {
      if (ctx.currentTime >= state.nextPlaybackTime - 0.05) {
        state.isAiSpeaking = false;
        if (!state.isDrawingMedia) {
          setAvatarState('listening');
        }
        if (state.socket && state.socket.readyState === WebSocket.OPEN && !state.isDirectGeminiWs) {
          state.socket.send(JSON.stringify({ type: 'ai_speech_ended' }));
        }
      }
    };

    // AI発話中フラグをONにしてマイクエコーを遮断
    state.isAiSpeaking = true;
    if (!state.isDrawingMedia) {
      setAvatarState('speaking');
    }

    if (state.aiSpeechEndTimer) {
      clearTimeout(state.aiSpeechEndTimer);
    }
    // スピーカーからの出音余韻マージン（150ms）
    const remainingMs = Math.max(100, (state.nextPlaybackTime - ctx.currentTime) * 1000 + 150);
    state.aiSpeechEndTimer = setTimeout(() => {
      state.isAiSpeaking = false;
      if (!state.isDrawingMedia) {
        setAvatarState('listening');
      }
      // バックエンドへ再生終了を即座に通知し、マイクのエコーガードを解放
      if (state.socket && state.socket.readyState === WebSocket.OPEN && !state.isDirectGeminiWs) {
        state.socket.send(JSON.stringify({ type: 'ai_speech_ended' }));
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
      // 発話終了後、余韻マージン（150ms）待ってからマイクを再開
      setTimeout(() => {
        state.isAiSpeaking = false;
        setAvatarState('listening');
        if (state.socket && state.socket.readyState === WebSocket.OPEN && !state.isDirectGeminiWs) {
          state.socket.send(JSON.stringify({ type: 'ai_speech_ended' }));
        }
      }, 150);
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
    // 描画処理が進行中の間は、描画完了時（明示的な終了呼び出し）以外の状態変化を完全にブロック！
    // （描画中に相槌音声やテキスト受信によってアバターがガタガタ動くのを100%防止）
    if (state.isDrawingMedia && avatarState !== 'drawing' && avatarState !== 'idle' && avatarState !== 'force_reset') {
      return;
    }

    if (avatarState === 'drawing') {
      state.isDrawingMedia = true;
    } else if (avatarState === 'force_reset') {
      state.isDrawingMedia = false;
      avatarState = state.isSessionActive ? 'listening' : 'idle';
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
  function showCanvasUpdateToast(title = '') {
    if (!dom.canvasUpdateToast) return;
    if (dom.canvasUpdateToastText) {
      dom.canvasUpdateToastText.textContent = title ? `✨ 「${title}」を描き直しました` : '✨ 新しい情景を描き直しました';
    }
    dom.canvasUpdateToast.classList.remove('hidden');
    setTimeout(() => {
      dom.canvasUpdateToast?.classList.add('hidden');
    }, 3800);
  }

  function displayGeneratedMedia(mediaData) {
    state.isDrawingMedia = false;
    dom.drawingOverlay.classList.add('hidden');

    const title = mediaData.title || '思い出の情景';
    dom.captionTitle.textContent = title;

    // 聞き取った情景ディテールを情景メモに確実に反映
    const rawElements = mediaData.visual_elements || mediaData.visual_description || '';
    if (rawElements) {
      const parts = rawElements.split(/[、,，/／\n]/);
      parts.forEach(p => {
        const cp = p.trim().replace(/^【.*?】[:：]?\s*/, '');
        if (cp.length >= 2 && cp.length <= 20 && !cp.includes('水彩画風') && !cp.includes('ノスタルジー')) {
          state.sceneCollector.details.add(cp);
        }
      });
    }
    if (title && title !== '思い出の情景') {
      state.sceneCollector.topic = title;
    }

    const isBlank = !!(mediaData.is_blank || !mediaData.media_url);
    state.currentArtifact = mediaData;

    if (isBlank) {
      // ユーザー指示: AIモデルで描けなかった時は過去画像やダミー絵を出さず、白紙のまま報告する
      state.hasDrawnImage = false;
      dom.btnSaveImage?.classList.add('hidden');
      dom.canvasPlaceholder.classList.remove('hidden');
      dom.memoryImage.classList.add('hidden');
      dom.memoryImage.src = '';
      dom.memoryVideo.classList.add('hidden');
      try { dom.memoryVideo.pause(); } catch (e) {}

      dom.captionTitle.textContent = `${title}（描画制限のため白紙）`;
      dom.captionTag.textContent = '白紙 (描画制限)';
      dom.captionFallbackBadge?.classList.add('hidden');
      dom.captionFallbackNotice?.classList.add('hidden');

      const rInfo = getPacificResetTimeInfo();
      showCanvasError(
        '⚠️ AIモデルの描画制限のため白紙',
        `Google AIのクォータ上限（429）のため、新しい絵を生成できませんでした。ご要望通りキャンバスは白紙のままお話を続けます。（本日${rInfo.timeStr}リセット予定）`,
        true
      );

      const reportMsg = `AIの描画制限のため、今回は絵を描くことができませんでした。キャンバスは白紙のままですが、このままお話を楽しく続けましょうね。`;
      dom.aiTranscriptText.textContent = reportMsg;
      if (state.isSimulation) {
        speakTextWithWebSpeech(reportMsg);
      }
    } else {
      state.hasDrawnImage = true;
      dom.btnSaveImage?.classList.remove('hidden');
      dom.canvasPlaceholder.classList.add('hidden');
      const curStyle = ART_STYLES[state.currentArtStyle] || ART_STYLES.watercolor;
      dom.captionTag.textContent = mediaData.media_format === 'video' ? '動く絵本' : curStyle.name;
      dom.captionFallbackBadge?.classList.add('hidden');
      dom.captionFallbackNotice?.classList.add('hidden');
      dismissCanvasError();

      if (mediaData.media_format === 'video') {
        dom.memoryImage.classList.add('hidden');
        dom.memoryVideo.src = mediaData.media_url;
        dom.memoryVideo.classList.remove('hidden');
        dom.memoryVideo.play();
        showCanvasUpdateToast(title);
      } else {
        dom.memoryVideo.classList.add('hidden');
        
        // 画像クロスフェード：新しい画像をプリロードしてからスムーズに更新
        const newImg = new Image();
        newImg.onload = () => {
          dom.memoryImage.classList.remove('refreshing');
          dom.memoryImage.src = mediaData.media_url;
          dom.memoryImage.classList.remove('hidden');
          showCanvasUpdateToast(title);
        };
        newImg.onerror = () => {
          dom.memoryImage.classList.remove('refreshing');
          dom.memoryImage.src = mediaData.media_url;
          dom.memoryImage.classList.remove('hidden');
          showCanvasUpdateToast(title);
        };

        // 既存の絵が表示されていたらリフレッシュ演出（フェードアウト）
        if (!dom.memoryImage.classList.contains('hidden') && dom.memoryImage.src) {
          dom.memoryImage.classList.add('refreshing');
        }
        newImg.src = mediaData.media_url;
      }
    }

    // 環境音の再生
    if (mediaData.ambient_sound && mediaData.ambient_sound !== 'none' && !isBlank) {
      dom.soundIndicator.classList.remove('hidden');
      dom.soundName.textContent = getSoundLabel(mediaData.ambient_sound);
      playSyntheticAmbientSound(mediaData.ambient_sound);
    } else {
      dom.soundIndicator.classList.add('hidden');
      stopSyntheticAmbientSound();
    }

    renderSceneCollectorUI();
    logDiag(`情景処理完了: ${title} (白紙=${isBlank})`);

    // 描画完了時刻を記録し、最小描画間隔（2分 = 120秒）のクールダウンタイマーを開始
    state.lastDrawTime = Date.now();
    startDrawCooldownTimer();
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
      setNoiseGateMode('normal');
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
    if (noiseSelect) noiseSelect.value = p.noise_gate_mode || state.noiseGateMode || 'normal';

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

  // ============================================================================
  // ユーザーの絵の修正・変更指示（「夕焼けにして」「花を置いて」等）の検知
  // ※勝手な自動描画は行わず、ユーザーが「この指示で描き直す」を押した時のみ実行する
  // ============================================================================
  function detectModificationIntent(rawText) {
    // キャンバスに絵が完成していない状態では、修正指示は判定しない
    if (!state.hasDrawnImage) return null;
    if (!rawText || typeof rawText !== 'string') return null;
    const clean = rawText.replace(/[「」『』]/g, '').trim();
    if (clean.length < 2) return null;

    // 「〜にします」「〜にしよう」などの日常の意思表明（料理等）は除外
    if (/(にします|にしよう|にするよ|にするね)/.test(clean)) return null;

    // 1. 明示的な絵の修正・変更リクエスト構文（文末一致で厳格に判定）
    const modPatterns = [
      /(.+?)(?:にしてほしい|にしてくれ|にしてください|に変えてほしい|に変えてくれ|に変えてください|に描き直して|に描きかえて)$/,
      /(.+?)(?:を追加して|を足して|を置いて|を入れて|を描き足して|を描いてみて)$/,
      /(?:もっと|もうちょっと)(.+?)(?:にして|に変えて)$/,
      /(?:もう一度|もう一回|新しく)(.+?)(?:描いて|描き直して)$/
    ];

    for (const pat of modPatterns) {
      const match = clean.match(pat);
      if (match) {
        return clean;
      }
    }

    // 単独の修正キーワード
    if (/^(描き直して|描きかえて|書き直して|修正して|直してほしい|変えてみて)$/.test(clean)) {
      return clean;
    }

    return null;
  }

  function handleUserModificationDetected(feedback) {
    if (!feedback) return;
    logDiag(`ユーザーの絵の修正指示を検知: 「${feedback}」（描き直しボタンで実行可能）`);
    state.lastUserModification = feedback;
    state.sceneCollector.details.add(`【修正指示】${feedback}`);

    if (dom.refineHintText) {
      dom.refineHintText.textContent = `💡 修正指示: 「${feedback}」ボタンを押すと描き直せます`;
    }
    renderSceneCollectorUI();

    // ※会話の途中で勝手に自動描画が始まってしまう事故を防ぐため、自動タイマーは完全廃止！
    // ユーザーが「この指示で描き直す」を押した時、または明示的に指示した時のみ安全に描き直します。
    if (state.pendingRefineTimer) {
      clearTimeout(state.pendingRefineTimer);
      state.pendingRefineTimer = null;
    }
  }

  async function executeRefineDrawing(feedbackText = '') {
    const waitSec = getRemainingDrawCooldownSec();
    if (waitSec > 0) {
      const rInfo = getPacificResetTimeInfo();
      logDiag(`連続描画防止: 前回の描画から2分間（120秒）経過していないため待機します（残り${waitSec}秒 / 本日${rInfo.timeStr}リセット）`);
      showCanvasError(
        '描画待機中（クォータ保護）',
        `連続描画を防ぐため、前回の描画から2分間お待ちいただいています（残り約 ${waitSec} 秒）。本日${rInfo.timeStr}にクォータが全量リセットされます。`,
        true
      );
      return;
    }

    if (state.pendingRefineTimer) {
      clearTimeout(state.pendingRefineTimer);
      state.pendingRefineTimer = null;
    }

    const feedback = feedbackText || state.lastUserModification || '修正・描き直し';
    state.lastUserModification = feedback;
    state.isDrawingMedia = false;
    dismissCanvasError();

    const sc = state.sceneCollector;
    const baseTopic = sc.topic || sc.place || (state.sessionTopics.length > 0 ? state.sessionTopics[state.sessionTopics.length - 1] : '思い出の風景');
    const title = `${feedback.slice(0, 12)}に修正`;

    // 収集されたディテールに修正指示を最優先で組み込む
    const detailsArray = Array.from(sc.details);
    const elementsParts = [
      `【最優先の修正指示（直前の絵をこの通りに変更・描き直し）】: ${feedback}`,
      `【元の情景話題】: ${baseTopic}`
    ];
    if (sc.place) elementsParts.push(`【場所・舞台】: ${sc.place}`);
    if (sc.seasonWeather) elementsParts.push(`【季節・天候・時間】: ${sc.seasonWeather}`);
    if (detailsArray.length > 0) elementsParts.push(`【情景ディテール】: ${detailsArray.join('、')}`);
    const curStyle = ART_STYLES[state.currentArtStyle] || ART_STYLES.watercolor;
    elementsParts.push(`【画風スタイル（最重要）】: ${curStyle.name}（${curStyle.promptModifier}）`);

    const combinedElements = elementsParts.join(' / ');

    sc.status = 'drawing';
    renderSceneCollectorUI();
    setAvatarState('drawing');

    logDiag(`修正指示を反映して再描画を開始: 「${title}」`);
    await triggerSceneDrawingForTopic(title, combinedElements, {
      is_refinement: true,
      user_feedback: feedback
    });

    sc.status = 'drawn';
    renderSceneCollectorUI();
  }

  /**
   * 会話テキスト（ユーザー発話またはさくらさんの返答）から、
   * 固定辞書に頼らず、会話内容そのものから短文や単語（情景ディテール）を動的抽出する
   */
  function extractDynamicDetailsFromSpeech(text) {
    if (!text || typeof text !== 'string') return [];
    const clean = text.replace(/[「」『』"']/g, '').trim();
    if (clean.length < 2) return [];

    const results = new Set();
    const ignorePhrases = [
      'はい', 'いいえ', 'うん', 'ええ', 'そうですね', 'そうです', 'そうでした', 'なるほど',
      'あー', 'えーと', 'あのね', 'あの', 'その', 'まあ', 'ちょっと', 'どうも', 'ありがとう',
      'こんにちは', 'こんばんは', 'おはよう', '元気でしたよ', '元気です', 'もしもし', '聞こえますか',
      'テスト', '楽しいところ', '普通', 'そう', 'ところ', 'もの', 'こと', '何か', '何', 'どれ', 'これ', 'あれ', 'それ',
      '少々お待ちください', '少しお待ちください', 'お待ちください', 'お待ち', 'お話し', 'お話'
    ];

    if (ignorePhrases.includes(clean)) return [];

    // 1. 句読点、並立助詞（と・や・とか・など・および）でセグメント分割
    const rawSegments = clean.split(/[、,。!\?\n\r\t]|\s+|(?<=[^\s])(?:と|や|とか|および|なら|ならびに|など)(?=[^\s])/);

    for (let seg of rawSegments) {
      if (!seg) continue;
      let s = seg.trim();

      // 文頭のフィラー・指示語・美化語除去
      s = s.replace(/^(あの|その|ええと|えーと|じゃあ|それでは|次は|今度は|絵を|絵に|お|ご)\s*/, '');

      // 文末の動詞・述語・過去形・感想・助動詞の包括的トリミング
      s = s.replace(/(?:に通っていた頃の絵です|に通っていた頃|に通っていました|に通っていた|に通った)$/, '');
      s = s.replace(/(?:があったように思います|がありました|があった|がある|があります)$/, '');
      s = s.replace(/(?:が咲いてました|が咲いていました|が咲いていた|が咲いている)$/, '');
      s = s.replace(/(?:が来ていたんですよ|が来ていました|が来ていた|が来て|に来ていた|に来て)$/, '');
      s = s.replace(/(?:で音が鳴っていました|が鳴っていました|で鳴っていた|が鳴っていた)$/, '');
      s = s.replace(/(?:になってました|になっていました|になっていた|になった|になって)$/, '');
      s = s.replace(/(?:を描いてみましょうか|を描きますね|を描いてみますね|を描きたいです|を描きたい|を描こう)$/, '');
      s = s.replace(/(?:に描いてみましょうか|に描きますね|に描いてみますね)$/, '');
      s = s.replace(/(?:少々お待ちください|少しお待ちください|お待ちください|お待ち)$/, '');
      s = s.replace(/(?:でしたね|でしたよ|でした|ですね|ですよ|です|ますね|ましたね|ました|ね|よ|よね)$/, '');
      s = s.replace(/(?:とか|などを|など|という|といった|のある|の風景|の景色|の絵|について)$/, '');
      s = s.replace(/(?:と思う|と思います|と感じる|と感じます)$/, '');

      // 端部の助詞・不要記号の除去
      s = s.replace(/^[をにがはでもへからとやで]/, '').replace(/[をにがはでもへからとやで]$/, '');
      s = s.trim();

      if (s.length >= 1 && s.length <= 16) {
        if (!ignorePhrases.includes(s) && !/^[\d\s\-_.,]+$/.test(s) && !/(?:描いて|書いて|キャンバス|お話し|お話|いかが|どう|の絵)/.test(s)) {
          results.add(s);
        }
      }

      // セグメント内の名詞複合句（「〇〇の〇〇」「〇〇状の〇〇」）
      const phraseMatches = s.match(/(?:[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FA]{2,6}(?:状の|のような|の|風の|色の)[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FA]{2,6})/g);
      if (phraseMatches) {
        phraseMatches.forEach(p => {
          let item = p.replace(/^[をにがはでもへからとやで]/, '').replace(/[をにがはでもへからとやで]$/, '').trim();
          if (item.length >= 3 && item.length <= 15 && !ignorePhrases.includes(item)) {
            results.add(item);
          }
        });
      }
    }

    // 2. 主語抽出（漢字1文字または2〜10文字の名詞句：「〇〇がある」「〇〇が咲いている」等）
    const subjectMatches = clean.match(/(?:[\u4E00-\u9FFF]|[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FA]{2,10})が(?:ある|あった|咲い|見え|実っ|通っ|遊んで|泳いで|鳴っ|来て|建っ)/g);
    if (subjectMatches) {
      subjectMatches.forEach(sm => {
        const subj = sm.replace(/が(?:ある|あった|咲い|見え|実っ|通っ|遊んで|泳いで|鳴っ|来て|建っ)$/, '').trim();
        if (subj.length >= 1 && subj.length <= 12 && !ignorePhrases.includes(subj)) {
          results.add(subj);
        }
      });
    }

    // 3. 包含関係の整理（長いフレーズに含まれる重複単語や不要句を除去）
    const arr = Array.from(results);
    const filtered = arr.filter(item => {
      const hasLonger = arr.some(other => other !== item && other.includes(item) && other.length <= 14);
      if (hasLonger && item.length <= 2) return false;
      return true;
    });

    return filtered;
  }

  function updateSceneCollectorFromText(text, speaker = 'user') {
    if (!text || typeof text !== 'string') return;
    const clean = text.replace(/[「」『』]/g, '').trim();
    if (clean.length < 2) return;

    const sc = state.sceneCollector;
    let changed = false;

    // 1. AIが描画確認の呼びかけ、または描画意図を述べたか検知（勝手な自動描画はせず、確認待ちにする）
    if (speaker === 'ai') {
      const isConfirming = /(キャンバスに描いてみましょうか|描いてみましょうか|絵にしてみましょうか|描きましょうか|絵を描いてみましょうか|キャンバスに映してみましょうか|キャンバスに描いてみますか|描いてみますね|描きますね|絵にしてみますね)/.test(clean);

      if (isConfirming) {
        sc.isAwaitingConfirmation = true;
        sc.status = 'confirming';
        renderSceneCollectorUI();
      }
    }

    // 2. ユーザーの絵の修正・描き直し指示を最優先で検知
    if (speaker === 'user') {
      // 画風スタイルの切り替え指示を音声から自動検知
      if (/(リアル|写実|写真みたい|写真風|本物みたい)/.test(clean)) {
        setArtStyle('realistic');
        showCanvasUpdateToast('画風を「📷 リアルな情景（写実）」に変更しました');
      } else if (/(油絵|油彩|油絵風)/.test(clean)) {
        setArtStyle('oil_painting');
        showCanvasUpdateToast('画風を「🖌️ 重厚な油絵」に変更しました');
      } else if (/(水彩|水彩画|水彩風)/.test(clean)) {
        setArtStyle('watercolor');
        showCanvasUpdateToast('画風を「🎨 優しい水彩画」に変更しました');
      } else if (/(色鉛筆|鉛筆画|スケッチ|手描き風)/.test(clean)) {
        setArtStyle('colored_pencil');
        showCanvasUpdateToast('画風を「✏️ 色鉛筆スケッチ」に変更しました');
      }

      const modIntent = detectModificationIntent(clean);
      if (modIntent) {
        handleUserModificationDetected(modIntent);
        return;
      }
    }

    // =========================================================================
    // 【最重要】辞書に頼らず、会話内容そのものから短文や単語を動的抽出する！
    // =========================================================================
    const dynamicDetails = extractDynamicDetailsFromSpeech(clean);

    if (dynamicDetails.length > 0) {
      dynamicDetails.forEach(item => {
        // 短い単語がすでに長いフレーズに包含されていなければ追加
        if (!sc.details.has(item)) {
          sc.details.add(item);
          changed = true;
          logDiag(`情景ディテールを動的抽出: 「${item}」`);
        }
      });
    }

    // A. 話題（トピック）の動的決定
    // 「〜の絵」「〜について」「〜を描きたい」などの明示的トピックフレーズの優先抽出
    let detectedNewTopic = '';
    const topicPhraseMatch = clean.match(/(?:(.+?)(?:の絵|について|のお話|の情景|を描きたい|を書きたい|を描こう|を書こう))/);
    if (topicPhraseMatch && topicPhraseMatch[1]) {
      const cand = topicPhraseMatch[1].replace(/^(あの|その|ええと|えーと|じゃあ|それでは|次は|今度は|絵を)\s*/, '').trim();
      if (cand.length >= 2 && cand.length <= 15) {
        detectedNewTopic = cand;
      }
    }

    // 明示的トピックがなければ、動的抽出された主要な短文・単語からトピックを推定
    if (!detectedNewTopic && !sc.topic && dynamicDetails.length > 0) {
      detectedNewTopic = dynamicDetails[0];
    }

    // 新しい話題の反映 ＆ まったく新しい話題への転換時のリフレッシュ
    if (detectedNewTopic) {
      if (!sc.topic || (!sc.topic.includes(detectedNewTopic) && !detectedNewTopic.includes(sc.topic))) {
        logDiag(`新しい話題を検知: 「${detectedNewTopic}」（前回の話題: ${sc.topic || 'なし'}）`);
        sc.topic = detectedNewTopic;
        changed = true;
      }
    }

    // B. 場所・舞台の動的抽出
    // 「〜の園庭」「〜の門」「〜の前」「〜の中」「〜の庭」「〜先」「〜園」「〜館」「〜室」「〜場」などの地名・場所語尾を検出
    const placeMatch = clean.match(/(?:[^\s、。!\?]{2,10}(?:園庭|校庭|校門|正門|の門|花壇|庭園|中庭|庭先|縁側|軒先|座敷|和室|お部屋|リビング|カフェ|喫茶店|教室|校舎|学校|体育館|海岸|砂浜|公園|商店街|田んぼ|畑|果樹園|駅|ホーム|港|神社|お寺|故郷|実家|アルプス|山|川|海))/);
    if (placeMatch) {
      sc.place = placeMatch[0];
      if (!sc.topic) {
        sc.topic = `${placeMatch[0]}の風景`;
      }
      changed = true;
    }

    // C. 季節・天候・時間帯の動的抽出
    const seasonMatch = clean.match(/(?:春の温かい日差し|春の光|秋晴れの澄んだ青空|澄み切った秋の空|秋の空|秋晴れ|晴れ渡った青空|青空|快晴|秋晴れ|夕暮れ|夕焼け|夕日|星空|雲海|雪景色|雪渓|残雪|新緑|紅葉|春|夏|秋|冬|朝|昼|夕方|夜)/);
    if (seasonMatch) {
      sc.seasonWeather = seasonMatch[0];
      changed = true;
    }

    // =========================================================================
    // 3. ユーザーからの明示的描画リクエスト・または合意返答の検知
    // ※「〜を描きたい」「〜を書きたい」は話題提示なので即時描画トリガーには含めない
    // ※会話中の単なる相槌（「はい」「うん」「そうですね」）での勝手な誤描画を完全防止
    // =========================================================================
    if (speaker === 'user') {
      const isExplicitDrawCommand = /(絵を描いてください|絵を書いてください|絵に描いてください|絵に書いてください|今の話題を絵にして|キャンバスに描いて|キャンバスに出して|この絵を描いて)/.test(clean);
      const isApprovalForPrompt = sc.isAwaitingConfirmation && /^(はい、?(絵を|絵に)?(描い|書い)てください|(描い|書い)てください|お願いします|お願い|描いて|書いて|そうして)$/.test(clean.trim());

      if (isExplicitDrawCommand || isApprovalForPrompt) {
        const now = Date.now();
        if (state.isDrawingMedia || (now - state.lastDrawTriggerTime < 5000)) {
          logDiag(`描画中またはクールダウン中のため、重複トリガーをスキップ: 「${clean}」`);
          return;
        }
        logDiag(`ユーザーの描画合意・指示を検知: 「${clean}」`);
        sc.isAwaitingConfirmation = false;
        executeConfirmedDrawing();
        return;
      }
    }

      if (isExplicitDrawCommand || isApprovalForPrompt) {
        const now = Date.now();
        if (state.isDrawingMedia || (now - state.lastDrawTriggerTime < 5000)) {
          logDiag(`描画中またはクールダウン中のため、重複トリガーをスキップ: 「${clean}」`);
          return;
        }
        logDiag(`ユーザーの描画合意・指示を検知: 「${clean}」`);
        sc.isAwaitingConfirmation = false;
        executeConfirmedDrawing();
        return;
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

    // 描き直し・修正アクションバー（絵が描かれた後に常設表示）
    if (dom.collectorRefineBar) {
      if (state.hasDrawnImage && sc.status !== 'drawing') {
        dom.collectorRefineBar.classList.remove('hidden');
        if (dom.refineHintText) {
          if (state.lastUserModification) {
            dom.refineHintText.textContent = `💡 修正指示: 「${state.lastUserModification}」を反映して描き直せます`;
          } else {
            dom.refineHintText.textContent = '💡 「夕焼けにして」「お花を置いて」と声で修正するか、ボタンを押して描き直せます';
          }
        }
        if (dom.btnRefineNow) {
          dom.btnRefineNow.disabled = false;
        }
      } else if (sc.status === 'drawing') {
        if (dom.btnRefineNow) dom.btnRefineNow.disabled = true;
      } else {
        dom.collectorRefineBar.classList.add('hidden');
      }
    }

    // ワンタップ描画ボタンのラベル・スタイル更新（常に「今の話題を絵にする」でゼロから描画可能）
    if (dom.btnDrawCurrentTopic) {
      const waitSec = getRemainingDrawCooldownSec();
      if (sc.status === 'drawing' || state.isDrawingMedia) {
        dom.btnDrawCurrentTopic.textContent = '🎨 描画中...';
        dom.btnDrawCurrentTopic.style.background = '';
        dom.btnDrawCurrentTopic.disabled = true;
      } else if (waitSec > 0) {
        dom.btnDrawCurrentTopic.textContent = `⏳ 次の描画まで (${waitSec}秒)`;
        dom.btnDrawCurrentTopic.style.background = '';
        dom.btnDrawCurrentTopic.disabled = true;
      } else if (sc.status === 'ready' || sc.status === 'confirming') {
        dom.btnDrawCurrentTopic.textContent = '✨ 準備OK！この情景を描く';
        dom.btnDrawCurrentTopic.style.background = 'linear-gradient(135deg, #d97706 0%, #b45309 100%)';
        dom.btnDrawCurrentTopic.disabled = false;
      } else {
        dom.btnDrawCurrentTopic.textContent = '🎨 今の話題を絵にする';
        dom.btnDrawCurrentTopic.style.background = '';
        dom.btnDrawCurrentTopic.disabled = false;
      }
    }
  }

  async function executeConfirmedDrawing(manualTopic = '') {
    const waitSec = getRemainingDrawCooldownSec();
    if (waitSec > 0) {
      const rInfo = getPacificResetTimeInfo();
      logDiag(`連続描画防止: 前回の描画から2分間（120秒）経過していないため待機します（残り${waitSec}秒 / 本日${rInfo.timeStr}リセット）`);
      showCanvasError(
        '描画待機中（クォータ保護）',
        `連続描画を防ぐため、前回の描画から2分間お待ちいただいています（残り約 ${waitSec} 秒）。本日${rInfo.timeStr}にクォータが全量リセットされます。`,
        true
      );
      return;
    }
    const now = Date.now();
    if (state.isDrawingMedia || (now - state.lastDrawTriggerTime < 5000)) {
      logDiag('描画中または直前に描画開始されたため、二重実行・クォータ枯渇を防止しました。');
      return;
    }
    state.lastDrawTriggerTime = now;
    state.isDrawingMedia = true;
    dismissCanvasError();

    const sc = state.sceneCollector;
    const pArgs = sc.pendingArgs?.args;
    const topic = manualTopic || sc.topic || pArgs?.japanese_title || sc.place || (state.sessionTopics.length > 0 ? state.sessionTopics[state.sessionTopics.length - 1] : '思い出の風景');

    // 収集された情景情報を総合して高精細プロンプトを作成
    const detailsArray = Array.from(sc.details);
    const elementsParts = [];
    elementsParts.push(`【描く情景の主題・モチーフ（最優先）】: ${topic}`);
    if (pArgs?.visual_elements) elementsParts.push(`【AI情景描写】: ${pArgs.visual_elements}`);
    if (sc.place) elementsParts.push(`【場所・舞台】: ${sc.place}`);
    if (sc.seasonWeather) elementsParts.push(`【季節・天候・時間】: ${sc.seasonWeather}`);
    if (detailsArray.length > 0) elementsParts.push(`【情景ディテール】: ${detailsArray.join('、')}`);
    const curStyle = ART_STYLES[state.currentArtStyle] || ART_STYLES.watercolor;
    elementsParts.push(`【画風スタイル（最重要）】: ${curStyle.name}（${curStyle.promptModifier}）`);

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
  // 動作診断・テストツール ＆ ワンタップ「今の話題を絵にする・描き直す」
  // ============================================================================
  async function triggerSceneDrawingForTopic(rawTopic, customElements = '', extraOptions = {}) {
    const waitSec = getRemainingDrawCooldownSec();
    if (waitSec > 0) {
      const rInfo = getPacificResetTimeInfo();
      logDiag(`連続描画防止: 前回の描画から2分間（120秒）経過していないため待機します（残り${waitSec}秒 / 本日${rInfo.timeStr}リセット）`);
      showCanvasError(
        '描画待機中（クォータ保護）',
        `連続描画を防ぐため、前回の描画から2分間お待ちいただいています（残り約 ${waitSec} 秒）。本日${rInfo.timeStr}にクォータが全量リセットされます。`,
        true
      );
      return;
    }

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
    if (dom.btnRefineNow) {
      dom.btnRefineNow.disabled = true;
      dom.btnRefineNow.textContent = '🎨 描画中...';
    }
    try {
      const isRefinement = !!extraOptions.is_refinement || !!extraOptions.user_feedback || !!state.lastUserModification;
      const feedback = (extraOptions.user_feedback || state.lastUserModification || '').trim();

      const art = await generateStandaloneMemoryArtifact({
        scene_type: 'past_memory',
        japanese_title: shortTitle,
        visual_elements: combinedElements,
        ambient_sound: 'autumn_insects',
        is_refinement: isRefinement,
        user_feedback: feedback
      });
      // より新しい発話の描画が走っていなければキャンバスに反映
      if (mySeqId === state.drawSequenceId) {
        displayGeneratedMedia(art);
      }
    } catch (e) {
      console.error('triggerSceneDrawingForTopic error:', e);
      // ユーザー指示: AIモデルで描けない時はダミー画像や過去の絵を出さず、白紙として報告する
      displayGeneratedMedia({
        title: shortTitle,
        media_format: 'image',
        media_url: '',
        is_fallback: true,
        is_blank: true,
        visual_elements: combinedElements,
        ambient_sound: 'none'
      });
    } finally {
      state.isDrawingMedia = false;
      dom.drawingOverlay?.classList.add('hidden');
      if (mySeqId === state.drawSequenceId) {
        updateDrawButtonsCooldownUI();
        renderSceneCollectorUI();
        setAvatarState('force_reset');
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
      const m = aiTxt.match(/(柿|かき|カキ|槍ヶ岳|北アルプス|山登り|山頂|喫茶店|カフェ|クリームソーダ|ホットケーキ|教室|校舎|文化祭|模擬店|海|桜|バラ|夕焼け|雪景色|公園|電車|リンゴ)/);
      if (m && m[0]) {
        candidate = `${m[0]}の情景`;
      }
    }

    const finalTopic = candidate || '思い出の風景';

    // 「今の話題を絵にする」は、常に現在の会話内容から新しい情景をゼロから描画（新規作成）！
    // 直前の絵の要素に引きずられず、今話している話題そのものを忠実に絵にします。
    logDiag(`「今の話題を絵にする」が押されました: 「${finalTopic}」の新規描画を開始します。`);
    state.lastUserModification = ''; // 新規描画なので直前の修正指示はクリア
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
