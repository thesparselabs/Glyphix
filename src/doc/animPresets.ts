// Animation presets: a layer's whole animation (animated properties + enter/exit/loop motion + a custom glyph
// animator) as plain data that can be saved, applied to other layers and exchanged as a .json file.
// Times are relative to the layer's in point. Position and rotation keys are offsets from the first key and scale
// keys a factor of it, so a saved animation works on a layer anywhere on the canvas at any size; everything else
// is absolute. Pure: the UI turns the returned patches into one undo step.
import { animatableProps, propAt } from './animatable';
import { sampleValue } from './animate';
import type { Patch } from './history';
import { sameFrame, snapToFrame } from './keyframes';
import { ENTER_PRESETS, EXIT_PRESETS, LOOP_PRESETS, type Motion } from './motion';
import { layerSpan } from './timing';
import { REST_POSE, type Comp, type Easing, type GlyphAnimator, type Keyframe, type Layer, type Prop } from './types';

export type ValueKind = 'number' | 'color' | 'text';
type Rel = 'add' | 'mul' | null;

export interface AnimTrack {
  /** Layer prop id; effect params as `fx:@<effect kind>:<key>` / `fxc:@<effect kind>:<key>` (the first such effect). */
  propId: string;
  kind: ValueKind;
  /** add: keys are offsets from the target's value; mul: factors of it; null: absolute. */
  rel: Rel;
  /** `dt`: seconds after the layer's in point. */
  keys: { dt: number; v: unknown; out: Easing }[];
}

export interface Animation {
  layerType: Layer['type'];
  /** Seconds from the in point to the end of the last key / motion (for display). */
  duration: number;
  tracks: AnimTrack[];
  /** Enter/exit/loop are already relative to the in/out points. Null = the layer has none. */
  motion: Motion | null;
  /** Custom glyph animator; `start` is seconds after the in point. */
  animator: GlyphAnimator | null;
}

export interface AnimPreset extends Animation {
  id: string;
  name: string;
  createdAt: number;
}

const REL: Record<string, Rel> = { x: 'add', y: 'add', rotation: 'add', scale: 'mul' };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** Placed layers (image, text) share transform, opacity and effects; backgrounds and adjustments are their own kind. */
const family = (t: Layer['type']) => (t === 'image' || t === 'text' ? 'placed' : t);
export const animationFits = (anim: Pick<Animation, 'layerType'>, layerType: Layer['type']) => family(anim.layerType) === family(layerType);

/** Why a preset cannot be applied to a layer type (null = it fits). */
export function misfitReason(anim: Pick<Animation, 'layerType'>, layerType: Layer['type']): string | null {
  if (animationFits(anim, layerType)) return null;
  const name = (t: Layer['type']) => (t === 'background' ? 'a background' : t === 'adjustment' ? 'an adjustment layer' : 'an image or text layer');
  return `Made for ${name(anim.layerType)}`;
}

const hasMotion = (m: Motion) => !!(m.enter || m.exit || m.loop);

