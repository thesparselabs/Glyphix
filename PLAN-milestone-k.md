# Milestone K — "Presets & reuse" + Lottie export

## Context

H–J gave Glyphix a real timeline, an easing editor and keyframes on every value. Today an animation a user builds
lives only on one layer: the key clipboard copies selected keys within the session, and the only reusable
animations are the built-in enter/exit/loop presets. K lets users **save an animation as their own preset, apply
it to other layers, copy/paste a whole animation between layers, keep a library that survives reload and can be
exported/imported as .json** — and adds a **Lottie (.json) export** of the part of a scene Lottie can represent,
with a clear list of what was left out.

Gate (from `CAPABILITY-MAP-phase3.md`): save/apply/copy round-trips; presets survive reload and export/import;
Lottie output validates and plays in lottie-web with matching timing for the supported subset; unsupported parts
listed.

## What exists (verified)

- Keys: `copyKeys` / `pasteKeys` / `KeyClipboard {items:{propId, dt, v, out}[]}` (`src/doc/keyframes.ts:64-109`);
  paste matches prop id, effect ids fall back to kind+key, values only onto the same kind (`valueKind`).
  In-memory clipboard in `src/app/timeline/keySelection.ts:23`.
- Prop registry: `animatableProps(layer)`, `propAt` (`src/doc/animatable.ts`), kinds number/color/text.
- Motion presets are **data, computed per frame** (`src/doc/motion.ts`: `Motion {enter, exit, loop}`,
  `motionModifiers`, `applyLayerPose`); glyph animators expand on the GPU, CPU reference functions exist
  (`glyphRanks`, `unitProgress`, … in `evaluate.ts:247-326`).
- Helpers to reuse: `offsetProp`, `scaleProp` (`src/doc/props.ts`), `moveLayerInTime`, `snapToFrame`,
  `store.set(label, patches)` (one undo step), `layerIndex`.
- Persistence: hand-written IndexedDB `glyphix` v1, stores projects/assets/meta (`src/persistence/db.ts`);
  readable file errors (`ProjectFileError`, `projectFile.ts:63`); file picker `useOpenFilePicker`
  (`ProjectsDialog.tsx:10`); `downloadBlob` (`export/exporter.ts:204`).
- Export: `ExportFormat` + `runExport` switch (`exporter.ts:216, 378`), `ExportResult.note` is the only warning
  slot; dialog `FORMATS` (`ExportDialog.tsx:12`).
- Text: HarfBuzz layout (`fontLibrary.layout`), `fontLibrary.outline(fontId, weight, ch)` gives SVG glyph paths
  (by character — needs a by-glyph-id variant for shaped text). `ease(e, p)` and `cssEasing(e)` (null = needs
  baking) in `easing.ts`. No Lottie package installed; `lottie-web@5.13.0` (2025-05-21) is the latest.

## Design decisions (recommendations)

1. **What a preset holds:** the layer's animated props (all keys, times relative to the layer's in point) +
   its `motion` (enter/exit/loop, incl. glyph animator for text) + effect param keys stored by effect *kind*+key.
   Built-in-preset style: one entry `{id, name, layerType, duration, props:{propId→keys}, motion, createdAt}`.
2. **Relative values:** position x/y and rotation are stored as **offsets from the first key** and scale as a
   **factor of the first key**, so "slide in from the left" applies to a layer anywhere on the canvas at any size.
   Everything else (opacity, colours, text, radius…) is absolute. Applying replaces the target props' keys
   (one undo step, also for several selected layers); props the target doesn't have (e.g. shadow off, effect kind
   missing, text on an image) are skipped and the toast says how many.
3. **Copy/paste animation** between layers = the same structure through an in-memory clipboard (Ctrl+Alt+C /
   Ctrl+Alt+V + buttons), so one code path serves presets and copy/paste.
4. **Library:** IndexedDB store `presets` (DB v2, `onupgradeneeded` adds it). Export/import as
   `{format:'glyphix-presets', version, presets[]}` .json with validation and readable errors (unknown format,
   newer version, bad prop values); imported ids re-generated on clash.
5. **UI:** a "Saved" tab in `AnimationSection` (list with hover preview, apply, rename, delete, import/export) and
   "Save as preset…" there; hover preview extends `previewDoc` to swap keys as well as motion.
6. **Lottie export (format "Lottie (.json)"), new module `src/export/lottie.ts`, pure `docToLottie(doc, deps)`:**
   - Comp → `{v, fr, ip, op, w, h, layers, assets}`; layers top-first; in/out → `ip/op`.
   - Image layer → image asset embedded as base64 (`assetBlob`), layer transform (anchor at centre, position,
     scale %, rotation, opacity); radius → a rounded-rect mask; crop via image cropping in the asset.
   - Text layer → shape layer from HarfBuzz glyph paths (by glyph id), solid colour or gradient fill, outline as
     stroke. Font-independent and plays everywhere.
   - Background solid / linear → shape layer with fill / gradient fill.
   - Keys: bezier/linear → Lottie tangents, hold → `h:1`, spring/bounce/steps → **baked** to per-frame keys.
   - Procedural whole-layer motion (enter/exit/loop) → **baked** per frame into transform/opacity keys.
   - Glyph animators → per-glyph groups with baked offset/scale/rotation/opacity; skew, blur, tint, scramble,
     glyph loops dropped.
   - **Not exported, listed in the report:** GPU effects, ASCII, video, mesh / image backgrounds, shadows, glow,
     tilt (3D), frames, image blur, `{frame}` tokens (exported as frame-1 text) — per layer, shown in the dialog
     as a list (new small "Left out" list; `ExportResult` gets `omitted: string[]`).
