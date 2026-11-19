/**
 * ServeCoach - Treinador de Saque de Tênis PWA
 * MediaPipe BlazePose + State Machine + Audio/Visual Cues
 * Roda 100% no navegador do iPhone (Safari/PWA)
 */

// ============ CONFIG & CONSTANTS ============
const CONFIG = {
  // Pose model
  modelComplexity: 0, // 0=lightning (FAST), 1=thunder, 2=full - DEFAULT TO FASTEST
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,

  // Smoothing
  smoothingFrames: 3,

  // Phase detection thresholds (degrees/ms) - adjustable via settings
  thresholds: {
    elbowMinTrophy: 85,      // min elbow angle at trophy
    pronateMinDrop: 30,      // min pronation angle at drop->accelerate
    trophyMinTime: 500,      // min time at trophy (ms)
    jerkRatioMax: 3.0,       // max jerk peak/mean ratio
    tremorRMSMax: 0.15,      // max tremor RMS (g)
  },

  // Audio cues
  audioEnabled: true,
  visualEnabled: true,
  hapticEnabled: true,

  // Camera
  facingMode: 'environment', // 'user' = front, 'environment' = back
  mirrorVideo: true,

  // Wake lock
  wakeLockEnabled: true,

  // Loading
  loadTimeoutMs: 60000,      // timeout for model loading
};

// ============ STATE ============
let poseDetector = null;
let video = null;
let canvas = null;
let ctx = null;
let animationId = null;
let wakeLock = null;

const PHASES = [
  'STANCE',      // 0: parado, preparando
  'PREP',        // 1: raquete sobe, toss inicia
  'TROPHY',      // 2: pausa no trophy
  'DROP',        // 3: raquete cai (pronação inicia)
  'ACCELERATE',  // 4: forward swing
  'CONTACT',     // 5: impacto
  'FOLLOW'       // 6: follow-through
];

let currentPhase = 0;
let phaseStartTime = 0;
let serveStartTime = 0;
let lastPhaseChange = 0;

const phaseHistory = []; // {phase, timestamp, angles}
const cueHistory = [];   // {cue, timestamp, phase}
const serveLog = [];     // completed serves

// Smoothing buffers
const angleBuffers = {
  elbow: [],
  shoulder: [],
  hip: [],
  knee: [],
  pronation: [],
  racketHeight: [],
};

// Landmark indices (MediaPipe BlazePose 33 keypoints)
const LM = {
  NOSE: 0,
  LEFT_EYE: 1, RIGHT_EYE: 2,
  LEFT_EAR: 3, RIGHT_EAR: 4,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_PINKY: 17, RIGHT_PINKY: 18,
  LEFT_INDEX: 19, RIGHT_INDEX: 20,
  LEFT_THUMB: 21, RIGHT_THUMB: 22,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
  LEFT_HEEL: 29, RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
};

// Determine dominant side (assume right-handed, configurable later)
const DOMINANT = 'RIGHT';
const S = (name) => LM[`${DOMINANT}_${name}`];
const OPP = (name) => LM[`${DOMINANT === 'RIGHT' ? 'LEFT' : 'RIGHT'}_${name}`];

// ============ AUDIO ENGINE ============
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.masterGain = null;
  }

  async init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this.masterGain.gain.value = 0.6;
    this.enabled = true;

    // Resume on user gesture (iOS requirement)
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  playCue(type) {
    if (!this.enabled || !CONFIG.audioEnabled) return;
    if (!this.ctx) return this.init().then(() => this.playCue(type));

    const now = this.ctx.currentTime;
    const patterns = {
      relax:      [{f: 180, d: 0.3, t: 'sine'}, {f: 140, d: 0.3, t: 'sine', delay: 0.4}],
      elbow:      [{f: 600, d: 0.1, t: 'square'}, {f: 600, d: 0.1, t: 'square', delay: 0.15}],
      pronate:    [{f: 800, d: 0.06, t: 'sawtooth'}, {f: 1000, d: 0.06, t: 'sawtooth', delay: 0.09}, {f: 1200, d: 0.06, t: 'sawtooth', delay: 0.18}],
      smooth:     [{f: 400, d: 0.4, t: 'sine'}, {f: 300, d: 0.3, t: 'sine', delay: 0.4}, {f: 220, d: 0.3, t: 'sine', delay: 0.7}],
      good:       [{f: 523, d: 0.15, t: 'sine'}, {f: 659, d: 0.25, t: 'sine', delay: 0.15}],
      toss:       [{f: 350, d: 0.12, t: 'triangle'}, {f: 350, d: 0.12, t: 'triangle', delay: 0.18}, {f: 350, d: 0.12, t: 'triangle', delay: 0.36}],
    };

    const pattern = patterns[type] || patterns.good;
    pattern.forEach(note => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = note.t;
      osc.frequency.value = note.f;
      gain.gain.setValueAtTime(0, now + (note.delay || 0));
      gain.gain.linearRampToValueAtTime(0.3, now + (note.delay || 0) + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + (note.delay || 0) + note.d);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now + (note.delay || 0));
      osc.stop(now + (note.delay || 0) + note.d + 0.02);
    });
  }
}

const audioEngine = new AudioEngine();

// ============ HAPTIC FEEDBACK ============
function triggerHaptic(type) {
  if (!CONFIG.hapticEnabled || !navigator.vibrate) return;
  const patterns = {
    relax: [30],
    elbow: [20, 30, 20],
    pronate: [15, 15, 15, 15, 15],
    smooth: [100, 50, 50],
    good: [50, 50, 100],
    toss: [40, 40, 40],
  };
  navigator.vibrate(patterns[type] || patterns.good);
}

// ============ GEOMETRY UTILS ============
function angleBetween3Points(a, b, c) {
  // a, b, c are {x,y,z,visibility} - b is vertex
  const v1 = {x: a.x - b.x, y: a.y - b.y};
  const v2 = {x: c.x - b.x, y: c.y - b.y};
  const dot = v1.x * v2.x + v1.y * v2.y;
  const m1 = Math.hypot(v1.x, v1.y);
  const m2 = Math.hypot(v2.x, v2.y);
  if (m1 === 0 || m2 === 0) return null;
  const cos = Math.max(-1, Math.min(1, dot / (m1 * m2)));
  return Math.acos(cos) * 180 / Math.PI;
}

