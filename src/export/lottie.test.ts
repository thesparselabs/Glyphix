import { describe, expect, it } from 'vitest';
import { createDemoDoc, ease, Easings, sampleProp, type Doc, type ImageLayer, type Layer, type TextLayer } from '@/doc';
import type { TextLayout } from '@/text/fontLibrary';
import { backgroundGradient, docToLottie, glyphToPaths, roundedRect, type LottieDeps, type LottieKey, type LottieLayer, type LottieProp } from './lottie';

// Fake font: every glyph is a 0.5 × 0.7 em box, 0.6 em apart, outline = a square in font units (upem 1000).
const layout = (text: string): TextLayout => {
  const glyphs = [...text].map((ch, i) => ({
    x: i * 0.6 - (text.length * 0.6) / 2,
    y: -0.3,
    advance: 0.6,
    glyph: ch === ' ' ? null : { page: 0, ax: 0, ay: 0, aw: 1, ah: 1, l: 0, b: 0, r: 0.5, t: 0.7 },
    gid: ch.charCodeAt(0),
    cluster: i,
    line: 0,
  }));
  return { glyphs, width: text.length * 0.6, height: 1.2, fontId: 'inter', generation: 0 };
};
const deps: LottieDeps = {
  image: () => 'data:image/png;base64,AAAA',
  layout: (spec) => layout(spec.text),
  glyphPath: () => ({ upem: 1000, commands: [{ type: 'M', values: [0, 0] }, { type: 'L', values: [500, 0] }, { type: 'L', values: [500, 700] }, { type: 'L', values: [0, 700] }, { type: 'Z', values: [] }] }),
};

const demo = () => createDemoDoc();
const layerOf = (doc: Doc, id: string) => doc.comp.layers.find((l) => l.id === id)!;
const out = (doc: Doc, d: LottieDeps = deps) => docToLottie(doc, d);
const byName = (layers: LottieLayer[], nm: string) => layers.find((l) => l.nm === nm)!;
const keysOf = (p: unknown) => (p as Extract<LottieProp, { a: 1 }>).k as LottieKey[];

