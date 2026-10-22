// Layer in/out points. A layer is on screen from `timing.in` until `timing.out` (or the comp's end). Enter
// presets are timed from the in point and exit presets from the out point, so a layer's animation travels with
// it; loops, keyframes and video clips stay on the comp clock.
import type { Motion } from './motion';
import type { Comp, Layer } from './types';

/** [in, out) in comp seconds, clamped to the comp. Backgrounds span the whole comp. */
export function layerSpan(layer: Layer, comp: Pick<Comp, 'duration'>): [number, number] {
  if (layer.type === 'background' || !layer.timing) return [0, comp.duration];
  const a = Math.min(comp.duration, Math.max(0, layer.timing.in));
  const b = Math.min(comp.duration, layer.timing.out ?? comp.duration);
  return [a, Math.max(a, b)];
}

export function isOnScreen(layer: Layer, comp: Pick<Comp, 'duration'>, t: number): boolean {
  const [a, b] = layerSpan(layer, comp);
  // A layer that starts at 0 / runs to the end is never cut on that side (the comp's last frame, and times
  // outside the comp, look exactly as they did before in/out points existed).
  return (a <= 0 || t >= a) && (b >= comp.duration || t < b);
}

/**
 * A layer's motion on the comp clock: the enter preset moved to start at the in point, and the comp's end
 * replaced by the out point (exit presets measure from there).
 */
export function motionOnComp<C extends Pick<Comp, 'duration'>>(motion: Motion, layer: Layer, comp: C): { motion: Motion; comp: C } {
  const [a, b] = layerSpan(layer, comp);
  if (a === 0 && b === comp.duration) return { motion, comp };
  return {
    motion: { ...motion, enter: motion.enter && { ...motion.enter, start: motion.enter.start + a } },
    comp: { ...comp, duration: b },
  };
}