function angleBetween2Points(a, b) {
  // angle of vector a->b relative to vertical (down = 0)
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.atan2(dx, dy) * 180 / Math.PI; // 0 = vertical down
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function smoothAngle(buffer, newVal, maxSize = 5) {
  if (newVal === null) return buffer[buffer.length - 1] || null;
  buffer.push(newVal);
  if (buffer.length > maxSize) buffer.shift();
  return buffer.reduce((a, b) => a + b, 0) / buffer.length;
}

function getLandmark(landmarks, idx) {
  const lm = landmarks[idx];
  if (!lm || lm.visibility < 0.3) return null;
  return {x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility};
}

// ============ POSE ANALYSIS ============
function analyzePose(landmarks) {
  const results = {
    // Angles
    elbow: null,
    shoulder: null,
    hip: null,
    knee: null,
    pronation: null,
    racketHeight: null,
    // Positions
    wrist: null,
    elbow_pos: null,
    shoulder_pos: null,
    hip_pos: null,
    // Visibility
    visible: true,
  };

  // Key landmarks
  const shoulder = getLandmark(landmarks, S('SHOULDER'));
  const elbow = getLandmark(landmarks, S('ELBOW'));
  const wrist = getLandmark(landmarks, S('WRIST'));
  const hip = getLandmark(landmarks, S('HIP'));
  const knee = getLandmark(landmarks, S('KNEE'));
  const ankle = getLandmark(landmarks, S('ANKLE'));
  const index = getLandmark(landmarks, S('INDEX'));
  const pinky = getLandmark(landmarks, S('PINKY'));
  const oppShoulder = getLandmark(landmarks, OPP('SHOULDER'));
  const oppHip = getLandmark(landmarks, OPP('HIP'));

  // Check critical visibility
  if (!shoulder || !elbow || !wrist || !hip || !knee) {
    results.visible = false;
    return results;
  }

  // Store positions
  results.wrist = wrist;
  results.elbow_pos = elbow;
  results.shoulder_pos = shoulder;
  results.hip_pos = hip;

  // Elbow angle (shoulder-elbow-wrist)
  results.elbow = angleBetween3Points(shoulder, elbow, wrist);

  // Shoulder angle (hip-shoulder-elbow) - trunk lean
  if (hip) results.shoulder = angleBetween3Points(hip, shoulder, elbow);

  // Hip angle (shoulder-hip-knee)
  results.hip = angleBetween3Points(shoulder, hip, knee);

  // Knee angle (hip-knee-ankle)
  if (ankle) results.knee = angleBetween3Points(hip, knee, ankle);

  // Pronation estimation: angle between forearm (elbow->wrist) and hand plane (wrist->index/pinky)
  if (index && pinky) {
    const forearmAngle = Math.atan2(wrist.y - elbow.y, wrist.x - elbow.x) * 180 / Math.PI;
    const handAngle = Math.atan2(index.y - pinky.y, index.x - pinky.x) * 180 / Math.PI;
    let pronation = forearmAngle - handAngle;
    // Normalize to 0-180 range
    while (pronation < 0) pronation += 180;
    while (pronation > 180) pronation -= 180;
    results.pronation = pronation;
  }

  // Racket height proxy: wrist Y relative to shoulder (normalized)
  results.racketHeight = (shoulder.y - wrist.y) / Math.abs(shoulder.y - hip.y);

  // Smooth
  results.elbow = smoothAngle(angleBuffers.elbow, results.elbow);
  results.shoulder = smoothAngle(angleBuffers.shoulder, results.shoulder);
  results.hip = smoothAngle(angleBuffers.hip, results.hip);
  results.knee = smoothAngle(angleBuffers.knee, results.knee);
  results.pronation = smoothAngle(angleBuffers.pronation, results.pronation);
  results.racketHeight = smoothAngle(angleBuffers.racketHeight, results.racketHeight);

  return results;
}

// ============ STATE MACHINE ============
const CUES = {
  RELAX_ARM: 'relax',
  ELBOW_UP: 'elbow',
  PRONATE_NOW: 'pronate',
  SMOOTH_ACCEL: 'smooth',
  GOOD_SERVE: 'good',
  TOSS_TIMING: 'toss',
};

let cueCooldowns = {};
const CUE_COOLDOWN_MS = 2000; // same cue not repeated within 2s

function canTriggerCue(cue) {
  const now = Date.now();
  if (cueCooldowns[cue] && now - cueCooldowns[cue] < CUE_COOLDOWN_MS) return false;
  cueCooldowns[cue] = now;
  return true;
}

function triggerCue(cueType, title, desc) {
  if (!canTriggerCue(cueType)) return;

  const banner = document.getElementById('cue-banner');
  const icon = document.getElementById('cue-icon');
  const titleEl = document.getElementById('cue-title');
  const descEl = document.getElementById('cue-desc');

  // Icon mapping
  const iconMap = {
    relax: '💪',
    elbow: '📐',
    pronate: '🔄',
    smooth: '🌊',
    good: '✅',
    toss: '⏱️',
  };
  const iconClassMap = {
    relax: 'relax',
    elbow: 'elbow',
    pronate: 'pronate',
    smooth: 'smooth',
    good: 'good',
    toss: 'toss',
  };

  icon.textContent = iconMap[cueType] || '💡';
  icon.className = 'cue-icon ' + (iconClassMap[cueType] || '');
  titleEl.textContent = title;
  descEl.textContent = desc;

  banner.classList.remove('hidden');

  // Audio + Haptic
  audioEngine.playCue(cueType);
  triggerHaptic(cueType);

  // Log
  cueHistory.push({
    cue: cueType,
    timestamp: Date.now(),
    phase: currentPhase,
    phaseName: PHASES[currentPhase],
  });

  // Auto-hide after 3s
  setTimeout(() => {
    if (banner.querySelector('.cue-title').textContent === title) {
      banner.classList.add('hidden');
    }
  }, 3000);
}

function enterPhase(newPhase) {
  const now = Date.now();
  if (newPhase > 0) marcarFase(newPhase);
  currentPhase = newPhase;
  phaseStartTime = now;

  if (newPhase === 0 || (newPhase === 1 && !serveStartTime)) serveStartTime = now;

  phaseHistory.push({
    phase: newPhase,
    phaseName: PHASES[newPhase],
    timestamp: now,
    duration: newPhase > 0 ? now - lastPhaseChange : 0,
  });
  lastPhaseChange = now;

  // Update UI
  updatePhaseUI();
}

function updatePhaseUI() {
  const badge = document.getElementById('phase-badge');
  badge.textContent = PHASES[currentPhase];
  badge.className = 'phase-badge';
  if (currentPhase > 0 && currentPhase < 6) badge.classList.add('active');
  if (currentPhase === 5) badge.classList.add('recording');
}

function checkPhaseTransitions(pose) {
  const now = Date.now();
  const timeInPhase = now - phaseStartTime;
  const t = CONFIG.thresholds;

  switch (currentPhase) {
    case 0: // STANCE -> PREP
      // Raquete subindo: pulso acima do cotovelo + movimento upward
      if (pose.wrist && pose.elbow_pos && pose.wrist.y < pose.elbow_pos.y - 0.05) {
        enterPhase(1);
      }
      // Cue: relax arm (check tremor proxy - wrist jitter)
      if (pose.elbow !== null && pose.elbow < 160) { // arm not straight = holding racket
        // We'll use a simple heuristic: if in stance for >2s and elbow angle varies
        triggerCue(CUES.RELAX_ARM, 'Braço Relaxado', 'Solte a tensão no antebraço e punho');
      }
      break;

    case 1: // PREP -> TROPHY
      // Trophy: wrist near highest point, velocity near zero
      // Heuristic: racket height peaks + elbow angle stable
      if (pose.racketHeight !== null && pose.racketHeight > 0.8 && pose.elbow !== null && pose.elbow > 90) {
        // Check if holding position (would need velocity, approximate with time)
        if (timeInPhase > 300) {
          enterPhase(2);
        }
      }
      // Cue: elbow up
      if (pose.elbow !== null && pose.elbow < t.elbowMinTrophy) {
        triggerCue(CUES.ELBOW_UP, 'Cotovelo Alto', `Suba o cotovelo (>${t.elbowMinTrophy}°) no trophy`);
      }
      break;

    case 2: // TROPHY -> DROP
      // Drop: racket starts falling, pronation initiates
      if (pose.racketHeight !== null && pose.racketHeight < 0.7) {
        enterPhase(3);
        const trophyTime = timeInPhase;
        if (trophyTime < t.trophyMinTime) {
          triggerCue(CUES.TOSS_TIMING, 'Tempo no Trophy', `Fique ${t.trophyMinTime}ms no trophy - pernas carregam, toss sobe`);
        }
      }
      break;

    case 3: // DROP -> ACCELERATE
      // Accelerate: forward motion + pronation accelerating
      if (pose.pronation !== null && pose.pronation > t.pronateMinDrop) {
        enterPhase(4);
        // Check if pronation started early enough
        if (pose.pronation < t.pronateMinDrop) {
          triggerCue(CUES.PRONATE_NOW, 'PRONAÇÃO AGORA!', 'Gire o antebraço para fora JÁ');
        }
      }
      // Cue during drop if pronation delayed
      if (pose.pronation !== null && pose.pronation < t.pronateMinDrop && timeInPhase > 80) {
        triggerCue(CUES.PRONATE_NOW, 'PRONAÇÃO AGORA!', 'Inicie a rotação do antebraço');
      }
      break;

    case 4: // ACCELERATE -> CONTACT
      // Contact: max velocity proxy - rapid change in wrist position
      // Simplified: if wrist drops below hip level (contact zone)
      if (pose.wrist && pose.hip_pos && pose.wrist.y > pose.hip_pos.y + 0.05) {
        enterPhase(5);
        // Check jerk smoothness (would need velocity history)
        // Simplified cue:
        triggerCue(CUES.SMOOTH_ACCEL, 'Acelere Suave', 'Progressivo: devagar → rápido, não arranque');
      }
      break;

    case 5: // CONTACT -> FOLLOW
      // Follow through: continue rotation
      enterPhase(6);
      break;

    case 6: // FOLLOW -> STANCE (reset)
      // Reset when arm comes down and stabilizes
      if (pose.wrist && pose.elbow_pos && pose.wrist.y > pose.elbow_pos.y + 0.1 && timeInPhase > 500) {
        // Check if good serve
        const serveData = analyzeServe();
        if (serveData.isGood) {
          triggerCue(CUES.GOOD_SERVE, 'Ótimo Saque!', 'Padrão consistente - repita isso');
        }
        logServe(serveData);
        enterPhase(0);
      }
      // Cue: finish pronation
      if (pose.pronation !== null && pose.pronation < 120 && timeInPhase < 300) {
        triggerCue(CUES.PRONATE_NOW, 'Complete a Pronação', 'Termine com a palma virada para fora');
      }
      break;
  }
}

function analyzeServe() {
  const phases = phaseHistory.filter(p => p.phase > 0 && p.phase < 6);
  const totalTime = phases.reduce((sum, p) => sum + (p.duration || 0), 0);
  const trophyPhase = phaseHistory.find(p => p.phase === 2);
  const trophyTime = trophyPhase ? trophyPhase.duration : 0;
  const dropPhase = phaseHistory.find(p => p.phase === 3);
  const acceleratePhase = phaseHistory.find(p => p.phase === 4);

  // Get angle stats from pose history (simplified)
  const elbowAngles = angleBuffers.elbow;
  const pronationAngles = angleBuffers.pronation;

  const maxPronation = Math.max(...pronationAngles.filter(v => v !== null), 0);
  const minElbowAtTrophy = Math.min(...elbowAngles.filter(v => v !== null), 180);

  const isGood = (
    minElbowAtTrophy >= CONFIG.thresholds.elbowMinTrophy &&
    maxPronation >= 120 &&
    trophyTime >= CONFIG.thresholds.trophyMinTime &&
    totalTime > 800 && totalTime < 2000
  );

  return {
    timestamp: Date.now(),
    totalTime,
    trophyTime,
    dropToContactTime: (dropPhase?.duration || 0) + (acceleratePhase?.duration || 0),
    minElbowAtTrophy,
    maxPronation,
    cuesCount: cueHistory.length,
    isGood,
    phases: phaseHistory.map(p => ({phase: p.phaseName, duration: p.duration})),
    cues: [...cueHistory],
  };
}

function logServe(serveData) {
  serveLog.push(serveData);
  // Keep last 50
  if (serveLog.length > 50) serveLog.shift();
  saveToIndexedDB('serves', serveLog);
}

// ============ RENDERING ============
function drawPose(landmarks) {
  if (!ctx || !video.videoWidth) return;

  const w = canvas.width = video.videoWidth;
  const h = canvas.height = video.videoHeight;

  ctx.clearRect(0, 0, w, h);
  ctx.save();

  // espelho: feito no CSS para o vídeo e o desenho juntos (aplicarEspelho)

  // Draw connections
  const connections = [
    [S('SHOULDER'), S('ELBOW')],
    [S('ELBOW'), S('WRIST')],
    [S('SHOULDER'), S('HIP')],
    [S('HIP'), S('KNEE')],
    [S('KNEE'), S('ANKLE')],
    [S('SHOULDER'), OPP('SHOULDER')],
    [S('HIP'), OPP('HIP')],
  ];

  ctx.strokeStyle = '#3fb950';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  connections.forEach(([a, b]) => {
    const pa = landmarks[a];
    const pb = landmarks[b];
    if (!pa || !pb || pa.visibility < 0.3 || pb.visibility < 0.3) return;
    ctx.beginPath();
    ctx.moveTo(pa.x * w, pa.y * h);
    ctx.lineTo(pb.x * w, pb.y * h);
    ctx.stroke();
  });

  // Draw key points with phase-specific highlighting
  const keyPoints = [S('SHOULDER'), S('ELBOW'), S('WRIST'), S('HIP'), S('KNEE'), S('ANKLE')];
  keyPoints.forEach(idx => {
    const lm = landmarks[idx];
    if (!lm || lm.visibility < 0.3) return;

    let color = '#3fb950';
    let radius = 8;

    // Highlight based on phase
    if (currentPhase === 1 && idx === S('ELBOW')) { color = '#d29922'; radius = 12; }
    if (currentPhase === 3 && idx === S('WRIST')) { color = '#f85149'; radius = 12; }
    if (currentPhase === 4 && idx === S('WRIST')) { color = '#58a6ff'; radius = 12; }

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lm.x * w, lm.y * h, radius, 0, Math.PI * 2);
    ctx.fill();

    // Inner dot
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(lm.x * w, lm.y * h, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // Draw phase label on canvas
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(10, 10, 180, 40);
  ctx.fillStyle = '#3fb950';
  ctx.font = 'bold 18px system-ui';
  ctx.fillText(PHASES[currentPhase], 20, 38);

  ctx.restore();
}

function updateMetricsUI(pose) {
  const phaseEl = document.getElementById('metric-phase');
  const elbowEl = document.getElementById('metric-elbow');
  const pronationEl = document.getElementById('metric-pronation');
  const timeEl = document.getElementById('metric-time');

  phaseEl.textContent = PHASES[currentPhase];
  elbowEl.textContent = pose.elbow !== null ? `${Math.round(pose.elbow)}°` : '—';
  pronationEl.textContent = pose.pronation !== null ? `${Math.round(pose.pronation)}°` : '—';
  timeEl.textContent = currentPhase > 0 && serveStartTime ? `${Date.now() - serveStartTime}ms` : '—';

  // Color coding
  if (pose.elbow !== null) {
    elbowEl.className = 'metric-value';
    if (currentPhase === 1 || currentPhase === 2) {
      if (pose.elbow < CONFIG.thresholds.elbowMinTrophy) elbowEl.classList.add('danger');
      else elbowEl.classList.add('good');
    }
  }

  if (pose.pronation !== null) {
    pronationEl.className = 'metric-value';
    if (currentPhase === 3 || currentPhase === 4) {
      if (pose.pronation < CONFIG.thresholds.pronateMinDrop) pronationEl.classList.add('warn');
      else if (pose.pronation > 100) pronationEl.classList.add('good');
    }
  }
}

// ============ MAIN LOOP ============
async function mainLoop() {
  if (!video.readyState) {
    animationId = requestAnimationFrame(mainLoop);
    return;
  }

  // Demo mode: just show camera, no pose detection
  if (!poseDetector || demoMode) {
    drawCameraOnly();
    animationId = requestAnimationFrame(mainLoop);
    return;
  }

  try {
    const poses = await poseDetector.estimatePoses(video, {flipHorizontal: false});
    seloIA();
    if (poses.novo === false) { animationId = requestAnimationFrame(mainLoop); return; }

    if (poses.length === 0 && ctx && canvas.width) ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (poses.length > 0) {
      const landmarks = poses[0].keypoints;

      // Draw
      drawPose(landmarks);

      // Analyze
      const pose = analyzePose(landmarks);

      // Update metrics UI
      updateMetricsUI(pose);

      // State machine (only in training modes)
      const mode = document.querySelector('.mode-btn.active')?.dataset?.mode;
      if (mode === 'shadow' || mode === 'calibrate' || (mode === 'review' && REV.ativo)) {
        checkPhaseTransitions(pose);
      }
    }
  } catch (e) {
    console.error('Pose estimation error:', e);
  }

  animationId = requestAnimationFrame(mainLoop);
}

// selo pequeno no topo com o estado da IA (substitui o aviso de modo demo)
function seloIA() {
  let el = document.getElementById('selo-ia');
  if (!el) {
    el = document.createElement('div'); el.id = 'selo-ia';
    el.style.cssText = 'position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 8px);transform:translateX(-50%);z-index:50;background:rgba(0,0,0,.6);color:#fff;font:600 12px system-ui;padding:4px 10px;border-radius:12px;pointer-events:none';
    document.body.appendChild(el);
  }
  const t = demoMode ? '⚡ Sem IA (só avisos manuais)' : IA_STATUS ? IA_STATUS : poseDetector ? '🟢 IA ativa · ' + IA_INFO.fps + ' análises/s' + (IA_INFO.modo ? ' · ' + IA_INFO.modo : '') : '⏳ Carregando IA...';
  if (el.textContent !== t) el.textContent = t;
}

function drawCameraOnly() {
  seloIA();
  if (!ctx || !video.videoWidth) return;

  const w = canvas.width = video.videoWidth;
  const h = canvas.height = video.videoHeight;

  ctx.clearRect(0, 0, w, h);
  ctx.save();

  ctx.restore();
}

// ============ ESPELHO ============
function aplicarEspelho() {
  const t = (CONFIG.mirrorVideo && !REV.ativo) ? 'scaleX(-1)' : 'none';
  if (video) video.style.transform = t;
  if (canvas) canvas.style.transform = t;
}

// ============ REVISAR: vídeo gravado em câmera lenta ============
const REV = {ativo: false, url: null, marcas: [], vel: 0.25};
const fmtT = (x) => (Math.round(x * 100) / 100).toFixed(2).replace('.', ',') + ' s';

function montarRevisar() {
  if (document.getElementById('rev-painel')) return;
  const p = document.createElement('div'); p.id = 'rev-painel';
  p.innerHTML = `
    <div class="rev-top">
      <label class="btn primary" id="rev-carregar">📂 Carregar vídeo do saque<input type="file" id="rev-arq" accept="video/*" hidden></label>
      <button class="btn" id="rev-camera" style="display:none">📷 Voltar à câmera</button>
    </div>
    <div id="rev-dica" class="rev-dica">Escolha um vídeo do saque (da galeria ou grave agora). Ele roda em câmera lenta com o esqueleto e as medidas.</div>
    <div id="rev-ctl" style="display:none">
      <input type="range" id="rev-barra" min="0" max="1000" value="0" aria-label="Posição no vídeo">
      <div class="rev-linha">
        <button class="btn" id="rev-voltar" aria-label="Quadro anterior">⏮</button>
        <button class="btn primary" id="rev-play" aria-label="Tocar ou pausar">⏸</button>
        <button class="btn" id="rev-avancar" aria-label="Próximo quadro">⏭</button>
        <select id="rev-vel" aria-label="Velocidade"><option value="0.1">0,1×</option><option value="0.25" selected>0,25×</option><option value="0.5">0,5×</option><option value="1">1×</option></select>
        <span id="rev-tempo" class="rev-tempo">0,00 s</span>
      </div>
      <div id="rev-marcas" class="rev-marcas"></div>
    </div>`;
  document.body.appendChild(p);
  const css = document.createElement('style');
  css.textContent = `#rev-painel{position:fixed;left:10px;right:10px;top:calc(env(safe-area-inset-top) + 46px);z-index:40;background:rgba(13,17,23,.88);border:1px solid rgba(255,255,255,.15);border-radius:14px;padding:10px;display:none;color:#fff;max-width:620px;margin:0 auto}
  #rev-painel .rev-top{display:flex;gap:8px}#rev-painel .rev-top .btn{flex:1;text-align:center;cursor:pointer}
  #rev-painel .rev-dica{font-size:13px;opacity:.8;margin-top:6px}
  #rev-painel input[type=range]{width:100%;margin:10px 0 6px}
  #rev-painel .rev-linha{display:flex;gap:6px;align-items:center}#rev-painel .rev-linha .btn{min-width:44px;padding:8px 10px}
  #rev-painel select{background:#161b22;color:#fff;border:1px solid #30363d;border-radius:8px;padding:8px}
  #rev-painel .rev-tempo{margin-left:auto;font-variant-numeric:tabular-nums;font-size:14px}
  #rev-painel .rev-marcas{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  #rev-painel .rev-marcas button{font-size:12px;padding:5px 9px;border-radius:12px;border:1px solid #3fb950;background:rgba(63,185,80,.15);color:#fff}`;
  document.head.appendChild(css);
  const $ = (id) => document.getElementById(id);
  $('rev-arq').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) abrirVideo(f); e.target.value = ''; });
  $('rev-camera').addEventListener('click', voltarCamera);
  $('rev-play').addEventListener('click', () => { if (video.paused) video.play(); else video.pause(); });
  const passo = (d) => { video.pause(); video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + d)); };
  $('rev-voltar').addEventListener('click', () => passo(-1 / 30));
  $('rev-avancar').addEventListener('click', () => passo(1 / 30));
  $('rev-vel').addEventListener('change', (e) => { REV.vel = +e.target.value; video.playbackRate = REV.vel; });
  $('rev-barra').addEventListener('input', (e) => { video.pause(); if (video.duration) video.currentTime = video.duration * e.target.value / 1000; });
}

