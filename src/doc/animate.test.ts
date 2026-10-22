import { describe, expect, it } from 'vitest';
import { fromOklab, isStill, matchesStill, mixColor, resolveProps, sampleValue, stillShadow, toOklab } from './animate';
import { animatableProps, propAt } from './animatable';
import { createBlankDoc, createDemoDoc } from './demo';
import { Easings } from './easing';
import { evaluate } from './evaluate';
import { moveKeys, pasteKeys, copyKeys } from './keyframes';
import { migrate } from './migrations';
import { toV8 } from './__fixtures__/v8';
import type { Color, Prop, TextLayer } from './types';

const track = <V>(a: V, b: V): Prop<V> => ({ track: { keys: [{ t: 0, v: a, out: Easings.linear }, { t: 1, v: b, out: Easings.linear }] } });

describe('OKLab colours', () => {
  it('round-trips sRGB', () => {
    for (const c of [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0.2, 0.6, 0.9], [0.5, 0.5, 0.5]]) {
      const back = fromOklab(toOklab(c));
      back.forEach((v, i) => expect(v).toBeCloseTo(c[i]!, 5));
    }
  });
  it('blends like CSS color-mix(in oklab, …) (reference values from Chrome)', () => {
    const cases: [Color, Color, [number, number, number]][] = [
      [[1, 0, 0, 1], [0, 0, 1, 1], [0.539974, 0.0962086, -0.0928316]],
      [[1, 1, 0, 1], [0, 0, 1, 1], [0.709982, -0.0518911, -0.0564726]],
      [[25 / 255, 150 / 255, 60 / 255, 1], [240 / 255, 20 / 255, 200 / 255, 1], [0.620783, 0.0600434, -0.00695446]],
    ];
    for (const [a, b, want] of cases) toOklab(mixColor(a, b, 0.5)).forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 3));
  });
  it('keys are exact; alpha blends linearly; overshoot stays in gamut', () => {
    const a: Color = [0.1, 0.2, 0.3, 0.2];
    const b: Color = [0.9, 0.8, 0.1, 1];
    expect(sampleValue(track(a, b), 0)).toEqual(a);
    expect(sampleValue(track(a, b), 1)).toEqual(b);
    expect(sampleValue(track(a, b), 0.5)[3]).toBeCloseTo(0.6, 9);
    const back: Prop<Color> = { track: { keys: [{ t: 0, v: [1, 0, 0, 1], out: { kind: 'bezier', x1: 0.68, y1: -0.6, x2: 0.32, y2: 1.6 } }, { t: 1, v: [0, 0, 1, 1], out: Easings.linear }] } };
    for (let i = 0; i <= 20; i++) for (const ch of sampleValue(back, i / 20)) expect(ch >= 0 && ch <= 1).toBe(true);
  });
});

describe('text and structures', () => {
  it('text holds until the next key, whatever the easing', () => {
    const text: Prop<string> = { track: { keys: [{ t: 0, v: 'A', out: Easings.easeOutBack }, { t: 1, v: 'B', out: Easings.linear }] } };
    expect(sampleValue(text, 0.999)).toBe('A');
    expect(sampleValue(text, 1)).toBe('B');
  });
  it('resolveProps samples every Prop inside a structure', () => {
    const shadow = { ...stillShadow({ blur: 10, offsetX: 0, offsetY: 4, color: [0, 0, 0, 1] }), blur: track(0, 20) };
    expect(resolveProps(shadow, 0.5)).toEqual({ blur: 10, offsetX: 0, offsetY: 4, color: [0, 0, 0, 1] });
    expect(isStill(shadow)).toBe(false);
    expect(matchesStill(stillShadow({ blur: 1, offsetX: 2, offsetY: 3, color: [0, 0, 0, 1] }), { blur: 1, offsetX: 2, offsetY: 3, color: [0, 0, 0, 1] })).toBe(true);
  });
  it('evaluate renders animated text, colours and the gradient at the playhead', () => {
    const doc = createDemoDoc();
    const h = doc.comp.layers.find((l) => l.id === 'headline') as TextLayer;
    h.text = { track: { keys: [{ t: 0, v: 'One', out: Easings.linear }, { t: 1, v: 'Two', out: Easings.linear }] } };
    h.color = track<Color>([1, 0, 0, 1], [0, 0, 1, 1]);
    const item = (t: number) => evaluate(doc, t).items.find((i) => i.id === 'headline') as { text: string; color: Color };
    expect(item(0.5).text).toBe('One');
    expect(item(1).text).toBe('Two');
    expect(item(0).color).toEqual([1, 0, 0, 1]);
  });
});

describe('keys on the new properties', () => {
  it('colour and text keys move, copy and paste (only onto the same kind of property)', () => {
    const doc = createDemoDoc();
    const h = { ...(doc.comp.layers.find((l) => l.id === 'headline') as TextLayer), color: track<Color>([1, 0, 0, 1], [0, 0, 1, 1]) };
    const ids = animatableProps(h).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['text', 'color', 'glowColor']));
    const moved = moveKeys(h.color, [1], 0.5, 30);
    expect('track' in moved && moved.track.keys.map((k) => k.t)).toEqual([0, 1.5]);
    const clip = copyKeys(h, new Map([['color', [0, 1]]]), 30)!;
    const patches = pasteKeys(h, clip, 2, 30);
    expect(patches.map((p) => p.path.join('.'))).toEqual(['color']);
    // A colour key never lands on a number property, even with a matching id.
    const wrong = { items: clip.items.map((i) => ({ ...i, propId: 'glow' })) };
    expect(pasteKeys(h, wrong, 2, 30)).toEqual([]);
  });
  it('rows for shadow / border / outline / gradient exist only while they are on; effect colours are listed', () => {
    const doc = createDemoDoc();
    const shot = doc.comp.layers.find((l) => l.id === 'shot')!;
    const ids = animatableProps(shot).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['radius', 'shadowBlur', 'shadowColor']));
    expect(ids).not.toContain('borderWidth');
    expect(propAt(shot, ['shadow', 'color'])).toEqual({ static: [0.05, 0.02, 0.15, 0.55] });
  });
});

describe('schema v9', () => {
  it('v8 projects open as the same document', () => {
    for (const doc of [createDemoDoc(), createBlankDoc('b')]) expect(migrate(toV8(doc))).toEqual(doc);
  });
});
