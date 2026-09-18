import { couple, venue, events } from "./wedding-data.js";
import { FILM_SRC, POSTER, END_POSTER } from "./demo-config.js";
import { FramePlayer } from "./frame-player.js";

const $ = selector => document.querySelector(selector);
const canvas = $("#journey-video");
const journey = $("#journey");
const stage = $(".journey-stage");
const status = $("#media-status");
const copies = [...document.querySelectorAll(".chapter-copy")];
const chapterButtons = [...document.querySelectorAll("[data-chapter]")];
const starts = copies.map(copy => Number(copy.dataset.start));
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
const connection = navigator.connection;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const FPS = 24;
const FRAME = 1 / FPS;
const hero = $(".hero-depth");
const heroContent = $(".hero-content");
let skyline = null;
let stageWidth = 0;
let stageHeight = 0;
let duration = 48.833333;
let presented = 0;
let activeChapter = -1;
let staticMode = false;
let player;
// Set when the guest's first gesture arrives before the player has finished
// loading its very first frame (common on a cold mobile load) — see
// beginJourney() and onReady().
let pendingAutoplay = false;
let scrollStart = 0;
let scrollDistance = 1;
let expectedScrollY = window.scrollY;
let touch = null;
let pinch = false;
let currentGestureDirection = 0;
const heldKeys = new Set();
let keyTimer;
const isTouch =
  matchMedia('(pointer: coarse)').matches || innerWidth < 900;
const GESTURE_GRACE = isTouch ? 1100 : 700;
const SCROLL_SLACK = isTouch ? 72 : 36;
// Seconds of film advanced per 100% of viewport scrolled/swiped. Higher =
// less physical scrolling needed to get through the whole film.
const SECS_PER_VIEWPORT_TOUCH = 11;
const SECS_PER_VIEWPORT_WHEEL = 9;
let touchVelocity = 0;
let lastTouchMoveAt = 0;
let momentumRaf = 0;
let touchStart = null;
let suppressClickUntil = 0;

// Navigation mode. "auto" (default — the plain link, no query param) plays
// the film through once on its own, then navigates like tap mode. The other
// two stay available via ?nav= for testing/comparison, not linked anywhere:
// "scroll" is the original continuous scroll-scrubbed film; "tap" replaces
// continuous scrubbing with discrete tap/swipe-to-advance, Stories-style.
const navParam = new URLSearchParams(location.search).get("nav");
const navMode = navParam === "tap" || navParam === "scroll" ? navParam : "auto";
document.documentElement.classList.add(`nav-${navMode}`);
let tweenRaf = 0;
let autoplayDone = false;
// Whether the guest has tapped the start overlay yet. Before this, the page
// sits still behind the blurred "Tap to begin" screen — nothing plays until
// that tap (see the #start-overlay wiring near loadFilm()) — and that same
// tap unmutes the music, since a discrete tap/click is the only reliable
// gesture across every browser (iOS included) to start audible playback.
let journeyStarted = false;
const AUTOPLAY_SPEED = 1.15;
const TAP_TRANSITION_SPEED = 1.7;
// Auto mode plays itself through once; after that (or once skipped) it
// navigates exactly like tap mode — animated chapter-to-chapter glides you
// can send backward, so there's always a way back to the beginning.
const tapLike = () => navMode === "tap" || (navMode === "auto" && autoplayDone);

// Coordinate-only mask: no second video or canvas is decoded on the phone.
fetch("/assets/hero-skyline.json")
  .then((response) => {
    if (!response.ok) throw new Error("Mask unavailable");
    return response.json();
  })
  .then((data) => {
    skyline = data;
    updateHeroDepth(presented);
  })
  .catch(() => {
    /* The readable hero remains available if the effect fails. */
  });

function updateHeroDepth(time) {
  if (staticMode) {
    hero.style.clipPath = "none";
    heroContent.style.transform = "none";
    return;
  }
  if (!skyline || time >= starts[1] || !stageWidth) return;
  const boundary =
    skyline.frames[
      Math.min(skyline.frames.length - 1, Math.floor(time * skyline.fps + 0.01))
    ];
  const scale = Math.max(
    stageWidth / skyline.width,
    stageHeight / skyline.height,
  );
  const offsetX = (stageWidth - skyline.width * scale) / 2;
  const offsetY = (stageHeight - skyline.height * scale) / 2;
  const right = offsetX + skyline.width * scale;
  const points = [`${offsetX}px ${offsetY}px`, `${right}px ${offsetY}px`];
  for (let x = boundary.length - 1; x >= 0; x--) {
    points.push(
      `${(offsetX + (x + 0.5) * scale).toFixed(2)}px ${(offsetY + boundary[x] * scale).toFixed(2)}px`,
    );
  }
  hero.style.clipPath = `polygon(${points.join(",")})`;
  const depth = clamp(time / 5, 0, 1);
  heroContent.style.transform = `translateY(${-depth * 18}px) scale(${1 - depth * 0.06})`;
}

