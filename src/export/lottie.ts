// Lottie (.json) export: the part of a scene Lottie can show, as vector shapes and embedded images.
// Values that come only from keys with plain easings (linear / bezier / hold) become real Lottie keys with
// tangents; everything else (spring, bounce, steps, enter/exit/loop presets, per-glyph animators, colour
// blends) is baked from evaluate() at every frame, so the file plays what the preview shows.
// What Lottie can't show (effects, shadows, glow, 3D tilt, video, …) is left out and listed per layer.
import {
  effectDef,
  evaluate,
  layerSpan,
  mulberry32,
  sampleProp,
  sampleValue,
  assignUnits,
  unitDelays,
  awayness,
  type BackgroundLayer,
  type Color,
  type Doc,
  type Easing,
  type GlyphAnimator,
  type ImageItem,
  type ImageLayer,
  type Layer,
  type Prop,
  type RenderItem,
  type TextItem,
  type TextLayer,
  type BackgroundItem,
} from '@/doc';
import { assetBlob } from '@/assets/assetStore';
import { fontLibrary, type LaidOutGlyph, type LayoutSpec, type TextLayout } from '@/text/fontLibrary';
import { safeName } from './fileName';
import type { ExportResult } from './exporter';

// ---------------------------------------------------------------------------
// Lottie JSON shapes (the subset we write; see https://lottie.github.io/lottie-spec/)

export interface LottieEase {
  x: number[];
  y: number[];
}
export interface LottieKey {
  /** Frame. */
  t: number;
  s: unknown[];
  o?: LottieEase;
  i?: LottieEase;
  h?: 1;
}
export type LottieProp = { a: 0; k: unknown } | { a: 1; k: LottieKey[] };
/** Bezier path: vertices, in/out tangents relative to their vertex. */
export interface LottiePath {
  c: boolean;
  v: number[][];
  i: number[][];
  o: number[][];
}
export type LottieItem = { ty: string; [key: string]: unknown };
export interface LottieLayer {
  ddd: 0;
  ind: number;
  ty: 2 | 4;
  nm: string;
  sr: 1;
  ks: Record<string, unknown>;
  ao: 0;
  ip: number;
  op: number;
  st: 0;
  bm: 0;
  refId?: string;
  shapes?: LottieItem[];
  hasMask?: boolean;
  masksProperties?: unknown[];
}
export interface LottieAsset {
  id: string;
  w: number;
  h: number;
  u: '';
  p: string;
  e: 1;
}
export interface LottieAnimation {
  v: string;
  nm: string;
  fr: number;
  ip: number;
  op: number;
  w: number;
  h: number;
  ddd: 0;
  assets: LottieAsset[];
  layers: LottieLayer[];
  markers: [];
}

export interface GlyphOutline {
  commands: { type: string; values: number[] }[];
  upem: number;
}

export interface LottieDeps {
  /** The image layer's picture (crop applied) as a data URL, or null when it isn't available. */
  image(layer: ImageLayer): string | null;
  /** Text layout as the preview draws it; null when the font isn't loaded. */
  layout(spec: LayoutSpec): TextLayout | null;
  /** A shaped glyph's outline by glyph id. */
  glyphPath(fontId: string, weight: number, gid: number): GlyphOutline | null;
  /** Above this much JSON, per-glyph animation is left out (glyphs × frames grows fast). */
  maxBytes?: number;
}

export const LOTTIE_MAX_BYTES = 20_000_000;
/** Lottie version we write (lottie-web 5.7+ reads it). */
const LOTTIE_VERSION = '5.7.0';

// ---------------------------------------------------------------------------
// Numbers, easings, animated properties

const round = (v: number, d = 1000) => Math.round(v * d) / d;
const same = (a: number[], b: number[], eps = 1e-4) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= eps * Math.max(1, Math.abs(v)));

const LINEAR_OUT: LottieEase = { x: [0], y: [0] };
const LINEAR_IN: LottieEase = { x: [1], y: [1] };

/** Easings Lottie has natively (its keys are CSS-style cubic beziers, plus hold). */
export const isDirectEasing = (e: Easing) => e.kind === 'linear' || e.kind === 'hold' || (e.kind === 'bezier' && e.x1 >= 0 && e.x1 <= 1 && e.x2 >= 0 && e.x2 <= 1);

