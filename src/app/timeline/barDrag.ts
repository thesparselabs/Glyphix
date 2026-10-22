// What dragging a part of a layer's timeline bar does, as layer-relative patches. Pure, so it is unit-tested;
// the bar component only turns pointer movement into `dt` (seconds since the drag began).
import { isPlaced, layerSpan, moveLayerInTime, snapToFrame, type Doc, type Layer, type Patch } from '@/doc';

export type BarPart = 'move' | 'in' | 'out' | 'enter' | 'enter-length' | 'exit' | 'exit-length';

export const BAR_LABELS: Record<BarPart, string> = {
  move: 'Move layer in time',
  in: 'Trim in point',
  out: 'Trim out point',
  enter: 'Move enter animation',
  'enter-length': 'Enter animation length',
  exit: 'Move exit animation',
  'exit-length': 'Exit animation length',
};

export interface DragContext {
  fps: number;
  duration: number;
  /** Pixels per second (snap distance is in pixels). */
  pps: number;
  /** Times the in/out edges snap to (playhead, comp ends, other layers' edges); empty = frames only. */
  targets: readonly number[];
}

const SNAP_PX = 6;

/** Nearest target within snap distance of `t`, if any. */
function nearTarget(t: number, ctx: DragContext): { t: number; dist: number } | null {
  let best: { t: number; dist: number } | null = null;
  for (const x of ctx.targets) {
    const dist = Math.abs(x - t) * ctx.pps;
    if (dist <= SNAP_PX && (!best || dist < best.dist)) best = { t: x, dist };
  }
  return best;
}

const snapEdge = (t: number, ctx: DragContext) => nearTarget(t, ctx)?.t ?? snapToFrame(t, ctx.fps);

/** An out point at (or past) the comp end means "runs to the end". */
const outValue = (t: number, duration: number) => (t >= duration - 1e-9 ? null : t);

/** Edges other layers' in/out points, the playhead and the comp ends — what a dragged bar edge snaps to. */
export function snapTargets(doc: Doc, layerId: string, playhead: number): number[] {
  // On frames (a paused playhead is usually between two), so a snapped edge is always on a frame; the comp end stays
  // exact (an out point there means "to the end").
  const f = (t: number) => snapToFrame(t, doc.comp.fps);
  const out = [0, doc.comp.duration, f(playhead)];
  for (const l of doc.comp.layers) if (l.id !== layerId && l.type !== 'background') out.push(...layerSpan(l, doc.comp).map((t) => (t >= doc.comp.duration ? t : f(t))));
  return out;
}

export function dragPatches(part: BarPart, layer: Layer, dt: number, ctx: DragContext): Patch[] {
  if (layer.type === 'background') return [];
  const frame = 1 / ctx.fps;
  const [a, b] = layerSpan(layer, ctx);
  const f = (t: number) => snapToFrame(t, ctx.fps);
  switch (part) {
    case 'move': {
      // Snap whichever edge is closer to a target; otherwise keep the in point on a frame.
      const sa = nearTarget(a + dt, ctx);
      const sb = nearTarget(b + dt, ctx);
      let d = sa && (!sb || sa.dist <= sb.dist) ? sa.t - a : sb ? sb.t - b : f(a + dt) - a;
      d = Math.max(-a, Math.min(ctx.duration - frame - a, d));
      const patches = moveLayerInTime(layer, d);
      const timing = { in: a + d, out: outValue(Math.min(ctx.duration, b + d), ctx.duration) };
      return patches.map((p) => (p.path.length === 1 && p.path[0] === 'timing' ? { path: p.path, value: timing } : p));
    }
    case 'in':
      return [{ path: ['timing'], value: { in: Math.max(0, Math.min(b - frame, snapEdge(a + dt, ctx))), out: layer.timing.out } }];
    case 'out':
      return [{ path: ['timing'], value: { in: layer.timing.in, out: outValue(Math.max(a + frame, Math.min(ctx.duration, snapEdge(b + dt, ctx))), ctx.duration) } }];
  }
  if (!isPlaced(layer)) return [];
  const { enter, exit } = layer.motion;
  switch (part) {
    case 'enter':
      return enter ? [{ path: ['motion', 'enter', 'start'], value: Math.max(0, f(enter.start + dt)) }] : [];
    case 'enter-length':
      return enter ? [{ path: ['motion', 'enter', 'duration'], value: Math.max(frame, f(enter.duration + dt)) }] : [];
    case 'exit':
      return exit ? [{ path: ['motion', 'exit', 'endOffset'], value: Math.max(0, f(exit.endOffset - dt)) }] : [];
    case 'exit-length':
      return exit ? [{ path: ['motion', 'exit', 'duration'], value: Math.max(frame, f(exit.duration - dt)) }] : [];
  }
  return [];
}