// Kept separate from updateChapter's "only when the chapter index changes"
// block because the label also depends on autoplayDone, which can flip
// (finishing, skipping, restarting) without the chapter index changing —
// e.g. finishing on chapter 6 needs to relabel from "Skip the film" to
// "Back to the beginning" even though the index stayed at 5 the whole time.
function updateFooterLabel(index) {
  const stillAutoplaying = navMode === "auto" && !autoplayDone;
  $("#next-chapter").firstChild.textContent = staticMode
    ? "The celebrations "
    : stillAutoplaying
      ? (journeyStarted ? "Skip the film " : "Tap to begin ")
      : tapLike()
        ? (index === 5 ? "Back to the beginning " : "Tap to continue ")
        : (index === 5 ? "Back to the beginning " : "Scroll to unfold ");
  $("#next-chapter span").textContent = index === 5 && !stillAutoplaying ? "↑" : "↓";
}

function updateChapter(time) {
  const index = staticMode
    ? 0
    : Math.max(
        0,
        starts.findLastIndex((start) => time >= start),
      );
  if (index !== activeChapter) {
    copies.forEach((copy, i) => {
      copy.classList.toggle("is-active", i === index);
      copy.setAttribute("aria-hidden", String(i !== index));
      copy.inert = i !== index;
      if (i !== index) copy.style.opacity = "0";
    });
    chapterButtons.forEach((button, i) => {
      if (i === index) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
    $("#chapter-number").textContent = String(index + 1).padStart(2, "0");
    $("#chapter-name").textContent = copies[index].dataset.name;
    activeChapter = index;
    updateFooterLabel(index);
  }
  // Fade around the actual scene boundaries, tied to the frame that has decoded.
  const fadeIn = index === 0 ? 1 : clamp((time - starts[index]) / 0.65, 0, 1);
  const fadeOut =
    index === copies.length - 1
      ? 1
      : clamp((starts[index + 1] - time) / 0.65, 0, 1);
  const alpha = staticMode ? 1 : Math.min(fadeIn, fadeOut);
  copies[index].style.opacity = String(alpha * alpha * (3 - 2 * alpha));
  updateHeroDepth(time);
  $("#progress-fill").style.transform =
    `scaleX(${staticMode ? 0 : clamp(time / (duration - FRAME), 0, 1)})`;
}


function measure() {
  scrollStart = journey.offsetTop;
  stageWidth = stage.clientWidth;
  stageHeight = stage.clientHeight;
  scrollDistance = Math.max(1, journey.offsetHeight - innerHeight);
  player?.resize();
  updateHeroDepth(presented);
}

function syncScroll() {
  if (staticMode || touch) return;
  expectedScrollY = Math.round(scrollStart + presented / (duration - FRAME) * scrollDistance);
  const drift = scrollY - expectedScrollY;
  if (Math.abs(drift) > SCROLL_SLACK) {
    window.scrollTo({ top: expectedScrollY, behavior: "instant" });
  }
}

function stopPlayback() {
  heldKeys.clear();
  clearInterval(keyTimer);
  stopMomentum();
  // Don't cancel the initial auto-mode playthrough just because the tab
  // blurred/hid — let it naturally pause and resume. player.stop() now
  // also pauses native playback (see playTo() in frame-player.js), so it
  // has to be skipped here too, not just the outer tweenRaf — otherwise
  // this same exception silently stopped applying once autoplay switched
  // to driving the video natively. Once finished (or in any other mode),
  // an in-flight tween is fine to cancel.
  if (!(navMode === "auto" && !autoplayDone)) {
    player?.stop();
    cancelAnimationFrame(tweenRaf);
    tweenRaf = 0;
  }
}

function inputAllowed(event) {
  return !staticMode && !document.hidden && !document.querySelector("dialog[open]")
    && !(event?.target instanceof Element && event.target.closest("input, select, textarea, [contenteditable]"));
}

function receiveIntent(direction) {
  if (!direction || !inputAllowed()) return;
  player?.intent(direction, GESTURE_GRACE);
}

function loadFilm() {
  player?.dispose();
  staticMode = motionPreference.matches || !!connection?.saveData;
  document.documentElement.classList.toggle("static-journey", staticMode);
  const restoredPosition = clamp((scrollY - journey.offsetTop) / Math.max(1, journey.offsetHeight - innerHeight), 0, 1);
  presented = 0;
  activeChapter = -1;
  updateChapter(0);
  player = new FramePlayer({
    canvas, status,
    src: FILM_SRC,
    poster: POSTER,
    endPoster: END_POSTER,
    onFrame(time) {
      presented = time;
      updateChapter(time);
      syncScroll();
      pulseFilmMusic();
    },
    onReady(film) {
      duration = film.duration;
      if (restoredPosition > .001) film.seek(restoredPosition * (duration - FRAME));
      // Sits still on the hero/home frame from here — see journeyStarted.
      markStartOverlayReady();
      if (pendingAutoplay) {
        pendingAutoplay = false;
        scheduleAutoplay();
        updateFooterLabel(activeChapter);
      }
    },
    onError() {
      stopPlayback();
      staticMode = true;
      document.documentElement.classList.add("static-journey");
      status.textContent = "The film couldn’t load. Open the celebrations for details.";
      activeChapter = -1;
      updateChapter(0);
    },
  });
  measure();
  if (!staticMode) {
    status.textContent = "Preparing your journey…";
    player.load();
  } else {
    status.textContent = "";
  }
}

// Animates the film from its current position to targetTime. Forward
// motion (the common case: auto mode's full playthrough, and forward
// chapter-to-chapter glides) delegates to player.playTo(), which drives the
// video with its own native playback instead of repeated manual seeks — on
// weak devices, forcing a fresh seek on every animation frame can't keep up
// with real-time requests: the requested position (a plain number) updates
// instantly while the actual decoded picture falls further and further
// behind, so playback looks laggy/still even though the tracked time
// advances smoothly. Confirmed directly against a real low-end Android
// device. <video> has no negative playbackRate, so backward motion still
// uses the original wall-clock-driven manual-scrub loop below.
function animateTo(targetTime, { speed = 1, onDone } = {}) {
  cancelAnimationFrame(tweenRaf);
  if (!player) { onDone?.(); return; }
  // Baseline off the player's own internal time, not the possibly-stale
  // `presented` (which only updates once a frame actually finishes decoding
  // and drawing). Using the stale value here was the cause of a visible
  // rewind-then-forward glitch at chapter boundaries: if the previous tween
  // ended while a frame was still buffering, `presented` could lag behind
  // where the film had actually already reached, and the next tween would
  // briefly scrub backward to "catch up" to its own wrong starting point.
  const startTime = player.time;
  const direction = Math.sign(targetTime - startTime) || 1;
  const totalDelta = Math.abs(targetTime - startTime);
  if (totalDelta < 0.001) { onDone?.(); return; }
  if (direction > 0) {
    player.playTo(targetTime, speed, onDone);
    return;
  }
  const startWall = performance.now();
  function step(now) {
    // Earlier versions held the target still while player.waitSince was set,
    // to avoid racing ahead of the old WebP-sheet prefetch window. The video
    // player has no such window — a superseded seek is harmless — and that
    // gating became a deadlock here: scrub() is the only thing that ever
    // sets a new video.currentTime, and a new currentTime is the only thing
    // that can trigger the "seeked" event that clears waitSince. Skipping
    // scrub() while waitSince is true meant it could never clear itself,
    // freezing the tween solid until the 10s bailout gave up entirely. Keep
    // advancing unconditionally instead; the player's own status message
    // still surfaces genuine stalls independently of this loop.
    const elapsed = ((now - startWall) / 1000) * speed;
    const progressed = Math.min(elapsed, totalDelta);
    const target = startTime + direction * progressed;
    if (!document.hidden && player) player.scrub(target - player.time);
    if (progressed >= totalDelta - 0.0005) {
      tweenRaf = 0;
      // Guarantee arrival at the exact target frame even if the last stretch
      // was still buffering when the wall-clock timer above finished —
      // otherwise playback can visibly stop a frame or two short of it.
      player?.seek(targetTime);
      onDone?.();
      return;
    }
    tweenRaf = requestAnimationFrame(step);
  }
  tweenRaf = requestAnimationFrame(step);
}

// Auto mode: the film plays itself through once, then simply stops on its
// final frame — it does not open the details dialog on its own. The visitor
// opens that explicitly via "the celebrations". After finishing (or being
// skipped), auto mode navigates exactly like tap mode.
function runAutoplay() {
  clearOpeningHold();
  animateTo(duration - FRAME, { speed: AUTOPLAY_SPEED, onDone: holdForMusicThenFinish });
}
// After the opening tap, sit on the hero frame a moment longer before the
// film starts moving, so the title line has time to actually be read instead
// of starting to scroll away immediately. Music (already playing from the
// tap) is unaffected — only the video's advance is delayed.
const OPENING_HOLD_MS = 2600;
let openingHoldTimer = 0;
function clearOpeningHold() {
  clearTimeout(openingHoldTimer);
  openingHoldTimer = 0;
}
function scheduleAutoplay() {
  status.textContent = "";
  clearOpeningHold();
  openingHoldTimer = setTimeout(runAutoplay, OPENING_HOLD_MS);
}
// The video plays at AUTOPLAY_SPEED (1.15x) but the music plays at its own
// normal speed, so the video always reaches its own true end before the
// ~46.8s music does — by several real seconds, not the couple this was
// tuned for. Hold here, on the already-settled final frame, keeping the
// music running (skip pulseFilmMusic()'s usual idle-pause, since nothing
// is calling it anymore once the tween itself has stopped) until the music
// has actually finished too — matching what skipAutoplay() already
// guarantees outright by forcing the music to its own end. Otherwise a
// guest who taps left right as the film "finishes" still hears a tail of
// music that a guest who used Skip never would.
let musicHoldInterval = 0;
let musicHoldEndedHandler = null;
function clearMusicHold() {
  clearInterval(musicHoldInterval);
  musicHoldInterval = 0;
  if (musicHoldEndedHandler) music.removeEventListener("ended", musicHoldEndedHandler);
  musicHoldEndedHandler = null;
}
function holdForMusicThenFinish() {
  if (navMode !== "auto" || autoplayDone) return;
  if (!musicReady || music.muted || music.ended) {
    finishAutoplay();
    return;
  }
  musicHoldInterval = setInterval(pulseFilmMusic, 150);
  musicHoldEndedHandler = () => {
    clearMusicHold();
    finishAutoplay();
  };
  music.addEventListener("ended", musicHoldEndedHandler, { once: true });
}
function finishAutoplay() {
  if (navMode !== "auto" || autoplayDone) return;
  // Covers skipAutoplay() (or anything else) reaching here while a
  // holdForMusicThenFinish() wait — or the opening hold below — is still
  // pending, so neither can leak into a state that's already finished.
  clearOpeningHold();
  clearMusicHold();
  autoplayDone = true;
  autoplayPaused = false;
  cancelAnimationFrame(tweenRaf);
  tweenRaf = 0;
  status.textContent = "";
  updateFooterLabel(activeChapter);
}
function skipAutoplay() {
  if (navMode !== "auto" || autoplayDone) return;
  ensureMusicUnmuted();
  // A single instant seek only pulses pulseFilmMusic() once, so the 220ms
  // idle timer pauses the music again almost immediately — leaving it
  // stranded wherever it happened to be when skip was pressed. Jump it to
  // its own end too, so the film and the music are at rest together, and a
  // later backward tap resumes it from the right place instead of a stale one.
  if (musicReady && music.duration) music.currentTime = music.duration;
  const target = Math.max(0, duration - FRAME);
  // The real seek below only paints (via onFrame) once the browser actually
  // lands on that frame, which — if that part of the film isn't buffered
  // yet — can take a visible moment. showEndFrame() paints a pre-rendered
  // still of the (held, static) final frame right now so the cut feels
  // instant; the real seek still runs behind it and silently takes over
  // once it lands, which looks identical since nothing in that shot moves.
  player?.showEndFrame();
  player?.seek(target);
  // Same reasoning as showEndFrame() above, for the text instead of the
  // picture: don't wait on the real seek to advance the chapter/progress UI
  // to the final chapter — otherwise finishAutoplay() below flips
  // autoplayDone to true while activeChapter is still wherever skip was
  // pressed from, and the footer label reads the wrong combination for a
  // beat ("Tap to continue" instead of "Back to the beginning").
  presented = target;
  updateChapter(target);
  finishAutoplay();
}
// A stray tap while the film is still playing itself shouldn't jump straight
// to the end — that's what the explicitly-labeled "Skip the film" control is
// for. An incidental tap just pauses it in place; tapping again resumes from
// exactly where it left off.
let autoplayPaused = false;
// The guest's very first touch/tap/key/scroll: unmutes the music (a real
// gesture, so it's allowed everywhere, iOS included) and sets the film in
// motion for the first time. Everything after this first call behaves like
// an ordinary pause/resume — ensureMusicUnmuted() is a no-op once already
// started, so it never re-forces sound back on if the guest has since muted.
function beginJourney() {
  // Unmuting/starting the music has to happen synchronously inside the
  // gesture handler (iOS requirement) even if the film itself isn't ready
  // yet — only the timed playthrough below waits.
  ensureMusicUnmuted();
  autoplayPaused = false;
  if (!player?.ready) {
    // A cold mobile load: the first sheet hasn't finished fetching/decoding
    // yet. Starting the wall-clock-driven tween now would let it race ahead
    // of what's actually buffered, so the opening seconds stutter as it
    // scrambles to catch up. Wait for onReady() to kick it off instead —
    // the "Preparing…" status stays up so it doesn't look stuck.
    pendingAutoplay = true;
    return;
  }
  scheduleAutoplay();
  updateFooterLabel(activeChapter);
}
function toggleAutoplayPause() {
  if (navMode !== "auto" || autoplayDone) return;
  // A forward tween now runs via player.playTo() (see animateTo()), which
  // never touches tweenRaf — checking tweenRaf alone would miss an
  // actively-playing native tween entirely and restart it instead of
  // pausing it. canvas.dataset.playing is set by both mechanisms.
  const isRunning = tweenRaf || canvas.dataset.playing === "true";
  if (isRunning) {
    player?.stop();
    cancelAnimationFrame(tweenRaf);
    tweenRaf = 0;
    autoplayPaused = true;
    status.textContent = "Paused — tap to continue";
  } else if (!journeyStarted) {
    beginJourney();
  } else {
    autoplayPaused = false;
    status.textContent = "";
    runAutoplay();
  }
}
// At the very beginning, a forward tap in auto mode replays the film from
// the top instead of taking a single discrete step to chapter two.
function tapNavigate(forward) {
  if (navMode === "auto" && autoplayDone && forward && activeChapter === 0) {
    autoplayDone = false;
    autoplayPaused = false;
    restartFilmMusic();
    runAutoplay();
    updateFooterLabel(activeChapter);
    return;
  }
  goToChapter(forward ? activeChapter + 1 : Math.max(0, activeChapter - 1));
}

// Wheel/trackpad and touch drive the film directly and proportionally to the
// gesture (see FramePlayer.scrub) instead of a timed "play until grace
// expires" loop, so response tracks the input 1:1. Keyboard/buttons still use
// the rate-based intent() path below, since discrete key presses have no
// continuous delta to be proportional to.
function wheelPixels(event) {
  if (event.deltaMode === 1) return event.deltaY * 16; // line mode
  if (event.deltaMode === 2) return event.deltaY * innerHeight; // page mode
  return event.deltaY;
}
window.addEventListener("wheel", event => {
  if (navMode !== "scroll" || !inputAllowed(event) || staticMode || event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  event.preventDefault();
  player?.scrub(wheelPixels(event) * (SECS_PER_VIEWPORT_WHEEL / innerHeight));
}, { passive: false });

function touchSample(touches) {
  const points = [...touches];
  const x = points.reduce((sum, point) => sum + point.clientX, 0) / points.length;
  const y = points.reduce((sum, point) => sum + point.clientY, 0) / points.length;
  const span = points.length === 2 ? Math.hypot(points[0].clientX - points[1].clientX, points[0].clientY - points[1].clientY) : 0;
  return { x, y, span, count: points.length };
}

function stopMomentum() {
  cancelAnimationFrame(momentumRaf);
  momentumRaf = 0;
  touchVelocity = 0;
  lastTouchMoveAt = 0;
}

function startMomentum(velocity) {
  if (staticMode || !velocity) return;
  let vel = velocity; // px/ms, matches the sign convention of dy below
  let last = performance.now();
  const secsPerPixel = SECS_PER_VIEWPORT_TOUCH / innerHeight;
  function step(now) {
    const dt = now - last;
    last = now;
    vel *= Math.pow(0.004, dt / 1000);
    if (Math.abs(vel) < 0.02 || !inputAllowed()) { momentumRaf = 0; return; }
    player?.scrub(vel * dt * secsPerPixel);
    momentumRaf = requestAnimationFrame(step);
  }
  momentumRaf = requestAnimationFrame(step);
}

stage.addEventListener("touchstart", event => {
  if (!inputAllowed(event) || event.touches.length > 2) return;
  stopMomentum();
  touch = touchSample(event.touches);
  touchStart = touch;
  pinch = false;
  currentGestureDirection = 0;
}, { passive: true });

stage.addEventListener("touchmove", event => {
  if (!touch || !inputAllowed(event) || !event.touches.length || event.touches.length > 2) return;
  const next = touchSample(event.touches);
  if (next.count !== touch.count) { touch = next; return; }
  // A two-finger parallel swipe uses the same centroid as one finger. A pinch
  // is left to the browser so zoom remains available.
  if (next.count === 2 && Math.abs(next.span - touch.span) > 5) {
    pinch = true;
    stopPlayback();
  }
  if (pinch) { touch = next; return; }
  const dy = touch.y - next.y;
  const dx = touch.x - next.x;
  if (Math.abs(dy) >= Math.abs(dx) && Math.abs(dy) >= 1) {
    if (event.cancelable) event.preventDefault();
    currentGestureDirection = Math.sign(dy);
    if (navMode === "scroll" && !staticMode) {
      const now = performance.now();
      if (lastTouchMoveAt) {
        const dt = now - lastTouchMoveAt;
        if (dt > 0) touchVelocity = dy / dt;
      }
      lastTouchMoveAt = now;
      player?.scrub(dy * (SECS_PER_VIEWPORT_TOUCH / innerHeight));
    }
  }
  touch = next;
}, { passive: false });

stage.addEventListener("touchend", event => {
  if (event.touches.length) { touch = touchSample(event.touches); return; }
  if (navMode === "scroll") {
    if (!pinch) startMomentum(touchVelocity);
  } else if (tapLike() && touchStart && touch && !pinch && inputAllowed(event)) {
    const totalDy = touchStart.y - touch.y;
    const totalDx = touchStart.x - touch.x;
    if (Math.hypot(totalDy, totalDx) > 40) {
      const forward = Math.abs(totalDy) >= Math.abs(totalDx) ? totalDy > 0 : totalDx > 0;
      suppressClickUntil = performance.now() + 350;
      tapNavigate(forward);
    }
  } else if (navMode === "auto" && !autoplayDone && !pinch && inputAllowed(event)) {
    // Without this, a light tap fires both this touchend handler and the
    // browser's synthesized click right after it, calling
    // toggleAutoplayPause() twice for one tap — pausing then immediately
    // resuming instead of just pausing.
    suppressClickUntil = performance.now() + 350;
    toggleAutoplayPause();
  }
  touch = null;
  touchStart = null;
  pinch = false;
  currentGestureDirection = 0;
  touchVelocity = 0;
  lastTouchMoveAt = 0;
}, { passive: true });
stage.addEventListener("touchcancel", () => {
  touch = null;
  touchStart = null;
  pinch = false;
  currentGestureDirection = 0;
  stopMomentum();
  stopPlayback();
}, { passive: true });

// Tap anywhere on the film to advance (right ~68% of the width) or go back
// (left ~32%), Stories-style — tap mode, and auto mode once its initial
// playthrough is done. Mid-playthrough in auto mode, any tap skips straight
// to the details. Real buttons/links inside the stage keep working normally
// (excluded below) rather than being treated as a tap-to-advance.
stage.addEventListener("click", event => {
  if (performance.now() < suppressClickUntil) return;
  if (event.target instanceof Element && event.target.closest("button, a")) return;
  if (tapLike()) {
    if (!inputAllowed(event)) return;
    const rect = stage.getBoundingClientRect();
    const forward = event.clientX - rect.left > rect.width * 0.32;
    tapNavigate(forward);
  } else if (navMode === "auto" && inputAllowed(event)) {
    toggleAutoplayPause();
  }
});

window.addEventListener("keydown", event => {
  if (!inputAllowed(event) || event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.("button, a, summary")) return;
  let direction = ["ArrowDown", "PageDown", "End"].includes(event.key) ? 1 : ["ArrowUp", "PageUp", "Home"].includes(event.key) ? -1 : 0;
  if (event.code === "Space") direction = event.shiftKey ? -1 : 1;
  if (!direction) return;
  event.preventDefault();
  if (navMode === "auto" && !autoplayDone) { toggleAutoplayPause(); return; }
  if (tapLike()) {
    tapNavigate(direction > 0);
    return;
  }
  heldKeys.add(event.code);
  receiveIntent(direction);
  clearInterval(keyTimer);
  keyTimer = setInterval(() => receiveIntent(direction), 150);
});
window.addEventListener("keyup", event => {
  if (!heldKeys.delete(event.code)) return;
  if (!heldKeys.size) stopPlayback();
});
window.addEventListener("scroll", () => {
  if (navMode !== "scroll" || !player?.ready || staticMode) return;
  const delta = scrollY - expectedScrollY;
  if (Math.abs(delta) <= 2) return;
  if (inputAllowed()) receiveIntent(Math.sign(delta));
  syncScroll();
}, { passive: true });
window.addEventListener("resize", measure, { passive: true });
window.addEventListener("pageshow", measure);
// iOS Safari settles its dynamic toolbar (and the resulting viewport height)
// asynchronously after load/orientation changes, so a measurement taken
// immediately can be stale — most visible as the hero mask/date drifting out
// of alignment with the video underneath. Re-measure once it settles.
window.visualViewport?.addEventListener("resize", measure, { passive: true });
setTimeout(measure, 300);
setTimeout(measure, 1000);
window.addEventListener("blur", stopPlayback);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPlayback();
  else measure();
});
motionPreference.addEventListener("change", loadFilm);
connection?.addEventListener("change", () => { if (connection.saveData) loadFilm(); });
new ResizeObserver(measure).observe(stage);

function goToChapter(index) {
  stopPlayback();
  if (staticMode) {
    $("#wedding-details").showModal();
    document.body.style.overflow = "hidden";
    return;
  }
  // Wrapping past the last chapter is "back to the beginning": an instant
  // cut, not an animated rewind through the whole film. Landing on chapter
  // one via ordinary backward taps still glides, same as any other step.
  const wrapToStart = index >= copies.length;
  if (wrapToStart) restartFilmMusic();
  const target = wrapToStart || index === 0
    ? 0
    : index === copies.length - 1
      ? Math.max(0, duration - FRAME) // the true final frame, not just "into" the last scene
      : starts[index] + .9;
  // Once the guest has already seen the film play through once (or skipped
  // it), left/right taps are revisiting chapters they've watched — a direct
  // cut respects that instead of replaying the glide. The glide is kept for
  // the standalone ?nav=tap testing mode and for the initial playthrough.
  const postAutoplay = navMode === "auto" && autoplayDone;
  if (tapLike() && !wrapToStart && !postAutoplay) animateTo(target, { speed: TAP_TRANSITION_SPEED });
  else player.seek(target);
}
chapterButtons.forEach(button => button.addEventListener("click", () => goToChapter(Number(button.dataset.chapter))));
$("#next-chapter").addEventListener("click", () => {
  if (navMode === "auto" && !autoplayDone) {
    if (!journeyStarted) beginJourney();
    else skipAutoplay();
    return;
  }
  tapNavigate(true);
});
loadFilm();

// A single blurred "Tap to begin" screen gates the very first interaction.
// Nothing about the journey (video, music, or the discrete tap/scroll
// gestures below) starts before this — no gesture short of an actual tap
// here counts, so the film can never end up moving without its music, and a
// guest who arrives and just scrolls sees the film sitting still instead of
// racing ahead silently.
//
// It opens on a "Loading" state (matching the browser's own loading
// indicator — the tab's spinner, or a mobile browser's progress bar) and
// only switches to the tappable "Tap to begin" state once the player has
// actually decoded its first frame (see markStartOverlayReady(), called from
// loadFilm()'s onReady). Tapping while still loading is deliberately a
// no-op rather than a queued start — starting the instant the guest taps
// early would begin playback before anything is buffered ahead, which is
// exactly the stutter this is meant to avoid.
const startOverlay = $("#start-overlay");
function markStartOverlayReady() {
  startOverlay.classList.remove("is-loading");
  startOverlay.setAttribute("aria-label", "Tap to begin the film, with sound");
  startOverlay.querySelector(".start-overlay-text").textContent = "Tap to begin";
  startOverlay.tabIndex = 0;
}
if (staticMode) {
  startOverlay.remove();
} else {
  const dismissStartOverlay = () => {
    if (startOverlay.classList.contains("is-loading")) return;
    startOverlay.removeEventListener("click", dismissStartOverlay);
    startOverlay.removeEventListener("keydown", onStartOverlayKeydown);
    startOverlay.classList.add("is-hidden");
    beginJourney();
  };
  function onStartOverlayKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    dismissStartOverlay();
  }
  startOverlay.addEventListener("click", dismissStartOverlay);
  startOverlay.addEventListener("keydown", onStartOverlayKeydown);
  if (player?.ready) markStartOverlayReady();
}

