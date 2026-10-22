// The timeline dock under the canvas: transport header, time ruler, one row per layer. Only the playhead line
// and timecode follow the clock (store subscriptions writing to the DOM); nothing here re-renders while playing.
import { memo, useEffect, useMemo, useLayoutEffect, useRef, useState } from 'react';
import { Blend, ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, Film, Image, Lock, Maximize2, Pause, Play, Repeat, Square, Type, Unlock, ZoomIn, ZoomOut } from 'lucide-react';
import { useEditor } from '../store';
import { Select } from '@/components/wensity/select';
import { IconButton, inputClass } from '../ui';
import { animatableProps, propAt, type Layer } from '@/doc';
import { keyName, layerKeyTimes, useKeySelection } from './keySelection';
import { KeyEasing } from './KeyEasing';
import { LayerBar } from './LayerBar';
import { PropRows } from './PropRows';
import { Ruler } from './Ruler';
import { END_PAD, fitZoom, HEADER_H, NAME_W, ORIGIN, PROP_H, ROW_H, RULER_H, useTimelineView, zoomLimits } from './view';

export function Timeline() {
  const collapsed = useTimelineView((s) => s.collapsed);
  const height = useTimelineView((s) => s.height);
  return (
    <footer aria-label="Timeline" className="relative flex min-h-0 flex-col border-t border-line bg-panel" style={{ height: collapsed ? HEADER_H : height }}>
      {!collapsed && <ResizeHandle />}
      <Header />
      {!collapsed && <Tracks />}
    </footer>
  );
}

function ResizeHandle() {
  const height = useTimelineView((s) => s.height);
  const { setHeight } = useTimelineView.getState();
  const start = useRef<{ y: number; h: number } | null>(null);
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="Resize timeline"
      aria-valuenow={height}
      className="absolute inset-x-0 -top-1 z-40 h-2 cursor-ns-resize touch-none outline-none hover:bg-accent/40 focus-visible:bg-accent/60"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { y: e.clientY, h: useTimelineView.getState().height };
      }}
      onPointerMove={(e) => start.current && setHeight(start.current.h - (e.clientY - start.current.y))}
      onPointerUp={() => (start.current = null)}
      onKeyDown={(e) => {
        const d = { ArrowUp: 24, ArrowDown: -24 }[e.key];
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        setHeight(height + d);
      }}
    />
  );
}

// ---------------------------------------------------------------------------

function Header() {
  const playing = useEditor((s) => s.playing);
  const duration = useEditor((s) => s.doc.comp.duration);
  const fps = useEditor((s) => s.doc.comp.fps);
  const loop = useEditor((s) => s.loop);
  const collapsed = useTimelineView((s) => s.collapsed);
  const { setPlaying, setTime, setLoop, set } = useEditor.getState();
  const view = useTimelineView.getState();
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-line px-3" style={{ height: HEADER_H }}>
      <IconButton label={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => setPlaying(!playing)} className="h-8 w-8">
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </IconButton>
      <Timecode fps={fps} duration={duration} />
      <IconButton label={loop ? 'Looping playback (on)' : 'Looping playback (off)'} active={loop} onClick={() => setLoop(!loop)}>
        <Repeat size={15} />
      </IconButton>
      <span className="h-5 w-px bg-line" aria-hidden />
      <label className="flex items-center gap-1.5 text-[11px] text-dim">
        Length
        <input
          type="number"
          aria-label="Video length in seconds"
          className={`${inputClass} w-16 py-0.5`}
          min={0.5}
          max={60}
          step={0.5}
          value={duration}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v >= 0.5 && v <= 60) {
              set('Video length', [{ path: ['comp', 'duration'], value: v }], 'comp-duration');
              if (useEditor.getState().time > v) setTime(v);
            }
          }}
        />
        s
      </label>
      <div className="w-24">
        <Select
          aria-label="Frame rate"
          selectSize="sm"
          fullWidth
          value={String(fps)}
          options={[24, 30, 60].map((f) => ({ value: String(f), label: `${f} fps` }))}
          onValueChange={(f) => set('Frame rate', [{ path: ['comp', 'fps'], value: Number(f) }])}
        />
      </div>
      {!collapsed && (
        <div className="w-44">
          <KeyEasing side="top" />
        </div>
      )}
      <div className="ml-auto flex items-center gap-1">
        {!collapsed && (
          <>
            <IconButton label="Zoom out (Ctrl+wheel)" onClick={() => view.setZoom(stepZoom(1 / 1.5))}>
              <ZoomOut size={15} />
            </IconButton>
            <IconButton label="Fit timeline" onClick={() => view.setZoom(null)}>
              <Maximize2 size={14} />
            </IconButton>
            <IconButton label="Zoom in (Ctrl+wheel)" onClick={() => view.setZoom(stepZoom(1.5))}>
              <ZoomIn size={15} />
            </IconButton>
          </>
        )}
        <IconButton label={collapsed ? 'Expand timeline' : 'Collapse timeline'} onClick={() => view.setCollapsed(!collapsed)}>
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </IconButton>
      </div>
    </div>
  );
}

