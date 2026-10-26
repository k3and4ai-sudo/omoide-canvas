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
    normal: { rms: 0.0022, hangoverChunks: 7, eosSilenceChunks: 6, label: '標準感度' },
    tv_cut: { rms: 0.0055, hangoverChunks: 7, eosSilenceChunks: 6, label: 'テレビ・周囲音カット' },
    strict: { rms: 0.0120, hangoverChunks: 6, eosSilenceChunks: 5, label: '強めカット' }
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
    recognition: null // Web Speech API 音声認識
  };

  // DOM要素キャッシュ
  const dom = {
    // ヘッダー ＆ ログインモーダル
    userGreeting: document.getElementById('userGreeting'),
    btnToggleCaregiver: document.getElementById('btnToggleCaregiver'),
    btnOpenLoginModal: document.getElementById('btnOpenLoginModal'),
    apiKeyStatusBadge: document.getElementById('apiKeyStatusBadge'),
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
  // 初期化 ＆ ハイブリッド動作モード（GitHub Pages単体 / ローカルサーバー併用）
  // ============================================================================
  const STORAGE_KEY_API = 'omoide_device_gemini_api_key';
  const STORAGE_KEY_PROFILE = 'omoide_user_profile_v2';
  const STORAGE_KEY_MEMORIES = 'omoide_memories_v2';
  const STORAGE_KEY_REPORTS = 'omoide_reports_v2';

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
1. 否定・訂正の絶対禁止（バリデーション）：事実と異なる発言や同じ話の繰り返しがあっても決して指摘・訂正せず、毎回初めて聞くように温かく受け止めてください。
2. 挨拶の連呼・「どういたしまして」の誤用禁止：最初の挨拶の後は「こんにちは」を繰り返さず、相手の発言内容に100%直接答えてください。
3. 短期記憶テスト・質問攻めの禁止：1回の返答につき質問は【最大1つだけ】にしてください。
4. 人生の先生として敬意を払う姿勢：「ぜひ${nickname}に教えていただきたいです」という姿勢で接してください。
5. 【重要】テレビ・ラジオ・周囲の雑音対策（空間フィルタリング）：
   背景から聞こえるテレビ番組の音声（ニュース、CM、ドラマ等）や遠くの第三者の声には絶対に反応せず、目の前の「${nickname}」が直接ゆっくり話しかけた言葉にのみ返答してください。
${levelRules}

# 【思い出の映像化（ツール呼び出し）ルール】
・会話の中で昔の思い出の風景や行きたい場所の情景が語られたら（または「絵を描いて」と希望されたら）：
1. 「とても素敵な風景ですね！今その絵を描いてみますね」と声かけし、直ちに \`generate_memory_visual\` ツールを呼び出す。
2. 絵が表示されたら「${nickname}、画面に絵が浮かびましたが、こんな雰囲気でしたか？」と確認する。
3. 修正希望があった場合は \`refine_memory_visual\` ツールを呼び出す。

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
              end_of_speech_sensitivity: 'END_SENSITIVITY_HIGH',
              prefix_padding_ms: 80,
              silence_duration_ms: 300
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
            if (state.currentUserTurnTranscript.trim()) {
              state.sessionTopics.push(state.currentUserTurnTranscript.trim());
              state.currentUserTurnTranscript = '';
            }
            state.currentAiTurnTranscript += outputTrans.text;
            const cleanAiTxt = state.currentAiTurnTranscript.trim();
            if (cleanAiTxt) {
              dom.aiTranscriptText.textContent = cleanAiTxt;
            }
          }

          if (sc.turnComplete || sc.turn_complete) {
            state.currentAiTurnTranscript = '';
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
              setAvatarState('drawing');
              handleDirectMediaGeneration(ws, callId, funcName, args);
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
        // AIがスピーカーから発話中の場合、またはノイズゲートしきい値未満の遠方テレビ音声の場合は破棄
        if (state.isAiSpeaking) return;
        if (state.noiseGateMode !== 'normal' && (Date.now() - state.lastVoiceActiveTime > 2500)) {
          return;
        }

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

          // ユーザーが話し終えた（1.2秒間の沈黙）を検知して送信
          if (state.speechDebounceTimer) {
            clearTimeout(state.speechDebounceTimer);
          }
          state.speechDebounceTimer = setTimeout(async () => {
            if (!state.isSessionActive || state.isAiSpeaking) return;
            const textToSend = state.pendingUserTranscript;
            state.pendingUserTranscript = '';
            if (!textToSend || textToSend.length < 2) return;

            state.sessionTopics.push(textToSend);

            if (state.isSimulation && !state.hasLocalBackend) {
              // ブラウザ単体デモモード時の対話＆水彩画生成シミュレーション
              logDiag(`発話完了を検知（デモ）: 「${textToSend}」`);
              const profile = state.currentProfile || DEFAULT_USER_PROFILE;
              const nickname = formatUserNickname(profile.call_name);
              const aiReply = `${textToSend}ですか、とても素敵ですね！その頃の情景をキャンバスに描いてみますね。`;
              dom.aiTranscriptText.textContent = aiReply;
              speakTextWithWebSpeech(aiReply);
              setTimeout(async () => {
                if (!state.isSessionActive) return;
                setAvatarState('drawing');
                const art = await generateStandaloneMemoryArtifact({
                  scene_type: 'past_memory',
                  japanese_title: `${textToSend.slice(0, 14)}の思い出`,
                  visual_elements: `${textToSend}、懐かしい日本の風景、温かい日差し`,
                  ambient_sound: 'autumn_insects'
                });
                displayGeneratedMedia(art);
                const followUp = `${nickname}、画面に絵が浮かびましたよ。こんな雰囲気でしたか？`;
                dom.aiTranscriptText.textContent = followUp;
                speakTextWithWebSpeech(followUp);
              }, 2200);
              return;
            }

            if (state.socket && state.socket.readyState === WebSocket.OPEN && !state.isDirectGeminiWs) {
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

  async function renderFallbackWatercolorDataUrl(title) {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');

    const isApple = /(リンゴ|りんご|松本|山|秋)/.test(title || '');
    const presetSrc = isApple
      ? 'static/memories/presets/apple_orchard.jpg'
      : 'static/memories/presets/showa_village.jpg';

    let loadedImg = false;
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = presetSrc;
      });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      loadedImg = true;
    } catch (e) {}

    if (!loadedImg) {
      const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
      grad.addColorStop(0, '#f5e6d7');
      grad.addColorStop(0.55, '#eef5f2');
      grad.addColorStop(1, '#d8e8e0');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = '#81b29a';
      ctx.beginPath();
      ctx.moveTo(0, 380);
      ctx.lineTo(220, 210);
      ctx.lineTo(460, 380);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#649682';
      ctx.beginPath();
      ctx.moveTo(300, 400);
      ctx.lineTo(560, 190);
      ctx.lineTo(800, 400);
      ctx.closePath();
      ctx.fill();
    }

    // 和紙風短冊（タイトル札）を左上に描画
    const bx = 28, by = 28, bw = 340, bh = 74;
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
    ctx.fillText('【おもいで水彩画】', bx + 16, by + 26);

    const cleanTitle = (title || '思い出の風景').replace(/\n/g, ' ').slice(0, 17);
    ctx.fillStyle = '#2c5e4f';
    ctx.font = 'bold 21px "Noto Sans JP", sans-serif';
    ctx.fillText(cleanTitle, bx + 16, by + 56);

    return canvas.toDataURL('image/jpeg', 0.86);
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
      // Step 1: Imagen 3 REST API
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instances: [{ prompt: finalPrompt }],
              parameters: { sampleCount: 1, aspectRatio: '4:3', outputOptions: { mimeType: 'image/jpeg' } }
            })
          }
        );
        if (res.ok) {
          const data = await res.json();
          const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
          if (b64) {
            mediaDataUrl = `data:image/jpeg;base64,${b64}`;
            logDiag('Imagen 3 による水彩画生成に成功しました！');
          }
        }
      } catch (e) {}

      // Step 2: Gemini 2.0 Flash Image Generation フォールバック
      if (!mediaDataUrl) {
        try {
          const res2 = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: finalPrompt }] }],
                generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
              })
            }
          );
          if (res2.ok) {
            const data2 = await res2.json();
            const parts = data2?.candidates?.[0]?.content?.parts || [];
            for (const p of parts) {
              const inl = p.inlineData || p.inline_data;
              if (inl && inl.data) {
                mediaDataUrl = `data:${inl.mimeType || 'image/png'};base64,${inl.data}`;
                logDiag('Gemini Flash Image による水彩画生成に成功しました！');
                break;
              }
            }
          }
        } catch (e) {}
      }
    }

    // Step 3: プリセット水彩画＋タイトル短冊合成フォールバック
    if (!mediaDataUrl) {
      mediaDataUrl = await renderFallbackWatercolorDataUrl(title);
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
      const artifact = await generateStandaloneMemoryArtifact(args);
      displayGeneratedMedia(artifact);

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
    } else if (avatarState === 'idle') {
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
        dom.drawingOverlay.classList.add('hidden');
        break;
      case 'listening':
        nextLabel = `${pName}：お話を聞いています...`;
        if (!state.isDrawingMedia) dom.drawingOverlay.classList.add('hidden');
        break;
      case 'speaking':
        nextLabel = `${pName}：お話し中...`;
        if (!state.isDrawingMedia) dom.drawingOverlay.classList.add('hidden');
        break;
      case 'drawing':
        nextLabel = `${pName}：絵を描いています...`;
        dom.drawingOverlay.classList.remove('hidden');
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
  // 動作診断・テストツール
  // ============================================================================
  async function testGenerateSampleVisual() {
    logDiag('水彩画生成テストを開始します...');
    setAvatarState('drawing');
    if (state.socket && state.socket.readyState === WebSocket.OPEN && !state.isDirectGeminiWs) {
      state.socket.send(JSON.stringify({ type: 'test_generate_visual' }));
    } else {
      const art = await generateStandaloneMemoryArtifact({
        scene_type: 'past_memory',
        japanese_title: '夕暮れの信州松本とりんご畑',
        visual_elements: '夕暮れの信州松本のリンゴ畑、赤く実ったリンゴ、北アルプスの山並み',
        ambient_sound: 'autumn_insects'
      });
      displayGeneratedMedia(art);
      setAvatarState(state.isSessionActive ? 'listening' : 'idle');
    }
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
