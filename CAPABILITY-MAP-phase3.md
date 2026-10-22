# Capability Map: Glyphix — Phase 3 (Motion studio, then desktop)

Status: **Planning — timeline first (milestones H–K), desktop afterwards (planned later).** Built milestone by
milestone, like Phases 1–2.
Source: `RESEARCH.md` §8.2 (Phase 3), the Phase 2 code, user decisions 2026-10-18.

> 🧒 **In plain words:** Glyphix can already animate things with presets and a few keyframes. Phase 3 gives it a
> real timeline, like a video editor: see every layer and every keyframe over time, drag them to change timing,
> shape how things move with curves, animate colours and text, save your own animations, and export Lottie.
> Then (later) it becomes a Mac/Windows app.

## Where we start (verified in code, 2026-10-18)

- The doc model already has keyframe tracks: `Prop<V> = { static } | { track: { keys: { t, v, out: Easing }[] } }`
  with easings `linear | hold | bezier | spring | steps` (`src/doc/types.ts`), sampled by `sampleProp`
  (`src/doc/evaluate.ts`).
- Keyframable today (numbers only): layer opacity, transform x / y / scale / rotation, tilt rotateX / rotateY,
  background glow, every effect param. Not keyframable: colours, text, gradients, border, shadow, frame.
- Animation presets per layer: enter (start, duration), exit (end offset, duration), loop (period, amount)
  (`src/doc/motion.ts`).
- UI: the "timeline" is a play button, a playhead slider and a length box (`Timeline` in `src/app/Editor.tsx`);
  keyframes are added with diamond buttons in the inspector. No tracks, no keyframe view, no easing UI.
- Layers have no in/out times (always visible); only video clips have start / trim.
- Reuse check: Theatre.js studio is AGPL-3.0 (not usable); `@xzdarcy/react-timeline-editor` (MIT) is a generic
  block strip with its own data model. Decision: build our own timeline UI on our doc model.

## Phase 3 goal (timeline part, one sentence)

A user opens the timeline, sees every layer's bar, presets and keyframes over time, drags them to retime,
picks or draws the easing of any keyframe, animates colours and text as well as numbers, saves an animation as
a preset to reuse on other layers, and exports MP4/WebM/GIF/PNG or a Lottie file — with preview = export.

## Modules

| Module id | Responsibility | Depends on |
|---|---|---|
| `layer-timing` | Layer in/out points (`timing: { in, out }`, schema v7, old projects visible the whole time); evaluate skips layers outside; presets and video clips stay relative to the comp | `doc-model` |
| `timeline-panel` | Bottom dock replacing the playhead slider: ruler (zoom, scroll, frame ticks, timecode), playhead scrub, layer rows (name column, visibility/lock), in/out bars, enter/exit/loop preset bars (drag edges to retime), expandable property rows | `layer-timing` |
| `keyframe-editing` | Keyframe diamonds per property row; select (click, Shift, box), move with snapping (frames, keys, playhead, in/out), delete, copy/paste, add at playhead, nudge by frame, jump to previous/next key; one undo step per gesture | `timeline-panel` |
| `easing-editor` | Per-keyframe easing: preset menu (ease in/out/in-out, back, bounce, elastic, steps, hold), draggable cubic-bezier curve, spring (mass, stiffness, damping) with live preview; shown in the timeline and the inspector | `keyframe-editing` |
| `animate-everything` | `Prop<Color>` (interpolated in OKLab), keyframable gradient stops, text content (hold keys), shadow, border, frame and effect colours; migrations from static values; renderer reads sampled values | `doc-model`, `keyframe-editing` |
| `animation-presets` | Save a layer's keyframes + motion as a user preset (relative to the layer's values), apply to other layers, copy/paste animation between layers, library in IndexedDB with export/import (.json) | `keyframe-editing`, `persistence` |
| `lottie-export` | Lottie JSON export of the vector-representable subset: images (embedded), transforms, opacity, text as glyph shapes, solid/gradient backgrounds, keyframes with easing; clear report of what was left out (GPU effects, ASCII, video) | `animate-everything`, `export` |

## Build order

```
Milestone H — "Timeline"
  layer-timing → timeline-panel → keyframe-editing
  ✔ Gate: 50 layers × ~10 animated props (hundreds of keys): timeline drag/scrub at 60 fps, playback unaffected
          (no timeline re-render per frame); each drag = one undo step; in/out points match preview = export;
          old projects unchanged; every timeline action keyboard-reachable; axe clean

Milestone I — "Easing & curves"
  easing-editor
  ✔ Gate: presets match CSS cubic-bezier / steps exactly; curve edits show live and export identically;
          spring settles like the preview; keyboard-editable curve handles

Milestone J — "Keyframe everything"
  animate-everything
  ✔ Gate: colour, gradient, text, shadow, border, frame, effect-colour keys interpolate (colour in OKLab);
          WebGPU = WebGL2; preview = export; v6 projects migrate unchanged

Milestone K — "Presets & reuse" (+ Lottie)
  animation-presets → lottie-export
  ✔ Gate: save/apply/copy animation round-trips; presets survive reload and export/import; Lottie output
          validates and plays in lottie-web with matching timing for the supported subset; unsupported parts listed

Desktop (Tauri) — planned after K: native capture, clipboard, system fonts, native OCR, ProRes 4444 via
FFmpeg-LGPL, big-file streaming; C8 (export in a Worker) belongs there.
```

## Decisions (user, 2026-10-18)

- Timeline first; desktop later in Phase 3.
- Layers get in/out points.
- Easing: per-keyframe curve editor (menu + bezier + spring); a whole-property value graph only if needed later.
- Lottie export stays in Phase 3 (Milestone K).
- Phase 2 leftovers (Brave export fix, AAC in MP4) stay in the open list (`CAPABILITY-MAP-phase2.md`), as do the
  deferred Milestone G (redact/OCR) and right-click menus.

## Risks

- Timeline UX depth: drag feel, snapping and zoom need iteration; keep a scripted UX check per gesture.
- Playback performance: the playhead must move without re-rendering the timeline (ref-driven), or the editor
  drops below 60 fps.
- `animate-everything` touches many renderer reads; preview = export and old-project migrations need wide tests.
- Lottie can only represent part of a Glyphix scene; must say clearly what is dropped.

## Explicitly NOT in Phase 3 (timeline part)

Audio waveform editing, multi-comp / nested comps, expressions, motion paths drawn on the canvas, collaboration.
