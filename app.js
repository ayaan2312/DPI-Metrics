/**
 * DPI METRICS — app.js
 * ─────────────────────────────────────────────────────────────
 * High-performance mouse analysis engine.
 *
 * Architecture:
 *   • mousemove events → lightweight handler, push to CircularBuffer
 *   • requestAnimationFrame loop → reads buffer, computes metrics, renders
 *   • Canvas API → jitter scatter plot & sparklines (zero DOM thrashing)
 *   • All hot paths avoid GC pressure: typed arrays, pre-allocated objects
 *
 * Browser limitation note:
 *   Browsers batch & coalesce mousemove events to the display refresh rate
 *   on the main thread. getCoalescedEvents() (Chrome/Edge) exposes the raw
 *   intermediate points at the native polling rate. We use it when available,
 *   with a standard fallback. This is the closest we can get to true 1000Hz
 *   measurement without a native app.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/* ════════════════════════════════════════════════════════════
   1. CIRCULAR BUFFER  — fixed-size, zero-allocation ring
   ════════════════════════════════════════════════════════════ */
class CircularBuffer {
  /**
   * @param {number} size  — must be power of two for fast modulo
   */
  constructor(size) {
    this.size  = size;
    this.mask  = size - 1;          // bitmask for mod
    this.buf   = new Float64Array(size);
    this.head  = 0;
    this.count = 0;
  }

  push(value) {
    this.buf[this.head & this.mask] = value;
    this.head = (this.head + 1) & this.mask;
    if (this.count < this.size) this.count++;
  }

  /** Read last N items into a provided Float64Array (avoids alloc) */
  readLast(n, out) {
    const take = Math.min(n, this.count);
    const start = ((this.head - take) + this.size) & this.mask;
    for (let i = 0; i < take; i++) {
      out[i] = this.buf[(start + i) & this.mask];
    }
    return take;
  }

  clear() {
    this.head = 0;
    this.count = 0;
  }

  get last() {
    if (this.count === 0) return 0;
    return this.buf[(this.head - 1 + this.size) & this.mask];
  }
}

/* ════════════════════════════════════════════════════════════
   2. STATE — pre-allocated, no mid-run object creation
   ════════════════════════════════════════════════════════════ */
const BUFFER_SIZE       = 2048;   // must be power of 2
const SPARKLINE_HISTORY = 64;
const JITTER_TRAIL      = 512;

// Timestamp ring: stores performance.now() per raw event
const tsBuffer = new CircularBuffer(BUFFER_SIZE);

// XY position ring for jitter plot
const xBuffer  = new CircularBuffer(BUFFER_SIZE);
const yBuffer  = new CircularBuffer(BUFFER_SIZE);

// Interval ring (ms between events)
const ivBuffer = new CircularBuffer(BUFFER_SIZE);

// Sparkline history rings
const hzHistory      = new CircularBuffer(64);
const jitterHistory  = new CircularBuffer(64);
const latencyHistory = new CircularBuffer(64);

// Scratch arrays (reused every RAF tick, zero alloc)
const scratchIntervals = new Float64Array(512);
const scratchXY        = new Float64Array(JITTER_TRAIL * 2);

// Derived state (plain object, updated in-place)
const metrics = {
  hz:          0,
  hzPeak:      0,
  hzMin:       Infinity,
  jitterRms:   0,
  intervalAvg: 0,
  totalSamples: 0,
  dropEvents:  0,
  consistency: 0,   // 0–100 %
  lastX:       0,
  lastY:       0,
  lastTs:      0,
  isTracking:  false,
};

// Calibration state
const calib = {
  active:      false,
  dragging:    false,
  startX:      0,
  startY:      0,
  endX:        0,
  endY:        0,
  resultDpi:   null,
  acceptedDpi: null,
};

// Jitter plot render config (updated from controls)
const jitterCfg = {
  trail:  200,
  zoom:   8,
  mode:   'scatter',   // 'scatter' | 'heatmap'
};

