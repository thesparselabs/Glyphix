import { useMemo, useRef, useState } from 'react';
import { AnimationSection, ORDER_OPTIONS } from './AnimationSection';
import { EffectsSection } from './EffectsSection';
import { PropControl } from './KeyButton';
import { VideoSection } from './VideoSection';
import { FontPicker } from './FontPicker';
import { Switch } from '@/components/wensity/switch';
import { fontLibrary } from '@/text/fontLibrary';
import { effectiveWeight, namedWeights, WEIGHT_NAMES } from '@/text/fonts';
import { CropSection, TransformSection } from './TransformSection';
import {
  isGlyphPreset,
  matchesStill,
  resolveProps,
  sampleValue,
  stillBorder,
  stillFill,
  stillGradient,
  stillOutline,
  stillShadow,
  stillTextShadow,
  type Resolved,
  isPlaced,
  NO_TILT,
  type AdjustmentLayer,
  type BackgroundFill,
  type BackgroundLayer,
  type Color,
  type Doc,
  type FrameKind,
  type ImageLayer,
  type Layer,
  type StaggerOrder,
  type TextLayer,
} from '@/doc';
import { assetStore } from '@/assets/assetStore';
import {
  BACKGROUND_PRESETS,
  CANVAS_PRESETS,
  currentPadding,
  fillToCss,
  fitWithPaddingPatches,
  resizeCompPatches,
  SHADOW_PRESETS,
  TILT_PRESETS,
} from '@/styling/presets';
import { extractPalette, samplePixels, suggestBackgrounds } from '@/styling/palette';
import { layerIndex, useEditor } from './store';
import { EasingButton } from './EasingEditor';
import { KeyEasing } from './timeline/KeyEasing';
import { useKeySelection } from './timeline/keySelection';
import { ColorField, Field, inputClass, PresetGrid, Section, Segmented, SelectField, SliderField } from './ui';

type Edit = (label: string, path: (string | number)[], value: unknown) => void;

/** Equal if the only differences are layer x/y positions (what a drag changes). */
function sameIgnoringPositions(a: Doc, b: Doc): boolean {
  if (a === b) return true;
  if (a.comp.width !== b.comp.width || a.comp.height !== b.comp.height || a.comp.layers.length !== b.comp.layers.length) return false;
  return a.comp.layers.every((la, i) => {
    const lb = b.comp.layers[i]!;
    if (la === lb) return true;
    if (!isPlaced(la) || !isPlaced(lb) || la.id !== lb.id) return false;
    const keys = new Set([...Object.keys(la), ...Object.keys(lb)]);
    for (const k of keys) {
      const va = (la as unknown as Record<string, unknown>)[k];
      const vb = (lb as unknown as Record<string, unknown>)[k];
      if (k === 'transform') {
        if (la.transform.scale !== lb.transform.scale || la.transform.rotation !== lb.transform.rotation) return false;
      } else if (va !== vb) return false;
    }
    return true;
  });
}

/** The document, but stable across drags so panels don't re-render on every pointer move. */
function useDocForPanels(): Doc {
  const last = useRef<Doc | null>(null);
  return useEditor((s) => {
    if (last.current && sameIgnoringPositions(last.current, s.doc)) return last.current;
    return (last.current = s.doc);
  });
}

export function Inspector() {
  const doc = useDocForPanels();
  const selectedId = useEditor((s) => s.selectedId);
  const layer = doc.comp.layers.find((l) => l.id === selectedId);
  const bg = doc.comp.layers.find((l): l is BackgroundLayer => l.type === 'background');

  return (
    <aside className="min-h-0 overflow-y-auto border-l border-line bg-panel" aria-label="Inspector">
      {layer && layer.type !== 'background' ? (
        <LayerInspector layer={layer} index={layerIndex(doc, layer.id)} />
      ) : (
        <>
          <CanvasSection />
          {bg && <BackgroundSection layer={bg} index={layerIndex(doc, bg.id)} />}
          {bg && <BackgroundEffects layer={bg} index={layerIndex(doc, bg.id)} />}
        </>
      )}
    </aside>
  );
}

function BackgroundEffects({ layer, index }: { layer: BackgroundLayer; index: number }) {
  return <EffectsSection layer={layer} edit={useEdit(layer, index)} title="Background effects" />;
}

