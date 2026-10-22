import { toV8 } from './__fixtures__/v8';
import { describe, expect, it } from 'vitest';
import { bounce, cssEasing, ease, EASING_PRESETS, easingPreset, Easings, spring } from './easing';
import { setKeyEasing } from './keyframes';
import { migrate } from './migrations';
import { createBlankDoc } from './demo';
import type { Easing, Prop } from './types';

const samples = (f: (p: number) => number, n = 1000) => Array.from({ length: n + 1 }, (_, i) => f(i / n));
/** Largest change between neighbouring samples (a jump shows up as one big step). */
const maxStep = (v: number[]) => Math.max(...v.slice(1).map((x, i) => Math.abs(x - v[i]!)));

/** The spring before Milestone I (critically-damped formula for every damping ≥ critical, then a snap to 1). */
function oldSpring(mass: number, stiffness: number, damping: number, p: number) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const t = (p * 6) / (Math.max(zeta, 0.1) * w0);
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}

describe('easing presets', () => {
  it('CSS keywords use the exact CSS values', () => {
    const css = Object.fromEntries(EASING_PRESETS.map((p) => [p.id, cssEasing(p.easing)]));
    expect(css['css-ease']).toBe('cubic-bezier(0.25, 0.1, 0.25, 1)');
    expect(css['css-ease-in']).toBe('cubic-bezier(0.42, 0, 1, 1)');
    expect(css['css-ease-out']).toBe('cubic-bezier(0, 0, 0.58, 1)');
    expect(css['css-ease-in-out']).toBe('cubic-bezier(0.42, 0, 0.58, 1)');
    expect(css.steps).toBe('steps(4, jump-end)');
    expect(css.spring).toBeNull();
    expect(css.bounce).toBeNull();
  });
  it('CSS ease matches its known values', () => {
    const e = easingPreset({ kind: 'bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 })!.easing;
    expect(ease(e, 0.5)).toBeCloseTo(0.8024, 4);
    expect(ease(e, 0.25)).toBeCloseTo(0.4085, 3);
  });
  it('old projects keep their preset names', () => {
    expect(easingPreset(Easings.easeOutCubic)?.label).toBe('Ease out');
    expect(easingPreset(Easings.easeInOutCubic)?.label).toBe('Ease in-out');
    expect(easingPreset(Easings.easeOutBack)?.label).toBe('Ease out back');
    expect(easingPreset({ kind: 'spring', mass: 1, stiffness: 170, damping: 12 })?.label).toBe('Spring');
    expect(easingPreset({ kind: 'bezier', x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 })).toBeUndefined();
  });
  it('every preset starts at 0 and ends at 1', () => {
    for (const p of EASING_PRESETS) {
      expect(ease(p.easing, 0), p.id).toBe(0);
      expect(ease(p.easing, 1), p.id).toBe(1);
    }
  });
  it('steps and hold match CSS steps(n, jump-end)', () => {
    expect(ease({ kind: 'steps', n: 4 }, 0.3)).toBe(0.25);
    expect(ease({ kind: 'steps', n: 4 }, 0.25)).toBe(0.25);
    expect(ease({ kind: 'steps', n: 4 }, 0.999)).toBe(0.75);
    expect(ease({ kind: 'hold' }, 0.999)).toBe(0);
  });
});

describe('spring', () => {
  it('lands on 1 without a jump, however much damping', () => {
    for (const damping of [4, 12, 20, 40, 80, 200]) {
      const v = samples((p) => spring(1, 170, damping, p));
      expect(maxStep(v), `damping ${damping}`).toBeLessThan(0.05);
      expect(Math.abs(1 - spring(1, 170, damping, 0.999)), `damping ${damping}`).toBeLessThan(0.005);
    }
  });
  it('critical damping is continuous with its neighbours', () => {
    const crit = 2 * Math.sqrt(170);
    for (const p of [0.1, 0.3, 0.6]) {
      expect(spring(1, 170, crit * (1 + 1e-9), p)).toBeCloseTo(spring(1, 170, crit, p), 3);
      expect(spring(1, 170, crit * (1 - 1e-9), p)).toBeCloseTo(spring(1, 170, crit, p), 3);
    }
  });
  it('bouncy springs barely change from before (≤ 0.3 % of the move)', () => {
    for (const [m, k, d] of [[1, 170, 12], [1, 180, 11], [1, 240, 9]] as const) {
      const diff = Math.max(...samples((p) => Math.abs(spring(m, k, d, p) - oldSpring(m, k, d, p)), 200));
      expect(diff, `${k}/${d}`).toBeLessThanOrEqual(0.003);
    }
  });
  it('elastic overshoots more than spring', () => {
    const peak = (e: Easing) => Math.max(...samples((p) => ease(e, p), 200));
    expect(peak(easingPreset({ kind: 'spring', mass: 1, stiffness: 200, damping: 4 })!.easing)).toBeGreaterThan(peak({ kind: 'spring', mass: 1, stiffness: 170, damping: 12 }));
  });
});

describe('bounce', () => {
  it('3 bounces = the classic ease-out-bounce curve', () => {
    // Robert Penner's easeOutBounce.
    const penner = (x: number) => {
      const n1 = 7.5625;
      const d1 = 2.75;
      if (x < 1 / d1) return n1 * x * x;
      if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
      if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
      return n1 * (x -= 2.625 / d1) * x + 0.984375;
    };
    for (const p of samples((x) => x, 100)) expect(bounce(3, p)).toBeCloseTo(penner(p), 6);
  });
  it('never goes past the target, ends on it', () => {
    for (const n of [0, 1, 2, 5]) {
      const v = samples((p) => bounce(n, p));
      expect(Math.max(...v)).toBeLessThanOrEqual(1);
      expect(v.at(-1)).toBe(1);
      expect(maxStep(v), `n ${n}`).toBeLessThan(0.01);
    }
  });
});

describe('setKeyEasing', () => {
  const prop: Prop<number> = { track: { keys: [0, 1, 2].map((t) => ({ t, v: t, out: Easings.linear })) } };
  it('sets the easing leaving the picked keys, never the last key', () => {
    const out = setKeyEasing(prop, [0, 2], { kind: 'bounce', n: 3 }, 30);
    if (!('track' in out)) throw new Error('static');
    expect(out.track.keys.map((k) => k.out.kind)).toEqual(['bounce', 'linear', 'linear']);
  });
  it('leaves a static value alone', () => {
    expect(setKeyEasing({ static: 3 }, [0], Easings.linear, 30)).toEqual({ static: 3 });
  });
});

describe('schema v8', () => {
  it('v7 projects open unchanged', () => {
    const doc = createBlankDoc('v7');
    const v7 = { ...toV8(doc), schemaVersion: 7 };
    expect(migrate(v7)).toEqual(doc);
  });
});

describe('overshooting curves stay in range', () => {
  it('layer opacity, scale and effect params are clamped; the position may overshoot', async () => {
    const { createDemoDoc } = await import('./demo');
    const { evaluate } = await import('./evaluate');
    const { createEffect } = await import('./effects');
    const back: Easing = { kind: 'bezier', x1: 0.68, y1: -0.6, x2: 0.32, y2: 1.6 };
    const doc = createDemoDoc();
    const shot = doc.comp.layers.find((l) => l.id === 'shot')!;
    if (shot.type !== 'image') throw new Error('demo changed');
    const track = (a: number, b: number) => ({ track: { keys: [{ t: 0, v: a, out: back }, { t: 1, v: b, out: back }] } });
    shot.opacity = track(0, 1);
    shot.transform.scale = track(0.05, 1);
    shot.transform.x = track(0, 100);
    const blur = createEffect('blur');
    const key = Object.keys(blur.params)[0]!;
    blur.params[key] = track(0, 10);
    shot.effects = [blur];
    let [minO, maxO, minS, minP, minX] = [1, 0, 1, Infinity, 0];
    for (let i = 0; i <= 100; i++) {
      const item = evaluate(doc, i / 100).items.find((it) => it.id === 'shot') as { opacity: number; scale: number; x: number; effects: { params: Record<string, number> }[] } | undefined;
      if (!item) continue;
      minO = Math.min(minO, item.opacity);
      maxO = Math.max(maxO, item.opacity);
      minS = Math.min(minS, item.scale);
      minX = Math.min(minX, item.x);
      minP = Math.min(minP, item.effects[0]?.params[key] ?? Infinity);
    }
    expect(minO).toBeGreaterThanOrEqual(0);
    expect(maxO).toBeLessThanOrEqual(1);
    expect(minS).toBeGreaterThanOrEqual(0);
    expect(minP).toBeGreaterThanOrEqual(0);
    expect(minX).toBeLessThan(0); // positions are free to overshoot
  });
});

describe('static effect params are not clamped', () => {
  it('a saved value outside the slider range is used as is', async () => {
    const { createEffect, resolveEffects } = await import('./effects');
    const { sampleProp } = await import('./evaluate');
    const fx = createEffect('ascii');
    fx.params.lineHeight = { static: 2.4 };
    expect(resolveEffects([fx], 0, sampleProp)[0]!.params.lineHeight).toBe(2.4);
  });
});
