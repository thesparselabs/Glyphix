import { useMemo, useState } from 'react';
import {
  defaultEnter,
  defaultExit,
  defaultLoop,
  Easings,
  ENTER_PRESETS,
  exitStart,
  EXIT_PRESETS,
  glyphPresetDefaults,
  LOOP_PRESETS,
  type Easing,
  type EnterMotion,
  type EnterPreset,
  type ExitMotion,
  type ExitPreset,
  type GlyphUnit,
  type ImageLayer,
  type LoopPreset,
  type Motion,
  type PresetInfo,
  type StaggerOptions,
  type StaggerOrder,
  type TextLayer,
} from '@/doc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/wensity/tabs';
import { Toggle } from '@/components/wensity/toggle';
import { EasingButton } from './EasingEditor';
import { useEditor } from './store';
import { copyAnimation, pasteAnimation, useAnimState } from './animActions';
import { SavedAnimations } from './SavedAnimations';
import { Button, Field, Segmented, SelectField, SliderField } from './ui';

type Edit = (label: string, path: (string | number)[], value: unknown) => void;

export const ORDER_OPTIONS: { value: StaggerOrder; label: string }[] = [
  { value: 'forward', label: 'First to last' },
  { value: 'reverse', label: 'Last to first' },
  { value: 'center', label: 'From the centre' },
  { value: 'edges', label: 'From the edges' },
  { value: 'random', label: 'Random' },
];

const FALLOFFS: Record<string, Easing> = {
  Even: Easings.linear,
  'Speed up': Easings.easeInCubic,
  'Slow down': Easings.easeOutCubic,
};

/** Play a motion on the canvas without touching the document (hover preview). */
function previewMotion(layerId: string, motion: Motion, from: number) {
  const s = useEditor.getState();
  s.setPreview({ layerId, motion });
  s.setTime(Math.max(0, Math.min(s.doc.comp.duration, from)));
  s.setPlaying(true);
}

function endPreview() {
  const s = useEditor.getState();
  if (s.preview) s.setPreview(null);
}

