import { ease } from './easing';
import { resolveProps, sampleValue, type Resolved } from './animate';
import { seededPermutation } from './random';
import { frameBarHeight } from './frame';
import { isPlaced } from './types';
import { isNoOp, resolveEffects, type ResolvedEffect } from './effects';
import { videoSourceTime } from './video';
import { expandTextTokens } from './textTokens';
import { isOnScreen, layerSpan, motionOnComp } from './timing';
import { exitStart, isGlyphPreset, maxRank, glyphAnimatorFor, glyphExitFor, glyphLoopFor, motionModifiers, unitCount, type GlyphLoop, type Modifiers } from './motion';
import type {
  Color,
  CropRect,
  Doc,
  Easing,
  GlyphAnimator,
  GlyphUnit,
  BackgroundFill,
  Border,
  Frame,
  Prop,
  Shadow,
  StaggerOrder,
  TextGradient,
  TextOutline,
  TextLayer,
  TextShadow,
  Transform,
  Comp,
} from './types';

// ---------------------------------------------------------------------------
// RenderList: flat, renderer-agnostic description of one frame.
// ---------------------------------------------------------------------------

export interface ResolvedTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export interface BackgroundItem {
  kind: 'background';
  id: string;
  opacity: number;
  fill: Resolved<BackgroundFill>;
  /** Enabled effects that change the image, in order; empty = drawn directly. */
  effects: ResolvedEffect[];
}

/** Processes everything below it with `effects`; `opacity` mixes the result in. */
export interface AdjustmentItem {
  kind: 'adjustment';
  id: string;
  opacity: number;
  effects: ResolvedEffect[];
}

export interface ImageItem extends ResolvedTransform {
  kind: 'image';
  id: string;
  assetId: string;
  crop: CropRect;
  width: number;
  height: number;
  opacity: number;
  radius: number;
  shadow: Resolved<Shadow> | null;
  border: Resolved<Border> | null;
  frame: Frame;
  /** Frame bar height in comp px (scale 1); 0 when there's no frame. */
  frameBar: number;
  tilt: { rotateX: number; rotateY: number; perspective: number };
  effects: ResolvedEffect[];
  /** Video layers: which source frame to show (seconds into the file), and how loud the live preview plays. */
  video: { time: number; volume: number } | null;
}

export interface TextItem extends ResolvedTransform {
  kind: 'text';
  id: string;
  text: string;
  fontId: string;
  weight: number;
  fontSize: number;
  lineHeight: number;
  color: Color;
  gradient: Resolved<TextGradient> | null;
  outline: Resolved<TextOutline> | null;
  shadow: Resolved<TextShadow> | null;
  align: 'left' | 'center' | 'right';
  tracking: number;
  opacity: number;
  glow: number;
  glowColor: Color;
  /** Static animator templates; per-glyph expansion happens in the renderer (GPU). */
  enter: GlyphAnimator | null;
  exit: GlyphAnimator | null;
  /** Continuous per-glyph emphasis loop (GPU), or null. */
  loop: GlyphLoop | null;
  effects: ResolvedEffect[];
}

export type RenderItem = BackgroundItem | ImageItem | TextItem | AdjustmentItem;

export interface RenderList {
  width: number;
  height: number;
  /** Comp time in seconds this list was evaluated at. */
  t: number;
  items: RenderItem[];
}

// ---------------------------------------------------------------------------

export function sampleProp<V extends number>(prop: Prop<V>, t: number): number {
  if ('static' in prop) return prop.static;
  const keys = prop.track.keys;
  if (keys.length === 0) throw new Error('Track has no keyframes');
  const first = keys[0]!;
  if (t <= first.t) return first.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t < b.t) {
      const p = (t - a.t) / (b.t - a.t);
      return a.v + (b.v - a.v) * ease(a.out, p);
    }
  }
  return keys[keys.length - 1]!.v;
}

function applyModifiers(tr: ResolvedTransform, m: Modifiers): ResolvedTransform {
  return { x: tr.x + m.dx, y: tr.y + m.dy, scale: tr.scale * m.scale, rotation: tr.rotation + m.rotation };
}

function resolveTransform(tr: Transform, t: number): ResolvedTransform {
  return {
    x: sampleProp(tr.x, t),
    y: sampleProp(tr.y, t),
    scale: sampleIn(tr.scale, t, 0), // an overshooting curve must not mirror the layer
    rotation: sampleProp(tr.rotation, t),
  };
}

/** Sample, clamping only animated values: an overshooting curve (back, elastic) must not leave the property's
 * range, but a static value is used exactly as saved. */
const sampleIn = (prop: Prop<number>, t: number, lo: number, hi = Infinity) =>
  'static' in prop ? prop.static : Math.min(hi, Math.max(lo, sampleProp(prop, t)));

/** An overshooting curve must not make a blur / width negative. */
const nonNegative = <T extends Record<K, number>, K extends string>(v: T, key: K): T => (v[key] < 0 ? { ...v, [key]: 0 } : v);

