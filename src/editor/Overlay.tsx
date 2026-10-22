import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { isPlaced, restTime, offsetProp, sampleProp, sampleValue, scaleProp, setValueAt, snapToFrame, type Doc, type ImageLayer, type Layer, type Patch, type TextLayer } from '@/doc';
import { fontLibrary } from '@/text/fontLibrary';
import { layerIndex, useEditor } from '@/app/store';
import { toComp, toScreen, useView } from './viewStore';
import {
  aabb,
  corners,
  cropFromEdge,
  hitTest,
  layerBox,
  rotate,
  rotationToward,
  scaleFromCorner,
  snapMove,
  snapTargets,
  type Corner,
  type Edge,
  type MeasureText,
  type OBox,
  type Vec,
} from './geometry';
import { frameBarHeight } from '@/styling/frames';

export const measureText: MeasureText = (l, t) => {
  const layout = fontLibrary.layout({ ...l, text: sampleValue(l.text, t) });
  return layout ? { width: layout.width * l.fontSize, height: layout.height * l.fontSize } : null;
};

const SNAP_PX = 6;
const HANDLE = 9;

type Drag =
  | { kind: 'move'; index: number; layer: Layer; startBox: OBox; startPtr: Vec }
  | { kind: 'scale'; index: number; layer: Layer; startBox: OBox; corner: Corner }
  | { kind: 'rotate'; index: number; layer: Layer; startBox: OBox }
  | { kind: 'crop'; index: number; layer: ImageLayer; startBox: OBox; edge: Edge }
  | { kind: 'pan'; last: Vec };

const transformOf = (l: Layer) => (isPlaced(l) ? l.transform : null);

