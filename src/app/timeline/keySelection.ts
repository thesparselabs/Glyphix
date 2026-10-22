// Selected keyframes (one layer at a time) and the key clipboard, plus the actions the timeline and the global
// shortcuts share: delete, nudge, copy, paste, jump to the previous/next key. Keys are named by property id and
// frame number (`opacity|36`), so selection survives undo and never compares floats.
import { create } from 'zustand';
import { animatableProps, copyKeys, deleteKeys, moveKeys, pasteKeys, propAt, putKey, sampleValue, setKeyEasing, snapToFrame, type Easing, type KeyClipboard, type Layer, type Prop } from '@/doc';
import { layerIndex, useEditor } from '../store';

export const keyName = (propId: string, frame: number) => `${propId}|${frame}`;
const parse = (name: string) => {
  const i = name.lastIndexOf('|');
  return { propId: name.slice(0, i), frame: Number(name.slice(i + 1)) };
};

interface KeySelection {
  layerId: string | null;
  keys: ReadonlySet<string>;
  clipboard: KeyClipboard | null;
  setKeys(layerId: string, keys: Iterable<string>): void;
  toggle(layerId: string, key: string): void;
  clear(): void;
}

export const useKeySelection = create<KeySelection>((set, get) => ({
  layerId: null,
  keys: new Set(),
  clipboard: null,
  setKeys: (layerId, keys) => set({ layerId, keys: new Set(keys) }),
  toggle(layerId, key) {
    const keys = new Set(get().layerId === layerId ? get().keys : []);
    if (!keys.delete(key)) keys.add(key);
    set({ layerId, keys });
  },
  clear: () => set({ layerId: null, keys: new Set() }),
}));

// Selecting another layer (canvas, layers panel) drops the key selection.
useEditor.subscribe((s, prev) => {
  const k = useKeySelection.getState();
  if (s.selectedId !== prev.selectedId && k.layerId && s.selectedId !== k.layerId) k.clear();
});

/** Selected key times per property id. */
export function selectionTimes(keys: Iterable<string>, fps: number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const name of keys) {
    const { propId, frame } = parse(name);
    out.set(propId, [...(out.get(propId) ?? []), frame / fps]);
  }
  return out;
}

/** The layer the key selection belongs to, if it still exists and is editable. */
function selectedLayer(): { layer: Layer; i: number } | null {
  const { layerId, keys } = useKeySelection.getState();
  if (!layerId || !keys.size) return null;
  const doc = useEditor.getState().doc;
  const i = layerIndex(doc, layerId);
  const layer = doc.comp.layers[i];
  return layer && !layer.locked ? { layer, i } : null;
}

const toDoc = (i: number, patches: { path: readonly (string | number)[]; value: unknown }[]) => patches.map((p) => ({ path: ['comp', 'layers', i, ...p.path], value: p.value }));

/** Patches moving the selected keys of `layer` by `dt` seconds (frame-snapped by the caller). */
export function moveSelectedPatches(layer: Layer, keys: Iterable<string>, dt: number, fps: number) {
  const sel = selectionTimes(keys, fps);
  return animatableProps(layer).flatMap((p) => {
    const times = sel.get(p.id);
    const prop = times && propAt(layer, p.path);
    return prop ? [{ path: p.path, value: moveKeys(prop, times, dt, fps) }] : [];
  });
}

/** Shift the selection's frame numbers after a move. */
export function shiftSelection(layerId: string, keys: Iterable<string>, frames: number) {
  useKeySelection.getState().setKeys(
    layerId,
    [...keys].map((n) => {
      const { propId, frame } = parse(n);
      return keyName(propId, Math.max(0, frame + frames));
    }),
  );
}

export function deleteSelectedKeys(): boolean {
  const hit = selectedLayer();
  if (!hit) return false;
  const { fps } = useEditor.getState().doc.comp;
  const sel = selectionTimes(useKeySelection.getState().keys, fps);
  const patches = animatableProps(hit.layer).flatMap((p) => {
    const times = sel.get(p.id);
    const prop = times && propAt(hit.layer, p.path);
    return prop ? [{ path: p.path, value: deleteKeys(prop, times, fps) }] : [];
  });
  useEditor.getState().set('Delete keyframes', toDoc(hit.i, patches));
  useKeySelection.getState().clear();
  return true;
}

/** Move the selected keys by whole frames; repeated presses coalesce into one undo step. */
export function nudgeSelectedKeys(frames: number): boolean {
  const hit = selectedLayer();
  if (!hit) return false;
  const { keys } = useKeySelection.getState();
  const { fps } = useEditor.getState().doc.comp;
  const earliest = Math.min(...[...keys].map((n) => parse(n).frame));
  const f = Math.max(-earliest, frames);
  if (!f) return true;
  useEditor.getState().set('Nudge keyframes', toDoc(hit.i, moveSelectedPatches(hit.layer, keys, f / fps, fps)), `key-nudge:${hit.layer.id}`);
  shiftSelection(hit.layer.id, keys, f);
  return true;
}

export function copySelectedKeys(): boolean {
  const hit = selectedLayer();
  if (!hit) return false;
  const { fps } = useEditor.getState().doc.comp;
  const clip = copyKeys(hit.layer, selectionTimes(useKeySelection.getState().keys, fps), fps);
  if (clip) useKeySelection.setState({ clipboard: clip });
  return !!clip;
}