/** Gradient stop offsets and mesh points stay inside the comp (0..1) under overshooting curves. */
function resolveFill(fill: BackgroundFill, t: number): Resolved<BackgroundFill> {
  const r = resolveProps(fill, t);
  const in01 = (v: number) => Math.min(1, Math.max(0, v));
  if (r.kind === 'linear') return { ...r, stops: r.stops.map((s) => ({ ...s, offset: in01(s.offset) })) };
  if (r.kind === 'mesh') return { ...r, points: r.points.map((p) => ({ ...p, x: in01(p.x), y: in01(p.y) })) };
  return r;
}

/** Pure: same (doc, t) → same RenderList. */
export function evaluate(doc: Doc, t: number): RenderList {
  const items: RenderItem[] = [];
  for (const layer of doc.comp.layers) {
    if (!layer.visible || !isOnScreen(layer, doc.comp, t)) continue;
    const opacity = sampleIn(layer.opacity, t, 0, 1);
    const effects = resolveEffects(layer.effects ?? [], t, sampleProp).filter((e) => !isNoOp(e));
    switch (layer.type) {
      case 'background':
        items.push({ kind: 'background', id: layer.id, opacity, fill: resolveFill(layer.fill, t), effects });
        break;
      case 'adjustment':
        if (effects.length && opacity > 0) items.push({ kind: 'adjustment', id: layer.id, opacity, effects });
        break;
      case 'image': {
        const timed = motionOnComp(layer.motion, layer, doc.comp);
        const m = motionModifiers(timed.motion, t, timed.comp, 'image');
        const tr = applyModifiers(resolveTransform(layer.transform, t), m);
        items.push({
          kind: 'image',
          id: layer.id,
          assetId: layer.assetId,
          crop: layer.crop,
          width: layer.width,
          height: layer.height,
          opacity: opacity * m.opacity,
          radius: sampleIn(layer.radius, t, 0),
          shadow: layer.shadow && nonNegative(resolveProps(layer.shadow, t), 'blur'),
          border: layer.border && nonNegative(resolveProps(layer.border, t), 'width'),
          frame: layer.frame,
          frameBar: frameBarHeight(layer),
          tilt: {
            rotateX: sampleProp(layer.tilt.rotateX, t) + m.tiltX,
            rotateY: sampleProp(layer.tilt.rotateY, t) + m.tiltY,
            perspective: layer.tilt.perspective,
          },
          effects,
          video: layer.video ? { time: videoSourceTime(layer.video, t), volume: layer.video.muted ? 0 : layer.video.volume } : null,
          ...tr,
        });
        break;
      }
      case 'text': {
        const timed = motionOnComp(layer.motion, layer, doc.comp);
        const m = motionModifiers(timed.motion, t, timed.comp, 'text');
        const { enter, exit, loop } = timed.motion;
        const shown = expandTextTokens(sampleValue(layer.text, t), doc.comp, t);
        items.push({
          kind: 'text',
          id: layer.id,
          text: shown, // {frame}, {frames}, {time} already replaced
          fontId: layer.fontId,
          weight: layer.weight,
          fontSize: layer.fontSize,
          lineHeight: layer.lineHeight,
          color: sampleValue(layer.color, t),
          gradient: layer.gradient && resolveProps(layer.gradient, t),
          outline: layer.outline && nonNegative(resolveProps(layer.outline, t), 'width'),
          shadow: layer.shadow && nonNegative(resolveProps(layer.shadow, t), 'blur'),
          align: layer.align,
          tracking: layer.tracking,
          opacity: opacity * m.opacity,
          glow: sampleIn(layer.glow, t, 0),
          glowColor: sampleValue(layer.glowColor, t),
          enter: (enter && glyphAnimatorFor(enter, shown)) ?? layer.animator,
          exit: exit && glyphExitFor(exit, shown, timed.comp),
          loop: glyphLoopFor(loop, layer.fontSize),
          effects,
          ...applyModifiers(resolveTransform(layer.transform, t), m),
        });
        break;
      }
    }
  }
  return { width: doc.comp.width, height: doc.comp.height, t, items };
}

// ---------------------------------------------------------------------------
// Glyph animator math. The renderer runs the same formula on the GPU; these
// CPU versions are the reference (tests, hit-testing, future CPU fallback).
// ---------------------------------------------------------------------------

/** Stagger rank for each unit index. rank 0 starts first. */
export function glyphRanks(count: number, order: StaggerOrder, seed: number): number[] {
  switch (order) {
    case 'forward':
      return Array.from({ length: count }, (_, i) => i);
    case 'reverse':
      return Array.from({ length: count }, (_, i) => count - 1 - i);
    case 'center':
    case 'edges': {
      const mid = (count - 1) / 2;
      const far = Math.round(mid);
      return Array.from({ length: count }, (_, i) => {
        const d = Math.round(Math.abs(i - mid));
        return order === 'center' ? d : far - d;
      });
    }
    case 'random': {
      const perm = seededPermutation(count, seed);
      const ranks = new Array<number>(count);
      perm.forEach((glyph, rank) => (ranks[glyph] = rank));
      return ranks;
    }
  }
}


