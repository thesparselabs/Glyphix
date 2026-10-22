// Motion presets. A layer stores *which* preset it uses (data); the pure evaluator turns that
// into modifiers on top of the layer's own properties, or (for text) into glyph animators that
// the GPU expands per glyph / word / line. Nothing is baked into keyframes, so editing stays simple.
import { ease, Easings } from './easing';
import { REST_POSE, type Comp, type Easing, type GlyphAnimator, type GlyphPose, type GlyphUnit, type StaggerOrder } from './types';

// ---------------------------------------------------------------------------
// Preset ids
// ---------------------------------------------------------------------------

/** Whole-layer presets (any layer). */
type LayerEnter = 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'zoom-in' | 'pop' | 'tilt-in';
type LayerExit = 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'zoom-out' | 'pop' | 'tilt-out';

export type GlyphEnterPreset =
  | 'rise'
  | 'typewriter'
  | 'cascade'
  | 'scatter'
  | 'blur-in'
  | 'flip-up'
  | 'spin-in'
  | 'drop'
  | 'shrink-in'
  | 'elastic'
  | 'swing-in'
  | 'track-in'
  | 'decode'
  | 'word-rise'
  | 'word-pop'
  | 'line-slide'
  | 'skew-in'
  | 'color-sweep';

export type GlyphExitPreset = 'sink' | 'blur-out' | 'flip-down' | 'scatter-out' | 'track-out' | 'erase' | 'decode-out' | 'word-fall';

export type EnterPreset = LayerEnter | GlyphEnterPreset;
export type ExitPreset = LayerExit | GlyphExitPreset;

/** Whole-layer loops, and per-glyph emphasis loops (text, computed in the glyph shader). */
export type GlyphLoopKind = 'wave' | 'jitter' | 'flicker' | 'swing' | 'breathe' | 'rainbow' | 'bounce';
export type LoopPreset = 'float' | 'ken-burns' | 'pulse' | GlyphLoopKind;

/** Optional overrides of how a per-glyph preset steps through the text. */
export interface StaggerOptions {
  unit?: GlyphUnit;
  order?: StaggerOrder;
  /** Share of the total duration each unit animates for (0.05..1); the rest is stagger. */
  overlap?: number;
  /** Distribution of start times across units (linear = evenly spaced). */
  falloff?: Easing;
}

export interface EnterMotion {
  preset: EnterPreset;
  /** Seconds from the layer's in point (comp start for layers that start at 0). */
  start: number;
  /** Seconds; for per-glyph text presets this is the whole line's duration. */
  duration: number;
  easing: Easing;
  stagger?: StaggerOptions;
}

export interface ExitMotion {
  preset: ExitPreset;
  /** Seconds before the layer's out point (the comp end by default) when the exit finishes (0 = right at the out point). */
  endOffset: number;
  duration: number;
  easing: Easing;
  stagger?: StaggerOptions;
}

export interface LoopMotion {
  preset: LoopPreset;
  /** Seconds per cycle. Cycles are seamless (start and end of a cycle match). */
  period: number;
  /** 0..1 strength; each preset maps it to a sensible range. */
  amount: number;
}

export interface Motion {
  enter: EnterMotion | null;
  exit: ExitMotion | null;
  loop: LoopMotion | null;
}

export const NO_MOTION: Motion = { enter: null, exit: null, loop: null };

// ---------------------------------------------------------------------------
// Preset tables
// ---------------------------------------------------------------------------

export interface PresetInfo<P extends string> {
  id: P;
  label: string;
  /** Which layer types offer it. */
  for: ('image' | 'text')[];
  easing: Easing;
  /** Per-glyph text preset (compiled to a glyph animator). */
  glyph?: boolean;
}

const easeInCubic = Easings.easeInCubic;
const springy: Easing = { kind: 'spring', mass: 1, stiffness: 180, damping: 11 };
const wobbly: Easing = { kind: 'spring', mass: 1, stiffness: 240, damping: 9 };

