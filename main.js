import { couple, venue, events } from "./wedding-data.js";
import { FRAMES_BASE, POSTER } from "./demo-config.js";
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
let duration = 50.416667;
let presented = 0;
let activeChapter = -1;
let staticMode = false;
let player;
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
      ? "Skip the film "
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
  player?.stop();
  heldKeys.clear();
  clearInterval(keyTimer);
  stopMomentum();
  // Don't cancel the initial auto-mode playthrough just because the tab
  // blurred/hid — let it naturally pause and resume. Once it's finished
  // (or in any other mode), an in-flight tween is fine to cancel.
  if (!(navMode === "auto" && !autoplayDone)) { cancelAnimationFrame(tweenRaf); tweenRaf = 0; }
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
    framesBase: FRAMES_BASE,
    poster: POSTER,
    onFrame(time) {
      presented = time;
      updateChapter(time);
      syncScroll();
    },
    onReady(film) {
      duration = film.duration;
      if (restoredPosition > .001) film.seek(restoredPosition * (duration - FRAME));
      if (navMode === "auto" && !staticMode) runAutoplay();
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

// Animates the film from its current position to targetTime, driven by
// absolute elapsed wall-clock time rather than accumulated per-tick deltas —
// so it can't drift or compound if the tab is throttled/backgrounded and the
// browser later fires a burst of catch-up animation frames. Used both for
// auto mode's full playthrough and for tap-like chapter-to-chapter glides.
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
  const startWall = performance.now();
  const direction = Math.sign(targetTime - startTime) || 1;
  const totalDelta = Math.abs(targetTime - startTime);
  if (totalDelta < 0.001) { onDone?.(); return; }
  let pausedMs = 0;
  let bufferingSince = 0;
  function step(now) {
    // While a frame is still decoding (player.waitSince set by a failed
    // draw), hold the target still instead of continuing to advance it from
    // wall-clock time. Otherwise, under sustained decode/network pressure,
    // the requested position keeps racing ahead of what's actually been
    // drawn, pushing the one sheet the display is stuck waiting on outside
    // the prefetch window — which aborts its in-flight fetch and restarts
    // it, over and over, freezing playback for a long stretch. Visually
    // that reads as the film "not moving" or looping rather than a clean
    // continuous advance, since nothing changes on screen the whole time.
    if (player?.waitSince) {
      if (!bufferingSince) bufferingSince = now;
      // Don't wait forever on a sheet that's permanently failed to load
      // (network down, etc.) — give up after a while rather than hanging.
      if (now - bufferingSince > 10000 || staticMode || player.closed) {
        tweenRaf = 0;
        onDone?.();
        return;
      }
      tweenRaf = requestAnimationFrame(step);
      return;
    }
    if (bufferingSince) { pausedMs += now - bufferingSince; bufferingSince = 0; }
    const elapsed = ((now - startWall - pausedMs) / 1000) * speed;
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
  animateTo(duration - FRAME, { speed: AUTOPLAY_SPEED, onDone: finishAutoplay });
}
function finishAutoplay() {
  if (navMode !== "auto" || autoplayDone) return;
  autoplayDone = true;
  autoplayPaused = false;
  cancelAnimationFrame(tweenRaf);
  tweenRaf = 0;
  status.textContent = "";
  updateFooterLabel(activeChapter);
}
function skipAutoplay() {
  if (navMode !== "auto" || autoplayDone) return;
  player?.seek(Math.max(0, duration - FRAME));
  finishAutoplay();
}
// A stray tap while the film is still playing itself shouldn't jump straight
// to the end — that's what the explicitly-labeled "Skip the film" control is
// for. An incidental tap just pauses it in place; tapping again resumes from
// exactly where it left off.
let autoplayPaused = false;
function toggleAutoplayPause() {
  if (navMode !== "auto" || autoplayDone) return;
  if (tweenRaf) {
    cancelAnimationFrame(tweenRaf);
    tweenRaf = 0;
    autoplayPaused = true;
    status.textContent = "Paused — tap to continue";
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
  const target = wrapToStart || index === 0
    ? 0
    : index === copies.length - 1
      ? Math.max(0, duration - FRAME) // the true final frame, not just "into" the last scene
      : starts[index] + .9;
  if (tapLike() && !wrapToStart) animateTo(target, { speed: TAP_TRANSITION_SPEED });
  else player.seek(target);
}
chapterButtons.forEach(button => button.addEventListener("click", () => goToChapter(Number(button.dataset.chapter))));
$("#next-chapter").addEventListener("click", () => {
  if (navMode === "auto" && !autoplayDone) { skipAutoplay(); return; }
  tapNavigate(true);
});
loadFilm();

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
    stopPlayback();
    cancelAnimationFrame(tweenRaf);
    tweenRaf = 0;
    autoplayDone = true;
    detailsDialog.showModal();
    document.body.style.overflow = "hidden";
  }),
);
$("#close-details").addEventListener("click", () => detailsDialog.close());
detailsDialog.addEventListener("close", () => {
  document.body.style.overflow = "";
});

// Background music. Browsers block audio-with-sound from starting until a
// real user gesture, so this starts on the guest's first tap/click/keypress
// anywhere on the page — auto mode's own skip/pause taps qualify too, no
// separate "tap for sound" step needed unless the guest never interacts.
const music = $("#bg-music");
const soundToggle = $("#sound-toggle");
let musicStarted = false;

function setSoundUI(playing) {
  soundToggle.setAttribute("aria-pressed", String(playing));
  soundToggle.setAttribute("aria-label", playing ? "Mute background music" : "Play background music");
  soundToggle.firstElementChild.textContent = playing ? "♫" : "♪";
}

function startMusic() {
  if (musicStarted) return;
  musicStarted = true;
  music.muted = false;
  music.play().then(() => setSoundUI(true)).catch(() => { musicStarted = false; });
}

function firstInteraction(event) {
  if (event.target === soundToggle || soundToggle.contains(event.target)) return;
  startMusic();
}
document.addEventListener("pointerdown", firstInteraction, { once: true, passive: true });
document.addEventListener("keydown", firstInteraction, { once: true });

soundToggle.addEventListener("click", () => {
  if (!musicStarted) { startMusic(); return; }
  music.muted = !music.muted;
  setSoundUI(!music.muted);
});