/** The layer's whole animation, or null when nothing animates (no keys, no motion, no animator). */
export function captureAnimation(layer: Layer, comp: Pick<Comp, 'duration'>): Animation | null {
  const t0 = layerSpan(layer, comp)[0];
  const tracks: AnimTrack[] = [];
  const seen = new Set<string>();
  for (const p of animatableProps(layer)) {
    const prop = propAt(layer, p.path);
    if (!prop || !('track' in prop) || !prop.track.keys.length) continue;
    let propId = p.id;
    const m = /^(fxc?):([^:]+):(.+)$/.exec(p.id);
    if (m) {
      const kind = layer.effects?.find((e) => e.id === m[2])?.kind;
      if (!kind) continue;
      propId = `${m[1]}:@${kind}:${m[3]}`;
    }
    if (seen.has(propId)) continue; // a second effect of the same kind: the first one wins
    seen.add(propId);
    const keys = [...prop.track.keys].sort((a, b) => a.t - b.t);
    const first = keys[0]!.v;
    let rel: Rel = p.kind === 'number' ? (REL[p.id] ?? null) : null;
    if (rel === 'mul' && first === 0) rel = null; // cannot express a factor of zero: keep absolute
    const rebase = (v: unknown) => (rel === 'add' ? (v as number) - (first as number) : rel === 'mul' ? (v as number) / (first as number) : v);
    tracks.push({ propId, kind: p.kind, rel, keys: keys.map((k) => ({ dt: k.t - t0, v: clone(rebase(k.v)), out: clone(k.out) })) });
  }
  const motion = 'motion' in layer && hasMotion(layer.motion) ? clone(layer.motion) : null;
  const animator = layer.type === 'text' && layer.animator ? clone({ ...layer.animator, start: layer.animator.start - t0 }) : null;
  if (!tracks.length && !motion && !animator) return null;
  const ends = [
    ...tracks.map((t) => t.keys[t.keys.length - 1]!.dt),
    motion?.enter ? motion.enter.start + motion.enter.duration : 0,
    motion?.exit ? motion.exit.duration : 0,
    animator ? animator.start + animator.duration : 0,
    0,
  ];
  return { layerType: layer.type, duration: Math.max(...ends), tracks, motion, animator };
}

export interface ApplyResult {
  /** Layer-relative patches. */
  patches: Patch[];
  /** Properties / motion parts applied, and ones skipped because the target cannot show them. */
  applied: number;
  skipped: number;
}

/**
 * Apply `anim` to `layer`: its keys land at the layer's in point + dt (on whole frames), replacing the keys of
 * each property it animates. Relative tracks start from the target's own value at the first key. Motion parts the
 * preset has replace the layer's; parts the layer type cannot show, and properties it does not have, are skipped.
 */
export function applyAnimation(layer: Layer, anim: Animation, comp: Pick<Comp, 'duration'>, fps: number): ApplyResult {
  const t0 = layerSpan(layer, comp)[0];
  const byId = new Map(animatableProps(layer).map((p) => [p.id, p]));
  const patches: Patch[] = [];
  let applied = 0;
  let skipped = 0;
  const target = (id: string) => {
    const m = /^(fxc?):@([^:]+):(.+)$/.exec(id);
    if (!m) return byId.get(id);
    const fx = layer.effects?.find((e) => e.kind === m[2]);
    return fx && byId.get(`${m[1]}:${fx.id}:${m[3]}`);
  };
  for (const track of anim.tracks) {
    const p = target(track.propId);
    const prop = p && propAt(layer, p.path);
    if (!p || !prop || p.kind !== track.kind || !track.keys.length) {
      skipped++;
      continue;
    }
    const src = [...track.keys].sort((a, b) => a.dt - b.dt);
    const tFirst = Math.max(0, snapToFrame(t0 + src[0]!.dt, fps));
    const base = track.rel ? (sampleValue(prop, tFirst) as number) : 0;
    const keys: Keyframe<unknown>[] = [];
    for (const k of src) {
      const t = Math.max(0, snapToFrame(t0 + k.dt, fps));
      const v = track.rel === 'add' ? base + (k.v as number) : track.rel === 'mul' ? base * (k.v as number) : clone(k.v);
      const key = { t, v, out: clone(k.out) };
      const same = keys.findIndex((x) => sameFrame(x.t, t, fps));
      if (same >= 0) keys[same] = key; // two keys on one frame: the later wins
      else keys.push(key);
    }
    patches.push({ path: p.path, value: { track: { keys } } as Prop<unknown> });
    applied++;
  }
  if (anim.motion && (layer.type === 'image' || layer.type === 'text')) {
    const type = layer.type;
    const next: Motion = { ...layer.motion };
    let changed = false;
    for (const [slot, list] of [['enter', ENTER_PRESETS], ['exit', EXIT_PRESETS], ['loop', LOOP_PRESETS]] as const) {
      const part = anim.motion[slot];
      if (!part) continue;
      if ((list as readonly { id: string; for: string[] }[]).find((x) => x.id === part.preset)?.for.includes(type)) {
        (next as unknown as Record<string, unknown>)[slot] = clone(part);
        applied++;
        changed = true;
      } else skipped++;
    }
    if (changed) patches.push({ path: ['motion'], value: next });
  } else if (anim.motion) {
    skipped += [anim.motion.enter, anim.motion.exit, anim.motion.loop].filter(Boolean).length;
  }
  if (anim.animator) {
    if (layer.type === 'text') {
      patches.push({ path: ['animator'], value: { ...clone(anim.animator), start: Math.max(0, t0 + anim.animator.start) } });
      applied++;
    } else skipped++;
  }
  return { patches, applied, skipped };
}