interface GlyphPresetDef {
  label: string;
  unit: GlyphUnit;
  order: StaggerOrder;
  /** Share of the total each unit animates for; 'steps' = one unit after another, instantly (typewriter). */
  overlap: number | 'steps';
  easing: Easing;
  pose: Partial<GlyphPose>;
}

const ACCENT: GlyphPose['color'] = [1, 0.82, 0.35, 1];

const GLYPH_ENTER: Record<GlyphEnterPreset, GlyphPresetDef> = {
  rise: { label: 'Rise', unit: 'glyph', order: 'forward', overlap: 0.45, easing: Easings.easeOutBack, pose: { offsetY: 60, scaleX: 0.6, scaleY: 0.6, opacity: 0 } },
  typewriter: { label: 'Typewriter', unit: 'glyph', order: 'forward', overlap: 'steps', easing: { kind: 'hold' }, pose: { opacity: 0 } },
  cascade: { label: 'Cascade', unit: 'glyph', order: 'center', overlap: 0.5, easing: Easings.easeOutBack, pose: { offsetY: -50, scaleX: 0.4, scaleY: 0.4, rotation: -18, opacity: 0 } },
  scatter: { label: 'Scatter', unit: 'glyph', order: 'random', overlap: 0.55, easing: Easings.easeOutCubic, pose: { scaleX: 2.2, scaleY: 2.2, rotation: 40, opacity: 0 } },
  'blur-in': { label: 'Blur in', unit: 'glyph', order: 'forward', overlap: 0.6, easing: Easings.easeOutCubic, pose: { blur: 0.2, scaleX: 1.15, scaleY: 1.15, opacity: 0 } },
  'flip-up': { label: 'Flip up', unit: 'glyph', order: 'forward', overlap: 0.5, easing: Easings.easeOutCubic, pose: { rotateX: -90, offsetY: 20, opacity: 0 } },
  'spin-in': { label: 'Spin in', unit: 'glyph', order: 'random', overlap: 0.5, easing: Easings.easeOutBack, pose: { rotation: 180, scaleX: 0, scaleY: 0, opacity: 0 } },
  drop: { label: 'Drop', unit: 'glyph', order: 'forward', overlap: 0.5, easing: springy, pose: { offsetY: -140, opacity: 0 } },
  'shrink-in': { label: 'Shrink in', unit: 'glyph', order: 'center', overlap: 0.5, easing: Easings.easeOutCubic, pose: { scaleX: 3, scaleY: 3, blur: 0.1, opacity: 0 } },
  elastic: { label: 'Elastic', unit: 'glyph', order: 'forward', overlap: 0.55, easing: wobbly, pose: { scaleX: 1.6, scaleY: 0.1, opacity: 0 } },
  'swing-in': { label: 'Swing in', unit: 'glyph', order: 'forward', overlap: 0.5, easing: Easings.easeOutBack, pose: { rotateY: 90, opacity: 0 } },
  'track-in': { label: 'Track in', unit: 'glyph', order: 'center', overlap: 0.9, easing: Easings.easeOutCubic, pose: { spread: 2.6, blur: 0.08, opacity: 0 } },
  decode: { label: 'Decode', unit: 'glyph', order: 'random', overlap: 0.6, easing: Easings.easeOutCubic, pose: { scramble: true, opacity: 0 } },
  'word-rise': { label: 'Word rise', unit: 'word', order: 'forward', overlap: 0.6, easing: Easings.easeOutCubic, pose: { offsetY: 50, blur: 0.05, opacity: 0 } },
  'word-pop': { label: 'Word pop', unit: 'word', order: 'forward', overlap: 0.5, easing: Easings.easeOutBack, pose: { scaleX: 0.3, scaleY: 0.3, opacity: 0 } },
  'line-slide': { label: 'Line slide', unit: 'line', order: 'forward', overlap: 0.6, easing: Easings.easeOutCubic, pose: { offsetX: -120, blur: 0.1, opacity: 0 } },
  'skew-in': { label: 'Skew in', unit: 'glyph', order: 'forward', overlap: 0.5, easing: Easings.easeOutCubic, pose: { skewX: -35, offsetX: 60, opacity: 0 } },
  'color-sweep': { label: 'Colour sweep', unit: 'glyph', order: 'forward', overlap: 0.5, easing: Easings.easeOutCubic, pose: { color: ACCENT, offsetY: 20, opacity: 0 } },
};

