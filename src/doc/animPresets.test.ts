import { describe, expect, it } from 'vitest';
import {
  animationFits,
  applyAnimation,
  applyPatches,
  captureAnimation,
  createDemoDoc,
  createEffect,
  defaultEnter,
  defaultLoop,
  Easings,
  evaluate,
  parsePresetFile,
  parsePresetText,
  PresetFileError,
  presetFileJson,
  type AnimPreset,
  type Doc,
  type ImageLayer,
  type Layer,
  type Prop,
  type TextLayer,
} from '.';

const fps = 30;
const keys = (...ks: [number, unknown][]): Prop<never> => ({ track: { keys: ks.map(([t, v]) => ({ t, v, out: Easings.easeOutCubic })) } }) as Prop<never>;
const layer = (doc: Doc, id: string) => doc.comp.layers.find((l) => l.id === id)!;
const withLayer = (doc: Doc, id: string, patch: Record<string, unknown>): Doc => ({ ...doc, comp: { ...doc.comp, layers: doc.comp.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)) } });
const apply = <L extends Layer>(l: L, patches: { path: readonly (string | number)[]; value: unknown }[]): L => applyPatches(l, patches);
const keyTimes = (p: Prop<unknown>) => ('track' in p ? p.track.keys.map((k) => k.t) : []);
const keyVals = (p: Prop<unknown>) => ('track' in p ? p.track.keys.map((k) => k.v) : []);
const asPreset = (a: NonNullable<ReturnType<typeof captureAnimation>>, i = 1): AnimPreset => ({ ...a, id: `p${i}`, name: `Preset ${i}`, createdAt: 1000 + i });
const noMotion = { enter: null, exit: null, loop: null };
/** The demo's image layer with nothing animated (the demo itself carries keys). */
const still = (doc: Doc): ImageLayer => {
  const shot = layer(doc, 'shot') as ImageLayer;
  return { ...shot, timing: { in: 0, out: null }, opacity: { static: 1 }, motion: noMotion, effects: [], transform: { x: { static: 960 }, y: { static: 640 }, scale: { static: 1 }, rotation: { static: 0 } } };
};

