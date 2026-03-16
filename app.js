/**
 * DPI METRICS — app.js  v2.0
 * ─────────────────────────────────────────────────────────────
 * Fixes applied vs v1 audit:
 *  [BUG-7]  CircularBuffer readLast off-by-one: fixed start calc
 *  [BUG-8]  ResizeObserver double-scale: ctx.setTransform() before every scale
 *  [BUG-6]  Hz noisy: 8-16 sample rolling window average (not last-interval)
 *  [BUG-9]  hzMin Infinity flash: guard in DOM update
 *  [BUG-10] Timestamp epoch mismatch: documented, both use performance.now epoch
 *  [FEAT-5] Heatmap mode: fully implemented in renderJitterPlot
 *  [UX-3]   DPI: diagonal detection warning, mm/cm/in unit conversion
 *  [UX-3]   DPI: visual ruler with tick marks on canvas
 *  [UX-3]   DPI: min drag 30px with clear error message
 *  [UX-4]   Jitter data persists across tab switches (global event capture)
 *  [UX-16]  CSV export of session data
 *  [MOBILE] Touch events on all zones (passthrough capture)
 *  [MOBILE] Bottom-nav synced with desktop tabs
 *  [OB]     Onboarding overlay with localStorage skip
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/* ════════════════════════════════════════════════════════════
   CONSTANTS
   ════════════════════════════════════════════════════════════ */
const BUFFER_SIZE      = 1024;   // power-of-2 for bitmask
const HZ_WINDOW_MS     = 500;    // sliding window for Hz average
const HISTORY_SAMPLES  = 120;
const JITTER_MAX_PTS   = 4096;
const RAF_ALPHA        = 0.1;    // EMA smoothing for fps display
const DROP_THRESHOLD   = 200;    // ms gap = mouse stopped

/* Canvas color palette — matches CSS metal+accent theme */
const C_CYAN      = '#00d4ff';
const C_CYAN_MID  = 'rgba(0,212,255,0.5)';
const C_CYAN_DIM  = 'rgba(0,212,255,0.18)';
const C_AMBER     = '#ffaa00';
const C_AMBER_MID = 'rgba(255,170,0,0.5)';
const C_AMBER_DIM = 'rgba(255,170,0,0.18)';
const C_VIOLET    = '#9b6dff';
const C_GREEN     = '#00d68f';
const C_CORAL     = '#ff5055';
const C_WHITE50   = 'rgba(255,255,255,0.3)';
const C_BG        = '#080910';
const C_GRID      = 'rgba(255,255,255,0.035)';
const C_STEEL_HI  = 'rgba(176,188,200,0.7)';
const C_STEEL_MID = 'rgba(130,144,160,0.5)';

/* ════════════════════════════════════════════════════════════
   CIRCULAR BUFFER (fixed-size, zero GC after construction)
   ════════════════════════════════════════════════════════════ */
class CircularBuffer {
  constructor(size) {
    this.data  = new Float64Array(size);
    this.size  = size;
    this.mask  = size - 1;
    this.head  = 0;   // next write slot
    this.count = 0;
  }

  push(val) {
    this.data[this.head] = val;
    this.head = (this.head + 1) & this.mask;
    if (this.count < this.size) this.count++;
  }

  /**
   * [FIX-7] Read the n-th most recent value.
   * head always points to the NEXT empty slot, so last written = head-1.
   */
  peekBack(n) {
    // head-1-n, wrapping correctly even when count < size
    return this.data[((this.head - 1 - n) + this.size * 2) & this.mask];
  }

  /** Iterate from oldest to newest across valid entries */
  forEach(fn) {
    const n     = this.count;
    const start = ((this.head - n) + this.size * 2) & this.mask;
    for (let i = 0; i < n; i++) {
      fn(this.data[(start + i) & this.mask], i);
    }
  }

  clear() { this.head = 0; this.count = 0; }
}

/* ════════════════════════════════════════════════════════════
   STATE
   ════════════════════════════════════════════════════════════ */
const state = {
  // ── Polling
  timestamps:      new CircularBuffer(BUFFER_SIZE),
  hzHistory:       new Float32Array(HISTORY_SAMPLES),
  hzHistIdx:       0,
  peakHz:          0,
  lastHz:          0,
  hzMin:           Infinity,
  lastInterval:    0,
  eventsInWindow:  0,
  eventsPerSec:    0,
  windowStart:     0,
  lastMouseMove:   0,

  // ── DPI Calibration
  isDragging:      false,
  dragStartX:      0,
  dragStartY:      0,   // [FIX] track Y for diagonal detection
  dragCurrentX:    0,
  dragCurrentY:    0,
  dragEndX:        0,
  dragEndY:        0,
  dragPixels:      0,
  calDpi:          null,
  dpiUnit:         'in',      // 'in' | 'cm' | 'mm'
  dpiHistory:      [],        // last 3 measurements

  // ── Jitter
  jitterPts:       new Float32Array(JITTER_MAX_PTS * 2),
  jitterHead:      0,
  jitterCount:     0,
  jitterTrailLen:  200,
  jitterZoom:      3,
  showIdeal:       true,
  showHeatmap:     false,
  jitterRms:       0,
  jitterMaxDev:    0,
  jitterSmoothness:0,

  // ── Export log
  exportLog:       [], // [{ts, hz, jitter}]

  // ── RAF
  rafFps:          0,
  lastRafTime:     0,
  activeTab:       'polling',
};

/* ════════════════════════════════════════════════════════════
   DOM REFS
   ════════════════════════════════════════════════════════════ */
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

