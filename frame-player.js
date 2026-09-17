const PREFETCH_FRAMES = 100;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// The source film repeats two short duplicate camera passes: one inside
// "The light", the other right at the "The gathering" -> "The horizon"
// exit. Skip only those duplicate ranges at playback time, keeping the
// original WebP assets untouched. Each join point is where the two takes
// have the closest framing, so there's no visible morph/warp/jump — just
// the duplicate pass removed.
const FRAME_CUTS = Object.freeze({
  light: { logicalEnd: 529, sourceResume: 584, removed: 54 },
  gathering: { logicalEnd: 766, sourceResume: 893, removed: 72 },
});
const REMOVED_FRAMES = FRAME_CUTS.light.removed + FRAME_CUTS.gathering.removed;
// Hold the untouched final source frame for ~3.67s so the 46.776s background
// track (music.mp3) always finishes naturally before the visual journey
// settles, instead of getting cut off by a shorter film.
const END_HOLD_FRAMES = 88;

function contentFrameCount(sourceCount) {
  return Math.max(1, sourceCount - REMOVED_FRAMES);
}

function sourceFrameFor(logicalFrame, sourceCount) {
  const contentCount = contentFrameCount(sourceCount);
  if (logicalFrame >= contentCount) return sourceCount - 1;
  if (logicalFrame <= FRAME_CUTS.light.logicalEnd) return logicalFrame;
  if (logicalFrame <= FRAME_CUTS.gathering.logicalEnd)
    return logicalFrame + FRAME_CUTS.light.removed;
  return logicalFrame + REMOVED_FRAMES;
}

// Bounded decoded-frame cache. Eight frames share a WebP sheet, reducing
// request overhead without retaining the whole film in memory.
class FrameSheets {
  constructor(manifest, variant, framesBase, onLoad, onError, options = {}) {
    const { frameScale = 1, prefetchFrames = PREFETCH_FRAMES, maxConcurrentLoads = 8 } = options;
    this.framesBase = framesBase;
    this.manifest = manifest;
    this.variant = variant;
    this.info = manifest.variants[variant];
    this.frameScale = frameScale;
    this.maxConcurrentLoads = maxConcurrentLoads;
    this.perSheet = manifest.columns * manifest.rows;
    this.prefetchSheets = Math.min(
      this.info.sheets,
      Math.ceil(prefetchFrames / this.perSheet),
    );
    // Only used when createImageBitmap supports it (checked in FramePlayer):
    // decoding a whole sheet at native res is columns*rows frames at once,
    // e.g. a 4x2 810x1440 sheet decodes to ~37MB of raster memory. Mobile
    // Safari's per-tab budget can't hold enough cached sheets at that size
    // without crashing the tab, so on touch devices we decode sheets scaled
    // down directly (cheaper than decoding full-res then downscaling).
    this.decodeOptions = frameScale < 1
      ? {
          resizeWidth: Math.round(manifest.columns * this.info.width * frameScale),
          resizeHeight: Math.round(manifest.rows * this.info.height * frameScale),
          resizeQuality: "medium",
        }
      : null;
    this.cache = new Map();
    this.loading = new Map();
    this.failures = new Map();
    this.wanted = [];
    this.bootstrapEnd = 0;
    this.onLoad = onLoad;
    this.onError = onError;
    this.closed = false;
  }

  sheetUrl(index) {
    return `${this.framesBase}/${this.variant}/${String(index).padStart(3, "0")}.webp`;
  }

  bootstrap() {
    this.bootstrapEnd = this.prefetchSheets;
    this.pump();
  }

  clearBootstrap(atSheet) {
    if (atSheet >= this.bootstrapEnd - 1) this.bootstrapEnd = 0;
  }

  keepInCache(index) {
    return this.wanted.includes(index) || index < this.bootstrapEnd;
  }

  focus(sheet, direction = 1) {
    const dir = direction || 1;
    const wanted = [];
    const behind = sheet - dir;
    if (behind >= 0 && behind < this.info.sheets) wanted.push(behind);
    for (let i = 0; i <= this.prefetchSheets; i++) {
      const idx = sheet + i * dir;
      if (idx >= 0 && idx < this.info.sheets) wanted.push(idx);
    }
    if (wanted.join() === this.wanted.join()) return;
    this.wanted = wanted;
    for (const [index, bitmap] of this.cache) {
      if (!this.keepInCache(index)) {
        bitmap.close();
        this.cache.delete(index);
      }
    }
    for (const [index, request] of this.loading) {
      if (!this.keepInCache(index)) request.abort();
    }
    this.pump();
  }

  maxConcurrent() {
    return this.maxConcurrentLoads;
  }

  pump() {
    if (this.closed) return;
    const queue = [...new Set([...this.wanted, ...this.bootstrapIndices()])];
    for (const index of queue) {
      if (this.loading.size >= this.maxConcurrent()) break;
      if (
        this.cache.has(index) ||
        this.loading.has(index) ||
        this.failures.get(index) >= 3
      )
        continue;
      const controller = new AbortController();
      this.loading.set(index, controller);
      this.load(index, controller);
    }
  }