/** One Lottie key leaving with easing `e` (bezier → tangents, hold → h:1). */
export function lottieKey(t: number, s: unknown[], e: Easing): LottieKey {
  if (e.kind === 'hold') return { t, s, h: 1 };
  if (e.kind === 'bezier') return { t, s, o: { x: [round(e.x1, 1e4)], y: [round(e.y1, 1e4)] }, i: { x: [round(e.x2, 1e4)], y: [round(e.y2, 1e4)] } };
  return { t, s, o: LINEAR_OUT, i: LINEAR_IN };
}

const lastKey = (k: LottieKey): LottieKey => ({ t: k.t, s: k.s });
const keyed = (keys: LottieKey[]): LottieProp => (keys.length === 1 ? { a: 0, k: keys[0]!.s } : { a: 1, k: [...keys.slice(0, -1), lastKey(keys[keys.length - 1]!)] });
const unwrap = (v: number[]) => (v.length === 1 ? v[0]! : v);

/** A value sampled at every frame f0, f0+1, … (one entry per frame). */
export interface Samples {
  f0: number;
  values: number[][];
}

/**
 * Lottie property for a sampled value. When `exact` is given and its keys use plain easings and reproduce every
 * sample, the real keys are written (exact between frames too); otherwise one key per frame (keys that a
 * straight line through their neighbours already gives are dropped), held from frame to frame when the keys use
 * steps.
 */
export function animated(fps: number, s: Samples, exact?: { prop: Prop<number>; map: (v: number) => number[] }): LottieProp {
  const vals = s.values.map((v) => v.map((x) => round(x)));
  if (vals.length === 0) return { a: 0, k: 0 };
  if (vals.every((v) => same(v, vals[0]!))) return { a: 0, k: unwrap(vals[0]!) };
  if (exact && 'track' in exact.prop) {
    const keys = exact.prop.track.keys;
    const direct = keys.slice(0, -1).every((k) => isDirectEasing(k.out));
    const matches = direct && s.values.every((v, i) => same(exact.map(sampleProp(exact.prop, (s.f0 + i) / fps)), v, 1e-3));
    if (matches) return keyed(keys.map((k) => lottieKey(round(k.t * fps), exact.map(k.v).map((x) => round(x)), k.out)));
  }
  const steps = !!exact && 'track' in exact.prop && exact.prop.track.keys.some((k) => k.out.kind === 'steps');
  return baked(s.f0, vals, steps);
}

function baked(f0: number, vals: number[][], hold: boolean): LottieProp {
  const keys: LottieKey[] = [];
  const n = vals.length;
  for (let i = 0; i < n; i++) {
    const v = vals[i]!;
    if (i > 0 && i < n - 1) {
      const prev = vals[i - 1]!;
      const next = vals[i + 1]!;
      // Hold: only changes need a key. Linear: a point on the line through its neighbours adds nothing.
      if (hold ? same(v, prev) : same(v, prev.map((p, j) => (p + next[j]!) / 2), 1e-5)) continue;
    }
    if (hold && i === n - 1 && n > 1 && same(v, vals[i - 1]!)) continue;
    keys.push(hold ? { t: f0 + i, s: v, h: 1 } : { t: f0 + i, s: v, o: LINEAR_OUT, i: LINEAR_IN });
  }
  return keyed(keys);
}

/** The same property with every value passed through `f` (e.g. a radius → a rounded-rect path). */
function mapProp(p: LottieProp, f: (v: number[]) => unknown): LottieProp {
  const arr = (x: unknown) => (Array.isArray(x) ? (x as number[]) : [x as number]);
  if (p.a === 0) return { a: 0, k: f(arr(p.k)) };
  return { a: 1, k: p.k.map((k) => ({ ...k, s: [f(k.s as number[])] })) };
}

const fixed = (k: unknown): LottieProp => ({ a: 0, k });

// ---------------------------------------------------------------------------
// Paths

const KAPPA = 0.5522847498;

/** Rounded rectangle from (0,0) to (w,h), clockwise. */
export function roundedRect(w: number, h: number, r: number): LottiePath {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = r * KAPPA;
  if (r <= 0) return { c: true, v: [[0, 0], [w, 0], [w, h], [0, h]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]] };
  const v = [[r, 0], [w - r, 0], [w, r], [w, h - r], [w - r, h], [r, h], [0, h - r], [0, r]];
  const z = [0, 0];
  const i = [z, z, [0, -k], z, [k, 0], z, [0, k], z];
  const o = [z, [k, 0], z, [0, k], z, [-k, 0], z, [0, -k]];
  const rr = (p: number[]) => p.map((x) => round(x, 100));
  return { c: true, v: v.map(rr), i: i.map(rr), o: o.map(rr) };
}