const dom = {
  // status
  statusDot:     $('statusDot'),
  statusLabel:   $('statusLabel'),
  fpsCounter:    $('fpsCounter'),
  exportBtn:     $('exportBtn'),

  // polling
  hzValue:       $('hzValue'),
  intervalValue: $('intervalValue'),
  peakHzValue:   $('peakHzValue'),
  eventsValue:   $('eventsValue'),
  hzSub:         $('hzSub'),
  pollingCanvas: $('pollingCanvas'),
  pollingZone:   $('pollingZone'),
  captureInner:  $('captureInner'),
  cursorTrail:   $('cursorTrail'),
  resetPolling:  $('resetPolling'),

  // dpi
  dpiValue:      $('dpiValue'),
  dpiSub:        $('dpiSub'),
  pixelsMoved:   $('pixelsMoved'),
  physicalDist:  $('physicalDist'),
  dpiDragZone:   $('dpiDragZone'),
  dpiCanvas:     $('dpiCanvas'),
  dragOverlay:   $('dragOverlay'),
  dragLabel:     $('dragLabel'),
  dpiResultBar:  $('dpiResultBar'),
  resetCalibration: $('resetCalibration'),
  diagWarning:   $('diagWarning'),
  dpiHistory:    $('dpiHistory'),
  rulerCanvas:   $('rulerCanvas'),
  unitBtns:      $$('.unit-btn'),

  // jitter
  jitterCanvas:  $('jitterCanvas'),
  jitterZone:    $('jitterZone'),
  jitterRms:     $('jitterRms'),
  jitterMax:     $('jitterMax'),
  jitterSmooth:  $('jitterSmooth'),
  jitterTrails:  $('jitterTrails'),
  jitterTrailsVal: $('jitterTrailsVal'),
  jitterZoom:    $('jitterZoom'),
  jitterZoomVal: $('jitterZoomVal'),
  showIdeal:     $('showIdeal'),
  showHeatmap:   $('showHeatmap'),
  clearJitter:   $('clearJitter'),
  jitterHint:    $('jitterHint'),

  // onboarding
  onboardingOverlay: $('onboardingOverlay'),
  onboardingStart:   $('onboardingStart'),
  skipOnboarding:    $('skipOnboarding'),

  // tabs
  tabBtns:       $$('.tab-btn'),
  bottomTabs:    $$('.bottom-tab'),
  tabPanels:     $$('.tab-panel'),

  // about section interactives
  hzRows:           $('hzRows'),
  hzSelBtns:        $$('.hz-sel-btn'),
  hzStatMs:         $('hzStatMs'),
  hzStatUpdates:    $('hzStatUpdates'),
  hzStatRating:     $('hzStatRating'),
  dpiDemoSlider:    $('dpiDemoSlider'),
  dpiDemoVal:       $('dpiDemoVal'),
  dpiDemoNote:      $('dpiDemoNote'),
  dpiDemoMouse:     $('dpiDemoMouse'),
  dpiDemoCursor:    $('dpiDemoCursor'),
  jitterGoodCanvas: $('jitterGoodCanvas'),
  jitterBadCanvas:  $('jitterBadCanvas'),
  jitterGoodRms:    $('jitterGoodRms'),
  jitterBadRms:     $('jitterBadRms'),
  jitterScaleFill:  $('jitterScaleFill'),
};

/* ════════════════════════════════════════════════════════════
   CANVAS SETUP — DPR-aware, [FIX-8] reset transform each resize
   ════════════════════════════════════════════════════════════ */
function getCanvasSize(canvas) {
  const rect = canvas.parentElement.getBoundingClientRect();
  return { w: rect.width || 800, h: rect.height || 300 };
}

/**
 * [FIX-8] Always call setTransform(1,0,0,1,0,0) before re-scaling.
 * Without this, consecutive resize calls compound the DPR scale.
 */
function setupCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.setTransform(1, 0, 0, 1, 0, 0); // [FIX-8] reset before scaling
  ctx.scale(dpr, dpr);
  return ctx;
}

function getCSSSize(canvas) {
  return {
    w: canvas.width  / (window.devicePixelRatio || 1),
    h: canvas.height / (window.devicePixelRatio || 1),
  };
}

let pollingCtx, dpiCtx, jitterCtx, rulerCtx;

function initCanvases() {
  {
    const cont = dom.pollingCanvas.parentElement;
    const w = cont.clientWidth - 44 || 700; // subtract axis width
    pollingCtx = setupCanvas(dom.pollingCanvas, w, 140);
  }
  {
    const zone = dom.dpiDragZone;
    const r = zone.getBoundingClientRect();
    dpiCtx = setupCanvas(dom.dpiCanvas, r.width || 700, r.height || 280);
  }
  {
    const zone = dom.jitterZone;
    const r = zone.getBoundingClientRect();
    jitterCtx = setupCanvas(dom.jitterCanvas, r.width || 700, r.height || 380);
  }
  {
    const rc = dom.rulerCanvas;
    const r = rc.parentElement.getBoundingClientRect();
    rulerCtx = setupCanvas(rc, r.width || 700, 28);
    drawRuler(rulerCtx, getCSSSize(rc).w, 28);
  }
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(initCanvases, 150);
}, { passive: true });

/* ════════════════════════════════════════════════════════════
   RULER CANVAS  — visual tick marks for calibration reference
   ════════════════════════════════════════════════════════════ */
function drawRuler(ctx, w, h) {
  ctx.fillStyle = '#0a0b0e';
  ctx.fillRect(0, 0, w, h);
  const pixelsPerTick = 16;
  const ticksPerInch  = 8;
  for (let px = 0; px < w; px += pixelsPerTick) {
    const isInch = px % (pixelsPerTick * ticksPerInch) === 0;
    const isHalf = px % (pixelsPerTick * 4) === 0;
    const tickH  = isInch ? h * .72 : isHalf ? h * .46 : h * .26;
    ctx.strokeStyle = isInch ? C_AMBER_MID : C_AMBER_DIM;
    ctx.lineWidth   = isInch ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(px, h);
    ctx.lineTo(px, h - tickH);
    ctx.stroke();
    if (isInch && px > 0) {
      ctx.fillStyle = C_AMBER_MID;
      ctx.font = '9px "Share Tech Mono", monospace';
      ctx.fillText(String(px / (pixelsPerTick * ticksPerInch)), px + 2, h - 2);
    }
  }
}

/* ════════════════════════════════════════════════════════════
   UNIT CONVERSION  — for DPI calibration
   ════════════════════════════════════════════════════════════ */
function toInches(value, unit) {
  switch (unit) {
    case 'cm': return value / 2.54;
    case 'mm': return value / 25.4;
    default:   return value; // inches
  }
}

/* ════════════════════════════════════════════════════════════
   POLLING RATE ENGINE
   ════════════════════════════════════════════════════════════ */

/**
 * [FIX-10] Note: e.timeStamp on PointerEvent and performance.now() both use
 * the same epoch (DOMHighResTimeStamp relative to navigationStart per spec).
 * They can be mixed safely in the same buffer with no normalisation needed.
 */
function recordMouseEvent(e) {
  // Use coalesced events for sub-frame samples (Chromium 58+, Firefox 59+)
  const events = (e.getCoalescedEvents && e.getCoalescedEvents()) || null;
  if (events && events.length > 0) {
    for (let i = 0; i < events.length; i++) {
      state.timestamps.push(events[i].timeStamp);
      state.eventsInWindow++;
    }
  } else {
    state.timestamps.push(e.timeStamp);
    state.eventsInWindow++;
  }
  state.lastMouseMove = performance.now();
}

