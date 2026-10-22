// Pure editor geometry in comp space (px, y down, rotation clockwise in degrees).
// Hit-testing and handles use un-animated-by-effects CPU geometry — never GPU readback.
import { isPlaced, sampleProp, type Doc, type Layer } from '@/doc';

export interface Vec {
  x: number;
  y: number;
}

/** Oriented box: centre, full size (already multiplied by scale), rotation. */
export interface OBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

export interface AABB {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Text block size in px at scale 1, or null if the font isn't ready. */
/** Size of a text layer's block at time `t` (animated text changes at its keys). */
export type MeasureText = (layer: Extract<Layer, { type: 'text' }>, t: number) => { width: number; height: number } | null;

const DEG = Math.PI / 180;

export function rotate(v: Vec, deg: number): Vec {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Extra height above the image for a window/browser frame (scale 1). Set by styling. */
export type FrameHeight = (layer: Extract<Layer, { type: 'image' }>) => number;

export function layerBox(layer: Layer, t: number, measure: MeasureText, frameHeight: FrameHeight = () => 0): OBox | null {
  if (!isPlaced(layer)) return null;
  const s = sampleProp(layer.transform.scale, t);
  const cx = sampleProp(layer.transform.x, t);
  const cy = sampleProp(layer.transform.y, t);
  const rotation = sampleProp(layer.transform.rotation, t);
  if (layer.type === 'image') {
    const bar = frameHeight(layer);
    // The frame bar sits above the image; the layer's anchor stays at the image+bar centre.
    return { cx, cy, w: layer.width * s, h: (layer.height + bar) * s, rotation };
  }
  const m = measure(layer, t);
  if (!m) return null;
  return { cx, cy, w: m.width * s, h: m.height * s, rotation };
}

export function corners(b: OBox): [Vec, Vec, Vec, Vec] {
  const hw = b.w / 2;
  const hh = b.h / 2;
  // top-left, top-right, bottom-right, bottom-left
  return ([
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ] as const).map((p) => {
    const r = rotate(p, b.rotation);
    return { x: b.cx + r.x, y: b.cy + r.y };
  }) as [Vec, Vec, Vec, Vec];
}

export function aabb(b: OBox): AABB {
  const c = corners(b);
  const xs = c.map((p) => p.x);
  const ys = c.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Point in comp space → the box's local frame (origin at centre, unrotated). */
export function toLocal(b: OBox, p: Vec): Vec {
  return rotate({ x: p.x - b.cx, y: p.y - b.cy }, -b.rotation);
}

export function containsPoint(b: OBox, p: Vec, pad = 0): boolean {
  const l = toLocal(b, p);
  return Math.abs(l.x) <= b.w / 2 + pad && Math.abs(l.y) <= b.h / 2 + pad;
}

/** Topmost visible, unlocked, non-background layer under the point. */
export function hitTest(doc: Doc, p: Vec, t: number, measure: MeasureText, frameHeight?: FrameHeight): Layer | null {
  const layers = doc.comp.layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]!;
    if (!l.visible || l.locked) continue;
    const b = layerBox(l, t, measure, frameHeight);
    if (b && containsPoint(b, p)) return l;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snapping

export interface SnapResult {
  dx: number;
  dy: number;
  /** Guide lines to draw, comp coordinates. */
  guidesX: number[];
  guidesY: number[];
}

export interface SnapTargets {
  xs: number[];
  ys: number[];
}

export function snapTargets(doc: Doc, excludeId: string, t: number, measure: MeasureText, frameHeight?: FrameHeight): SnapTargets {
  const { width, height } = doc.comp;
  const xs = [0, width / 2, width];
  const ys = [0, height / 2, height];
  for (const l of doc.comp.layers) {
    if (l.id === excludeId || !l.visible) continue;
    const b = layerBox(l, t, measure, frameHeight);
    if (!b) continue;
    const a = aabb(b);
    xs.push(a.x0, (a.x0 + a.x1) / 2, a.x1);
    ys.push(a.y0, (a.y0 + a.y1) / 2, a.y1);
  }
  return { xs, ys };
}

/**
 * Snap a moving box. `box` is the box *after* applying the raw (dx,dy) drag delta.
 * Returns the correction to add and the guides that matched. Threshold in comp px.
 */
export function snapMove(box: AABB, targets: SnapTargets, threshold: number): SnapResult {
  const snapAxis = (edges: number[], cands: number[]) => {
    let best: { d: number; at: number } | null = null;
    for (const e of edges) {
      for (const c of cands) {
        const d = c - e;
        if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: c };
      }
    }
    return best;
  };
  const sx = snapAxis([box.x0, (box.x0 + box.x1) / 2, box.x1], targets.xs);
  const sy = snapAxis([box.y0, (box.y0 + box.y1) / 2, box.y1], targets.ys);
  return { dx: sx?.d ?? 0, dy: sy?.d ?? 0, guidesX: sx ? [sx.at] : [], guidesY: sy ? [sy.at] : [] };
}

// ---------------------------------------------------------------------------
// Handle math

export type Corner = 'nw' | 'ne' | 'se' | 'sw';
export type Edge = 'n' | 'e' | 's' | 'w';

const CORNER_SIGN: Record<Corner, Vec> = { nw: { x: -1, y: -1 }, ne: { x: 1, y: -1 }, se: { x: 1, y: 1 }, sw: { x: -1, y: 1 } };
const EDGE_SIGN: Record<Edge, Vec> = { n: { x: 0, y: -1 }, e: { x: 1, y: 0 }, s: { x: 0, y: 1 }, w: { x: -1, y: 0 } };

/**
 * Uniform scale from a corner handle with the opposite corner fixed.
 * Returns the scale factor to apply and the new centre.
 */
export function scaleFromCorner(start: OBox, corner: Corner, pointer: Vec, minSize = 8): { factor: number; cx: number; cy: number } {
  const sign = CORNER_SIGN[corner];
  const anchorLocal = { x: (-sign.x * start.w) / 2, y: (-sign.y * start.h) / 2 };
  const pLocal = toLocal(start, pointer);
  const diag = { x: sign.x * start.w, y: sign.y * start.h };
  const len2 = diag.x * diag.x + diag.y * diag.y;
  const proj = ((pLocal.x - anchorLocal.x) * diag.x + (pLocal.y - anchorLocal.y) * diag.y) / len2;
  const factor = Math.max(minSize / Math.min(start.w, start.h), proj);
  const centreLocal = { x: anchorLocal.x + (diag.x * factor) / 2, y: anchorLocal.y + (diag.y * factor) / 2 };
  const c = rotate(centreLocal, start.rotation);
  return { factor, cx: start.cx + c.x, cy: start.cy + c.y };
}

/**
 * Resize one side with the opposite side fixed. Returns new full size (scaled px) and centre.
 */
export function resizeFromEdge(start: OBox, edge: Edge, pointer: Vec, minSize = 8): { w: number; h: number; cx: number; cy: number } {
  const sign = EDGE_SIGN[edge];
  const pLocal = toLocal(start, pointer);
  let { w, h } = start;
  let shift = { x: 0, y: 0 };
  if (sign.x !== 0) {
    const fixed = (-sign.x * start.w) / 2;
    w = Math.max(minSize, sign.x * (pLocal.x - fixed));
    shift = { x: fixed + (sign.x * w) / 2, y: 0 };
  } else {
    const fixed = (-sign.y * start.h) / 2;
    h = Math.max(minSize, sign.y * (pLocal.y - fixed));
    shift = { x: 0, y: fixed + (sign.y * h) / 2 };
  }
  const c = rotate(shift, start.rotation);
  return { w, h, cx: start.cx + c.x, cy: start.cy + c.y };
}

/** Rotation (deg) so the box's "up" points at the pointer; optional snapping step. */
export function rotationToward(start: OBox, pointer: Vec, snapStep = 0): number {
  const ang = Math.atan2(pointer.y - start.cy, pointer.x - start.cx) / DEG + 90;
  const norm = ((ang % 360) + 540) % 360 - 180;
  return snapStep ? Math.round(norm / snapStep) * snapStep : norm;
}

// ---------------------------------------------------------------------------
// Crop: rect in source-normalised coords (0..1). The layer's width/height are the displayed
// size of the cropped region, so cropping never rescales the visible pixels.

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function cropFromEdge(
  start: { crop: CropRect; width: number; height: number; box: OBox; scale: number },
  edge: Edge,
  pointer: Vec,
): { crop: CropRect; width: number; height: number; cx: number; cy: number } {
  const { crop, width, height, box, scale } = start;
  // Source-normalised units per layer px (at scale 1).
  const pxPerU = width / crop.w;
  const pxPerV = height / crop.h;
  const sign = EDGE_SIGN[edge];
  const pLocal = toLocal(box, pointer);
  const c = { ...crop };
  let w = width;
  let h = height;
  if (sign.x !== 0) {
    const fixedU = sign.x > 0 ? crop.x : crop.x + crop.w;
    const fixedLocal = (-sign.x * box.w) / 2;
    const deltaPx = (sign.x * (pLocal.x - fixedLocal)) / scale; // new width in px
    const maxPx = (sign.x > 0 ? 1 - fixedU : fixedU) * pxPerU;
    w = Math.min(maxPx, Math.max(8, deltaPx));
    c.w = w / pxPerU;
    c.x = sign.x > 0 ? fixedU : fixedU - c.w;
  } else {
    const fixedV = sign.y > 0 ? crop.y : crop.y + crop.h;
    const fixedLocal = (-sign.y * box.h) / 2;
    const deltaPx = (sign.y * (pLocal.y - fixedLocal)) / scale;
    const maxPx = (sign.y > 0 ? 1 - fixedV : fixedV) * pxPerV;
    h = Math.min(maxPx, Math.max(8, deltaPx));
    c.h = h / pxPerV;
    c.y = sign.y > 0 ? fixedV : fixedV - c.h;
  }
  const shift = sign.x !== 0 ? { x: (sign.x * (w - width) * scale) / 2, y: 0 } : { x: 0, y: (sign.y * (h - height) * scale) / 2 };
  const r = rotate(shift, box.rotation);
  return { crop: c, width: w, height: h, cx: box.cx + r.x, cy: box.cy + r.y };
}
