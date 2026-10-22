import type { Easing } from './types';

/** CSS cubic-bezier(x1, y1, x2, y2) evaluated at x ∈ [0,1]. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  // Newton-Raphson, then bisection as a fallback.
  let s = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(s) - x;
    if (Math.abs(err) < 1e-6) return sampleY(s);
    const d = slopeX(s);
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
  }
  let lo = 0;
  let hi = 1;
  s = x;
  for (let i = 0; i < 32; i++) {
    const v = sampleX(s);
    if (Math.abs(v - x) < 1e-6) break;
    if (v < x) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return sampleY(s);
}

/** Damped spring from rest at 0 towards 1, after `t` seconds of spring time (closed form). */
function springRaw(w0: number, zeta: number, t: number): number {
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta - 1 < 1e-6) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const r = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - r); // slow mode
  const r2 = -w0 * (zeta + r);
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

/**
 * Damped spring from 0 → 1, as a function of normalised progress p ∈ [0,1]: the spring is stretched to fit the
 * time between two keys (stiffness and damping set the shape, not the duration). p = 1 is 6 time constants of the
 * slowest decay; the little that is left then is spread linearly over the segment so the curve lands on 1
 * without a jump.
 */
export function spring(mass: number, stiffness: number, damping: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const decay = zeta < 1 ? Math.max(zeta, 0.1) * w0 : zeta - 1 < 1e-6 ? w0 : w0 * (zeta - Math.sqrt(zeta * zeta - 1));
  const settle = 6 / decay;
  return springRaw(w0, zeta, p * settle) + p * (1 - springRaw(w0, zeta, settle));
}

/** Falls from 0 onto 1 (accelerating), then `n` bounces; each bounce keeps half the speed (a quarter of the height). */
export function bounce(n: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const e = 0.5;
  const bounces = Math.max(0, Math.round(n));
  // Time units: the fall takes 1, bounce i takes 2·e^i.
  let u = p * (1 + 2 * (1 - e ** bounces));
  if (u < 1) return u * u;
  u -= 1;
  for (let i = 1; i <= bounces; i++) {
    const d = 2 * e ** i;
    if (u < d || i === bounces) {
      const x = (2 * Math.min(u, d)) / d - 1;
      return 1 - e ** (2 * i) * (1 - x * x);
    }
    u -= d;
  }
  return 1;
}

export function ease(e: Easing, p: number): number {
  const x = Math.min(1, Math.max(0, p));
  switch (e.kind) {
    case 'linear':
      return x;
    case 'hold':
      return x < 1 ? 0 : 1;
    case 'bezier':
      return cubicBezier(e.x1, e.y1, e.x2, e.y2, x);
    case 'spring':
      return spring(e.mass, e.stiffness, e.damping, x);
    case 'steps':
      return Math.min(1, Math.floor(x * e.n) / e.n);
    case 'bounce':
      return bounce(e.n, x);
  }
}

export const Easings = {
  linear: { kind: 'linear' } as Easing,
  easeOutCubic: { kind: 'bezier', x1: 0.33, y1: 1, x2: 0.68, y2: 1 } as Easing,
  easeInCubic: { kind: 'bezier', x1: 0.32, y1: 0, x2: 0.67, y2: 0 } as Easing,
  easeInOutCubic: { kind: 'bezier', x1: 0.65, y1: 0, x2: 0.35, y2: 1 } as Easing,
  easeOutBack: { kind: 'bezier', x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 } as Easing,
} as const;

/** The easings offered in every easing picker. The CSS ones use the exact values of the CSS keywords. */
export const EASING_PRESETS: readonly { id: string; label: string; easing: Easing }[] = [
  { id: 'linear', label: 'Linear', easing: Easings.linear },
  { id: 'ease-in', label: 'Ease in', easing: Easings.easeInCubic },
  { id: 'ease-out', label: 'Ease out', easing: Easings.easeOutCubic },
  { id: 'ease-in-out', label: 'Ease in-out', easing: Easings.easeInOutCubic },
  { id: 'back-out', label: 'Ease out back', easing: Easings.easeOutBack },
  { id: 'back-in-out', label: 'Ease in-out back', easing: { kind: 'bezier', x1: 0.68, y1: -0.6, x2: 0.32, y2: 1.6 } },
  { id: 'css-ease', label: 'CSS ease', easing: { kind: 'bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } },
  { id: 'css-ease-in', label: 'CSS ease-in', easing: { kind: 'bezier', x1: 0.42, y1: 0, x2: 1, y2: 1 } },
  { id: 'css-ease-out', label: 'CSS ease-out', easing: { kind: 'bezier', x1: 0, y1: 0, x2: 0.58, y2: 1 } },
  { id: 'css-ease-in-out', label: 'CSS ease-in-out', easing: { kind: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 } },
  { id: 'spring', label: 'Spring', easing: { kind: 'spring', mass: 1, stiffness: 170, damping: 12 } },
  { id: 'elastic', label: 'Elastic', easing: { kind: 'spring', mass: 1, stiffness: 200, damping: 4 } },
  { id: 'bounce', label: 'Bounce', easing: { kind: 'bounce', n: 3 } },
  { id: 'steps', label: 'Steps', easing: { kind: 'steps', n: 4 } },
  { id: 'hold', label: 'Hold', easing: { kind: 'hold' } },
];

const same = (a: Easing, b: Easing) => JSON.stringify(a) === JSON.stringify(b);

/** The preset an easing equals, if any. */
export const easingPreset = (e: Easing) => EASING_PRESETS.find((p) => same(p.easing, e));

/** The CSS `animation-timing-function` for an easing, or null when CSS has none (spring, bounce). */
export function cssEasing(e: Easing): string | null {
  const n = (v: number) => String(Math.round(v * 1000) / 1000);
  switch (e.kind) {
    case 'linear':
      return 'linear';
    case 'hold':
      return 'steps(1, jump-end)';
    case 'steps':
      return `steps(${e.n}, jump-end)`;
    case 'bezier':
      return `cubic-bezier(${n(e.x1)}, ${n(e.y1)}, ${n(e.x2)}, ${n(e.y2)})`;
    default:
      return null;
  }
}