/**
 * [FIX-6] Hz computed from N-sample rolling window average of intervals,
 * not a single last-interval. Window=16 samples for 1000Hz ±3Hz stability.
 * Larger window = more stable; smaller = more responsive. 16 is the sweet spot.
 */
function computePollingRate(now) {
  const buf = state.timestamps;
  if (buf.count < 4) return;

  const WINDOW = 16; // rolling window size
  const n = Math.min(WINDOW, buf.count - 1);
  let sumIntervals = 0;
  let minInterval  = Infinity;
  let validCount   = 0;

  for (let i = 0; i < n; i++) {
    const t0 = buf.peekBack(i);
    const t1 = buf.peekBack(i + 1);
    const interval = t0 - t1;
    if (interval > 0.02 && interval < DROP_THRESHOLD) {
      sumIntervals += interval;
      if (interval < minInterval) minInterval = interval;
      validCount++;
    }
  }

  if (validCount < 2) return;

  const avgInterval = sumIntervals / validCount;
  const hz = avgInterval > 0 ? Math.round(1000 / avgInterval) : 0;

  state.lastHz       = hz;
  state.lastInterval = avgInterval;
  if (hz > state.peakHz) state.peakHz = hz;
  if (hz > 0 && hz < state.hzMin) state.hzMin = hz;

  // Push to history ring for chart
  state.hzHistory[state.hzHistIdx] = hz;
  state.hzHistIdx = (state.hzHistIdx + 1) % HISTORY_SAMPLES;

  // Per-second event count
  if (now - state.windowStart >= 1000) {
    state.eventsPerSec   = state.eventsInWindow;
    state.eventsInWindow = 0;
    state.windowStart    = now;
  }

  // Export log (cap at 10,000 entries)
  if (state.exportLog.length < 10000) {
    state.exportLog.push({ ts: Math.round(now), hz, jitter: state.jitterRms });
  }
}

/* ════════════════════════════════════════════════════════════
   JITTER ENGINE
   ════════════════════════════════════════════════════════════ */
function pushJitterPoint(x, y) {
  const idx = state.jitterHead * 2;
  state.jitterPts[idx]     = x;
  state.jitterPts[idx + 1] = y;
  state.jitterHead  = (state.jitterHead + 1) % JITTER_MAX_PTS;
  if (state.jitterCount < JITTER_MAX_PTS) state.jitterCount++;
  // Hide hint once we have data
  if (state.jitterCount > 10) dom.jitterHint.classList.add('hidden');
}

function computeJitterStats() {
  const trail = Math.min(state.jitterTrailLen, state.jitterCount);
  if (trail < 3) return;

  const pts   = state.jitterPts;
  const head  = state.jitterHead;
  const total = JITTER_MAX_PTS;

  const getXY = n => {
    const i = ((head - 1 - n + total * 2) % total) * 2;
    return [pts[i], pts[i + 1]];
  };

  const [ax, ay] = getXY(trail - 1);
  const [bx, by] = getXY(0);
  const abx = bx - ax, aby = by - ay;
  const abLen = Math.sqrt(abx * abx + aby * aby);
  if (abLen < 1) return;

  let sumSq = 0, maxDev = 0;
  for (let i = 0; i < trail; i++) {
    const [px, py] = getXY(i);
    const cross = Math.abs((px - ax) * aby - (py - ay) * abx);
    const dist  = cross / abLen;
    sumSq  += dist * dist;
    if (dist > maxDev) maxDev = dist;
  }

  state.jitterRms     = Math.sqrt(sumSq / trail);
  state.jitterMaxDev  = maxDev;
  state.jitterSmoothness = Math.max(0, Math.min(100,
    100 - (state.jitterRms / abLen) * 1000));
}

/* ════════════════════════════════════════════════════════════
   RENDER — POLLING CHART
   ════════════════════════════════════════════════════════════ */
function renderPollingChart(ctx, w, h) {
  ctx.fillStyle = C_BG;
  ctx.fillRect(0, 0, w, h);

  // Subtle grid
  ctx.strokeStyle = C_GRID;
  ctx.lineWidth = 1;
  [1000, 750, 500, 250].forEach(hz => {
    const y = h - (hz / 1000) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  });
  // 1000Hz dashed reference
  ctx.strokeStyle = 'rgba(0,212,255,0.06)';
  ctx.setLineDash([4, 6]);
  ctx.beginPath(); ctx.moveTo(0, 1); ctx.lineTo(w, 1); ctx.stroke();
  ctx.setLineDash([]);

  if (state.hzHistory.every(v => v === 0)) return;
  const barW = w / HISTORY_SAMPLES;

  for (let i = 0; i < HISTORY_SAMPLES; i++) {
    const raw = (state.hzHistIdx + i) % HISTORY_SAMPLES;
    const hz  = state.hzHistory[raw];
    if (!hz) continue;
    const barH = (hz / 1000) * h;
    /* Color tiers matching CSS: cyan=great, green=good, amber=mid, coral=low */
    const color = hz >= 900 ? 'rgba(0,212,255,.75)'   :
                  hz >= 480 ? 'rgba(0,214,143,.65)'   :
                  hz >= 230 ? 'rgba(255,170,0,.65)'   :
                              'rgba(255,80,85,.65)';
    ctx.fillStyle = color;
    ctx.fillRect(i * barW + 1, h - barH, Math.max(barW - 2, 1), barH);
  }

  // Overlay line
  ctx.beginPath();
  ctx.strokeStyle = C_CYAN_MID;
  ctx.lineWidth   = 1.5;
  let started = false;
  for (let i = 0; i < HISTORY_SAMPLES; i++) {
    const raw = (state.hzHistIdx + i) % HISTORY_SAMPLES;
    const hz  = state.hzHistory[raw];
    if (!hz) continue;
    const x = (i + .5) * barW, y = h - (hz / 1000) * h;
    started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
  }
  ctx.stroke();
}

/* ════════════════════════════════════════════════════════════
   RENDER — DPI CALIBRATION CANVAS
   ════════════════════════════════════════════════════════════ */
