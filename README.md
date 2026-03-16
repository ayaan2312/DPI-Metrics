# DPI Metrics

**Real-time mouse polling rate, DPI calibration & sensor jitter analyzer**

OLED-dark, gamer-focused browser tool. Zero frameworks. Pure Vanilla JS + Canvas API.

---

## File Structure

```
dpi-metrics/
├── index.html     → App shell, semantic HTML5
├── styles.css     → OLED theme, CSS Grid/Flexbox layout
├── app.js         → Core engine: CircularBuffer, RAF loop, Canvas renderers
├── vercel.json    → Vercel static deployment config with optimal caching headers
├── .gitignore
└── README.md
```

---

## How It Works

| Component | Technique |
|---|---|
| Polling rate | `getCoalescedEvents()` on PointerEvent → falls back to standard `mousemove` |
| Timestamp precision | `performance.now()` (sub-millisecond, monotonic) |
| Data storage | `CircularBuffer` backed by `Float64Array` — zero GC pressure |
| Main loop | `requestAnimationFrame` — never blocks the main thread |
| Visualization | Canvas 2D API — no DOM-based chart libs |
| DPI calibration | Pixel drag distance ÷ physical inches (user-measured) |
| Jitter | RMS deviation of XY positions from centroid over last N samples |

---

## Deploy to Vercel (Step-by-Step)

### Option A — Vercel CLI (Recommended, ~2 minutes)

**Step 1: Install Vercel CLI**
```bash
npm install -g vercel
```

**Step 2: Login**
```bash
vercel login
# Choose your auth method (GitHub / Google / Email)
```

**Step 3: Deploy**
```bash
cd dpi-metrics
vercel
```

Answer the prompts:
- `Set up and deploy?` → **Y**
- `Which scope?` → Select your account
- `Link to existing project?` → **N**
- `Project name?` → `dpi-metrics` (or anything you like)
- `In which directory is your code?` → `.` (current)
- `Want to override settings?` → **N**

Vercel will output a URL like: `https://dpi-metrics-xxxx.vercel.app`

**Step 4: Promote to production**
```bash
vercel --prod
```

Your permanent URL will be: `https://dpi-metrics.vercel.app`

---

### Option B — GitHub + Vercel Dashboard (No CLI)

**Step 1: Push to GitHub**
```bash
git init
git add .
git commit -m "init: DPI Metrics v1"
gh repo create dpi-metrics --public --push --source=.
# Or manually push to your GitHub account
```

**Step 2: Import on Vercel**
1. Go to [vercel.com/new](https://vercel.com/new)
2. Click **"Import Git Repository"**
3. Select your `dpi-metrics` repo
4. Framework preset: leave as **"Other"** (it's a static site)
5. Root directory: **`.`**
6. Build command: *(leave blank)*
7. Output directory: *(leave blank or `.`)*
8. Click **Deploy**

Done. Vercel auto-deploys on every `git push` after this.

---

### Option C — Vercel CLI One-Shot (No Git)

```bash
npx vercel --prod
```

No git repo needed. Vercel uploads your files directly.

---

## Custom Domain (Optional)

```bash
vercel domains add yourdomain.com
vercel alias set dpi-metrics-xxxx.vercel.app yourdomain.com
```

Or configure in the Vercel dashboard under **Project → Settings → Domains**.

---

## Local Development

No build step needed. Just open the file:

```bash
# macOS
open index.html

# Or use a simple static server for accurate PointerEvent behavior:
npx serve .
# → http://localhost:3000
```

> **Note:** `getCoalescedEvents()` requires a secure context on some browsers. Use `localhost` or HTTPS (Vercel provides this automatically).

---

## Browser Compatibility

| Feature | Chrome | Firefox | Safari | Edge |
|---|---|---|---|---|
| `getCoalescedEvents()` | ✅ 58+ | ✅ 59+ | ❌ fallback | ✅ 79+ |
| `performance.now()` | ✅ | ✅ | ✅ | ✅ |
| Canvas 2D | ✅ | ✅ | ✅ | ✅ |
| ResizeObserver | ✅ | ✅ | ✅ 13.1+ | ✅ |
| PointerEvent | ✅ | ✅ | ✅ 13+ | ✅ |

**Best results:** Chrome or Edge (fullest `getCoalescedEvents` support).

---

## Known Browser Limitations

1. **Event coalescing:** Even with `getCoalescedEvents()`, Chrome timestamps coalesced events at the frame boundary, not actual hardware timestamps. This means measured polling rate may plateau at ~240–250Hz on a 240Hz display even with a 1000Hz mouse. This is a platform-level limitation with no browser workaround. A native app (using Raw Input API on Windows) is required for true 1000Hz verification.

2. **Input throttling:** Some browsers reduce `mousemove` frequency when the tab is not focused or under CPU load. The drop event counter in the stats bar detects this (intervals > 200ms).

3. **DPI calibration accuracy:** Accuracy depends entirely on the precision of the user's physical ruler measurement. The pixel distance itself is measured to float precision via `e.clientX`.

4. **HiDPI displays:** On Retina/HiDPI displays, `clientX/Y` are in CSS pixels, not device pixels. The jitter canvas renders at `devicePixelRatio` for sharpness. DPI calibration measures CSS pixels, which may differ from physical pixels by the DPR factor — but since DPI is measured in the same CSS pixel space as the mouse reports, the ratio remains valid.

---

## Performance Targets

| Metric | Target | How achieved |
|---|---|---|
| RAF loop overhead | < 0.5ms/frame | Typed arrays, no alloc in hot path |
| DOM writes/frame | ≤ 1 per 6 frames | Throttled update counter |
| Memory growth | Zero after init | CircularBuffer pre-allocated |
| First paint | < 100ms | No framework, minimal CSS |
| Canvas frame time | < 2ms | Direct 2D API, no libraries |