function atualizarRevUI() {
  const $ = (id) => document.getElementById(id);
  if (!$('rev-painel') || !REV.ativo) return;
  $('rev-play').textContent = video.paused ? '▶' : '⏸';
  $('rev-tempo').textContent = fmtT(video.currentTime || 0) + ' / ' + fmtT(video.duration || 0);
  if (video.duration && document.activeElement !== $('rev-barra')) $('rev-barra').value = Math.round(video.currentTime / video.duration * 1000);
}

function marcarFase(fase) {
  if (!REV.ativo) return;
  const t = video.currentTime;
  if (REV.marcas.some(m => m.fase === fase && Math.abs(m.t - t) < 0.15)) return;
  REV.marcas.push({fase, t});
  REV.marcas.sort((a, b) => a.t - b.t);
  const el = document.getElementById('rev-marcas');
  el.innerHTML = '<span style="font-size:12px;opacity:.75;width:100%">Fases encontradas (toque para ir):</span>' +
    REV.marcas.map((m, i) => `<button data-i="${i}">${PHASES[m.fase]} · ${fmtT(m.t)}</button>`).join('');
  el.querySelectorAll('button').forEach(b => b.onclick = () => { video.pause(); video.currentTime = REV.marcas[+b.dataset.i].t; });
}

async function abrirVideo(arquivo) {
  if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
  if (REV.url) URL.revokeObjectURL(REV.url);
  REV.url = URL.createObjectURL(arquivo);
  REV.ativo = true; REV.marcas = [];
  document.getElementById('rev-marcas').innerHTML = '';
  aplicarEspelho();
  video.style.objectFit = canvas.style.objectFit = 'contain';   // vídeo inteiro, sem cortar o corpo
  video.muted = true; video.loop = false; video.playsInline = true;
  video.src = REV.url;
  video.onloadedmetadata = () => { canvas.width = video.videoWidth; canvas.height = video.videoHeight; };
  video.ontimeupdate = atualizarRevUI; video.onplay = atualizarRevUI; video.onpause = atualizarRevUI;
  video.onended = () => { atualizarRevUI(); showToast(REV.marcas.length ? 'Fim do vídeo: toque nas fases para rever' : 'Fim do vídeo. Nenhuma fase completa encontrada; confira se o corpo inteiro aparece.', 'info'); };
  setMode('review');
  try { await video.play(); } catch (e) { /* iPhone pode pedir toque no ▶ */ }
  video.playbackRate = REV.vel;
  document.getElementById('rev-ctl').style.display = 'block';
  document.getElementById('rev-camera').style.display = 'block';
  document.getElementById('rev-dica').textContent = 'Câmera lenta: use ⏮ ⏭ para ir quadro a quadro. As fases aparecem abaixo quando o app as reconhece.';
  showToast('Vídeo carregado: analisando em câmera lenta', 'success');
}

