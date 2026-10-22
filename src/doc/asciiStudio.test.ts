import { describe, expect, it } from 'vitest';
import { applyPatches } from './history';
import {
  applyAsciiPreset,
  ASCII_CHARSETS,
  ASCII_PRESETS,
  asciiCanvasSize,
  createDemoDoc,
  createEffect,
  defaultClip,
  effectDef,
  evaluate,
  expandTextTokens,
  frameNumbers,
  planVideoToAscii,
  type Doc,
  type ImageLayer,
} from '.';

describe('ASCII presets', () => {
  it('each preset only names real parameters and colours, inside their ranges', () => {
    const def = effectDef('ascii');
    for (const p of ASCII_PRESETS) {
      for (const [k, v] of Object.entries(p.params)) {
        const d = def.params.find((q) => q.key === k);
        expect(d, `${p.id}.${k}`).toBeTruthy();
        expect(v).toBeGreaterThanOrEqual(d!.min);
        expect(v).toBeLessThanOrEqual(d!.max);
      }
      for (const k of Object.keys(p.colors)) expect(def.colors.some((c) => c.key === k), `${p.id}.${k}`).toBe(true);
    }
    expect(new Set(ASCII_PRESETS.map((p) => p.id)).size).toBe(ASCII_PRESETS.length);
    expect(ASCII_PRESETS.find((p) => p.id === 'binary')!.params.charset).toBe(ASCII_CHARSETS.indexOf('Binary'));
  });

  it('applyAsciiPreset changes only what the preset lists and keeps the effect’s id', () => {
    const fx = createEffect('ascii');
    const out = applyAsciiPreset(fx, ASCII_PRESETS.find((p) => p.id === 'newsprint')!);
    expect(out.id).toBe(fx.id);
    expect(out.params.invert).toEqual({ static: 1 });
    expect(out.params.mix).toEqual(fx.params.mix); // not in the preset
    expect(out.colors.ink2).toEqual(fx.colors.ink2);
    expect(out.colors.bg).not.toEqual(fx.colors.bg);
    expect(fx.params.invert).toEqual({ static: 0 }); // input untouched
  });
});

describe('frame counter tokens', () => {
  const comp = { fps: 25, duration: 4 }; // 100 frames
  it('numbers frames from 1 and pads to the width of {frames}', () => {
    expect(expandTextTokens('Frame {frame} / {frames}', comp, 0)).toBe('Frame 001 / 100');
    expect(expandTextTokens('{frame}', comp, 0.04)).toBe('002');
    expect(expandTextTokens('{frame}', comp, 3.96)).toBe('100');
    expect(expandTextTokens('{frame}', comp, 4)).toBe('100'); // clamped
    expect(expandTextTokens('{frame}', comp, -1)).toBe('001');
  });
  it('does not drift at exact frame boundaries', () => {
    for (let i = 0; i < 100; i++) expect(frameNumbers(comp, i / 25).frame).toBe(i + 1);
  });
  it('{time} is seconds with 2 decimals; unknown braces and plain text are left alone', () => {
    expect(expandTextTokens('t={time}s', comp, 1.254)).toBe('t=1.25s');
    expect(expandTextTokens('{nope} {frame', comp, 1)).toBe('{nope} {frame');
    expect(expandTextTokens('plain', comp, 1)).toBe('plain');
  });
  it('evaluate() substitutes per time in the render list', () => {
    const doc = createDemoDoc();
    const text = doc.comp.layers.find((l) => l.type === 'text')!;
    const d = applyPatches(doc, [{ path: ['comp', 'layers', doc.comp.layers.indexOf(text), 'text'], value: { static: 'F{frame}/{frames}' } }]);
    const shown = (t: number) => (evaluate(d, t).items.find((i) => i.kind === 'text') as { text: string }).text;
    const n = Math.round(d.comp.duration * d.comp.fps);
    expect(shown(0)).toBe(`F${'1'.padStart(String(n).length, '0')}/${n}`);
    expect(shown(1)).not.toBe(shown(0));
  });
});

describe('planVideoToAscii', () => {
  function docWithVideo(): { doc: Doc; layer: ImageLayer } {
    const base = createDemoDoc();
    const img = base.comp.layers.find((l): l is ImageLayer => l.type === 'image')!;
    const layer: ImageLayer = { ...img, assetId: 'vid-x', video: { ...defaultClip(2.5, base.comp), in: 0.5, out: 2.5, start: 1, loop: false }, width: 300, height: 200, radius: { static: 16 } };
    const doc = { ...base, comp: { ...base.comp, layers: base.comp.layers.map((l) => (l === img ? layer : l)) } };
    return { doc, layer };
  }

  it('sizes the canvas to the clip, its length to the trimmed clip, and adds the ASCII effect', () => {
    const { doc, layer } = docWithVideo();
    const plan = planVideoToAscii(doc, layer.id, { width: 640, height: 360 }, 'matrix')!;
    const out = applyPatches(doc, plan.patches);
    expect([out.comp.width, out.comp.height]).toEqual([640, 360]);
    expect(out.comp.duration).toBeCloseTo(2);
    const l = out.comp.layers.find((x) => x.id === layer.id) as ImageLayer;
    expect([l.width, l.height, l.radius]).toEqual([640, 360, { static: 0 }]);
    expect(l.video!.start).toBe(0);
    expect(l.transform.x).toEqual({ static: 320 });
    expect(l.effects.filter((e) => e.kind === 'ascii')).toHaveLength(1);
    expect(l.effects.at(-1)!.params.charset).toEqual({ static: ASCII_CHARSETS.indexOf('Binary') });
  });

  it('restyles an existing ASCII effect instead of adding another, and caps huge clips', () => {
    const { doc, layer } = docWithVideo();
    const once = applyPatches(doc, planVideoToAscii(doc, layer.id, { width: 3840, height: 2160 }, 'terminal')!.patches);
    expect([once.comp.width, once.comp.height]).toEqual([1920, 1080]);
    const twice = applyPatches(once, planVideoToAscii(once, layer.id, { width: 3840, height: 2160 }, 'blocks')!.patches);
    const fx = (twice.comp.layers.find((x) => x.id === layer.id) as ImageLayer).effects.filter((e) => e.kind === 'ascii');
    expect(fx).toHaveLength(1);
    expect(fx[0]!.params.charset).toEqual({ static: ASCII_CHARSETS.indexOf('Blocks') });
  });

  it('picks the only video layer without a selection; null when there is none', () => {
    const { doc } = docWithVideo();
    expect(planVideoToAscii(doc, null, { width: 100, height: 100 })).not.toBeNull();
    expect(planVideoToAscii(createDemoDoc(), null, { width: 100, height: 100 })).toBeNull();
    expect(asciiCanvasSize(101, 51)).toEqual({ width: 102, height: 52 });
  });
});
