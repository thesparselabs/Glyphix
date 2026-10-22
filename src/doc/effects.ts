// Effects: a stack of GPU passes on a layer, or on everything below an adjustment layer.
// The registry is the single source of truth for each effect's parameters: their ranges and
// defaults drive the UI, new effects, and the renderer's uniforms.
import { sampleValue } from './animate';
import type { Color, Effect, EffectKind, Prop } from './types';

export interface EffectParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Shown after the value (px, °, %…). */
  unit?: string;
  /** Rendered as an on/off switch (0 or 1). */
  toggle?: boolean;
  /** Shown as 0–100 % (value is 0..1 or −1..1). */
  percent?: boolean;
  /** A choice (rendered as a select): the value is one of these. Still a number, so it can be keyed (it steps). */
  options?: { value: number; label: string }[];
  /** Not keyframable (changing it rebuilds GPU data, e.g. the ASCII glyph atlas). */
  fixed?: boolean;
}

export interface EffectTextDef {
  key: string;
  label: string;
  default: string;
}

export interface EffectColorDef {
  key: string;
  label: string;
  default: Color;
}

export interface EffectDef {
  kind: EffectKind;
  label: string;
  /** One line for the add menu. */
  description: string;
  params: EffectParamDef[];
  colors: EffectColorDef[];
  texts?: EffectTextDef[];
}

const choice = (key: string, label: string, labels: readonly string[], def = 0): EffectParamDef => ({
  key,
  label,
  min: 0,
  max: labels.length - 1,
  step: 1,
  default: def,
  options: labels.map((l, value) => ({ value, label: l })),
});

/** ASCII charsets and colour modes, by param value (the renderer's CHARSETS follow this order). */
export const ASCII_CHARSETS = ['Standard', 'Blocks', 'Detailed', 'Binary', 'Custom'] as const;
/** Index of the "Custom" charset (uses the effect's `charset` text). */
export const ASCII_CUSTOM_CHARSET = ASCII_CHARSETS.length - 1;
/** `fontId` text value for the built-in ASCII font (JetBrains Mono outlines embedded in the renderer). */
export const ASCII_BUILTIN_FONT = '';
export const ASCII_COLOR_MODES = ['Mono', 'Original colour', 'Two-colour'] as const;

const p = (key: string, label: string, min: number, max: number, def: number, step = 1, extra: Partial<EffectParamDef> = {}): EffectParamDef => ({
  key,
  label,
  min,
  max,
  step,
  default: def,
  ...extra,
});

