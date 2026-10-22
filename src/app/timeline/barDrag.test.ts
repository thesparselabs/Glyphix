import { describe, expect, it } from 'vitest';
import { createBlankDoc, type Layer, type Prop, type TextLayer } from '@/doc';
import { dragPatches, snapTargets, type BarPart, type DragContext } from './barDrag';

const ctx = (over: Partial<DragContext> = {}): DragContext => ({ fps: 30, duration: 5, pps: 100, targets: [], ...over });
const headline = (timing: { in: number; out: number | null }) => {
  const l = createBlankDoc('t').comp.layers.find((x) => x.id === 'headline') as TextLayer;
  return { ...l, timing, opacity: { track: { keys: [{ t: 1, v: 0, out: { kind: 'linear' } }, { t: 2, v: 1, out: { kind: 'linear' } }] } } } as TextLayer;
};
const byPath = (layer: Layer, part: BarPart, dt: number, c: DragContext) => Object.fromEntries(dragPatches(part, layer, dt, c).map((p) => [p.path.join('.'), p.value]));

describe('timeline bar drags', () => {
  it('move shifts in/out and keys by whole frames, not before 0 or past the end', () => {
    const p = byPath(headline({ in: 1, out: 3 }), 'move', 0.51, ctx());
    expect(p.timing).toEqual({ in: 1.5, out: 3.5 });
    expect((p.opacity as Prop<number> & { track: { keys: { t: number }[] } }).track.keys.map((k) => k.t)).toEqual([1.5, 2.5]);
    expect(byPath(headline({ in: 1, out: 3 }), 'move', -9, ctx()).timing).toEqual({ in: 0, out: 2 });
    // Pushed to the end: in stops a frame before it, out becomes "runs to the end".
    expect(byPath(headline({ in: 1, out: 3 }), 'move', 9, ctx()).timing).toEqual({ in: 5 - 1 / 30, out: null });
  });

  it('a moved edge snaps to a target within 6 px (either edge), else to frames', () => {
    // in 1 → 2.04, 4 px from the playhead at 2.
    expect(byPath(headline({ in: 1, out: 3 }), 'move', 1.04, ctx({ targets: [2] })).timing).toEqual({ in: 2, out: 4 });
    // out 3 → 3.97, 3 px from 4.
    expect(byPath(headline({ in: 1, out: 3 }), 'move', 0.97, ctx({ targets: [4] })).timing).toEqual({ in: 2, out: 4 });
    // 10 px away: frames only.
    expect(byPath(headline({ in: 1, out: 3 }), 'move', 1.1, ctx({ targets: [2] })).timing).toEqual({ in: 2.1, out: 4.1 });
  });

  it('trims keep at least one frame; trimming out to the end means "to the end"', () => {
    expect(byPath(headline({ in: 1, out: 3 }), 'in', 5, ctx()).timing).toEqual({ in: 3 - 1 / 30, out: 3 });
    expect(byPath(headline({ in: 1, out: 3 }), 'in', -0.5, ctx()).timing).toEqual({ in: 0.5, out: 3 });
    expect(byPath(headline({ in: 1, out: 3 }), 'out', 2.5, ctx()).timing).toEqual({ in: 1, out: null });
    expect(byPath(headline({ in: 1, out: null }), 'out', -1, ctx()).timing).toEqual({ in: 1, out: 4 });
    // Trims leave keys alone.
    expect(Object.keys(byPath(headline({ in: 1, out: 3 }), 'in', 0.5, ctx()))).toEqual(['timing']);
  });

  it('preset strips change start / end offset and lengths, frame-snapped', () => {
    const l = { ...headline({ in: 0, out: null }), motion: { enter: { preset: 'rise', start: 0.2, duration: 1, easing: { kind: 'linear' } }, exit: { preset: 'fade', endOffset: 0, duration: 0.6, easing: { kind: 'linear' } }, loop: null } } as TextLayer;
    expect(byPath(l, 'enter', 0.31, ctx())).toEqual({ 'motion.enter.start': 0.5 });
    expect(byPath(l, 'enter', -1, ctx())).toEqual({ 'motion.enter.start': 0 });
    expect(byPath(l, 'enter-length', -2, ctx())).toEqual({ 'motion.enter.duration': 1 / 30 });
    expect(byPath(l, 'exit', -0.5, ctx())).toEqual({ 'motion.exit.endOffset': 0.5 });
    expect(byPath(l, 'exit', 1, ctx())).toEqual({ 'motion.exit.endOffset': 0 });
    expect(byPath(l, 'exit-length', -0.4, ctx())).toEqual({ 'motion.exit.duration': 1 });
  });

  it('snap targets: comp ends, playhead, other layers’ edges (not its own, not the background)', () => {
    const doc = createBlankDoc('t');
    expect(snapTargets(doc, 'headline', 1.2)).toEqual([0, 5, 1.2]);
    expect(snapTargets(doc, 'bg', 1.2)).toEqual([0, 5, 1.2, 0, 5]);
    // A playhead paused between frames snaps edges onto the nearest frame.
    expect(snapTargets(doc, 'headline', 0.4999)).toEqual([0, 5, 0.5]);
  });
});