async function voltarCamera() {
  if (!REV.ativo) return;
  REV.ativo = false;
  video.pause(); video.removeAttribute('src'); video.load();
  video.style.objectFit = canvas.style.objectFit = '';
  video.ontimeupdate = video.onplay = video.onpause = video.onended = null;
  if (REV.url) { URL.revokeObjectURL(REV.url); REV.url = null; }
  document.getElementById('rev-ctl').style.display = 'none';
  document.getElementById('rev-camera').style.display = 'none';
  document.getElementById('rev-dica').textContent = 'Escolha um vídeo do saque (da galeria ou grave agora). Ele roda em câmera lenta com o esqueleto e as medidas.';
  await setupCamera();
  aplicarEspelho();
}

// ============ CAMERA SETUP ============
async function setupCamera() {
  video = document.getElementById('video');
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext('2d');

  const constraints = {
    video: {
      facingMode: CONFIG.facingMode,
      width: {ideal: 1280},
      height: {ideal: 720},
      frameRate: {ideal: 60, max: 60},
    },
    audio: false,
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => {
        video.play().then(resolve).catch(reject);
      };
      video.onerror = reject;
      setTimeout(() => reject(new Error('Camera timeout')), 10000);
    });

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    aplicarEspelho();

    return true;
  } catch (e) {
    console.error('Camera error:', e);
    window.ultimoErroCamera = e;
    return false;
  }
}