7. **Validation:** `lottie-web@5.13.0` as a devDependency only (test-time player) + structural unit tests.

## Tasks

- **K1 — doc (coordinator):** `src/doc/animPresets.ts`: `captureAnimation(layer)`, `applyAnimation(layer,
  anim, doc)` → patches, relative transform math, validation `parsePresetFile(json)`. Unit tests (round-trip on
  each layer type, relative offset, skipped props, effect kind matching, bad files).
- **K2 — library + UI (Sonnet worker, reviewed):** `src/persistence/presets.ts` (DB v2), Saved tab, save dialog,
  apply to selected layers, copy/paste animation (shortcuts + LayersPanel buttons), import/export .json, toasts,
  hover preview.
- **K3 — Lottie (coordinator core, Sonnet for dialog wiring):** `fontLibrary.glyphPath(fontId, weight, gid)` +
  keep gid in `LaidOutGlyph`; `src/export/lottie.ts`; `ExportFormat 'lottie'`; dialog "Left out" list.
  Unit tests on mapping (easing tangents, hold, baking, ip/op, omitted list).
- **K4 — checks + status:** `scripts/e2e-presets.mjs`, `scripts/e2e-lottie.mjs`, axe states (Saved tab, export
  report), full suites on Chrome WebGPU, WebGL2, Firefox; `PLAN-milestone-k.md` status section.

## Verification

- `npx vitest run` (new unit tests + existing 210).
- `e2e-presets`: save a keyed+motion animation, apply to another layer elsewhere on the canvas → its frames match
  the source shifted by the position offset; one undo step; reload → library still there; export .json → delete →
  import → applies identically; bad file → readable error; copy/paste animation between layers.
- `e2e-lottie`: export via the dialog, load in lottie-web (svg renderer) in the page, `goToAndStop` at several
  frames: layer bounding-box centres / opacity match our evaluate() at the same times (±1 px / ±0.01), duration and
  fps match, eased key mid-points match (bezier exact, baked spring within 1 px); text glyph shape bounds match our
  layout; the "Left out" list names effects/video in a mixed scene.
- `a11y-axe` with the new states; full `npm run e2e` chain on the 3 setups (temporary port, outDir in scratchpad).

## Not in K

Lottie import, Lottie text layers with embedded fonts, dotLottie (.lottie), effects/3D in Lottie, cloud sync of
presets, sharing presets via the system clipboard.

## Risks

- Lottie player differences: test only with lottie-web; other players (iOS/Android) not verified.
- Baking glyph animators can make big files (glyphs × frames); cap and report if over a size limit.
- Relative-offset rules may not suit every animation (e.g. absolute moves to a fixed spot); document it.

## Status (2026-10-22)

Built in two parallel worktrees (presets: Sonnet worker; Lottie: Opus worker), reviewed and merged by the
coordinator.

- **K1/K2 presets:** `src/doc/animPresets.ts` (`captureAnimation`, `applyAnimation`, `parsePresetFile`,
  `PresetFileError`), `src/persistence/presets.ts` (IndexedDB v2 store `presets`), "Saved" tab
  (`src/app/SavedAnimations.tsx`), Copy / Paste animation (buttons + Ctrl+Alt+C / V, `src/app/animActions.ts`),
  hover preview of a whole animation (`previewDoc` takes patches). Applying replaces only the motion slots the
  preset has; one undo step; messages in a small banner (the app has no toast provider).
- **K3 Lottie:** `src/export/lottie.ts` (`docToLottie`, `exportLottie`), format "Lottie" in the export dialog with
  a "Left out" list; `fontLibrary.glyphPath` (shaped glyph ids). Exact keys for linear / bezier / hold when they
  reproduce every frame; spring / bounce / steps, enter/exit/loop presets, colour blends and per-glyph animators
  baked per frame. Left out (listed): effects, adjustment layers, shadows, glow, border, window frame, 3D tilt,
  video, mesh / image backgrounds, glyph loops, per-glyph skew / 3D flip / blur / tint / scramble; above 20 MB
  the per-glyph animation is dropped (listed). `lottie-web@5.13.0` devDependency (test player only).

| Gate | Result |
|---|---|
| Save / apply / copy round-trip | apply onto a layer 1100 px away at half size = source shifted / scaled at 6 times; one undo |
| Survives reload, export / import | yes; 4 bad files give readable errors |
| Lottie plays in lottie-web with matching timing | image centres Δ ≤ 0.009 px, bezier mid-points 0.0065 px, baked spring 0.004 px, background colour ≤ 1.04/255, text bounds 0.84 px; fr / op match |
| Unsupported parts listed | "Left out" list in the dialog (mixed scene names effects, video) |
| Unit tests | 236/236 |
| axe | 20/20 states |

Suites: full `e2e` chain (now with `e2e-presets` and `e2e-lottie`) on Chrome WebGPU, WebGL2 and Firefox — green
after two test fixes found by the chain run: `e2e-presets` waited on a promise with `waitForFunction` (Firefox
flake) and reloaded before the debounced autosave had written. axe found the Apply button's label didn't contain
its visible text (fixed: visible name + hidden "Apply" prefix). Known speed-only miss under load: MP4 1080p 5 s
export 5.97 s once (passed on rerun).

Known limits: mid-animation per-glyph poses checked by eye, not number by number; Lottie blends extra gradient
stops in sRGB (close, not identical); only lottie-web tested (not iOS / Android players).