/** Interaction layer over the canvas. Everything is computed on the CPU from the document. */
export function Overlay() {
  const doc = useEditor((s) => s.doc);
  const time = useEditor((s) => s.time);
  const selectedId = useEditor((s) => s.selectedId);
  const cropId = useEditor((s) => s.cropId);
  const editingTextId = useEditor((s) => s.editingTextId);
  const view = useView((s) => s.view);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [guides, setGuides] = useState<{ xs: number[]; ys: number[] }>({ xs: [], ys: [] });
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Re-measure text once fonts arrive.
  const [, setFontTick] = useState(0);
  useEffect(() => fontLibrary.onChange(() => setFontTick((n) => n + 1)), []);

  const boxOf = (l: Layer) => layerBox(l, time, measureText, frameBarHeight);
  const selected = doc.comp.layers.find((l) => l.id === selectedId) ?? null;
  const selBox = selected ? boxOf(selected) : null;
  const hover = hoverId && hoverId !== selectedId ? doc.comp.layers.find((l) => l.id === hoverId) : null;
  const hoverBox = hover ? boxOf(hover) : null;

  const local = (e: { clientX: number; clientY: number }): Vec => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const compPt = (e: { clientX: number; clientY: number }) => {
    const p = local(e);
    return toComp(useView.getState().view, p.x, p.y);
  };

  // Wheel: ctrl/⌘ (and trackpad pinch) zooms at the cursor, otherwise pans. Needs a non-passive listener.
  useEffect(() => {
    const el = ref.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const v = useView.getState();
      // Clamp per event: mouse wheels send ~100 per notch, trackpad pinches send small deltas.
      if (e.ctrlKey || e.metaKey) v.zoomAt(Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01), p.x, p.y);
      else v.panBy(-e.deltaX, -e.deltaY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const begin = (d: Drag, e: RPointerEvent) => {
    drag.current = d;
    ref.current!.setPointerCapture(e.pointerId);
    if (d.kind !== 'pan') {
      useEditor.getState().setPlaying(false);
      useEditor.getState().beginGesture();
    }
  };

  const onPointerDown = (e: RPointerEvent) => {
    if (editingTextId) return;
    if (e.button === 1 || (e.button === 0 && e.altKey && e.shiftKey)) {
      begin({ kind: 'pan', last: local(e) }, e);
      return;
    }
    if (e.button !== 0) return;
    const s = useEditor.getState();
    const handle = (e.target as Element).closest<HTMLElement | SVGElement>('[data-handle]')?.dataset.handle;
    if (handle && selected && selBox) {
      const index = layerIndex(s.doc, selected.id);
      if (handle === 'rotate') return begin({ kind: 'rotate', index, layer: selected, startBox: selBox }, e);
      if (handle.startsWith('crop-') && selected.type === 'image')
        return begin({ kind: 'crop', index, layer: selected, startBox: selBox, edge: handle.slice(5) as Edge }, e);
      return begin({ kind: 'scale', index, layer: selected, startBox: selBox, corner: handle as Corner }, e);
    }
    const p = compPt(e);
    const hit = hitTest(s.doc, p, s.time, measureText, frameBarHeight);
    if (s.cropId && hit?.id !== s.cropId) s.setCrop(null);
    if (!hit) {
      s.select(null);
      return;
    }
    if (hit.id !== s.selectedId) s.select(hit.id);
    const box = boxOf(hit);
    if (box) begin({ kind: 'move', index: layerIndex(s.doc, hit.id), layer: hit, startBox: box, startPtr: p }, e);
  };

  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current;
    // The button was released somewhere we didn't hear about (outside the window, lost capture):
    // finish the gesture instead of letting the next hover keep dragging.
    if (d && e.buttons === 0) {
      finishDrag();
      return;
    }
    if (!d) {
      if (e.buttons === 0 && !editingTextId) {
        const s = useEditor.getState();
        setHoverId(hitTest(s.doc, compPt(e), s.time, measureText, frameBarHeight)?.id ?? null);
      }
      return;
    }
    if (d.kind === 'pan') {
      const p = local(e);
      useView.getState().panBy(p.x - d.last.x, p.y - d.last.y);
      d.last = p;
      return;
    }
    const s = useEditor.getState();
    const p = compPt(e);
    const tr = transformOf(d.layer);
    if (!tr) return;
    const base = ['comp', 'layers', d.index];
    const patches: Patch[] = [];
    const zoom = useView.getState().view.zoom;

    if (d.kind === 'move') {
      let dx = p.x - d.startPtr.x;
      let dy = p.y - d.startPtr.y;
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0); // axis lock
      if (!e.altKey) {
        const moved = aabb({ ...d.startBox, cx: d.startBox.cx + dx, cy: d.startBox.cy + dy });
        const snap = snapMove(moved, snapTargets(s.doc, d.layer.id, s.time, measureText, frameBarHeight), SNAP_PX / zoom);
        dx += snap.dx;
        dy += snap.dy;
        setGuides({ xs: snap.guidesX, ys: snap.guidesY });
      } else setGuides({ xs: [], ys: [] });
      // Round to 1/1000 px so snapped positions are exact (no 960.0000000000001 in the document).
      dx = Math.round(dx * 1000) / 1000;
      dy = Math.round(dy * 1000) / 1000;
      patches.push({ path: [...base, 'transform', 'x'], value: offsetProp(tr.x, dx) }, { path: [...base, 'transform', 'y'], value: offsetProp(tr.y, dy) });
    } else if (d.kind === 'scale') {
      const r = scaleFromCorner(d.startBox, d.corner, p);
      patches.push(
        { path: [...base, 'transform', 'scale'], value: scaleProp(tr.scale, r.factor) },
        { path: [...base, 'transform', 'x'], value: offsetProp(tr.x, r.cx - d.startBox.cx) },
        { path: [...base, 'transform', 'y'], value: offsetProp(tr.y, r.cy - d.startBox.cy) },
      );
    } else if (d.kind === 'rotate') {
      const deg = rotationToward(d.startBox, p, e.shiftKey ? 15 : 0);
      patches.push({ path: [...base, 'transform', 'rotation'], value: offsetProp(tr.rotation, deg - d.startBox.rotation) });
    } else if (d.kind === 'crop') {
      const l = d.layer;
      const scale = sampleProp(l.transform.scale, s.time);
      const r = cropFromEdge({ crop: l.crop, width: l.width, height: l.height, box: imageBox(d.startBox, l, scale), scale }, d.edge, p);
      patches.push(
        { path: [...base, 'crop'], value: r.crop },
        { path: [...base, 'width'], value: r.width },
        { path: [...base, 'height'], value: r.height },
        { path: [...base, 'transform', 'x'], value: offsetProp(tr.x, r.cx - d.startBox.cx) },
        { path: [...base, 'transform', 'y'], value: offsetProp(tr.y, r.cy - d.startBox.cy) },
      );
    }
    s.set(labelFor(d.kind), patches);
  };

  const finishDrag = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.kind !== 'pan') useEditor.getState().endGesture();
    setGuides({ xs: [], ys: [] });
  };

  const onPointerUp = (e: RPointerEvent) => {
    if (!drag.current) return;
    if (ref.current!.hasPointerCapture(e.pointerId)) ref.current!.releasePointerCapture(e.pointerId);
    finishDrag();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const s = useEditor.getState();
    const hit = hitTest(s.doc, compPt(e), s.time, measureText, frameBarHeight);
    if (hit?.type === 'text') startTextEdit(hit);
    else if (hit?.type === 'image') s.setCrop(s.cropId === hit.id ? null : hit.id);
  };

  const cursor = drag.current?.kind === 'pan' ? 'grabbing' : hoverId ? 'move' : 'default';

  return (
    <div
      ref={ref}
      className="absolute inset-0 touch-none select-none"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={finishDrag}
      onPointerLeave={() => setHoverId(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        {guides.xs.map((x) => {
          const sx = toScreen(view, x, 0).x;
          return <line key={`gx${x}`} x1={sx} x2={sx} y1={0} y2="100%" stroke="#f472b6" strokeWidth={1} />;
        })}
        {guides.ys.map((y) => {
          const sy = toScreen(view, 0, y).y;
          return <line key={`gy${y}`} y1={sy} y2={sy} x1={0} x2="100%" stroke="#f472b6" strokeWidth={1} />;
        })}
        {hoverBox && <polygon points={pts(view, corners(hoverBox))} fill="none" stroke="#a78bfa" strokeOpacity={0.6} strokeWidth={1} />}
        {selected && selBox && !editingTextId && (
          <Selection view={view} box={selBox} layer={selected} cropping={cropId === selected.id} time={time} />
        )}
      </svg>
      {editingTextId && <TextEditor doc={doc} id={editingTextId} />}
    </div>
  );
}

const labelFor = (k: Drag['kind']) => ({ move: 'Move', scale: 'Scale', rotate: 'Rotate', crop: 'Crop', pan: 'Pan' })[k];

const pts = (view: ReturnType<typeof useView.getState>['view'], c: Vec[]) =>
  c.map((p) => toScreen(view, p.x, p.y)).map((p) => `${p.x},${p.y}`).join(' ');

/** The image part of a layer's box (excluding any frame bar). */
function imageBox(box: OBox, l: ImageLayer, scale: number): OBox {
  const bar = frameBarHeight(l) * scale;
  const shift = rotate({ x: 0, y: bar / 2 }, box.rotation);
  return { ...box, h: box.h - bar, cx: box.cx + shift.x, cy: box.cy + shift.y };
}

function Selection({ view, box, layer, cropping, time }: { view: ReturnType<typeof useView.getState>['view']; box: OBox; layer: Layer; cropping: boolean; time: number }) {
  const c = corners(box);
  const sc = c.map((p) => toScreen(view, p.x, p.y));
  const names: Corner[] = ['nw', 'ne', 'se', 'sw'];
  const up = rotate({ x: 0, y: -1 }, box.rotation);
  const topMid = { x: (sc[0]!.x + sc[1]!.x) / 2, y: (sc[0]!.y + sc[1]!.y) / 2 };
  const rotHandle = { x: topMid.x + up.x * 28, y: topMid.y + up.y * 28 };
  const locked = layer.locked;

  if (cropping && layer.type === 'image') {
    const scale = sampleProp(layer.transform.scale, time);
    const ib = imageBox(box, layer, scale);
    // Ghost of the full source image around the crop.
    const fullW = (layer.width / layer.crop.w) * scale;
    const fullH = (layer.height / layer.crop.h) * scale;
    const offset = rotate(
      { x: (0.5 - (layer.crop.x + layer.crop.w / 2)) * fullW, y: (0.5 - (layer.crop.y + layer.crop.h / 2)) * fullH },
      box.rotation,
    );
    const ghost = corners({ cx: ib.cx + offset.x, cy: ib.cy + offset.y, w: fullW, h: fullH, rotation: box.rotation });
    const ic = corners(ib).map((p) => toScreen(view, p.x, p.y));
    const mids: [Edge, Vec][] = [
      ['n', mid(ic[0]!, ic[1]!)],
      ['e', mid(ic[1]!, ic[2]!)],
      ['s', mid(ic[2]!, ic[3]!)],
      ['w', mid(ic[3]!, ic[0]!)],
    ];
    return (
      <g>
        <polygon points={pts(view, ghost)} fill="none" stroke="#fff" strokeOpacity={0.5} strokeDasharray="4 4" />
        <polygon points={ic.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#facc15" strokeWidth={1.5} />
        {mids.map(([edge, p]) => (
          <rect
            key={edge}
            data-handle={`crop-${edge}`}
            className="pointer-events-auto"
            style={{ cursor: edge === 'n' || edge === 's' ? 'ns-resize' : 'ew-resize' }}
            x={p.x - (edge === 'n' || edge === 's' ? 12 : 3)}
            y={p.y - (edge === 'n' || edge === 's' ? 3 : 12)}
            width={edge === 'n' || edge === 's' ? 24 : 6}
            height={edge === 'n' || edge === 's' ? 6 : 24}
            rx={2}
            fill="#facc15"
          />
        ))}
      </g>
    );
  }

  return (
    <g>
      <polygon points={sc.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#8b5cf6" strokeWidth={1.5} />
      {!locked && (
        <>
          <line x1={topMid.x} y1={topMid.y} x2={rotHandle.x} y2={rotHandle.y} stroke="#8b5cf6" />
          <circle data-handle="rotate" className="pointer-events-auto" style={{ cursor: 'grab' }} cx={rotHandle.x} cy={rotHandle.y} r={5.5} fill="#fff" stroke="#8b5cf6" strokeWidth={1.5} />
          {sc.map((p, i) => (
            <rect
              key={names[i]}
              data-handle={names[i]}
              className="pointer-events-auto"
              style={{ cursor: i % 2 === 0 ? 'nwse-resize' : 'nesw-resize' }}
              x={p.x - HANDLE / 2}
              y={p.y - HANDLE / 2}
              width={HANDLE}
              height={HANDLE}
              rx={2}
              fill="#fff"
              stroke="#8b5cf6"
              strokeWidth={1.5}
            />
          ))}
        </>
      )}
    </g>
  );
}

const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// ---------------------------------------------------------------------------
// Inline text editing: a transparent <textarea> over the GPU-rendered text supplies caret,
// selection and IME; every keystroke updates the document (one undo step per edit session).

export function startTextEdit(layer: TextLayer) {
  const s = useEditor.getState();
  s.select(layer.id);
  s.setPlaying(false);
  // Show the text at rest while editing.
  s.setTime(restTime(layer, s.doc.comp));
  s.setEditingText(layer.id);
}

function TextEditor({ doc, id }: { doc: Doc; id: string }) {
  const layer = doc.comp.layers.find((l) => l.id === id);
  const view = useView((s) => s.view);
  const time = useEditor((s) => s.time);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const s = useEditor.getState();
    s.beginGesture();
    const ta = taRef.current;
    ta?.focus();
    ta?.select();
    return () => useEditor.getState().endGesture();
  }, [id]);

  const box = useMemo(() => (layer?.type === 'text' ? layerBox(layer, time, measureText) : null), [layer, time]);
  if (!layer || layer.type !== 'text' || !box) return null;

  const scale = sampleProp(layer.transform.scale, time);
  const text = sampleValue(layer.text, time);
  const lines = text.split('\n').length;
  const c = toScreen(view, box.cx, box.cy);
  const w = Math.max(box.w, layer.fontSize) * view.zoom + 8;
  const h = box.h * view.zoom;
  const close = () => useEditor.getState().setEditingText(null);

  return (
    <textarea
      ref={taRef}
      aria-label="Edit text"
      value={text}
      spellCheck={false}
      onChange={(e) => {
        // Animated text: edits the key at the playhead.
        const s = useEditor.getState();
        const value = setValueAt(layer.text, snapToFrame(s.time, s.doc.comp.fps), e.target.value, 0.5 / s.doc.comp.fps);
        s.set('Edit text', [{ path: ['comp', 'layers', layerIndex(s.doc, id), 'text'], value }]);
      }}
      onBlur={close}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) close();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute resize-none overflow-hidden border-0 bg-transparent p-0 outline-1 outline-dashed outline-violet-400/70"
      style={{
        left: c.x - w / 2,
        top: c.y - h / 2,
        width: w,
        height: h,
        transform: `rotate(${box.rotation}deg)`,
        fontFamily: 'Inter, sans-serif',
        fontSize: layer.fontSize * scale * view.zoom,
        lineHeight: `${h / lines}px`,
        letterSpacing: `${layer.tracking}em`,
        textAlign: layer.align,
        color: 'transparent',
        caretColor: '#fff',
      }}
    />
  );
}
