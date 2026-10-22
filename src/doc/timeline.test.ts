import { toV8 } from './__fixtures__/v8';
import { describe, expect, it } from 'vitest';
import {
  animatableProps,
  applyPatches,
  audioSegments,
  copyKeys,
  createBlankDoc,
  createDemoDoc,
  createEffect,
  defaultExit,
  deleteKeys,
  evaluate,
  layerSpan,
  migrate,
  moveKeys,
  moveLayerInTime,
  pasteKeys,
  putKey,
  SCHEMA_VERSION,
  type Doc,
  type ImageLayer,
  type Layer,
  type Prop,
  type TextLayer,
} from '.';

const fps = 30;
const track = (...ts: number[]): Prop<number> => ({ track: { keys: ts.map((t, i) => ({ t, v: i * 10, out: { kind: 'linear' } })) } });
const times = (p: Prop<number>) => ('track' in p ? p.track.keys.map((k) => k.t) : []);
const layer = (doc: Doc, id: string) => doc.comp.layers.find((l) => l.id === id)!;
const patchLayer = (doc: Doc, id: string, patches: { path: readonly (string | number)[]; value: unknown }[]) => {
  const i = doc.comp.layers.findIndex((l) => l.id === id);
  return applyPatches(doc, patches.map((p) => ({ path: ['comp', 'layers', i, ...p.path], value: p.value })));
};

describe('layer in/out points', () => {
  it('migrates v6 layers to "the whole comp" and renders them identically', () => {
    const v6 = toV8(createDemoDoc()) as { schemaVersion: number; comp: { layers: Record<string, unknown>[] } };
    v6.schemaVersion = 6;
    v6.comp.layers.forEach((l) => delete l.timing);
    const doc = migrate(v6);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    doc.comp.layers.forEach((l) => expect(l.timing).toEqual({ in: 0, out: null }));
    for (const t of [0, 1, 2.5, doc.comp.duration]) expect(evaluate(doc, t)).toEqual(evaluate(createDemoDoc(), t));
  });

  it('hides a layer outside [in, out); null out runs to the end, including the last frame', () => {
    let doc = createDemoDoc();
    doc = patchLayer(doc, 'shot', [{ path: ['timing'], value: { in: 1, out: 3 } }]);
    const has = (t: number) => evaluate(doc, t).items.some((i) => i.id === 'shot');
    expect([0.99, 1, 2.99, 3].map(has)).toEqual([false, true, true, false]);
    doc = patchLayer(doc, 'shot', [{ path: ['timing'], value: { in: 1, out: null } }]);
    expect(has(doc.comp.duration)).toBe(true);
    expect(layerSpan(layer(doc, 'shot'), { duration: 5 })).toEqual([1, 5]);
    // Backgrounds are always on.
    expect(layerSpan({ ...layer(doc, 'bg'), timing: { in: 2, out: 3 } } as Layer, { duration: 5 })).toEqual([0, 5]);
  });

  it('enter presets start at the in point, exit presets end at the out point', () => {
    let doc = createBlankDoc('t');
    const head = layer(doc, 'headline') as TextLayer;
    const enter = head.motion.enter!; // rise, start 0.2, duration 1
    doc = patchLayer(doc, 'headline', [
      { path: ['timing'], value: { in: 2, out: 4 } },
      { path: ['motion', 'exit'], value: { ...defaultExit('fade'), endOffset: 0, duration: 0.5 } },
    ]);
    const op = (t: number) => (evaluate(doc, t).items.find((i) => i.id === 'headline') as { opacity: number } | undefined)?.opacity;
    // The same layer untrimmed, with the exit ending at the comp end.
    const base = patchLayer(createBlankDoc('t'), 'headline', [{ path: ['motion', 'exit'], value: { ...defaultExit('fade'), endOffset: 0, duration: 0.5 } }]);
    const baseOp = (t: number) => (evaluate(base, t).items.find((i) => i.id === 'headline') as { opacity: number }).opacity;
    const end = base.comp.duration;
    // Same enter curve, two seconds later; same exit curve, ending at the out point.
    for (const dt of [0.1, 0.3, 0.7]) expect(op(2 + enter.start + dt)).toBeCloseTo(baseOp(enter.start + dt), 6);
    for (const dt of [0.4, 0.2, 0.02]) expect(op(4 - dt)).toBeCloseTo(baseOp(end - dt), 6);
    expect(op(3.4)).toBeCloseTo(1, 6);
  });

  it('a video is heard only while its layer is on screen', () => {
    let doc = createDemoDoc();
    doc = patchLayer(doc, 'shot', [
      { path: ['video'], value: { start: 0, in: 0, out: 2, loop: true, volume: 1, muted: false } },
      { path: ['timing'], value: { in: 1.5, out: 3.5 } },
    ]);
    const segs = audioSegments(doc);
    expect(Math.min(...segs.map((s) => s.compStart))).toBeCloseTo(1.5, 9);
    expect(Math.max(...segs.map((s) => s.compStart + s.duration))).toBeCloseTo(3.5, 9);
    expect(segs[0]!.sourceStart).toBeCloseTo(1.5, 9);
  });
});