// ---------------------------------------------------------------------------
// Preset files

export const PRESET_FILE_FORMAT = 'glyphix-presets';
export const PRESET_FILE_VERSION = 1;

/** A file that is not a (readable) presets file; the message is meant for the user. */
export class PresetFileError extends Error {}

export const presetFileJson = (presets: readonly AnimPreset[]) => JSON.stringify({ format: PRESET_FILE_FORMAT, version: PRESET_FILE_VERSION, presets }, null, 2);

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isColor = (v: unknown) => Array.isArray(v) && v.length === 4 && v.every(num);

function bad(why: string): never {
  throw new Error(why);
}

function easing(e: unknown, where: string): Easing {
  if (!isObj(e)) bad(`${where} easing is missing`);
  const fields: Record<string, string[]> = { linear: [], hold: [], bezier: ['x1', 'y1', 'x2', 'y2'], spring: ['mass', 'stiffness', 'damping'], steps: ['n'], bounce: ['n'] };
  const f = typeof e.kind === 'string' ? fields[e.kind] : undefined;
  if (!f) bad(`${where} easing "${String(e.kind)}" is unknown`);
  for (const k of f) if (!num(e[k])) bad(`${where} easing has a bad "${k}"`);
  return Object.fromEntries(['kind', ...f].map((k) => [k, e[k]])) as unknown as Easing;
}

function value(v: unknown, kind: ValueKind, where: string): unknown {
  if ((kind === 'number' && num(v)) || (kind === 'color' && isColor(v)) || (kind === 'text' && typeof v === 'string')) return clone(v);
  return bad(`${where} has a ${kind} value that is not valid`);
}

const ids = (list: readonly { id: string }[]) => new Set(list.map((p) => p.id));
const [ENTER_IDS, EXIT_IDS, LOOP_IDS] = [ids(ENTER_PRESETS), ids(EXIT_PRESETS), ids(LOOP_PRESETS)];

function motion(m: unknown): Motion {
  if (!isObj(m)) bad('the motion is not valid');
  const out: Motion = { enter: null, exit: null, loop: null };
  const part = (slot: 'enter' | 'exit' | 'loop', known: Set<string>, numbers: string[]) => {
    const p = m[slot];
    if (p == null) return;
    if (!isObj(p) || typeof p.preset !== 'string' || !known.has(p.preset)) bad(`the ${slot} animation "${String(isObj(p) ? p.preset : p)}" is unknown`);
    for (const k of numbers) if (!num(p[k])) bad(`the ${slot} animation has a bad "${k}"`);
    const c = clone(p) as Record<string, unknown>;
    if (slot !== 'loop') c.easing = easing(c.easing, `the ${slot} animation`);
    if (c.stagger !== undefined && !isObj(c.stagger)) bad(`the ${slot} animation has bad letter timing`);
    (out as unknown as Record<string, unknown>)[slot] = c;
  };
  part('enter', ENTER_IDS, ['start', 'duration']);
  part('exit', EXIT_IDS, ['endOffset', 'duration']);
  part('loop', LOOP_IDS, ['period', 'amount']);
  return out;
}