// Event copy and the calendar use the same editable data (see wedding-data.js).
const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  timeZone: "Asia/Kolkata",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
});
const venueMapUrl = venue.mapUrl ||
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue.address ? `${venue.name}, ${venue.address}` : venue.name)}`;

function renderDetails(container) {
  container.querySelector(".venue-name").textContent = venue.name;
  container.querySelector(".venue-address").textContent = venue.address;
  container.querySelector(".venue-map-link").href = venueMapUrl;

  const list = container.querySelector(".events-list");
  list.replaceChildren();
  events.forEach((event, i) => {
    const item = document.createElement("article");
    item.className = "event";
    const number = document.createElement("span");
    number.className = "event-number";
    number.textContent = `${String(i + 1).padStart(2, "0")} /`;
    const copy = document.createElement("div");
    const date = document.createElement("p");
    date.className = "small-label";
    date.textContent = `${dateFormat.format(new Date(event.start))} · ${timeFormat.format(new Date(event.start))}`;
    const title = document.createElement("h3");
    title.textContent = event.title;
    const label = document.createElement("p");
    label.textContent = event.label;
    copy.append(date, title, label);
    item.append(number, copy);
    if (event.note) {
      const details = document.createElement("div");
      details.className = "event-details";
      const note = document.createElement("span");
      note.textContent = event.note;
      details.append(note);
      item.append(details);
    }
    list.append(item);
  });
}
const detailsDialog = $("#wedding-details");
renderDetails(detailsDialog);

const escapeICS = (s) =>
  s
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
const utcStamp = (date) =>
  new Date(date)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
const calendar = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  `PRODID:${couple.calendarProdId}`,
  "CALSCALE:GREGORIAN",
];
events.forEach((event, i) => {
  calendar.push(
    "BEGIN:VEVENT",
    `UID:wedding-invitation-${i}-${Date.now()}@invitation.local`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `DTSTART:${utcStamp(event.start)}`,
    `DTEND:${utcStamp(event.end)}`,
    `SUMMARY:${escapeICS(`${couple.partnerOne} & ${couple.partnerTwo} - ${event.label}`)}`,
    `LOCATION:${escapeICS(venue.address ? `${venue.name}, ${venue.address}` : venue.name)}`,
    "DESCRIPTION:Wedding dates and venues. Final details to follow.",
    "END:VEVENT",
  );
});
calendar.push("END:VCALENDAR");
// Fold at UTF-8-safe boundaries for calendar readers (RFC 5545).
const encoder = new TextEncoder();
const folded = calendar.map((line) => {
  let result = "",
    width = 0;
  for (const character of line) {
    const bytes = encoder.encode(character).length;
    if (width + bytes > 73) {
      result += "\r\n ";
      width = 1;
    }
    result += character;
    width += bytes;
  }
  return result;
});
const calendarURL = URL.createObjectURL(
  new Blob([folded.join("\r\n") + "\r\n"], {
    type: "text/calendar;charset=utf-8",
  }),
);
document.querySelectorAll(".save-date-link").forEach((link) => { link.href = calendarURL; });
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) URL.revokeObjectURL(calendarURL);
});

// Native dialog supplies focus containment and Escape. This is the only
// thing that opens it — auto mode never opens it on its own, even once the
// film finishes; the visitor always chooses to.
document.querySelectorAll('a[href="#celebrations"]').forEach((link) =>
  link.addEventListener("click", (event) => {
    event.preventDefault();
    // Opening the details mid-playthrough is a pause, not a skip — the guest
    // is coming straight back. Stop the film here exactly as a stray tap
    // mid-autoplay would (see toggleAutoplayPause's pause branch), so
    // closing the dialog and tapping again resumes the film *and* the music
    // from exactly where they left off, instead of jumping ahead or
    // restarting. Cancel any pending opening-hold timer too, so a dialog
    // opened in that brief window can't have it fire the film to life
    // behind the modal once the wait is over.
    clearOpeningHold();
    stopPlayback();
    // Explicitly opening the dialog isn't the case stopPlayback()'s
    // auto-mode exemption (tab blur/hide) is for, so stop the player
    // directly regardless of it (matters for a still-running native
    // playTo() tween).
    player?.stop();
    cancelAnimationFrame(tweenRaf);
    tweenRaf = 0;
    if (navMode === "auto" && !autoplayDone) {
      autoplayPaused = true;
      status.textContent = "Paused — tap to continue";
    }
    detailsDialog.showModal();
    document.body.style.overflow = "hidden";
  }),
);
$("#close-details").addEventListener("click", () => detailsDialog.close());
detailsDialog.addEventListener("close", () => {
  document.body.style.overflow = "";
});

// Background music. The film itself waits for the guest's tap on the
// start overlay before it moves at all (see journeyStarted) — that same tap
// is what turns the sound on, in ensureMusicUnmuted(), called from
// beginJourney(). A real, discrete tap/click is what makes this reliable
// across browsers (iOS included): <audio> autoplay — unlike <video> —
// doesn't reliably start there without one, and continuous gestures like
// scroll/wheel/touchmove aren't guaranteed to count as one. There's no mute
// control once started — a guest who wants it quieter just turns the
// device volume down.
const music = $("#bg-music");
let musicReady = false;
let musicIdleTimer = null;

// The one-time switch that turns the music on, fired from the guest's tap
// on the start overlay (see beginJourney()). A no-op afterwards.
function ensureMusicUnmuted() {
  if (journeyStarted) return;
  journeyStarted = true;
  music.muted = false;
  musicReady = true;
  music.play().catch(() => { musicReady = false; });
}

// Keeps the music's own play/pause state mirrored to the film's: paused the
// instant the film stops actively advancing (autoplay paused, tab
// backgrounded, sitting still between taps) and resumed the instant it does
// again. Without this the music — started once and left alone — would just
// keep counting down on its own and could finish while the film was sitting
// idle, or end up out of step with where the film visually is. Called from
// the frame player's onFrame, so it only fires while frames are actually
// being presented; a short idle window absorbs the gaps between frames
// during normal playback.
function pulseFilmMusic() {
  if (!musicReady) return;
  if (music.paused && !music.ended) music.play().catch(() => {});
  clearTimeout(musicIdleTimer);
  musicIdleTimer = setTimeout(() => {
    if (!music.paused) music.pause();
  }, 220);
}

// Called whenever the film loops back to its very beginning and starts
// playing again. If sound is on, the music restarts in step with it. If
// muted, it's left exactly as-is — no reset — so that unmuting later resumes
// at whatever point it's naturally reached rather than jumping to zero.
function restartFilmMusic() {
  if (!musicReady || music.muted) return;
  music.currentTime = 0;
  music.play().catch(() => {});
}