function useEdit(layer: Layer, index: number): Edit {
  const set = useEditor((s) => s.set);
  const base = ['comp', 'layers', index] as const;
  // Slider edits coalesce into a single undo step per property.
  return (label, path, value) => set(label, [{ path: [...base, ...path], value }], `${layer.id}:${path.join('.')}`);
}

function LayerInspector({ layer, index }: { layer: Exclude<Layer, BackgroundLayer>; index: number }) {
  const edit = useEdit(layer, index);
  const keys = useKeySelection((s) => (s.layerId === layer.id ? s.keys.size : 0));
  const keyframes = keys > 0 && (
    <Section title="Keyframes">
      <p className="text-xs text-dim">
        {keys} keyframe{keys === 1 ? '' : 's'} selected (E)
      </p>
      <Field label="Easing to the next key">
        <KeyEasing side="left" />
      </Field>
    </Section>
  );
  return (
    <>
      {keyframes}
      {layer.type === 'adjustment' ? (
        <AdjustmentInspector layer={layer} edit={edit} />
      ) : layer.type === 'text' ? (
        <TextInspector layer={layer} edit={edit} />
      ) : (
        <ImageInspector layer={layer} index={index} edit={edit} />
      )}
    </>
  );
}

function AdjustmentInspector({ layer, edit }: { layer: AdjustmentLayer; edit: Edit }) {
  const opacity = 'static' in layer.opacity ? layer.opacity.static : null;
  return (
    <>
      <Section title="Adjustment layer">
        <p className="text-xs leading-relaxed text-dim">Effects here apply to every layer below this one.</p>
        {opacity !== null && (
          <SliderField label="Amount" hint={`${Math.round(opacity * 100)}%`} min={0} max={1} step={0.01} value={opacity} onValueChange={(v) => edit('Adjustment amount', ['opacity'], { static: v })} />
        )}
      </Section>
      <EffectsSection layer={layer} edit={edit} />
    </>
  );
}

// ---------------------------------------------------------------------------