/* ════════════════════════════════════════════════════════════
   3. DOM REFERENCES
   ════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const dom = {
  trackingZone:     $('trackingZone'),
  zoneCrosshair:    $('zoneCrosshair'),
  zoneCoords:       $('zoneCoords'),

  metricHz:         $('metricHz').querySelector('.val'),
  metricDpi:        $('metricDpi').querySelector('.val'),
  metricJitter:     $('metricJitter').querySelector('.val'),
  metricLatency:    $('metricLatency').querySelector('.val'),

  subHz:            $('subHz'),
  subDpi:           $('subDpi'),
  subJitter:        $('subJitter'),
  dpiBadge:         $('dpiBadge'),

  sparkHz:          $('sparkHz'),
  sparkJitter:      $('sparkJitter'),
  sparkLatency:     $('sparkLatency'),

  statPeak:         $('statPeak'),
  statMin:          $('statMin'),
  statSamples:      $('statSamples'),
  statDrops:        $('statDrops'),
  statConsistency:  $('statConsistency'),
  btnReset:         $('btnReset'),

  statusDot:        $('statusDot'),
  statusLabel:      $('statusLabel'),

  // Calibration
  calibInstructions: $('calibInstructions'),
  calibActive:       $('calibActive'),
  calibResult:       $('calibResult'),
  btnStartCalib:     $('btnStartCalib'),
  btnCancelCalib:    $('btnCancelCalib'),
  btnAcceptCalib:    $('btnAcceptCalib'),
  btnRetryCalib:     $('btnRetryCalib'),
  calibTrackArea:    $('calibTrackArea'),
  calibStart:        $('calibStart'),
  calibEnd:          $('calibEnd'),
  calibLine:         $('calibLine'),
  calibResultValue:  $('calibResultValue'),
  calibResultSub:    $('calibResultSub'),
  rulerInches:       $('rulerInches'),

  // Jitter
  jitterCanvas:     $('jitterCanvas'),
  jOverlayHz:       $('jOverlayHz'),
  jOverlayJitter:   $('jOverlayJitter'),
  trailLength:      $('trailLength'),
  trailLengthVal:   $('trailLengthVal'),
  jitterZoom:       $('jitterZoom'),
  jitterZoomVal:    $('jitterZoomVal'),
  toggleMode:       $('toggleMode'),
  btnClearJitter:   $('btnClearJitter'),

  footerFps:        $('footerFps'),

  sections: {
    dashboard:   $('sec-dashboard'),
    calibration: $('sec-calibration'),
    jitter:      $('sec-jitter'),
  },
  navItems: document.querySelectorAll('.nav-item'),
};

/* ════════════════════════════════════════════════════════════
   4. CANVAS CONTEXTS
   ════════════════════════════════════════════════════════════ */
const ctxSparkHz      = dom.sparkHz.getContext('2d');
const ctxSparkJitter  = dom.sparkJitter.getContext('2d');
const ctxSparkLatency = dom.sparkLatency.getContext('2d');
const ctxJitter       = dom.jitterCanvas.getContext('2d');

/* ════════════════════════════════════════════════════════════
   5. MOUSE EVENT HANDLER
   ════════════════════════════════════════════════════════════ */

/**
 * Raw event handler — designed to be as thin as possible.
 * All heavy computation is deferred to the RAF loop.
 *
 * getCoalescedEvents() workaround:
 *   Standard mousemove fires ~60–120 times/sec even on a 1000Hz mouse
 *   because the browser composites events per display frame.
 *   getCoalescedEvents() (PointerEvent) exposes the intermediate samples.
 *   We use it to reconstruct the actual polling rate.
 */
function handlePointerMove(e) {
  // Use coalesced events if available (Chrome/Edge ~93+)
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : null;

  if (events && events.length > 0) {
    for (let i = 0; i < events.length; i++) {
      const ce = events[i];
      recordEvent(ce.timeStamp, ce.clientX, ce.clientY);
    }
  } else {
    // Fallback: use performance.now() for sub-ms precision
    recordEvent(performance.now(), e.clientX, e.clientY);
  }

  // Update crosshair position directly (skip RAF for visual snappiness)
  const rect = dom.trackingZone.getBoundingClientRect();
  const lx   = e.clientX - rect.left;
  const ly   = e.clientY - rect.top;
  if (lx >= 0 && ly >= 0 && lx <= rect.width && ly <= rect.height) {
    dom.zoneCrosshair.style.left = lx + 'px';
    dom.zoneCrosshair.style.top  = ly + 'px';
    dom.zoneCoords.textContent = `X: ${Math.round(e.clientX)}  Y: ${Math.round(e.clientY)}`;
  }
}

