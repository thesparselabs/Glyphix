// Every property of a layer that can carry keyframes, in timeline order. The timeline, keyframe operations
// and (later) animation presets and Lottie export all read this list, so a new keyframable property is one entry.
import { effectDef } from './effects';
import type { Path } from './history';
import type { Layer, Prop } from './types';

export interface AnimatableProp {
  /** Stable within a layer (effect params use the effect's id), e.g. `opacity`, `fx:fx-ab12:radius`. */
  id: string;
  label: string;
  /** Row group in the timeline ("Transform", "Blur", …). */
  group: string;
  /** Path from the layer to the Prop. */
  path: Path;
  /** What the keys hold: numbers interpolate, colours blend in OKLab, text holds. */
  kind: 'number' | 'color' | 'text';
}

const P = (id: string, label: string, group: string, path: Path, kind: AnimatableProp['kind'] = 'number'): AnimatableProp => ({ id, label, group, path, kind });

/** Every keyframable property of `layer`. Shadow, border, outline and gradient rows exist only while they are on. */
export function animatableProps(layer: Layer): AnimatableProp[] {
  const out: AnimatableProp[] = [P('opacity', 'Opacity', 'Layer', ['opacity'])];
  if (layer.type === 'image' || layer.type === 'text') {
    out.push(
      P('x', 'Position X', 'Transform', ['transform', 'x']),
      P('y', 'Position Y', 'Transform', ['transform', 'y']),
      P('scale', 'Scale', 'Transform', ['transform', 'scale']),
      P('rotation', 'Rotation', 'Transform', ['transform', 'rotation']),
    );
  }
  if (layer.type === 'image') {
    out.push(P('tiltX', 'Tilt X', 'Tilt', ['tilt', 'rotateX']), P('tiltY', 'Tilt Y', 'Tilt', ['tilt', 'rotateY']), P('radius', 'Corner radius', 'Style', ['radius']));
    if (layer.shadow)
      out.push(
        P('shadowBlur', 'Blur', 'Shadow', ['shadow', 'blur']),
        P('shadowX', 'Offset X', 'Shadow', ['shadow', 'offsetX']),
        P('shadowY', 'Offset Y', 'Shadow', ['shadow', 'offsetY']),
        P('shadowColor', 'Colour', 'Shadow', ['shadow', 'color'], 'color'),
      );
    if (layer.border) out.push(P('borderWidth', 'Width', 'Border', ['border', 'width']), P('borderColor', 'Colour', 'Border', ['border', 'color'], 'color'));
  }
  if (layer.type === 'text') {
    out.push(P('text', 'Text', 'Text', ['text'], 'text'), P('color', 'Colour', 'Text', ['color'], 'color'), P('glow', 'Glow', 'Text', ['glow']), P('glowColor', 'Glow colour', 'Text', ['glowColor'], 'color'));
    if (layer.gradient)
      out.push(
        P('gradientAngle', 'Angle', 'Gradient', ['gradient', 'angle']),
        P('gradientFrom', 'From', 'Gradient', ['gradient', 'from'], 'color'),
        P('gradientTo', 'To', 'Gradient', ['gradient', 'to'], 'color'),
      );
    if (layer.outline) out.push(P('outlineWidth', 'Width', 'Outline', ['outline', 'width']), P('outlineColor', 'Colour', 'Outline', ['outline', 'color'], 'color'));
    if (layer.shadow)
      out.push(
        P('shadowX', 'Offset X', 'Shadow', ['shadow', 'offsetX']),
        P('shadowY', 'Offset Y', 'Shadow', ['shadow', 'offsetY']),
        P('shadowBlur', 'Blur', 'Shadow', ['shadow', 'blur']),
        P('shadowColor', 'Colour', 'Shadow', ['shadow', 'color'], 'color'),
      );
  }
  if (layer.type === 'background') {
    const f = layer.fill;
    if (f.kind === 'solid') out.push(P('fillColor', 'Colour', 'Background', ['fill', 'color'], 'color'));
    if (f.kind === 'linear') {
      out.push(P('fillAngle', 'Angle', 'Background', ['fill', 'angle']));
      f.stops.forEach((_, i) => out.push(P(`stop${i}Color`, `Stop ${i + 1} colour`, 'Background', ['fill', 'stops', i, 'color'], 'color'), P(`stop${i}Offset`, `Stop ${i + 1} position`, 'Background', ['fill', 'stops', i, 'offset'])));
    }
    if (f.kind === 'mesh')
      f.points.forEach((_, i) =>
        out.push(
          P(`point${i}Color`, `Point ${i + 1} colour`, 'Background', ['fill', 'points', i, 'color'], 'color'),
          P(`point${i}X`, `Point ${i + 1} X`, 'Background', ['fill', 'points', i, 'x']),
          P(`point${i}Y`, `Point ${i + 1} Y`, 'Background', ['fill', 'points', i, 'y']),
        ),
      );
  }
  (layer.effects ?? []).forEach((e, i) => {
    const def = effectDef(e.kind);
    for (const q of def.params) if (!q.fixed) out.push(P(`fx:${e.id}:${q.key}`, q.label, def.label, ['effects', i, 'params', q.key]));
    for (const c of def.colors) out.push(P(`fxc:${e.id}:${c.key}`, c.label, def.label, ['effects', i, 'colors', c.key], 'color'));
  });
  return out;
}

/** The Prop at a layer-relative path (a missing effect param reads as its default, static). */
export function propAt(layer: Layer, path: Path): Prop<unknown> | undefined {
  let v: unknown = layer;
  for (const k of path) v = v == null ? undefined : (v as Record<string | number, unknown>)[k];
  if (v === undefined && path[0] === 'effects') {
    const e = layer.effects?.[path[1] as number];
    const d = e && effectDef(e.kind);
    const def = path[2] === 'colors' ? d?.colors.find((c) => c.key === path[3]) : d?.params.find((q) => q.key === path[3]);
    if (def) return { static: def.default };
  }
  return v as Prop<unknown> | undefined;
}
