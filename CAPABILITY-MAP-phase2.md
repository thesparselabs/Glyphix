# Capability Map: Glyphix — Phase 2 (Typography, GPU effects, ASCII)

Status: **In progress — Milestone D done (`PLAN-milestone-d.md`), Milestone E done 2026-10-13 (`PLAN-milestone-e.md`), Milestone F done 2026-10-14 (`PLAN-milestone-f.md`); ASCII Studio (F+) done 2026-10-18 (`PLAN-milestone-fplus.md`); next: G (optional).** Built milestone by milestone, like Phase 1.
Source: `RESEARCH.md` §4 (GPU typography and effects), §8.2 (Phase 2), §11 (video → ASCII); the Phase 1 code.

> 🧒 **In plain words:** Phase 1 made Glyphix a good screenshot editor that can move things. Phase 2 makes it
> *special*: lots of fonts, letters that fly in 20+ different ways, shader effects (glow, glitch, blur…), and
> video turned into moving ASCII art. These are the features no free screenshot tool has.

## Phase 2 goal (one sentence)

A user picks from a dozen good fonts (or uploads their own), animates a headline letter by letter, word by word or
line by line with 20+ kinetic presets, adds GPU effects (glow, blur, glitch, RGB split, noise, gradient map…) to any
layer or to everything below an adjustment layer, drops in a video and turns it into ASCII art, and exports
MP4 (with audio), WebM with transparency, GIF or PNG. The preview still looks exactly like the export.

## Modules

| Module id | Responsibility | Depends on |
|---|---|---|
| `font-manager` | Bundled OFL font set (~15 families, variable weights), font upload (TTF/OTF/WOFF) stored as project assets, font picker with live previews, atlas that grows and evicts | `text-engine`, `persistence` |
| `text-styling` | Weight, line height, outline, text shadow, gradient fill — all from the SDF in the glyph shader | `font-manager` |
| `glyph-animators` | Animator v2: unit (glyph / word / line), order (forward, reverse, center, edges, random), stagger falloff, 3D flip, skew, blur, spread, colour, scramble; enter **and** exit animators; per-glyph emphasis loops | `text-engine`, `motion-presets` |
| `kinetic-presets` | 20+ text presets (enter / exit / emphasis) built on animator v2, hover-to-preview, "advanced" overrides | `glyph-animators` |
| `compositor` | Layers that need it render into their own GPU texture, then composite; adjustment layers process everything below them. Replaces the single-scene draw while keeping preview = export | `render-core` |
| `effects` | Effect stack per layer: blur, glow, noise/grain, displacement, glitch, RGB split, gradient map, dissolve, pixelate, vignette, colour adjust; keyframable params; every effect in WebGPU *and* WebGL2 | `compositor`, `doc-model` |
| `video-layer` | Video import, preview via `<video>` + `requestVideoFrameCallback`, frame-exact export via Mediabunny decode, audio passthrough into MP4 | `assets`, `export`, `compositor` |
| `ascii` | ASCII effect (two-pass: cell analysis → glyph raster), calibrated brightness LUT from the real font, charsets, colour modes, edge glyphs, keyframable params; works on any layer or adjustment layer | `effects`, `font-manager` |
| `export-v2` | WebM VP9 with alpha, MP4 with audio, PNG sequence (zip); effects and video are frame-exact | `export`, `video-layer` |
| `ascii-text` | Read back the exact characters the GPU chose (cell glyph + colour per frame); copy a frame as text, export a .txt/JSON frame sequence (zip), a self-contained HTML player and a React component | `ascii`, `export-v2` |
| `ascii-glyphs` | Custom character order, any bundled/uploaded font for ASCII (glyph set built at runtime), non-square cells (line height, letter spacing), columns × rows / auto-fit, density threshold | `ascii`, `font-manager` |
| `ascii-studio-ux` | One-click "Video → ASCII" (fit canvas, add effect), ASCII look presets, animated GIF input, optional frame counter | `ascii`, `video-layer` |
| `redact` *(optional)* | Redact layer (blur / pixelate / solid box) + OCR auto-detect of text regions in a Worker | `effects`, `assets` |

## Build order

```
Milestone D — "Type that moves"
  font-manager → text-styling → glyph-animators → kinetic-presets
  ✔ Gate: 15 font families + upload; 20+ kinetic presets; 300 glyphs with enter + exit + emphasis at 60 fps
          (WebGPU and WebGL2); preview = export mid-animation for every preset

Milestone E — "Effects"
  compositor → effects (+ adjustment layers)
  ✔ Gate: 10+ effects, WebGPU vs WebGL2 pixel diff within tolerance; 4K layer with 3 effects ≥ 30 fps preview;
          Phase 1 gates still green (drag 60 fps, preview = export)

Milestone F — "Video and ASCII"
  video-layer → ascii → export-v2
  ✔ Gate: 1080p30 video plays in sync; ASCII 160×90 on 1080p at 60 fps preview (effect < 2 ms);
          MP4 with audio and WebM-alpha export frame-exact

Milestone F+ — "ASCII Studio"  (PRIORITY: next, before G)
  ascii-glyphs → ascii-text → ascii-studio-ux
  ✔ Gate: text export equals the rendered ASCII cell for cell (every frame of a test video); custom
          charset + any font render identically on WebGPU / WebGL2 and in export; 160×90 ASCII video still
          60 fps; HTML player plays the exported sequence in sync; GIF input frame-exact; keyboard + axe clean

Milestone G (optional) — "Redact"
  redact (manual first, then OCR auto-detect)
```