const GLYPH_EXIT: Record<GlyphExitPreset, GlyphPresetDef> = {
  sink: { label: 'Sink', unit: 'glyph', order: 'forward', overlap: 0.45, easing: easeInCubic, pose: { offsetY: 60, scaleX: 0.6, scaleY: 0.6, opacity: 0 } },
  'blur-out': { label: 'Blur out', unit: 'glyph', order: 'forward', overlap: 0.6, easing: easeInCubic, pose: { blur: 0.2, opacity: 0 } },
  'flip-down': { label: 'Flip down', unit: 'glyph', order: 'forward', overlap: 0.5, easing: easeInCubic, pose: { rotateX: 90, offsetY: 20, opacity: 0 } },
  'scatter-out': { label: 'Scatter out', unit: 'glyph', order: 'random', overlap: 0.55, easing: easeInCubic, pose: { randomOffset: 220, randomRotation: 90, opacity: 0 } },
  'track-out': { label: 'Track out', unit: 'glyph', order: 'center', overlap: 0.9, easing: easeInCubic, pose: { spread: 2.6, blur: 0.08, opacity: 0 } },
  erase: { label: 'Erase', unit: 'glyph', order: 'reverse', overlap: 'steps', easing: { kind: 'hold' }, pose: { opacity: 0 } },
  'decode-out': { label: 'Decode out', unit: 'glyph', order: 'random', overlap: 0.6, easing: easeInCubic, pose: { scramble: true, opacity: 0 } },
  'word-fall': { label: 'Word fall', unit: 'word', order: 'forward', overlap: 0.6, easing: easeInCubic, pose: { offsetY: 80, rotation: 8, opacity: 0 } },
};

const layerPreset = <P extends string>(id: P, label: string, easing: Easing): PresetInfo<P> => ({ id, label, for: ['image', 'text'], easing });

export const ENTER_PRESETS: PresetInfo<EnterPreset>[] = [
  layerPreset('fade', 'Fade', Easings.easeOutCubic),
  layerPreset('slide-up', 'Slide up', Easings.easeOutCubic),
  layerPreset('slide-down', 'Slide down', Easings.easeOutCubic),
  layerPreset('slide-left', 'Slide left', Easings.easeOutCubic),
  layerPreset('slide-right', 'Slide right', Easings.easeOutCubic),
  layerPreset('zoom-in', 'Zoom in', Easings.easeOutCubic),
  layerPreset('pop', 'Pop', Easings.easeOutBack),
  { id: 'tilt-in', label: '3D tilt in', for: ['image'], easing: Easings.easeOutCubic },
  ...Object.entries(GLYPH_ENTER).map(([id, d]) => ({ id: id as GlyphEnterPreset, label: d.label, for: ['text' as const], easing: d.easing, glyph: true })),
];

export const EXIT_PRESETS: PresetInfo<ExitPreset>[] = [
  layerPreset('fade', 'Fade', easeInCubic),
  layerPreset('slide-up', 'Slide up', easeInCubic),
  layerPreset('slide-down', 'Slide down', easeInCubic),
  layerPreset('slide-left', 'Slide left', easeInCubic),
  layerPreset('slide-right', 'Slide right', easeInCubic),
  layerPreset('zoom-out', 'Zoom out', easeInCubic),
  layerPreset('pop', 'Pop', easeInCubic),
  { id: 'tilt-out', label: '3D tilt out', for: ['image'], easing: easeInCubic },
  ...Object.entries(GLYPH_EXIT).map(([id, d]) => ({ id: id as GlyphExitPreset, label: d.label, for: ['text' as const], easing: d.easing, glyph: true })),
];