describe('docToLottie', () => {
  it('writes the comp and lists layers top first', () => {
    const { json } = out(demo());
    expect(json).toMatchObject({ v: '5.7.0', fr: 30, ip: 0, op: 150, w: 1920, h: 1080 });
    expect(json.layers.map((l) => l.nm)).toEqual(['Headline', 'Screenshot', 'Background']);
    expect(json.layers.map((l) => l.ind)).toEqual([1, 2, 3]);
    expect(json.assets).toHaveLength(1);
    expect(byName(json.layers, 'Screenshot').refId).toBe(json.assets[0]!.id);
  });

  it('keeps bezier keys exact with their tangents', () => {
    const { json } = out(demo());
    const y = keysOf((byName(json.layers, 'Screenshot').ks.p as { y: unknown }).y);
    expect(y).toHaveLength(2);
    expect(y[0]).toMatchObject({ t: 0, s: [700], o: { x: [0.33], y: [1] }, i: { x: [0.68], y: [1] } });
    expect(y[1]).toEqual({ t: 30, s: [640] });
    // Scale is a 2D value in percent; opacity 0..100.
    expect(keysOf(byName(json.layers, 'Screenshot').ks.s)[0]!.s).toEqual([94, 94]);
    expect(keysOf(byName(json.layers, 'Screenshot').ks.o)[1]).toEqual({ t: 24, s: [100] });
  });

  it('writes hold keys as h:1', () => {
    const doc = demo();
    const shot = layerOf(doc, 'shot') as ImageLayer;
    shot.transform.x = { track: { keys: [{ t: 0, v: 100, out: { kind: 'hold' } }, { t: 1, v: 900, out: Easings.linear }] } };
    const x = keysOf((byName(out(doc).json.layers, 'Screenshot').ks.p as { x: unknown }).x);
    expect(x[0]).toEqual({ t: 0, s: [100], h: 1 });
    expect(x[1]).toEqual({ t: 30, s: [900] });
  });

  it('bakes a spring one key per frame, matching ease()', () => {
    const doc = demo();
    const shot = layerOf(doc, 'shot') as ImageLayer;
    const spring = { kind: 'spring', mass: 1, stiffness: 170, damping: 12 } as const;
    shot.transform.x = { track: { keys: [{ t: 0, v: 0, out: spring }, { t: 1, v: 1000, out: Easings.linear }] } };
    const x = keysOf((byName(out(doc).json.layers, 'Screenshot').ks.p as { x: unknown }).x);
    expect(x.length).toBeGreaterThan(25);
    for (const k of x.filter((k) => k.t <= 30)) expect(k.s[0]).toBeCloseTo(1000 * ease(spring, k.t / 30), 2);
    for (const k of x) expect(k.s[0]).toBeCloseTo(sampleProp(shot.transform.x, k.t / 30), 2);
  });

  it('bakes enter presets into the transform', () => {
    const doc = demo();
    const shot = layerOf(doc, 'shot') as ImageLayer;
    shot.motion = { enter: { preset: 'slide-up', start: 0, duration: 1, easing: Easings.easeOutCubic }, exit: null, loop: null };
    const y = keysOf((byName(out(doc).json.layers, 'Screenshot').ks.p as { y: unknown }).y);
    expect(y.length).toBeGreaterThan(5); // baked, not the doc's 2 keys
    expect(y.every((k, i) => i === 0 || k.t > y[i - 1]!.t)).toBe(true);
  });

  it('sets ip / op from the in and out points', () => {
    const doc = demo();
    layerOf(doc, 'shot').timing = { in: 1, out: 3.5 };
    const shot = byName(out(doc).json.layers, 'Screenshot');
    expect([shot.ip, shot.op]).toEqual([30, 105]);
    expect([byName(out(doc).json.layers, 'Background').ip, byName(out(doc).json.layers, 'Background').op]).toEqual([0, 150]);
  });

  it('rounds image corners with a mask', () => {
    const shot = byName(out(demo()).json.layers, 'Screenshot');
    expect(shot.hasMask).toBe(true);
    const mask = (shot.masksProperties![0] as { pt: { k: { v: number[][] } } }).pt.k;
    expect(mask.v[0]).toEqual([18, 0]);
    expect(shot.ks.a).toEqual({ a: 0, k: [640, 380] });
    expect(roundedRect(100, 40, 50).v[0]).toEqual([20, 0]); // radius limited to half the short side
  });

  it('writes colours as 0..1 RGBA and gradients with extra stops in linear light', () => {
    const doc = demo();
    (layerOf(doc, 'bg') as Extract<Layer, { type: 'background' }>).fill = { kind: 'solid', color: { static: [1, 0.5, 0, 1] } };
    const fill = (byName(out(doc).json.layers, 'Background').shapes![0]!.it as { ty: string; c?: unknown }[]).find((i) => i.ty === 'fl')!;
    expect(fill.c).toEqual({ a: 0, k: [1, 0.5, 0, 1] });
    // Two stops: 9 points; the midpoint is the linear-light mix (brighter than the sRGB average).
    const g = backgroundGradient([{ offset: 0, color: [0, 0, 0, 1] }, { offset: 1, color: [1, 1, 1, 1] }]);
    expect(g.length).toBe(9 * 4);
    expect(g[4 * 4]).toBeCloseTo(0.5);
    expect(g[4 * 4 + 1]).toBeCloseTo(0.7354, 3);
  });

  it('bakes the glyph animator per glyph, at rest after it ends', () => {
    const { json } = out(demo());
    const head = byName(json.layers, 'Headline');
    const glyphs = head.shapes!.filter((s) => s.ty === 'gr');
    expect(glyphs).toHaveLength('Ship visuals that move'.replace(/ /g, '').length);
    const tr = (glyphs[0]!.it as { ty: string; o: unknown; p: unknown }[]).find((i) => i.ty === 'tr')!;
    const o = keysOf(tr.o);
    expect(o[0]!.s[0]).toBe(0); // starts away (opacity 0)
    expect(o[o.length - 1]!.s[0]).toBe(100);
    // Glyph shapes sit in layer px: font units × size / upem, y flipped.
    const sh = (glyphs[glyphs.length - 1]!.it as { ty: string; ks?: { k: { v: number[][] } } }[]).find((i) => i.ty === 'sh')!;
    const first = layout('Ship visuals that move').glyphs[0]!;
    expect(sh.ks!.k.v[0]).toEqual([+(first.x * 96).toFixed(2), +(-first.y * 96).toFixed(2)]);
  });

  it('leaves per-glyph baking out above the size cap, and says so', () => {
    const { json, omitted } = out(demo(), { ...deps, maxBytes: 2000 });
    expect(byName(json.layers, 'Headline').shapes).toHaveLength(1);
    expect(omitted.some((o) => /Per-glyph animation was left out/.test(o))).toBe(true);
  });

  it('switches animated text with hold keys, and fixes frame counters', () => {
    const doc = demo();
    const head = layerOf(doc, 'headline') as TextLayer;
    head.animator = null;
    head.text = { track: { keys: [{ t: 0, v: 'One', out: Easings.linear }, { t: 2, v: 'Two {frame}', out: Easings.linear }] } };
    const { json, omitted } = out(doc);
    const groups = byName(json.layers, 'Headline').shapes!;
    expect(groups).toHaveLength(2);
    const op = (g: (typeof groups)[number]) => keysOf((g.it as { ty: string; o: unknown }[]).find((i) => i.ty === 'tr')!.o);
    expect(op(groups[0]!)).toEqual([{ t: 0, s: [100], h: 1 }, { t: 60, s: [0] }]);
    expect(op(groups[1]!)).toEqual([{ t: 0, s: [0], h: 1 }, { t: 60, s: [100] }]);
    expect(omitted).toContain('Headline: glow, frame counter (shows its first frame only)');
  });

  it('lists what Lottie leaves out, per layer', () => {
    const doc = demo();
    const shot = layerOf(doc, 'shot') as ImageLayer;
    shot.tilt = { rotateX: { static: 10 }, rotateY: { static: 0 }, perspective: 2400 };
    shot.effects = [{ id: 'fx', kind: 'blur', enabled: true, params: {}, colors: {}, text: {} }];
    const clip: ImageLayer = { ...structuredClone(shot), id: 'clip', name: 'Clip', assetId: 'vid-x', video: { start: 0, in: 0, out: 2, loop: false, volume: 1, muted: false } };
    doc.comp.layers.push(clip);
    (layerOf(doc, 'bg') as Extract<Layer, { type: 'background' }>).fill = { kind: 'mesh', points: [] };
    const { json, omitted } = out(doc);
    expect(omitted).toEqual([
      'Background: mesh gradient (the whole layer)',
      'Screenshot: drop shadow, 3D tilt, effects (Blur)',
      'Headline: glow',
      "Video layer 'Clip' (video isn't supported in Lottie)",
    ]);
    expect(json.layers.map((l) => l.nm)).toEqual(['Headline', 'Screenshot']);
  });
});

