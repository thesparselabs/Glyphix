// Easing editor: a button that opens a popover with presets, a curve editor, and a live preview.
// All curves and the preview are drawn with ease() from the doc, the same function the renderer uses.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/wensity/popover';
import { cssEasing, ease, EASING_PRESETS, easingPreset, type Easing } from '@/doc';
import { useEditor } from './store';
import { inputClass, SliderField } from './ui';

type Bezier = Extract<Easing, { kind: 'bezier' }>;
type Side = 'left' | 'right' | 'top' | 'bottom';

const Y_MIN = -0.5;
const Y_MAX = 1.5;
const AREA = 200; // curve area is AREA x AREA px
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;
const clampX = (v: number) => round2(clamp(v, 0, 1));
const clampY = (v: number) => round2(clamp(v, Y_MIN, Y_MAX));

/** SVG path of the eased curve for x in 0..1, drawn in a w x h box showing y from Y_MIN to Y_MAX. */
function curvePath(e: Easing, w: number, h: number, samples = 64) {
  let d = '';
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const y = ease(e, t);
    const px = t * w;
    const py = ((Y_MAX - y) / (Y_MAX - Y_MIN)) * h;
    d += `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`;
  }
  return d;
}

/** Small curve picture for the trigger and the preset grid. */
function Thumb({ easing, w = 28, h = 16 }: { easing: Easing; w?: number; h?: number }) {
  return (
    <svg aria-hidden width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0 overflow-visible">
      <path d={curvePath(easing, w, h, 24)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

const focusRing = 'outline-none focus-visible:outline-2 focus-visible:outline-white';

export function EasingButton({
  label,
  value,
  onChange,
  disabled,
  note,
  side = 'left',
}: {
  /** Accessible name prefix; the trigger's aria-label is `${label}: ${presetLabel | 'Custom' | 'Mixed'}`. */
  label: string;
  /** null = the selected keys have different easings ("Mixed"). */
  value: Easing | null;
  /** coalesceKey: same string for repeated nudges / typing on one control so they merge into one undo step. */
  onChange: (e: Easing, coalesceKey?: string) => void;
  disabled?: boolean;
  /** Extra line shown at the top of the popover. */
  note?: string;
  side?: Side;
}) {
  const [open, setOpen] = useState(false);
  const preset = value ? easingPreset(value) : undefined;
  const name = value ? (preset?.label ?? 'Custom') : 'Mixed';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`${label}: ${name}`}
          className={`${inputClass} flex items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50`}
        >
          <span className="flex min-w-0 items-center gap-2">
            {value ? <Thumb easing={value} /> : <span aria-hidden className="w-7 shrink-0 text-center text-dim">~</span>}
            <span className="truncate">{name}</span>
          </span>
          <ChevronDown size={14} aria-hidden className="shrink-0 text-dim" />
        </button>
      </PopoverTrigger>
      <PopoverContent width="md" side={side} align="start">
        <EasingPanel label={label} value={value} onChange={onChange} note={note} open={open} />
      </PopoverContent>
    </Popover>
  );
}

function EasingPanel({ label, value, onChange, note, open }: { label: string; value: Easing | null; onChange: (e: Easing, k?: string) => void; note?: string; open: boolean }) {
  const key = (part: string) => `easing:${label}:${part}`;
  return (
    // data-own-keys: arrows / Delete here belong to the editor, not to the selected keyframes (see useShortcuts).
    <div data-own-keys className="space-y-3">
      {note && <p className="text-xs text-dim">{note}</p>}
      <div role="group" aria-label="Easing presets" className="grid grid-cols-3 gap-1.5">
        {EASING_PRESETS.map((p) => {
          const on = !!value && easingPreset(value)?.id === p.id;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(p.easing)}
              className={`flex flex-col items-center gap-1 rounded px-1 py-1.5 text-[10px] leading-tight ring-1 hover:bg-white/6 ${focusRing} ${on ? 'bg-accent/20 text-white ring-accent' : 'text-zinc-300 ring-line'}`}
            >
              <Thumb easing={p.easing} w={36} h={22} />
              <span className="text-center">{p.label}</span>
            </button>
          );
        })}
      </div>
      {value ? (
        <>
          <CurveArea easing={value} onChange={onChange} keyFor={key} />
          <KindControls value={value} onChange={onChange} keyFor={key} />
          <Preview easing={value} active={open} />
        </>
      ) : (
        <p className="text-xs text-dim">Pick a preset to set all selected keys.</p>
      )}
    </div>
  );
}