/** @inline — push a single sample into all circular buffers */
function recordEvent(ts, x, y) {
  const prev = metrics.lastTs;

  if (prev > 0) {
    const interval = ts - prev;
    // Sanity-clamp: ignore intervals > 200ms (mouse stopped) or < 0.05ms
    if (interval > 0.05 && interval < 200) {
      ivBuffer.push(interval);
    } else if (interval >= 200) {
      metrics.dropEvents++;
    }
  }

  tsBuffer.push(ts);
  xBuffer.push(x);
  yBuffer.push(y);

  metrics.lastTs = ts;
  metrics.lastX  = x;
  metrics.lastY  = y;
  metrics.totalSamples++;
}

/* ════════════════════════════════════════════════════════════
   6. METRIC COMPUTATION  (runs in RAF, ~16ms budget)
   ════════════════════════════════════════════════════════════ */

/**
 * Compute polling rate from the most recent N intervals.
 * Strategy: take last 64 intervals, compute mean, invert to Hz.
 * This sliding-window approach responds quickly but avoids
 * single-event spikes.
 */
function computeHz() {
  const n = ivBuffer.readLast(64, scratchIntervals);
  if (n < 4) return 0;

  let sum = 0;
  for (let i = 0; i < n; i++) sum += scratchIntervals[i];
  const avgMs = sum / n;
  return avgMs > 0 ? 1000 / avgMs : 0;
}

/**
 * Compute RMS jitter from the last N positions.
 * Jitter = RMS of (distance from centroid) for each point.
 */
function computeJitter() {
  const n = xBuffer.readLast(32, scratchIntervals);
  if (n < 4) return 0;

  // Read Y into second half of scratch (reuse same scratch Float64 but offset)
  const ySlice = new Float64Array(scratchIntervals.buffer, 32 * 8, 32); // view
  yBuffer.readLast(32, ySlice);

  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    cx += scratchIntervals[i];
    cy += ySlice[i];
  }
  cx /= n; cy /= n;

  let rms = 0;
  for (let i = 0; i < n; i++) {
    const dx = scratchIntervals[i] - cx;
    const dy = ySlice[i]           - cy;
    rms += dx * dx + dy * dy;
  }
  return Math.sqrt(rms / n);
}

/**
 * Consistency: percentage of intervals within ±20% of the mean.
 * Higher = more stable polling rate.
 */
function computeConsistency(n) {
  if (n < 8) return 0;
  const count = ivBuffer.readLast(n, scratchIntervals);
  let sum = 0;
  for (let i = 0; i < count; i++) sum += scratchIntervals[i];
  const mean = sum / count;
  const threshold = mean * 0.2;
  let good = 0;
  for (let i = 0; i < count; i++) {
    if (Math.abs(scratchIntervals[i] - mean) <= threshold) good++;
  }
  return (good / count) * 100;
}

/* ════════════════════════════════════════════════════════════
   7. CANVAS RENDERERS
   ════════════════════════════════════════════════════════════ */

/** Draws a single sparkline into a 2D canvas context */
function drawSparkline(ctx, buffer, color, w, h) {
  const n = buffer.readLast(64, scratchIntervals);
  if (n < 2) return;

  ctx.clearRect(0, 0, w, h);

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (scratchIntervals[i] < min) min = scratchIntervals[i];
    if (scratchIntervals[i] > max) max = scratchIntervals[i];
  }
  const range = max - min || 1;

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.shadowColor = color;
  ctx.shadowBlur  = 4;

  for (let i = 0; i < n; i++) {
    const px = (i / (n - 1)) * w;
    const py = h - ((scratchIntervals[i] - min) / range) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Area fill
  ctx.shadowBlur = 0;
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = color.replace(')', ', 0.08)').replace('rgb', 'rgba');
  ctx.fill();
}

