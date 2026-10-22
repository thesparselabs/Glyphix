// Saved documents carry `schemaVersion`. Every load (IndexedDB or .glyphix file) runs the
// migrations from the saved version up to SCHEMA_VERSION, in order. Migrations take and return
// plain JSON so they never depend on the current TypeScript types.
import { SCHEMA_VERSION, type Doc } from './types';

type Json = Record<string, unknown>;

/** MIGRATIONS[v] upgrades a version-v document to v+1. */
const MIGRATIONS: Record<number, (doc: Json) => Json> = {
  // v1 → v2: layers gain `motion` (animation presets).
  1: (doc) => {
    const comp = doc.comp as Json & { layers: Json[] };
    return {
      ...doc,
      comp: {
        ...comp,
        layers: comp.layers.map((l) => (l.type === 'background' || 'motion' in l ? l : { ...l, motion: { enter: null, loop: null } })),
      },
    };
  },
  // v2 → v3: motion gains `exit`; text gains weight/lineHeight/gradient/outline/shadow;
  // the glyph animator's `from` becomes a full pose with unit + falloff.
  2: (doc) => {
    const comp = doc.comp as Json & { layers: Json[] };
    const layers = comp.layers.map((l) => {
      if (l.type === 'background') return l;
      const motion = { exit: null, ...(l.motion as Json) };
      if (l.type !== 'text') return { ...l, motion };
      const a = l.animator as (Json & { from?: Record<string, number> }) | null;
      // Tolerate documents that already have the new shape (hand-edited or partially migrated).
      const animator = !a || !a.from ? a : {
        unit: 'glyph',
        order: a.order,
        start: a.start,
        duration: a.duration,
        stagger: a.stagger,
        falloff: { kind: 'linear' },
        seed: a.seed,
        easing: a.easing,
        pose: {
          offsetX: a.from.offsetX ?? 0,
          offsetY: a.from.offsetY ?? 0,
          scaleX: a.from.scale ?? 1,
          scaleY: a.from.scale ?? 1,
          rotation: a.from.rotation ?? 0,
          rotateX: 0,
          rotateY: 0,
          skewX: 0,
          opacity: a.from.opacity ?? 1,
          blur: 0,
          spread: 1,
          color: null,
          randomOffset: 0,
          randomRotation: 0,
          scramble: false,
        },
      };
      return { weight: 400, lineHeight: 1.15, gradient: null, outline: null, shadow: null, ...l, animator, motion };
    });
    return { ...doc, comp: { ...comp, layers } };
  },
  // v3 → v4: every layer gains an effect stack.
  3: (doc) => {
    const comp = doc.comp as Json & { layers: Json[] };
    return { ...doc, comp: { ...comp, layers: comp.layers.map((l) => ({ effects: [], ...l })) } };
  },
  // v4 → v5: image layers can show a video.
  4: (doc) => {
    const comp = doc.comp as Json & { layers: Json[] };
    return { ...doc, comp: { ...comp, layers: comp.layers.map((l) => (l.type === 'image' ? { video: null, ...l } : l)) } };
  },
  // v6 → v7: layers gain in/out points (on for the whole comp, as before).
  6: (doc) => {
    const comp = doc.comp as Json & { layers: Json[] };
    return { ...doc, comp: { ...comp, layers: comp.layers.map((l) => ({ timing: { in: 0, out: null }, ...l })) } };
  },
  // v7 → v8: a new easing kind (bounce); nothing to change.
  7: (doc) => doc,
  // v8 → v9: colours, text, shadows, borders, outlines, gradients, radius and effect colours can be animated:
  // their values become static Props (same values, so renders are unchanged).
  8: (doc) => {
    const comp = doc.comp as Json & { layers: Json[] };
    const st = (v: unknown) => (v === undefined ? v : { static: v });
    const wrap = (o: unknown, keys: string[]): unknown => {
      if (!o || typeof o !== 'object') return o;
      const out: Json = { ...(o as Json) };
      for (const k of keys) if (k in out) out[k] = st(out[k]);
      return out;
    };
    const fill = (f: unknown): unknown => {
      if (!f || typeof f !== 'object') return f;
      const x = f as Json;
      if (x.kind === 'solid') return wrap(x, ['color']);
      if (x.kind === 'linear') return { ...wrap(x, ['angle']) as Json, stops: ((x.stops as Json[] | undefined) ?? []).map((s) => wrap(s, ['offset', 'color'])) };
      if (x.kind === 'mesh') return { ...x, points: ((x.points as Json[] | undefined) ?? []).map((p) => wrap(p, ['x', 'y', 'color'])) };
      return x;
    };
    const effect = (e: Json): Json => ({ ...e, colors: Object.fromEntries(Object.entries((e.colors as Json | undefined) ?? {}).map(([k, c]) => [k, st(c)])) });
    const layer = (l: Json): Json => {
      const out: Json = { ...l, effects: ((l.effects as Json[] | undefined) ?? []).map(effect) };
      if (l.type === 'background') out.fill = fill(l.fill);
      if (l.type === 'image') {
        out.radius = st(l.radius);
        out.shadow = wrap(l.shadow, ['blur', 'offsetX', 'offsetY', 'color']);
        out.border = wrap(l.border, ['width', 'color']);
      }
      if (l.type === 'text') {
        Object.assign(out, wrap(l, ['text', 'color', 'glowColor']));
        out.gradient = wrap(l.gradient, ['angle', 'from', 'to']);
        out.outline = wrap(l.outline, ['width', 'color']);
        out.shadow = wrap(l.shadow, ['offsetX', 'offsetY', 'blur', 'color']);
      }
      return out;
    };
    return { ...doc, comp: { ...comp, layers: comp.layers.map(layer) } };
  },
  // v5 → v6: effects gain text settings; existing ASCII effects keep their square cells.
  5: (doc) => {
    const comp = doc.comp as Json & { layers: Json[] };
    const effect = (e: Json): Json => {
      const out: Json = { text: {}, ...e };
      if (e.kind === 'ascii') out.params = { square: { static: 1 }, ...(e.params as Json) };
      return out;
    };
    return { ...doc, comp: { ...comp, layers: comp.layers.map((l) => ({ ...l, effects: ((l.effects as Json[] | undefined) ?? []).map(effect) })) } };
  },
};

export class NewerSchemaError extends Error {
  constructor(readonly found: number) {
    super(`This project was saved by a newer version of Glyphix (format ${found}; this app reads up to ${SCHEMA_VERSION}).`);
  }
}

export function migrate(input: unknown): Doc {
  if (!input || typeof input !== 'object' || !('comp' in input)) throw new Error('Not a Glyphix project');
  let doc = input as Json;
  let v = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 1;
  if (v > SCHEMA_VERSION) throw new NewerSchemaError(v);
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`No migration from format ${v}`);
    doc = step(doc);
    v++;
  }
  return { ...doc, schemaVersion: SCHEMA_VERSION } as unknown as Doc;
}