/**
 * Glyph outline commands (font units, y up) → closed Lottie paths in px (y down): x·s + dx, dy − y·s.
 * Quadratic segments become the exact cubic (controls at 2/3 towards the quadratic control point).
 */
export function glyphToPaths(commands: { type: string; values: number[] }[], s: number, dx: number, dy: number): LottiePath[] {
  const paths: LottiePath[] = [];
  let cur: { v: number[][]; i: number[][]; o: number[][] } | null = null;
  const P = (x: number, y: number) => [dx + x * s, dy - y * s];
  const close = () => {
    if (!cur || cur.v.length === 0) return;
    // A contour that ends where it started: merge the duplicate vertex.
    const n = cur.v.length;
    if (n > 1 && same(cur.v[0]!, cur.v[n - 1]!, 1e-9)) {
      cur.i[0] = cur.i[n - 1]!;
      cur.v.pop();
      cur.i.pop();
      cur.o.pop();
    }
    if (cur.v.length > 1) {
      const r2 = (p: number[]) => p.map((x) => round(x, 100));
      paths.push({ c: true, v: cur.v.map(r2), i: cur.i.map(r2), o: cur.o.map(r2) });
    }
    cur = null;
  };
  const last = () => cur!.v[cur!.v.length - 1]!;
  const add = (p: number[], inT: number[]) => {
    cur!.v.push(p);
    cur!.i.push(inT);
    cur!.o.push([0, 0]);
  };
  for (const c of commands) {
    const a = c.values;
    switch (c.type) {
      case 'M':
        close();
        cur = { v: [P(a[0]!, a[1]!)], i: [[0, 0]], o: [[0, 0]] };
        break;
      case 'L':
        if (cur) add(P(a[0]!, a[1]!), [0, 0]);
        break;
      case 'Q': {
        if (!cur) break;
        const p0 = last();
        const q = P(a[0]!, a[1]!);
        const p = P(a[2]!, a[3]!);
        cur.o[cur.o.length - 1] = [(2 / 3) * (q[0]! - p0[0]!), (2 / 3) * (q[1]! - p0[1]!)];
        add(p, [(2 / 3) * (q[0]! - p[0]!), (2 / 3) * (q[1]! - p[1]!)]);
        break;
      }
      case 'C': {
        if (!cur) break;
        const p0 = last();
        const c1 = P(a[0]!, a[1]!);
        const c2 = P(a[2]!, a[3]!);
        const p = P(a[4]!, a[5]!);
        cur.o[cur.o.length - 1] = [c1[0]! - p0[0]!, c1[1]! - p0[1]!];
        add(p, [c2[0]! - p[0]!, c2[1]! - p[1]!]);
        break;
      }
      case 'Z':
        close();
        break;
    }
  }
  close();
  return paths;
}

// ---------------------------------------------------------------------------
// Colours and gradients (the renderer blends gradients in linear light; Lottie blends in sRGB, so extra
// stops are sampled along each segment)

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055);
const mixLinear = (a: Color, b: Color, p: number): number[] => [0, 1, 2].map((i) => toSrgb(toLinear(a[i]!) + (toLinear(b[i]!) - toLinear(a[i]!)) * p));
const SUB = 8;

/** Background linear gradient, as the shader computes it: stops 0..3 composed segment by segment. */
export function backgroundGradient(stops: { offset: number; color: Color }[]): number[] {
  const list = stops.length ? stops : [{ offset: 0, color: [0, 0, 0, 1] as Color }];
  const at = (i: number) => list[Math.min(i, list.length - 1)]!;
  const o = [0, 1, 2, 3].map((i) => at(i).offset);
  const lin = [0, 1, 2, 3].map((i) => at(i).color.slice(0, 3).map(toLinear));
  const sat = (x: number) => Math.min(1, Math.max(0, x));
  const colourAt = (g: number) => {
    let c = lin[0]!;
    for (let i = 0; i < 3; i++) {
      const p = sat((g - o[i]!) / Math.max(o[i + 1]! - o[i]!, 1e-5));
      c = c.map((v, j) => v + (lin[i + 1]![j]! - v) * p);
    }
    return c.map(toSrgb);
  };
  const n = Math.min(4, list.length);
  const sorted = o.slice(0, n).map(sat).sort((a, b) => a - b);
  const pos: number[] = [];
  if (n === 1) pos.push(0, 1);
  else for (let i = 0; i < n - 1; i++) for (let j = 0; j < (i === n - 2 ? SUB + 1 : SUB); j++) pos.push(sorted[i]! + ((sorted[i + 1]! - sorted[i]!) * j) / SUB);
  return pos.flatMap((p) => [p, ...colourAt(p)]);
}

