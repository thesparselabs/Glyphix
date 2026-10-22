// Dominant colours from an image (seeded k-means in RGB), and background suggestions built from them.
import { mulberry32, type BackgroundFill, type Color, type Resolved } from '@/doc';

export type RGB = [number, number, number];

/** @param rgba pixel data (e.g. a 64×64 downsample); returns up to k colours, most common first. */
export function extractPalette(rgba: Uint8ClampedArray | Uint8Array, k = 5, seed = 1): { color: RGB; weight: number }[] {
  const pts: RGB[] = [];
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) continue;
    pts.push([rgba[i]! / 255, rgba[i + 1]! / 255, rgba[i + 2]! / 255]);
  }
  if (!pts.length) return [];
  const rand = mulberry32(seed);
  // k-means++ initialisation.
  const centres: RGB[] = [pts[Math.floor(rand() * pts.length)]!];
  const d2 = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  while (centres.length < Math.min(k, pts.length)) {
    const dists = pts.map((p) => Math.min(...centres.map((c) => d2(p, c))));
    const total = dists.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let r = rand() * total;
    let idx = 0;
    while (r > dists[idx]! && idx < pts.length - 1) r -= dists[idx++]!;
    centres.push([...pts[idx]!] as RGB);
  }
  const assign = new Int32Array(pts.length);
  for (let iter = 0; iter < 12; iter++) {
    pts.forEach((p, i) => {
      let best = 0;
      let bd = Infinity;
      centres.forEach((c, j) => {
        const d = d2(p, c);
        if (d < bd) {
          bd = d;
          best = j;
        }
      });
      assign[i] = best;
    });
    const sums = centres.map(() => [0, 0, 0, 0]);
    pts.forEach((p, i) => {
      const s = sums[assign[i]!]!;
      s[0]! += p[0];
      s[1]! += p[1];
      s[2]! += p[2];
      s[3]!++;
    });
    sums.forEach((s, j) => {
      if (s[3]) centres[j] = [s[0]! / s[3], s[1]! / s[3], s[2]! / s[3]];
    });
  }
  const counts = centres.map(() => 0);
  assign.forEach((a) => counts[a]!++);
  return centres
    .map((color, j) => ({ color, weight: counts[j]! / pts.length }))
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

function toHsl([r, g, b]: RGB): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): RGB {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** Push a colour toward something that works as a backdrop (vivid, mid lightness). */
function vivid(c: RGB, lightness: number, minSat = 0.55): Color {
  const [h, s] = toHsl(c);
  const [r, g, b] = fromHsl(h, Math.max(minSat, s), lightness);
  return [r, g, b, 1];
}

/** Background suggestions derived from a screenshot's palette. */
export function suggestBackgrounds(palette: { color: RGB; weight: number }[]): Resolved<BackgroundFill>[] {
  if (!palette.length) return [];
  // Prefer the most saturated colours: screenshots are mostly neutral UI chrome.
  const bySat = [...palette].sort((a, b) => toHsl(b.color)[1] - toHsl(a.color)[1]).map((p) => p.color);
  const a = bySat[0]!;
  const b = bySat[1] ?? fromHsl((toHsl(a)[0] + 0.12) % 1, 0.7, 0.55);
  const shifted = (c: RGB, dh: number): RGB => {
    const [h, s, l] = toHsl(c);
    return fromHsl((h + dh + 1) % 1, s, l);
  };
  return [
    { kind: 'linear', angle: 135, stops: [{ offset: 0, color: vivid(a, 0.45) }, { offset: 1, color: vivid(shifted(a, 0.1), 0.62) }] },
    { kind: 'linear', angle: 90, stops: [{ offset: 0, color: vivid(a, 0.18, 0.4) }, { offset: 1, color: vivid(a, 0.42) }] },
    {
      kind: 'mesh',
      points: [
        { x: 0.1, y: 0.1, color: vivid(a, 0.55) },
        { x: 0.9, y: 0.15, color: vivid(b, 0.6) },
        { x: 0.15, y: 0.9, color: vivid(shifted(b, -0.08), 0.5) },
        { x: 0.85, y: 0.85, color: vivid(shifted(a, 0.15), 0.65) },
      ],
    },
    { kind: 'solid', color: vivid(a, 0.92, 0.3) },
  ];
}

/** Downsample an image source to RGBA for palette extraction. */
export function samplePixels(source: CanvasImageSource, size = 64): Uint8ClampedArray {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(source, 0, 0, size, size);
  return g.getImageData(0, 0, size, size).data;
}