/** Draw the main jitter scatter / trail plot */
function drawJitterPlot() {
  const canvas = dom.jitterCanvas;
  const cw = canvas.width;
  const ch = canvas.height;

  ctxJitter.clearRect(0, 0, cw, ch);

  // Background grid
  ctxJitter.strokeStyle = '#1a1a1a';
  ctxJitter.lineWidth   = 1;
  const gridStep = 40;
  ctxJitter.beginPath();
  for (let x = 0; x < cw; x += gridStep) {
    ctxJitter.moveTo(x, 0);
    ctxJitter.lineTo(x, ch);
  }
  for (let y = 0; y < ch; y += gridStep) {
    ctxJitter.moveTo(0, y);
    ctxJitter.lineTo(cw, y);
  }
  ctxJitter.stroke();

  // Center crosshair
  const cx = cw / 2, cy = ch / 2;
  ctxJitter.strokeStyle = '#1e3a3e';
  ctxJitter.lineWidth   = 1;
  ctxJitter.setLineDash([4, 4]);
  ctxJitter.beginPath();
  ctxJitter.moveTo(cx, 0); ctxJitter.lineTo(cx, ch);
  ctxJitter.moveTo(0, cy); ctxJitter.lineTo(cw, cy);
  ctxJitter.stroke();
  ctxJitter.setLineDash([]);

  // Collect XY trail
  const trail = Math.min(jitterCfg.trail, xBuffer.count);
  if (trail < 2) return;

  const xs = new Float64Array(trail);
  const ys = new Float64Array(trail);
  xBuffer.readLast(trail, xs);
  yBuffer.readLast(trail, ys);

  // Compute centroid
  let mx = 0, my = 0;
  for (let i = 0; i < trail; i++) { mx += xs[i]; my += ys[i]; }
  mx /= trail; my /= trail;

  const zoom = jitterCfg.zoom;

  if (jitterCfg.mode === 'scatter') {
    // Draw points oldest→newest, fading in age
    for (let i = 0; i < trail; i++) {
      const age    = i / trail;
      const alpha  = 0.15 + age * 0.85;
      const radius = 1.5 + age * 1.5;
      const dx = (xs[i] - mx) * zoom + cx;
      const dy = (ys[i] - my) * zoom + cy;

      // Color: old = dark teal, recent = cyan
      const r = Math.round(0   + age * 0);
      const g = Math.round(100 + age * 142);
      const b = Math.round(120 + age * 135);

      ctxJitter.beginPath();
      ctxJitter.arc(dx, dy, radius, 0, Math.PI * 2);
      ctxJitter.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
      ctxJitter.fill();
    }

    // Trail line connecting recent 20 points
    const lineN = Math.min(20, trail);
    ctxJitter.beginPath();
    ctxJitter.strokeStyle = 'rgba(0,242,255,0.2)';
    ctxJitter.lineWidth   = 1;
    for (let i = trail - lineN; i < trail; i++) {
      const dx = (xs[i] - mx) * zoom + cx;
      const dy = (ys[i] - my) * zoom + cy;
      i === trail - lineN ? ctxJitter.moveTo(dx, dy) : ctxJitter.lineTo(dx, dy);
    }
    ctxJitter.stroke();
  }

  // Centroid marker
  ctxJitter.beginPath();
  ctxJitter.arc(cx, cy, 4, 0, Math.PI * 2);
  ctxJitter.fillStyle   = 'rgba(255,170,0,0.9)';
  ctxJitter.shadowColor = '#ffaa00';
  ctxJitter.shadowBlur  = 8;
  ctxJitter.fill();
  ctxJitter.shadowBlur  = 0;

  // Radius circles (RMS jitter visualization)
  if (metrics.jitterRms > 0) {
    const rmsR = metrics.jitterRms * zoom;
    ctxJitter.beginPath();
    ctxJitter.arc(cx, cy, rmsR, 0, Math.PI * 2);
    ctxJitter.strokeStyle = 'rgba(0,242,255,0.15)';
    ctxJitter.lineWidth   = 1;
    ctxJitter.setLineDash([3, 5]);
    ctxJitter.stroke();
    ctxJitter.setLineDash([]);
  }

  // Overlay labels
  dom.jOverlayHz.textContent     = `${metrics.hz.toFixed(0)} Hz`;
  dom.jOverlayJitter.textContent = `± ${metrics.jitterRms.toFixed(2)} px`;
}