/**
 * Start delay (s) of each unit: stagger · lastRank · falloff(rank / lastRank).
 * A linear falloff gives evenly spaced starts, exactly `stagger` apart.
 */
export function unitDelays(count: number, anim: Pick<GlyphAnimator, 'order' | 'seed' | 'stagger' | 'falloff'>): number[] {
  const ranks = glyphRanks(count, anim.order, anim.seed);
  const last = maxRank(count, anim.order);
  if (last <= 0) return ranks.map(() => 0);
  const span = anim.stagger * last;
  return ranks.map((r) => span * ease(anim.falloff, r / last));
}

/**
 * Which unit each glyph belongs to. `glyphs` are the drawn glyphs in visual order with their
 * source character index (cluster) and line. Words are runs of non-whitespace on a line.
 */
export function assignUnits(text: string, glyphs: { cluster: number; line: number }[], unit: GlyphUnit): { units: number[]; count: number } {
  if (unit === 'glyph') return { units: glyphs.map((_, i) => i), count: glyphs.length };
  const keyOf = (g: { cluster: number; line: number }) => {
    if (unit === 'line') return g.line;
    // Word = index of the whitespace-separated run that contains this character.
    let start = g.cluster;
    while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
    return start;
  };
  const ids = new Map<number, number>();
  const units = glyphs.map((g) => {
    const k = keyOf(g);
    let id = ids.get(k);
    if (id === undefined) {
      id = ids.size;
      ids.set(k, id);
    }
    return id;
  });
  return { units, count: ids.size };
}

/** Linear (un-eased) progress 0..1 of a unit with start delay `delay`, at comp time t. */
export function unitProgress(anim: Pick<GlyphAnimator, 'start' | 'duration'>, delay: number, t: number): number {
  if (anim.duration <= 0) return t >= anim.start + delay ? 1 : 0;
  const p = (t - anim.start - delay) / anim.duration;
  return Math.min(1, Math.max(0, p));
}

/** Linear progress of the unit with stagger rank `rank` (linear falloff). */
export function glyphProgress(anim: Pick<GlyphAnimator, 'start' | 'duration' | 'stagger'>, rank: number, t: number): number {
  return unitProgress(anim, anim.stagger * rank, t);
}

/** How far a unit is from rest: enter animators go 1 → 0, exit animators 0 → 1. */
export function awayness(anim: GlyphAnimator, delay: number, t: number, kind: 'enter' | 'exit'): number {
  const e = ease(anim.easing, unitProgress(anim, delay, t));
  return kind === 'enter' ? 1 - e : e;
}

export const EASING_LUT_SIZE = 256;

/** Easing curve baked into a lookup table so the GPU reproduces any easing (bezier, spring…) exactly. */
export function easingLUT(e: Easing, size = EASING_LUT_SIZE): Float32Array {
  const lut = new Float32Array(size);
  for (let i = 0; i < size; i++) lut[i] = ease(e, i / (size - 1));
  return lut;
}

/** Last moment any unit is still animating; useful for auto comp duration. */
export function animatorEnd(anim: GlyphAnimator, unitCount: number): number {
  const delays = unitDelays(Math.max(1, unitCount), anim);
  return anim.start + Math.max(...delays) + anim.duration;
}

/** A moment when a text layer is fully at rest (entered, not yet exiting), for editing. */
export function restTime(layer: TextLayer, fullComp: Pick<Comp, 'duration'>): number {
  const { motion, comp } = motionOnComp(layer.motion, layer, fullComp);
  const { enter, exit } = motion;
  // Enter presets (whole-layer or per glyph) finish exactly at start + duration.
  let t = enter ? enter.start + enter.duration : 0;
  const custom = layer.animator;
  if (custom && !(enter && isGlyphPreset(enter.preset))) t = Math.max(t, animatorEnd(custom, unitCount(sampleValue(layer.text, layer.timing.in), custom.unit)));
  if (exit) t = Math.min(t, exitStart(exit, comp) - 1e-3);
  const [a, b] = layerSpan(layer, fullComp);
  return Math.min(b, Math.max(a, t));
}

/**
 * A representative moment for thumbnails: after entrances have finished and before exits begin
 * (the end of the comp when nothing exits).
 */
export function posterTime(doc: Doc): number {
  const { comp } = doc;
  let entered = 0;
  let exiting = comp.duration;
  for (const l of comp.layers) {
    if (!isPlaced(l) || !l.visible) continue;
    const timed = motionOnComp(l.motion, l, comp);
    const { enter, exit } = timed.motion;
    if (l.type === 'text') entered = Math.max(entered, Math.min(comp.duration, restTime({ ...l, motion: { ...l.motion, exit: null } }, comp)));
    else if (enter) entered = Math.max(entered, enter.start + enter.duration);
    if (exit) exiting = Math.min(exiting, exitStart(exit, timed.comp));
  }
  if (exiting >= comp.duration) return Math.max(0, comp.duration - 0.05);
  return Math.max(0, exiting > entered ? (entered + exiting) / 2 : exiting - 0.05);
}