function animator(a: unknown): GlyphAnimator {
  if (!isObj(a) || !isObj(a.pose)) bad('the glyph animator is not valid');
  for (const k of ['start', 'duration', 'stagger', 'seed']) if (!num(a[k])) bad(`the glyph animator has a bad "${k}"`);
  if (!['glyph', 'word', 'line'].includes(a.unit as string)) bad('the glyph animator has an unknown unit');
  if (!['forward', 'reverse', 'center', 'edges', 'random'].includes(a.order as string)) bad('the glyph animator has an unknown order');
  const pose: Record<string, unknown> = { ...REST_POSE };
  for (const [k, v] of Object.entries(a.pose)) {
    const rest = (REST_POSE as unknown as Record<string, unknown>)[k];
    if (rest === undefined) continue;
    const ok = k === 'color' ? v === null || isColor(v) : typeof v === typeof rest && (typeof v !== 'number' || num(v));
    if (!ok) bad(`the glyph animator pose has a bad "${k}"`);
    pose[k] = v;
  }
  return { ...(clone(a) as unknown as GlyphAnimator), easing: easing(a.easing, 'the glyph animator'), falloff: easing(a.falloff, 'the glyph animator'), pose: pose as unknown as GlyphAnimator['pose'] };
}

function preset(raw: unknown): AnimPreset {
  if (!isObj(raw)) bad('it is not an object');
  if (typeof raw.id !== 'string' || !raw.id) bad('it has no id');
  if (typeof raw.name !== 'string' || !raw.name.trim()) bad('it has no name');
  if (!['image', 'text', 'background', 'adjustment'].includes(raw.layerType as string)) bad('its layer type is unknown');
  if (!Array.isArray(raw.tracks)) bad('it has no list of animated properties');
  const tracks = raw.tracks.map((t: unknown, i): AnimTrack => {
    const where = `property ${i + 1}`;
    if (!isObj(t) || typeof t.propId !== 'string' || !t.propId) bad(`${where} has no id`);
    if (t.kind !== 'number' && t.kind !== 'color' && t.kind !== 'text') bad(`${where} has an unknown value type`);
    if (t.rel !== null && t.rel !== 'add' && t.rel !== 'mul') bad(`${where} has an unknown relative mode`);
    if (t.rel && t.kind !== 'number') bad(`${where} is relative but not a number`);
    if (!Array.isArray(t.keys) || !t.keys.length) bad(`${where} has no keys`);
    const kind = t.kind;
    const keys = t.keys.map((k: unknown, j: number) => {
      if (!isObj(k) || !num(k.dt)) bad(`${where} key ${j + 1} has a bad time`);
      return { dt: k.dt, v: value(k.v, kind, `${where} key ${j + 1}`), out: easing(k.out, `${where} key ${j + 1}`) };
    });
    return { propId: t.propId, kind, rel: t.rel, keys };
  });
  return {
    id: raw.id,
    name: raw.name.trim(),
    createdAt: num(raw.createdAt) ? raw.createdAt : Date.now(),
    layerType: raw.layerType as Layer['type'],
    duration: num(raw.duration) ? raw.duration : 0,
    tracks,
    motion: raw.motion == null ? null : motion(raw.motion),
    animator: raw.animator == null ? null : animator(raw.animator),
  };
}

/** Read a presets file's JSON. Throws `PresetFileError` with a readable message. */
export function parsePresetFile(json: unknown): AnimPreset[] {
  if (!isObj(json) || json.format !== PRESET_FILE_FORMAT || !num(json.version)) throw new PresetFileError('This is not a Glyphix presets file.');
  if (json.version > PRESET_FILE_VERSION) throw new PresetFileError(`This presets file was made by a newer version of Glyphix (file version ${json.version}). Update the app to open it.`);
  if (!Array.isArray(json.presets)) throw new PresetFileError('This presets file has no list of presets.');
  return json.presets.map((raw: unknown, i: number) => {
    try {
      return preset(raw);
    } catch (e) {
      throw new PresetFileError(`Preset ${i + 1} is damaged (${e instanceof Error ? e.message : String(e)}).`);
    }
  });
}

/** Parse the text of a presets file (also reports text that is not JSON). */
export function parsePresetText(text: string): AnimPreset[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PresetFileError('This is not a Glyphix presets file (it is not valid JSON).');
  }
  return parsePresetFile(json);
}
