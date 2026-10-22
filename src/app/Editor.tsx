import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Blend, ImagePlus, Check, CloudOff, FolderOpen, Download, Maximize, Minus, Plus, Redo2, Type, Undo2 } from 'lucide-react';
import { flushSave, useSaveStatus } from '@/persistence/autosave';
import { openProjectFile, saveProjectFile } from '@/persistence/actions';
import { PROJECT_EXTENSION } from '@/persistence/projectFile';
import { ProjectsDialog, useOpenFilePicker } from './ProjectsDialog';
import { ExportDialog } from './ExportDialog';
import { useEditor } from './store';
import { Viewport } from './Viewport';
import { LayersPanel } from './LayersPanel';
import { Inspector } from './Inspector';
import { Timeline } from './timeline/Timeline';
import { Button, IconButton } from './ui';
import { Switch } from '@/components/wensity/switch';
import { isPlaced, layerSpan, offsetProp } from '@/doc';
import { BAR_LABELS, dragPatches } from './timeline/barDrag';
import { copySelectedKeys, deleteSelectedKeys, jumpToKey, nudgeSelectedKeys, pasteKeysAtPlayhead, useKeySelection } from './timeline/keySelection';
import { isMediaFile, MEDIA_ACCEPT, placeMedia } from './media';
import { copyAnimation, pasteAnimation, useAnimState } from './animActions';
import { Overlay, startTextEdit } from '@/editor/Overlay';
import { useView } from '@/editor/viewStore';
import { layerIndex, previewDoc } from './store';