Dependency direction stays one-way: `doc-model` is still the root and stays free of renderer/DOM imports.

## Phase 2 success criteria (draft)

- 15 bundled font families with weights; uploaded fonts survive reload and `.glyphix` round-trip.
- 20+ kinetic text presets (enter, exit, emphasis), all computed on the GPU; 300 glyphs with enter + exit +
  emphasis at 60 fps on the Iris Xe laptop iGPU, in WebGPU and forced WebGL2.
- 10+ effects; each matches between WebGPU and WebGL2 (mean Δ < 1/255); effect params animate.
- Video layer + ASCII effect: 160×90 grid on 1080p video at 60 fps preview.
- Export: MP4 with audio, WebM VP9 with alpha, GIF, PNG; preview = export (max Δ ≤ 2/255 where effects use
  noise/derivatives, 0 elsewhere).
- Every new control is keyboard-reachable; Lighthouse accessibility stays 100.

## Open decisions (2026-10-18)

- **Brave: "Export failed: Cannot read properties of null (reading 'getSupportedExtensions')".** Brave on this
  machine has no WebGPU, and when the export asks for a WebGL2 context it gets `null`; three.js then crashes on
  it. Not reproducible in headless Brave 1.95 (25 exports in a row work, no context leak). Likely causes:
  graphics acceleration off or GPU blocklisted (no software fallback any more), WebGL blocked for the site
  after GPU resets, or Shields/extensions blocking WebGL. Needs the WebGL/WebGL2/WebGPU lines from `brave://gpu`.
  Proposed fix either way: detect the missing context and show a clear message; let export reuse the
  preview's renderer when no new context is available.
- **AAC in MP4:** add `@mediabunny/aac-encoder` (MPL-2.0, 4.7 MB) so MP4 sound plays in QuickTime; now Opus.
- **C8, export in a Worker:** still deferred; exports block the main thread (~5–9 s for 5 s of 1080p).

## Deferred to the end (user, 2026-10-18): Milestone G "Redact" and right-click menus

Planned but not started; pick up before closing out the phases.
- **Redact layer:** a placed box (move/resize/rotate/keyframes for free) that hides everything below it: solid
  (safest, proposed default), pixelate, blur (warn: blurred text can be partly recovered). GPU pass like an
  adjustment layer masked to the box; note in the export dialog that `.glyphix` files keep the original.
- **Detect sensitive text:** OCR on the comp rendered at 2× in a Worker; list by type (emails, IPs, URLs,
  keys/tokens, phones, Luhn-checked cards, other text) → one-undo redaction. Line boxes only, so spans inside a
  line snap to word gaps found in the image.
- **Engine test (2026-10-18, 1280×720 console screenshot, 13 sensitive items):** PaddleOCR via ppu-paddle-ocr
  6.6.0 (PP-OCRv6 tiny, 6.4 MB models + onnxruntime-web 1.30.0 wasm 14 MB) read every email/IP/key well enough to
  classify at 1×; Tesseract.js 7.0.0 missed the dark-sidebar email and garbled the IP and keys (6/13 exact at 1×,
  10/13 at 2× for both). Recommendation: PaddleOCR, self-hosted, lazy-loaded, cached for offline.
- **Right-click menus:** none today (the canvas blocks the browser menu, `src/editor/Overlay.tsx`). Proposed:
  canvas + Layers panel menus (copy, paste, duplicate, delete, order, hide/lock, "redact this area"), keyboard
  Shift+F10 / Menu key.
- Open questions for then: OCR engine, default redaction style, menu scope.

## Explicitly NOT in Phase 2

Keyframe / curve editor UI (Phase 3), OCR text *replacement*, desktop app, system fonts, per-glyph variable-axis
animation, ProRes, Lottie, collaboration.

## Assumptions (to confirm)

1. **Fonts are downloaded from the google/fonts repo (OFL) and bundled in `public/fonts`**, loaded lazily on first
   use. No Google Fonts API calls at runtime (offline/PWA, privacy).
2. **WOFF2 upload is not supported in D** (needs Brotli + glyf transforms). TTF, OTF and WOFF are.
3. **Text shadow in D is the soft SDF shadow** (small blur). Big blurred shadows come from the effects in E.
4. **Scramble/decode uses a fixed alternate charset** (A–Z, 0–9, symbols) from the same font.
5. **OCR redact is optional (Milestone G)**, like C8 was in Phase 1.
6. **C8 (export in a Worker) stays deferred.** It becomes more valuable in F (video makes exports heavier), so it
   is revisited there.
