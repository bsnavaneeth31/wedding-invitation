const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Two independent layers, on purpose:
//
//  - FETCH (network): cheap. A compressed sprite sheet is ~500KB, and the
//    whole film is only ~50MB, so we just download every sheet in the
//    background, in film order, starting the moment the page opens — chapter
//    1 arrives first, chapter 2 is already on the way while you watch it,
//    and so on, the same shape as the old "load the next chapter while this
//    one plays" idea, just done at the byte level instead of hand-tracking
//    chapter boundaries (which comes for free since chapters are contiguous
//    ranges of the same sheet order).
//  - DECODE (CPU/GPU raster memory): expensive. A decoded 4x2 810x1440 sheet
//    is ~36MB of raw pixels regardless of how its bytes were obtained, and
//    that's what was crashing mobile tabs when too many stayed decoded at
//    once. So only a handful of sheets around the current playhead are ever
//    decoded — full native resolution, no downscaling — and everything
//    outside that window gets its bitmap closed immediately. Re-entering an
//    already-fetched sheet later just redecodes its cached bytes (fast, no
//    network wait), it doesn't refetch.
class FrameSheets {
  constructor(manifest, variant, framesBase, onDecode, onError, options = {}) {
    const { decodeAhead = 3, decodeBehind = 1, fetchConcurrency = 6, decodeConcurrency = 2 } = options;
    this.framesBase = framesBase;
    this.variant = variant;
    this.info = manifest.variants[variant];
    this.perSheet = manifest.columns * manifest.rows;
    this.totalSheets = this.info.sheets;
    this.decodeAhead = decodeAhead;
    this.decodeBehind = decodeBehind;
    this.fetchConcurrency = fetchConcurrency;
    this.decodeConcurrency = decodeConcurrency;
    this.blobs = new Map();
    this.fetching = new Map();
    this.fetchFailures = new Map();
    this.fetchCursor = 0;
    this.cache = new Map();
    this.decoding = new Set();
    this.decodeFailures = new Map();
    this.wanted = [];
    this.onDecode = onDecode;
    this.onError = onError;
    this.closed = false;
  }

  sheetUrl(index) {
    return `${this.framesBase}/${this.variant}/${String(index).padStart(3, "0")}.webp`;
  }

  // The decode window: a handful of sheets either side of wherever playback
  // currently is. Independent of how far ahead fetching has gotten.
  focus(sheet, direction = 1) {
    const dir = direction || 1;
    const wanted = [];
    const behind = sheet - dir * this.decodeBehind;
    if (behind >= 0 && behind < this.totalSheets) wanted.push(behind);
    for (let i = 0; i <= this.decodeAhead; i++) {
      const idx = sheet + i * dir;
      if (idx >= 0 && idx < this.totalSheets) wanted.push(idx);
    }
    if (wanted.join() === this.wanted.join()) return;
    this.wanted = wanted;
    for (const [index, bitmap] of this.cache) {
      if (!wanted.includes(index)) {
        bitmap.close();
        this.cache.delete(index);
      }
    }
    this.pumpDecode();
    this.pumpFetch();
  }

  pumpFetch() {
    if (this.closed) return;
    // Priority: whatever the decode window needs right now that isn't
    // downloaded yet (e.g. the guest jumped straight to a later chapter).
    for (const index of this.wanted) {
      if (this.fetching.size >= this.fetchConcurrency) return;
      if (this.blobs.has(index) || this.fetching.has(index)) continue;
      if ((this.fetchFailures.get(index) || 0) >= 3) continue;
      this.fetchOne(index);
    }
    // Background: keep working through the rest of the film in order, so
    // whatever chapter comes next has already arrived by the time playback
    // gets there.
    while (this.fetching.size < this.fetchConcurrency && this.fetchCursor < this.totalSheets) {
      const index = this.fetchCursor++;
      if (this.blobs.has(index) || this.fetching.has(index) || (this.fetchFailures.get(index) || 0) >= 3) continue;
      this.fetchOne(index);
    }
  }

  async fetchOne(index) {
    const controller = new AbortController();
    this.fetching.set(index, controller);
    try {
      const response = await fetch(this.sheetUrl(index), { signal: controller.signal });
      if (!response.ok) throw new Error(`Frame sheet ${response.status}`);
      const blob = await response.blob();
      if (this.closed || controller.signal.aborted) return;
      this.blobs.set(index, blob);
      this.pumpDecode();
    } catch (error) {
      if (!controller.signal.aborted && !this.closed) {
        const count = (this.fetchFailures.get(index) || 0) + 1;
        this.fetchFailures.set(index, count);
        if (count >= 3 && this.wanted.includes(index)) this.onError(error);
      }
    } finally {
      this.fetching.delete(index);
      this.pumpFetch();
    }
  }

  pumpDecode() {
    if (this.closed) return;
    for (const index of this.wanted) {
      if (this.decoding.size >= this.decodeConcurrency) return;
      if (this.cache.has(index) || this.decoding.has(index)) continue;
      if ((this.decodeFailures.get(index) || 0) >= 3) continue;
      const blob = this.blobs.get(index);
      if (!blob) continue; // Not fetched yet — fetchOne's completion retriggers this.
      this.decodeOne(index, blob);
    }
  }

  async decodeOne(index, blob) {
    this.decoding.add(index);
    try {
      let bitmap;
      if ("createImageBitmap" in window) {
        bitmap = await createImageBitmap(blob);
      } else {
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.src = url;
        try {
          await image.decode();
        } finally {
          URL.revokeObjectURL(url);
        }
        image.close = () => { image.src = ""; };
        bitmap = image;
      }
      if (this.closed || !this.wanted.includes(index)) bitmap.close();
      else {
        this.cache.set(index, bitmap);
        this.onDecode();
      }
    } catch (error) {
      const count = (this.decodeFailures.get(index) || 0) + 1;
      this.decodeFailures.set(index, count);
      if (count >= 3) this.onError(error);
    } finally {
      this.decoding.delete(index);
      this.pumpDecode();
    }
  }

  dispose() {
    this.closed = true;
    for (const controller of this.fetching.values()) controller.abort();
    for (const bitmap of this.cache.values()) bitmap.close();
    this.cache.clear();
    this.blobs.clear();
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
      this.duration = this.info.count / this.fps;
      this.end = (this.info.count - 1) / this.fps;
      this.store = new FrameSheets(
        manifest,
        this.variant,
        this.framesBase,
        () => this.onSheet(),
        (error) => this.fail(error),
        {
          fetchConcurrency: this.coarse ? 4 : 8,
          decodeConcurrency: 2,
          decodeAhead: 3,
          decodeBehind: 1,
        },
      );
      this.pendingJump = 0;
      this.store.focus(0);
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

  drawFrame(index, force = false) {
    if (!force && index === this.frame) return true;
    const sheet = Math.floor(index / this.perSheet);
    const bitmap = this.store.cache.get(sheet);
    if (!bitmap) return false;
    const cell = index % this.perSheet;
    this.drawImage(
      bitmap,
      (cell % this.columns) * this.info.width,
      Math.floor(cell / this.columns) * this.info.height,
      this.info.width,
      this.info.height,
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
      Math.floor((this.time * this.fps) / this.perSheet),
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
    this.store.focus(Math.floor(index / this.perSheet), Math.sign(deltaTime));
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
    this.store.focus(Math.floor(index / this.perSheet), this.direction);
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
    this.pendingJump = Math.max(0, Math.min(this.end, time));
    const index = Math.round(this.pendingJump * this.fps);
    this.store.focus(Math.floor(index / this.perSheet));
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
