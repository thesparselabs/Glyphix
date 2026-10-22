import { NO_MOTION } from './motion';
import { createEffect } from './effects';
import { FULL_CROP, NO_FRAME, NO_TILT, type AdjustmentLayer, type Comp, type EffectKind, type ImageLayer, type TextLayer } from './types';

export function newLayerId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Size that fits `w×h` inside the comp with `margin` (0..1) on each side, never upscaling. */
export function fitSize(comp: Comp, w: number, h: number, margin = 0.14): { width: number; height: number } {
  const s = Math.min(1, (comp.width * (1 - 2 * margin)) / w, (comp.height * (1 - 2 * margin)) / h);
  return { width: Math.round(w * s), height: Math.round(h * s) };
}

export function createImageLayer(comp: Comp, assetId: string, srcW: number, srcH: number, name = 'Image'): ImageLayer {
  const { width, height } = fitSize(comp, srcW, srcH);
  return {
    id: newLayerId('img'),
    name,
    type: 'image',
    visible: true,
    timing: { in: 0, out: null },
    locked: false,
    assetId,
    video: null,
    crop: FULL_CROP,
    width,
    height,
    radius: { static: 16 },
    shadow: { blur: { static: 60 }, offsetX: { static: 0 }, offsetY: { static: 30 }, color: { static: [0, 0, 0, 0.45] } },
    border: null,
    frame: NO_FRAME,
    tilt: NO_TILT,
    motion: NO_MOTION,
    opacity: { static: 1 },
    effects: [],
    transform: { x: { static: comp.width / 2 }, y: { static: comp.height / 2 }, scale: { static: 1 }, rotation: { static: 0 } },
  };
}

/** A new headline in the middle of the comp. */
export function createTextLayer(comp: Comp, text = 'Your text', fontId = 'inter'): TextLayer {
  const fontSize = Math.round(Math.min(comp.width, comp.height) / 11);
  return {
    id: newLayerId('text'),
    name: 'Text',
    type: 'text',
    visible: true,
    timing: { in: 0, out: null },
    locked: false,
    text: { static: text },
    fontId,
    weight: 600,
    fontSize,
    lineHeight: 1.15,
    color: { static: [1, 1, 1, 1] },
    gradient: null,
    outline: null,
    shadow: null,
    align: 'center',
    tracking: -0.01,
    opacity: { static: 1 },
    effects: [],
    glow: { static: 0 },
    glowColor: { static: [1, 1, 1, 1] },
    transform: { x: { static: comp.width / 2 }, y: { static: comp.height / 2 }, scale: { static: 1 }, rotation: { static: 0 } },
    animator: null,
    motion: NO_MOTION,
  };
}

/** An adjustment layer with one effect, processing everything below it. */
export function createAdjustmentLayer(kind: EffectKind = 'colorAdjust'): AdjustmentLayer {
  return {
    id: newLayerId('adj'),
    name: 'Adjustment',
    type: 'adjustment',
    visible: true,
    timing: { in: 0, out: null },
    locked: false,
    opacity: { static: 1 },
    effects: [createEffect(kind)],
  };
}
