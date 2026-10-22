// An expanded layer's property rows: every animatable property, its keys as diamonds. Click selects (Shift
// toggles), drag moves the selection (frame snapping; within 6 px also the playhead, the layer's in/out and other
// keys — Alt: frames only), drag in an empty row draws a selection box, double-click jumps the playhead to a key.
import { animatableProps, easingPreset, layerSpan, propAt, snapToFrame, type Easing, type Layer } from '@/doc';
import { layerIndex, useEditor } from '../store';
import { addKeyAtPlayhead, keyName, moveSelectedPatches, shiftSelection, useKeySelection } from './keySelection';
import { NAME_W, PROP_H } from './view';

const SNAP_PX = 6;

const easingLabel = (e: Easing) => easingPreset(e)?.label ?? 'custom easing';

function startKeyDrag(e: React.PointerEvent<HTMLElement>, layer: Layer, propId: string, frame: number, pps: number) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const s = useEditor.getState();
  const ks = useKeySelection.getState();
  const name = keyName(propId, frame);
  if (s.selectedId !== layer.id) s.select(layer.id);
  if (e.shiftKey) return ks.toggle(layer.id, name);
  if (ks.layerId !== layer.id || !ks.keys.has(name)) ks.setKeys(layer.id, [name]);
  if (layer.locked) return;

  const keys = [...useKeySelection.getState().keys];
  const { fps } = s.doc.comp;
  const i = layerIndex(s.doc, layer.id);
  const t = frame / fps;
  const selected = new Set(keys);
  const earliest = Math.min(...keys.map((n) => Number(n.slice(n.lastIndexOf('|') + 1)))) / fps;
  // Snap targets for the grabbed key: playhead, in/out, keys that are not moving.
  const targets = [s.time, ...layerSpan(layer, s.doc.comp)];
  for (const p of animatableProps(layer)) {
    const prop = propAt(layer, p.path);
    if (prop && 'track' in prop) for (const k of prop.track.keys) if (!selected.has(keyName(p.id, Math.round(k.t * fps)))) targets.push(k.t);
  }
  const x0 = e.clientX;
  let frames = 0;
  s.beginGesture();
  const move = (ev: PointerEvent) => {
    const want = t + (ev.clientX - x0) / pps;
    const near = ev.altKey ? undefined : targets.filter((x) => Math.abs(x - want) * pps <= SNAP_PX).sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0];
    const f = Math.round(Math.max(-earliest, snapToFrame(near ?? want, fps) - t) * fps);
    if (f === frames) return;
    frames = f;
    useEditor.getState().set('Move keyframes', moveSelectedPatches(layer, keys, f / fps, fps).map((p) => ({ path: ['comp', 'layers', i, ...p.path], value: p.value })));
  };
  // On window: the diamond is re-created as its key moves to another frame.
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    useEditor.getState().endGesture();
    if (frames) shiftSelection(layer.id, keys, frames);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

/** Rubber-band selection over this layer's keys (a fixed-position box; keys are found by their DOM position). */
function startBoxSelect(e: React.PointerEvent<HTMLElement>, layerId: string) {
  if (e.button !== 0 || e.target !== e.currentTarget) return;
  e.preventDefault();
  const scroller = e.currentTarget.closest<HTMLElement>('[data-timeline-scroller]');
  const x0 = e.clientX;
  const y0 = e.clientY;
  const add = e.shiftKey;
  const before = add && useKeySelection.getState().layerId === layerId ? [...useKeySelection.getState().keys] : [];
  if (useEditor.getState().selectedId !== layerId) useEditor.getState().select(layerId);
  const box = document.createElement('div');
  box.className = 'pointer-events-none fixed z-50 rounded-sm bg-accent/15 ring-1 ring-accent';
  document.body.append(box);
  const rect = (ev: PointerEvent) => ({ l: Math.min(x0, ev.clientX), t: Math.min(y0, ev.clientY), r: Math.max(x0, ev.clientX), b: Math.max(y0, ev.clientY) });
  const move = (ev: PointerEvent) => {
    const r = rect(ev);
    Object.assign(box.style, { left: `${r.l}px`, top: `${r.t}px`, width: `${r.r - r.l}px`, height: `${r.b - r.t}px` });
  };
  const end = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    box.remove();
    const r = rect(ev);
    const hit = [...(scroller ?? document).querySelectorAll<HTMLElement>(`[data-key][data-layer="${CSS.escape(layerId)}"]`)].filter((k) => {
      const b = k.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      return cx >= r.l && cx <= r.r && cy >= r.t && cy <= r.b;
    });
    useKeySelection.getState().setKeys(layerId, [...before, ...hit.map((k) => k.dataset.key!)]);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
}

export function PropRows({ layer, pps }: { layer: Layer; pps: number }) {
  const fps = useEditor((s) => s.doc.comp.fps);
  const selected = useKeySelection((s) => (s.layerId === layer.id ? s.keys : null));
  return (
    <ul aria-label={`${layer.name} properties`}>
      {animatableProps(layer).map((p) => {
        const prop = propAt(layer, p.path);
        const keys = prop && 'track' in prop ? prop.track.keys : [];
        const label = p.group === 'Layer' || p.group === 'Transform' ? p.label : `${p.group} · ${p.label}`;
        return (
          <li key={p.id} aria-label={label} className="flex border-b border-line/30" style={{ height: PROP_H }}>
            <div className="sticky left-0 z-30 flex shrink-0 items-center gap-1 border-r border-line bg-panel pr-1 pl-7" style={{ width: NAME_W }}>
              <span className={`min-w-0 flex-1 truncate text-[11px] ${keys.length ? 'text-zinc-300' : 'text-dim'}`}>{label}</span>
              <button
                type="button"
                aria-label={`Add ${label} keyframe at playhead`}
                disabled={layer.locked}
                className="w-4 rounded text-sm leading-none text-dim hover:text-white disabled:opacity-30"
                onClick={() => addKeyAtPlayhead(layer.id, p.id)}
              >
                {/* Text, not an icon: see .key-diamond in index.css. */}+
              </button>
            </div>
            <div className={`relative ml-2 flex-1 ${keys.length ? '' : 'opacity-60'}`} onPointerDown={(e) => startBoxSelect(e, layer.id)}>
              {keys.map((k) => {
                const frame = Math.round(k.t * fps);
                const name = keyName(p.id, frame);
                const on = !!selected?.has(name);
                return (
                  <button
                    key={frame}
                    type="button"
                    data-key={name}
                    data-layer={layer.id}
                    data-ease={k.out.kind === 'linear' || k.out.kind === 'hold' ? k.out.kind : undefined}
                    aria-label={`${label} keyframe at ${k.t.toFixed(2)} s, ${easingLabel(k.out)}${on ? ', selected' : ''}`}
                    aria-pressed={on}
                    className="key-diamond absolute size-3.5 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-white"
                    style={{ left: k.t * pps - 7, top: (PROP_H - 14) / 2 }}
                    onPointerDown={(e) => startKeyDrag(e, layer, p.id, frame, pps)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      e.stopPropagation();
                      const ks = useKeySelection.getState();
                      if (e.shiftKey) ks.toggle(layer.id, name);
                      else ks.setKeys(layer.id, [name]);
                    }}
                    onDoubleClick={() => {
                      useEditor.getState().setPlaying(false);
                      useEditor.getState().setTime(k.t);
                    }}
                  />
                );
              })}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
