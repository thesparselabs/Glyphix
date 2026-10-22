import { describe, expect, it } from 'vitest';
import { cubicBezier, ease, Easings, spring } from './easing';
import { createDemoDoc } from './demo';
import { assignUnits, awayness, easingLUT, evaluate, glyphProgress, glyphRanks, sampleProp, unitDelays } from './evaluate';
import { History, makeInsert, makeMove, makeRemove, makeSet } from './history';
import { offsetProp } from './props';
import { seededPermutation } from './random';
import { REST_POSE, type Doc, type GlyphAnimator, type TextLayer } from './types';

describe('easing', () => {
  it('bezier endpoints and linear identity', () => {
    expect(cubicBezier(0.33, 1, 0.68, 1, 0)).toBe(0);
    expect(cubicBezier(0.33, 1, 0.68, 1, 1)).toBe(1);
    expect(cubicBezier(0, 0, 1, 1, 0.37)).toBeCloseTo(0.37, 4);
  });
  it('easeOutBack overshoots', () => {
    const samples = Array.from({ length: 101 }, (_, i) => ease(Easings.easeOutBack, i / 100));
    expect(Math.max(...samples)).toBeGreaterThan(1.05);
  });
  it('spring lands on 1', () => {
    expect(spring(1, 170, 12, 1)).toBe(1);
    expect(spring(1, 170, 12, 0.999)).toBeCloseTo(1, 1);
  });
  it('steps', () => {
    expect(ease({ kind: 'steps', n: 4 }, 0.3)).toBe(0.25);
  });
});

describe('sampleProp', () => {
  const prop = { track: { keys: [{ t: 1, v: 10, out: Easings.linear }, { t: 3, v: 30, out: Easings.linear }] } };
  it('clamps before/after and interpolates', () => {
    expect(sampleProp(prop, 0)).toBe(10);
    expect(sampleProp(prop, 2)).toBe(20);
    expect(sampleProp(prop, 9)).toBe(30);
    expect(sampleProp({ static: 5 }, 2)).toBe(5);
  });
});

describe('evaluate', () => {
  it('is pure and deterministic', () => {
    const doc = createDemoDoc();
    const a = evaluate(doc, 1.234);
    const b = evaluate(structuredClone(doc), 1.234);
    expect(a).toEqual(b);
  });
  it('skips hidden layers', () => {
    const doc = createDemoDoc();
    doc.comp.layers[1]!.visible = false;
    expect(evaluate(doc, 0).items.map((i) => i.id)).toEqual(['bg', 'headline']);
  });
});