/* ════════════════════════════════════════════════════════════
   8. RAF MAIN LOOP
   ════════════════════════════════════════════════════════════ */
let rafId         = null;
let lastRafTime   = 0;
let rafFrameCount = 0;
let rafFpsTimer   = 0;
let rafFps        = 0;
// UI update throttle: metrics text updates every ~4 frames (~67ms at 60fps)
// This prevents excessive DOM writes while keeping display snappy
let updateCounter = 0;

function rafLoop(ts) {
  rafId = requestAnimationFrame(rafLoop);

  // FPS counter (for footer display)
  rafFrameCount++;
  if (ts - rafFpsTimer >= 1000) {
    rafFps        = rafFrameCount;
    rafFrameCount = 0;
    rafFpsTimer   = ts;
    dom.footerFps.textContent = `RAF: ${rafFps}fps`;
  }

  // Compute at full RAF rate
  if (ivBuffer.count >= 4) {
    metrics.hz          = computeHz();
    metrics.jitterRms   = computeJitter();
    metrics.intervalAvg = ivBuffer.count > 0 ? (ivBuffer.readLast(8, scratchIntervals), scratchIntervals.slice(0, Math.min(8, ivBuffer.count)).reduce((a,b)=>a+b,0) / Math.min(8, ivBuffer.count)) : 0;
    metrics.consistency = computeConsistency(64);

    if (metrics.hz > metrics.hzPeak)             metrics.hzPeak = metrics.hz;
    if (metrics.hz < metrics.hzMin && metrics.hz > 0) metrics.hzMin  = metrics.hz;

    // Push to sparkline histories once per 4 frames
    if (updateCounter % 4 === 0) {
      hzHistory.push(metrics.hz);
      jitterHistory.push(metrics.jitterRms);
      latencyHistory.push(metrics.intervalAvg);
    }
  }

  // DOM text update: throttled to every 6 frames (~10fps at 60fps)
  // Enough to be readable; avoids triggering layout repeatedly
  if (updateCounter % 6 === 0 && ivBuffer.count >= 4) {
    updateDomMetrics();
  }

  // Sparklines: every 8 frames
  if (updateCounter % 8 === 0) {
    const spW = dom.sparkHz.width;
    const spH = dom.sparkHz.height;
    drawSparkline(ctxSparkHz,      hzHistory,      '#00f2ff', spW, spH);
    drawSparkline(ctxSparkJitter,  jitterHistory,  '#ff2d55', spW, spH);
    drawSparkline(ctxSparkLatency, latencyHistory, '#ffaa00', spW, spH);
  }

  // Jitter canvas: every frame when on that section, else throttled
  const jitterSectionActive = dom.sections.jitter.classList.contains('active');
  if (jitterSectionActive) {
    drawJitterPlot();
  } else if (updateCounter % 16 === 0) {
    // Low-rate background update so it's ready when user switches
    drawJitterPlot();
  }

  updateCounter = (updateCounter + 1) & 255;
}