/** Text gradient from → to (linear light, alpha linear): colour stops, then opacity stops. */
export function textGradient(from: Color, to: Color): number[] {
  const pos = Array.from({ length: SUB + 1 }, (_, i) => i / SUB);
  return [...pos.flatMap((p) => [p, ...mixLinear(from, to, p)]), ...pos.flatMap((p) => [p, from[3] + (to[3] - from[3]) * p])];
}

/** Gradient start / end points for an angle (degrees, y down) across a w×h box centred on (cx, cy). */
export function gradientEnds(angle: number, w: number, h: number, cx: number, cy: number): [number[], number[]] {
  const a = (angle * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  return [
    [cx - dx * half, cy - dy * half],
    [cx + dx * half, cy + dy * half],
  ];
}

// ---------------------------------------------------------------------------
// Building

const transformItem = (extra: Record<string, unknown> = {}): LottieItem => ({
  ty: 'tr',
  p: fixed([0, 0]),
  a: fixed([0, 0]),
  s: fixed([100, 100]),
  r: fixed(0),
  o: fixed(100),
  sk: fixed(0),
  sa: fixed(0),
  ...extra,
});

const group = (nm: string, it: LottieItem[], tr: LottieItem = transformItem()): LottieItem => ({ ty: 'gr', nm, it: [...it, tr] });

const effectLabels = (layer: Layer) => layer.effects.filter((e) => e.enabled).map((e) => effectDef(e.kind).label);

interface Ctx {
  doc: Doc;
  fps: number;
  frames: number;
  /** Item of each layer at each frame (undefined when it isn't on screen). */
  items: Map<string, (RenderItem | undefined)[]>;
  deps: LottieDeps;
  bakeGlyphs: boolean;
  assets: LottieAsset[];
  omitted: string[];
  glyphBaked: boolean;
}

/** Frames where the layer is on screen, and its items there. */
function visibleRun<T extends RenderItem>(ctx: Ctx, layer: Layer): { f0: number; items: T[] } | null {
  const all = ctx.items.get(layer.id) ?? [];
  const f0 = all.findIndex((x) => x);
  if (f0 < 0) return null;
  let f1 = f0;
  while (f1 + 1 < all.length && all[f1 + 1]) f1++;
  return { f0, items: all.slice(f0, f1 + 1) as T[] };
}

function layerBase(ctx: Ctx, layer: Layer, ty: 2 | 4, ks: Record<string, unknown>): LottieLayer {
  const [a, b] = layerSpan(layer, ctx.doc.comp);
  return { ddd: 0, ind: 0, ty, nm: layer.name, sr: 1, ks, ao: 0, ip: round(a * ctx.fps), op: round(b * ctx.fps), st: 0, bm: 0 };
}

/** Layer transform from per-frame items (exact keys when the layer's own keys explain every frame). */
function placedTransform(ctx: Ctx, layer: ImageLayer | TextLayer, f0: number, items: (ImageItem | TextItem)[], anchor: number[]) {
  const S = (f: (it: ImageItem | TextItem) => number[]): Samples => ({ f0, values: items.map(f) });
  const tr = layer.transform;
  return {
    a: fixed(anchor.map((v) => round(v))),
    p: {
      s: true,
      x: animated(ctx.fps, S((it) => [it.x]), { prop: tr.x, map: (v) => [v] }),
      y: animated(ctx.fps, S((it) => [it.y]), { prop: tr.y, map: (v) => [v] }),
    },
    s: animated(ctx.fps, S((it) => [it.scale * 100, it.scale * 100]), { prop: tr.scale, map: (v) => [v * 100, v * 100] }),
    r: animated(ctx.fps, S((it) => [it.rotation]), { prop: tr.rotation, map: (v) => [v] }),
    o: animated(ctx.fps, S((it) => [it.opacity * 100]), { prop: layer.opacity, map: (v) => [v * 100] }),
  };
}

function imageLayer(ctx: Ctx, layer: ImageLayer, notes: string[]): LottieLayer | null {
  if (layer.video) {
    ctx.omitted.push(`Video layer '${layer.name}' (video isn't supported in Lottie)`);
    return null;
  }
  const run = visibleRun<ImageItem>(ctx, layer);
  if (!run) return null;
  const url = ctx.deps.image(layer);
  if (!url) {
    ctx.omitted.push(`Image layer '${layer.name}' (its picture isn't available)`);
    return null;
  }
  const { f0, items } = run;
  const first = items[0]!;
  if (layer.shadow) notes.push('drop shadow');
  if (layer.border && items.some((it) => (it.border?.width ?? 0) > 0)) notes.push('border');
  if (layer.frame.kind !== 'none') notes.push('window frame');
  if (items.some((it) => it.tilt.rotateX !== 0 || it.tilt.rotateY !== 0)) notes.push('3D tilt');

  const id = `image_${ctx.assets.length}`;
  ctx.assets.push({ id, w: layer.width, h: layer.height, u: '', p: url, e: 1 });
  // The card (image + frame bar) is centred on the position; the image is its lower part.
  const out = layerBase(ctx, layer, 2, placedTransform(ctx, layer, f0, items, [layer.width / 2, (layer.height - first.frameBar) / 2]));
  out.refId = id;
  const radius = animated(ctx.fps, { f0, values: items.map((it) => [it.radius]) }, { prop: layer.radius, map: (v) => [Math.max(0, v)] });
  if (!(radius.a === 0 && radius.k === 0)) {
    out.hasMask = true;
    out.masksProperties = [{ inv: false, mode: 'a', nm: 'Corners', pt: mapProp(radius, (v) => roundedRect(layer.width, layer.height, v[0]!)), o: fixed(100), x: fixed(0) }];
  }
  return out;
}

function backgroundLayer(ctx: Ctx, layer: BackgroundLayer, notes: string[]): LottieLayer | null {
  const run = visibleRun<BackgroundItem>(ctx, layer);
  if (!run) return null;
  const { f0, items } = run;
  const { width: W, height: H } = ctx.doc.comp;
  const S = (f: (it: BackgroundItem) => number[]): Samples => ({ f0, values: items.map(f) });
  let fill: LottieItem;
  const kind = layer.fill.kind;
  if (kind === 'solid') {
    fill = { ty: 'fl', c: animated(ctx.fps, S((it) => (it.fill as { color: Color }).color.slice(0, 3).concat(1))), o: fixed(100), r: 1 };
  } else if (kind === 'linear') {
    type Lin = Extract<BackgroundItem['fill'], { kind: 'linear' }>;
    const ends = items.map((it) => gradientEnds((it.fill as Lin).angle, W, H, W / 2, H / 2));
    const g = S((it) => backgroundGradient((it.fill as Lin).stops));
    fill = {
      ty: 'gf',
      t: 1,
      s: animated(ctx.fps, { f0, values: ends.map((e) => e[0]) }),
      e: animated(ctx.fps, { f0, values: ends.map((e) => e[1]) }),
      g: { p: g.values[0]!.length / 4, k: animated(ctx.fps, g) },
      o: fixed(100),
      r: 1,
    };
  } else {
    ctx.omitted.push(`${layer.name}: ${kind === 'mesh' ? 'mesh gradient' : 'image background'} (the whole layer)${notes.length ? `, ${notes.join(', ')}` : ''}`);
    notes.length = 0;
    return null;
  }
  const rect: LottieItem = { ty: 'rc', d: 1, p: fixed([W / 2, H / 2]), s: fixed([W, H]), r: fixed(0) };
  const ks = { a: fixed([0, 0]), p: fixed([0, 0]), s: fixed([100, 100]), r: fixed(0), o: animated(ctx.fps, S((it) => [it.opacity * 100]), { prop: layer.opacity, map: (v) => [v * 100] }) };
  const out = layerBase(ctx, layer, 4, ks);
  out.shapes = [group('Fill', [rect, fill])];
  return out;
}

/** Pose parts the export can't bake (they need the glyph shader). */
function droppedPose(a: GlyphAnimator | null, notes: Set<string>) {
  if (!a) return;
  const p = a.pose;
  if (p.skewX) notes.add('per-glyph skew');
  if (p.rotateX || p.rotateY) notes.add('per-glyph 3D flip');
  if (p.blur > 0) notes.add('per-glyph blur');
  if (p.color && p.color[3] > 0) notes.add('per-glyph tint');
  if (p.scramble) notes.add('scramble');
}

/** Per glyph of one animator: start delay, random value and pivot (the unit's box centre, em, y up) — as the renderer computes them. */
function unitParams(text: string, drawn: LaidOutGlyph[], anim: GlyphAnimator) {
  const { units, count } = assignUnits(text, drawn, anim.unit);
  const delays = unitDelays(count, anim);
  const rng = mulberry32((anim.seed + 1) * 7919);
  const rands = Array.from({ length: count }, () => rng());
  const box = Array.from({ length: count }, () => [Infinity, Infinity, -Infinity, -Infinity]);
  drawn.forEach((g, i) => {
    const a = g.glyph!;
    const b = box[units[i]!]!;
    b[0] = Math.min(b[0]!, g.x + a.l);
    b[1] = Math.min(b[1]!, g.y + a.b);
    b[2] = Math.max(b[2]!, g.x + a.r);
    b[3] = Math.max(b[3]!, g.y + a.t);
  });
  return drawn.map((_, i) => {
    const b = box[units[i]!]!;
    return { delay: delays[units[i]!]!, rand: rands[units[i]!]!, pivot: [(b[0]! + b[2]!) / 2, (b[1]! + b[3]!) / 2] };
  });
}

/** Group transform for one glyph under an animator, baked per frame (y down, px at layer scale 1). */
function poseTransform(ctx: Ctx, anim: GlyphAnimator, kind: 'enter' | 'exit', u: { delay: number; rand: number; pivot: number[] }, fs: number, fa: number, fb: number): LottieItem {
  const p = anim.pose;
  const px = u.pivot[0]! * fs;
  const py = -u.pivot[1]! * fs;
  const rand2 = (u.rand * 7.31 + 0.17) % 1;
  const dir = [Math.cos(u.rand * 2 * Math.PI), -Math.sin(u.rand * 2 * Math.PI)];
  const pos: number[][] = [];
  const scale: number[][] = [];
  const rot: number[][] = [];
  const op: number[][] = [];
  for (let f = fa; f <= fb; f++) {
    const k = awayness(anim, u.delay, f / ctx.fps, kind);
    const spread = px * (1 + (p.spread - 1) * k - 1);
    pos.push([px + spread + p.offsetX * k + dir[0]! * p.randomOffset * k, py + p.offsetY * k + dir[1]! * p.randomOffset * k]);
    scale.push([(1 + (p.scaleX - 1) * k) * 100, (1 + (p.scaleY - 1) * k) * 100]);
    rot.push([p.rotation * k - p.randomRotation * k * (rand2 * 2 - 1)]);
    op.push([Math.min(1, Math.max(0, 1 + (p.opacity - 1) * k)) * 100]);
  }
  const A = (values: number[][]) => animated(ctx.fps, { f0: fa, values });
  return transformItem({ a: fixed([round(px), round(py)]), p: A(pos), s: A(scale), r: A(rot), o: A(op) });
}

function textLayer(ctx: Ctx, layer: TextLayer, notes: string[]): LottieLayer | null {
  const run = visibleRun<TextItem>(ctx, layer);
  if (!run) return null;
  const { f0, items } = run;
  const f1 = f0 + items.length - 1;
  const { fps } = ctx;
  const fs = layer.fontSize;
  const S = (f: (it: TextItem) => number[]): Samples => ({ f0, values: items.map(f) });
  const extra = new Set<string>();
  if (items.some((it) => it.glow > 0 && it.glowColor[3] > 0)) extra.add('glow');
  if (layer.shadow) extra.add('text shadow');
  const loop = items.find((it) => it.loop)?.loop;
  if (loop) extra.add(`${loop.kind} loop`);

  // Text segments: runs of frames with the same text (animated text switches at its keys).
  const segments: { raw: string; fa: number; fb: number; text: string }[] = [];
  items.forEach((it, i) => {
    const raw = sampleValue(layer.text, (f0 + i) / fps);
    const seg = segments[segments.length - 1];
    if (seg && seg.raw === raw) seg.fb = f0 + i;
    else segments.push({ raw, fa: f0 + i, fb: f0 + i, text: it.text });
  });
  if (segments.some((s) => items.slice(s.fa - f0, s.fb - f0 + 1).some((it) => it.text !== s.text))) extra.add('frame counter (shows its first frame only)');

  const colorFill = (): LottieItem => ({
    ty: 'fl',
    c: animated(fps, S((it) => [...it.color.slice(0, 3), 1])),
    o: animated(fps, S((it) => [it.color[3] * 100])),
    r: 1,
  });
  const stroke = (): LottieItem | null => {
    if (!layer.outline || !items.some((it) => (it.outline?.width ?? 0) > 0)) return null;
    // Outlines grow outwards from the glyph edge: a stroke twice as wide, under the fill.
    return {
      ty: 'st',
      c: animated(fps, S((it) => [...it.outline!.color.slice(0, 3), 1])),
      o: animated(fps, S((it) => [it.outline!.color[3] * 100])),
      w: animated(fps, S((it) => [2 * Math.min(it.outline!.width, 0.21 * fs)])),
      lc: 2,
      lj: 2,
      ml: 4,
    };
  };

  const shapes: LottieItem[] = [];
  for (const seg of segments) {
    const layout = ctx.deps.layout({ fontId: layer.fontId, weight: layer.weight, text: seg.text, tracking: layer.tracking, align: layer.align, lineHeight: layer.lineHeight });
    if (!layout) {
      ctx.omitted.push(`Text layer '${layer.name}' (its font isn't loaded)`);
      return null;
    }
    const drawn = layout.glyphs.filter((g) => g.glyph);
    const fill = (): LottieItem => {
      if (!layer.gradient) return colorFill();
      const ends = items.map((it) => gradientEnds(it.gradient!.angle, layout.width * fs, layout.height * fs, 0, 0));
      const g = S((it) => textGradient(it.gradient!.from, it.gradient!.to));
      return {
        ty: 'gf',
        t: 1,
        s: animated(fps, { f0, values: ends.map((e) => e[0]) }),
        e: animated(fps, { f0, values: ends.map((e) => e[1]) }),
        g: { p: SUB + 1, k: animated(fps, g) },
        o: fixed(100),
        r: 1,
      };
    };
    const styles = (): LottieItem[] => [fill(), ...[stroke()].filter((x): x is LottieItem => !!x)];
    const glyphPaths = (g: LaidOutGlyph): LottieItem[] => {
      const outline = ctx.deps.glyphPath(layout.fontId, layer.weight, g.gid);
      if (!outline) return [];
      return glyphToPaths(outline.commands, fs / outline.upem, g.x * fs, -g.y * fs).map((ks) => ({ ty: 'sh', ks: fixed(ks) }));
    };

    const at = items[seg.fa - f0]!;
    const enter = at.enter;
    const exit = at.exit;
    droppedPose(enter, extra);
    droppedPose(exit, extra);
    let content: LottieItem[];
    if ((enter || exit) && ctx.bakeGlyphs) {
      ctx.glyphBaked = true;
      const pe = enter && unitParams(seg.text, drawn, enter);
      const px = exit && unitParams(seg.text, drawn, exit);
      // Later glyphs draw on top (as in the renderer): Lottie draws the first item on top.
      content = drawn
        .map((g, i) => {
          let item = group(`Glyph ${i + 1}`, [...glyphPaths(g), ...styles()], enter ? poseTransform(ctx, enter, 'enter', pe![i]!, fs, seg.fa, seg.fb) : transformItem());
          if (exit) item = group(`Glyph ${i + 1} exit`, [item], poseTransform(ctx, exit, 'exit', px![i]!, fs, seg.fa, seg.fb));
          return item;
        })
        .reverse();
    } else {
      if (enter || exit) extra.add('per-glyph animation (file too large)');
      content = [group('Glyphs', [...drawn.flatMap(glyphPaths), ...styles()])];
    }
    if (segments.length === 1) {
      shapes.push(...content);
      continue;
    }
    // Several texts over time: each shows only during its own frames (hold keys on the group's opacity).
    const keys: LottieKey[] = [];
    if (seg.fa > f0) keys.push({ t: f0, s: [0], h: 1 });
    keys.push({ t: seg.fa, s: [100], h: 1 });
    if (seg.fb < f1) keys.push({ t: seg.fb + 1, s: [0], h: 1 });
    shapes.push(group(`Text ${shapes.length + 1}`, content, transformItem({ o: keyed(keys) })));
  }
  notes.push(...extra);
  const out = layerBase(ctx, layer, 4, placedTransform(ctx, layer, f0, items, [0, 0]));
  out.shapes = shapes;
  return out;
}

function build(doc: Doc, deps: LottieDeps, bakeGlyphs: boolean): { json: LottieAnimation; omitted: string[]; glyphBaked: boolean } {
  const { comp } = doc;
  const fps = comp.fps;
  const frames = Math.max(1, Math.round(comp.duration * fps));
  const items = new Map<string, (RenderItem | undefined)[]>();
  for (let f = 0; f <= frames; f++) {
    for (const it of evaluate(doc, Math.min(f / fps, comp.duration)).items) {
      let arr = items.get(it.id);
      if (!arr) items.set(it.id, (arr = new Array(frames + 1)));
      arr[f] = it;
    }
  }
  const ctx: Ctx = { doc, fps, frames, items, deps, bakeGlyphs, assets: [], omitted: [], glyphBaked: false };
  const layers: LottieLayer[] = [];
  for (const layer of comp.layers) {
    if (!layer.visible) continue;
    const notes: string[] = [];
    let out: LottieLayer | null = null;
    switch (layer.type) {
      case 'background':
        out = backgroundLayer(ctx, layer, notes);
        break;
      case 'image':
        out = imageLayer(ctx, layer, notes);
        break;
      case 'text':
        out = textLayer(ctx, layer, notes);
        break;
      case 'adjustment': {
        const fx = effectLabels(layer);
        if (fx.length) ctx.omitted.push(`Adjustment layer '${layer.name}' (effects: ${fx.join(', ')})`);
        continue;
      }
    }
    if (!out) continue;
    const fx = effectLabels(layer);
    if (fx.length) notes.push(`effects (${fx.join(', ')})`);
    if (notes.length) ctx.omitted.push(`${layer.name}: ${notes.join(', ')}`);
    layers.push(out);
  }
  // Lottie lists layers top first.
  layers.reverse().forEach((l, i) => (l.ind = i + 1));
  const json: LottieAnimation = { v: LOTTIE_VERSION, nm: doc.name, fr: fps, ip: 0, op: frames, w: comp.width, h: comp.height, ddd: 0, assets: ctx.assets, layers, markers: [] };
  return { json, omitted: ctx.omitted, glyphBaked: ctx.glyphBaked };
}

/** Pure, given `deps`: the Lottie animation for a doc and a readable list of what was left out. */
export function docToLottie(doc: Doc, deps: LottieDeps): { json: LottieAnimation; omitted: string[] } {
  const max = deps.maxBytes ?? LOTTIE_MAX_BYTES;
  const full = build(doc, deps, true);
  if (!full.glyphBaked || JSON.stringify(full.json).length <= max) return { json: full.json, omitted: full.omitted };
  const lite = build(doc, deps, false);
  return { json: lite.json, omitted: [...lite.omitted, `Per-glyph animation was left out: with it the file would be over ${Math.round(max / 1e6)} MB`] };
}

// ---------------------------------------------------------------------------
// Export (browser): embed images, then build

async function toDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(s)}`;
}

/** The layer's picture with its crop applied, stretched to the layer's aspect (as drawn), at most 2× its size. */
async function encodeImage(layer: ImageLayer): Promise<string | null> {
  const blob = await assetBlob(layer.assetId);
  if (!blob) return null;
  const bmp = await createImageBitmap(blob);
  try {
    const { crop } = layer;
    const sw = Math.max(1, crop.w * bmp.width);
    const sh = Math.max(1, crop.h * bmp.height);
    const k = Math.min(2, Math.sqrt((sw * sh) / Math.max(1, layer.width * layer.height)));
    const c = new OffscreenCanvas(Math.max(1, Math.round(layer.width * k)), Math.max(1, Math.round(layer.height * k)));
    c.getContext('2d')!.drawImage(bmp, crop.x * bmp.width, crop.y * bmp.height, sw, sh, 0, 0, c.width, c.height);
    const type = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return toDataUrl(await c.convertToBlob({ type, quality: 0.92 }));
  } finally {
    bmp.close();
  }
}

export async function exportLottie(doc: Doc, opts: { signal?: AbortSignal; onProgress?: (f: number) => void } = {}): Promise<ExportResult> {
  const started = performance.now();
  await fontLibrary.loadAll(doc.comp.layers.flatMap((l) => (l.type === 'text' && l.visible ? [l.fontId] : [])));
  const images = new Map<string, string | null>();
  const pics = doc.comp.layers.filter((l): l is ImageLayer => l.type === 'image' && l.visible && !l.video);
  for (const [i, l] of pics.entries()) {
    if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    images.set(l.id, await encodeImage(l).catch(() => null));
    opts.onProgress?.((0.5 * (i + 1)) / pics.length);
  }
  if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
  const { json, omitted } = docToLottie(doc, {
    image: (l) => images.get(l.id) ?? null,
    layout: (spec) => fontLibrary.layout(spec),
    glyphPath: (fontId, weight, gid) => fontLibrary.glyphPath(fontId, weight, gid),
  });
  opts.onProgress?.(1);
  const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
  return { blob, filename: `${safeName(doc)}.json`, ms: performance.now() - started, width: doc.comp.width, height: doc.comp.height, note: null, omitted };
}