export const LOOP_PRESETS: PresetInfo<LoopPreset>[] = [
  layerPreset('float', 'Float', Easings.linear),
  layerPreset('pulse', 'Pulse', Easings.linear),
  { id: 'ken-burns', label: 'Ken Burns', for: ['image'], easing: Easings.linear },
  ...(
    [
      ['wave', 'Wave'],
      ['bounce', 'Bounce'],
      ['swing', 'Swing'],
      ['breathe', 'Breathe'],
      ['jitter', 'Jitter'],
      ['flicker', 'Flicker'],
      ['rainbow', 'Rainbow'],
    ] as const
  ).map(([id, label]) => ({ id, label, for: ['text' as const], easing: Easings.linear, glyph: true })),
];

export const isGlyphPreset = (p: EnterPreset) => p in GLYPH_ENTER;
export const isGlyphExit = (p: ExitPreset) => p in GLYPH_EXIT;
export const isGlyphLoop = (p: LoopPreset): p is GlyphLoopKind => LOOP_PRESETS.some((l) => l.id === p && l.glyph);

/** Default unit/order/overlap of a per-glyph preset (what the "advanced" controls start from). */
export function glyphPresetDefaults(preset: EnterPreset | ExitPreset, kind: 'enter' | 'exit'): Required<Omit<StaggerOptions, 'overlap'>> & { overlap: number | 'steps' } | null {
  const def = kind === 'enter' ? GLYPH_ENTER[preset as GlyphEnterPreset] : GLYPH_EXIT[preset as GlyphExitPreset];
  if (!def) return null;
  return { unit: def.unit, order: def.order, overlap: def.overlap, falloff: Easings.linear };
}

export function defaultEnter(preset: EnterPreset, start = 0): EnterMotion {
  const info = ENTER_PRESETS.find((p) => p.id === preset)!;
  return { preset, start, duration: preset === 'typewriter' ? 1.2 : 0.8, easing: info.easing };
}

export function defaultExit(preset: ExitPreset): ExitMotion {
  const info = EXIT_PRESETS.find((p) => p.id === preset)!;
  return { preset, endOffset: 0, duration: preset === 'erase' ? 0.8 : 0.6, easing: info.easing };
}

export function defaultLoop(preset: LoopPreset, comp: Pick<Comp, 'duration'>): LoopMotion {
  // Ken Burns spans the whole comp; other cycles are snapped so a whole number fits the comp,
  // which keeps a looping export seamless.
  const base = preset === 'ken-burns' ? comp.duration : preset === 'wave' || preset === 'bounce' ? 1.6 : preset === 'jitter' || preset === 'flicker' ? 1 : preset === 'rainbow' ? 2.5 : 3;
  const cycles = Math.max(1, Math.round(comp.duration / base));
  return { preset, period: comp.duration > 0 ? comp.duration / cycles : base, amount: 0.5 };
}

/** When an exit starts, given the comp length. */
export const exitStart = (exit: ExitMotion, comp: Pick<Comp, 'duration'>) => comp.duration - exit.endOffset - exit.duration;

// ---------------------------------------------------------------------------
// Whole-layer modifiers
// ---------------------------------------------------------------------------

/** What motion does to a layer at time t, on top of its own props. Identity = no change. */
export interface Modifiers {
  dx: number;
  dy: number;
  /** Multiplies the layer's scale. */
  scale: number;
  /** Degrees added to rotation. */
  rotation: number;
  /** Multiplies opacity. */
  opacity: number;
  /** Degrees added to the 3D tilt (images). */
  tiltX: number;
  tiltY: number;
}

export const IDENTITY: Modifiers = { dx: 0, dy: 0, scale: 1, rotation: 0, opacity: 1, tiltX: 0, tiltY: 0 };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/** Travel distance for slides, proportional to the comp so presets look the same at any size. */
const slideDistance = (comp: Pick<Comp, 'width' | 'height'>) => 0.09 * Math.min(comp.width, comp.height);

/**
 * Apply a whole-layer pose at "awayness" k (0 = rest, 1 = fully away) to m.
 * `fade` is the opacity factor to use (enter fades in early, exit fades out late).
 */