  bootstrapIndices() {
    if (!this.bootstrapEnd) return [];
    return Array.from({ length: this.bootstrapEnd }, (_, index) => index);
  }

  async load(index, controller) {
    let bitmap;
    try {
      const response = await fetch(this.sheetUrl(index), {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Frame sheet ${response.status}`);
      const blob = await response.blob();
      if ("createImageBitmap" in window) {
        bitmap = this.decodeOptions
          ? await createImageBitmap(blob, this.decodeOptions)
          : await createImageBitmap(blob);
      } else {
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.src = url;
        try {
          await image.decode();
        } finally {
          URL.revokeObjectURL(url);
        }
        image.close = () => {
          image.src = "";
        };
        bitmap = image;
      }
      if (
        this.closed ||
        controller.signal.aborted ||
        !this.keepInCache(index)
      )
        bitmap.close();
      else {
        this.cache.set(index, bitmap);
        this.onLoad();
      }
    } catch (error) {
      if (!controller.signal.aborted && !this.closed) {
        const count = (this.failures.get(index) || 0) + 1;
        this.failures.set(index, count);
        if (count >= 3) this.onError(error);
      }
    } finally {
      this.loading.delete(index);
      this.pump();
    }
  }

  dispose() {
    this.closed = true;
    for (const request of this.loading.values()) request.abort();
    for (const bitmap of this.cache.values()) bitmap.close();
    this.cache.clear();
  }
}

export class FramePlayer {
  constructor({ canvas, status, framesBase = "/assets/frames", poster, onFrame, onReady, onError }) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.framesBase = framesBase;
    this.status = status;
    this.onFrame = onFrame;
    this.onReady = onReady;
    this.onError = onError;
    this.time = 0;
    this.direction = 0;
    this.coarse = matchMedia("(pointer: coarse)").matches || innerWidth < 900;
    this.rate = this.coarse ? 3.6 : 2.2;
    this.boost = 1;
    this.lastIntent = 0;
    this.frame = -1;
    this.raf = 0;
    this.until = 0;
    this.lastTick = 0;
    this.pendingJump = null;
    if (poster) {
      this.poster = new Image();
      this.poster.src = poster;
      this.poster.onload = () => {
        if (this.frame < 0) this.drawPoster();
      };
    }
    this.resize();
  }

  async load() {
    try {
      const response = await fetch(`${this.framesBase}/manifest.json`);
      if (!response.ok) throw new Error("Frame manifest unavailable");
      const manifest = await response.json();
      if (this.closed) return;
      this.fps = manifest.fps;
      this.perSheet = manifest.columns * manifest.rows;
      this.columns = manifest.columns;
      // Only a desktop-resolution frame set is available for this invitation.
      this.variant = "desktop";
      this.coarse = matchMedia("(pointer: coarse)").matches || innerWidth < 900;
      this.rate = this.coarse ? 1.6 : 2.2;
      this.info = manifest.variants[this.variant];
      this.sourceCount = this.info.count;
      this.count = contentFrameCount(this.sourceCount) + END_HOLD_FRAMES;
      this.duration = this.count / this.fps;
      this.end = (this.count - 1) / this.fps;
      // Decode at half resolution on touch devices to stay well under mobile
      // Safari's per-tab memory ceiling (see FrameSheets) — see drawFrame,
      // which scales the source rect to match.
      this.frameScale = this.coarse && "createImageBitmap" in window ? 0.5 : 1;
      this.store = new FrameSheets(
        manifest,
        this.variant,
        this.framesBase,
        () => this.onSheet(),
        (error) => this.fail(error),
        {
          frameScale: this.frameScale,
          prefetchFrames: this.coarse ? 48 : PREFETCH_FRAMES,
          maxConcurrentLoads: this.coarse ? 4 : 8,
        },
      );
      this.pendingJump = 0;
      this.store.focus(0);
      this.store.bootstrap();
      this.resize();
    } catch (error) {
      this.fail(error);
    }
  }

  onSheet() {
    if (this.pendingJump !== null) {
      const index = Math.round(this.pendingJump * this.fps);
      if (this.drawFrame(index)) {
        this.time = this.pendingJump;
        this.pendingJump = null;
        if (!this.ready) {
          this.ready = true;
          this.onReady(this);
        }
      }
    }
    this.wake();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const nativeDpr = devicePixelRatio || 1;
    const frameW = this.info?.width || this.width;
    const sharpDpr = frameW / this.width;
    const dpr = Math.min(nativeDpr, Math.max(1, sharpDpr), 3);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.scale(dpr, dpr);
    this.drawWidth = this.width;
    this.drawHeight = this.height;
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = "high";
    if (this.frame >= 0 && this.store) this.drawFrame(this.frame, true);
    else this.drawPoster();
  }

  drawPoster() {
    if (!this.poster.complete || !this.poster.naturalWidth) return;
    this.drawImage(
      this.poster,
      0,
      0,
      this.poster.naturalWidth,
      this.poster.naturalHeight,
    );
  }

  drawImage(image, sx, sy, width, height) {
    const scale = Math.max(this.drawWidth / width, this.drawHeight / height);
    const dw = width * scale;
    const dh = height * scale;
    const dx = (this.drawWidth - dw) / 2;
    const dy = (this.drawHeight - dh) / 2;
    this.context.drawImage(
      image,
      sx,
      sy,
      width,
      height,
      Math.round(dx),
      Math.round(dy),
      Math.round(dw),
      Math.round(dh),
    );
  }

  sourceFrame(index) {
    return sourceFrameFor(
      Math.max(0, Math.min(this.count - 1, index)),
      this.sourceCount,
    );
  }

  sourceSheet(index) {
    return Math.floor(this.sourceFrame(index) / this.perSheet);
  }

  drawFrame(index, force = false) {
    if (!force && index === this.frame) return true;
    const source = this.sourceFrame(index);
    const sheet = Math.floor(source / this.perSheet);
    const bitmap = this.store.cache.get(sheet);
    if (!bitmap) return false;
    const cell = source % this.perSheet;
    const scale = this.frameScale || 1;
    this.drawImage(
      bitmap,
      (cell % this.columns) * this.info.width * scale,
      Math.floor(cell / this.columns) * this.info.height * scale,
      this.info.width * scale,
      this.info.height * scale,
    );
    this.frame = index;
    this.canvas.dataset.frame = String(index);
    this.canvas.dataset.time = String(index / this.fps);
    this.canvas.dataset.cachedSheets = String(this.store.cache.size);
    this.status.textContent = "";
    this.waitSince = 0;
    this.onFrame(index / this.fps);
    return true;
  }

  intent(direction, grace = 550) {
    if (!this.ready || this.closed) return;
    const sheet = this.sourceSheet(this.time * this.fps);
    this.store?.clearBootstrap(sheet);
    if (this.direction !== direction) this.lastTick = 0;
    const now = performance.now();
    if (now - this.lastIntent < 90)
      this.boost = Math.min(1.75, this.boost + 0.2);
    else this.boost = 1;
    this.lastIntent = now;
    this.direction = direction;
    this.until = performance.now() + grace;
    this.canvas.dataset.playing = "true";
    this.store.focus(
      this.sourceSheet(this.time * this.fps),
      direction,
    );
    this.wake();
  }

  // Direct, proportional response to a wheel/touch gesture: the film moves
  // exactly as far as the input says, with no timed "play until grace expires"
  // indirection. This is what makes continuous input (trackpad, finger drag)
  // feel 1:1 instead of laggy.
  scrub(deltaTime) {
    if (!this.ready || this.closed || !deltaTime) return;
    this.stop();
    const next = clamp(this.time + deltaTime, 0, this.end);
    const index = Math.round(next * this.fps);
    this.store.focus(this.sourceSheet(index), Math.sign(deltaTime));
    this.time = next;
    if (this.drawFrame(index)) {
      this.pendingJump = null;
      this.waitSince = 0;
    } else {
      this.pendingJump = next;
      if (!this.waitSince) this.waitSince = performance.now();
      else if (performance.now() - this.waitSince > 400)
        this.status.textContent = "Loading the next moment…";
    }
  }

  wake() {
    if (!this.raf && this.direction && !document.hidden && !this.closed) {
      this.raf = requestAnimationFrame((now) => this.tick(now));
    }
  }

  tick(now) {
    this.raf = 0;
    if (!this.direction || document.hidden || now >= this.until) {
      this.stop();
      return;
    }
    const dt = this.lastTick ? Math.min((now - this.lastTick) / 1000, 0.06) : 0;
    this.lastTick = now;
    const next = Math.max(
      0,
      Math.min(
        this.end,
        this.time + this.direction * this.rate * this.boost * dt,
      ),
    );
    const index = Math.round(next * this.fps);
    this.store.focus(this.sourceSheet(index), this.direction);
    if (this.drawFrame(index)) this.time = next;
    else {
      // Buffer in place; never jump ahead to catch up with elapsed network time.
      if (!this.waitSince) this.waitSince = now;
      if (now - this.waitSince > 400)
        this.status.textContent = "Loading the next moment…";
    }
    const atBoundary =
      (this.direction < 0 && next === 0) ||
      (this.direction > 0 && next === this.end);
    if (atBoundary && index === this.frame) this.stop();
    else this.wake();
  }

  stop() {
    this.direction = 0;
    this.until = 0;
    this.lastTick = 0;
    this.boost = 1;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas.dataset.playing = "false";
    this.status.textContent = "";
  }

  seek(time) {
    this.stop();
    if (!this.store) return;
    this.store.clearBootstrap(
      this.sourceSheet(Math.max(0, Math.min(this.end, time)) * this.fps),
    );
    this.pendingJump = Math.max(0, Math.min(this.end, time));
    const index = Math.round(this.pendingJump * this.fps);
    this.store.focus(this.sourceSheet(index));
    this.onSheet();
  }

  fail(error) {
    if (this.closed) return;
    this.stop();
    this.onError(error);
  }

  dispose() {
    this.stop();
    this.closed = true;
    this.store?.dispose();
  }
}