describe('glyph animator', () => {
  const anim: GlyphAnimator = {
    unit: 'glyph', order: 'forward', start: 0.5, duration: 1, stagger: 0.1, falloff: Easings.linear, seed: 1, easing: Easings.linear,
    pose: { ...REST_POSE, offsetY: 10, scaleX: 0, scaleY: 0, opacity: 0 },
  };
  it('staggers by rank', () => {
    expect(glyphProgress(anim, 0, 1)).toBeCloseTo(0.5);
    expect(glyphProgress(anim, 5, 1)).toBe(0);
    expect(glyphProgress(anim, 5, 10)).toBe(1);
  });
  it('ranks are permutations / symmetric', () => {
    expect(glyphRanks(4, 'reverse', 0)).toEqual([3, 2, 1, 0]);
    expect(glyphRanks(5, 'center', 0)).toEqual([2, 1, 0, 1, 2]);
    expect(glyphRanks(5, 'edges', 0)).toEqual([0, 1, 2, 1, 0]);
    const r = glyphRanks(50, 'random', 42);
    expect([...r].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(glyphRanks(50, 'random', 42)).toEqual(r);
  });
  it('seeded permutation is stable across runs', () => {
    expect(seededPermutation(6, 123)).toEqual(seededPermutation(6, 123));
    expect(seededPermutation(6, 123)).not.toEqual(seededPermutation(6, 124));
  });
  it('linear falloff spaces starts exactly `stagger` apart; other falloffs keep the ends', () => {
    expect(unitDelays(4, anim)).toEqual([0, 0.1, 0.2, 0.30000000000000004]);
    const eased = unitDelays(5, { ...anim, falloff: Easings.easeInCubic });
    expect(eased[0]).toBe(0);
    expect(eased[4]).toBeCloseTo(0.4);
    expect(eased[2]!).toBeLessThan(0.2); // ease-in: early units bunch up
    expect(unitDelays(5, { ...anim, order: 'center' })).toEqual([0.2, 0.1, 0, 0.1, 0.2]);
  });
  it('awayness: enter goes 1 → 0, exit 0 → 1', () => {
    expect(awayness(anim, 0, 0, 'enter')).toBe(1);
    expect(awayness(anim, 0, 5, 'enter')).toBe(0);
    expect(awayness(anim, 0, 0, 'exit')).toBe(0);
    expect(awayness(anim, 0, 1, 'exit')).toBeCloseTo(0.5);
  });
  it('units: glyphs, words and lines', () => {
    const text = 'Ship it\nnow';
    // Drawn glyphs (no spaces/newlines): S h i p i t n o w
    const glyphs = [0, 1, 2, 3, 5, 6, 8, 9, 10].map((cluster) => ({ cluster, line: cluster > 7 ? 1 : 0 }));
    expect(assignUnits(text, glyphs, 'glyph').count).toBe(9);
    expect(assignUnits(text, glyphs, 'word')).toEqual({ units: [0, 0, 0, 0, 1, 1, 2, 2, 2], count: 3 });
    expect(assignUnits(text, glyphs, 'line')).toEqual({ units: [0, 0, 0, 0, 0, 0, 1, 1, 1], count: 2 });
  });
  it('LUT matches ease()', () => {
    const lut = easingLUT(Easings.easeOutBack, 11);
    expect(lut[5]).toBeCloseTo(ease(Easings.easeOutBack, 0.5), 5);
  });
});

describe('history', () => {
  const path = ['comp', 'layers', 2, 'text'] as const;
  it('undo/redo restores exact docs', () => {
    const doc = createDemoDoc('A');
    const h = new History<Doc>(doc);
    h.commit(makeSet(h.current, 'Edit text', [{ path, value: { static: 'B' } }]));
    expect((h.current.comp.layers[2] as TextLayer).text).toEqual({ static: 'B' });
    expect(h.undo()).toEqual(doc);
    h.redo();
    expect((h.current.comp.layers[2] as TextLayer).text).toEqual({ static: 'B' });
  });
  it('coalesces drags into one step', () => {
    const doc = createDemoDoc();
    const h = new History<Doc>(doc);
    const x = ['comp', 'layers', 1, 'transform', 'x'];
    for (let i = 0; i < 10; i++) h.commit(makeSet(h.current, 'Move', [{ path: x, value: { static: i } }], 'drag:shot'), 1000 + i * 16);
    expect(h.undo()).toEqual(doc);
    expect(h.canUndo).toBe(false);
  });
  it('structural sharing leaves untouched layers identical', () => {
    const doc = createDemoDoc();
    const h = new History<Doc>(doc);
    h.commit(makeSet(h.current, 'Edit', [{ path, value: 'Z' }]));
    expect(h.current.comp.layers[0]).toBe(doc.comp.layers[0]);
  });
  it('insert and undo-insert', () => {
    const doc = createDemoDoc();
    const h = new History<Doc>(doc);
    const layer = { ...doc.comp.layers[2]!, id: 'copy' };
    h.commit(makeInsert(['comp', 'layers'], 1, layer, 'Duplicate'));
    expect(h.current.comp.layers.map((l) => l.id)).toEqual(['bg', 'copy', 'shot', 'headline']);
    expect(h.undo()).toEqual(doc);
  });
});

describe('history gestures & array ops', () => {
  const x = ['comp', 'layers', 1, 'transform', 'x'];
  it('a gesture is one undo step regardless of pauses', () => {
    const doc = createDemoDoc();
    const h = new History<Doc>(doc);
    h.beginGesture();
    for (let i = 0; i < 50; i++) h.commit(makeSet(h.current, 'Move', [{ path: x, value: { static: i } }]), i * 5000);
    h.endGesture();
    const entryCount = (h as unknown as { past: { forward: unknown[] }[] }).past;
    expect(entryCount).toHaveLength(1);
    expect(entryCount[0]!.forward).toHaveLength(1);
    expect(h.undo()).toEqual(doc);
  });
  it('remove and move round-trip', () => {
    const doc = createDemoDoc();
    const h = new History<Doc>(doc);
    const layers = ['comp', 'layers'];
    h.commit(makeMove(layers, 2, 0, doc.comp.layers[2], 'Send to back'));
    expect(h.current.comp.layers.map((l) => l.id)).toEqual(['headline', 'bg', 'shot']);
    h.commit(makeRemove(layers, 2, h.current.comp.layers[2], 'Delete'));
    expect(h.current.comp.layers.map((l) => l.id)).toEqual(['headline', 'bg']);
    h.undo();
    h.undo();
    expect(h.current).toEqual(doc);
  });
  it('offsetProp shifts every keyframe', () => {
    const p = offsetProp({ track: { keys: [{ t: 0, v: 1, out: Easings.linear }, { t: 1, v: 5, out: Easings.linear }] } }, 10);
    expect('track' in p && p.track.keys.map((k) => k.v)).toEqual([11, 15]);
  });
});
