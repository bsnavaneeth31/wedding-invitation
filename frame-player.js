const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
// Kept a hair short of the real video duration when clamping seeks — seeking
// to the exact end can land past the last decodable frame on some browsers.
const END_EPSILON = 1 / 24;

// A single hardware-decoded <video> element standing in for what used to be
// a JS-decoded WebP sprite-sheet sequence. All the duplicate-footage cuts
// and the end-of-film hold that frame-player.js used to compute at runtime
// are now baked directly into the encoded video's timeline during the
// export pass (see scripts.tmp/), so this class only ever deals in plain
// seconds — no frame-index/source-frame remapping left to do here.
export class FramePlayer {
  constructor({ canvas, status, src, poster, onFrame, onReady, onError }) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.src = src;
    this.status = status;
    this.onFrame = onFrame;
    this.onReady = onReady;
    this.onError = onError;
    this.time = 0;
    this.direction = 0;
    this.rate = (matchMedia("(pointer: coarse)").matches || innerWidth < 900) ? 3.6 : 2.2;
    this.boost = 1;
    this.lastIntent = 0;
    this.raf = 0;
    this.until = 0;
    this.lastTick = 0;
    this.waitSince = 0;
    this.ready = false;
    this.closed = false;
    this.pendingJump = 0;
    if (poster) {
      this.poster = new Image();
      this.poster.src = poster;
      this.poster.onload = () => {
        if (!this.ready) this.drawPoster();
      };
    }
    this.resize();
  }

  async load() {
    try {
      this.video = document.createElement("video");
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.preload = "auto";
      this.video.src = this.src;
      // Event-driven stall tracking, not polled per scrub() call: .seeking
      // flips true synchronously after almost any currentTime assignment
      // (even ones that resolve instantly), so checking it right after
      // setting currentTime flags routine seeks as "stalled." "waiting" only
      // fires when the browser genuinely can't proceed for lack of data, and
      // "seeked" always eventually fires for whatever the latest target is
      // once the browser catches up — even if we've since moved on to a
      // newer target — so this can't get stuck the way per-call polling did.
      this.video.addEventListener("waiting", () => {
        if (!this.waitSince) this.waitSince = performance.now();
      });
      this.video.addEventListener("seeked", () => {
        this.waitSince = 0;
        this.status.textContent = "";
      });
      const metadataReady = new Promise((resolve, reject) => {
        this.video.addEventListener("loadedmetadata", resolve, { once: true });
        this.video.addEventListener("error", () => reject(new Error("Film failed to load")), { once: true });
      });
      this.video.load();
      await metadataReady;
      if (this.closed) return;
      this.duration = this.video.duration;
      this.end = Math.max(0, this.duration - END_EPSILON);
      this.resize();
      const startAt = clamp(this.pendingJump ?? 0, 0, this.end);
      await this.seekAndWait(startAt);
      if (this.closed) return;
      this.time = startAt;
      this.pendingJump = null;
      this.ready = true;
      this.render(startAt);
      this.onReady(this);
    } catch (error) {
      this.fail(error);
    }
  }

  seekAndWait(target) {
    return new Promise((resolve) => {
      // Setting currentTime to the value it already holds (e.g. the initial
      // 0 -> 0 "seek" right after load) never fires "seeked" — there's
      // nothing to seek to. Resolve directly once there's decoded data for
      // the current position instead of waiting on an event that won't come.
      if (Math.abs(this.video.currentTime - target) < 0.005) {
        if (this.video.readyState >= 2) { resolve(); return; }
        this.video.addEventListener("loadeddata", () => resolve(), { once: true });
        return;
      }
      const onSeeked = () => {
        this.video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      this.video.addEventListener("seeked", onSeeked);
      this.video.currentTime = target;
    });
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const nativeDpr = devicePixelRatio || 1;
    const frameW = this.video?.videoWidth || this.width;
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
    if (this.ready) this.drawCurrentFrame();
    else this.drawPoster();
  }

  drawPoster() {
    if (!this.poster?.complete || !this.poster.naturalWidth) return;
    this.drawImage(this.poster, 0, 0, this.poster.naturalWidth, this.poster.naturalHeight);
  }

  drawImage(image, sx, sy, width, height) {
    const scale = Math.max(this.drawWidth / width, this.drawHeight / height);
    const dw = width * scale;
    const dh = height * scale;
    const dx = (this.drawWidth - dw) / 2;
    const dy = (this.drawHeight - dh) / 2;
    this.context.drawImage(
      image,
      sx, sy, width, height,
      Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh),
    );
  }

  drawCurrentFrame() {
    if (!this.video?.videoWidth) return false;
    this.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight);
    return true;
  }

  render(time) {
    this.drawCurrentFrame();
    this.canvas.dataset.time = String(time);
    this.status.textContent = "";
    this.waitSince = 0;
    this.onFrame(time);
  }

  // this.waitSince is set/cleared by the video's own "waiting"/"seeked"
  // events (see load()) — this just surfaces a status message once a
  // genuine stall has run long enough to be worth telling the guest about.
  // animateTo() in main.js also reads player.waitSince directly to hold its
  // tween target still instead of racing ahead of what's actually decoded.
  reportStallIfSlow(now) {
    if (this.waitSince && now - this.waitSince > 400) {
      this.status.textContent = "Loading the next moment…";
    }
  }

  intent(direction, grace = 550) {
    if (!this.ready || this.closed) return;
    if (this.direction !== direction) this.lastTick = 0;
    const now = performance.now();
    if (now - this.lastIntent < 90) this.boost = Math.min(1.75, this.boost + 0.2);
    else this.boost = 1;
    this.lastIntent = now;
    this.direction = direction;
    this.until = now + grace;
    this.canvas.dataset.playing = "true";
    this.wake();
  }

  // Direct, proportional response to a wheel/touch gesture: the film moves
  // exactly as far as the input says. Draws whatever the video currently has
  // decoded rather than waiting on a "seeked" event per call — with the
  // short keyframe interval baked into the export, that's visually caught
  // up within a frame or two, and it's what keeps continuous scrubbing 1:1
  // instead of laggy.
  scrub(deltaTime) {
    if (!this.ready || this.closed || !deltaTime) return;
    this.stop();
    const next = clamp(this.time + deltaTime, 0, this.end);
    this.time = next;
    this.video.currentTime = next;
    this.drawCurrentFrame();
    this.canvas.dataset.time = String(next);
    this.reportStallIfSlow(performance.now());
    this.onFrame(next);
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
    const next = clamp(this.time + this.direction * this.rate * this.boost * dt, 0, this.end);
    this.time = next;
    this.video.currentTime = next;
    this.drawCurrentFrame();
    this.canvas.dataset.time = String(next);
    this.reportStallIfSlow(now);
    this.onFrame(next);
    const atBoundary = (this.direction < 0 && next === 0) || (this.direction > 0 && next === this.end);
    if (atBoundary) this.stop();
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

  // Exact, waits for the browser to actually land on the target frame before
  // calling onFrame — used for chapter jumps, the initial restored position,
  // and animateTo()'s final guaranteed-arrival seek, none of which fire more
  // than a handful of times a second, so the wait is cheap.
  seek(time) {
    this.stop();
    if (!this.ready) {
      this.pendingJump = clamp(time, 0, this.end ?? time);
      return;
    }
    const target = clamp(time, 0, this.end);
    this.time = target;
    this.waitSince = performance.now();
    this.seekAndWait(target).then(() => {
      if (this.closed) return;
      this.render(target);
    });
  }

  fail(error) {
    if (this.closed) return;
    this.stop();
    this.onError(error);
  }

  dispose() {
    this.stop();
    this.closed = true;
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
    }
  }
}