describe('animation presets: capture and apply', () => {
  const base = createDemoDoc();
  const comp = base.comp;
  const shotAnimated = (doc: Doc) => {
    return withLayer(doc, 'shot', {
      timing: { in: 1, out: null },
      transform: { ...still(doc).transform, x: keys([1.5, 100], [2.5, 400]), scale: keys([1.5, 1], [2.5, 1.5]) },
      opacity: keys([1, 0], [2, 1]),
      motion: { enter: defaultEnter('slide-up', 0), exit: null, loop: defaultLoop('float', comp) },
    });
  };

  it('captures nothing from a layer that does not animate', () => {
    expect(captureAnimation(still(base), comp)).toBeNull();
  });

  it('round-trips an image layer: keys, easing and motion survive; times follow the in point', () => {
    const doc = shotAnimated(base);
    const src = layer(doc, 'shot') as ImageLayer;
    const anim = captureAnimation(src, comp)!;
    expect(anim.tracks.map((t) => [t.propId, t.rel])).toEqual([['opacity', null], ['x', 'add'], ['scale', 'mul']]);
    expect(anim.tracks[0]!.keys.map((k) => k.dt)).toEqual([0, 1]); // relative to the in point (1 s)
    // Same layer with a later in point: keys follow it.
    const dst = { ...src, timing: { in: 3, out: null } };
    const r = applyAnimation(dst, anim, comp, fps);
    expect(r.skipped).toBe(0);
    const out = apply(dst, r.patches);
    expect(keyTimes(out.opacity)).toEqual([3, 4]);
    expect(keyTimes(out.transform.x)).toEqual([3.5, 4.5]);
    expect(out.motion).toEqual(src.motion);
    // Onto itself: identical.
    const self = apply(src, applyAnimation(src, anim, comp, fps).patches);
    expect(self.opacity).toEqual(src.opacity);
    expect(keyVals(self.transform.x)).toEqual([100, 400]);
    expect(keyVals(self.transform.scale).map((v) => Math.round((v as number) * 1e6) / 1e6)).toEqual([1, 1.5]);
  });

  it('position is an offset and scale a factor: the same animation on a layer elsewhere moves with it', () => {
    const doc = shotAnimated(base);
    const anim = captureAnimation(layer(doc, 'shot'), comp)!;
    const shot = layer(doc, 'shot') as ImageLayer;
    // A second image 300 px to the right and twice as big.
    const other: ImageLayer = { ...shot, id: 'other', transform: { ...shot.transform, x: { static: 400 }, scale: { static: 2 } }, opacity: { static: 1 }, motion: noMotion };
    const placed = apply(other, applyAnimation(other, anim, comp, fps).patches);
    const final = { ...doc, comp: { ...doc.comp, layers: [...doc.comp.layers, placed] } };
    const dx = 400 - 100; // other's x minus the source's first key
    type Item = { x: number; y: number; scale: number };
    for (const t of [1.5, 1.8, 2.2, 2.5, 3]) {
      const items = evaluate(final, t).items as unknown as (Item & { id: string })[];
      const a = items.find((i) => i.id === 'shot')!;
      const b = items.find((i) => i.id === 'other')!;
      expect(b.x).toBeCloseTo(a.x + dx, 3);
      expect(b.scale).toBeCloseTo(a.scale * 2, 3);
      expect(b.y).toBeCloseTo(a.y, 6);
    }
  });

  it('rotation is an offset; a first scale key of 0 stays absolute', () => {
    const shot = still(base);
    const l: ImageLayer = { ...shot, transform: { ...shot.transform, rotation: keys([0, 10], [1, 40]), scale: keys([0, 0], [1, 1]) } };
    const anim = captureAnimation(l, comp)!;
    expect(anim.tracks.find((t) => t.propId === 'rotation')).toMatchObject({ rel: 'add', keys: [{ v: 0 }, { v: 30 }] });
    expect(anim.tracks.find((t) => t.propId === 'scale')!.rel).toBeNull();
    const t: ImageLayer = { ...l, transform: { ...l.transform, rotation: { static: 100 }, scale: { static: 3 } } };
    const out = apply(t, applyAnimation(t, anim, comp, fps).patches);
    expect(keyVals(out.transform.rotation)).toEqual([100, 130]);
    expect(keyVals(out.transform.scale)).toEqual([0, 1]);
  });

  it('round-trips a text layer with a custom glyph animator and glyph presets', () => {
    const head = layer(base, 'headline') as TextLayer;
    expect(head.animator).not.toBeNull();
    const src: TextLayer = { ...head, timing: { in: 2, out: null }, animator: { ...head.animator!, start: 2.5 }, color: keys([2, [1, 0, 0, 1]], [3, [0, 0, 1, 1]]), motion: { enter: defaultEnter('typewriter', 0), exit: null, loop: defaultLoop('wave', comp) } };
    const anim = captureAnimation(src, comp)!;
    expect(anim.animator!.start).toBeCloseTo(0.5, 9);
    const dst: TextLayer = { ...src, timing: { in: 0, out: null }, animator: null, color: { static: [1, 1, 1, 1] }, motion: noMotion };
    const r = applyAnimation(dst, anim, comp, fps);
    expect(r.skipped).toBe(0);
    const out = apply(dst, r.patches);
    expect(out.animator!.start).toBeCloseTo(0.5, 9);
    expect(out.motion).toEqual(src.motion);
    expect(keyVals(out.color)).toEqual([[1, 0, 0, 1], [0, 0, 1, 1]]);
    expect(keyTimes(out.color)).toEqual([0, 1]);
  });

  it('round-trips a background fill', () => {
    const bg = layer(base, 'bg');
    const fillColor = (l: Layer) => (l as unknown as { fill: { color: Prop<unknown> } }).fill.color;
    const src = { ...bg, fill: { kind: 'solid', color: keys([0, [0, 0, 0, 1]], [1, [1, 1, 1, 1]]) } } as Layer;
    const anim = captureAnimation(src, comp)!;
    expect(anim.layerType).toBe('background');
    expect(animationFits(anim, 'image')).toBe(false);
    const dst = { ...bg, fill: { kind: 'solid', color: { static: [0.5, 0.5, 0.5, 1] } } } as Layer;
    expect(fillColor(apply(dst, applyAnimation(dst, anim, comp, fps).patches))).toEqual(fillColor(src));
  });

  it('matches effects by kind, not by id, and skips what the target lacks', () => {
    const fxA = createEffect('blur');
    fxA.params.radius = keys([0, 2], [1, 20]);
    const src: ImageLayer = { ...still(base), effects: [fxA] };
    const anim = captureAnimation(src, comp)!;
    expect(anim.tracks.map((t) => t.propId)).toContain('fx:@blur:radius');
    const dst: ImageLayer = { ...src, effects: [createEffect('grain'), createEffect('blur')] };
    const r = applyAnimation(dst, anim, comp, fps);
    expect(r.patches.map((p) => p.path.join('.'))).toEqual(['effects.1.params.radius']);
    expect(keyVals(r.patches[0]!.value as Prop<unknown>)).toEqual([2, 20]);
    // No blur at all: skipped.
    const none = applyAnimation({ ...src, effects: [] }, anim, comp, fps);
    expect([none.applied, none.skipped]).toEqual([0, 1]);
  });

  it('counts skipped parts: glyph presets and animators on an image, props the target lacks, text on an image', () => {
    const head = layer(base, 'headline') as TextLayer;
    const src: TextLayer = {
      ...head,
      timing: { in: 0, out: null },
      color: keys([0, [1, 0, 0, 1]], [1, [0, 0, 1, 1]]),
      shadow: { offsetX: keys([0, 0], [1, 10]), offsetY: { static: 0 }, blur: { static: 4 }, color: { static: [0, 0, 0, 1] } },
      text: keys([0, 'a'], [1, 'b']),
      motion: { enter: defaultEnter('typewriter', 0), exit: null, loop: defaultLoop('float', comp) },
      opacity: keys([0, 0], [1, 1]),
      glow: { static: 0.5 },
    };
    const anim = captureAnimation(src, comp)!;
    const dst: ImageLayer = { ...still(base), shadow: null };
    const r = applyAnimation(dst, anim, comp, fps);
    // Applied: opacity, the float loop. Skipped: colour, text, shadow offset X (an image has none of these here),
    // the typewriter enter and the custom animator.
    expect(r.applied).toBe(2);
    expect(r.skipped).toBe(5);
    const out = apply(dst, r.patches);
    expect(out.motion.enter).toBeNull(); // the glyph enter did not land
    expect(out.motion.loop?.preset).toBe('float');
    // A kind mismatch is skipped as well.
    const odd = applyAnimation(dst, { ...anim, tracks: [{ propId: 'opacity', kind: 'color', rel: null, keys: [{ dt: 0, v: [0, 0, 0, 1], out: Easings.linear }] }], motion: null, animator: null }, comp, fps);
    expect([odd.applied, odd.skipped]).toEqual([0, 1]);
  });

  it('keeps the target motion parts the preset does not have', () => {
    const doc = shotAnimated(base);
    const anim = captureAnimation(layer(doc, 'shot'), comp)!; // enter + loop
    const dst: ImageLayer = { ...(layer(doc, 'shot') as ImageLayer), motion: { enter: null, exit: { preset: 'fade', endOffset: 0, duration: 0.5, easing: Easings.linear }, loop: null } };
    const out = apply(dst, applyAnimation(dst, anim, comp, fps).patches);
    expect(out.motion.exit?.preset).toBe('fade');
    expect(out.motion.enter?.preset).toBe('slide-up');
  });
});