async function flipCamera() {
  CONFIG.facingMode = CONFIG.facingMode === 'user' ? 'environment' : 'user';
  CONFIG.mirrorVideo = CONFIG.facingMode === 'user';
  document.getElementById('setting-mirror').checked = CONFIG.mirrorVideo;

  // Stop current stream
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
  }

  await setupCamera();
  saveSettings();
}

// ============ POSE DETECTOR INIT ============
const EH_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IA_INFO = {modo: '', ms: 0, fps: 0, quadros: 0, t0: performance.now()};

// IA num worker: a tela nunca trava. Devolve true se deu certo.
function iniciarWorker(nome) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker('pose-worker.js?v=8'); } catch (e) { return reject(e); }
    const limite = setTimeout(() => { w.terminate(); reject(new Error('IA demorou demais para carregar')); }, 90000);
    let ocupado = false, ultimo = [], novo = false, tsAnt = 0;
    w.onerror = (e) => { clearTimeout(limite); reject(new Error(e.message || 'worker falhou')); };
    w.onmessage = (e) => {
      const d = e.data;
      if (d.tipo === 'pronto') {
        clearTimeout(limite);
        IA_INFO.modo = d.modo + ' · fundo';
        poseDetector = {
          worker: w,
          async estimatePoses(videoEl) {
            if (!ocupado && videoEl.videoWidth) {
              ocupado = true;
              let ts = performance.now(); if (ts <= tsAnt) ts = tsAnt + 1; tsAnt = ts;
              const escala = Math.min(1, 640 / videoEl.videoWidth);
              const op = escala < 1 ? {resizeWidth: Math.round(videoEl.videoWidth * escala), resizeHeight: Math.round(videoEl.videoHeight * escala)} : undefined;
              (op ? createImageBitmap(videoEl, op).catch(() => createImageBitmap(videoEl)) : createImageBitmap(videoEl))
                .then(img => w.postMessage({tipo: 'quadro', img, ts}, [img]))
                .catch(() => { ocupado = false; });
            }
            const r = ultimo; r.novo = novo; novo = false; return r;
          },
        };
        resolve(true);
      } else if (d.tipo === 'erro') {
        clearTimeout(limite); w.terminate(); reject(new Error(d.msg));
      } else if (d.tipo === 'pose') {
        ocupado = false; novo = true;
        ultimo = d.lm ? [{keypoints: d.lm}] : [];
        IA_INFO.ms = d.ms || 0; IA_INFO.quadros++;
        const agora = performance.now();
        if (agora - IA_INFO.t0 > 1000) { IA_INFO.fps = Math.round(IA_INFO.quadros * 1000 / (agora - IA_INFO.t0)); IA_INFO.quadros = 0; IA_INFO.t0 = agora; }
      }
    };
    w.postMessage({tipo: 'init', nome, conf: CONFIG.minDetectionConfidence, gpu: !EH_IOS});
  });
}