/** Current zoom × factor, within limits (the tracks publish their fit zoom for this). */
let lastFit = 100;
function stepZoom(factor: number) {
  const { zoom } = useTimelineView.getState();
  const [lo, hi] = zoomLimits(lastFit, useEditor.getState().doc.comp.fps);
  return Math.max(lo, Math.min(hi, (zoom ?? lastFit) * factor));
}

function Timecode({ fps, duration }: { fps: number; duration: number }) {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const show = (t: number) => {
      el.current!.textContent = `${t.toFixed(2)}s · frame ${Math.round(t * fps)} / ${Math.round(duration * fps)}`;
    };
    show(useEditor.getState().time);
    return useEditor.subscribe((s, prev) => s.time !== prev.time && show(s.time));
  }, [fps, duration]);
  return <span ref={el} className="w-44 font-mono text-[11px] text-zinc-300 tabular-nums" />;
}

// ---------------------------------------------------------------------------

/** How many property rows a layer can show (cached per layer object: the store selector runs every frame). */
const propCounts = new WeakMap<Layer, number>();
const propCount = (l: Layer) => propCounts.get(l) ?? (propCounts.set(l, animatableProps(l).length), propCounts.get(l)!);
/** Layers this far (px) outside the scroller are still rendered, so a quick scroll never shows blank rows. */
const OVERSCAN = 84;

