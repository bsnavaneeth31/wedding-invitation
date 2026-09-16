// Real <video> playback for the "auto"/"tap" experience (see main.js's
// navMode). Unlike frame-player.js — which manually decodes and caches
// sprite-sheet bitmaps so arbitrary scroll-scrubbing stays smooth — this
// hands the compressed film straight to the browser's own media pipeline:
// native buffering (progressive HTTP range requests, no custom prefetch
// logic needed), hardware-accelerated decode, and a bounded, browser-managed
// memory footprint regardless of resolution. That's what makes full source
// resolution safe here even on low-memory phones, where the sprite-sheet
// player has to trade resolution for decoded-bitmap memory instead.
//
// Reverse playback isn't reliably supported by <video> across browsers, so
// playTo() only animates forward glides; a backward target cuts instantly
// (see playTo below) — an acceptable trade since the guest-facing flow is
// overwhelmingly forward (the auto playthrough, and tapping "next").
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export class VideoPlayer {
  constructor({ video, status, src, poster, onFrame, onReady, onError }) {
    this.video = video;
    this.status = status;
    this.src = src;
    this.onFrame = onFrame;
    this.onReady = onReady;
    this.onError = onError;
    this.ready = false;
    this.closed = false;
    this.raf = 0;
    this.arriving = null;
    video.muted = true;
    video.playsInline = true;
    video.disableRemotePlayback = true;
    if (poster) video.poster = poster;
    this.handleWaiting = () => {
      if (!this.closed) this.status.textContent = "Loading the next moment…";
    };
    this.handlePlaying = () => {
      if (!this.closed) this.status.textContent = "";
    };
    this.handleError = () => {
      if (!this.closed) this.onError(video.error || new Error("Video playback failed"));
    };
    video.addEventListener("waiting", this.handleWaiting);
    video.addEventListener("playing", this.handlePlaying);
    video.addEventListener("error", this.handleError);
  }

  get time() {
    return this.video.currentTime;
  }

  get animating() {
    return !!this.arriving;
  }

  async load() {
    if (!this.video.querySelector("source")) {
      const source = document.createElement("source");
      source.src = this.src;
      source.type = "video/mp4";
      this.video.appendChild(source);
      this.video.load();
    }
    await new Promise((resolve, reject) => {
      if (this.video.readyState >= 1) { resolve(); return; }
      const onMeta = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(this.video.error || new Error("Video load failed")); };
      const cleanup = () => {
        this.video.removeEventListener("loadedmetadata", onMeta);
        this.video.removeEventListener("error", onErr);
      };
      this.video.addEventListener("loadedmetadata", onMeta);
      this.video.addEventListener("error", onErr);
    });
    if (this.closed) return;
    this.duration = this.video.duration;
    this.end = Math.max(0, this.duration - 1 / 24);
    this.ready = true;
    this.status.textContent = "";
    this.onReady(this);
  }

  seek(time) {
    this.stop();
    const target = clamp(time, 0, this.end);
    this.video.currentTime = target;
    this.onFrame(target);
  }

  // Forward glide: play natively at `rate` until reaching targetTime, then
  // pause exactly there and call onDone — the video-backed replacement for
  // the old scrub-per-frame tween (see main.js's animateTo). A target behind
  // the current position cuts instantly instead (see file header).
  playTo(targetTime, rate, onDone) {
    this.stop();
    const target = clamp(targetTime, 0, this.end);
    if (target <= this.video.currentTime + 0.001) {
      this.seek(target);
      onDone?.();
      return;
    }
    this.video.playbackRate = clamp(rate, 0.0625, 16);
    this.arriving = { target, onDone };
    this.resync();
    const playPromise = this.video.play();
    if (playPromise?.catch) {
      playPromise.catch((error) => {
        if (!this.closed) this.onError(error);
      });
    }
    this.watch();
  }

  // Re-seeking to the exact current position (a no-op position-wise) forces
  // the decoder to resync to that precise frame before resuming. Without
  // this, some mobile browsers' video decoders can briefly render a stale,
  // already-passed frame right after play() following a pause — the
  // position reported by currentTime is correct throughout, but what's
  // actually painted lags behind it for a moment. Seen as the film
  // appearing to step back into an earlier moment right after a guest taps
  // to resume, before catching back up.
  resync() {
    this.video.currentTime = this.video.currentTime;
  }

  watch() {
    const step = () => {
      this.raf = 0;
      if (this.closed || !this.arriving) return;
      const { target, onDone } = this.arriving;
      const now = this.video.currentTime;
      if (now >= target || this.video.ended) {
        this.arriving = null;
        this.video.pause();
        this.video.currentTime = target;
        this.onFrame(target);
        onDone?.();
        return;
      }
      this.onFrame(now);
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  // Resumes a playTo() that's still in flight (its target/onDone survive a
  // stop() only when called via this path) — used when the tab regains focus
  // mid-autoplay, since a backgrounded <video> is commonly paused by the
  // browser itself. See main.js's stopPlayback/visibilitychange handling.
  resume() {
    if (this.closed || !this.arriving || !this.video.paused) return;
    this.resync();
    const playPromise = this.video.play();
    if (playPromise?.catch) {
      playPromise.catch((error) => {
        if (!this.closed) this.onError(error);
      });
    }
    this.watch();
  }

  resize() {
    /* Native <video> sizes itself via CSS object-fit; nothing to do. */
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.arriving = null;
    this.video.pause();
    this.status.textContent = "";
  }

  dispose() {
    this.closed = true;
    this.stop();
    this.video.removeEventListener("waiting", this.handleWaiting);
    this.video.removeEventListener("playing", this.handlePlaying);
    this.video.removeEventListener("error", this.handleError);
  }
}