/** Grid of presets; hovering (or focusing) one previews it on the canvas. */
function PresetPicker<P extends string>({
  label,
  value,
  presets,
  layerType,
  onPick,
  onPreview,
}: {
  label: string;
  value: P | 'none';
  presets: PresetInfo<P>[];
  layerType: 'image' | 'text';
  onPick: (id: P | 'none') => void;
  onPreview: (id: P) => void;
}) {
  const available = presets.filter((p) => p.for.includes(layerType));
  const groups = layerType === 'text' ? [available.filter((p) => !p.glyph), available.filter((p) => p.glyph)] : [available];
  const button = (id: P | 'none', text: string) => (
    <Toggle
      key={id}
      variant="outline"
      size="sm"
      pressed={value === id}
      onPressedChange={() => onPick(id)}
      onPointerEnter={() => id !== 'none' && onPreview(id as P)}
      onPointerLeave={endPreview}
      onFocus={() => id !== 'none' && onPreview(id as P)}
      onBlur={endPreview}
      className="h-auto min-h-8 px-1.5 py-1.5 text-xs leading-tight whitespace-normal data-[pressed]:border-accent data-[pressed]:bg-accent/20 data-[pressed]:text-white"
    >
      {text}
    </Toggle>
  );
  return (
    <div role="group" aria-label={label} className="space-y-2">
      {groups.map((g, i) => (
        <div key={i} className="space-y-1.5">
          {groups.length > 1 && <div className="text-[11px] text-dim">{i === 0 ? 'Whole layer' : 'Letter by letter'}</div>}
          <div className="grid grid-cols-3 gap-1.5">
            {i === 0 && button('none', 'None')}
            {g.map((p) => button(p.id, p.label))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Unit / order / overlap / falloff overrides for per-glyph presets. */
function StaggerControls({ kind, motion, base, edit }: { kind: 'enter' | 'exit'; motion: EnterMotion | ExitMotion; base: (string | number)[]; edit: Edit }) {
  const defaults = glyphPresetDefaults(motion.preset, kind);
  const [open, setOpen] = useState(!!motion.stagger);
  if (!defaults) return null;
  const opts: StaggerOptions = motion.stagger ?? {};
  const set = (patch: Partial<StaggerOptions>) => edit('Stagger', [...base, 'stagger'], { ...opts, ...patch });
  const overlap = opts.overlap ?? (defaults.overlap === 'steps' ? 0.05 : defaults.overlap);
  const falloff = opts.falloff ?? defaults.falloff;
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} className="rounded-md ring-1 ring-line">
      <summary className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-zinc-300 outline-none select-none focus-visible:ring-2 focus-visible:ring-accent">Letter timing</summary>
      <div className="space-y-3 px-2.5 pt-1 pb-3">
        <Field label="Animate by">
          <Segmented<GlyphUnit>
            label="Animate by"
            value={opts.unit ?? defaults.unit}
            onChange={(unit) => set({ unit })}
            options={[
              { value: 'glyph', label: 'Letter' },
              { value: 'word', label: 'Word' },
              { value: 'line', label: 'Line' },
            ]}
          />
        </Field>
        <SelectField<StaggerOrder> label="Order" value={opts.order ?? defaults.order} options={ORDER_OPTIONS} onValueChange={(order) => set({ order })} />
        <SliderField label="Overlap" hint={`${Math.round(overlap * 100)}%`} min={0.05} max={1} step={0.01} value={overlap} onValueChange={(v) => set({ overlap: v })} />
        <SelectField
          label="Spacing"
          value={Object.entries(FALLOFFS).find(([, e]) => JSON.stringify(e) === JSON.stringify(falloff))?.[0] ?? 'Even'}
          options={Object.keys(FALLOFFS).map((k) => ({ value: k, label: k }))}
          onValueChange={(k) => set({ falloff: FALLOFFS[k] })}
        />
        {motion.stagger && (
          <button type="button" className="text-xs text-violet-300 hover:text-violet-200" onClick={() => edit('Reset letter timing', [...base, 'stagger'], undefined)}>
            Reset to the preset’s timing
          </button>
        )}
      </div>
    </details>
  );
}

function EasingSelect({ value, onChange }: { value: Easing; onChange: (e: Easing) => void }) {
  return (
    <Field label="Easing">
      <EasingButton label="Easing" value={value} side="left" onChange={(e) => onChange(e)} />
    </Field>
  );
}

/** Enter / exit / loop presets for an image or text layer. */
export function AnimationSection({ layer, edit }: { layer: ImageLayer | TextLayer; edit: Edit }) {
  // Only the duration: subscribing to the whole comp would re-render this section on every drag move.
  const duration = useEditor((s) => s.doc.comp.duration);
  const comp = useMemo(() => ({ duration }), [duration]);
  const { enter, exit, loop } = layer.motion;
  const [tab, setTab] = useState('enter');
  const hasCopied = useAnimState((s) => !!s.clipboard);

  const play = (t: number) => {
    // Jump the playhead to just before the animation so the change is visible immediately.
    const s = useEditor.getState();
    s.setTime(Math.max(0, Math.min(s.doc.comp.duration, t)));
    s.setPlaying(true);
  };

  const nextEnter = (id: EnterPreset): EnterMotion => ({ ...defaultEnter(id, enter?.start ?? 0), ...(enter ? { start: enter.start, duration: enter.duration } : {}) });
  const nextExit = (id: ExitPreset): ExitMotion => ({ ...defaultExit(id), ...(exit ? { endOffset: exit.endOffset, duration: exit.duration } : {}) });

  return (
    <section className="space-y-3 border-b border-line px-4 py-4" aria-label="Animation">
      <h3 className="text-[11px] font-semibold tracking-wider text-dim uppercase">Animation</h3>
      <div className="flex gap-1.5">
        <Button className="flex-1" title="Copy this layer's whole animation (Ctrl+Alt+C)" onClick={() => void copyAnimation()}>
          Copy animation
        </Button>
        <Button className="flex-1" disabled={!hasCopied || layer.locked} title="Paste the copied animation onto this layer (Ctrl+Alt+V)" onClick={() => void pasteAnimation()}>
          Paste animation
        </Button>
      </div>
      <Tabs variant="segmented" size="sm" value={tab} onValueChange={setTab}>
        <TabsList className="w-full">
          <TabsTrigger value="enter" className="flex-1">
            Enter{enter ? ' •' : ''}
          </TabsTrigger>
          <TabsTrigger value="exit" className="flex-1">
            Exit{exit ? ' •' : ''}
          </TabsTrigger>
          <TabsTrigger value="loop" className="flex-1">
            Loop{loop ? ' •' : ''}
          </TabsTrigger>
          <TabsTrigger value="saved" className="flex-1">
            Saved
          </TabsTrigger>
        </TabsList>

        <TabsContent value="enter" className="space-y-3 pt-3">
          <PresetPicker<EnterPreset>
            label="Enter animation"
            value={enter?.preset ?? 'none'}
            presets={ENTER_PRESETS}
            layerType={layer.type}
            onPreview={(id) => {
              const m = nextEnter(id);
              previewMotion(layer.id, { ...layer.motion, enter: m }, m.start);
            }}
            onPick={(id) => {
              endPreview();
              if (id === 'none') return edit('Remove enter animation', ['motion', 'enter'], null);
              const next = nextEnter(id);
              edit('Enter animation', ['motion', 'enter'], next);
              play(next.start);
            }}
          />
          {enter && (
            <>
              <SliderField label="Starts at" hint={`${enter.start.toFixed(2)}s`} min={0} max={comp.duration} step={0.05} value={enter.start} onValueChange={(v) => edit('Animation start', ['motion', 'enter', 'start'], v)} />
              <SliderField label="Duration" hint={`${enter.duration.toFixed(2)}s`} min={0.1} max={Math.max(3, comp.duration)} step={0.05} value={enter.duration} onValueChange={(v) => edit('Animation duration', ['motion', 'enter', 'duration'], v)} />
              <EasingSelect value={enter.easing} onChange={(e) => edit('Animation easing', ['motion', 'enter', 'easing'], e)} />
              {layer.type === 'text' && <StaggerControls key={enter.preset} kind="enter" motion={enter} base={['motion', 'enter']} edit={edit} />}
            </>
          )}
        </TabsContent>

        <TabsContent value="exit" className="space-y-3 pt-3">
          <PresetPicker<ExitPreset>
            label="Exit animation"
            value={exit?.preset ?? 'none'}
            presets={EXIT_PRESETS}
            layerType={layer.type}
            onPreview={(id) => {
              const m = nextExit(id);
              previewMotion(layer.id, { ...layer.motion, exit: m }, exitStart(m, comp) - 0.3);
            }}
            onPick={(id) => {
              endPreview();
              if (id === 'none') return edit('Remove exit animation', ['motion', 'exit'], null);
              const next = nextExit(id);
              edit('Exit animation', ['motion', 'exit'], next);
              play(exitStart(next, comp) - 0.3);
            }}
          />
          {exit && (
            <>
              <SliderField label="Ends before the end" hint={`${exit.endOffset.toFixed(2)}s`} min={0} max={Math.max(0, comp.duration - exit.duration)} step={0.05} value={exit.endOffset} onValueChange={(v) => edit('Exit timing', ['motion', 'exit', 'endOffset'], v)} />
              <SliderField label="Duration" hint={`${exit.duration.toFixed(2)}s`} min={0.1} max={Math.max(3, comp.duration)} step={0.05} value={exit.duration} onValueChange={(v) => edit('Exit duration', ['motion', 'exit', 'duration'], v)} />
              <EasingSelect value={exit.easing} onChange={(e) => edit('Exit easing', ['motion', 'exit', 'easing'], e)} />
              {layer.type === 'text' && <StaggerControls key={exit.preset} kind="exit" motion={exit} base={['motion', 'exit']} edit={edit} />}
            </>
          )}
        </TabsContent>

        <TabsContent value="loop" className="space-y-3 pt-3">
          <PresetPicker<LoopPreset>
            label="Loop animation"
            value={loop?.preset ?? 'none'}
            presets={LOOP_PRESETS}
            layerType={layer.type}
            onPreview={(id) => previewMotion(layer.id, { ...layer.motion, loop: defaultLoop(id, comp) }, useEditor.getState().time)}
            onPick={(id) => {
              endPreview();
              if (id === 'none') return edit('Remove loop', ['motion', 'loop'], null);
              edit('Loop animation', ['motion', 'loop'], defaultLoop(id, comp));
              play(0);
            }}
          />
          {loop && (
            <>
              <SliderField label="Cycle" hint={`${loop.period.toFixed(1)}s`} min={0.4} max={Math.max(10, comp.duration)} step={0.1} value={loop.period} onValueChange={(v) => edit('Loop cycle', ['motion', 'loop', 'period'], v)} />
              <SliderField label="Strength" hint={`${Math.round(loop.amount * 100)}%`} min={0} max={1} step={0.01} value={loop.amount} onValueChange={(v) => edit('Loop strength', ['motion', 'loop', 'amount'], v)} />
              {Math.abs(comp.duration / loop.period - Math.round(comp.duration / loop.period)) > 0.01 && (
                <p className="text-xs text-amber-300/90">
                  The video is {comp.duration}s; a {loop.period.toFixed(1)}s cycle won't loop seamlessly at the end.
                </p>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="saved" className="pt-3">
          <SavedAnimations layer={layer} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