function Tracks() {
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0, scrollLeft: 0, scrollTop: 0 });
  const duration = useEditor((s) => s.doc.comp.duration);
  const fps = useEditor((s) => s.doc.comp.fps);
  const zoom = useTimelineView((s) => s.zoom);
  // Top of the list = front-most layer, as in the Layers panel. Only layers near the viewport are rendered (a
  // few thousand key buttons make every frame of playback expensive); row heights are fixed, so offsets are sums.
  const spec = useEditor((s) => s.doc.comp.layers.map((l) => `${l.id}\u0002${propCount(l)}`).join('\u0001'));
  const expanded = useTimelineView((s) => s.expanded);
  const { rows, total } = useMemo(() => {
    let top = 0;
    const rows = spec
      .split('\u0001')
      .filter(Boolean)
      .reverse()
      .map((r) => {
        const [id, n] = r.split('\u0002') as [string, string];
        const h = ROW_H + (expanded[id] ? Number(n) * PROP_H : 0);
        top += h;
        return { id, top: top - h, h };
      });
    return { rows, total: top };
  }, [spec, expanded]);
  const y0 = box.scrollTop - RULER_H - OVERSCAN;
  const y1 = box.scrollTop + box.height - RULER_H + OVERSCAN;
  const shown = rows.filter((r) => r.top + r.h > y0 && r.top < y1);
  const first = shown[0];
  const last = shown[shown.length - 1];
  const before = first?.top ?? 0;
  const after = last ? total - last.top - last.h : 0;

  // Off-screen rows are not in the DOM, so bring the selected layer's row into view (the Layers panel reaches every
  // layer by keyboard; from there Tab reaches its bar and keys here).
  const selectedId = useEditor((s) => s.selectedId);
  useEffect(() => {
    const node = scroller.current;
    const row = rows.find((r) => r.id === selectedId);
    if (!node || !row) return;
    if (row.top < node.scrollTop) node.scrollTop = row.top;
    else if (RULER_H + row.top + ROW_H > node.scrollTop + node.clientHeight) node.scrollTop = RULER_H + row.top + ROW_H - node.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the selection changes
  }, [selectedId]);

  const fit = fitZoom(box.width, duration);
  lastFit = fit;
  const [lo, hi] = zoomLimits(fit, fps);
  const pps = zoom === null ? fit : Math.max(lo, Math.min(hi, zoom));

  useLayoutEffect(() => {
    const node = scroller.current!;
    let raf = 0;
    const measure = () =>
      setBox((b) => {
        const next = { width: node.clientWidth, height: node.clientHeight, scrollLeft: node.scrollLeft, scrollTop: node.scrollTop };
        return b.width === next.width && b.height === next.height && b.scrollLeft === next.scrollLeft && b.scrollTop === next.scrollTop ? b : next;
      });
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    node.addEventListener('scroll', onScroll, { passive: true });
    measure();
    return () => {
      ro.disconnect();
      node.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Ctrl/Cmd + wheel zooms around the pointer.
  const anchor = useRef<{ t: number; x: number } | null>(null);
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  useEffect(() => {
    const node = scroller.current!;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const x = e.clientX - node.getBoundingClientRect().left;
      const cur = ppsRef.current;
      anchor.current = { t: (x + node.scrollLeft - ORIGIN) / cur, x };
      const [a, b] = zoomLimits(lastFit, useEditor.getState().doc.comp.fps);
      useTimelineView.getState().setZoom(Math.max(a, Math.min(b, cur * Math.exp(-e.deltaY * 0.002))));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    scroller.current!.scrollLeft = a.t * pps + ORIGIN - a.x;
  }, [pps]);

  return (
    <div className="relative min-h-0 flex-1">
    <div
      ref={scroller}
      role="region"
      aria-label="Timeline tracks"
      data-timeline-scroller
      className="absolute inset-0 overflow-auto overscroll-contain"
      // Its own layout/paint scope: header and playhead updates never re-lay out thousands of rows.
      style={{ contain: 'strict' }}
      tabIndex={-1}
      onKeyDown={(e) => {
        // Ctrl/Cmd+A inside the timeline: every key of the selected layer.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
          const s = useEditor.getState();
          const layer = s.doc.comp.layers.find((l) => l.id === s.selectedId);
          if (!layer) return;
          e.preventDefault();
          e.stopPropagation();
          const { fps } = s.doc.comp;
          useKeySelection.getState().setKeys(
            layer.id,
            animatableProps(layer).flatMap((p) => {
              const prop = propAt(layer, p.path);
              return prop && 'track' in prop ? prop.track.keys.map((k) => keyName(p.id, Math.round(k.t * fps))) : [];
            }),
          );
        }
      }}
    >
      <div className="relative" style={{ width: ORIGIN + duration * pps + END_PAD, minHeight: '100%' }}>
        <div className="sticky top-0 z-40 flex border-b border-line bg-panel">
          <div className="sticky left-0 z-30 shrink-0 border-r border-line bg-panel" style={{ width: NAME_W, height: RULER_H }} />
          <Ruler pps={pps} duration={duration} fps={fps} scrollLeft={box.scrollLeft} viewWidth={box.width} />
        </div>
        <ul aria-label="Timeline layers">
          <li aria-hidden style={{ height: before }} />
          {shown.map((r) => (
            <LayerRow key={r.id} id={r.id} pps={pps} />
          ))}
          <li aria-hidden style={{ height: after }} />
        </ul>
      </div>
    </div>
    {/* Over the scroller, not inside it: in Firefox a line moving inside the scrolled rows repaints them every
        frame (scrubbing ~50 ms/frame with ten rows of keys). Clipped to the track area. */}
    <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-10 overflow-hidden" style={{ left: NAME_W }}>
      <Playhead pps={pps} scroller={scroller} />
    </div>
    </div>
  );
}

/** The red line: positioned by a store subscription so playback never re-renders the panel. */
function Playhead({ pps, scroller }: { pps: number; scroller: React.RefObject<HTMLDivElement | null> }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = scroller.current!;
    const place = (t: number, playing: boolean) => {
      const x = ORIGIN + t * pps; // in the scrolled content
      // While playing, page along so the line stays in view.
      if (playing && (x < node.scrollLeft + ORIGIN || x > node.scrollLeft + node.clientWidth - 8)) node.scrollLeft = x - ORIGIN - 8;
      el.current!.style.transform = `translateX(${x - NAME_W - node.scrollLeft}px)`;
    };
    const follow = () => place(useEditor.getState().time, false);
    follow();
    node.addEventListener('scroll', follow, { passive: true });
    const unsub = useEditor.subscribe((s, prev) => s.time !== prev.time && place(s.time, s.playing));
    return () => {
      unsub();
      node.removeEventListener('scroll', follow);
    };
  }, [pps, scroller]);
  return (
    <div ref={el} aria-hidden className="absolute top-0 bottom-0 left-0 w-px bg-red-500 will-change-transform">
      <div className="absolute -top-px -left-[5px] h-0 w-0 border-x-[5.5px] border-t-[7px] border-x-transparent border-t-red-500" />
    </div>
  );
}

