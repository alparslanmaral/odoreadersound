(() => {
  'use strict';

  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;
  const STORAGE_KEY = 'rpmExhaustCalibration';

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---- DOM refs ----
  const video = document.getElementById('video');
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cameraPlaceholder = document.getElementById('cameraPlaceholder');
  const startCameraBtn = document.getElementById('startCameraBtn');

  const statusBanner = document.getElementById('statusBanner');

  const rpmValueEl = document.getElementById('rpmValue');
  const rpmBarFill = document.getElementById('rpmBarFill');

  const setPivotBtn = document.getElementById('setPivotBtn');
  const pivotStatus = document.getElementById('pivotStatus');
  const setIdleBtn = document.getElementById('setIdleBtn');
  const idleStatus = document.getElementById('idleStatus');
  const setMaxBtn = document.getElementById('setMaxBtn');
  const maxStatus = document.getElementById('maxStatus');
  const pickColorBtn = document.getElementById('pickColorBtn');
  const colorStatus = document.getElementById('colorStatus');
  const colorSwatch = document.getElementById('colorSwatch');

  const minRpmInput = document.getElementById('minRpmInput');
  const maxRpmInput = document.getElementById('maxRpmInput');

  const radiusSlider = document.getElementById('radiusSlider');
  const radiusValueEl = document.getElementById('radiusValue');
  const thresholdSlider = document.getElementById('thresholdSlider');
  const thresholdValueEl = document.getElementById('thresholdValue');
  const smoothingSlider = document.getElementById('smoothingSlider');
  const smoothingValueEl = document.getElementById('smoothingValue');

  const saveCalibrationBtn = document.getElementById('saveCalibrationBtn');
  const resetCalibrationBtn = document.getElementById('resetCalibrationBtn');
  const calibNote = document.getElementById('calibNote');

  const audioFileInput = document.getElementById('audioFileInput');
  const audioFileStatus = document.getElementById('audioFileStatus');
  const startSoundBtn = document.getElementById('startSoundBtn');
  const stopSoundBtn = document.getElementById('stopSoundBtn');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumeValueEl = document.getElementById('volumeValue');

  const fileModeControls = document.getElementById('fileModeControls');
  const pitchMinSlider = document.getElementById('pitchMinSlider');
  const pitchMinValueEl = document.getElementById('pitchMinValue');
  const pitchMaxSlider = document.getElementById('pitchMaxSlider');
  const pitchMaxValueEl = document.getElementById('pitchMaxValue');

  const synthModeControls = document.getElementById('synthModeControls');
  const cylindersSlider = document.getElementById('cylindersSlider');
  const cylindersValueEl = document.getElementById('cylindersValue');

  const debugToggle = document.getElementById('debugToggle');

  // ---- State ----
  let pivot = null;            // {x,y} in canvas pixel space
  let tempIdlePoint = null;
  let tempMaxPoint = null;
  let calAngleIdle = null;
  let calAngleMax = null;
  let refColor = null;         // {h,s,v,r,g,b}

  let radius = parseFloat(radiusSlider.value);
  let radiusTol = Math.max(6, Math.round(radius * 0.08));
  let colorThreshold = parseFloat(thresholdSlider.value) / 100;
  let smoothingAlpha = 0.05 + (1 - parseFloat(smoothingSlider.value) / 100) * 0.45;

  let cal = null;               // saved calibration object
  let calibrated = false;
  let calibMode = 'none';       // none | pivot | needleIdle | needleMax | color
  let debugMode = false;

  let smoothedVec = null;
  let lastDetectedAngle = null;
  let lastFrameHadMatch = false;

  // ---- Status banner ----
  let statusTimer = null;
  function showStatus(message, type = 'info', persistent = false) {
    statusBanner.textContent = message;
    statusBanner.className = 'status-banner visible ' + type;
    if (statusTimer) clearTimeout(statusTimer);
    if (!persistent) {
      statusTimer = setTimeout(() => {
        statusBanner.className = 'status-banner';
      }, 4000);
    }
  }

  // ---- Range slider fill ----
  function styleRangeFill(el) {
    const min = parseFloat(el.min) || 0;
    const max = parseFloat(el.max) || 100;
    const val = parseFloat(el.value);
    const pct = ((val - min) / (max - min)) * 100;
    el.style.background = `linear-gradient(90deg, var(--accent) ${pct}%, var(--panel-alt) ${pct}%)`;
  }

  function bindSlider(slider, valueEl, onChange, format = (v) => v) {
    const apply = () => {
      const raw = parseFloat(slider.value);
      if (valueEl) valueEl.textContent = format(raw);
      styleRangeFill(slider);
      onChange(raw);
    };
    slider.addEventListener('input', apply);
    apply();
    return apply;
  }

  bindSlider(radiusSlider, radiusValueEl, (v) => {
    radius = v;
    radiusTol = Math.max(6, Math.round(radius * 0.08));
  }, (v) => Math.round(v));

  bindSlider(thresholdSlider, thresholdValueEl, (v) => { colorThreshold = v / 100; }, (v) => Math.round(v));

  bindSlider(smoothingSlider, smoothingValueEl, (v) => {
    smoothingAlpha = 0.05 + (1 - v / 100) * 0.45;
  }, (v) => Math.round(v));

  // ---- Color helpers ----
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    const v = max;
    return { h, s, v };
  }

  function hsvDistance(a, b) {
    let dh = Math.abs(a.h - b.h);
    if (dh > 180) dh = 360 - dh;
    const dhNorm = dh / 180;
    const ds = Math.abs(a.s - b.s);
    const dv = Math.abs(a.v - b.v);
    return Math.sqrt(dhNorm * dhNorm * 0.6 + ds * ds * 0.25 + dv * dv * 0.15);
  }

  function interpolateColor(t) {
    const c1 = [245, 245, 247];
    const c2 = [227, 6, 19];
    const r = Math.round(lerp(c1[0], c2[0], t));
    const g = Math.round(lerp(c1[1], c2[1], t));
    const b = Math.round(lerp(c1[2], c2[2], t));
    return `rgb(${r}, ${g}, ${b})`;
  }

  // ---- Angle helpers ----
  function angleToVec(deg) {
    const rad = deg * DEG2RAD;
    return { x: Math.cos(rad), y: Math.sin(rad) };
  }
  function vecToAngle(v) {
    let deg = Math.atan2(v.y, v.x) * RAD2DEG;
    if (deg < 0) deg += 360;
    return deg;
  }
  function normalizeAngleDiff(diff) {
    return ((diff % 360) + 540) % 360 - 180;
  }
  function angleFromPivot(pt) {
    const dx = pt.x - pivot.x, dy = pt.y - pivot.y;
    let deg = Math.atan2(dy, dx) * RAD2DEG;
    if (deg < 0) deg += 360;
    return deg;
  }

  function angleToRpm(angle) {
    const deltaMax = normalizeAngleDiff(cal.angleMax - cal.angleIdle);
    if (deltaMax === 0) return cal.minRpm;
    const delta = normalizeAngleDiff(angle - cal.angleIdle);
    const t = delta / deltaMax;
    const rpm = cal.minRpm + t * (cal.maxRpm - cal.minRpm);
    return clamp(rpm, cal.minRpm, cal.maxRpm);
  }

  // ---- Sound engine ----
  function createNoiseBuffer(ctx) {
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  const SoundEngine = {
    ctx: null,
    gainNode: null,
    mode: 'synth',
    running: false,
    volume: 0.7,
    buffer: null,
    fileSource: null,
    pitchMin: 0.5,
    pitchMax: 2.0,
    synthNodes: null,
    cylinders: 4,
    minRpm: 0,
    maxRpm: 7000,

    init() {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = this.volume;
      this.gainNode.connect(this.ctx.destination);
    },

    async start() {
      if (!this.ctx) this.init();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (this.running) return;
      if (this.mode === 'file' && this.buffer) this._startFile();
      else this._startSynth();
      this.running = true;
    },

    stop() {
      if (this.fileSource) {
        try { this.fileSource.stop(); } catch (e) { /* already stopped */ }
        this.fileSource = null;
      }
      if (this.synthNodes) {
        const n = this.synthNodes;
        for (const node of [n.osc1, n.osc2, n.osc3, n.noiseSource]) {
          try { node.stop(); } catch (e) { /* already stopped */ }
        }
        this.synthNodes = null;
      }
      this.running = false;
    },

    _startFile() {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer;
      src.loop = true;
      src.playbackRate.value = this.pitchMin;
      src.connect(this.gainNode);
      src.start();
      this.fileSource = src;
    },

    _startSynth() {
      const c = this.ctx;
      const osc1 = c.createOscillator(); osc1.type = 'sawtooth';
      const osc2 = c.createOscillator(); osc2.type = 'sawtooth';
      const osc3 = c.createOscillator(); osc3.type = 'square';
      const g1 = c.createGain(); g1.gain.value = 0.45;
      const g2 = c.createGain(); g2.gain.value = 0.22;
      const g3 = c.createGain(); g3.gain.value = 0.10;
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = 1200; filter.Q.value = 0.8;

      const noiseSource = c.createBufferSource();
      noiseSource.buffer = createNoiseBuffer(c);
      noiseSource.loop = true;
      const noiseFilter = c.createBiquadFilter();
      noiseFilter.type = 'bandpass'; noiseFilter.frequency.value = 400; noiseFilter.Q.value = 0.6;
      const noiseGain = c.createGain(); noiseGain.gain.value = 0.06;

      osc1.connect(g1); osc2.connect(g2); osc3.connect(g3);
      g1.connect(filter); g2.connect(filter); g3.connect(filter);
      filter.connect(this.gainNode);

      noiseSource.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(this.gainNode);

      osc1.frequency.value = 40; osc2.frequency.value = 80; osc3.frequency.value = 120;
      osc1.start(); osc2.start(); osc3.start(); noiseSource.start();

      this.synthNodes = { osc1, osc2, osc3, filter, noiseSource, noiseFilter, noiseGain };
    },

    setRpm(rpm) {
      if (!this.running || !this.ctx) return;
      const now = this.ctx.currentTime;
      const smoothTime = 0.06;
      const t = clamp((rpm - this.minRpm) / Math.max(1, this.maxRpm - this.minRpm), 0, 1);
      if (this.mode === 'file' && this.fileSource) {
        const rate = this.pitchMin + t * (this.pitchMax - this.pitchMin);
        this.fileSource.playbackRate.setTargetAtTime(rate, now, smoothTime);
      } else if (this.synthNodes) {
        // exhaust pulse frequency for a 4-stroke engine: cylinders fire once every 2 revolutions
        const firing = Math.max(4, (rpm / 60) * (this.cylinders / 2));
        this.synthNodes.osc1.frequency.setTargetAtTime(firing, now, smoothTime);
        this.synthNodes.osc2.frequency.setTargetAtTime(firing * 2, now, smoothTime);
        this.synthNodes.osc3.frequency.setTargetAtTime(firing * 3, now, smoothTime);
        this.synthNodes.filter.frequency.setTargetAtTime(500 + t * 4500, now, smoothTime);
        this.synthNodes.noiseGain.gain.setTargetAtTime(0.05 + t * 0.15, now, smoothTime);
        this.synthNodes.noiseFilter.frequency.setTargetAtTime(300 + t * 800, now, smoothTime);
      }
    },

    setVolume(v) {
      this.volume = v;
      if (this.gainNode) this.gainNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    },
  };

  bindSlider(volumeSlider, volumeValueEl, (v) => SoundEngine.setVolume(v / 100), (v) => Math.round(v));
  bindSlider(pitchMinSlider, pitchMinValueEl, (v) => { SoundEngine.pitchMin = v / 100; }, (v) => (v / 100).toFixed(2));
  bindSlider(pitchMaxSlider, pitchMaxValueEl, (v) => { SoundEngine.pitchMax = v / 100; }, (v) => (v / 100).toFixed(2));
  bindSlider(cylindersSlider, cylindersValueEl, (v) => { SoundEngine.cylinders = v; }, (v) => Math.round(v));

  audioFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const arrayBuffer = await file.arrayBuffer();
      if (!SoundEngine.ctx) SoundEngine.init();
      const audioBuffer = await SoundEngine.ctx.decodeAudioData(arrayBuffer);
      SoundEngine.buffer = audioBuffer;
      SoundEngine.mode = 'file';
      audioFileStatus.textContent = `Loaded: ${file.name}`;
      fileModeControls.hidden = false;
      synthModeControls.hidden = true;
      if (SoundEngine.running) { SoundEngine.stop(); SoundEngine.start(); }
    } catch (err) {
      showStatus('Could not decode audio file: ' + err.message, 'error');
    }
  });

  startSoundBtn.addEventListener('click', async () => {
    try {
      await SoundEngine.start();
      startSoundBtn.disabled = true;
      stopSoundBtn.disabled = false;
    } catch (err) {
      showStatus('Could not start audio: ' + err.message, 'error');
    }
  });

  stopSoundBtn.addEventListener('click', () => {
    SoundEngine.stop();
    startSoundBtn.disabled = false;
    stopSoundBtn.disabled = true;
  });

  // ---- Camera ----
  async function startCamera() {
    if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      showStatus('Camera access requires HTTPS (localhost is exempt). Deploy over HTTPS to use the camera on a phone.', 'warning', true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      showStatus('Camera access failed: ' + err.message, 'error', true);
    }
  }

  video.addEventListener('loadedmetadata', () => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    cameraPlaceholder.hidden = true;
    [setPivotBtn, setIdleBtn, setMaxBtn, pickColorBtn].forEach((b) => (b.disabled = false));
    requestAnimationFrame(tick);
  });

  startCameraBtn.addEventListener('click', startCamera);

  // ---- Calibration UI ----
  function setCalibMode(mode) {
    calibMode = mode;
    [setPivotBtn, setIdleBtn, setMaxBtn, pickColorBtn].forEach((b) => b.classList.remove('active'));
    const map = { pivot: setPivotBtn, needleIdle: setIdleBtn, needleMax: setMaxBtn, color: pickColorBtn };
    if (map[mode]) map[mode].classList.add('active');
  }

  setPivotBtn.addEventListener('click', () => {
    setCalibMode('pivot');
    showStatus('Tap the needle\'s pivot (rotation center) on the image.', 'info', true);
  });
  setIdleBtn.addEventListener('click', () => {
    if (!pivot) { showStatus('Set the pivot point first.', 'warning'); return; }
    setCalibMode('needleIdle');
    showStatus('With the gauge at idle / 0 RPM, tap the needle tip.', 'info', true);
  });
  setMaxBtn.addEventListener('click', () => {
    if (!pivot) { showStatus('Set the pivot point first.', 'warning'); return; }
    setCalibMode('needleMax');
    showStatus('With the gauge at max RPM, tap the needle tip.', 'info', true);
  });
  pickColorBtn.addEventListener('click', () => {
    setCalibMode('color');
    showStatus('Tap directly on the needle to sample its color.', 'info', true);
  });

  function getCanvasPoint(evt) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (evt.clientX - rect.left) * scaleX, y: (evt.clientY - rect.top) * scaleY };
  }

  canvas.addEventListener('pointerdown', (evt) => {
    if (calibMode === 'none' || canvas.width === 0) return;
    const pt = getCanvasPoint(evt);

    if (calibMode === 'pivot') {
      pivot = pt;
      pivotStatus.textContent = 'Set';
    } else if (calibMode === 'needleIdle') {
      tempIdlePoint = pt;
      calAngleIdle = angleFromPivot(pt);
      idleStatus.textContent = 'Set';
    } else if (calibMode === 'needleMax') {
      tempMaxPoint = pt;
      calAngleMax = angleFromPivot(pt);
      maxStatus.textContent = 'Set';
    } else if (calibMode === 'color') {
      const px = clamp(Math.round(pt.x), 0, canvas.width - 1);
      const py = clamp(Math.round(pt.y), 0, canvas.height - 1);
      const data = ctx.getImageData(px, py, 1, 1).data;
      refColor = { ...rgbToHsv(data[0], data[1], data[2]), r: data[0], g: data[1], b: data[2] };
      colorStatus.textContent = 'Set';
      colorSwatch.style.background = `rgb(${data[0]}, ${data[1]}, ${data[2]})`;
    }

    setCalibMode('none');
    statusBanner.className = 'status-banner';
    updateSaveButtonState();
  });

  function updateSaveButtonState() {
    const minRpm = parseFloat(minRpmInput.value);
    const maxRpm = parseFloat(maxRpmInput.value);
    const ready = pivot && calAngleIdle !== null && calAngleMax !== null && refColor &&
      Number.isFinite(minRpm) && Number.isFinite(maxRpm) && minRpm < maxRpm;
    saveCalibrationBtn.disabled = !ready;
  }
  minRpmInput.addEventListener('input', updateSaveButtonState);
  maxRpmInput.addEventListener('input', updateSaveButtonState);

  saveCalibrationBtn.addEventListener('click', () => {
    cal = {
      pivot,
      angleIdle: calAngleIdle,
      angleMax: calAngleMax,
      minRpm: parseFloat(minRpmInput.value),
      maxRpm: parseFloat(maxRpmInput.value),
      refColor,
      radius,
      thresholdPercent: parseFloat(thresholdSlider.value),
      smoothingPercent: parseFloat(smoothingSlider.value),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cal));
    calibrated = true;
    SoundEngine.minRpm = cal.minRpm;
    SoundEngine.maxRpm = cal.maxRpm;
    calibNote.textContent = 'Calibration saved.';
    showStatus('Calibration saved successfully.', 'success');
  });

  resetCalibrationBtn.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    pivot = null; tempIdlePoint = null; tempMaxPoint = null;
    calAngleIdle = null; calAngleMax = null; refColor = null;
    cal = null; calibrated = false;
    smoothedVec = null; lastDetectedAngle = null;
    pivotStatus.textContent = 'Not set';
    idleStatus.textContent = 'Not set';
    maxStatus.textContent = 'Not set';
    colorStatus.textContent = 'Not set';
    colorSwatch.style.background = 'var(--panel-alt)';
    calibNote.textContent = '';
    rpmValueEl.textContent = '—';
    rpmBarFill.style.width = '0%';
    updateSaveButtonState();
    showStatus('Calibration cleared.', 'info');
  });

  function loadCalibration() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw);
      cal = saved;
      pivot = saved.pivot;
      calAngleIdle = saved.angleIdle;
      calAngleMax = saved.angleMax;
      refColor = saved.refColor;
      calibrated = true;

      minRpmInput.value = saved.minRpm;
      maxRpmInput.value = saved.maxRpm;
      radiusSlider.value = saved.radius;
      radiusSlider.dispatchEvent(new Event('input'));
      thresholdSlider.value = saved.thresholdPercent;
      thresholdSlider.dispatchEvent(new Event('input'));
      smoothingSlider.value = saved.smoothingPercent;
      smoothingSlider.dispatchEvent(new Event('input'));

      pivotStatus.textContent = 'Loaded';
      idleStatus.textContent = 'Loaded';
      maxStatus.textContent = 'Loaded';
      colorStatus.textContent = 'Loaded';
      if (refColor) colorSwatch.style.background = `rgb(${refColor.r}, ${refColor.g}, ${refColor.b})`;

      SoundEngine.minRpm = saved.minRpm;
      SoundEngine.maxRpm = saved.maxRpm;

      calibNote.textContent = 'Loaded saved calibration. Recalibrate if the camera angle changed.';
      updateSaveButtonState();
    } catch (e) {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  debugToggle.addEventListener('change', () => { debugMode = debugToggle.checked; });

  // ---- Detection ----
  function detectNeedleAngle() {
    const rMin = radius - radiusTol, rMax = radius + radiusTol;
    const roiX = clamp(Math.floor(pivot.x - rMax), 0, canvas.width - 1);
    const roiY = clamp(Math.floor(pivot.y - rMax), 0, canvas.height - 1);
    const roiRight = clamp(Math.ceil(pivot.x + rMax), 0, canvas.width);
    const roiBottom = clamp(Math.ceil(pivot.y + rMax), 0, canvas.height);
    const roiW = roiRight - roiX, roiH = roiBottom - roiY;
    if (roiW <= 0 || roiH <= 0) return null;

    const imageData = ctx.getImageData(roiX, roiY, roiW, roiH);
    const data = imageData.data;

    const matches = [];
    for (let a = 0; a < 360; a += 2) {
      const rad = a * DEG2RAD;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      let bestDist = Infinity;
      for (let r = rMin; r <= rMax; r += 3) {
        const px = Math.round(pivot.x + r * cos) - roiX;
        const py = Math.round(pivot.y + r * sin) - roiY;
        if (px < 0 || py < 0 || px >= roiW || py >= roiH) continue;
        const idx = (py * roiW + px) * 4;
        const dist = hsvDistance(rgbToHsv(data[idx], data[idx + 1], data[idx + 2]), refColor);
        if (dist < bestDist) bestDist = dist;
      }
      if (bestDist < colorThreshold) {
        matches.push({ angle: a, weight: 1 - bestDist / colorThreshold });
      }
    }

    if (!matches.length) return null;
    let sx = 0, sy = 0, sw = 0;
    for (const m of matches) {
      const rad = m.angle * DEG2RAD;
      sx += Math.cos(rad) * m.weight;
      sy += Math.sin(rad) * m.weight;
      sw += m.weight;
    }
    if (sw === 0) return null;
    let deg = Math.atan2(sy / sw, sx / sw) * RAD2DEG;
    if (deg < 0) deg += 360;
    return deg;
  }

  // ---- Overlay drawing ----
  function drawCrosshair(pt, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pt.x - 10, pt.y); ctx.lineTo(pt.x + 10, pt.y);
    ctx.moveTo(pt.x, pt.y - 10); ctx.lineTo(pt.x, pt.y + 10);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawDot(pt, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawOverlay() {
    if (!pivot) return;
    const showCalibGuides = !calibrated || debugMode;

    if (showCalibGuides) {
      ctx.save();
      ctx.strokeStyle = 'rgba(227, 6, 19, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(pivot.x, pivot.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      if (debugMode) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(227, 6, 19, 0.3)';
        ctx.beginPath(); ctx.arc(pivot.x, pivot.y, radius - radiusTol, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(pivot.x, pivot.y, radius + radiusTol, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      drawCrosshair(pivot, '#E30613');
      ctx.restore();
    }

    if (!calibrated) {
      if (tempIdlePoint) drawDot(tempIdlePoint, '#8E8E93');
      if (tempMaxPoint) drawDot(tempMaxPoint, '#F5F5F7');
    }

    if (debugMode && lastDetectedAngle !== null) {
      const rad = lastDetectedAngle * DEG2RAD;
      const px = pivot.x + radius * Math.cos(rad);
      const py = pivot.y + radius * Math.sin(rad);
      ctx.save();
      ctx.strokeStyle = lastFrameHadMatch ? '#34C759' : 'rgba(52, 199, 89, 0.4)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(pivot.x, pivot.y);
      ctx.lineTo(px, py);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  // ---- RPM display ----
  function updateRpmDisplay(rpm) {
    rpmValueEl.textContent = Math.round(rpm).toString();
    const t = clamp((rpm - cal.minRpm) / Math.max(1, cal.maxRpm - cal.minRpm), 0, 1);
    rpmBarFill.style.width = (t * 100) + '%';
    rpmValueEl.style.color = interpolateColor(t);
  }

  // ---- Main loop ----
  function tick() {
    if (video.readyState >= 2 && canvas.width > 0) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      if (calibrated && pivot && refColor) {
        const rawAngle = detectNeedleAngle();
        lastFrameHadMatch = rawAngle !== null;
        if (rawAngle !== null) {
          const rv = angleToVec(rawAngle);
          if (!smoothedVec) smoothedVec = rv;
          else {
            smoothedVec.x += smoothingAlpha * (rv.x - smoothedVec.x);
            smoothedVec.y += smoothingAlpha * (rv.y - smoothedVec.y);
          }
          lastDetectedAngle = vecToAngle(smoothedVec);
        }
        if (lastDetectedAngle !== null) {
          const rpm = angleToRpm(lastDetectedAngle);
          updateRpmDisplay(rpm);
          SoundEngine.setRpm(rpm);
        }
      }

      drawOverlay();
    }
    requestAnimationFrame(tick);
  }

  // ---- Init ----
  loadCalibration();
  updateSaveButtonState();
  if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    showStatus('Camera access requires HTTPS (localhost is exempt). Deploy over HTTPS to use this on a phone.', 'warning', true);
  }
})();