export const EFFECTS: readonly EffectDef[] = [
  {
    kind: 'blur',
    label: 'Blur',
    description: 'Gaussian blur',
    params: [p('radius', 'Radius', 0, 200, 12, 0.5, { unit: 'px' })],
    colors: [],
  },
  {
    kind: 'glow',
    label: 'Glow',
    description: 'Soft light around bright parts',
    params: [
      p('radius', 'Radius', 1, 200, 24, 0.5, { unit: 'px' }),
      p('intensity', 'Intensity', 0, 4, 1.2, 0.05),
      p('threshold', 'Threshold', 0, 1, 0, 0.01, { percent: true }),
    ],
    colors: [{ key: 'color', label: 'Glow colour', default: [1, 1, 1, 1] }],
  },
  {
    kind: 'shadow',
    label: 'Drop shadow',
    description: 'Blurred shadow from the layer’s shape',
    params: [
      p('offsetX', 'Offset X', -200, 200, 0, 1, { unit: 'px' }),
      p('offsetY', 'Offset Y', -200, 200, 12, 1, { unit: 'px' }),
      p('blur', 'Blur', 0, 200, 16, 0.5, { unit: 'px' }),
      p('opacity', 'Opacity', 0, 1, 0.6, 0.01, { percent: true }),
    ],
    colors: [{ key: 'color', label: 'Shadow colour', default: [0, 0, 0, 1] }],
  },
  {
    kind: 'grain',
    label: 'Grain',
    description: 'Film grain noise',
    params: [
      p('amount', 'Amount', 0, 1, 0.12, 0.01, { percent: true }),
      p('size', 'Size', 1, 8, 1.5, 0.1, { unit: 'px' }),
      p('animated', 'Animated', 0, 1, 1, 1, { toggle: true }),
    ],
    colors: [],
  },
  {
    kind: 'displace',
    label: 'Displace',
    description: 'Wavy, liquid distortion',
    params: [
      p('amount', 'Amount', 0, 200, 20, 0.5, { unit: 'px' }),
      p('scale', 'Scale', 10, 1000, 220, 1, { unit: 'px' }),
      p('speed', 'Speed', 0, 4, 0.5, 0.05),
    ],
    colors: [],
  },
  {
    kind: 'glitch',
    label: 'Glitch',
    description: 'Digital slices and colour tears',
    params: [
      p('amount', 'Amount', 0, 1, 0.5, 0.01, { percent: true }),
      p('blockSize', 'Block size', 4, 200, 36, 1, { unit: 'px' }),
      p('speed', 'Speed', 0, 30, 8, 0.5, { unit: '/s' }),
      p('split', 'Colour split', 0, 60, 10, 0.5, { unit: 'px' }),
    ],
    colors: [],
  },
  {
    kind: 'rgbSplit',
    label: 'RGB split',
    description: 'Offset red and blue channels',
    params: [p('amount', 'Amount', 0, 60, 6, 0.5, { unit: 'px' }), p('angle', 'Angle', 0, 360, 0, 1, { unit: '°' })],
    colors: [],
  },
  {
    kind: 'gradientMap',
    label: 'Gradient map',
    description: 'Recolour by brightness',
    params: [p('mix', 'Mix', 0, 1, 1, 0.01, { percent: true })],
    colors: [
      { key: 'dark', label: 'Shadows colour', default: [0.12, 0.05, 0.35, 1] },
      { key: 'light', label: 'Highlights colour', default: [1, 0.78, 0.45, 1] },
    ],
  },
  {
    kind: 'dissolve',
    label: 'Dissolve',
    description: 'Burn away with a noisy edge',
    params: [
      p('progress', 'Progress', 0, 1, 0.4, 0.01, { percent: true }),
      p('scale', 'Noise scale', 2, 300, 40, 1, { unit: 'px' }),
      p('edge', 'Edge width', 0, 1, 0.08, 0.01, { percent: true }),
    ],
    colors: [{ key: 'color', label: 'Edge colour', default: [1, 0.55, 0.15, 1] }],
  },
  {
    kind: 'pixelate',
    label: 'Pixelate',
    description: 'Big square pixels',
    params: [p('size', 'Cell size', 1, 200, 16, 1, { unit: 'px' })],
    colors: [],
  },
  {
    kind: 'ascii',
    label: 'ASCII',
    description: 'Redraw as text characters',
    params: [
      p('size', 'Cell size', 4, 100, 12, 1, { unit: 'px' }),
      // Cells across the comp; 0 = use the cell size.
      p('columns', 'Columns', 0, 480, 0, 1),
      choice('charset', 'Characters', ASCII_CHARSETS),
      p('weight', 'Font weight', 100, 900, 500, 100, { fixed: true }),
      p('lineHeight', 'Line height', 0.5, 2, 1.2, 0.05, { fixed: true }),
      p('spacing', 'Letter spacing', -0.5, 1, 0, 0.01, { fixed: true, percent: true }),
      // Legacy (schema ≤ 5) square cells with glyphs stretched to fill them.
      p('square', 'Square cells', 0, 1, 0, 1, { toggle: true, fixed: true }),
      choice('colorMode', 'Colour mode', ASCII_COLOR_MODES, 1),
      p('background', 'Background', 0, 1, 1, 0.01, { percent: true }),
      p('contrast', 'Contrast', -1, 1, 0, 0.01, { percent: true }),
      p('gamma', 'Gamma', 0.2, 5, 0.7, 0.05),
      p('edges', 'Edges', 0, 1, 0, 1, { toggle: true }),
      p('edgeThreshold', 'Edge threshold', 0, 1, 0.25, 0.01, { percent: true }),
      p('invert', 'Invert', 0, 1, 0, 1, { toggle: true }),
      // Cells darker than this stay blank (the charset's lightest glyph).
      p('threshold', 'Density threshold', 0, 1, 0, 0.01, { percent: true }),
      p('mix', 'Mix', 0, 1, 1, 0.01, { percent: true }),
    ],
    texts: [
      { key: 'charset', label: 'Custom characters (dark → light)', default: ' .:-=+*#%@' },
      { key: 'fontId', label: 'Font', default: ASCII_BUILTIN_FONT },
    ],
    colors: [
      { key: 'ink', label: 'Glyph colour', default: [0.82, 1, 0.86, 1] },
      { key: 'ink2', label: 'Glyph shadow colour', default: [0.1, 0.25, 0.7, 1] },
      { key: 'bg', label: 'Background colour', default: [0.03, 0.04, 0.05, 1] },
    ],
  },
  {
    kind: 'vignette',
    label: 'Vignette',
    description: 'Darken the edges of the canvas',
    params: [
      p('amount', 'Amount', 0, 1, 0.5, 0.01, { percent: true }),
      p('size', 'Size', 0, 1, 0.55, 0.01, { percent: true }),
      p('softness', 'Softness', 0.01, 1, 0.5, 0.01, { percent: true }),
    ],
    colors: [{ key: 'color', label: 'Vignette colour', default: [0, 0, 0, 1] }],
  },
  {
    kind: 'colorAdjust',
    label: 'Colour adjust',
    description: 'Brightness, contrast, saturation, hue',
    params: [
      p('brightness', 'Brightness', -1, 1, 0, 0.01, { percent: true }),
      p('contrast', 'Contrast', -1, 1, 0, 0.01, { percent: true }),
      p('saturation', 'Saturation', -1, 1, 0, 0.01, { percent: true }),
      p('hue', 'Hue', -180, 180, 0, 1, { unit: '°' }),
    ],
    colors: [],
  },
];