// Subscriptions are kept as low in the tree as possible: during a drag only <Stage> (canvas +
// overlay) re-renders; panels subscribe to the narrow slices they display.
export function Editor({ initialWarning = null }: { initialWarning?: string | null }) {
  const [backend, setBackend] = useState<string>('…');
  const [error, setError] = useState<string | null>(initialWarning);
  usePlaybackClock();
  useShortcuts();
  usePasteImage(setError);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const pickFile = useOpenFilePicker(setError);
  useProjectShortcuts(pickFile, setError, () => setExportOpen(true));

  return (
    <div className="grid h-full grid-rows-[48px_minmax(0,1fr)_auto] bg-app text-sm">
      <Toolbar backend={backend} onProjects={() => setProjectsOpen(true)} onExport={() => setExportOpen(true)} onError={setError} />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <ProjectsDialog open={projectsOpen} onOpenChange={setProjectsOpen} onError={setError} pickFile={pickFile} />
      <div className="grid min-h-0 grid-cols-[220px_1fr_288px]">
        <LayersPanel />
        <main className="relative min-h-0 min-w-0 bg-[radial-gradient(circle_at_center,#16161f_0,#0b0b0f_70%)]">
          <Stage onBackend={setBackend} onError={setError} />
          <ZoomControls />
          {error && (
            <div role="alert" className="absolute top-3 left-1/2 -translate-x-1/2 rounded-md bg-red-500/15 px-3 py-2 text-xs text-red-200 ring-1 ring-red-500/40">
              {error}
            </div>
          )}
          <NoticeBanner />
          <p className="pointer-events-none absolute bottom-2 left-3 text-xs text-dim">Paste or drop an image or video · double-click text to edit, image to crop</p>
        </main>
        <Inspector />
      </div>
      <Timeline />
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Short messages from animation actions ("Applied 'X' — 2 properties skipped"). */
function NoticeBanner() {
  const notice = useAnimState((s) => s.notice);
  if (!notice) return null;
  return (
    <div role={notice.error ? 'alert' : 'status'} className={`absolute bottom-8 left-1/2 -translate-x-1/2 rounded-md px-3 py-2 text-xs ring-1 ${notice.error ? 'bg-red-500/15 text-red-200 ring-red-500/40' : 'bg-panel-2 text-zinc-100 ring-line'}`}>
      {notice.text}
    </div>
  );
}

function Stage({ onBackend, onError }: { onBackend: (kind: string) => void; onError: (msg: string | null) => void }) {
  const realDoc = useEditor((s) => s.doc);
  const preview = useEditor((s) => s.preview);
  const doc = useMemo(() => previewDoc(realDoc, preview), [realDoc, preview]);
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const forceWebGL = useEditor((s) => s.forceWebGL);
  const view = useView((s) => s.view);
  const setHost = useView((s) => s.setHost);
  const setComp = useView((s) => s.setComp);
  useEffect(() => setComp(doc.comp.width, doc.comp.height), [doc.comp.width, doc.comp.height, setComp]);
  const lastKind = useRef('');
  return (
    <Viewport
      doc={doc}
      time={time}
      playing={playing}
      forceWebGL={forceWebGL}
      view={view}
      onHostResize={setHost}
      onStats={(s) => {
        if (s.backend !== lastKind.current) onBackend((lastKind.current = s.backend));
      }}
      onError={onError}
    >
      <Overlay />
    </Viewport>
  );
}

function ProjectTitle() {
  const name = useEditor((s) => s.doc.name);
  const save = useSaveStatus();
  const label =
    save.state === 'saving' ? 'Saving…' : save.state === 'error' ? 'Not saved' : save.state === 'saved' ? 'Saved' : '';
  return (
    <div className="flex min-w-0 items-center gap-2">
      <input
        aria-label="Project name"
        className="w-44 min-w-0 truncate rounded-md bg-transparent px-2 py-1 text-sm text-zinc-200 outline-none hover:bg-white/5 focus:bg-panel-2 focus:ring-1 focus:ring-accent"
        value={name}
        onChange={(e) => useEditor.getState().set('Rename project', [{ path: ['name'], value: e.target.value }], 'project-name')}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span
        role="status"
        title={save.error ?? undefined}
        className={`flex items-center gap-1 text-xs ${save.state === 'error' ? 'text-red-300' : 'text-dim'}`}
      >
        {save.state === 'error' ? <CloudOff size={13} /> : save.state === 'saved' ? <Check size={13} /> : null}
        {label}
      </span>
    </div>
  );
}

function Toolbar({ backend, onProjects, onExport, onError }: { backend: string; onProjects: () => void; onExport: () => void; onError: (msg: string | null) => void }) {
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const forceWebGL = useEditor((s) => s.forceWebGL);
  const { undo, redo, setForceWebGL } = useEditor.getState();
  return (
    <header className="flex items-center gap-2 border-b border-line bg-panel px-3">
      <span className="mr-3 text-[15px] font-semibold tracking-tight">
        Glyph<span className="text-violet-400">ix</span>
      </span>
      <IconButton label="Projects" onClick={onProjects}>
        <FolderOpen size={16} />
      </IconButton>
      <ProjectTitle />
      <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
        <Undo2 size={16} />
      </IconButton>
      <IconButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
        <Redo2 size={16} />
      </IconButton>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <IconButton label="Add text" shortcut="T" onClick={() => useEditor.getState().addText()}>
        <Type size={16} />
      </IconButton>
      <AddMediaButton onError={onError} />
      <IconButton label="Add adjustment layer" onClick={() => useEditor.getState().addAdjustment()}>
        <Blend size={16} />
      </IconButton>

      <div className="ml-auto flex items-center gap-2">
        <div className="flex items-center gap-2 rounded-md px-2 py-1 ring-1 ring-line">
          <Switch
            switchSize="sm"
            checked={forceWebGL}
            onCheckedChange={(checked) => setForceWebGL(checked)}
            label="Force WebGL2"
            labelClassName="text-xs text-dim"
          />
          <span className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300 uppercase">{backend}</span>
        </div>
        <a href="#/bench" className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-dim hover:text-white">
          <Activity size={14} /> Bench
        </a>
        <Button variant="primary" onClick={onExport}>
          <Download size={14} /> Export
        </Button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------

function usePlaybackClock() {
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const s = useEditor.getState();
      if (s.playing && last) {
        const dur = s.doc.comp.duration;
        let t = s.time + (now - last) / 1000;
        if (t >= dur) t = s.loop ? t % dur : dur;
        s.setTime(t);
        if (!s.loop && t >= dur) s.setPlaying(false);
      }
      last = now;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      const typing =
        target instanceof Element && target.closest('input, textarea, select, [contenteditable]') && !(target instanceof HTMLInputElement && target.type === 'range');
      if (typing) return;
      // Inside a panel that handles its own keys (the easing editor), only Ctrl/Cmd shortcuts are global: arrows,
      // Delete and Space must not reach the selected keys or layer.
      if (target instanceof Element && target.closest('[data-own-keys]') && !(e.metaKey || e.ctrlKey)) return;
      const s = useEditor.getState();
      const v = useView.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const sel = s.doc.comp.layers.find((l) => l.id === s.selectedId);
      const handled = () => e.preventDefault();

      // Selected keyframes take Delete, arrows, Ctrl+C and Escape before the layer does.
      const ks = useKeySelection.getState();
      const hasKeys = ks.layerId !== null && ks.keys.size > 0;
      if (hasKeys && e.key === 'Escape') return ks.clear();
      if (hasKeys && (e.key === 'Delete' || e.key === 'Backspace')) return handled(), deleteSelectedKeys();
      if (hasKeys && !mod && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return handled(), nudgeSelectedKeys((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
      if (hasKeys && mod && !e.altKey && key === 'c') return handled(), copySelectedKeys();
      if (hasKeys && !mod && !e.altKey && key === 'e') {
        // Opens the easing editor of the selected keys (timeline header, or the inspector when collapsed).
        const open = document.querySelector<HTMLButtonElement>('[data-key-easing] button:not(:disabled)');
        if (open) return handled(), open.click();
      }
      // Ctrl+Alt+C / V: copy / paste the whole animation of the selected layer (checked first: Alt changes e.key on macOS).
      if (mod && e.altKey && (e.code === 'KeyC' || e.code === 'KeyV')) return handled(), e.code === 'KeyC' ? copyAnimation() : pasteAnimation();
      if (mod && key === 'v' && ks.clipboard && pasteKeysAtPlayhead()) return handled();
      if (!mod && !e.altKey && (key === 'j' || key === 'k')) return handled(), jumpToKey(key === 'j' ? -1 : 1);

      if (mod && key === 'z') return handled(), e.shiftKey ? s.redo() : s.undo();
      if (mod && key === 'y') return handled(), s.redo();
      if (mod && key === '0') return handled(), v.fit();
      if (mod && key === '1') return handled(), v.zoomTo(1);
      if (mod && (key === '=' || key === '+')) return handled(), v.zoomAt(1.25, v.host.width / 2, v.host.height / 2);
      if (mod && key === '-') return handled(), v.zoomAt(0.8, v.host.width / 2, v.host.height / 2);
      if (e.key === ' ') return handled(), s.setPlaying(!s.playing);
      if (e.key === 'Home') return s.setTime(0);
      if (e.key === 'Escape') return s.cropId ? s.setCrop(null) : s.select(null);
      if (!mod && !e.altKey && key === 't') return handled(), s.addText();
      if (!sel || sel.locked) return;
      if (mod && key === 'd') return handled(), s.duplicateLayer(sel.id);
      if (mod && e.key === ']') return handled(), s.moveLayer(sel.id, e.shiftKey ? 999 : 1);
      if (mod && e.key === '[') return handled(), s.moveLayer(sel.id, e.shiftKey ? -999 : -1);
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.type !== 'background') return handled(), s.removeLayer(sel.id);
      // Alt+[ / Alt+]: trim the selected layer's in / out point to the playhead (e.code: Alt changes e.key on macOS).
      if (e.altKey && !mod && (e.code === 'BracketLeft' || e.code === 'BracketRight') && sel.type !== 'background') {
        handled();
        const part = e.code === 'BracketLeft' ? 'in' : 'out';
        const [a, b] = layerSpan(sel, s.doc.comp);
        const { fps, duration } = s.doc.comp;
        const patches = dragPatches(part, sel, s.time - (part === 'in' ? a : b), { fps, duration, pps: 1, targets: [] });
        const i = layerIndex(s.doc, sel.id);
        return s.set(BAR_LABELS[part], patches.map((p) => ({ path: ['comp', 'layers', i, ...p.path], value: p.value })));
      }
      if (e.key === 'Enter' && sel.type === 'text') return handled(), startTextEdit(sel);
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const dir = arrows[e.key];
      if (dir && isPlaced(sel)) {
        handled();
        const step = e.shiftKey ? 10 : 1;
        const i = layerIndex(s.doc, sel.id);
        s.set(
          'Nudge',
          [
            { path: ['comp', 'layers', i, 'transform', 'x'], value: offsetProp(sel.transform.x, dir[0] * step) },
            { path: ['comp', 'layers', i, 'transform', 'y'], value: offsetProp(sel.transform.y, dir[1] * step) },
          ],
          `nudge:${sel.id}`,
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function useProjectShortcuts(pickFile: () => void, onError: (msg: string | null) => void, openExport: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'o') {
        e.preventDefault();
        pickFile();
      } else if (key === 'e') {
        e.preventDefault();
        openExport();
      } else if (key === 's') {
        e.preventDefault(); // never the browser's "save page"
        const done = e.shiftKey ? saveProjectFile() : flushSave();
        done.catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickFile, onError, openExport]);
}

/** File picker for images and videos (the keyboard-friendly alternative to paste / drop). */
function AddMediaButton({ onError }: { onError: (msg: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton label="Add image or video" onClick={() => input.current?.click()}>
        <ImagePlus size={16} />
      </IconButton>
      <input
        ref={input}
        type="file"
        accept={MEDIA_ACCEPT}
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) placeMedia(file).then(() => onError(null), (err: unknown) => onError(err instanceof Error ? err.message : String(err)));
        }}
      />
    </>
  );
}

function ZoomControls() {
  const zoom = useView((s) => s.view.zoom);
  const { fit, zoomAt, host } = useView.getState();
  return (
    <div className="absolute right-3 bottom-2 flex items-center gap-1 rounded-md bg-panel/90 px-1 py-0.5 ring-1 ring-line">
      <IconButton label="Zoom out (Ctrl+-)" onClick={() => zoomAt(0.8, host.width / 2, host.height / 2)}>
        <Minus size={14} />
      </IconButton>
      <button type="button" className="w-12 text-center font-mono text-xs text-zinc-300 tabular-nums" title="Fit (Ctrl+0)" onClick={fit}>
        {Math.round(zoom * 100)}%
      </button>
      <IconButton label="Zoom in (Ctrl+=)" onClick={() => zoomAt(1.25, host.width / 2, host.height / 2)}>
        <Plus size={14} />
      </IconButton>
      <IconButton label="Fit to screen (Ctrl+0)" onClick={fit}>
        <Maximize size={14} />
      </IconButton>
    </div>
  );
}

function usePasteImage(onError: (msg: string | null) => void) {
  const place = useCallback(
    async (file: File) => {
      try {
        await placeMedia(file);
        onError(null);
      } catch (e) {
        onError(e instanceof Error ? e.message : `Could not read that file: ${String(e)}`);
      }
    },
    [onError],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find(isMediaFile);
      if (file) {
        e.preventDefault();
        void place(file);
      }
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      const project = files.find((f) => f.name.toLowerCase().endsWith(PROJECT_EXTENSION));
      if (project) {
        e.preventDefault();
        openProjectFile(project).then(
          () => onError(null),
          (err: unknown) => onError(err instanceof Error ? err.message : String(err)),
        );
        return;
      }
      const file = files.find(isMediaFile);
      if (file) {
        e.preventDefault();
        void place(file);
      }
    };
    window.addEventListener('paste', onPaste);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [place]);
}
