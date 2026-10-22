# Milestone I — "Easing & curves"

Source: `CAPABILITY-MAP-phase3.md` (module `easing-editor`). Branch: `phase3`. Coordinator builds the doc layer
and reviews everything; a Sonnet worker may build the curve editor component and the e2e check (reviewed and
re-run by the coordinator); Haiku runs the full suites.

> 🧒 **In plain words:** between two keyframes the value has to travel somehow — evenly, fast then slow, overshoot
> and settle, jump. Today each key already stores that "how" (its easing), but you can only pick from a short
> list in a few places, and never per keyframe. After I you select keys in the timeline, open an easing editor,
> pick a preset or drag a curve / tune a spring, and watch a live preview — and the export moves exactly the same.

## What exists (verified in code)

- `Keyframe.out: Easing` — the easing from this key to the next (`src/doc/types.ts`). Kinds: `linear`, `hold`,
  `bezier {x1,y1,x2,y2}`, `spring {mass,stiffness,damping}`, `steps {n}`.
- `ease()` / `cubicBezier()` / `spring()` in `src/doc/easing.ts`; preview and export both sample through it.
- Two separate preset lists with a plain dropdown: `EASINGS` in `src/app/AnimationSection.tsx` (enter/exit
  presets) and `EASING_PRESETS` in `src/app/Inspector.tsx` (text animator). No UI edits a key's easing; new keys
  get ease-in-out cubic.
- `spring()` stretches the spring to fit the time between the keys (p = 1 → 6 time constants) and snaps to 1 at
  the end. Measured: bouncy springs jump ≤ 0.25 % of the move at the end (e.g. 2.5 px on 1000 px), but heavily
  damped ones jump a lot — damping 40 → 20 %, damping 80 → 56 % — because the over-damped case uses the
  critically-damped formula with a settle time that is too short.

## Gate

- Presets match the browser's own CSS `cubic-bezier()` and `steps()` exactly (compared against the Web Animations
  API in Chrome and Firefox, ≤ 0.001 difference at 101 points).
- Editing a curve shows live on the canvas and in the editor preview; the exported frame = the preview frame
  (pixel-identical) at several times across an edited segment.
- Spring: the curve shown in the editor = the values the canvas renders; it ends on the next key's value with
  no visible jump.
- Curve handles, spring and steps controls are fully keyboard-editable; axe clean.
- Each easing change (a whole handle drag, applied to all selected keys) is one undo step.
- Old projects open unchanged and render byte-identically (except the spring end-jump fix, see decision 3).
- Chrome WebGPU, WebGL2 and Firefox suites green.

## Design decisions (recommendations — confirm or change)

1. **Bounce gets its own easing kind; elastic is a spring.** CSS cubic-bezier cannot bounce (the value bounces
   off the target several times). Add `{ kind: 'bounce'; n: number }` (number of bounces, default 3, standard
   "ease out bounce" shape). "Elastic" is a preset of the existing spring with low damping, so no new kind.
   Adding a kind changes the saved format → **schema v8** with an empty migration (old files open as-is; an
   older Glyphix build refuses a v8 file with the existing "saved by a newer version" message).
   *Alternative:* no bounce at all (no schema change). *Cost later:* Lottie (Milestone K) can't express bounce or
   spring natively either way; K will bake them into many small keys.
