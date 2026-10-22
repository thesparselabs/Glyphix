import { Easings } from './easing';
import type { Keyframe, Prop } from './types';

// Editing helpers for properties that may be animated. Direct manipulation on the canvas
// shifts/scales the whole animation so it keeps its shape (there's no keyframe editor in Phase 1).

export function offsetProp(prop: Prop<number>, delta: number): Prop<number> {
  if ('static' in prop) return { static: prop.static + delta };
  return { track: { keys: prop.track.keys.map((k) => ({ ...k, v: k.v + delta })) } };
}

export function scaleProp(prop: Prop<number>, factor: number): Prop<number> {
  if ('static' in prop) return { static: prop.static * factor };
  return { track: { keys: prop.track.keys.map((k) => ({ ...k, v: k.v * factor })) } };
}

export function isAnimated(prop: Prop<unknown>): boolean {
  return 'track' in prop;
}

// Keyframes at the playhead (the effect panel's keyframe buttons). Times within half a frame match.

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

export function keyAt<V>(prop: Prop<V>, t: number, eps: number): Keyframe<V> | null {
  if ('static' in prop) return null;
  return prop.track.keys.find((k) => near(k.t, t, eps)) ?? null;
}

/** Set the value at `t`: a static prop stays static; an animated one gets (or updates) a key at `t`. */
export function setValueAt<V>(prop: Prop<V>, t: number, v: V, eps: number): Prop<V> {
  if ('static' in prop) return { static: v };
  return addKey(prop, t, v, eps);
}

/** Add (or replace) a key at `t`. A static prop becomes animated with this one key. */
export function addKey<V>(prop: Prop<V>, t: number, v: V, eps: number): Prop<V> {
  const keys = 'static' in prop ? [] : prop.track.keys.filter((k) => !near(k.t, t, eps));
  const out = ('static' in prop ? null : prop.track.keys.find((k) => near(k.t, t, eps))?.out) ?? Easings.easeInOutCubic;
  keys.push({ t, v, out });
  keys.sort((a, b) => a.t - b.t);
  return { track: { keys } };
}

/** Remove the key at `t`; the last key removed turns the prop back into a static value. */
export function removeKey<V>(prop: Prop<V>, t: number, eps: number): Prop<V> {
  if ('static' in prop) return prop;
  const hit = prop.track.keys.find((k) => near(k.t, t, eps));
  const keys = prop.track.keys.filter((k) => k !== hit);
  return keys.length ? { track: { keys } } : { static: hit?.v ?? prop.track.keys[0]!.v };
}