const BY_KIND = new Map(EFFECTS.map((d) => [d.kind, d]));

export function effectDef(kind: EffectKind): EffectDef {
  const d = BY_KIND.get(kind);
  if (!d) throw new Error(`Unknown effect ${kind}`);
  return d;
}

export function createEffect(kind: EffectKind): Effect {
  const d = effectDef(kind);
  return {
    id: `fx-${Math.random().toString(36).slice(2, 10)}`,
    kind,
    enabled: true,
    params: Object.fromEntries(d.params.map((q) => [q.key, { static: q.default } as Prop<number>])),
    colors: Object.fromEntries(d.colors.map((c) => [c.key, { static: [...c.default] as Color }])),
    text: Object.fromEntries((d.texts ?? []).map((x) => [x.key, x.default])),
  };
}

/** An effect with every parameter sampled at one time. Missing params fall back to defaults. */
export interface ResolvedEffect {
  /** The effect's id (lets the renderer capture one effect's output, e.g. ASCII cells for text export). */
  id: string;
  kind: EffectKind;
  params: Record<string, number>;
  colors: Record<string, Color>;
  text: Record<string, string>;
}

export function resolveEffects(effects: readonly Effect[], t: number, sample: (p: Prop<number>, t: number) => number): ResolvedEffect[] {
  const out: ResolvedEffect[] = [];
  for (const e of effects) {
    if (!e.enabled) continue;
    const d = BY_KIND.get(e.kind);
    if (!d) continue; // from a newer version: skip rather than fail
    const params: Record<string, number> = {};
    for (const q of d.params) {
      const prop = e.params[q.key];
      // Animated values are clamped (an overshooting curve must not leave the range); a static value is used as
      // saved, even outside the slider's range (presets and old projects rely on that).
      params[q.key] = !prop ? q.default : 'track' in prop ? Math.min(q.max, Math.max(q.min, sample(prop, t))) : prop.static;
    }
    const colors: Record<string, Color> = {};
    for (const c of d.colors) {
      const prop = e.colors[c.key];
      colors[c.key] = prop ? sampleValue(prop, t) : c.default;
    }
    const text: Record<string, string> = {};
    for (const x of d.texts ?? []) text[x.key] = e.text?.[x.key] ?? x.default;
    out.push({ id: e.id, kind: e.kind, params, colors, text });
  }
  return out;
}

/** True when an effect does nothing at these settings (skipped by the renderer). */
export function isNoOp(e: ResolvedEffect): boolean {
  const q = e.params;
  switch (e.kind) {
    case 'blur':
      return q.radius! < 0.25;
    case 'glow':
      return q.intensity! <= 0;
    case 'shadow':
      return q.opacity! <= 0;
    case 'grain':
    case 'glitch':
    case 'vignette':
      return q.amount! <= 0;
    case 'displace':
    case 'rgbSplit':
      return q.amount! <= 0;
    case 'gradientMap':
    case 'ascii':
      return q.mix! <= 0;
    case 'dissolve':
      return q.progress! <= 0;
    case 'pixelate':
      return q.size! <= 1;
    case 'colorAdjust':
      return q.brightness === 0 && q.contrast === 0 && q.saturation === 0 && q.hue === 0;
  }
}