async function initPoseDetector() {
  const loadingText = document.getElementById('loading-text');
  const startTime = Date.now();
  const nomes = {0: 'pose_landmarker_lite', 1: 'pose_landmarker_heavy', 2: 'pose_landmarker_full'};
  try {
    await iniciarWorker(nomes[CONFIG.modelComplexity] || nomes[0]);
    return true;
  } catch (e) {
    console.warn('IA em segundo plano falhou, tentando na tela principal:', e.message);
  }

  async function tryLoadModel(complexity) {
    loadingText.textContent = 'Baixando MediaPipe...';
    const mp = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
    const {PoseLandmarker, FilesetResolver} = mp;

    loadingText.textContent = 'Carregando modelo WASM...';
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );

    const modelNames = {
      0: 'pose_landmarker_lite',
      1: 'pose_landmarker_heavy',
      2: 'pose_landmarker_full',
    };
    const name = modelNames[complexity] || modelNames[0];

    loadingText.textContent = `Baixando modelo ${name}... (${Math.round((Date.now()-startTime)/1000)}s)`;

    const opts = (delegate) => ({
      baseOptions: {
        modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/${name}/float16/latest/${name}.task`,
        delegate,
      },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: CONFIG.minDetectionConfidence,
      minPosePresenceConfidence: CONFIG.minTrackingConfidence,
      minTrackingConfidence: CONFIG.minTrackingConfidence,
      outputSegmentationMasks: false,
    });
    let landmarker;
    try {
      if (EH_IOS) throw new Error('iPhone: CPU é mais estável');
      landmarker = await PoseLandmarker.createFromOptions(vision, opts('GPU'));
      IA_INFO.modo = 'GPU';
    } catch (e) {
      landmarker = await PoseLandmarker.createFromOptions(vision, opts('CPU'));
      IA_INFO.modo = 'CPU';
    }

    // Adaptador: o resto do app espera estimatePoses() -> [{keypoints}]
    let lastTs = 0;
    poseDetector = {
      landmarker,
      async estimatePoses(videoEl) {
        let ts = performance.now();
        if (ts <= lastTs) ts = lastTs + 1;
        lastTs = ts;
        const r = landmarker.detectForVideo(videoEl, ts);
        return (r.landmarks && r.landmarks.length) ? [{keypoints: r.landmarks[0]}] : [];
      },
    };

    return true;
  }

  // Try preferred model first, fallback to lightning if timeout
  try {
    await Promise.race([
      tryLoadModel(CONFIG.modelComplexity),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Model load timeout')), CONFIG.loadTimeoutMs)
      )
    ]);
  } catch (e) {
    console.warn('Preferred model failed/timeout, falling back to lightning:', e.message);
    loadingText.textContent = 'Modelo pesado demorou, carregando versão rápida...';
    CONFIG.modelComplexity = 0; // Force lightning
    document.getElementById('setting-model').value = 'lightning';
    await tryLoadModel(0);
  }

  return true;
}

function loadScriptWithTimeout(src, timeoutMs) {
  return Promise.race([
    loadScript(src),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout loading ${src}`)), timeoutMs)
    )
  ]);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

// ============ WAKE LOCK ============
async function requestWakeLock() {
  if (!CONFIG.wakeLockEnabled || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) {
    console.log('Wake lock failed:', e);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// ============ SETTINGS ============
const SETTINGS_KEY = 'servecoach_settings';
const DATA_KEY = 'servecoach_data';

function loadSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) Object.assign(CONFIG, JSON.parse(saved));
  } catch (e) {}

  // Apply to UI
  document.getElementById('setting-camera').value = CONFIG.facingMode === 'user' ? 'front' : 'back';
  const modelMap = {0: 'lightning', 1: 'thunder', 2: 'full'};
  document.getElementById('setting-model').value = modelMap[CONFIG.modelComplexity] || 'lightning';
  document.getElementById('setting-mirror').checked = CONFIG.mirrorVideo;
  document.getElementById('sens-elbow').value = CONFIG.thresholds.elbowMinTrophy;
  document.getElementById('val-elbow').textContent = CONFIG.thresholds.elbowMinTrophy + '°';
  document.getElementById('sens-pronate').value = CONFIG.thresholds.pronateMinDrop;
  document.getElementById('val-pronate').textContent = CONFIG.thresholds.pronateMinDrop + '°';
  document.getElementById('sens-toss').value = CONFIG.thresholds.trophyMinTime;
  document.getElementById('val-toss').textContent = CONFIG.thresholds.trophyMinTime + 'ms';
  document.getElementById('sens-jerk').value = CONFIG.thresholds.jerkRatioMax;
  document.getElementById('val-jerk').textContent = CONFIG.thresholds.jerkRatioMax + 'x';
  document.getElementById('sens-tremor').value = CONFIG.thresholds.tremorRMSMax;
  document.getElementById('val-tremor').textContent = CONFIG.thresholds.tremorRMSMax + 'g';
  document.getElementById('setting-audio').checked = CONFIG.audioEnabled;
  document.getElementById('setting-visual').checked = CONFIG.visualEnabled;
  document.getElementById('setting-haptic').checked = CONFIG.hapticEnabled;
  document.getElementById('setting-wakelock').checked = CONFIG.wakeLockEnabled;
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(CONFIG));
  } catch (e) {}
}

