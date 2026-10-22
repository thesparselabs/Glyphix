// A layer's bar on the timeline: when it is on screen (drag to move, drag an end to trim), its enter/exit
// presets as strips along the bottom (drag to move, drag the outer end to change the length), its loop as a
// striped line along the top. Each drag is one undo step.
import { isPlaced, layerSpan, type Layer } from '@/doc';
import { layerIndex, useEditor } from '../store';
import { BAR_LABELS, dragPatches, snapTargets, type BarPart } from './barDrag';
import { ROW_H } from './view';

const COLORS: Record<string, string> = {
  text: 'bg-violet-500/35 ring-violet-400/60',
  image: 'bg-sky-500/30 ring-sky-400/60',
  video: 'bg-teal-500/30 ring-teal-400/60',
  adjustment: 'bg-amber-500/25 ring-amber-400/50',
};

function startDrag(e: React.PointerEvent<HTMLElement>, part: BarPart, layer: Layer, pps: number) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const s = useEditor.getState();
  s.select(layer.id);
  if (layer.locked) return;
  const el = e.currentTarget;
  const x0 = e.clientX;
  const i = layerIndex(s.doc, layer.id);
  const { fps, duration } = s.doc.comp;
  const targets = snapTargets(s.doc, layer.id, s.time);
  el.setPointerCapture(e.pointerId);
  s.beginGesture();
  const move = (ev: PointerEvent) => {
    const patches = dragPatches(part, layer, (ev.clientX - x0) / pps, { fps, duration, pps, targets: ev.altKey ? [] : targets });
    if (patches.length) useEditor.getState().set(BAR_LABELS[part], patches.map((p) => ({ path: ['comp', 'layers', i, ...p.path], value: p.value })));
  };
  const end = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    useEditor.getState().endGesture();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/** Move the layer by whole frames from the keyboard (repeated presses coalesce into one undo step). */
function nudge(layer: Layer, frames: number) {
  const s = useEditor.getState();
  const { fps, duration } = s.doc.comp;
  const i = layerIndex(s.doc, layer.id);
  const patches = dragPatches('move', layer, frames / fps, { fps, duration, pps: 1, targets: [] });
  s.set(BAR_LABELS.move, patches.map((p) => ({ path: ['comp', 'layers', i, ...p.path], value: p.value })), `tl-nudge:${layer.id}`);
}

const fmt = (t: number) => `${t.toFixed(2)} s`;

export function LayerBar({ layer, pps, duration }: { layer: Layer; pps: number; duration: number }) {
  if (layer.type === 'background') return <span aria-hidden className="absolute inset-x-0 top-[9px] h-2.5 rounded-sm bg-zinc-500/15" style={{ width: duration * pps }} />;
  const [a, b] = layerSpan(layer, { duration });
  const kind = layer.type === 'image' && layer.video ? 'video' : layer.type;
  const motion = isPlaced(layer) ? layer.motion : null;
  const enter = motion?.enter;
  const exit = motion?.exit;
  const h = ROW_H - 6;
  const handle = (part: BarPart, side: 'left' | 'right') => (
    <span
      aria-hidden
      data-part={part}
      className={`absolute top-0 bottom-0 z-10 w-1.5 cursor-ew-resize hover:bg-white/40 ${side === 'left' ? 'left-0 rounded-l' : 'right-0 rounded-r'}`}
      onPointerDown={(e) => startDrag(e, part, layer, pps)}
    />
  );
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${layer.name}: on screen ${fmt(a)} to ${fmt(b)}`}
      aria-keyshortcuts="ArrowLeft ArrowRight Alt+BracketLeft Alt+BracketRight"
      data-part="move"
      className={`absolute top-[3px] overflow-hidden rounded ring-1 outline-none ring-inset focus-visible:ring-2 focus-visible:ring-white ${COLORS[kind]} ${layer.locked ? 'cursor-not-allowed opacity-60' : 'cursor-grab active:cursor-grabbing'} ${layer.visible ? '' : 'opacity-40'}`}
      style={{ left: a * pps, width: Math.max(2, (b - a) * pps), height: h }}
      onPointerDown={(e) => startDrag(e, 'move', layer, pps)}
      onKeyDown={(e) => {
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !layer.locked) {
          e.preventDefault();
          e.stopPropagation();
          nudge(layer, (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
        }
      }}
    >
      {motion?.loop && <span aria-hidden title={`Loop: ${motion.loop.preset}`} className="absolute inset-x-0 top-0 h-[3px] bg-[repeating-linear-gradient(90deg,rgb(255_255_255/0.55)_0_4px,transparent_4px_8px)]" />}
      <span className="pointer-events-none absolute top-[3px] left-2 truncate text-[10px] leading-none text-white/85" style={{ maxWidth: '90%' }}>
        {layer.name}
      </span>
      {enter && (
        <span
          aria-hidden
          data-part="enter"
          title={`Enter: ${enter.preset}`}
          className="absolute bottom-[2px] h-[7px] cursor-grab rounded-sm bg-emerald-400/80"
          style={{ left: enter.start * pps, width: Math.max(4, enter.duration * pps) }}
          onPointerDown={(e) => startDrag(e, 'enter', layer, pps)}
        >
          <span aria-hidden data-part="enter-length" className="absolute top-0 right-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/60" onPointerDown={(e) => startDrag(e, 'enter-length', layer, pps)} />
        </span>
      )}
      {exit && (
        <span
          aria-hidden
          data-part="exit"
          title={`Exit: ${exit.preset}`}
          className="absolute bottom-[2px] h-[7px] cursor-grab rounded-sm bg-rose-400/80"
          style={{ right: exit.endOffset * pps, width: Math.max(4, exit.duration * pps) }}
          onPointerDown={(e) => startDrag(e, 'exit', layer, pps)}
        >
          <span aria-hidden data-part="exit-length" className="absolute top-0 bottom-0 left-0 w-1.5 cursor-ew-resize hover:bg-white/60" onPointerDown={(e) => startDrag(e, 'exit-length', layer, pps)} />
        </span>
      )}
      {handle('in', 'left')}
      {handle('out', 'right')}
    </div>
  );
}