describe('baking', () => {
  it('holds baked steps from frame to frame', () => {
    const doc = demo();
    const shot = layerOf(doc, 'shot') as ImageLayer;
    shot.transform.rotation = { track: { keys: [{ t: 0, v: 0, out: { kind: 'steps', n: 4 } }, { t: 2, v: 20, out: Easings.linear }] } };
    const r = keysOf(byName(out(doc).json.layers, 'Screenshot').ks.r);
    expect(r.map((k) => [k.t, k.s[0]])).toEqual([[0, 0], [15, 5], [30, 10], [45, 15], [60, 20]]);
    expect(r.slice(0, -1).every((k) => k.h === 1)).toBe(true);
  });
});

describe('glyphToPaths', () => {
  it('turns a quadratic into the exact cubic (same point at t = 0.5)', () => {
    const [p] = glyphToPaths([{ type: 'M', values: [0, 0] }, { type: 'Q', values: [50, 100, 100, 0] }, { type: 'Z', values: [] }], 1, 0, 0);
    const p0 = p!.v[0]!;
    const p1 = p!.v[1]!;
    const c1 = [p0[0]! + p!.o[0]![0]!, p0[1]! + p!.o[0]![1]!];
    const c2 = [p1[0]! + p!.i[1]![0]!, p1[1]! + p!.i[1]![1]!];
    const cubicMid = [0, 1].map((j) => (p0[j]! + 3 * c1[j]! + 3 * c2[j]! + p1[j]!) / 8);
    const quadMid = [0.25 * 0 + 0.5 * 50 + 0.25 * 100, -(0.25 * 0 + 0.5 * 100 + 0.25 * 0)]; // y flipped
    expect(cubicMid[0]).toBeCloseTo(quadMid[0]!, 1);
    expect(cubicMid[1]).toBeCloseTo(quadMid[1]!, 1);
  });

  it('closes contours, merges a repeated start point and scales font units to px', () => {
    const paths = glyphToPaths(
      [{ type: 'M', values: [0, 0] }, { type: 'L', values: [10, 0] }, { type: 'L', values: [10, 10] }, { type: 'L', values: [0, 0] }, { type: 'Z', values: [] }, { type: 'M', values: [20, 0] }, { type: 'C', values: [20, 5, 25, 10, 30, 10] }, { type: 'L', values: [30, 0] }, { type: 'Z', values: [] }],
      2,
      100,
      50,
    );
    expect(paths).toHaveLength(2);
    expect(paths[0]!.v).toEqual([[100, 50], [120, 50], [120, 30]]);
    expect(paths[0]!.c).toBe(true);
    expect(paths[1]!.o[0]).toEqual([0, -10]);
    expect(paths[1]!.i[1]).toEqual([-10, 0]);
  });
});