// Banco local. A versão 1 antiga era criada vazia (sem as áreas) e a leitura travava o app
// em "Carregando modelos de IA..." — a versão 2 cria as áreas; qualquer erro só devolve null.
function openDB() {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(null);
    let done = false;
    const fim = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => fim(null), 2500);
    try {
      const request = indexedDB.open('ServeCoachDB', 2);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('serves')) db.createObjectStore('serves', {keyPath: 'timestamp'});
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', {keyPath: 'key'});
      };
      request.onsuccess = (e) => fim(e.target.result);
      request.onerror = () => fim(null);
      request.onblocked = () => fim(null);
    } catch (e) { fim(null); }
  });
}

async function saveToIndexedDB(storeName, data) {
  try {
    const db = await openDB();
    if (!db || !db.objectStoreNames.contains(storeName)) return;
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    if (Array.isArray(data)) data.forEach(item => store.put(item));
    else store.put({key: storeName, value: data});
  } catch (e) { console.warn('Não salvou no banco local:', e.message); }
}

async function loadFromIndexedDB(storeName) {
  try {
    const db = await openDB();
    if (!db || !db.objectStoreNames.contains(storeName)) return null;
    return await new Promise((resolve) => {
      const r = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 2500);
    });
  } catch (e) { return null; }
}

