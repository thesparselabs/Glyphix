// Video clip timing: which source frame a video layer shows at comp time t, and which parts of
// which files play as audio. Pure functions; the renderer and exporter both use them.
import type { Comp, Doc, VideoClip } from './types';
import { layerSpan } from './timing';

export const clipLength = (c: VideoClip) => Math.max(0, c.out - c.in);

/** Source time (s) shown at comp time `t`. Holds the first/last frame outside the clip unless it loops. */
export function videoSourceTime(clip: VideoClip, t: number): number {
  const len = clipLength(clip);
  if (len <= 0) return clip.in;
  const local = t - clip.start;
  if (clip.loop) return clip.in + (((local % len) + len) % len);
  return clip.in + Math.min(len, Math.max(0, local));
}

/** A new clip for a source of `duration` seconds placed at comp time 0. */
export function defaultClip(duration: number, comp: Pick<Comp, 'duration'>): VideoClip {
  return { start: 0, in: 0, out: duration, loop: duration < comp.duration, volume: 1, muted: false };
}

/** One stretch of a video file's audio, placed on the comp timeline. */
export interface AudioSegment {
  layerId: string;
  assetId: string;
  /** Comp time where this stretch starts / its length (s). */
  compStart: number;
  duration: number;
  /** Source time where it starts reading. */
  sourceStart: number;
  volume: number;
}

/**
 * Audio to mix for an export of `doc` (0..comp.duration): one segment per stretch of each audible,
 * visible video layer. Looping clips produce one segment per repetition. Holds (before/after the clip) are silent.
 */
export function audioSegments(doc: Doc): AudioSegment[] {
  const out: AudioSegment[] = [];
  for (const l of doc.comp.layers) {
    if (l.type !== 'image' || !l.video || !l.visible) continue;
    const c = l.video;
    const len = clipLength(c);
    if (c.muted || c.volume <= 0 || len <= 0) continue;
    // Heard only while the layer is on screen.
    const [lo, end] = layerSpan(l, doc.comp);
    const push = (compStart: number, sourceStart: number, duration: number) => {
      const a = Math.max(lo, compStart);
      const b = Math.min(end, compStart + duration);
      if (b - a > 1e-6) out.push({ layerId: l.id, assetId: l.assetId, compStart: a, duration: b - a, sourceStart: sourceStart + (a - compStart), volume: c.volume });
    };
    if (!c.loop) push(c.start, c.in, len);
    else {
      // Repetitions that overlap [lo, end]; the first may start before lo.
      const first = Math.floor((lo - c.start) / len);
      for (let k = first; c.start + k * len < end; k++) push(c.start + k * len, c.in, len);
    }
  }
  return out;
}