// ---------------------------------------------------------------------------

const icons = { background: Square, image: Image, video: Film, text: Type, adjustment: Blend } as const;

const LayerRow = memo(function LayerRow({ id, pps }: { id: string; pps: number }) {
  const layer = useEditor((s) => s.doc.comp.layers.find((l) => l.id === id));
  const selected = useEditor((s) => s.selectedId === id);
  const duration = useEditor((s) => s.doc.comp.duration);
  const fps = useEditor((s) => s.doc.comp.fps);
  const expanded = useTimelineView((s) => !!s.expanded[id]);
  const keyTimes = useMemo(() => (layer ? layerKeyTimes(layer, fps) : []), [layer, fps]);
  if (!layer) return null;
  const s = useEditor.getState();
  const Icon = icons[layer.type === 'image' && layer.video ? 'video' : layer.type];
  const canExpand = layer.type !== 'background';
  return (
    <li aria-label={layer.name}>
      <div className={`flex border-b border-line/60 ${selected ? 'bg-accent/10' : ''}`} style={{ height: ROW_H }}>
        <div className={`group sticky left-0 z-30 flex shrink-0 items-center gap-1 border-r border-line pr-2 pl-1 ${selected ? 'bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-panel))]' : 'bg-panel'}`} style={{ width: NAME_W }}>
          {canExpand ? (
            <button
              type="button"
              aria-label={`${expanded ? 'Hide' : 'Show'} ${layer.name} properties`}
              aria-expanded={expanded}
              className="rounded p-0.5 text-dim hover:text-white"
              onClick={() => useTimelineView.getState().toggleExpanded(id)}
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          ) : (
            <span className="w-[17px]" />
          )}
          <button type="button" aria-pressed={selected} className={`flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs ${selected ? 'text-white' : 'text-zinc-300'}`} onClick={() => s.select(id)}>
            <Icon size={13} className="shrink-0 text-dim" />
            <span className={`truncate ${layer.visible ? '' : 'opacity-40'}`}>{layer.name}</span>
          </button>
          <button
            type="button"
            aria-label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`}
            className={`rounded p-0.5 text-dim hover:text-white ${layer.locked ? '' : 'opacity-0 group-hover:opacity-70 focus-visible:opacity-100'}`}
            onClick={() => s.toggleLayer(id, 'locked')}
          >
            {layer.locked ? <Lock size={12} /> : <Unlock size={12} />}
          </button>
          <button type="button" aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`} className="rounded p-0.5 text-dim hover:text-white" onClick={() => s.toggleLayer(id, 'visible')}>
            {layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
        </div>
        <div className="relative ml-2 flex-1">
          <LayerBar layer={layer} pps={pps} duration={duration} />
          {/* Every key of the layer, merged per frame (open the layer to edit them). */}
          {keyTimes.length > 0 && (
            // One SVG for the whole row (not an element per key: see .key-diamond in index.css).
            <svg data-summary-keys aria-hidden className="pointer-events-none absolute inset-y-0 left-0 overflow-visible" width={duration * pps} height={ROW_H}>
              <path d={keyTimes.map((t) => `M${t * pps} ${ROW_H / 2 - 4}l4 4-4 4-4-4Z`).join('')} fill="rgb(228 228 231 / 0.9)" stroke="rgb(9 9 11 / 0.8)" />
            </svg>
          )}
        </div>
      </div>
      {expanded && <PropRows layer={layer} pps={pps} />}
    </li>
  );
});
