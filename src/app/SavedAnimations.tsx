// "Saved" tab of the Animation panel: the user's own animation presets (stored in this browser). Save the layer's
// animation, apply a preset to the selected layer (hover = preview on the canvas), rename, delete, and exchange the
// whole library as a .json file.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, Pencil, Trash2, Upload, X } from 'lucide-react';
import { applyAnimation, captureAnimation, layerSpan, misfitReason, parsePresetText, presetFileJson, type AnimPreset, type ImageLayer, type TextLayer } from '@/doc';
import { deletePreset, importPresets, listPresets, renamePreset, savePreset } from '@/persistence/presets';
import { downloadBlob } from '@/export/exporter';
import { applyAnimationTo, notify, resultNotice } from './animActions';
import { useEditor } from './store';
import { Button, Field, IconButton, inputClass } from './ui';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const size = (p: AnimPreset) => `${p.tracks.length} ${p.tracks.length === 1 ? 'property' : 'properties'}${p.motion || p.animator ? ' + motion' : ''}`;

/** Play a whole saved animation on the layer without touching the document (hover preview). */
function previewPreset(layer: ImageLayer | TextLayer, p: AnimPreset) {
  const s = useEditor.getState();
  const r = applyAnimation(layer, p, s.doc.comp, s.doc.comp.fps);
  if (!r.patches.length) return;
  s.setPreview({ layerId: layer.id, motion: layer.motion, patches: r.patches });
  s.setTime(layerSpan(layer, s.doc.comp)[0]);
  s.setPlaying(true);
}

const endPreview = () => {
  const s = useEditor.getState();
  if (s.preview) s.setPreview(null);
};

export function SavedAnimations({ layer }: { layer: ImageLayer | TextLayer }) {
  const duration = useEditor((s) => s.doc.comp.duration);
  const [presets, setPresets] = useState<AnimPreset[] | null>(null);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => listPresets().then(setPresets, (e: unknown) => (notify(`Could not read your saved animations: ${e instanceof Error ? e.message : String(e)}`, true), setPresets([]))), []);
  useEffect(() => void reload(), [reload]);
  useEffect(() => endPreview, []);

  const guard = (work: () => Promise<void>) => work().then(reload, (e: unknown) => notify(e instanceof Error ? e.message : String(e), true));
  const canSave = !!captureAnimation(layer, { duration });

  const save = () =>
    guard(async () => {
      const anim = captureAnimation(layer, useEditor.getState().doc.comp);
      if (!anim) return notify('Nothing to save: this layer has no animation.', true);
      const saved = await savePreset(name || `Animation ${(presets?.length ?? 0) + 1}`, anim);
      setName('');
      notify(`Saved '${saved.name}'`);
    });

  const apply = (p: AnimPreset) => {
    endPreview();
    const r = applyAnimationTo([layer.id], p, `Apply '${p.name}'`);
    if (!r) notify(layer.locked ? 'This layer is locked.' : (misfitReason(p, layer.type) ?? 'The animation does not fit this layer.'), true);
    else {
      notify(resultNotice(`Applied '${p.name}'`, r));
      const s = useEditor.getState();
      s.setTime(layerSpan(layer, s.doc.comp)[0]);
      s.setPlaying(true);
    }
  };

  const commitRename = () => {
    const r = renaming;
    setRenaming(null);
    if (r && r.text.trim()) void guard(() => renamePreset(r.id, r.text));
  };

  const exportAll = () => {
    if (!presets?.length) return;
    downloadBlob(new Blob([presetFileJson(presets)], { type: 'application/json' }), 'glyphix-presets.json');
  };

  const importFile = (file: File) =>
    guard(async () => {
      const list = parsePresetText(await file.text());
      const stored = await importPresets(list);
      notify(stored.length ? `Imported ${plural(stored.length, 'animation')}` : 'That file has no animations.');
    });

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-1.5">
        <div className="min-w-0 flex-1">
          <Field label="Preset name">
            <input className={inputClass} value={name} placeholder="Animation name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && canSave && void save()} />
          </Field>
        </div>
        <Button disabled={!canSave} onClick={() => void save()} title={canSave ? undefined : 'This layer has no animation to save'}>
          Save…
        </Button>
      </div>
      {!canSave && <p className="text-xs text-dim">Add keyframes or an enter, exit or loop animation to this layer, then save it here.</p>}

      <ul aria-label="Saved animations" className="space-y-1.5">
        {presets?.map((p) => {
          const why = misfitReason(p, layer.type);
          return (
            <li key={p.id} className="flex items-center gap-1 rounded-md bg-panel-2 px-1.5 py-1 ring-1 ring-line">
              {renaming?.id === p.id ? (
                <>
                  <input
                    autoFocus
                    aria-label={`New name for ${p.name}`}
                    className={`${inputClass} min-w-0 flex-1`}
                    value={renaming.text}
                    onChange={(e) => setRenaming({ id: p.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                  <IconButton label={`Save name for ${p.name}`} onClick={commitRename}>
                    <Check size={14} />
                  </IconButton>
                  <IconButton label="Cancel rename" onClick={() => setRenaming(null)}>
                    <X size={14} />
                  </IconButton>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={!!why}
                    className="min-w-0 flex-1 rounded px-1.5 py-1 text-left outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
                    onPointerEnter={() => !why && previewPreset(layer, p)}
                    onPointerLeave={endPreview}
                    onFocus={() => !why && previewPreset(layer, p)}
                    onBlur={endPreview}
                    onClick={() => apply(p)}
                  >
                    <span className="block truncate text-xs text-zinc-100">
                      <span className="sr-only">Apply </span>
                      {p.name}
                    </span>
                    <span className="block truncate text-[11px] text-dim">{why ?? `${size(p)} · ${p.duration.toFixed(1)}s`}</span>
                  </button>
                  <IconButton label={`Rename ${p.name}`} onClick={() => setRenaming({ id: p.id, text: p.name })}>
                    <Pencil size={14} />
                  </IconButton>
                  <IconButton label={`Delete ${p.name}`} onClick={() => void guard(() => deletePreset(p.id))}>
                    <Trash2 size={14} />
                  </IconButton>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {presets && !presets.length && <p className="text-xs text-dim">No saved animations yet.</p>}

      <div className="flex gap-1.5">
        <Button className="flex-1" onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> Import…
        </Button>
        <Button className="flex-1" disabled={!presets?.length} onClick={exportAll}>
          <Download size={14} /> Export…
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          aria-label="Import animations file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importFile(f);
          }}
        />
      </div>
    </div>
  );
}