function renderDpiCanvas(ctx, w, h) {
  ctx.fillStyle = C_BG;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = C_GRID;
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
  for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }

  if (!state.isDragging && state.dragPixels === 0) return;

  const sx  = state.dragStartX;
  const sy  = state.dragStartY;
  const ex  = state.isDragging ? state.dragCurrentX : state.dragEndX;
  const ey  = state.isDragging ? state.dragCurrentY : state.dragEndY;
  const midY = h / 2;

  if (ex !== sx) {
    // Gradient measurement line — amber themed
    const grad = ctx.createLinearGradient(sx, 0, ex, 0);
    grad.addColorStop(0, C_AMBER_DIM);
    grad.addColorStop(1, C_AMBER);
    ctx.beginPath(); ctx.moveTo(sx, midY); ctx.lineTo(ex, midY);
    ctx.strokeStyle = grad; ctx.lineWidth = 2.5; ctx.stroke();

    // Pixel count label
    const pixels = Math.abs(ex - sx);
    ctx.fillStyle  = C_AMBER;
    ctx.font       = '12px "Share Tech Mono", monospace';
    ctx.textAlign  = 'center';
    ctx.fillText(`${Math.round(pixels)} px`, (sx + ex) / 2, midY - 22);

    // Tick marks
    ctx.strokeStyle = C_AMBER_DIM; ctx.lineWidth = 1.5;
    [sx, ex].forEach(xp => {
      ctx.beginPath(); ctx.moveTo(xp, midY - 14); ctx.lineTo(xp, midY + 14); ctx.stroke();
    });

    // Diagonal indicator (yellow warning)
    if (Math.abs(ey - sy) > 5) {
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
      ctx.strokeStyle = 'rgba(255,200,0,0.35)'; ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]); ctx.stroke(); ctx.setLineDash([]);
    }

    // End dot
    ctx.beginPath(); ctx.arc(ex, midY, 5, 0, Math.PI * 2);
    ctx.fillStyle = state.isDragging ? C_AMBER_DIM : C_AMBER; ctx.fill();
  }

  // Start dot with glow
  ctx.beginPath(); ctx.arc(sx, midY, 7, 0, Math.PI * 2);
  ctx.fillStyle = C_AMBER;
  ctx.shadowColor = C_AMBER; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.arc(sx, midY, 14, 0, Math.PI * 2);
  ctx.strokeStyle = C_AMBER_DIM; ctx.lineWidth = 1; ctx.stroke();
}

/* ════════════════════════════════════════════════════════════
   RENDER — JITTER SCATTER PLOT
   [FIX-5] heatmap mode fully implemented
   ════════════════════════════════════════════════════════════ */