/** Write computed metrics to DOM — called at throttled rate */
function updateDomMetrics() {
  const hasData = ivBuffer.count >= 4;

  // Polling rate
  if (hasData) {
    dom.metricHz.textContent   = Math.round(metrics.hz);
    dom.metricLatency.textContent = metrics.intervalAvg.toFixed(2);
    dom.statPeak.textContent   = Math.round(metrics.hzPeak);
    dom.statMin.textContent    = metrics.hzMin === Infinity ? '—' : Math.round(metrics.hzMin);
    dom.subHz.textContent      = pollingLabel(metrics.hz);

    // Hz colour feedback
    const hzVal = $('metricHz').querySelector('.val');
    if (metrics.hz >= 900)     hzVal.style.color = 'var(--cyan)';
    else if (metrics.hz >= 450) hzVal.style.color = 'var(--green)';
    else if (metrics.hz >= 200) hzVal.style.color = 'var(--amber)';
    else                        hzVal.style.color = 'var(--red)';
  }

  // Jitter
  if (hasData) {
    dom.metricJitter.textContent = metrics.jitterRms.toFixed(2);
    dom.subJitter.textContent    = jitterLabel(metrics.jitterRms);
  }

  // Sample counts
  dom.statSamples.textContent  = metrics.totalSamples.toLocaleString();
  dom.statDrops.textContent    = metrics.dropEvents;
  dom.statConsistency.textContent = hasData ? metrics.consistency.toFixed(1) + '%' : '—';

  // Status indicator
  if (!metrics.isTracking) {
    setStatus('idle');
  } else if (metrics.hz >= 800) {
    setStatus('active');
  } else if (metrics.hz >= 100) {
    setStatus('warning');
  } else {
    setStatus('error');
  }

  // Live pulse on cards
  $('card-hz').classList.toggle('live', metrics.isTracking);
  $('card-jitter').classList.toggle('live', metrics.isTracking);
  $('card-latency').classList.toggle('live', metrics.isTracking);

  // DPI card
  if (calib.acceptedDpi !== null) {
    dom.metricDpi.textContent   = Math.round(calib.acceptedDpi);
    dom.dpiBadge.textContent    = dpiLabel(calib.acceptedDpi);
    dom.dpiBadge.classList.add('visible');
    $('card-dpi').classList.add('live');
  }
}

/* ════════════════════════════════════════════════════════════
   9. HUMAN-READABLE LABELS
   ════════════════════════════════════════════════════════════ */
function pollingLabel(hz) {
  if (hz >= 950) return '1000Hz — flagship';
  if (hz >= 450) return '500Hz — high-end';
  if (hz >= 220) return '250Hz — standard';
  if (hz >= 110) return '125Hz — budget/USB';
  if (hz > 0)   return 'detecting…';
  return 'waiting for input…';
}

function jitterLabel(rms) {
  if (rms < 0.3) return 'excellent sensor';
  if (rms < 0.8) return 'good quality';
  if (rms < 2.0) return 'average jitter';
  return 'high jitter — check surface';
}

function dpiLabel(dpi) {
  if (dpi < 400)  return 'LOW';
  if (dpi < 800)  return 'MED';
  if (dpi < 1600) return 'HIGH';
  if (dpi < 3200) return 'ULTRA';
  return 'EXTREME';
}

/* ════════════════════════════════════════════════════════════
   10. STATUS / UI HELPERS
   ════════════════════════════════════════════════════════════ */
function setStatus(state) {
  dom.statusDot.className   = 'status-dot ' + (state === 'idle' ? '' : state);
  dom.statusLabel.textContent =
    state === 'active'  ? 'LIVE' :
    state === 'warning' ? 'DEGRADED' :
    state === 'error'   ? 'ERROR' : 'IDLE';
}

function switchSection(name) {
  Object.entries(dom.sections).forEach(([key, el]) => {
    el.classList.toggle('active', key === name);
  });
  dom.navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.section === name);
  });
}

/* ════════════════════════════════════════════════════════════
   11. CALIBRATION LOGIC
   ════════════════════════════════════════════════════════════ */

/**
 * DPI Calibration:
 *   User drags across a known physical distance (e.g. 1 inch on a ruler).
 *   DPI = pixel_distance / physical_distance_in_inches
 *
 * Limitation: we rely on the user's ruler accuracy. Sub-pixel precision
 * is available via e.clientX/Y which are float on HiDPI displays, but
 * the physical inch measurement is the dominant error source.
 */
let calibMouseDown = false;

function startCalibration() {
  calib.active   = true;
  calib.dragging = false;
  dom.calibInstructions.hidden = true;
  dom.calibActive.hidden       = false;
  dom.calibResult.hidden       = true;

  // Reset visual markers
  dom.calibStart.style.display = 'none';
  dom.calibEnd.style.display   = 'none';
  dom.calibLine.style.display  = 'none';
}

function cancelCalibration() {
  calib.active   = false;
  calib.dragging = false;
  calibMouseDown = false;
  dom.calibInstructions.hidden = false;
  dom.calibActive.hidden       = true;
  dom.calibResult.hidden       = true;
}