describe('keyframe operations', () => {
  it('moves keys onto whole frames, never before 0; a moved key replaces one it lands on', () => {
    expect(times(moveKeys(track(0, 1, 2), [1], 0.51, fps))).toEqual([0, 1.5, 2]);
    expect(times(moveKeys(track(0.5, 1), [0.5, 1], -2, fps))).toEqual([0]); // both clamp to 0: one survives
    const landed = moveKeys(track(0, 1, 2), [2], -1, fps);
    expect(times(landed)).toEqual([0, 1]);
    expect('track' in landed && landed.track.keys[1]!.v).toBe(20); // the moved key's value wins
  });

  it('deletes keys; deleting the last one leaves a static value', () => {
    expect(times(deleteKeys(track(0, 1, 2), [1], fps))).toEqual([0, 2]);
    expect(deleteKeys(track(1), [1], fps)).toEqual({ static: 0 });
    expect(putKey({ static: 5 }, 0.51, 7, fps)).toEqual({ track: { keys: [{ t: 0.5, v: 7, out: expect.anything() }] } });
  });

  it('copies keys relative to the earliest and pastes them at the playhead, effects matched by kind', () => {
    const doc = createDemoDoc();
    const src = { ...(layer(doc, 'shot') as ImageLayer) };
    const fx = createEffect('blur');
    fx.params.radius = track(1, 1.5);
    src.opacity = track(1.5, 2);
    src.effects = [fx];
    const clip = copyKeys(src, new Map([['opacity', [2]], [`fx:${fx.id}:radius`, [1, 1.5]]]), fps)!;
    expect(clip.items.map((i) => [i.propId.split(':').at(-1), i.dt])).toEqual([['opacity', 1], ['radius', 0], ['radius', 0.5]]);
    const dst = { ...(layer(doc, 'headline') as TextLayer), effects: [createEffect('blur')] };
    const patches = pasteKeys(dst, clip, 3, fps);
    const byPath = Object.fromEntries(patches.map((p) => [p.path.join('.'), times(p.value as Prop<number>)]));
    expect(byPath).toEqual({ opacity: [4], 'effects.0.params.radius': [3, 3.5] });
  });

  it('moving a layer in time carries its in/out, keys, video start and custom animator', () => {
    const doc = createDemoDoc();
    const shot = { ...(layer(doc, 'shot') as ImageLayer), opacity: track(0, 1), video: { start: 0.5, in: 0, out: 2, loop: false, volume: 1, muted: false } };
    const p = Object.fromEntries(moveLayerInTime({ ...shot, timing: { in: 0, out: null } }, 1.5).map((x) => [x.path.join('.'), x.value]));
    expect(p.timing).toEqual({ in: 1.5, out: null });
    expect(times(p.opacity as Prop<number>)).toEqual([1.5, 2.5]);
    expect(p['video.start']).toBe(2);
    expect(Object.keys(p)).not.toContain('transform.x'); // static props untouched
  });

  it('lists animatable props per layer type, effect params by effect id, fixed params left out', () => {
    const doc = createDemoDoc();
    const t = { ...(layer(doc, 'headline') as TextLayer), effects: [createEffect('ascii')] };
    const ids = animatableProps(t).map((p) => p.id);
    expect(ids.slice(0, 9)).toEqual(['opacity', 'x', 'y', 'scale', 'rotation', 'text', 'color', 'glow', 'glowColor']);
    expect(ids).toContain(`fx:${t.effects[0]!.id}:size`);
    expect(ids).not.toContain(`fx:${t.effects[0]!.id}:lineHeight`); // fixed (rebuilds the glyph atlas)
    expect(animatableProps(layer(doc, 'shot')).map((p) => p.id)).toContain('tiltX');
  });
});
