import { useEffect, useRef } from 'react';
import { snapToFrame } from '@/doc';
import { useEditor } from '../store';
import { ORIGIN, RULER_H, TRACK_PAD } from './view';

/**
 * Tick spacing in seconds: the smallest "nice" step at least `minPx` wide. Below a second the steps are frame
 * counts that divide the frame rate, so ticks always land on whole seconds.
 */
export function tickStep(pps: number, fps: number, minPx: number): number {
  const frames = Array.from({ length: fps - 1 }, (_, i) => i + 1).filter((f) => fps % f === 0);
  const steps = frames.map((f) => f / fps).concat([1, 2, 5, 10, 15, 30, 60]);
  return steps.find((s) => s * pps >= minPx) ?? 60;
}

/** Whole seconds read "1s"; ticks between them read as the frame within the second ("10f"). */
export function tickLabel(t: number, fps: number): string {
  const f = Math.round(t * fps);
  return f % fps === 0 ? `${f / fps}s` : `${f % fps}f`;
}

export const timeLabel = (t: number, fps: number) => `${t.toFixed(2)} s, frame ${Math.round(t * fps)}`;

/**
 * Time ruler: ticks for the visible range, and the keyboard/pointer playhead control (the "Playhead" slider).
 * Its aria values follow the clock through a store subscription, not re-renders.
 */
export function Ruler({ pps, duration, fps, scrollLeft, viewWidth }: { pps: number; duration: number; fps: number; scrollLeft: number; viewWidth: number }) {
  const el = useRef<HTMLDivElement>(null);
  const width = duration * pps;

  useEffect(() => {
    const node = el.current!;
    const sync = (t: number) => {
      node.setAttribute('aria-valuenow', t.toFixed(3));
      node.setAttribute('aria-valuetext', timeLabel(t, fps));
    };
    sync(useEditor.getState().time);
    return useEditor.subscribe((s, prev) => s.time !== prev.time && sync(s.time));
  }, [fps]);

  const seek = (t: number) => {
    const s = useEditor.getState();
    s.setPlaying(false);
    s.setTime(Math.max(0, Math.min(duration, snapToFrame(t, fps))));
  };
  const timeAt = (clientX: number) => (clientX - el.current!.getBoundingClientRect().left) / pps;

  const major = tickStep(pps, fps, 64);
  const minor = tickStep(pps, fps, 8);
  const from = Math.max(0, Math.floor((scrollLeft - ORIGIN) / pps / major) * major);
  const to = Math.min(duration, (scrollLeft + viewWidth) / pps + major);
  const ticks: { t: number; major: boolean }[] = [];
  for (let i = Math.round(from / minor); i * minor <= to + 1e-9; i++) {
    const t = i * minor;
    ticks.push({ t, major: Math.abs(t / major - Math.round(t / major)) < 1e-6 });
  }

  return (
    <div
      ref={el}
      role="slider"
      tabIndex={0}
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={duration}
      className="relative cursor-ew-resize touch-none select-none outline-none focus-visible:bg-accent/10"
      style={{ width, height: RULER_H, marginLeft: TRACK_PAD }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(timeAt(e.clientX));
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && seek(timeAt(e.clientX))}
      onKeyDown={(e) => {
        const t = useEditor.getState().time;
        const step = (e.shiftKey ? 10 : 1) / fps;
        const to = { ArrowLeft: t - step, ArrowRight: t + step, ArrowDown: t - step, ArrowUp: t + step, Home: 0, End: duration, PageDown: t - 1, PageUp: t + 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        e.stopPropagation(); // not the global layer-nudge shortcuts
        seek(to);
      }}
    >
      <svg aria-hidden className="absolute inset-0 overflow-visible" width={width} height={RULER_H}>
        {ticks.map(({ t, major: m }) => (
          <g key={t.toFixed(4)} transform={`translate(${Math.round(t * pps) + 0.5},0)`}>
            <line y1={m ? 10 : 17} y2={RULER_H} stroke="currentColor" className={m ? 'text-zinc-500' : 'text-zinc-700'} />
            {m && (
              <text x={3} y={10} className="fill-zinc-400 font-mono text-[10px]">
                {tickLabel(t, fps)}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
