// Sampling any animated value: numbers interpolate, colours blend in OKLab (so red → blue passes through purple,
// not a muddy grey), strings hold until the next key. `resolveProps` turns a doc structure that contains Props
// (a shadow, a fill, …) into plain values at one time, which is what the renderer receives.
import { ease } from './easing';
import type { BackgroundFill, Border, Color, Prop, Shadow, TextGradient, TextOutline, TextShadow } from './types';

/** Values a Prop can hold. */
export type Animatable = number | Color | string;

/** A doc structure with every Prop<V> replaced by V (what the renderer gets). */
export type Resolved<T> = T extends Prop<infer V> ? V : T extends readonly unknown[] ? { [K in keyof T]: Resolved<T[K]> } : T extends object ? { [K in keyof T]: Resolved<T[K]> } : T;

export function isProp(x: unknown): x is Prop<unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const keys = Object.keys(x);
  return keys.length === 1 && (keys[0] === 'static' || (keys[0] === 'track' && Array.isArray((x as { track: { keys?: unknown } }).track?.keys)));
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB (0..1) → OKLab. */
export function toOklab([r, g, b]: readonly number[]): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r!), toLinear(g!), toLinear(b!)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab → sRGB (0..1, clamped: an overshooting curve can leave the gamut). */
export function fromOklab([L, a, b]: readonly number[]): [number, number, number] {
  const l = (L! + 0.3963377774 * a! + 0.2158037573 * b!) ** 3;
  const m = (L! - 0.1055613458 * a! - 0.0638541728 * b!) ** 3;
  const s = (L! - 0.0894841775 * a! - 1.291485548 * b!) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return rgb.map((c) => Math.min(1, Math.max(0, toSrgb(Math.max(0, c))))) as [number, number, number];
}

/** Blend two colours in OKLab; alpha blends linearly. */
export function mixColor(a: Color, b: Color, p: number): Color {
  const A = toOklab(a);
  const B = toOklab(b);
  const [r, g, bl] = fromOklab([A[0] + (B[0] - A[0]) * p, A[1] + (B[1] - A[1]) * p, A[2] + (B[2] - A[2]) * p]);
  return [r, g, bl, Math.min(1, Math.max(0, a[3] + (b[3] - a[3]) * p))];
}

function mix<V>(a: V, b: V, p: number): V {
  if (p === 0) return a;
  if (typeof a === 'number' && typeof b === 'number') return (a + (b - a) * p) as V;
  if (Array.isArray(a) && Array.isArray(b)) return (p === 1 ? b : mixColor(a as unknown as Color, b as unknown as Color, p)) as V;
  return a; // strings (and anything else) hold until the next key
}

/** The value of any Prop at `t` (numbers: same result as `sampleProp`). */
export function sampleValue<V>(prop: Prop<V>, t: number): V {
  if ('static' in prop) return prop.static;
  const keys = prop.track.keys;
  if (keys.length === 0) throw new Error('Track has no keyframes');
  if (t <= keys[0]!.t) return keys[0]!.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t < b.t) return mix(a.v, b.v, ease(a.out, (t - a.t) / (b.t - a.t)));
  }
  return keys[keys.length - 1]!.v;
}

/** Every Prop inside `value` sampled at `t` (objects and arrays copied, everything else as is). */
export function resolveProps<T>(value: T, t: number): Resolved<T> {
  if (isProp(value)) return sampleValue(value, t) as Resolved<T>;
  if (Array.isArray(value)) return value.map((v) => resolveProps(v, t)) as Resolved<T>;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveProps(v, t);
    return out as Resolved<T>;
  }
  return value as Resolved<T>;
}

/** Wrap a plain value as a static Prop. */
export const still = <V>(v: V): Prop<V> => ({ static: v });

// Plain values (presets, palette suggestions, the renderer's view) → doc structures with static Props.

export const stillShadow = (s: Resolved<Shadow>): Shadow => ({ blur: still(s.blur), offsetX: still(s.offsetX), offsetY: still(s.offsetY), color: still(s.color) });
export const stillBorder = (b: Resolved<Border>): Border => ({ width: still(b.width), color: still(b.color) });
export const stillOutline = (o: Resolved<TextOutline>): TextOutline => ({ width: still(o.width), color: still(o.color) });
export const stillTextShadow = (s: Resolved<TextShadow>): TextShadow => ({ offsetX: still(s.offsetX), offsetY: still(s.offsetY), blur: still(s.blur), color: still(s.color) });
export const stillGradient = (g: Resolved<TextGradient>): TextGradient => ({ angle: still(g.angle), from: still(g.from), to: still(g.to) });

export function stillFill(f: Resolved<BackgroundFill>): BackgroundFill {
  switch (f.kind) {
    case 'solid':
      return { kind: 'solid', color: still(f.color) };
    case 'linear':
      return { kind: 'linear', angle: still(f.angle), stops: f.stops.map((s) => ({ offset: still(s.offset), color: still(s.color) })) };
    case 'mesh':
      return { kind: 'mesh', points: f.points.map((p) => ({ x: still(p.x), y: still(p.y), color: still(p.color) })) };
    case 'image':
      return f;
  }
}

/** True when nothing inside `value` is animated. */
export function isStill(value: unknown): boolean {
  if (isProp(value)) return 'static' in value;
  if (Array.isArray(value)) return value.every(isStill);
  if (value && typeof value === 'object') return Object.values(value).every(isStill);
  return true;
}

/** Same plain values as `plain` (and nothing animated): for highlighting the matching preset. */
export const matchesStill = (value: unknown, plain: unknown) => isStill(value) && JSON.stringify(resolveProps(value, 0)) === JSON.stringify(plain);