function applyLayerPose(m: Modifiers, preset: LayerEnter | LayerExit, k: number, fade: number, d: number, exiting: boolean) {
  switch (preset) {
    case 'fade':
      m.opacity *= clamp01(1 - k);
      return;
    case 'slide-up':
      m.dy += (exiting ? -k : k) * d;
      break;
    case 'slide-down':
      m.dy += (exiting ? k : -k) * d;
      break;
    case 'slide-left':
      m.dx += (exiting ? -k : k) * d;
      break;
    case 'slide-right':
      m.dx += (exiting ? k : -k) * d;
      break;
    case 'zoom-in':
      m.scale *= mix(1, 0.85, k);
      break;
    case 'zoom-out':
      m.scale *= mix(1, 1.15, k);
      break;
    case 'pop':
      m.scale *= mix(1, 0.5, k);
      break;
    case 'tilt-in':
    case 'tilt-out':
      m.tiltX += k * (exiting ? -38 : 38);
      m.tiltY += -k * 24;
      m.dy += k * d * (exiting ? -0.6 : 0.6);
      break;
  }
  m.opacity *= fade;
}

/**
 * Whole-layer modifiers for time t. For text layers, per-glyph presets are *not* applied here
 * (see glyphAnimators); their whole-layer part is identity.
 */