function CanvasSection() {
  const doc = useDocForPanels();
  const set = useEditor((s) => s.set);
  const { width, height } = doc.comp;
  const current = CANVAS_PRESETS.find((p) => p.width === width && p.height === height)?.id ?? 'custom';
  return (
    <Section title="Canvas">
      <PresetGrid
        label="Canvas size"
        value={current}
        options={CANVAS_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
        onChange={(id) => {
          const p = CANVAS_PRESETS.find((c) => c.id === id)!;
          set(`Canvas ${p.label}`, resizeCompPatches(doc, p.width, p.height));
        }}
      />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Width">
          <input
            type="number"
            className={inputClass}
            min={64}
            max={8192}
            value={width}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (v >= 64 && v <= 8192) set('Canvas width', resizeCompPatches(doc, v, height), 'canvas-size');
            }}
          />
        </Field>
        <Field label="Height">
          <input
            type="number"
            className={inputClass}
            min={64}
            max={8192}
            value={height}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (v >= 64 && v <= 8192) set('Canvas height', resizeCompPatches(doc, width, v), 'canvas-size');
            }}
          />
        </Field>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function BackgroundSection({ layer, index }: { layer: BackgroundLayer; index: number }) {
  const edit = useEdit(layer, index);
  const doc = useDocForPanels();
  const fill = layer.fill;
  const setFill = (label: string, f: BackgroundFill) => edit(label, ['fill'], f);
  // Images in the doc: palette source + image-background candidates.
  const images = useMemo(
    () => [...new Set(doc.comp.layers.flatMap((l) => (l.type === 'image' ? [l.assetId] : [])))].filter((id) => assetStore.has(id)),
    [doc.comp.layers],
  );
  const suggestions = useMemo(() => {
    const a = images[0] ? assetStore.get(images[0]) : undefined;
    if (!a) return [];
    const level = a.levels[a.levels.length - 1]!;
    return suggestBackgrounds(extractPalette(samplePixels(level.source as CanvasImageSource), 6, 1));
  }, [images]);

  const switchKind = (kind: BackgroundFill['kind']) => {
    if (kind === fill.kind) return;
    const first = firstColor(resolveProps(fill, useEditor.getState().time));
    if (kind === 'solid') setFill('Solid background', { kind: 'solid', color: { static: first } });
    else if (kind === 'linear') setFill('Gradient background', stillFill(BACKGROUND_PRESETS[0]!.fill));
    else if (kind === 'mesh') setFill('Mesh background', stillFill(BACKGROUND_PRESETS.find((p) => p.fill.kind === 'mesh')!.fill));
    else if (images[0]) setFill('Image background', { kind: 'image', assetId: images[0], blur: 40, dim: 0.15 });
  };

  return (
    <Section title="Background">
      <Segmented
        label="Background type"
        value={fill.kind}
        onChange={switchKind}
        options={[
          { value: 'solid', label: 'Solid' },
          { value: 'linear', label: 'Gradient' },
          { value: 'mesh', label: 'Mesh' },
          { value: 'image', label: 'Image', disabled: !images.length },
        ]}
      />

      {suggestions.length > 0 && (
        <Field label="From your screenshot">
          <Swatches fills={suggestions} current={fill} onPick={(f) => setFill('Background from screenshot', stillFill(f))} />
        </Field>
      )}
      <Field label="Presets">
        <Swatches fills={BACKGROUND_PRESETS.map((p) => p.fill)} current={fill} onPick={(f) => setFill('Background preset', stillFill(f))} />
      </Field>

      {fill.kind === 'solid' && (
        <PropControl prop={fill.color} name="background colour" label="Background colour" onChange={(p, l) => edit(l, ['fill', 'color'], p)}>
          {(v, set) => (
            <Field label="Colour">
              <ColorField value={v} onChange={set} />
            </Field>
          )}
        </PropControl>
      )}
      {fill.kind === 'linear' && (
        <>
          <PropControl prop={fill.angle} name="gradient angle" label="Gradient angle" onChange={(p, l) => edit(l, ['fill', 'angle'], p)}>
            {(v, set) => <SliderField label="Angle" hint={`${Math.round(v)}°`} min={0} max={360} value={v} onValueChange={set} />}
          </PropControl>
          <div className="flex gap-2">
            {fill.stops.map((stop, i) => (
              <div key={i} className="min-w-0 flex-1">
                <PropControl prop={stop.color} name={`gradient stop ${i + 1} colour`} label="Gradient colour" onChange={(p, l) => edit(l, ['fill', 'stops', i, 'color'], p)}>
                  {(v, set) => <ColorField label={`Stop ${i + 1}`} value={v} onChange={set} />}
                </PropControl>
              </div>
            ))}
          </div>
        </>
      )}
      {fill.kind === 'mesh' && (
        <div className="flex gap-2">
          {fill.points.map((p, i) => (
            <div key={i} className="min-w-0 flex-1">
              <PropControl prop={p.color} name={`mesh point ${i + 1} colour`} label="Mesh colour" onChange={(pr, l) => edit(l, ['fill', 'points', i, 'color'], pr)}>
                {(v, set) => <ColorField label={`Point ${i + 1}`} value={v} onChange={set} />}
              </PropControl>
            </div>
          ))}
        </div>
      )}
      {fill.kind === 'image' && (
        <>
          <SliderField label="Blur" hint={`${fill.blur}px`} min={0} max={160} value={fill.blur} onValueChange={(v) => edit('Background blur', ['fill', 'blur'], v)} />
          <SliderField label="Dim" hint={`${Math.round(fill.dim * 100)}%`} min={0} max={0.9} step={0.01} value={fill.dim} onValueChange={(v) => edit('Background dim', ['fill', 'dim'], v)} />
        </>
      )}
    </Section>
  );
}

const firstColor = (f: Resolved<BackgroundFill>): Color =>
  f.kind === 'solid' ? f.color : f.kind === 'linear' ? (f.stops[0]?.color ?? [0, 0, 0, 1]) : f.kind === 'mesh' ? (f.points[0]?.color ?? [0, 0, 0, 1]) : [0.1, 0.1, 0.12, 1];

