# Pallavi & Navaneeth — wedding invitation

A cinematic, single-screen wedding invitation. Vanilla JS + Vite — no framework.

## Included

- Two playback backends, chosen per nav mode (see `main.js`'s `loadFilm`):
  - **`video-player.js`** — a real `<video>` (`public/assets/journey.mp4`,
    H.264, native 810×1440) for the guest-facing default: the browser's own
    media pipeline handles buffering and decode, so full source resolution
    stays safe on mobile without the memory blowup a hand-rolled decoded-frame
    cache would hit at that resolution. Auto mode plays it through natively at
    a fixed rate; tap-to-chapter glides play forward at a faster rate and
    pause on arrival (reverse playback isn't reliably supported by `<video>`,
    so a backward chapter tap cuts instantly instead).
  - **`frame-player.js`** — the original sprite-sheet canvas player, kept only
    for `?nav=scroll` (continuous scroll-scrubbing to an arbitrary frame,
    which compressed video doesn't do well). Wheel/trackpad/touch/keyboard
    input drives an internal clock with inertia and a grace period, not a 1:1
    mapping of scroll position to frame; the browser scrollbar is synced
    afterwards. 152 sprite sheets (1210 frames @ 24fps, 810×1440) served from
    `public/assets/frames/desktop/`, indexed by true frame number, decoded at
    half resolution on touch devices to bound memory.
- A temple-rises-behind-the-text hero effect: a per-frame silhouette mask
  (`public/assets/hero-skyline.json`) clips the hero text to a shrinking sky
  region as the temple rises into frame.
- Six full-screen chapters cross-fading over the film, a chapter nav, a
  progress bar, and a wedding-details dialog (venue, events, "Save the
  dates" calendar download).

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3000

## Personalize

Edit directly in [index.html](index.html):

- The hero heading, eyebrow, date text
- The five other chapter texts (`.chapter-copy` articles)
- The wedding-details dialog intro text
- The `<title>` and meta description

Edit in [wedding-data.js](wedding-data.js):

- `couple` — names used in the generated calendar file
- `venue` — name, address, and an optional Google Maps link, shown once in
  the details dialog and used for the "Save the dates" `.ics` download
- `events` — the entries shown in the details dialog and exported to the
  calendar file

## Notes

- The default auto/tap experience is full native resolution (810×1440) on
  every device, via `public/assets/journey.mp4`. Only `?nav=scroll` still
  uses the 810×1440 sprite-sheet tiles, downscaled 50% on touch devices.
- Regenerating `journey.mp4` from the sprite sheets (e.g. after re-editing a
  chapter): extract each sheet's cells to full-res PNGs in frame order, then
  encode with ffmpeg, e.g. `ffmpeg -framerate 24 -i frame_%04d.png -c:v
  libx264 -preset slow -crf 20 -g 24 -pix_fmt yuv420p -movflags +faststart
  journey.mp4`.