function finishCalibration(pxDistance) {
  const inches    = parseFloat(dom.rulerInches.value) || 1;
  const dpi       = pxDistance / inches;

  calib.resultDpi = dpi;

  dom.calibActive.hidden       = true;
  dom.calibResult.hidden       = false;
  dom.calibResultValue.textContent = Math.round(dpi) + ' DPI';
  dom.calibResultSub.textContent   =
    `${pxDistance.toFixed(1)}px over ${inches}" → ${dpiLabel(dpi)} sensitivity`;
}

dom.calibTrackArea.addEventListener('pointerdown', e => {
  if (!calib.active) return;
  const rect  = dom.calibTrackArea.getBoundingClientRect();
  calib.startX = e.clientX - rect.left;
  calib.dragging  = true;
  calibMouseDown  = true;

  dom.calibStart.style.left    = calib.startX + 'px';
  dom.calibStart.style.display = 'block';
  dom.calibEnd.style.display   = 'none';
  dom.calibLine.style.display  = 'none';
  dom.calibTrackArea.setPointerCapture(e.pointerId);
});

dom.calibTrackArea.addEventListener('pointermove', e => {
  if (!calib.active || !calib.dragging) return;
  const rect   = dom.calibTrackArea.getBoundingClientRect();
  calib.endX   = e.clientX - rect.left;

  const x1     = Math.min(calib.startX, calib.endX);
  const x2     = Math.max(calib.startX, calib.endX);

  dom.calibEnd.style.left    = calib.endX + 'px';
  dom.calibEnd.style.display = 'block';

  dom.calibLine.style.left   = x1 + 'px';
  dom.calibLine.style.width  = (x2 - x1) + 'px';
  dom.calibLine.style.display = 'block';
});

dom.calibTrackArea.addEventListener('pointerup', e => {
  if (!calib.active || !calib.dragging) return;
  calib.dragging = false;
  calibMouseDown = false;

  const pxDistance = Math.abs(calib.endX - calib.startX);
  if (pxDistance < 10) {
    // Too short to be a valid measurement
    cancelCalibration();
    startCalibration(); // restart
    return;
  }
  finishCalibration(pxDistance);
});

dom.btnStartCalib.addEventListener('click', startCalibration);
dom.btnCancelCalib.addEventListener('click', cancelCalibration);
dom.btnRetryCalib.addEventListener('click', () => {
  dom.calibResult.hidden       = true;
  dom.calibActive.hidden       = false;
  dom.calibStart.style.display = 'none';
  dom.calibEnd.style.display   = 'none';
  dom.calibLine.style.display  = 'none';
  calib.dragging = false;
});
dom.btnAcceptCalib.addEventListener('click', () => {
  calib.acceptedDpi = calib.resultDpi;
  calib.active = false;
  dom.subDpi.textContent = `calibrated via ruler`;
  switchSection('dashboard');
});

/* ════════════════════════════════════════════════════════════
   12. TRACKING ZONE EVENT BINDING
   ════════════════════════════════════════════════════════════ */

// Use PointerEvent for coalesced access + pointer capture
dom.trackingZone.addEventListener('pointerenter', () => {
  metrics.isTracking = true;
  dom.trackingZone.classList.add('tracking');
  setStatus('active');
});

dom.trackingZone.addEventListener('pointerleave', () => {
  metrics.isTracking = false;
  dom.trackingZone.classList.remove('tracking');
  setStatus('idle');
});

dom.trackingZone.addEventListener('pointermove', handlePointerMove, { passive: true });

/* ════════════════════════════════════════════════════════════
   13. JITTER CONTROLS
   ════════════════════════════════════════════════════════════ */
dom.trailLength.addEventListener('input', e => {
  jitterCfg.trail = parseInt(e.target.value);
  dom.trailLengthVal.textContent = jitterCfg.trail;
});
dom.jitterZoom.addEventListener('input', e => {
  jitterCfg.zoom = parseInt(e.target.value);
  dom.jitterZoomVal.textContent  = jitterCfg.zoom + '×';
});
dom.toggleMode.addEventListener('click', () => {
  jitterCfg.mode = jitterCfg.mode === 'scatter' ? 'heatmap' : 'scatter';
  dom.toggleMode.textContent = jitterCfg.mode.toUpperCase();
  dom.toggleMode.classList.toggle('active', true);
});
dom.btnClearJitter.addEventListener('click', () => {
  xBuffer.clear();
  yBuffer.clear();
  ctxJitter.clearRect(0, 0, dom.jitterCanvas.width, dom.jitterCanvas.height);
});