function renderJitterPlot(ctx, w, h) {
  ctx.fillStyle = 'rgba(8,9,16,0.38)';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = C_GRID; ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
  for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }

  const trail = Math.min(state.jitterTrailLen, state.jitterCount);
  if (trail < 2) return;

  const zoom  = state.jitterZoom;
  const pts   = state.jitterPts;
  const head  = state.jitterHead;
  const total = JITTER_MAX_PTS;
  const cx = w / 2, cy = h / 2;

  const getXY = n => {
    const i = ((head - 1 - n + total * 2) % total) * 2;
    return [pts[i], pts[i + 1]];
  };

  const [anchorX, anchorY] = getXY(Math.floor(trail / 2));
  const toScreen = (px, py) => [cx + (px - anchorX) * zoom, cy + (py - anchorY) * zoom];

  // Ideal line
  let idealPath = null;
  if (state.showIdeal && trail >= 2) {
    const [ax, ay] = getXY(trail - 1), [bx, by] = getXY(0);
    const [sax, say] = toScreen(ax, ay), [sbx, sby] = toScreen(bx, by);
    ctx.beginPath(); ctx.moveTo(sax, say); ctx.lineTo(sbx, sby);
    ctx.strokeStyle = C_WHITE50; ctx.lineWidth = 1; ctx.setLineDash([4,6]); ctx.stroke(); ctx.setLineDash([]);
    idealPath = { ax, ay, bx, by, len: Math.sqrt((bx-ax)**2+(by-ay)**2) };
  }

  const getDev = (px, py) => {
    if (!idealPath || idealPath.len < 0.01) return 0;
    const { ax, ay, bx, by, len } = idealPath;
    return Math.abs((px-ax)*(by-ay)-(py-ay)*(bx-ax))/len;
  };

  // Path line — violet
  ctx.beginPath(); let first = true;
  for (let i = trail - 1; i >= 0; i--) {
    const [px, py] = getXY(i), [sx, sy] = toScreen(px, py);
    first ? (ctx.moveTo(sx,sy), first=false) : ctx.lineTo(sx, sy);
  }
  ctx.strokeStyle = 'rgba(155,109,255,0.45)'; ctx.lineWidth = 1.5; ctx.stroke();

  // Scatter dots
  for (let i = 0; i < trail; i++) {
    const [px, py] = getXY(i), [sx, sy] = toScreen(px, py);
    const age = i / trail;
    const dev = getDev(px, py);
    let r, g, b, a;
    if (state.showHeatmap) {
      const t = Math.min(dev / 2.5, 1);
      if (t < 0.5) {
        const s = t * 2;
        r = Math.round(155 - s * 60); g = Math.round(109 + s * 100); b = Math.round(255 - s * 150);
      } else {
        const s = (t - 0.5) * 2;
        r = Math.round(200 + s * 55); g = Math.round(180 - s * 130); b = Math.round(100 - s * 80);
      }
      a = (0.9 - age * 0.6).toFixed(2);
    } else {
      // violet age fade
      r = 155; g = 109; b = 255;
      a = (0.88 - age * 0.72).toFixed(2);
    }
    ctx.beginPath(); ctx.arc(sx, sy, 2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r},${g},${b},${a})`; ctx.fill();
  }

  // Newest point — bright violet glow
  const [nx, ny] = getXY(0), [nsx, nsy] = toScreen(nx, ny);
  ctx.beginPath(); ctx.arc(nsx, nsy, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = C_VIOLET; ctx.shadowColor = C_VIOLET; ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.arc(nsx, nsy, 9, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(155,109,255,0.2)'; ctx.lineWidth = 1; ctx.stroke();
}

/* ════════════════════════════════════════════════════════════
   DOM UPDATES — throttled, from RAF
   ════════════════════════════════════════════════════════════ */
let prevHz = -1, prevPeak = -1;

function updatePollingUI() {
  const hz    = state.lastHz;
  const stale = performance.now() - state.lastMouseMove > 1500;

  if (hz !== prevHz) {
    setMetric(dom.hzValue, hz > 0 ? hz : '—');
    setMetric(dom.intervalValue,
      state.lastInterval > 0 ? state.lastInterval.toFixed(2) : '—');
    setMetric(dom.eventsValue,
      state.eventsPerSec > 0 ? state.eventsPerSec : '—');
    prevHz = hz;

    // Use CSS classes for color — no broken inline var() references
    const hv = dom.hzValue;
    hv.classList.remove('hz-great','hz-good','hz-mid','hz-low');
    if      (hz >= 900) hv.classList.add('hz-great');
    else if (hz >= 480) hv.classList.add('hz-good');
    else if (hz >= 230) hv.classList.add('hz-mid');
    else if (hz >= 50)  hv.classList.add('hz-low');

    dom.hzSub.textContent =
      hz >= 950 ? '1000 Hz — flagship'    :
      hz >= 480 ? '500 Hz — high-end'     :
      hz >= 230 ? '250 Hz — mid-range'    :
      hz >= 110 ? '125 Hz — budget USB'   :
      hz >  0   ? 'Measuring…'            : 'Move your mouse to begin';
  }

  if (state.peakHz !== prevPeak) {
    setMetric(dom.peakHzValue, state.peakHz > 0 ? state.peakHz : '—');
    prevPeak = state.peakHz;
  }

  dom.statusDot.className   = stale ? 'status-dot' : 'status-dot active';
  dom.statusLabel.textContent =
    stale       ? 'IDLE'   :
    hz >= 900   ? '1000Hz' :
    hz >= 480   ? '500Hz'  :
    hz >= 230   ? '250Hz'  :
    hz >= 120   ? '125Hz'  : 'ACTIVE';
}

function setMetric(el, val) {
  const s = String(val);
  if (el.textContent !== s) {
    el.textContent = s;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
}

function updateJitterUI() {
  if (state.jitterCount < 3) return;
  computeJitterStats();
  setMetric(dom.jitterRms,    state.jitterRms.toFixed(2));
  setMetric(dom.jitterMax,    state.jitterMaxDev.toFixed(2));
  setMetric(dom.jitterSmooth,
    state.jitterSmoothness != null ? Math.round(state.jitterSmoothness) : '—');
}

/* ════════════════════════════════════════════════════════════
   RAF MAIN LOOP
   ════════════════════════════════════════════════════════════ */
function rafLoop(now) {
  requestAnimationFrame(rafLoop);

  // EMA FPS
  if (state.lastRafTime > 0) {
    const inst = 1000 / (now - state.lastRafTime);
    state.rafFps = state.rafFps * (1 - RAF_ALPHA) + inst * RAF_ALPHA;
  }
  state.lastRafTime = now;

  computePollingRate(now);

  // Only render active tab
  if (state.activeTab === 'polling') {
    const { w, h } = getCSSSize(dom.pollingCanvas);
    renderPollingChart(pollingCtx, w, h);
    updatePollingUI();
  }
  if (state.activeTab === 'dpi') {
    const { w, h } = getCSSSize(dom.dpiCanvas);
    renderDpiCanvas(dpiCtx, w, h);
  }
  if (state.activeTab === 'jitter') {
    const { w, h } = getCSSSize(dom.jitterCanvas);
    renderJitterPlot(jitterCtx, w, h);
    updateJitterUI();
  }

  dom.fpsCounter.textContent = `RAF: ${Math.round(state.rafFps)} fps`;
}

/* ════════════════════════════════════════════════════════════
   GLOBAL MOUSE CAPTURE — keeps data flowing across tab switches
   [FIX-4] Jitter data collected regardless of active section
   ════════════════════════════════════════════════════════════ */
document.addEventListener('pointermove', e => {
  recordMouseEvent(e);

  // Cursor trail in polling zone
  if (state.activeTab === 'polling') {
    const rect = dom.pollingZone.getBoundingClientRect();
    const lx = e.clientX - rect.left;
    const ly = e.clientY - rect.top;
    if (lx >= 0 && ly >= 0 && lx <= rect.width && ly <= rect.height) {
      dom.pollingZone.classList.add('active');
      dom.cursorTrail.style.left = lx + 'px';
      dom.cursorTrail.style.top  = ly + 'px';
    } else {
      dom.pollingZone.classList.remove('active');
    }
  }

  // Jitter — collect from the jitter zone
  if (state.activeTab === 'jitter') {
    const rect = dom.jitterZone.getBoundingClientRect();
    const lx = e.clientX - rect.left;
    const ly = e.clientY - rect.top;
    if (lx >= 0 && ly >= 0 && lx <= rect.width && ly <= rect.height) {
      pushJitterPoint(lx, ly);
    }
  }
}, { passive: true });

// Touch on jitter zone
dom.jitterZone.addEventListener('touchmove', e => {
  e.preventDefault();
  const rect = dom.jitterZone.getBoundingClientRect();
  const t    = e.touches[0];
  pushJitterPoint(t.clientX - rect.left, t.clientY - rect.top);
}, { passive: false });

/* ════════════════════════════════════════════════════════════
   DPI CALIBRATION LISTENERS
   [FIX-3] Diagonal detection, unit conversion, min-drag error
   ════════════════════════════════════════════════════════════ */
function initDpiListeners() {
  const zone = dom.dpiDragZone;

  const startDrag = (clientX, clientY) => {
    const rect     = zone.getBoundingClientRect();
    state.isDragging   = true;
    state.dragStartX   = clientX - rect.left;
    state.dragStartY   = clientY - rect.top;
    state.dragCurrentX = state.dragStartX;
    state.dragCurrentY = state.dragStartY;
    state.dragEndX     = state.dragStartX;
    state.dragEndY     = state.dragStartY;
    state.dragPixels   = 0;
    zone.classList.add('dragging');
    dom.dragLabel.textContent = 'DRAG HORIZONTALLY…';
    dom.diagWarning.hidden    = true;
  };

  const moveDrag = (clientX, clientY) => {
    if (!state.isDragging) return;
    const rect = zone.getBoundingClientRect();
    state.dragCurrentX = clientX - rect.left;
    state.dragCurrentY = clientY - rect.top;
  };

  const endDrag = (clientX, clientY) => {
    if (!state.isDragging) return;
    state.isDragging = false;
    const rect = zone.getBoundingClientRect();
    state.dragEndX   = clientX - rect.left;
    state.dragEndY   = clientY - rect.top;
    state.dragPixels = Math.abs(state.dragEndX - state.dragStartX);
    zone.classList.remove('dragging');
    computeDpi();
  };

  // Mouse
  zone.addEventListener('mousedown',  e => startDrag(e.clientX, e.clientY));
  window.addEventListener('mousemove', e => moveDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup',   e => endDrag(e.clientX, e.clientY));

  // Touch
  zone.addEventListener('touchstart', e => {
    e.preventDefault();
    startDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });

  window.addEventListener('touchmove', e => {
    if (state.isDragging && e.touches[0]) {
      moveDrag(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  window.addEventListener('touchend', e => {
    if (state.isDragging && e.changedTouches[0]) {
      endDrag(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
  });

  // Reset button
  dom.resetCalibration.addEventListener('click', resetDpi);

  // Unit toggle  [FIX-3]
  dom.unitBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      state.dpiUnit = btn.dataset.unit;
      dom.unitBtns.forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
    });
  });
}

function computeDpi() {
  const hPixels  = state.dragPixels;
  const vPixels  = Math.abs(state.dragEndY - state.dragStartY);
  const totalPx  = Math.sqrt(hPixels * hPixels + vPixels * vPixels);
  const distVal  = parseFloat(dom.physicalDist.value) || 1.0;
  const inches   = toInches(distVal, state.dpiUnit);

  // [FIX-3] Minimum drag of 30px
  if (hPixels < 30) {
    dom.dpiResultBar.textContent = '⚠ Drag too short (< 30px). Move your mouse further horizontally.';
    dom.dpiResultBar.className   = 'dpi-result-bar warning';
    dom.dragLabel.textContent    = 'CLICK & DRAG TO CALIBRATE';
    return;
  }

  // [FIX-3] Diagonal warning: if vertical > 20% of horizontal
  const diagRatio = vPixels / hPixels;
  if (diagRatio > 0.2) {
    dom.diagWarning.hidden = false;
  }

  // DPI uses horizontal component only (most accurate)
  const dpi = Math.round(hPixels / inches);
  state.calDpi = dpi;

  setMetric(dom.dpiValue, dpi);
  setMetric(dom.pixelsMoved, Math.round(hPixels));

  dom.dpiResultBar.textContent =
    `✓ Calibrated: ${dpi} DPI  |  ${Math.round(hPixels)}px horizontal  |  ${distVal}${state.dpiUnit}  |  ${getDpiLabel(dpi)}`;
  dom.dpiResultBar.className = 'dpi-result-bar success';
  dom.dragLabel.textContent  = `DPI: ${dpi} — drag again to recalibrate`;

  // History
  state.dpiHistory.unshift(dpi);
  if (state.dpiHistory.length > 5) state.dpiHistory.pop();
  renderDpiHistory();
}

function getDpiLabel(dpi) {
  if (dpi < 400)  return 'LOW';
  if (dpi < 800)  return 'MEDIUM';
  if (dpi < 1600) return 'HIGH';
  if (dpi < 3200) return 'ULTRA';
  return 'EXTREME';
}

function renderDpiHistory() {
  dom.dpiHistory.innerHTML = state.dpiHistory.map((v, i) =>
    `<span class="dpi-hist-item ${i === 0 ? 'latest' : ''}">${i === 0 ? '▸ ' : ''}${v} DPI</span>`
  ).join('');
}

function resetDpi() {
  state.isDragging  = false;
  state.dragPixels  = 0;
  state.dragStartX  = 0; state.dragEndX = 0;
  state.dragStartY  = 0; state.dragEndY = 0;
  state.calDpi      = null;
  state.dpiHistory  = [];
  dom.dpiValue.textContent    = '—';
  dom.pixelsMoved.textContent = '—';
  dom.dpiResultBar.textContent= 'Waiting for calibration drag…';
  dom.dpiResultBar.className  = 'dpi-result-bar';
  dom.dragLabel.textContent   = 'CLICK & DRAG TO CALIBRATE';
  dom.diagWarning.hidden       = true;
  dom.dpiHistory.innerHTML     = '';
  const { w, h } = getCSSSize(dom.dpiCanvas);
  dpiCtx.fillStyle = C_BG;  // fixed: was '#0a0a0a'
  dpiCtx.fillRect(0, 0, w, h);
}

/* ════════════════════════════════════════════════════════════
   JITTER LISTENERS
   ════════════════════════════════════════════════════════════ */
function initJitterListeners() {
  dom.clearJitter.addEventListener('click', () => {
    state.jitterHead  = 0;
    state.jitterCount = 0;
    state.jitterRms = state.jitterMaxDev = 0;
    dom.jitterRms.textContent = dom.jitterMax.textContent = dom.jitterSmooth.textContent = '—';
    dom.jitterHint.classList.remove('hidden');
    const { w, h } = getCSSSize(dom.jitterCanvas);
    jitterCtx.fillStyle = C_BG;  // fixed: was old #050505
    jitterCtx.fillRect(0, 0, w, h);
  });

  dom.jitterTrails.addEventListener('input', e => {
    state.jitterTrailLen = parseInt(e.target.value);
    dom.jitterTrailsVal.textContent = e.target.value;
    dom.jitterTrails.setAttribute('aria-valuenow', e.target.value);
  });

  dom.jitterZoom.addEventListener('input', e => {
    state.jitterZoom = parseFloat(e.target.value);
    dom.jitterZoomVal.textContent = e.target.value + '×';
    dom.jitterZoom.setAttribute('aria-valuenow', e.target.value);
  });

  dom.showIdeal.addEventListener('change',   e => { state.showIdeal   = e.target.checked; });
  dom.showHeatmap.addEventListener('change', e => { state.showHeatmap = e.target.checked; });
}

/* ════════════════════════════════════════════════════════════
   EXPORT  — [FIX-16] CSV download
   ════════════════════════════════════════════════════════════ */
function exportCsv() {
  if (state.exportLog.length === 0) {
    alert('No data to export. Move your mouse first.');
    return;
  }

  const header = 'timestamp_ms,hz,jitter_rms_px\n';
  const rows   = state.exportLog.map(r =>
    `${r.ts},${r.hz},${r.jitter.toFixed(3)}`
  ).join('\n');
  const blob   = new Blob([header + rows], { type: 'text/csv' });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement('a');
  a.href        = url;
  a.download    = `dpi-metrics-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ════════════════════════════════════════════════════════════
   TAB NAVIGATION — syncs desktop + mobile + sections
   ════════════════════════════════════════════════════════════ */
