// Looks for the ASCII effect: named bundles of parameter and colour values. A preset lists only what it
// changes; everything else on the effect keeps its value. Keys follow the ASCII entry in effects.ts.
import { ASCII_CHARSETS, ASCII_COLOR_MODES } from './effects';
import type { Color, Effect } from './types';

export interface AsciiPreset {
  id: string;
  label: string;
  /** One line for the picker. */
  description: string;
  params: Record<string, number>;
  colors: Record<string, Color>;
}

const charset = (name: (typeof ASCII_CHARSETS)[number]) => ASCII_CHARSETS.indexOf(name);
const colorMode = (name: (typeof ASCII_COLOR_MODES)[number]) => ASCII_COLOR_MODES.indexOf(name);

export const ASCII_PRESETS: readonly AsciiPreset[] = [
  {
    id: 'terminal',
    label: 'Terminal green',
    description: 'Phosphor green on near-black',
    params: { size: 12, charset: charset('Standard'), colorMode: colorMode('Mono'), background: 1, contrast: 0.1, gamma: 0.7, invert: 0, edges: 0 },
    colors: { ink: [0.2, 1, 0.4, 1], bg: [0.01, 0.04, 0.02, 1] },
  },
  {
    id: 'matrix',
    label: 'Matrix',
    description: 'Dense binary rain, bright green',
    params: { size: 10, charset: charset('Binary'), colorMode: colorMode('Two-colour'), background: 1, contrast: 0.25, gamma: 0.6, invert: 0, edges: 0 },
    colors: { ink: [0.55, 1, 0.65, 1], ink2: [0, 0.35, 0.1, 1], bg: [0, 0.02, 0, 1] },
  },
  {
    id: 'newsprint',
    label: 'Newsprint',
    description: 'Dark ink on paper',
    params: { size: 10, charset: charset('Detailed'), colorMode: colorMode('Mono'), background: 1, contrast: 0.2, gamma: 0.9, invert: 1, edges: 0 },
    colors: { ink: [0.1, 0.09, 0.08, 1], bg: [0.93, 0.9, 0.82, 1] },
  },
  {
    id: 'blocks',
    label: 'Blocks',
    description: 'Chunky block shading, light on dark',
    params: { size: 14, charset: charset('Blocks'), colorMode: colorMode('Mono'), background: 1, contrast: 0.15, gamma: 0.8, invert: 0, edges: 0 },
    colors: { ink: [0.92, 0.94, 1, 1], bg: [0.05, 0.05, 0.08, 1] },
  },
  {
    id: 'fullColour',
    label: 'Full colour',
    description: 'Each character keeps the picture’s colour',
    params: { size: 8, charset: charset('Detailed'), colorMode: colorMode('Original colour'), background: 1, contrast: 0.1, gamma: 0.7, invert: 0, edges: 0 },
    colors: { bg: [0.02, 0.02, 0.03, 1] },
  },
  {
    id: 'binary',
    label: 'Binary',
    description: 'Only 0s and 1s, white on black',
    params: { size: 12, charset: charset('Binary'), colorMode: colorMode('Mono'), background: 1, contrast: 0.2, gamma: 0.7, invert: 0, edges: 0 },
    colors: { ink: [1, 1, 1, 1], bg: [0, 0, 0, 1] },
  },
];

export const asciiPreset = (id: string): AsciiPreset | undefined => ASCII_PRESETS.find((p) => p.id === id);

/** A copy of an ASCII effect with the preset's values applied; values the preset doesn't list are kept. */
export function applyAsciiPreset(effect: Effect, preset: AsciiPreset): Effect {
  return {
    ...effect,
    params: { ...effect.params, ...Object.fromEntries(Object.entries(preset.params).map(([k, v]) => [k, { static: v }])) },
    colors: { ...effect.colors, ...Object.fromEntries(Object.entries(preset.colors).map(([k, c]) => [k, { static: [...c] as Color }])) },
  };
}