/** The curve box. Bezier gets two draggable, keyboard-movable handles; other kinds just show the curve. */
function CurveArea({ easing, onChange, keyFor }: { easing: Easing; onChange: (e: Easing, k?: string) => void; keyFor: (p: string) => string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  // Latest value, so a drag that is faster than React renders never works from stale numbers.
  const latest = useRef(easing);
  latest.current = easing;
  const bez = easing.kind === 'bezier' ? easing : null;
  const px = (x: number) => x * AREA;
  const py = (y: number) => ((Y_MAX - y) / (Y_MAX - Y_MIN)) * AREA;

  const setHandle = (n: 1 | 2, x: number, y: number, k?: string) => {
    const cur = latest.current;
    if (cur.kind !== 'bezier') return;
    const next: Bezier = n === 1 ? { ...cur, x1: clampX(x), y1: clampY(y) } : { ...cur, x2: clampX(x), y2: clampY(y) };
    latest.current = next;
    onChange(next, k);
  };

  const onDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    useEditor.getState().beginGesture();
    e.currentTarget.focus();
  };
  const onMove = (n: 1 | 2) => (e: PointerEvent<HTMLButtonElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || !r.width) return;
    const x = (e.clientX - r.left) / r.width;
    const y = Y_MAX - ((e.clientY - r.top) / r.height) * (Y_MAX - Y_MIN);
    setHandle(n, x, y);
  };
  const onUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    useEditor.getState().endGesture();
  };
  const onKey = (n: 1 | 2) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    const dy = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    e.stopPropagation(); // the editor has global arrow-key shortcuts
    const cur = latest.current;
    if (cur.kind !== 'bezier') return;
    const step = e.shiftKey ? 0.1 : 0.01;
    const [x, y] = n === 1 ? [cur.x1, cur.y1] : [cur.x2, cur.y2];
    setHandle(n, x + dx * step, y + dy * step, keyFor(`h${n}`));
  };

  const handles: { n: 1 | 2; x: number; y: number }[] = bez
    ? [
        { n: 1, x: bez.x1, y: bez.y1 },
        { n: 2, x: bez.x2, y: bez.y2 },
      ]
    : [];

  return (
    <div className="relative mx-auto select-none" style={{ width: AREA, height: AREA }}>
      <svg ref={svgRef} aria-hidden width={AREA} height={AREA} viewBox={`0 0 ${AREA} ${AREA}`} className="overflow-visible rounded bg-panel-2 ring-1 ring-line">
        <line x1={0} x2={AREA} y1={py(0)} y2={py(0)} stroke="currentColor" className="text-zinc-600" strokeDasharray="3 3" />
        <line x1={0} x2={AREA} y1={py(1)} y2={py(1)} stroke="currentColor" className="text-zinc-600" strokeDasharray="3 3" />
        {bez && (
          <>
            <line x1={px(0)} y1={py(0)} x2={px(bez.x1)} y2={py(bez.y1)} stroke="currentColor" className="text-dim" />
            <line x1={px(1)} y1={py(1)} x2={px(bez.x2)} y2={py(bez.y2)} stroke="currentColor" className="text-dim" />
          </>
        )}
        <path d={curvePath(easing, AREA, AREA)} fill="none" stroke="currentColor" className="text-accent" strokeWidth={2} strokeLinejoin="round" />
      </svg>
      {handles.map((h) => (
        <button
          key={h.n}
          type="button"
          aria-label={`Handle ${h.n}: x ${h.x.toFixed(2)}, y ${h.y.toFixed(2)}`}
          onPointerDown={onDown}
          onPointerMove={onMove(h.n)}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onKey(h.n)}
          className={`absolute h-4 w-4 cursor-grab rounded-full bg-white ring-2 ring-accent active:cursor-grabbing ${focusRing}`}
          style={{ left: px(h.x) - 8, top: py(h.y) - 8, touchAction: 'none' }}
        />
      ))}
    </div>
  );
}

