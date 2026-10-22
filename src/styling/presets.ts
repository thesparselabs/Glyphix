import {
  sampleProp,
  type BackgroundFill,
  type Doc,
  type ImageLayer,
  type Patch,
  type Resolved,
  type Shadow,
  type Tilt,
} from '@/doc';
import { frameBarHeight } from '@/doc';
import { isPlaced, offsetProp, scaleProp, type Prop } from '@/doc';

export const CANVAS_PRESETS = [
  { id: '16:9', label: '16:9', width: 1920, height: 1080 },
  { id: '1:1', label: '1:1', width: 1080, height: 1080 },
  { id: '4:5', label: '4:5', width: 1080, height: 1350 },
  { id: '9:16', label: '9:16', width: 1080, height: 1920 },
  { id: 'og', label: 'Open Graph', width: 1200, height: 630 },
  { id: 'x', label: 'X / Twitter', width: 1600, height: 900 },
] as const;

/** Plain values; apply with `stillShadow`. */
export const SHADOW_PRESETS: { id: string; label: string; shadow: Resolved<Shadow> | null }[] = [
  { id: 'none', label: 'None', shadow: null },
  { id: 'soft', label: 'Soft', shadow: { blur: 80, offsetX: 0, offsetY: 24, color: [0, 0, 0, 0.3] } },
  { id: 'medium', label: 'Medium', shadow: { blur: 60, offsetX: 0, offsetY: 30, color: [0, 0, 0, 0.45] } },
  { id: 'hard', label: 'Hard', shadow: { blur: 10, offsetX: 0, offsetY: 16, color: [0, 0, 0, 0.6] } },
  { id: 'float', label: 'Float', shadow: { blur: 140, offsetX: 0, offsetY: 70, color: [0.05, 0.02, 0.15, 0.55] } },
];

const tilt = (rotateX: number, rotateY: number, perspective = 2400): Tilt => ({
  rotateX: { static: rotateX },
  rotateY: { static: rotateY },
  perspective,
});

export const TILT_PRESETS: { id: string; label: string; tilt: Tilt }[] = [
  { id: 'flat', label: 'Flat', tilt: tilt(0, 0) },
  { id: 'left', label: 'Turn left', tilt: tilt(0, -22) },
  { id: 'right', label: 'Turn right', tilt: tilt(0, 22) },
  { id: 'lean', label: 'Lean back', tilt: tilt(24, 0) },
  { id: 'hero', label: 'Hero', tilt: tilt(18, -20, 2000) },
  { id: 'hero-r', label: 'Hero right', tilt: tilt(18, 20, 2000) },
];

/** Plain values; apply with `stillFill`. */
export const BACKGROUND_PRESETS: { id: string; fill: Resolved<BackgroundFill> }[] = [
  { id: 'sunset', fill: { kind: 'linear', angle: 135, stops: [{ offset: 0, color: [0.35, 0.2, 0.95, 1] }, { offset: 0.55, color: [0.85, 0.25, 0.65, 1] }, { offset: 1, color: [1, 0.6, 0.3, 1] }] } },
  { id: 'ocean', fill: { kind: 'linear', angle: 160, stops: [{ offset: 0, color: [0.05, 0.55, 0.85, 1] }, { offset: 1, color: [0.1, 0.15, 0.45, 1] }] } },
  { id: 'mint', fill: { kind: 'linear', angle: 120, stops: [{ offset: 0, color: [0.55, 0.95, 0.75, 1] }, { offset: 1, color: [0.15, 0.6, 0.6, 1] }] } },
  { id: 'night', fill: { kind: 'linear', angle: 90, stops: [{ offset: 0, color: [0.08, 0.08, 0.12, 1] }, { offset: 1, color: [0.18, 0.12, 0.3, 1] }] } },
  {
    id: 'aurora',
    fill: {
      kind: 'mesh',
      points: [
        { x: 0.1, y: 0.15, color: [0.45, 0.3, 1, 1] },
        { x: 0.9, y: 0.1, color: [0.2, 0.85, 0.9, 1] },
        { x: 0.2, y: 0.9, color: [1, 0.45, 0.7, 1] },
        { x: 0.85, y: 0.85, color: [1, 0.8, 0.4, 1] },
      ],
    },
  },
  {
    id: 'peach',
    fill: {
      kind: 'mesh',
      points: [
        { x: 0.15, y: 0.2, color: [1, 0.75, 0.6, 1] },
        { x: 0.85, y: 0.2, color: [1, 0.55, 0.6, 1] },
        { x: 0.5, y: 0.95, color: [1, 0.92, 0.75, 1] },
      ],
    },
  },
  { id: 'paper', fill: { kind: 'solid', color: [0.96, 0.95, 0.93, 1] } },
  { id: 'ink', fill: { kind: 'solid', color: [0.06, 0.06, 0.08, 1] } },
];