export function motionModifiers(motion: Motion, t: number, comp: Pick<Comp, 'width' | 'height' | 'duration'>, layerType: 'image' | 'text'): Modifiers {
  const m = { ...IDENTITY };
  const d = slideDistance(comp);
  const enter = motion.enter;
  if (enter && !(layerType === 'text' && isGlyphPreset(enter.preset))) {
    const p = enter.duration > 0 ? clamp01((t - enter.start) / enter.duration) : 1;
    // Opacity follows linear progress (fast-in) so overshooting easings never push it past 1.
    applyLayerPose(m, enter.preset as LayerEnter, 1 - ease(enter.easing, p), clamp01(p * 2.5), d, false);
  }
  const exit = motion.exit;
  if (exit && !(layerType === 'text' && isGlyphExit(exit.preset))) {
    // Measured from the end so the last moment is exactly p = 1 (no floating-point leftovers).
    const end = comp.duration - exit.endOffset;
    const p = exit.duration > 0 ? clamp01((t - end) / exit.duration + 1) : t >= end ? 1 : 0;
    applyLayerPose(m, exit.preset as LayerExit, ease(exit.easing, p), clamp01((1 - p) * 2.5), d, true);
  }
  const loop = motion.loop;
  if (loop && loop.period > 0) {
    const phase = (2 * Math.PI * t) / loop.period;
    const a = loop.amount;
    switch (loop.preset) {
      case 'float':
        m.dy += Math.sin(phase) * mix(4, 28, a) * (Math.min(comp.width, comp.height) / 1080);
        break;
      case 'pulse':
        m.scale *= 1 + (0.5 - 0.5 * Math.cos(phase)) * mix(0.01, 0.08, a);
        break;
      case 'ken-burns':
        // Ping-pong zoom + pan: seamless when the period equals the comp duration.
        m.scale *= 1 + (0.5 - 0.5 * Math.cos(phase)) * mix(0.03, 0.18, a);
        m.dx += Math.sin(phase) * mix(4, 30, a);
        break;
      default:
        break; // per glyph, in the shader
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// Per-glyph presets → glyph animators
// ---------------------------------------------------------------------------

/** How many units a text has (what the stagger steps through). Mirrors the renderer's unit split. */
export function unitCount(text: string, unit: GlyphUnit): number {
  switch (unit) {
    case 'glyph':
      return text.replace(/\s/g, '').length;
    case 'word':
      return (text.match(/\S+/g) ?? []).length;
    case 'line':
      return text.split('\n').filter((l) => /\S/.test(l)).length;
  }
}

/** Visible glyph count as the evaluator sees it (shaping may merge a few; ranks still cover them). */
export const glyphCount = (text: string) => unitCount(text, 'glyph');

/** Highest stagger rank an order produces for `count` units (center/edges share ranks). */
export const maxRank = (count: number, order: StaggerOrder) => Math.max(0, order === 'center' || order === 'edges' ? Math.round((count - 1) / 2) : count - 1);

function compile(def: GlyphPresetDef, start: number, total: number, easing: Easing, opts: StaggerOptions | undefined, text: string): GlyphAnimator {
  const unit = opts?.unit ?? def.unit;
  const order = opts?.order ?? def.order;
  const n = Math.max(1, unitCount(text, unit));
  // Steps between the first and the last unit to start: the whole text finishes at start + total.
  const last = maxRank(n, order);
  const span = Math.max(0.01, total);
  const steps = def.overlap === 'steps' && opts?.overlap === undefined;
  const overlap = last === 0 ? 1 : Math.min(1, Math.max(0.05, opts?.overlap ?? (def.overlap === 'steps' ? 1 / (last + 1) : def.overlap)));
  return {
    unit,
    order,
    start,
    // Typewriter-style presets: each unit appears instantly, one after another.
    duration: steps ? span / (last + 1) : span * overlap,
    stagger: steps ? span / (last + 1) : last > 0 ? (span * (1 - overlap)) / last : 0,
    falloff: opts?.falloff ?? Easings.linear,
    seed: 7,
    easing,
    pose: { ...REST_POSE, ...def.pose },
  };
}

/** Compile a text enter preset into a glyph animator. `duration` is the whole text's duration. */
export function glyphAnimatorFor(enter: EnterMotion, text: string): GlyphAnimator | null {
  const def = GLYPH_ENTER[enter.preset as GlyphEnterPreset];
  return def ? compile(def, enter.start, enter.duration, enter.easing, enter.stagger, text) : null;
}

/** Compile a text exit preset; it finishes `endOffset` seconds before the comp ends. */
export function glyphExitFor(exit: ExitMotion, text: string, comp: Pick<Comp, 'duration'>): GlyphAnimator | null {
  const def = GLYPH_EXIT[exit.preset as GlyphExitPreset];
  return def ? compile(def, exitStart(exit, comp), exit.duration, exit.easing, exit.stagger, text) : null;
}

/** Continuous per-glyph emphasis loop (computed in the glyph shader). */
export interface GlyphLoop {
  kind: GlyphLoopKind;
  /** Meaning depends on kind: px (wave, bounce, jitter), degrees (swing), scale delta (breathe), 0..1 (flicker, rainbow). */
  amplitude: number;
  period: number;
  /** Phase step between neighbouring glyphs, in cycles. */
  spread: number;
}

export function glyphLoopFor(loop: LoopMotion | null, fontSize: number): GlyphLoop | null {
  if (!loop || loop.period <= 0 || !isGlyphLoop(loop.preset)) return null;
  const a = loop.amount;
  const kind = loop.preset;
  switch (kind) {
    case 'wave':
      return { kind, amplitude: fontSize * mix(0.04, 0.22, a), period: loop.period, spread: 0.07 };
    case 'bounce':
      return { kind, amplitude: fontSize * mix(0.05, 0.25, a), period: loop.period, spread: 0.09 };
    case 'jitter':
      return { kind, amplitude: fontSize * mix(0.01, 0.06, a), period: loop.period, spread: 0 };
    case 'flicker':
      return { kind, amplitude: mix(0.1, 0.6, a), period: loop.period, spread: 0 };
    case 'swing':
      return { kind, amplitude: mix(4, 22, a), period: loop.period, spread: 0.1 };
    case 'breathe':
      return { kind, amplitude: mix(0.04, 0.22, a), period: loop.period, spread: 0.08 };
    case 'rainbow':
      return { kind, amplitude: mix(0.35, 1, a), period: loop.period, spread: 0.06 };
  }
}

/** Kept for older callers: the wave part of a loop. */
export const waveFor = (loop: LoopMotion | null, fontSize: number) => {
  const g = glyphLoopFor(loop, fontSize);
  return g && g.kind === 'wave' ? g : null;
};
