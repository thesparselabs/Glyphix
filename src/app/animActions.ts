// Whole-animation actions shared by the Animation panel and the keyboard: copy / paste an animation between
// layers, apply a saved preset (one undo step), and a short notice line ("Applied 'X' — 2 properties skipped").
import { create } from 'zustand';
import { applyAnimation, captureAnimation, misfitReason, type Animation } from '@/doc';
import { layerIndex, useEditor } from './store';

export interface Notice {
  text: string;
  error: boolean;
}

interface AnimState {
  clipboard: Animation | null;
  notice: Notice | null;
}

export const useAnimState = create<AnimState>(() => ({ clipboard: null, notice: null }));

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, error = false) {
  clearTimeout(noticeTimer);
  useAnimState.setState({ notice: { text, error } });
  noticeTimer = setTimeout(() => useAnimState.setState({ notice: null }), error ? 8000 : 4000);
}

const plural = (n: number) => `${n} ${n === 1 ? 'property' : 'properties'}`;

/** Copy the selected layer's whole animation. */
export function copyAnimation(): boolean {
  const s = useEditor.getState();
  const layer = s.doc.comp.layers.find((l) => l.id === s.selectedId);
  if (!layer) return false;
  const anim = captureAnimation(layer, s.doc.comp);
  if (!anim) {
    notify('Nothing to copy: this layer has no animation.', true);
    return false;
  }
  useAnimState.setState({ clipboard: anim });
  notify('Animation copied');
  return true;
}

/**
 * Apply `anim` to the layers `ids` as ONE undo step; returns what was applied / skipped, or null when no layer
 * could take it. Locked layers and layers of another kind (a background onto an image, …) are left alone.
 */
export function applyAnimationTo(ids: readonly string[], anim: Animation, label: string): { applied: number; skipped: number } | null {
  const s = useEditor.getState();
  const { fps } = s.doc.comp;
  const patches: { path: readonly (string | number)[]; value: unknown }[] = [];
  let [applied, skipped] = [0, 0];
  let fit = false;
  for (const id of ids) {
    const i = layerIndex(s.doc, id);
    const layer = s.doc.comp.layers[i];
    if (!layer || layer.locked || misfitReason(anim, layer.type)) continue;
    fit = true;
    const r = applyAnimation(layer, anim, s.doc.comp, fps);
    applied += r.applied;
    skipped += r.skipped;
    patches.push(...r.patches.map((p) => ({ path: ['comp', 'layers', i, ...p.path], value: p.value })));
  }
  if (!fit) return null;
  if (patches.length) s.set(label, patches);
  return { applied, skipped };
}

export const resultNotice = (what: string, r: { skipped: number }) => `${what}${r.skipped ? ` — ${plural(r.skipped)} skipped` : ''}`;

/** Paste the copied animation onto the selected layer. */
export function pasteAnimation(): boolean {
  const { clipboard } = useAnimState.getState();
  const s = useEditor.getState();
  if (!clipboard || !s.selectedId) return false;
  const layer = s.doc.comp.layers.find((l) => l.id === s.selectedId);
  if (!layer) return false;
  const bad = misfitReason(clipboard, layer.type);
  const r = !bad && !layer.locked ? applyAnimationTo([layer.id], clipboard, 'Paste animation') : null;
  if (!r) notify(layer.locked ? 'This layer is locked.' : (bad ?? 'The animation does not fit this layer.'), true);
  else notify(resultNotice('Pasted animation', r));
  return !!r;
}