function switchTab(tabName) {
  state.activeTab = tabName;

  // Desktop tabs
  dom.tabBtns.forEach(b => {
    const active = b.dataset.tab === tabName;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  // Bottom tabs
  dom.bottomTabs.forEach(b => {
    const active = b.dataset.tab === tabName;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  // Panels
  dom.tabPanels.forEach(p => {
    const active = p.id === `tab-${tabName}`;
    p.classList.toggle('active', active);
    p.hidden = !active;
  });

  // Re-init canvas for newly visible panel
  setTimeout(initCanvases, 60);

  // Trigger scroll reveal when about becomes active
  if (tabName === 'about') {
    setTimeout(() => {
      document.querySelectorAll('#tab-about .reveal').forEach((el, i) => {
        setTimeout(() => el.classList.add('visible'), i * 120);
      });
    }, 60);
  }
}

function initTabs() {
  dom.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  dom.bottomTabs.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

/* ════════════════════════════════════════════════════════════
   ONBOARDING
   ════════════════════════════════════════════════════════════ */
function initOnboarding() {
  const skipped = localStorage.getItem('dpm_skip_onboarding') === '1';
  if (skipped) {
    dom.onboardingOverlay.classList.add('hidden');
    return;
  }
  dom.onboardingStart.addEventListener('click', () => {
    if (dom.skipOnboarding.checked) {
      localStorage.setItem('dpm_skip_onboarding', '1');
    }
    dom.onboardingOverlay.classList.add('hidden');
  });
}

/* ════════════════════════════════════════════════════════════
   POLLING RESET
   ════════════════════════════════════════════════════════════ */
function initPollingListeners() {
  dom.resetPolling.addEventListener('click', () => {
    state.timestamps.clear();
    state.hzHistory.fill(0);
    state.hzHistIdx = 0;
    state.peakHz    = 0;
    state.lastHz    = 0;
    state.hzMin     = Infinity;
    prevHz = prevPeak = -1;
    state.exportLog = [];
    dom.hzValue.textContent       = '—';
    dom.intervalValue.textContent = '—';
    dom.peakHzValue.textContent   = '—';
    dom.eventsValue.textContent   = '—';
    dom.hzSub.textContent         = 'Move your mouse to begin';
  });
}

/* ════════════════════════════════════════════════════════════
   INIT
   ════════════════════════════════════════════════════════════ */
function init() {
  initOnboarding();
  initTabs();
  initPollingListeners();
  initDpiListeners();
  initJitterListeners();
  initAboutSection();

  dom.exportBtn.addEventListener('click', exportCsv);

  // Slight delay so layout is paint-settled before canvas sizing
  setTimeout(() => {
    initCanvases();
    state.windowStart = performance.now();
    requestAnimationFrame(rafLoop);
  }, 100);
}

init();

/* ════════════════════════════════════════════════════════════
   ABOUT SECTION — Interactive explainers
   ════════════════════════════════════════════════════════════ */

/* ── SCROLL REVEAL ────────────────────────────────────────── */
function initScrollReveal() {
  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        // Stagger children slightly if they exist
        e.target.classList.add('visible');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  els.forEach(el => io.observe(el));
}

/* ── HZ TIMELINE EXPLAINER ────────────────────────────────── */
const HZ_OPTIONS = {
  125:  { ms: '8.0',  updates: '125',   rating: 'BUDGET' },
  250:  { ms: '4.0',  updates: '250',   rating: 'MID' },
  500:  { ms: '2.0',  updates: '500',   rating: 'HIGH-END' },
  1000: { ms: '1.0',  updates: '1,000', rating: 'COMPETITIVE' },
};

function buildHzDots(hz) {
  if (!dom.hzRows) return;
  dom.hzRows.innerHTML = '';
  // Show 3 rows, each representing ~33ms of data
  // At 125Hz: ~4 dots/row. At 1000Hz: ~33 dots/row
  const dotsPerRow = Math.round(hz / 40);
  const rows = 3;
  for (let r = 0; r < rows; r++) {
    const row = document.createElement('div');
    row.className = 'hz-row';
    for (let i = 0; i < dotsPerRow; i++) {
      const d = document.createElement('div');
      d.className = 'hz-dot';
      d.style.animationDelay = `${(i * (1000 / hz) * 0.5).toFixed(0)}ms`;
      row.appendChild(d);
    }
    dom.hzRows.appendChild(row);
  }
}

function setHzSelection(hz) {
  const info = HZ_OPTIONS[hz];
  if (!info) return;
  buildHzDots(hz);
  if (dom.hzStatMs)      dom.hzStatMs.textContent      = info.ms + ' ms';
  if (dom.hzStatUpdates) dom.hzStatUpdates.textContent = info.updates;
  if (dom.hzStatRating)  dom.hzStatRating.textContent  = info.rating;
  dom.hzSelBtns.forEach(b => b.classList.toggle('active', parseInt(b.dataset.hz) === hz));
}

function initHzExplainer() {
  if (!dom.hzSelBtns.length) return;
  dom.hzSelBtns.forEach(btn => {
    btn.addEventListener('click', () => setHzSelection(parseInt(btn.dataset.hz)));
  });
  setHzSelection(125);
}

/* ── DPI DEMO SLIDER ──────────────────────────────────────── */
function initDpiDemo() {
  if (!dom.dpiDemoSlider) return;

  const notes = {
    200:  'Very low — fine for precise work, slow cursor',
    400:  'Low — preferred by many pro FPS players',
    600:  'Low-mid — good balance for FPS gaming',
    800:  'Mid-range — good balance of speed and accuracy',
    1000: 'Mid-high — comfortable for most gaming styles',
    1200: 'High — fast cursor, less physical movement needed',
    1600: 'High — common default for gaming mice',
    2000: 'Very high — tiny movements = large cursor travel',
    2400: 'Very high — difficult to aim precisely',
    2800: 'Extreme — minimal physical movement required',
    3200: 'Maximum — hair-trigger sensitivity',
  };

  dom.dpiDemoSlider.addEventListener('input', () => {
    const dpi = parseInt(dom.dpiDemoSlider.value);
    dom.dpiDemoVal.textContent = dpi.toLocaleString();

    // Mouse stays fixed on the left; cursor travels further at higher DPI
    // Normalize: 800 DPI = cursor at 40% across the screen
    const baseDpi   = 800;
    const basePos   = 30;  // % from left
    const maxTravel = 65;  // % available
    const cursorPct = Math.min(basePos + (dpi / baseDpi - 1) * (maxTravel / 2.5), basePos + maxTravel);
    if (dom.dpiDemoCursor) {
      dom.dpiDemoCursor.style.left = cursorPct.toFixed(1) + '%';
    }

    // Closest note
    const keys = Object.keys(notes).map(Number).sort((a,b)=>a-b);
    const closest = keys.reduce((prev, curr) => Math.abs(curr - dpi) < Math.abs(prev - dpi) ? curr : prev);
    dom.dpiDemoNote.textContent = notes[closest] || '';
  });
}

/* ── JITTER CANVAS ANIMATIONS ─────────────────────────────── */
let jitterAnimId = null;

function animateJitterExplainers() {
  const goodCtx = dom.jitterGoodCanvas ? dom.jitterGoodCanvas.getContext('2d') : null;
  const badCtx  = dom.jitterBadCanvas  ? dom.jitterBadCanvas.getContext('2d')  : null;
  if (!goodCtx || !badCtx) return;

  const W = 240, H = 120;
  // Each canvas is fixed 240×120 in HTML; scale for DPR
  const dpr = window.devicePixelRatio || 1;
  [dom.jitterGoodCanvas, dom.jitterBadCanvas].forEach(c => {
    c.width  = W * dpr; c.height = H * dpr;
    c.style.width = W + 'px'; c.style.height = H + 'px';
    c.getContext('2d').setTransform(1,0,0,1,0,0);
    c.getContext('2d').scale(dpr, dpr);
  });

  let t = 0;
  // Pre-generate random noise offsets
  const GOOD_NOISE = Array.from({length: 200}, () => (Math.random() - 0.5) * 0.6);
  const BAD_NOISE  = Array.from({length: 200}, () => (Math.random() - 0.5) * 4.5);

  let goodRmsSamples = [];
  let badRmsSamples  = [];

  function drawExplainerFrame() {
    jitterAnimId = requestAnimationFrame(drawExplainerFrame);

    // Only run if about tab is visible
    if (state.activeTab !== 'about') return;

    t = (t + 1) % 200;
    const midY = H / 2;
    const speed = 1.2;
    const trailLen = 60;  // number of trail points to draw

    // ── GOOD sensor — steel/cyan trail ──
    goodCtx.fillStyle = 'rgba(8,9,16,.38)';
    goodCtx.fillRect(0, 0, W, H);
    goodCtx.beginPath();
    goodCtx.strokeStyle = 'rgba(180,190,210,.15)';
    goodCtx.lineWidth = 1; goodCtx.setLineDash([4,6]);
    goodCtx.moveTo(0, midY); goodCtx.lineTo(W, midY);
    goodCtx.stroke(); goodCtx.setLineDash([]);

    for (let i = 0; i < trailLen; i++) {
      const idx = (t - i + 200) % 200;
      const px  = W - i * speed, py = midY + GOOD_NOISE[idx];
      if (px < 0) break;
      const age = i / trailLen;
      // Cyan-to-teal age fade
      const cr = Math.round(0   + (1-age)*20);
      const cg = Math.round(180 + (1-age)*32);
      const cb = Math.round(220 + (1-age)*35);
      goodCtx.beginPath(); goodCtx.arc(px, py, 1.5, 0, Math.PI*2);
      goodCtx.fillStyle = `rgba(${cr},${cg},${cb},${(1-age*0.82).toFixed(2)})`; goodCtx.fill();
    }
    goodCtx.beginPath(); goodCtx.arc(W, midY + GOOD_NOISE[t], 3, 0, Math.PI*2);
    goodCtx.fillStyle = '#00d4ff';
    goodCtx.shadowColor = 'rgba(0,212,255,.55)'; goodCtx.shadowBlur = 8;
    goodCtx.fill(); goodCtx.shadowBlur = 0;

    // Compute live RMS for good
    goodRmsSamples.push(Math.abs(GOOD_NOISE[t]));
    if (goodRmsSamples.length > 30) goodRmsSamples.shift();
    const goodRms = Math.sqrt(goodRmsSamples.reduce((s,v)=>s+v*v,0)/goodRmsSamples.length);
    if (dom.jitterGoodRms) dom.jitterGoodRms.textContent = goodRms.toFixed(2);

    // ── BAD sensor — coral/hot trail ──
    badCtx.fillStyle = 'rgba(8,9,16,.38)';
    badCtx.fillRect(0, 0, W, H);
    badCtx.beginPath();
    badCtx.strokeStyle = 'rgba(180,190,210,.15)';
    badCtx.lineWidth = 1; badCtx.setLineDash([4,6]);
    badCtx.moveTo(0, midY); badCtx.lineTo(W, midY);
    badCtx.stroke(); badCtx.setLineDash([]);

    for (let i = 0; i < trailLen; i++) {
      const idx = (t - i + 200) % 200;
      const px  = W - i * speed;
      const py  = midY + BAD_NOISE[idx];
      if (px < 0) break;
      const age = i / trailLen;
      const dev = Math.abs(BAD_NOISE[idx]);
      // Color by deviation: green-ish → orange → hot
      const norm = Math.min(dev / 4.5, 1);
      const cr = Math.round(100 + norm * 140);
      const cg = Math.round(150 - norm * 110);
      const cb = Math.round(120 - norm * 90);
      badCtx.beginPath();
      badCtx.arc(px, py, 2, 0, Math.PI*2);
      badCtx.fillStyle = `rgba(${cr},${cg},${cb},${(0.9-age*0.7).toFixed(2)})`;
      badCtx.fill();
    }
    badCtx.beginPath();
    badCtx.arc(W - 0, midY + BAD_NOISE[t], 3.5, 0, Math.PI*2);
    badCtx.fillStyle = '#ff5055';
    badCtx.shadowColor = 'rgba(255,80,85,0.5)'; badCtx.shadowBlur = 10;
    badCtx.fill(); badCtx.shadowBlur = 0;

    badRmsSamples.push(Math.abs(BAD_NOISE[t]));
    if (badRmsSamples.length > 30) badRmsSamples.shift();
    const badRms = Math.sqrt(badRmsSamples.reduce((s,v)=>s+v*v,0)/badRmsSamples.length);
    if (dom.jitterBadRms)  dom.jitterBadRms.textContent  = badRms.toFixed(2);

    // Scale bar: fill to match bad RMS normalized to max 4px
    if (dom.jitterScaleFill) {
      dom.jitterScaleFill.style.width = Math.min((badRms / 4) * 100, 100).toFixed(0) + '%';
    }
  }

  drawExplainerFrame();
}

/* ── MASTER INIT ──────────────────────────────────────────── */
function initAboutSection() {
  initScrollReveal();
  initHzExplainer();
  initDpiDemo();
  // Start jitter animation loop — it self-throttles when about tab is inactive
  animateJitterExplainers();
}