2. **Spring keeps fitting the gap between keys** (today's behaviour): stiffness/damping change the *shape*,
   the keyframe times decide the *duration*. A "physical" spring that decides its own duration would fight the
   keys you placed on the timeline.
3. **Fix the spring end-jump:** use the real over-damped formula and a settle time from its slowest decay, then
   remove the small leftover linearly over the segment so the curve lands exactly on 1. Changes existing spring
   renders: bouncy springs (the Springy/Wobbly presets, the current "Spring" preset) by ≤ 0.3 % of the move;
   heavily damped springs visibly (they were jumping). The only intentional visual change; the old-project
   byte-identical check excludes spring keys.
4. **One preset registry in `src/doc/easing.ts`** (`EASING_PRESETS: { id, label, easing }[]`), used by the
   timeline, the inspector, enter/exit presets and the text animator (replacing the two app-side lists).
   Presets: Linear, Hold, CSS ease / ease-in / ease-out / ease-in-out (exact CSS values), ease in/out/in-out
   cubic (existing values, so old projects still show their names), back out, back in-out, bounce, spring,
   elastic, steps (4). Anything else shows as "Custom".
5. **Steps match CSS `steps(n, jump-end)`** (today's formula). Other CSS step positions are out of scope.
6. **What you edit:** the easing *leaving* each selected key (the segment to the next key). With several keys
   selected the edit applies to all of them (one undo step); if they differ the editor says "Mixed" until you
   pick something. The last key of a property has no next key — it's skipped and the editor says so.

## UI

- **Easing editor** (`src/app/EasingEditor.tsx`, a popover, reused everywhere):
  - Preset grid: each preset a button with a small curve picture and its name; the current one is pressed.
  - Curve area (bezier): the curve on a 0–1 box with room for overshoot (y from −0.5 to 1.5); two round handles
    on stems from the corners. Drag a handle (x clamped to 0–1, like CSS). Keyboard: each handle is focusable;
    arrows move it by 0.01, Shift by 0.1; its label reads "Handle 1: x 0.33, y 1.00". Plus four number inputs
    (x1, y1, x2, y2) and a "copy as CSS" text `cubic-bezier(…)`.
  - Spring: three sliders (mass, stiffness, damping) with the curve redrawn live.
  - Steps: number of steps; Bounce: number of bounces.
  - Live preview: a dot travelling along a bar on loop, using the same `ease()` as the renderer.
  - Edits apply to the document live while dragging (canvas updates), committed as one undo step.
- **Timeline:** keys show their easing by shape (diamond = curve, square = hold, circle = linear) — still CSS
  background images, so no speed cost. "Easing…" button in the timeline header (enabled when keys are selected)
  and **E** shortcut open the editor for the selected keys.
- **Inspector:** when keys are selected, a "Keyframes" section shows "n keys selected" and the easing button.
- **Enter/exit presets and the text animator:** the plain dropdowns become the same editor (button showing the
  current preset's name and curve).

## Tasks

- **I1 — doc:** bounce kind + schema v8 (empty migration), spring end fix, `EASING_PRESETS` + `easingName`,
  `setKeyEasing(prop, times, easing, fps)` pure op, unit tests (CSS reference values, bounce ends on 1, spring
  lands on 1 with no jump, steps, v7→v8 migration, preset round-trip).
- **I2 — EasingEditor component** (curve, handles, keyboard, number inputs, spring/steps/bounce controls,
  preview). One gesture per drag.
- **I3 — wiring:** timeline key shapes + header button + E; inspector Keyframes section; enter/exit and animator
  pickers switched to the editor; remove the duplicate preset lists.
- **I4 — checks + status:** `scripts/e2e-easing.mjs` (CSS match via Web Animations API, live edit preview =
  export pixels, keyboard handles, one undo step per drag, multi-key apply, Mixed state, last-key skip);
  axe states (editor open with bezier / spring); unit + all suites on Chrome WebGPU, WebGL2, Firefox; status
  section here.

## Not in I

Whole-property value graph (decided: only if needed later), separate in/out easing per side of a key (After
Effects "influence"), CSS `steps(n, start)` and other step positions, motion paths on the canvas.

## Risks

- Bezier y-overshoot values outside a property's valid range (e.g. opacity > 1, scale < 0): the renderer must
  clamp where it matters. Check opacity / scale / blur params under "back" easing.
- Handle dragging precision on small popovers; keep the curve area ≥ 200 px and number inputs as the exact path.

## Status (2026-10-18)

Built: I1 (bounce kind + schema v8, spring fix, preset registry, `setKeyEasing`, `cssEasing`), I2 (`EasingEditor`:
presets with curve pictures, bezier handles by mouse and keyboard, number inputs, copy as CSS, spring / steps /
bounce controls, live preview), I3 (timeline header button + **E**, key shapes by easing, inspector Keyframes
section, enter/exit and glyph-animator pickers use the editor; the two app-side preset lists are gone).

Also fixed while building: overshooting curves (back, elastic, spring) are clamped for layer opacity (0–1), scale
(≥ 0), glow (≥ 0) and effect params (their min–max) — **only when animated**; static values are used exactly as
saved (an ASCII line height of 2.4 above the slider's 2 still works, so old projects render unchanged).

| Gate | Result |
|---|---|
| Presets = browser CSS `cubic-bezier()` / `steps()` (Web Animations API, 12 presets × 101 points) | worst Δ 0.00001 (Chrome WebGPU, WebGL2, Firefox) |
| Live edit on canvas; export frame = doc-API frame at 0.2 / 0.5 / 0.8 s | Δ 0 (vs original Δ 228) |
| Heavily damped spring (damping 100) lands without a jump | biggest 1 ms step 0.34 px on a 60 px move; 640.00 px 1 ms before the key |
| Keyboard handles, one undo step per pick / drag / nudge run, multi-key, Mixed, last key skipped | `e2e-easing` 25/25 on 3 setups (incl. arrows / Delete inside the editor change nothing) |
| axe | 16/16 states clean (new: editor with curve handles, editor with spring) |
| Unit tests | 201/201 |

Measured (unit test): before the fix heavily damped springs jumped at the end (damping 40: 20 % of the move, 80:
56 %); bouncy springs change ≤ 0.3 %.

Known limits: key shapes show only linear / hold / curve (spring, bounce and steps draw as curve diamonds).

Suites: full `e2e` chain on Chrome WebGPU, WebGL2 and Firefox — functional checks green. Speed-only misses under
load, as before: Firefox 4K-layer drag p95 33 ms (also on `main`), one Chrome WebGL2 MP4 export at 5.85 s (passed
on retry). Test-harness lesson: pass an output folder to the scripts; with the default `.` they write `.html`
files into the project root, which makes Vite reload the page under the running test.