/** Paste the copied keys at the playhead onto the same properties of the selected layer; selects them. */
export function pasteKeysAtPlayhead(): boolean {
  const { clipboard } = useKeySelection.getState();
  const s = useEditor.getState();
  const i = s.selectedId ? layerIndex(s.doc, s.selectedId) : -1;
  const layer = s.doc.comp.layers[i];
  if (!clipboard || !layer || layer.locked) return false;
  const { fps } = s.doc.comp;
  const patches = pasteKeys(layer, clipboard, s.time, fps);
  if (!patches.length) return false;
  s.set('Paste keyframes', toDoc(i, patches));
  // Select what was pasted: keys of the pasted properties on the pasted frames.
  const byPath = new Map(animatableProps(layer).map((p) => [p.path.join('.'), p.id]));
  const t0 = snapToFrame(s.time, fps);
  const frames = new Set(clipboard.items.map((it) => Math.round((t0 + it.dt) * fps)));
  const pasted = patches.flatMap((p) => {
    const id = byPath.get(p.path.join('.'))!;
    const prop = p.value as Prop<number>;
    return 'track' in prop ? prop.track.keys.map((k) => Math.round(k.t * fps)).filter((f) => frames.has(f)).map((f) => keyName(id, f)) : [];
  });
  useKeySelection.getState().setKeys(layer.id, pasted);
  return true;
}

/** All key times of a layer, sorted, one per frame. */
export function layerKeyTimes(layer: Layer, fps: number): number[] {
  const frames = new Set<number>();
  for (const p of animatableProps(layer)) {
    const prop = propAt(layer, p.path);
    if (prop && 'track' in prop) for (const k of prop.track.keys) frames.add(Math.round(k.t * fps));
  }
  return [...frames].sort((a, b) => a - b).map((f) => f / fps);
}

/** Move the playhead to the previous (-1) / next (+1) key of the selected layer. */
export function jumpToKey(dir: -1 | 1): boolean {
  const s = useEditor.getState();
  const layer = s.doc.comp.layers.find((l) => l.id === s.selectedId);
  if (!layer) return false;
  const { fps } = s.doc.comp;
  const times = layerKeyTimes(layer, fps);
  const half = 0.5 / fps;
  const t = dir > 0 ? times.find((x) => x > s.time + half) : times.findLast((x) => x < s.time - half);
  if (t === undefined) return false;
  s.setPlaying(false);
  s.setTime(t);
  return true;
}

/** Add (or replace) a key at the playhead with the property's current value there. */
export function addKeyAtPlayhead(layerId: string, propId: string) {
  const s = useEditor.getState();
  const i = layerIndex(s.doc, layerId);
  const layer = s.doc.comp.layers[i];
  const p = layer && animatableProps(layer).find((x) => x.id === propId);
  const prop = p && propAt(layer, p.path);
  if (!p || !prop || layer.locked) return;
  const { fps } = s.doc.comp;
  s.set(`Add ${p.label} keyframe`, toDoc(i, [{ path: p.path, value: putKey(prop, s.time, sampleValue(prop, s.time), fps) }]));
  useKeySelection.getState().setKeys(layerId, [keyName(propId, Math.round(snapToFrame(s.time, fps) * fps))]);
}

/** The easing leaving the selected keys: one value, null when they differ; `skipped` = last keys (no next key). */
export function selectedKeysEasing(): { value: Easing | null; editable: number; skipped: number } | null {
  const { layerId, keys } = useKeySelection.getState();
  const doc = useEditor.getState().doc;
  const layer = layerId ? doc.comp.layers.find((l) => l.id === layerId) : undefined;
  if (!layer || !keys.size) return null;
  const sel = selectionTimes(keys, doc.comp.fps);
  const found: Easing[] = [];
  let skipped = 0;
  for (const p of animatableProps(layer)) {
    const prop = sel.has(p.id) ? propAt(layer, p.path) : undefined;
    if (!prop || !('track' in prop)) continue;
    const last = prop.track.keys.at(-1);
    for (const k of prop.track.keys) {
      if (!sel.get(p.id)!.some((t) => Math.abs(t - k.t) < 0.5 / doc.comp.fps)) continue;
      if (k === last) skipped++;
      else found.push(k.out);
    }
  }
  const same = found.every((e) => JSON.stringify(e) === JSON.stringify(found[0]));
  return { value: found.length && same ? found[0]! : null, editable: found.length, skipped };
}

/** Set the easing leaving every selected key (last keys are skipped). */
export function setSelectedKeysEasing(easing: Easing, coalesceKey?: string): boolean {
  const hit = selectedLayer();
  if (!hit) return false;
  const { fps } = useEditor.getState().doc.comp;
  const sel = selectionTimes(useKeySelection.getState().keys, fps);
  const patches = animatableProps(hit.layer).flatMap((p) => {
    const times = sel.get(p.id);
    const prop = times && propAt(hit.layer, p.path);
    return prop ? [{ path: p.path, value: setKeyEasing(prop, times, easing, fps) }] : [];
  });
  useEditor.getState().set('Keyframe easing', toDoc(hit.i, patches), coalesceKey && `${coalesceKey}:${hit.layer.id}`);
  return true;
}