describe('preset files', () => {
  const doc = withLayer(createDemoDoc(), 'shot', { opacity: keys([0, 0], [1, 1]), motion: { enter: defaultEnter('pop', 0), exit: null, loop: null } });
  const anim = captureAnimation(layer(doc, 'shot'), doc.comp)!;
  const presets = [asPreset(anim, 1), asPreset(anim, 2)];

  it('round-trips through JSON', () => {
    expect(parsePresetText(presetFileJson(presets))).toEqual(presets);
  });

  it('explains what is wrong with a file', () => {
    const msg = (x: unknown) => {
      try {
        parsePresetFile(x);
      } catch (e) {
        expect(e).toBeInstanceOf(PresetFileError);
        return (e as Error).message;
      }
      return 'no error';
    };
    expect(msg({ hello: 1 })).toMatch(/not a Glyphix presets file/);
    expect(msg(null)).toMatch(/not a Glyphix presets file/);
    expect(() => parsePresetText('{nope')).toThrow(/not valid JSON/);
    expect(msg({ format: 'glyphix-presets', version: 2, presets: [] })).toMatch(/newer version/);
    expect(msg({ format: 'glyphix-presets', version: 1 })).toMatch(/no list of presets/);
    const file = (p: unknown) => ({ format: 'glyphix-presets', version: 1, presets: [presets[0], presets[1], p] });
    const copy = () => JSON.parse(JSON.stringify(presets[0]));
    expect(msg(file(null))).toMatch(/^Preset 3 is damaged \(it is not an object\)/);
    const nan = copy();
    nan.tracks[0].keys[0].v = 'x';
    expect(msg(file(nan))).toMatch(/Preset 3 is damaged \(property 1 key 1 has a number value/);
    const ease = copy();
    ease.tracks[0].keys[0].out = { kind: 'wobble' };
    expect(msg(file(ease))).toMatch(/easing "wobble" is unknown/);
    const inf = copy();
    inf.tracks[0].keys[0].out = { kind: 'bezier', x1: 0, y1: 0, x2: null, y2: 1 };
    expect(msg(file(inf))).toMatch(/bad "x2"/);
    const mo = copy();
    mo.motion.enter.preset = 'explode';
    expect(msg(file(mo))).toMatch(/"explode" is unknown/);
    const nameless = copy();
    delete nameless.name;
    expect(msg(file(nameless))).toMatch(/no name/);
    const col = copy();
    col.tracks[0].kind = 'color';
    expect(msg(file(col))).toMatch(/color value/);
  });
});