/** CSS preview of a fill (plain values: resolve an animated one first), for swatches. */
export function fillToCss(fill: Resolved<BackgroundFill>): string {
  const c = (col: readonly number[]) => `rgb(${col.slice(0, 3).map((v) => Math.round(v * 255)).join(' ')})`;
  switch (fill.kind) {
    case 'solid':
      return c(fill.color);
    case 'linear':
      return `linear-gradient(${fill.angle + 90}deg, ${fill.stops.map((s) => `${c(s.color)} ${s.offset * 100}%`).join(', ')})`;
    case 'mesh':
      return fill.points.map((p) => `radial-gradient(circle at ${p.x * 100}% ${p.y * 100}%, ${c(p.color)}, transparent 70%)`).join(', ');
    case 'image':
      return '#333';
  }
}

/**
 * Resize the comp and scale the layout to fit (like changing a design's aspect ratio):
 * positions scale about the centre and every layer's scale is multiplied by the same factor.
 */
export function resizeCompPatches(doc: Doc, width: number, height: number): Patch[] {
  const k = Math.min(width / doc.comp.width, height / doc.comp.height);
  const ox = doc.comp.width / 2;
  const oy = doc.comp.height / 2;
  const patches: Patch[] = [
    { path: ['comp', 'width'], value: width },
    { path: ['comp', 'height'], value: height },
  ];
  doc.comp.layers.forEach((l, i) => {
    if (!isPlaced(l)) return;
    const base = ['comp', 'layers', i, 'transform'];
    // new = newCentre + (old − oldCentre)·k, applied to every keyframe.
    const remap = (p: Prop<number>, from: number, to: number): Prop<number> => offsetProp(scaleProp(offsetProp(p, -from), k), to);
    patches.push(
      { path: [...base, 'x'], value: remap(l.transform.x, ox, width / 2) },
      { path: [...base, 'y'], value: remap(l.transform.y, oy, height / 2) },
      { path: [...base, 'scale'], value: scaleProp(l.transform.scale, k) },
    );
  });
  return patches;
}

/** Size + centre an image so the card (incl. frame bar) sits `padding` px inside the comp. */
export function fitWithPaddingPatches(doc: Doc, index: number, padding: number): Patch[] {
  const l = doc.comp.layers[index] as ImageLayer;
  const restScale = sampleProp(l.transform.scale, Number.POSITIVE_INFINITY);
  const aspect = l.width / l.height;
  const availW = Math.max(40, doc.comp.width - padding * 2) / restScale;
  const availH = Math.max(40, doc.comp.height - padding * 2) / restScale;
  // Solve for width with the bar (which depends on width) included in the height.
  let width = Math.min(availW, availH * aspect);
  for (let i = 0; i < 3; i++) {
    const bar = frameBarHeight({ frame: l.frame, width });
    width = Math.min(availW, (availH - bar) * aspect);
  }
  const height = width / aspect;
  const restX = sampleProp(l.transform.x, Number.POSITIVE_INFINITY);
  const restY = sampleProp(l.transform.y, Number.POSITIVE_INFINITY);
  const base = ['comp', 'layers', index];
  return [
    { path: [...base, 'width'], value: width },
    { path: [...base, 'height'], value: height },
    { path: [...base, 'transform', 'x'], value: offsetProp(l.transform.x, doc.comp.width / 2 - restX) },
    { path: [...base, 'transform', 'y'], value: offsetProp(l.transform.y, doc.comp.height / 2 - restY) },
  ];
}

/** Current padding implied by an image's size (smallest gap to the comp edge). */
export function currentPadding(doc: Doc, l: ImageLayer): number {
  const s = sampleProp(l.transform.scale, Number.POSITIVE_INFINITY);
  const w = l.width * s;
  const h = (l.height + frameBarHeight(l)) * s;
  return Math.max(0, Math.round(Math.min((doc.comp.width - w) / 2, (doc.comp.height - h) / 2)));
}
