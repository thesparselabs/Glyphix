import { AudioBufferSource, BufferTarget, canEncodeAudio, canEncodeVideo, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat } from 'mediabunny';
import { Zip, ZipPassThrough } from 'fflate';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { audioSegments, evaluate, type Doc } from '@/doc';
import { createBackend, type RenderBackend } from '@/render/backend';
import { fontLibrary } from '@/text/fontLibrary';
import { MIX_CHANNELS, MIX_RATE, mixAudio, type AudioMix } from './audioMix';
import { safeName } from './fileName';
import { exportLottie } from './lottie';

// Export runs on the main thread with its own backend instance (full-resolution assets) and a
// fixed timestep (t = i / fps, never drops frames). The same evaluator + renderer as the preview,
// so preview = export. It awaits the encoder between frames, so the UI stays responsive.

export interface ExportOptions {
  forceWebGL?: boolean;
  scale?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export async function prepare(doc: Doc, opts: ExportOptions): Promise<{ backend: RenderBackend; canvas: HTMLCanvasElement; width: number; height: number }> {
  const fonts = new Set(doc.comp.layers.flatMap((l) => (l.type === 'text' ? [l.fontId] : [])));
  // Frame bars draw their URL text with the CSS Inter face; make sure it's ready so export matches preview.
  // Missing fonts fall back to Inter (the same fallback the preview uses).
  await Promise.all([fontLibrary.loadAll(fonts), document.fonts.load('500 12px Inter')]);
  const { width, height } = videoSize(doc, opts.scale);
  const canvas = document.createElement('canvas');
  const backend = await createBackend({ canvas, forceWebGL: opts.forceWebGL, fullResAssets: true });
  backend.setSize(width, height, 1);
  return { backend, canvas, width, height };
}

/** Render one frame and snapshot it synchronously (WebGPU canvases are only readable in the same task). */
export async function renderFrameBitmap(backend: RenderBackend, doc: Doc, t: number): Promise<ImageBitmap> {
  const list = evaluate(doc, t);
  await backend.prepare(list);
  backend.render(list);
  return createImageBitmap(backend.canvas);
}

export async function exportPng(doc: Doc, t: number, opts: ExportOptions = {}): Promise<Blob> {
  const { backend, width, height } = await prepare(doc, opts);
  try {
    // Text layout happens on first render; render twice so freshly rasterised glyphs are in the atlas.
    backend.render(evaluate(doc, t));
    const bmp = await renderFrameBitmap(backend, doc, t);
    const out = new OffscreenCanvas(width, height);
    out.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    return await out.convertToBlob({ type: 'image/png' });
  } finally {
    // Let queued GPU work finish first, or WebGPU logs errors from pending error scopes.
    await backend.idle().catch(() => {});
    backend.dispose();
  }
}

// Thumbnails: one small renderer reused for every autosave. Creating a renderer builds and compiles
// every shader on the main thread (a visible hitch); preview proxies are fine at thumbnail size.
let thumbs: Promise<RenderBackend> | null = null;
let thumbQueue: Promise<unknown> = Promise.resolve();

export function renderThumbnail(doc: Doc, t: number, width: number): Promise<Blob> {
  const job = thumbQueue.then(async () => {
    thumbs ??= createBackend({ canvas: document.createElement('canvas') }).then((b) => {
      b.onLost = () => (thumbs = null);
      return b;
    });
    const backend = await thumbs;
    const fonts = doc.comp.layers.flatMap((l) => (l.type === 'text' ? [l.fontId] : []));
    await fontLibrary.loadAll(fonts);
    const w = Math.max(2, Math.round(width / 2) * 2);
    const h = Math.max(2, Math.round((width * doc.comp.height) / doc.comp.width / 2) * 2);
    backend.setSize(w, h, 1);
    backend.render(evaluate(doc, t)); // first render pulls new glyphs into the atlas
    const bmp = await renderFrameBitmap(backend, doc, t);
    const out = new OffscreenCanvas(w, h);
    out.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    return out.convertToBlob({ type: 'image/png' });
  });
  thumbQueue = job.catch(() => undefined);
  return job;
}

export interface VideoExportOptions extends ExportOptions {
  /** 'mp4' (H.264 + AAC; falls back to WebM when H.264 can't be encoded) or 'webm' (VP9 + Opus). */
  container?: 'mp4' | 'webm';
  /** WebM: hide background layers and keep the alpha channel. */
  transparent?: boolean;
}

export interface VideoExportResult {
  blob: Blob;
  extension: string;
  codec: string;
  /** Audio codec, or null when the export has no sound. */
  audioCodec: string | null;
  /** True when the video carries an alpha channel. */
  alpha: boolean;
  /** Fallbacks taken, for the user ("saved without sound: …"). */
  notes: string[];
  ms: number;
}

/** Output size for a comp at `scale`: encoders need even dimensions. */
const videoSize = (doc: Doc, scale = 1) => ({
  width: Math.round((doc.comp.width * scale) / 2) * 2,
  height: Math.round((doc.comp.height * scale) / 2) * 2,
});

const AUDIO_CODECS: Record<'mp4' | 'webm', ('aac' | 'opus')[]> = { mp4: ['aac', 'opus'], webm: ['opus'] };
/** Mixed audio is fed to the encoder in slices just ahead of the video, so the muxer interleaves them. */
const AUDIO_SLICE = 0.5;

export async function exportVideo(doc: Doc, opts: VideoExportOptions = {}): Promise<VideoExportResult> {
  const started = performance.now();
  const notes: string[] = [];
  const { width, height } = videoSize(doc, opts.scale);
  const avc = opts.container !== 'webm' && (await canEncodeVideo('avc', { width, height }));
  const codec = avc ? 'avc' : 'vp9';
  if (!avc && !(await canEncodeVideo('vp9', { width, height }))) throw new Error("this browser can't encode H.264 or VP9 video");
  const container = avc ? 'mp4' : 'webm';
  // Alpha needs VP9 in WebM. Without encoder support, keep the background rather than turn it black.
  const alpha = !avc && !!opts.transparent && (await canEncodeVideo('vp9', { width, height, alpha: 'keep' }));
  if (opts.transparent && !alpha) notes.push("This browser can't encode transparent video; saved with the background.");
  const source = alpha ? withoutBackground(doc) : doc;

  // Audio: pick an encodable codec first, so a browser without one doesn't decode audio for nothing.
  let audioCodec: 'aac' | 'opus' | null = null;
  let mix: AudioMix | null = null;
  if (audioSegments(doc).length) {
    for (const c of AUDIO_CODECS[container]) {
      if (await canEncodeAudio(c, { numberOfChannels: MIX_CHANNELS, sampleRate: MIX_RATE })) {
        audioCodec = c;
        break;
      }
    }
    if (audioCodec) mix = await mixAudio(doc, { signal: opts.signal });
    else notes.push("This browser can't encode audio; saved without sound.");
    if (mix?.failed.length) notes.push(`The audio of ${mix.failed.length === 1 ? 'one video' : `${mix.failed.length} videos`} couldn't be decoded and is silent.`);
    if (mix && container === 'mp4' && audioCodec === 'opus') notes.push("AAC isn't available in this browser; the audio is Opus (some players, like QuickTime, can't play it).");
  }

  const { backend, canvas } = await prepare(source, opts);
  try {
    const format = avc ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat();
    const target = new BufferTarget();
    const output = new Output({ format, target });
    const video = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH, alpha: alpha ? 'keep' : 'discard' });
    const { fps, duration } = doc.comp;
    output.addVideoTrack(video, { frameRate: fps });
    const audio = mix && audioCodec ? new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH }) : null;
    if (audio) output.addAudioTrack(audio);
    await output.start();

    // The mix starts at t = 0 and covers exactly the comp duration, like the video.
    let audioPos = 0;
    const feedAudio = async (until: number) => {
      if (!audio || !mix) return;
      const buf = mix.buffer;
      const end = Math.min(buf.length, Math.round(until * buf.sampleRate));
      while (audioPos < end) {
        const n = Math.min(buf.length - audioPos, Math.round(AUDIO_SLICE * buf.sampleRate));
        const slice = new AudioBuffer({ length: n, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
        for (let c = 0; c < buf.numberOfChannels; c++) slice.copyToChannel(buf.getChannelData(c).subarray(audioPos, audioPos + n), c);
        await audio.add(slice);
        audioPos += n;
      }
    };

    backend.render(evaluate(source, 0)); // warm-up: shaders, glyph atlas
    const frames = Math.round(duration * fps);
    for (let i = 0; i < frames; i++) {
      if (opts.signal?.aborted) {
        await output.cancel();
        throw new DOMException('Export cancelled', 'AbortError');
      }
      const t = i / fps;
      await feedAudio(t + AUDIO_SLICE);
      const list = evaluate(source, t);
      await backend.prepare(list);
      backend.render(list);
      await video.add(t, 1 / fps);
      opts.onProgress?.((i + 1) / frames);
    }
    await feedAudio(Infinity);
    await output.finalize();
    return {
      blob: new Blob([target.buffer!], { type: format.mimeType }),
      extension: format.fileExtension,
      codec,
      audioCodec: audio ? audioCodec : null,
      alpha,
      notes,
      ms: performance.now() - started,
    };
  } finally {
    // Let queued GPU work finish first, or WebGPU logs errors from pending error scopes.
    await backend.idle().catch(() => {});
    backend.dispose();
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// Unified export (used by the Export dialog)

export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'mp4' | 'webm' | 'png-seq' | 'gif' | 'lottie';

export interface ExportSettings {
  format: ExportFormat;
  /** Output size relative to the comp (stills 1–4×, video and sequences 0.5–2×, GIF 0.25–1×). */
  scale: number;
  /** JPEG/WebP quality 0..1. */
  quality: number;
  /** PNG/WebP/PNG sequence: hide background layers so the export has an alpha channel. */
  transparent: boolean;
  /** WebM: the same, as VP9 with alpha (its own setting: on by default). */
  webmTransparent: boolean;
  /** Stills: which moment to export. */
  time: number;
  /** GIF frame rate. Divisors of 100 keep GIF's 10 ms frame timing exact. */
  gifFps: 10 | 20 | 25;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  ms: number;
  width: number;
  height: number;
  /** e.g. "WebP isn't supported here; saved PNG instead". */
  note: string | null;
  /** Lottie: parts of the scene the file leaves out, one readable line each. */
  omitted?: string[];
}

const STILL_MIME: Record<'png' | 'jpeg' | 'webp', string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' };

const withoutBackground = (doc: Doc): Doc => ({
  ...doc,
  comp: { ...doc.comp, layers: doc.comp.layers.map((l) => (l.type === 'background' ? { ...l, visible: false } : l)) },
});

export { safeName } from './fileName';

export async function exportStill(doc: Doc, settings: Pick<ExportSettings, 'format' | 'scale' | 'quality' | 'transparent' | 'time'>, opts: ExportOptions = {}): Promise<ExportResult> {
  const started = performance.now();
  const format = settings.format as 'png' | 'jpeg' | 'webp';
  // JPEG has no alpha: transparency is ignored there.
  const source = settings.transparent && format !== 'jpeg' ? withoutBackground(doc) : doc;
  const { backend, width, height } = await prepare(source, { ...opts, scale: settings.scale });
  try {
    backend.render(evaluate(source, settings.time)); // warm-up: layout → atlas, texture uploads
    const bmp = await renderFrameBitmap(backend, source, settings.time);
    const out = new OffscreenCanvas(width, height);
    const g = out.getContext('2d')!;
    if (format === 'jpeg') {
      g.fillStyle = '#ffffff'; // JPEG can't store alpha; never let it turn black
      g.fillRect(0, 0, width, height);
    }
    g.drawImage(bmp, 0, 0);
    bmp.close();
    opts.onProgress?.(1);
    const wanted = STILL_MIME[format];
    const blob = await out.convertToBlob({ type: wanted, quality: settings.quality });
    const note = blob.type !== wanted ? `${format.toUpperCase()} isn't supported by this browser; saved ${EXT[blob.type]?.toUpperCase() ?? blob.type} instead.` : null;
    return { blob, filename: `${safeName(doc)}.${EXT[blob.type] ?? format}`, ms: performance.now() - started, width, height, note };
  } finally {
    await backend.idle().catch(() => {});
    backend.dispose();
  }
}

export async function exportGif(doc: Doc, settings: Pick<ExportSettings, 'scale' | 'gifFps'>, opts: ExportOptions = {}): Promise<ExportResult> {
  const started = performance.now();
  const { backend, width, height } = await prepare(doc, { ...opts, scale: settings.scale });
  const read = async (t: number) => {
    const bmp = await renderFrameBitmap(backend, doc, t);
    const c = new OffscreenCanvas(width, height);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0);
    bmp.close();
    return g.getImageData(0, 0, width, height).data;
  };
  try {
    const fps = settings.gifFps;
    const frames = Math.max(1, Math.round(doc.comp.duration * fps));
    backend.render(evaluate(doc, 0)); // warm-up

    // One global palette, sampled from frames across the clip, so colours don't flicker.
    const samples = Math.min(8, frames);
    const sampleStep = 3; // every 3rd pixel keeps quantize fast
    const perFrame = Math.ceil((width * height) / sampleStep);
    const pool = new Uint8ClampedArray(samples * perFrame * 4);
    for (let k = 0; k < samples; k++) {
      if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const px = await read(((k + 0.5) / samples) * doc.comp.duration);
      for (let i = 0, o = k * perFrame * 4; i < width * height; i += sampleStep, o += 4) pool.set(px.subarray(i * 4, i * 4 + 4), o);
      opts.onProgress?.((0.2 * (k + 1)) / samples);
    }
    const palette = quantize(pool, 256);

    const gif = GIFEncoder();
    for (let i = 0; i < frames; i++) {
      if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const px = await read(i / fps);
      gif.writeFrame(applyPalette(px, palette), width, height, { palette, delay: 1000 / fps, repeat: 0 });
      opts.onProgress?.(0.2 + (0.8 * (i + 1)) / frames);
    }
    gif.finish();
    const blob = new Blob([gif.bytes() as Uint8Array<ArrayBuffer>], { type: 'image/gif' });
    return { blob, filename: `${safeName(doc)}.gif`, ms: performance.now() - started, width, height, note: null };
  } finally {
    await backend.idle().catch(() => {});
    backend.dispose();
  }
}

/** File name of frame `i` in a PNG sequence. */
export const sequenceFrameName = (i: number) => `frame-${String(i).padStart(5, '0')}.png`;

/** Every frame (t = i / fps) as a PNG, stored (not deflated: PNGs are already compressed) in a zip. */
export async function exportPngSequence(doc: Doc, settings: Pick<ExportSettings, 'scale' | 'transparent'>, opts: ExportOptions = {}): Promise<ExportResult> {
  const started = performance.now();
  const source = settings.transparent ? withoutBackground(doc) : doc;
  const { backend, width, height } = await prepare(source, { ...opts, scale: settings.scale });
  const chunks: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((err, data) => {
    if (err) zipError = err;
    else chunks.push(data);
  });
  try {
    const { fps, duration } = doc.comp;
    const frames = Math.max(1, Math.round(duration * fps));
    backend.render(evaluate(source, 0)); // warm-up
    // PNG encoding runs beside the render loop: a few frames in flight, added to the zip in order.
    const pending: Promise<Uint8Array>[] = [];
    let written = 0;
    const flush = async (keep: number) => {
      while (pending.length > keep) {
        const png = await pending.shift()!;
        const entry = new ZipPassThrough(sequenceFrameName(written));
        zip.add(entry);
        entry.push(png, true);
        written++;
        opts.onProgress?.(written / frames);
      }
    };
    for (let i = 0; i < frames; i++) {
      if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const bmp = await renderFrameBitmap(backend, source, i / fps);
      const out = new OffscreenCanvas(width, height);
      out.getContext('2d')!.drawImage(bmp, 0, 0);
      bmp.close();
      pending.push(out.convertToBlob({ type: 'image/png' }).then(async (b) => new Uint8Array(await b.arrayBuffer())));
      await flush(3);
    }
    await flush(0);
    zip.end();
    if (zipError) throw zipError;
    const blob = new Blob(chunks as Uint8Array<ArrayBuffer>[], { type: 'application/zip' });
    return { blob, filename: `${safeName(doc)}-frames.zip`, ms: performance.now() - started, width, height, note: null };
  } finally {
    await backend.idle().catch(() => {});
    backend.dispose();
  }
}

export async function runExport(doc: Doc, settings: ExportSettings, opts: ExportOptions = {}): Promise<ExportResult> {
  switch (settings.format) {
    case 'png':
    case 'jpeg':
    case 'webp':
      return exportStill(doc, settings, opts);
    case 'gif':
      return exportGif(doc, settings, opts);
    case 'png-seq':
      return exportPngSequence(doc, settings, opts);
    case 'lottie':
      return exportLottie(doc, opts);
    case 'mp4':
    case 'webm': {
      const webm = settings.format === 'webm';
      const r = await exportVideo(doc, { ...opts, scale: settings.scale, container: settings.format, transparent: webm && settings.webmTransparent });
      const { width, height } = videoSize(doc, settings.scale);
      const notes = [...(!webm && r.codec !== 'avc' ? ["H.264 isn't available in this browser; saved WebM (VP9) instead."] : []), ...r.notes];
      return { blob: r.blob, filename: `${safeName(doc)}.${r.extension.replace(/^\./, '')}`, ms: r.ms, width, height, note: notes.join(' ') || null };
    }
  }
}
