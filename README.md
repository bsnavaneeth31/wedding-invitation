# Pallavi & Navaneeth — wedding invitation

A cinematic, single-screen wedding invitation. Vanilla JS + Vite — no framework.

## Included

- Gesture-driven "virtual film": wheel/trackpad/touch/keyboard input drives an
  internal clock with inertia and a grace period (`frame-player.js`), not a
  1:1 mapping of scroll position to frame. The browser scrollbar is kept in
  sync afterwards so it still feels like scrolling.
- Fetching and decoding sprite sheets are decoupled (`frame-player.js`):
  every sheet downloads in the background, in film order, starting the
  moment the page opens — chapter 1's bytes are ready almost immediately,
  and later chapters have already arrived by the time playback reaches them.
  Only a small window of sheets around the current playhead is ever decoded
  to a bitmap (that's the part that costs raw memory, ~36MB per sheet at
  full resolution), so the whole film never needs to be resident at once.
- A temple-rises-behind-the-text hero effect: a per-frame silhouette mask
  (`public/assets/hero-skyline.json`) clips the hero text to a shrinking sky
  region as the temple rises into frame.
- Six full-screen chapters cross-fading over the film, a chapter nav, a
  progress bar, and a wedding-details dialog (venue, events, "Save the
  dates" calendar download).
- 152 sprite sheets (1210 frames @ 24fps, 810×1440) served from
  `public/assets/frames/desktop/`, indexed by true frame number.

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

- Only a desktop-resolution frame set is used (810×1440 tiles), for all
  screen sizes — there's no separate lower-res mobile variant, and frames are
  never downscaled on decode either (see the fetch/decode split above).
