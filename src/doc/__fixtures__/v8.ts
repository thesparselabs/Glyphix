// Test helper: a current document written back in the v8 format (before colours, text, shadows, borders, outlines,
// gradients, radius and effect colours could be animated), so migration tests start from the real old shape.
import type { Doc } from '../types';

type Json = Record<string, unknown>;

const un = (v: unknown) => {
  if (v && typeof v === 'object' && 'static' in v) return (v as { static: unknown }).static;
  if (v === undefined || v === null) return v;
  throw new Error(`v8 has no animated value here: ${JSON.stringify(v)}`);
};
const unwrap = (o: unknown, keys: string[]) => {
  if (!o || typeof o !== 'object') return o;
  const out: Json = { ...(o as Json) };
  for (const k of keys) if (k in out) out[k] = un(out[k]);
  return out;
};

export function toV8(doc: Doc): Json {
  const d = structuredClone(doc) as unknown as Json & { comp: Json & { layers: Json[] } };
  d.schemaVersion = 8;
  d.comp.layers = d.comp.layers.map((l) => {
    const out: Json = { ...l, effects: (l.effects as Json[]).map((e) => ({ ...e, colors: Object.fromEntries(Object.entries(e.colors as Json).map(([k, c]) => [k, un(c)])) })) };
    if (l.type === 'background') {
      const f = l.fill as Json;
      if (f.kind === 'solid') out.fill = unwrap(f, ['color']);
      if (f.kind === 'linear') out.fill = { ...(unwrap(f, ['angle']) as Json), stops: (f.stops as Json[]).map((s) => unwrap(s, ['offset', 'color'])) };
      if (f.kind === 'mesh') out.fill = { ...f, points: (f.points as Json[]).map((p) => unwrap(p, ['x', 'y', 'color'])) };
    }
    if (l.type === 'image') Object.assign(out, { radius: un(l.radius), shadow: unwrap(l.shadow, ['blur', 'offsetX', 'offsetY', 'color']), border: unwrap(l.border, ['width', 'color']) });
    if (l.type === 'text')
      Object.assign(out, unwrap(l, ['text', 'color', 'glowColor']), {
        gradient: unwrap(l.gradient, ['angle', 'from', 'to']),
        outline: unwrap(l.outline, ['width', 'color']),
        shadow: unwrap(l.shadow, ['offsetX', 'offsetY', 'blur', 'color']),
      });
    return out;
  });
  return d;
}
