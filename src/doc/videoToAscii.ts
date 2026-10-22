// "Turn into ASCII": the document changes that make a video/GIF layer a ready-to-export ASCII piece.
// Pure: given the doc, it returns the patches; the app applies them as one undo step.
import { applyAsciiPreset, asciiPreset, ASCII_PRESETS, type AsciiPreset } from './asciiPresets';
import { still } from './animate';
import { createEffect } from './effects';
import { clipLength } from './video';
import type { Doc, ImageLayer, VideoClip } from './types';
import type { Patch } from './history';

/** Longest side of the canvas we size to a clip (bigger clips are scaled down, aspect kept). */
export const MAX_ASCII_CANVAS = 1920;

export type VideoLayer = ImageLayer & { video: VideoClip };

/** The video/GIF layer to convert: the selected one, else the only one in the doc. Null when it is ambiguous or missing. */
export function pickVideoLayer(doc: Doc, selectedId: string | null): VideoLayer | null {
  const videos = doc.comp.layers.filter((l): l is VideoLayer => l.type === 'image' && !!l.video);
  return videos.find((l) => l.id === selectedId) ?? (videos.length === 1 ? videos[0]! : null);
}

/** Canvas size for a clip of `w×h`: its own size (even numbers, longest side at most MAX_ASCII_CANVAS). */
export function asciiCanvasSize(w: number, h: number): { width: number; height: number } {
  const s = Math.min(1, MAX_ASCII_CANVAS / Math.max(w, h));
  const even = (v: number) => Math.max(2, Math.round((v * s) / 2) * 2);
  return { width: even(w), height: even(h) };
}

export interface AsciiPlan {
  label: string;
  patches: Patch[];
  layerId: string;
}

/**
 * Canvas = the clip's size, canvas length = the clip's length, the layer fills the canvas, and an ASCII effect
 * with `preset` is on it (an existing ASCII effect on the layer is restyled instead of adding a second one).
 * `source` is the clip's own pixel size. Returns null when there is no layer (or preset) to use.
 */
export function planVideoToAscii(
  doc: Doc,
  selectedId: string | null,
  source: { width: number; height: number },
  preset: AsciiPreset | string = ASCII_PRESETS[0]!,
): AsciiPlan | null {
  const layer = pickVideoLayer(doc, selectedId);
  const p = typeof preset === 'string' ? asciiPreset(preset) : preset;
  if (!layer || !p) return null;
  const { width, height } = asciiCanvasSize(source.width, source.height);
  const fps = doc.comp.fps;
  const duration = Math.max(1 / fps, Math.round(clipLength(layer.video) * fps) / fps);
  const base = ['comp', 'layers', doc.comp.layers.indexOf(layer)];
  const effects = layer.effects ?? [];
  const at = effects.findIndex((e) => e.kind === 'ascii');
  const styled = applyAsciiPreset(at >= 0 ? effects[at]! : createEffect('ascii'), p);
  return {
    label: 'Turn into ASCII',
    layerId: layer.id,
    patches: [
      { path: ['comp', 'width'], value: width },
      { path: ['comp', 'height'], value: height },
      { path: ['comp', 'duration'], value: duration },
      { path: [...base, 'video'], value: { ...layer.video, start: 0 } },
      { path: [...base, 'width'], value: width },
      { path: [...base, 'height'], value: height },
      { path: [...base, 'crop'], value: { x: 0, y: 0, w: 1, h: 1 } },
      { path: [...base, 'transform'], value: { ...layer.transform, x: { static: width / 2 }, y: { static: height / 2 }, scale: { static: 1 }, rotation: { static: 0 } } },
      { path: [...base, 'radius'], value: still(0) },
      { path: [...base, 'shadow'], value: null },
      { path: [...base, 'border'], value: null },
      { path: [...base, 'effects'], value: at >= 0 ? effects.map((e, i) => (i === at ? styled : e)) : [...effects, styled] },
    ],
  };
}