/** Preset swatches use plain values; the one matching the document's current (non-animated) fill is highlighted. */
function Swatches({ fills, current, onPick }: { fills: Resolved<BackgroundFill>[]; current: BackgroundFill; onPick: (f: Resolved<BackgroundFill>) => void }) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {fills.map((f, i) => {
        const active = matchesStill(current, f);
        return (
          <button
            key={i}
            type="button"
            aria-label={`Apply ${f.kind} background ${i + 1}`}
            aria-pressed={active}
            onClick={() => onPick(f)}
            className={`aspect-video rounded-md transition hover:ring-2 hover:ring-accent ${active ? 'ring-2 ring-accent' : 'ring-1 ring-line'}`}
            // Mesh fills are translucent gradients: give them a grey base colour (last layer of the shorthand).
            style={{ background: f.kind === 'mesh' ? `${fillToCss(f)}, #888` : fillToCss(f) }}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

const FRAMES: { value: FrameKind; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'macos-light', label: 'Window' },
  { value: 'macos-dark', label: 'Window dark' },
  { value: 'browser-light', label: 'Browser' },
  { value: 'browser-dark', label: 'Browser dark' },
];

function ImageInspector({ layer, index, edit }: { layer: ImageLayer; index: number; edit: Edit }) {
  const doc = useDocForPanels();
  const set = useEditor((s) => s.set);
  const shadowId = SHADOW_PRESETS.find((p) => matchesStill(layer.shadow, p.shadow))?.id ?? 'custom';
  const tiltId = TILT_PRESETS.find((p) => JSON.stringify(p.tilt) === JSON.stringify(layer.tilt))?.id ?? 'custom';
  const rx = 'static' in layer.tilt.rotateX ? layer.tilt.rotateX.static : 0;
  const ry = 'static' in layer.tilt.rotateY ? layer.tilt.rotateY.static : 0;
  const padding = currentPadding(doc, layer);
  const maxPad = Math.round(Math.min(doc.comp.width, doc.comp.height) / 2 - 40);

  return (
    <>
      <TransformSection layer={layer} edit={edit} />
      <Section title="Frame">
        <PresetGrid label="Frame" value={layer.frame.kind} options={FRAMES} onChange={(kind) => edit('Frame', ['frame', 'kind'], kind)} />
        {layer.frame.kind.startsWith('browser') && (
          <Field label="Address">
            <input className={inputClass} value={layer.frame.url} placeholder="glyphix.app" onChange={(e) => edit('Frame URL', ['frame', 'url'], e.target.value)} />
          </Field>
        )}
      </Section>

      <Section title="Layout">
        <SliderField label="Padding" hint={`${padding}px`} min={0}
            max={maxPad}
            value={Math.min(padding, maxPad)}
            onValueChange={(v) => set('Padding', fitWithPaddingPatches(doc, index, v), `${layer.id}:padding`)} />
        <PropControl prop={layer.radius} name="corner radius" label="Radius" onChange={(p, l) => edit(l, ['radius'], p)}>
          {(v, set) => <SliderField label="Corner radius" hint={`${Math.round(v)}px`} min={0} max={80} value={v} onValueChange={set} />}
        </PropControl>
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            {layer.border ? (
              <PropControl prop={layer.border.width} name="border width" label="Border" onChange={(p, l) => edit(l, ['border'], { ...layer.border!, width: p })}>
                {(w, set) => (
                  <SliderField
                    label="Border"
                    hint={`${w}px`}
                    min={0}
                    max={24}
                    value={w}
                    onValueChange={(nw) => (nw === 0 && 'static' in layer.border!.width ? edit('Border', ['border'], null) : set(nw))}
                  />
                )}
              </PropControl>
            ) : (
              <SliderField label="Border" hint="off" min={0} max={24} value={0} onValueChange={(w) => w > 0 && edit('Border', ['border'], stillBorder({ width: w, color: [1, 1, 1, 0.35] }))} />
            )}
          </div>
          {layer.border && (
            <div className="w-14">
              <PropControl prop={layer.border.color} name="border colour" label="Border colour" onChange={(p, l) => edit(l, ['border', 'color'], p)}>
                {(v, set) => <ColorField label="Border colour" alpha value={v} onChange={set} />}
              </PropControl>
            </div>
          )}
        </div>
      </Section>

      {layer.video && <VideoSection layer={{ ...layer, video: layer.video }} edit={edit} />}
      <CropSection layer={layer} index={index} />
      <Section title="Shadow">
        <PresetGrid
          label="Shadow preset"
          value={shadowId}
          onChange={(id) => {
            const sh = SHADOW_PRESETS.find((p) => p.id === id)!.shadow;
            edit('Shadow', ['shadow'], sh ? stillShadow(sh) : null);
          }}
          options={SHADOW_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
        />
        {layer.shadow && (
          <>
            <PropControl prop={layer.shadow.blur} name="shadow blur" label="Shadow blur" onChange={(p, l) => edit(l, ['shadow', 'blur'], p)}>
              {(v, set) => <SliderField label="Blur" hint={`${Math.round(v)}px`} min={0} max={200} value={v} onValueChange={set} />}
            </PropControl>
            <PropControl prop={layer.shadow.offsetY} name="shadow offset" label="Shadow offset" onChange={(p, l) => edit(l, ['shadow', 'offsetY'], p)}>
              {(v, set) => <SliderField label="Offset" hint={`${Math.round(v)}px`} min={-100} max={150} value={v} onValueChange={set} />}
            </PropControl>
            <PropControl prop={layer.shadow.color} name="shadow opacity" label="Shadow opacity" onChange={(p, l) => edit(l, ['shadow', 'color'], p)}>
              {(c, set) => <SliderField label="Opacity" hint={`${Math.round(c[3] * 100)}%`} min={0} max={1} step={0.01} value={c[3]} onValueChange={(a) => set([c[0], c[1], c[2], a])} />}
            </PropControl>
          </>
        )}
      </Section>

      <Section title="3D tilt">
        <PresetGrid
          label="Tilt preset"
          value={tiltId}
          options={TILT_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
          onChange={(id) => edit('Tilt', ['tilt'], TILT_PRESETS.find((p) => p.id === id)!.tilt)}
        />
        <SliderField label="Tilt X" hint={`${rx}°`} min={-45} max={45} value={rx} onValueChange={(v) => edit('Tilt X', ['tilt', 'rotateX'], { static: v })} />
        <SliderField label="Tilt Y" hint={`${ry}°`} min={-45} max={45} value={ry} onValueChange={(v) => edit('Tilt Y', ['tilt', 'rotateY'], { static: v })} />
        <SliderField label="Perspective" hint={`${layer.tilt.perspective}px`} min={800}
            max={6000}
            step={100}
            value={layer.tilt.perspective ?? NO_TILT.perspective}
            onValueChange={(v) => edit('Perspective', ['tilt', 'perspective'], v)} />
      </Section>
      <AnimationSection layer={layer} edit={edit} />
      <EffectsSection layer={layer} edit={edit} />
    </>
  );
}

// ---------------------------------------------------------------------------

function TextInspector({ layer, edit }: { layer: TextLayer; edit: Edit }) {
  // The hand-tuned animator applies only when no per-glyph enter preset is chosen.
  const anim = layer.motion.enter && isGlyphPreset(layer.motion.enter.preset) ? null : layer.animator;
  const [fontError, setFontError] = useState<string | null>(null);
  const info = fontLibrary.info(layer.fontId);
  const weights = namedWeights(info);
  const weight = effectiveWeight(info, layer.weight);
  const glow = 'static' in layer.glow ? layer.glow.static : null;
  return (
    <>
      <Section title="Text">
        <PropControl prop={layer.text} name="text" label="Edit text" align="start" onChange={(p, l) => edit(l, ['text'], p)}>
          {(v, set) => (
            <Field label="Content">
              <textarea className={`${inputClass} min-h-16 resize-y`} value={v} onChange={(e) => set(e.target.value)} />
            </Field>
          )}
        </PropControl>
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-dim">Font</span>
          <FontPicker
            value={layer.fontId}
            onChange={(id) => {
              setFontError(null);
              edit('Font', ['fontId'], id);
            }}
            onError={setFontError}
          />
          {fontError && (
            <p role="alert" className="text-xs text-red-300">
              {fontError}
            </p>
          )}
        </div>
        <SelectField
          label="Weight"
          value={String(weights.includes(weight) ? weight : weights[0])}
          options={weights.map((w) => ({ value: String(w), label: `${WEIGHT_NAMES[w] ?? w} · ${w}` }))}
          onValueChange={(v) => edit('Font weight', ['weight'], Number(v))}
        />
        <SliderField label="Size" hint={`${layer.fontSize}px`} min={12} max={400} value={layer.fontSize} onValueChange={(v) => edit('Font size', ['fontSize'], v)} />
        <SliderField label="Line height" hint={`${layer.lineHeight.toFixed(2)}×`} min={0.7} max={2.2} step={0.01} value={layer.lineHeight} onValueChange={(v) => edit('Line height', ['lineHeight'], v)} />
        <SliderField label="Tracking" hint={`${layer.tracking.toFixed(2)}em`} min={-0.1} max={0.4} step={0.01} value={layer.tracking} onValueChange={(v) => edit('Tracking', ['tracking'], v)} />
        <Field label="Align">
          <Segmented
            label="Text alignment"
            value={layer.align}
            onChange={(v) => edit('Align', ['align'], v)}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'center', label: 'Centre' },
              { value: 'right', label: 'Right' },
            ]}
          />
        </Field>
      </Section>

      <AnimationSection layer={layer} edit={edit} />
      <EffectsSection layer={layer} edit={edit} />

      <Section title="Fill">
        <Segmented
          label="Fill type"
          value={layer.gradient ? 'gradient' : 'solid'}
          onChange={(v) =>
            edit(
              'Fill',
              ['gradient'],
              v === 'gradient' ? stillGradient({ angle: 0, from: sampleValue(layer.color, useEditor.getState().time), to: [0.55, 0.85, 1, 1] }) : null,
            )
          }
          options={[
            { value: 'solid', label: 'Solid' },
            { value: 'gradient', label: 'Gradient' },
          ]}
        />
        {layer.gradient ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <PropControl prop={layer.gradient.from} name="gradient start colour" label="Gradient colour" onChange={(p, l) => edit(l, ['gradient', 'from'], p)}>
                {(v, set) => (
                  <Field label="From">
                    <ColorField label="Gradient start colour" value={v} onChange={set} />
                  </Field>
                )}
              </PropControl>
              <PropControl prop={layer.gradient.to} name="gradient end colour" label="Gradient colour" onChange={(p, l) => edit(l, ['gradient', 'to'], p)}>
                {(v, set) => (
                  <Field label="To">
                    <ColorField label="Gradient end colour" value={v} onChange={set} />
                  </Field>
                )}
              </PropControl>
            </div>
            <PropControl prop={layer.gradient.angle} name="text gradient angle" label="Gradient angle" onChange={(p, l) => edit(l, ['gradient', 'angle'], p)}>
              {(v, set) => <SliderField label="Angle" hint={`${Math.round(v)}°`} min={0} max={360} value={v} onValueChange={set} />}
            </PropControl>
          </>
        ) : (
          <PropControl prop={layer.color} name="text colour" label="Text colour" onChange={(p, l) => edit(l, ['color'], p)}>
            {(v, set) => (
              <Field label="Colour">
                <ColorField label="Text colour" value={v} onChange={set} />
              </Field>
            )}
          </PropControl>
        )}
      </Section>

      <Section title="Outline">
        <Switch
          switchSize="sm"
          checked={!!layer.outline}
          onCheckedChange={(on) => edit('Outline', ['outline'], on ? stillOutline({ width: Math.max(1, Math.round(layer.fontSize * 0.04)), color: [0, 0, 0, 1] }) : null)}
          label="Outline"
          labelClassName="text-xs text-dim"
        />
        {layer.outline && (
          <>
            <PropControl prop={layer.outline.width} name="outline width" label="Outline width" onChange={(p, l) => edit(l, ['outline', 'width'], p)}>
              {(v, set) => <SliderField label="Width" hint={`${Math.round(v * 10) / 10}px`} min={1} max={Math.max(4, Math.round(layer.fontSize * 0.2))} value={v} onValueChange={set} />}
            </PropControl>
            <PropControl prop={layer.outline.color} name="outline colour" label="Outline colour" onChange={(p, l) => edit(l, ['outline', 'color'], p)}>
              {(v, set) => (
                <Field label="Colour">
                  <ColorField label="Outline colour" value={v} onChange={set} />
                </Field>
              )}
            </PropControl>
          </>
        )}
      </Section>

      <Section title="Shadow">
        <Switch
          switchSize="sm"
          checked={!!layer.shadow}
          onCheckedChange={(on) =>
            edit(
              'Text shadow',
              ['shadow'],
              on ? stillTextShadow({ offsetX: 0, offsetY: Math.round(layer.fontSize * 0.05), blur: Math.round(layer.fontSize * 0.08), color: [0, 0, 0, 0.5] }) : null,
            )
          }
          label="Text shadow"
          labelClassName="text-xs text-dim"
        />
        {layer.shadow && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <PropControl prop={layer.shadow.offsetX} name="text shadow X offset" label="Shadow X" onChange={(p, l) => edit(l, ['shadow', 'offsetX'], p)}>
                {(v, set) => <SliderField label="X" hint={`${Math.round(v)}px`} min={-60} max={60} value={v} onValueChange={set} />}
              </PropControl>
              <PropControl prop={layer.shadow.offsetY} name="text shadow Y offset" label="Shadow Y" onChange={(p, l) => edit(l, ['shadow', 'offsetY'], p)}>
                {(v, set) => <SliderField label="Y" hint={`${Math.round(v)}px`} min={-60} max={60} value={v} onValueChange={set} />}
              </PropControl>
            </div>
            <PropControl prop={layer.shadow.blur} name="text shadow blur" label="Shadow softness" onChange={(p, l) => edit(l, ['shadow', 'blur'], p)}>
              {(v, set) => <SliderField label="Softness" hint={`${Math.round(v)}px`} min={0} max={Math.max(4, Math.round(layer.fontSize * 0.2))} value={v} onValueChange={set} />}
            </PropControl>
            <PropControl prop={layer.shadow.color} name="text shadow colour" label="Shadow colour" onChange={(p, l) => edit(l, ['shadow', 'color'], p)}>
              {(v, set) => (
                <Field label="Colour">
                  <ColorField label="Shadow colour" alpha value={v} onChange={set} />
                </Field>
              )}
            </PropControl>
          </>
        )}
      </Section>

      <Section title="Glow">
        {glow === null ? (
          <p className="text-xs text-dim">Glow is animated in this project (keyframes).</p>
        ) : (
          <SliderField label="Strength" hint={`${Math.round(glow * 100)}%`} min={0} max={1} step={0.01} value={glow} onValueChange={(v) => edit('Glow', ['glow'], { static: v })} />
        )}
        <PropControl prop={layer.glowColor} name="glow colour" label="Glow colour" onChange={(p, l) => edit(l, ['glowColor'], p)}>
          {(v, set) => (
            <Field label="Colour">
              <ColorField label="Glow colour" value={v} onChange={set} />
            </Field>
          )}
        </PropControl>
      </Section>

      <TransformSection layer={layer} edit={edit} />
      {anim && (
        <Section title="Custom glyph animation">
          <Field label="Easing">
            <EasingButton label="Glyph easing" value={anim.easing} side="left" onChange={(e) => edit('Easing', ['animator', 'easing'], e)} />
          </Field>
          <SelectField<StaggerOrder>
            label="Order"
            value={anim.order}
            options={ORDER_OPTIONS}
            onValueChange={(o) => edit('Stagger order', ['animator', 'order'], o)}
          />
          <SliderField label="Stagger" hint={`${Math.round(anim.stagger * 1000)}ms`} min={0} max={0.2} step={0.005} value={anim.stagger} onValueChange={(v) => edit('Stagger', ['animator', 'stagger'], v)} />
          <SliderField label="Duration" hint={`${anim.duration.toFixed(2)}s`} min={0.1} max={2} step={0.05} value={anim.duration} onValueChange={(v) => edit('Duration', ['animator', 'duration'], v)} />
          <SliderField label="Rise from" hint={`${anim.pose.offsetY}px`} min={-200} max={200} value={anim.pose.offsetY} onValueChange={(v) => edit('Rise', ['animator', 'pose', 'offsetY'], v)} />
          <SliderField label="Rotate from" hint={`${anim.pose.rotation}°`} min={-90} max={90} value={anim.pose.rotation} onValueChange={(v) => edit('Rotate', ['animator', 'pose', 'rotation'], v)} />
          <SliderField label="Scale from" hint={`${anim.pose.scaleX.toFixed(2)}×`} min={0} max={3} step={0.05} value={anim.pose.scaleX} onValueChange={(v) => edit('Scale', ['animator', 'pose'], { ...anim.pose, scaleX: v, scaleY: v })} />
          <SliderField label="Seed" hint={String(anim.seed)} min={0} max={100} value={anim.seed} onValueChange={(v) => edit('Seed', ['animator', 'seed'], v)} />
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