/** Controls that go with each kind: number inputs + CSS text (bezier), sliders (spring / steps / bounce). */
function KindControls({ value, onChange, keyFor }: { value: Easing; onChange: (e: Easing, k?: string) => void; keyFor: (p: string) => string }) {
  switch (value.kind) {
    case 'bezier':
      return <BezierFields value={value} onChange={onChange} keyFor={keyFor} />;
    case 'spring':
      return (
        <div className="space-y-2">
          <SliderField label="Mass" value={value.mass} min={0.1} max={5} step={0.1} onValueChange={(v) => onChange({ ...value, mass: v }, keyFor('mass'))} />
          <SliderField label="Stiffness" value={value.stiffness} min={10} max={500} step={1} onValueChange={(v) => onChange({ ...value, stiffness: v }, keyFor('stiffness'))} />
          <SliderField label="Damping" value={value.damping} min={1} max={100} step={0.5} onValueChange={(v) => onChange({ ...value, damping: v }, keyFor('damping'))} />
        </div>
      );
    case 'steps':
      return <SliderField label="Steps" value={value.n} min={1} max={24} step={1} onValueChange={(v) => onChange({ ...value, n: v }, keyFor('steps'))} />;
    case 'bounce':
      return <SliderField label="Bounces" value={value.n} min={0} max={6} step={1} onValueChange={(v) => onChange({ ...value, n: v }, keyFor('bounces'))} />;
    default:
      return (
        <button
          type="button"
          onClick={() => onChange({ kind: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 })}
          className={`w-full rounded px-2 py-1 text-xs text-zinc-300 ring-1 ring-line hover:bg-white/6 ${focusRing}`}
        >
          Edit as curve
        </button>
      );
  }
}

function BezierFields({ value, onChange, keyFor }: { value: Bezier; onChange: (e: Easing, k?: string) => void; keyFor: (p: string) => string }) {
  const [copied, setCopied] = useState(false);
  const css = cssEasing(value) ?? '';
  const fields = [
    ['x1', 'x'],
    ['y1', 'y'],
    ['x2', 'x'],
    ['y2', 'y'],
  ] as const;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(css);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard can be blocked; the text is still selectable */
    }
  };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-1.5">
        {fields.map(([name, axis]) => (
          <input
            key={name}
            type="number"
            aria-label={name}
            step={0.01}
            min={axis === 'x' ? 0 : Y_MIN}
            max={axis === 'x' ? 1 : Y_MAX}
            value={value[name]}
            onChange={(e) => {
              if (e.target.value === '' || !Number.isFinite(e.target.valueAsNumber)) return;
              const v = axis === 'x' ? clampX(e.target.valueAsNumber) : clampY(e.target.valueAsNumber);
              onChange({ ...value, [name]: v }, keyFor(name));
            }}
            className={`${inputClass} px-1.5 text-xs`}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate text-xs text-dim" title={css}>{css}</code>
        <button type="button" onClick={copy} className={`shrink-0 rounded px-2 py-1 text-xs text-zinc-300 ring-1 ring-line hover:bg-white/6 ${focusRing}`}>
          {copied ? 'Copied' : 'Copy CSS'}
        </button>
      </div>
    </div>
  );
}

const LOOP_MS = 1200;
const REST_MS = 400;
const TRACK = 200;
const DOT = 10;

/** A dot travelling along a bar with the chosen easing, looping. Moved through a ref so React doesn't re-render per frame. */
function Preview({ easing, active }: { easing: Easing; active: boolean }) {
  const dot = useRef<HTMLSpanElement>(null);
  const easingRef = useRef(easing);
  easingRef.current = easing;
  const place = (p: number) => {
    if (dot.current) dot.current.style.transform = `translateX(${(ease(easingRef.current, p) * (TRACK - DOT)).toFixed(2)}px)`;
  };
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (!active || reduced) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = (now - t0) % (LOOP_MS + REST_MS);
      place(Math.min(1, t / LOOP_MS));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, reduced]);

  if (reduced) {
    // No motion: show where the dot would be at a few moments instead.
    return (
      <div aria-hidden className="relative mx-auto h-4" style={{ width: TRACK }}>
        <div className="absolute inset-x-0 top-1/2 h-px bg-line" />
        {[0.25, 0.5, 0.75, 1].map((p) => (
          <span key={p} className="absolute top-1/2 -mt-[3px] h-1.5 w-1.5 rounded-full bg-accent/70" style={{ left: ease(easing, p) * (TRACK - DOT) + 2 }} />
        ))}
      </div>
    );
  }
  return (
    <div aria-hidden className="relative mx-auto h-4" style={{ width: TRACK }}>
      <div className="absolute inset-x-0 top-1/2 h-px bg-line" />
      <span ref={dot} className="absolute top-1/2 -mt-[5px] rounded-full bg-accent" style={{ width: DOT, height: DOT, left: 0 }} />
    </div>
  );
}
