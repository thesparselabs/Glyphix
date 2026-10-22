// Timeline panel UI state (not part of the document): dock height, collapsed, zoom. Height and collapsed are
// remembered per browser.
import { create } from 'zustand';

export const NAME_W = 200;
/** Gap between the name column and time 0 (so keys at 0 are fully visible). */
export const TRACK_PAD = 8;
/** x of time 0 in the scrolled content. */
export const ORIGIN = NAME_W + TRACK_PAD;
export const ROW_H = 28;
/** A property row under an expanded layer. */
export const PROP_H = ROW_H - 4;
export const RULER_H = 24;
export const HEADER_H = 44;
export const MIN_H = 120;
/** Empty space after the comp end, so the last key / bar edge is grabbable. */
export const END_PAD = 32;

const KEY = 'glyphix.timeline';

interface Saved {
  height: number;
  collapsed: boolean;
}

function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null;
    if (s && typeof s.height === 'number') return { height: Math.max(MIN_H, s.height), collapsed: !!s.collapsed };
  } catch {
    // storage blocked or corrupt: defaults
  }
  return { height: 240, collapsed: false };
}

function save(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not remembered, still works
  }
}

interface TimelineView extends Saved {
  /** Pixels per second; null = fit the whole comp in the visible width. */
  zoom: number | null;
  /** Layers whose property rows are open. */
  expanded: Readonly<Record<string, boolean>>;
  toggleExpanded(id: string): void;
  setHeight(h: number): void;
  setCollapsed(c: boolean): void;
  setZoom(z: number | null): void;
}

export const useTimelineView = create<TimelineView>((set, get) => ({
  ...load(),
  zoom: null,
  expanded: {},
  toggleExpanded: (id) => set((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })),
  setHeight(h) {
    const height = Math.round(Math.max(MIN_H, Math.min(h, window.innerHeight * 0.7)));
    set({ height });
    save({ height, collapsed: get().collapsed });
  },
  setCollapsed(collapsed) {
    set({ collapsed });
    save({ height: get().height, collapsed });
  },
  setZoom: (zoom) => set({ zoom }),
}));

/** Pixels per second that fit `duration` into a track area `width` px wide. */
export const fitZoom = (width: number, duration: number) => Math.max(1, (width - ORIGIN - END_PAD) / Math.max(duration, 0.1));

/** Zoom range: from "whole comp" (or 10 px/s) to one frame = 40 px. */
export const zoomLimits = (fit: number, fps: number) => [Math.min(fit, 10), fps * 40] as const;