/* ════════════════════════════════════════════════════════════
   14. NAV & RESET
   ════════════════════════════════════════════════════════════ */
dom.navItems.forEach(item => {
  item.addEventListener('click', () => switchSection(item.dataset.section));
});

dom.btnReset.addEventListener('click', () => {
  tsBuffer.clear();
  xBuffer.clear();
  yBuffer.clear();
  ivBuffer.clear();
  hzHistory.clear();
  jitterHistory.clear();
  latencyHistory.clear();

  metrics.hz           = 0;
  metrics.hzPeak       = 0;
  metrics.hzMin        = Infinity;
  metrics.jitterRms    = 0;
  metrics.intervalAvg  = 0;
  metrics.totalSamples = 0;
  metrics.dropEvents   = 0;
  metrics.consistency  = 0;
  metrics.lastTs       = 0;
  metrics.isTracking   = false;

  dom.metricHz.textContent      = '—';
  dom.metricJitter.textContent  = '—';
  dom.metricLatency.textContent = '—';
  dom.statPeak.textContent      = '—';
  dom.statMin.textContent       = '—';
  dom.statSamples.textContent   = '0';
  dom.statDrops.textContent     = '0';
  dom.statConsistency.textContent = '—';
  dom.subHz.textContent         = 'waiting for input…';

  ctxSparkHz.clearRect(0, 0, dom.sparkHz.width, dom.sparkHz.height);
  ctxSparkJitter.clearRect(0, 0, dom.sparkJitter.width, dom.sparkJitter.height);
  ctxSparkLatency.clearRect(0, 0, dom.sparkLatency.width, dom.sparkLatency.height);
  setStatus('idle');
});

/* ════════════════════════════════════════════════════════════
   15. CANVAS RESIZE OBSERVER
   Keeps jitter canvas pixel-perfect across window resize / DPR changes
   ════════════════════════════════════════════════════════════ */
const dpr = window.devicePixelRatio || 1;

function resizeJitterCanvas() {
  const wrapper = dom.jitterCanvas.parentElement;
  const w = wrapper.clientWidth;
  const h = wrapper.clientHeight;
  dom.jitterCanvas.width  = Math.round(w * dpr);
  dom.jitterCanvas.height = Math.round(h * dpr);
  dom.jitterCanvas.style.width  = w + 'px';
  dom.jitterCanvas.style.height = h + 'px';
  ctxJitter.scale(dpr, dpr);
}

const ro = new ResizeObserver(() => {
  resizeJitterCanvas();
});
ro.observe(dom.jitterCanvas.parentElement);

/* Sparkline DPR scaling */
function resizeSparklines() {
  [dom.sparkHz, dom.sparkJitter, dom.sparkLatency].forEach(c => {
    const w = c.parentElement.clientWidth;
    c.width  = Math.round(w * dpr);
    c.height = Math.round(40 * dpr);
    c.style.width  = w + 'px';
    c.style.height = '40px';
  });
}

/* ════════════════════════════════════════════════════════════
   16. BOOT
   ════════════════════════════════════════════════════════════ */
function boot() {
  resizeJitterCanvas();
  resizeSparklines();

  // Scale sparkline contexts for DPR
  [ctxSparkHz, ctxSparkJitter, ctxSparkLatency].forEach(ctx => {
    ctx.scale(dpr, dpr);
  });

  switchSection('dashboard');
  setStatus('idle');

  // Start the loop
  rafId = requestAnimationFrame(rafLoop);

  // Resize sparklines on window resize
  window.addEventListener('resize', () => {
    resizeSparklines();
  }, { passive: true });

  console.info('%c DPI METRICS booted ', 'background:#00f2ff;color:#000;font-weight:bold;font-family:monospace;',
    `\ngetCoalescedEvents: ${typeof PointerEvent !== 'undefined' ? '✓ available' : '✗ fallback'}`
  );
}

boot();