// ============ EXPORT / IMPORT ============
function exportSession() {
  const data = {
    version: '1.0.0',
    exportDate: new Date().toISOString(),
    config: CONFIG,
    serves: serveLog,
    cues: cueHistory,
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `servecoach_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
  a.click();
  URL.revokeObjectURL(url);

  showToast('Sessão exportada!', 'success');
}

function clearAllData() {
  serveLog.length = 0;
  cueHistory.length = 0;
  phaseHistory.length = 0;
  saveToIndexedDB('serves', []);
  showToast('Histórico limpo', 'success');
}

// ============ TOAST ============
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'success' ? 'success' : type === 'error' ? 'error' : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-20px)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============ UI EVENT HANDLERS ============
function setupUI() {
  // Mode buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      setMode(btn.dataset.mode);
    });
  });

  // Camera flip
  document.getElementById('btn-camera-flip').addEventListener('click', flipCamera);

  // Settings panel
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.add('open');
  });
  document.getElementById('settings-close').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.remove('open');
  });

  // Settings inputs
  document.getElementById('setting-camera').addEventListener('change', (e) => {
    CONFIG.facingMode = e.target.value === 'front' ? 'user' : 'environment';
    CONFIG.mirrorVideo = CONFIG.facingMode === 'user';
    flipCamera();
  });

  document.getElementById('setting-model').addEventListener('change', async (e) => {
    const map = {lightning: 0, thunder: 1, full: 2};
    CONFIG.modelComplexity = map[e.target.value];
    saveSettings();
    showToast('Reinicie o app para mudar modelo', 'info');
  });

  document.getElementById('setting-mirror').addEventListener('change', (e) => {
    CONFIG.mirrorVideo = e.target.checked;
    aplicarEspelho();
    saveSettings();
  });

  // Sensitivity sliders
  const sliderMap = {
    'sens-elbow': ['thresholds', 'elbowMinTrophy', '°'],
    'sens-pronate': ['thresholds', 'pronateMinDrop', '°'],
    'sens-toss': ['thresholds', 'trophyMinTime', 'ms'],
    'sens-jerk': ['thresholds', 'jerkRatioMax', 'x'],
    'sens-tremor': ['thresholds', 'tremorRMSMax', 'g'],
  };

  Object.entries(sliderMap).forEach(([id, [obj, prop, unit]]) => {
    const slider = document.getElementById(id);
    const valEl = document.getElementById('val-' + id.replace('sens-', ''));
    slider.addEventListener('input', () => {
      CONFIG[obj][prop] = parseFloat(slider.value);
      valEl.textContent = slider.value + unit;
    });
    slider.addEventListener('change', saveSettings);
  });

  // Toggles
  ['audio', 'visual', 'haptic', 'wakelock'].forEach(key => {
    document.getElementById('setting-' + key).addEventListener('change', (e) => {
      CONFIG[key + 'Enabled'] = e.target.checked;
      if (key === 'wakelock') {
        if (e.target.checked) requestWakeLock(); else releaseWakeLock();
      }
      saveSettings();
    });
  });

  // Calibration modal
  document.getElementById('cal-start').addEventListener('click', startCalibration);
  document.getElementById('cal-cancel').addEventListener('click', () => {
    document.getElementById('cal-modal').classList.remove('show');
    setMode('shadow');
  });

  // Session modal
  document.getElementById('session-new').addEventListener('click', () => {
    document.getElementById('session-modal').classList.remove('show');
    resetSession();
    setMode('shadow');
  });
  document.getElementById('session-save').addEventListener('click', exportSession);

  // Export/clear
  document.getElementById('export-data').addEventListener('click', exportSession);
  document.getElementById('clear-data').addEventListener('click', () => {
    if (confirm('Apagar todo histórico de saques?')) clearAllData();
  });

  // Close modal on backdrop click
  document.querySelectorAll('.modal-backdrop').forEach(bg => {
    bg.addEventListener('click', (e) => {
      if (e.target === bg) bg.classList.remove('show');
    });
  });
}

let calibrationState = {count: 0, target: 3, serves: []};

function setMode(mode) {
  // Reset state machine
  currentPhase = 0;
  phaseHistory.length = 0;
  cueHistory.length = 0;
  phaseStartTime = 0;
  serveStartTime = 0;
  lastPhaseChange = 0;
  angleBuffers.elbow.length = 0;
  angleBuffers.shoulder.length = 0;
  angleBuffers.hip.length = 0;
  angleBuffers.knee.length = 0;
  angleBuffers.pronation.length = 0;
  angleBuffers.racketHeight.length = 0;
  updatePhaseUI();
  document.getElementById('cue-banner').classList.add('hidden');

  montarRevisar();
  document.getElementById('rev-painel').style.display = mode === 'review' ? 'block' : 'none';
  if (mode !== 'review' && REV.ativo) voltarCamera();

  if (mode === 'calibrate') {
    calibrationState = {count: 0, target: 3, serves: []};
    document.getElementById('cal-count').textContent = '0 / 3';
    document.getElementById('cal-progress-bar').style.width = '0%';
    document.getElementById('cal-start').disabled = false;
    document.getElementById('cal-desc').textContent = 'Faça 3 saques sombra no seu ritmo ideal. Mantenha o iPhone estável no tripé.';
    document.getElementById('cal-modal').classList.add('show');
  }
}

function startCalibration() {
  document.getElementById('cal-modal').classList.remove('show');
  calibrationState.count = 0;
  calibrationState.serves = [];
  // Just run normal shadow mode, collect 3 serves
  setMode('shadow');
  showToast('Calibração iniciada - faça 3 saques ideais', 'success');
}

function resetSession() {
  serveLog.length = 0;
  cueHistory.length = 0;
  phaseHistory.length = 0;
  currentPhase = 0;
  updatePhaseUI();
}

function endSession() {
  if (serveLog.length === 0) return;

  document.getElementById('stat-serves').textContent = serveLog.length;
  document.getElementById('stat-good').textContent = serveLog.filter(s => s.isGood).length;
  document.getElementById('stat-cues').textContent = cueHistory.length;
  document.getElementById('stat-duration').textContent = (serveStartTime ? Math.round((Date.now() - serveStartTime) / 1000) : 0) + 's';

  document.getElementById('session-modal').classList.add('show');
}

// ============ LANDSCAPE HINT ============
function checkOrientation() {
  // Only show once per session
  if (sessionStorage.getItem('landscapeHintDismissed') === 'true') return;

  const hint = document.getElementById('landscape-hint');
  if (window.innerHeight > window.innerWidth) {
    hint.classList.add('show');
  } else {
    hint.classList.remove('show');
  }
}

function dismissLandscapeHint() {
  sessionStorage.setItem('landscapeHintDismissed', 'true');
  document.getElementById('landscape-hint').classList.remove('show');
}

// Dismiss button
document.addEventListener('DOMContentLoaded', () => {
  const dismissBtn = document.getElementById('landscape-dismiss');
  if (dismissBtn) dismissBtn.addEventListener('click', dismissLandscapeHint);
});

window.addEventListener('resize', checkOrientation);
window.addEventListener('orientationchange', checkOrientation);

// ============ DEMO MODE (no AI) ============
let demoMode = false;

function enableDemoMode() {
  demoMode = true;
  poseDetector = null; // No AI
  document.getElementById('loading').style.display = 'none';
  setupUI();
  requestWakeLock();
  mainLoop(); // Will just show camera, no pose detection
  checkOrientation();
  setMode('shadow');
  showToast('Modo Demo: câmera ativa, cues manuais nas configurações', 'success');
}

async function clearCacheAndReload() {
  if ('caches' in window) {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map(name => caches.delete(name)));
  }
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(reg => reg.unregister()));
  }
  location.reload();
}

window.addEventListener('error', (e) => { try { showToast('Erro: ' + (e.message || e), 'error'); } catch (_) {} });
window.addEventListener('unhandledrejection', (e) => { try { showToast('Erro: ' + ((e.reason && e.reason.message) || e.reason), 'error'); } catch (_) {} });

// ============ INIT ============
// Nada bloqueia: a câmera abre já; a IA carrega por trás (com nova tentativa sozinha) e,
// quando fica pronta, o esqueleto e as análises começam sem precisar recarregar.
let IA_STATUS = '';
let iniciado = false;

function mostrarApp() {
  if (iniciado) return;
  iniciado = true;
  document.getElementById('loading').style.display = 'none';
  setupUI();
  requestWakeLock();
  mainLoop();
  checkOrientation();
  const bt = document.querySelector('.mode-btn[data-mode="shadow"]');
  if (bt) bt.click(); else setMode('shadow');
}

async function carregarIA(tentativa = 1) {
  IA_STATUS = '⏳ Carregando IA' + (tentativa > 1 ? ` (tentativa ${tentativa})` : '') + '...';
  try {
    await initPoseDetector();
    IA_STATUS = '';
    showToast('IA pronta: posicione o corpo inteiro na tela', 'success');
  } catch (e) {
    console.error('IA não carregou:', e);
    poseDetector = null;
    IA_STATUS = '⚠️ Sem IA (internet?) — nova tentativa em 10 s';
    setTimeout(() => carregarIA(tentativa + 1), 10000);
  }
}

function erroCamera(e) {
  const t = document.getElementById('loading-text');
  const negado = e && (e.name === 'NotAllowedError' || /denied|permission/i.test(e.message || ''));
  t.innerHTML = negado
    ? 'A câmera foi bloqueada.<br><small>No iPhone: Ajustes › Safari › Câmera › <b>Permitir</b> (ou toque em “aA” na barra de endereço › Ajustes do Site › Câmera). Depois toque em Tentar novamente.</small>'
    : 'Não consegui abrir a câmera' + (e && e.message ? ': ' + e.message : '') + '.<br><small>Feche outros apps que usam a câmera e toque em Tentar novamente.</small>';
  ['btn-retry-load', 'btn-skip-ai'].forEach(id => { const b = document.getElementById(id); if (b) b.style.display = 'block'; });
}

async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('demo') === '1') { enableDemoMode(); return; }

  const loadingText = document.getElementById('loading-text');
  const skipBtn = document.getElementById('btn-skip-ai');
  const retryBtn = document.getElementById('btn-retry-load');
  const clearCacheBtn = document.getElementById('btn-clear-cache');
  skipBtn.addEventListener('click', enableDemoMode);
  retryBtn.addEventListener('click', () => location.reload());
  clearCacheBtn.addEventListener('click', clearCacheAndReload);
  skipBtn.textContent = '📷 Abrir sem câmera/IA (só os avisos manuais)';

  try { loadSettings(); } catch (e) { console.warn('Ajustes:', e); }

  // saques salvos: em paralelo, nunca trava
  loadFromIndexedDB('serves').then(s => { if (s) s.forEach(x => serveLog.push(x)); });

  loadingText.textContent = 'Abrindo a câmera...';
  let camErro = null;
  try {
    const ok = await setupCamera();
    if (!ok) camErro = window.ultimoErroCamera || new Error('câmera indisponível');
  } catch (e) { camErro = e; }
  if (camErro) { erroCamera(camErro); return; }

  mostrarApp();          // já mostra a câmera
  carregarIA();          // IA em segundo plano
}

// Handle visibility change
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    releaseWakeLock();
  } else if (CONFIG.wakeLockEnabled) {
    requestWakeLock();
  }
});

// Start
init();