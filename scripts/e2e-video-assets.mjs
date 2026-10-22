// Milestone F (F2): video assets and the frame-exact provider. Import each fixture (metadata, poster,
// dedupe), bad files rejected with readable messages, every frame of the 1080p clip decoded exactly
// (sequential, backward and random seeks) with no VideoFrame leaks, the renderer shows the exact frame
// the right way up on WebGPU and WebGL2, and video layers survive reload and the .glyphix round-trip.
// Needs the fixtures (scripts/make-video-fixtures.sh). Frames carry their number in the top 120 px:
// 240 px blocks, bit k = block k, white = 1.
// Usage: node scripts/e2e-video-assets.mjs [baseUrl]   (BROWSER=firefox for Firefox)
import { launch, browserName } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// The React style-shorthand warning comes from Inspector's background swatch (not video code); reported separately.
const KNOWN = /conflicting property is set/;
page.on('console', (m) => ((m.type() === 'error' && !KNOWN.test(m.text())) || /garbage collected without being closed/i.test(m.text())) && errors.push(m.text()));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const skip = (name, why) => console.log(`SKIP ${name} — ${why}`);
const ready = () => page.waitForFunction(() => window.__glyphix && window.__glyphix.saveState() === 'saved', null, { timeout: 30000 });
const FIX = '/scripts/fixtures/';

await page.goto(base);
await ready();
await page.keyboard.press('Space'); // pause
const webgl = await page.evaluate(() => window.__glyphix.editor.getState().forceWebGL);
console.log(`browser: ${browserName}${webgl ? ' (?webgl)' : ''}`);

// --- Page helpers: fetch a fixture, read the frame-number strip from anything drawable.
await page.evaluate(() => {
  window.__v = {
    async fetch(name) {
      const r = await fetch(`/scripts/fixtures/${name}`);
      return r.blob();
    },
    /** Frame number in the strip of `src` (w px wide; strip stripH px tall), for a video srcW px wide. */
    strip(src, w, stripH, srcW = w) {
      const c = (window.__v.canvas ??= new OffscreenCanvas(16, 16));
      if (c.width !== w || c.height !== stripH) Object.assign(c, { width: w, height: stripH });
      const g = c.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, w, stripH);
      g.drawImage(src, 0, 0, w, stripH, 0, 0, w, stripH);
      const data = g.getImageData(0, 0, w, stripH).data;
      const block = (240 * w) / srcW;
      let n = 0;
      let bits = 0;
      for (let k = 0; (k + 0.5) * block < w; k++, bits++) {
        const i = (Math.floor(stripH / 2) * w + Math.floor((k + 0.5) * block)) * 4;
        const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (luma > 128) n |= 1 << k;
      }
      return { n, bits };
    },
  };
});

// --- Import every fixture.
const fixtures = [
  { file: 'clip-1080p30.mp4', w: 1920, h: 1080, dur: 5, audio: true },
  { file: 'clip-720p-vp9.webm', w: 1280, h: 720, dur: 3, audio: true },
  { file: 'clip-silent-2s.mp4', w: 640, h: 360, dur: 2, audio: false },
];
const imported = {};
for (const f of fixtures) {
  const r = await page.evaluate(async (file) => {
    const blob = await window.__v.fetch(file);
    const t0 = performance.now();
    try {
      const { id, meta, reused } = await window.__glyphix.video.importVideo(blob);
      const ms = performance.now() - t0;
      return { id, meta, reused, ms, size: blob.size, inStore: window.__glyphix.assets().includes(id) };
    } catch (e) {
      return { error: `${e.constructor.name}: ${e.message}` };
    }
  }, f.file);
  if (r.error) {
    if (/can’t decode|can't decode/.test(r.error)) skip(`import ${f.file}`, r.error);
    else check(`import ${f.file}`, false, r.error);
    continue;
  }
  imported[f.file] = r.id;
  const m = r.meta;
  const ok = m.width === f.w && m.height === f.h && Math.abs(m.duration - f.dur) < 0.1 && m.fps === 30 && m.hasAudio === f.audio && r.inStore && /^vid-[0-9a-f]{20}$/.test(r.id) && !r.reused;
  check(`import ${f.file}: meta + poster`, ok, `${r.id} ${m.width}×${m.height} ${m.duration.toFixed(3)} s ${m.fps} fps audio=${m.hasAudio} codec=${m.codec}; ${r.ms.toFixed(0)} ms for ${(r.size / 1e6).toFixed(1)} MB`);
}
const vid = imported['clip-1080p30.mp4'];

if (vid) {
  const again = await page.evaluate(async () => window.__glyphix.video.importVideo(await window.__v.fetch('clip-1080p30.mp4')));
  check('same file imported twice → same id, reused', again.id === vid && again.reused);
}

// --- Bad inputs.
const bad = await page.evaluate(async () => {
  const { importVideo } = window.__glyphix.video;
  const png = await (await fetch('/icons/icon-192.png')).blob();
  const noise = new Uint8Array(200_000);
  for (let i = 0; i < noise.length; i += 65536) crypto.getRandomValues(noise.subarray(i, i + 65536));
  const out = {};
  for (const [name, blob] of [['png', png], ['random bytes', new Blob([noise], { type: 'video/mp4' })], ['empty', new Blob([])]]) {
    try {
      await importVideo(blob);
      out[name] = 'accepted';
    } catch (e) {
      out[name] = `${e.constructor.name}: ${e.message}`;
    }
  }
  return out;
});
for (const [name, msg] of Object.entries(bad)) check(`rejects ${name} with a readable message`, /^VideoFileError: .{12,}/.test(msg), msg);

// --- Exact frames straight from the provider (every frame of the 1080p clip).
if (vid) {
  const r = await page.evaluate(async (id) => {
    const { createExactFrames } = window.__glyphix.video;
    const P = createExactFrames();
    const list = (t) => ({ items: [{ kind: 'image', id: 'L', assetId: id, video: { time: t } }] });
    const read = (t) => window.__v.strip(P.frame('L', id, t), 1920, 120);
    const wrong = [];
    let maxOpen = 0;
    const t0 = performance.now();
    let decodeMs = 0;
    for (let i = 0; i < 150; i++) {
      const t = i / 30 + 1e-4;
      const td = performance.now();
      await P.prepare(list(t));
      decodeMs += performance.now() - td;
      maxOpen = Math.max(maxOpen, P.stats().openFrames);
      const { n } = read(t);
      if (n !== i) wrong.push(`${i}→${n}`);
    }
    const seqMs = performance.now() - t0;
    const seqSessions = P.stats().sessions;
    // Same time twice: no new frame.
    const v0 = P.version;
    const f0 = P.stats().frames;
    await P.prepare(list(149 / 30 + 1e-4));
    const noRedecode = P.version === v0 && P.stats().frames === f0;
    // Exact boundaries without the epsilon, mid-frame, before the start and past the end.
    const edge = [];
    for (const [t, want] of [[90 / 30, 90], [91.5 / 30, 91], [0, 0], [-1, 0], [99, 149]]) {
      await P.prepare(list(t));
      const { n } = read(t);
      if (n !== want) edge.push(`${t.toFixed(4)}→${n} (want ${want})`);
    }
    // Backward seeks, then a random far seek.
    const back = [];
    for (const i of [120, 30, 90]) {
      await P.prepare(list(i / 30 + 1e-4));
      const { n } = read(i / 30);
      if (n !== i) back.push(`${i}→${n}`);
    }
    const t1 = performance.now();
    await P.prepare(list(137 / 30 + 1e-4));
    const seekMs = performance.now() - t1;
    const seekOk = read(0).n === 137;
    // 300 sequential requests (60 per second of source): open frames must not grow.
    const opens = [];
    for (let i = 0; i < 300; i++) {
      await P.prepare(list(i / 60));
      if (i % 50 === 0) opens.push(P.stats().openFrames);
      if (read(0).n !== Math.floor(i / 2 + 1e-9)) back.push(`60fps ${i}→${read(0).n}`);
    }
    opens.push(P.stats().openFrames);
    const stats = P.stats();
    P.dispose();
    const after = P.stats().openFrames;
    return { wrong, seqMs, decodeMs, seqSessions, maxOpen, noRedecode, edge, back, seekMs, seekOk, opens, stats, after };
  }, vid);
  check('exact provider: frames 0..149 read back their own number', r.wrong.length === 0, r.wrong.length ? r.wrong.slice(0, 10).join(', ') : `150 frames; decode ${(150000 / r.decodeMs).toFixed(0)} frames/s sequential (${r.decodeMs.toFixed(0)} ms), ${(150000 / r.seqMs).toFixed(0)} frames/s incl. readback`);
  check('sequential decode uses one session and holds one frame', r.seqSessions === 1 && r.maxOpen === 1, `sessions ${r.seqSessions}, max open ${r.maxOpen}`);
  check('same time twice → no decode', r.noRedecode);
  check('exact at frame boundaries, mid-frame, before start, past end', r.edge.length === 0, r.edge.join(', '));
  check('backward seeks (120, 30, 90) and 300 requests at 60/s are exact', r.back.length === 0, r.back.slice(0, 10).join(', '));
  check('random far seek is exact', r.seekOk, `seek to frame 137 took ${r.seekMs.toFixed(0)} ms`);
  check('no VideoFrame build-up over 300 frames; dispose closes all', r.opens.every((n) => n <= 1) && r.after === 0, `open frames ${r.opens.join(',')} → ${r.after} after dispose; ${r.stats.sessions} sessions, ${r.stats.frames} frames delivered`);
}

// --- VP9 clip: sequential frames (5 strip bits fit in 1280 px, so compare mod 32).
const vp9 = imported['clip-720p-vp9.webm'];
if (vp9) {
  const r = await page.evaluate(async (id) => {
    const P = window.__glyphix.video.createExactFrames();
    const wrong = [];
    let bits = 0;
    const t0 = performance.now();
    for (let i = 0; i < 90; i++) {
      await P.prepare({ items: [{ kind: 'image', id: 'L', assetId: id, video: { time: i / 30 + 1e-4 } }] });
      const s = window.__v.strip(P.frame('L', id, 0), 1280, 120);
      bits = s.bits;
      if (s.n !== i % (1 << s.bits)) wrong.push(`${i}→${s.n}`);
    }
    const ms = performance.now() - t0;
    P.dispose();
    return { wrong, bits, ms };
  }, vp9);
  check('VP9 WebM: frames 0..89 exact', r.wrong.length === 0, r.wrong.length ? r.wrong.slice(0, 10).join(', ') : `${r.bits} strip bits, ${(90000 / r.ms).toFixed(0)} frames/s`);
}

// --- Through the renderer: exact frame, right way up, on WebGPU and WebGL2; poster before the first decode.
if (vid) {
  const kinds = webgl ? [true] : [false, true];
  for (const forceWebGL of kinds) {
    const r = await page.evaluate(
      async ([id, forceWebGL]) => {
        const { createBackend, renderFrameBitmap } = window.__glyphix.render;
        const { createExactFrames } = window.__glyphix.video;
        const { defaultClip } = await import('/src/doc/index.ts');
        const doc = structuredClone(window.__glyphix.state().doc);
        const src = doc.comp.layers.find((l) => l.type === 'image');
        Object.assign(doc.comp, { width: 1920, height: 1080, duration: 5 });
        doc.comp.layers = [{
          ...src, id: 'V', assetId: id, video: defaultClip(5, doc.comp), crop: { x: 0, y: 0, w: 1, h: 1 },
          width: 1920, height: 1080, radius: { static: 0 }, shadow: null, border: null, effects: [],
          frame: { kind: 'none', url: '' },
          tilt: { rotateX: { static: 0 }, rotateY: { static: 0 }, perspective: src.tilt.perspective },
          motion: { enter: null, exit: null, loop: null }, opacity: { static: 1 },
          transform: { x: { static: 960 }, y: { static: 540 }, scale: { static: 1 }, rotation: { static: 0 } },
        }];
        const frames = createExactFrames();
        const b = await createBackend({ canvas: document.createElement('canvas'), fullResAssets: true, forceWebGL, frames });
        b.setSize(960, 540, 1);
        const read = (bmp) => {
          const top = window.__v.strip(bmp, 960, 60, 1920);
          // Upside down would put the strip at the bottom: there the frame shows the test pattern.
          const c = new OffscreenCanvas(960, 540);
          const g = c.getContext('2d');
          g.drawImage(bmp, 0, 0);
          const px = g.getImageData(0, 0, 960, 540).data;
          let bottomBinary = 0;
          for (let x = 60; x < 960; x += 120) {
            const i = (510 * 960 + x) * 4;
            const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
            if (l < 8 || l > 247) bottomBinary++;
          }
          return { n: top.n, bottomBinary };
        };
        // Poster: a provider with no frames shows the asset's poster (frame 0).
        const none = { prepare: async () => {}, frame: () => null, version: 0, dispose() {} };
        const pb = await createBackend({ canvas: document.createElement('canvas'), fullResAssets: true, forceWebGL, frames: none });
        pb.setSize(960, 540, 1);
        const poster = read(await renderFrameBitmap(pb, doc, 3));
        pb.dispose();
        const results = [];
        for (const i of [0, 1, 59, 60, 61, 149, 120, 30, 90]) {
          const t0 = performance.now();
          const bmp = await renderFrameBitmap(b, doc, i / 30 + 1e-4);
          results.push({ i, ms: performance.now() - t0, ...read(bmp) });
        }
        const kind = b.kind;
        b.dispose();
        frames.dispose();
        return { kind, poster, results };
      },
      [vid, forceWebGL],
    );
    const wrong = r.results.filter((x) => x.n !== x.i).map((x) => `${x.i}→${x.n}`);
    const flipped = r.results.filter((x) => x.bottomBinary > 4).length;
    check(`${r.kind}: renderer shows the exact frame, top strip at the top`, wrong.length === 0 && flipped === 0, wrong.length ? wrong.join(', ') : `frames ${r.results.map((x) => x.i).join(',')}; ${r.results.map((x) => x.ms.toFixed(0)).join('/')} ms`);
    check(`${r.kind}: poster shows frame 0 until a frame is decoded`, r.poster.n === 0 && r.poster.bottomBinary <= 4, `strip ${r.poster.n}`);
  }
}

// --- Persistence: a video layer survives reload.
if (vid) {
  const before = await page.evaluate(async (id) => {
    const { defaultClip } = await import('/src/doc/index.ts');
    const g = window.__glyphix;
    const s = g.editor.getState();
    const i = s.doc.comp.layers.findIndex((l) => l.type === 'image');
    s.set('Video', [
      { path: ['comp', 'layers', i, 'assetId'], value: id },
      { path: ['comp', 'layers', i, 'video'], value: defaultClip(5, s.doc.comp) },
    ]);
    return { layerId: s.doc.comp.layers[i].id, meta: g.video.videoMeta(id) };
  }, vid);
  await page.waitForFunction(() => window.__glyphix.saveState() !== 'saved', null, { timeout: 5000 }).catch(() => {});
  await ready();
  await page.reload();
  await ready();
  const after = await page.evaluate(async ([id, layerId]) => {
    const g = window.__glyphix;
    const layer = g.state().doc.comp.layers.find((l) => l.id === layerId);
    const P = g.video.createExactFrames();
    await P.prepare({ items: [{ kind: 'image', id: 'L', assetId: id, video: { time: 75 / 30 + 1e-4 } }] });
    const f = P.frame('L', id, 0);
    const c = new OffscreenCanvas(1920, 120);
    const cg = c.getContext('2d');
    if (f) cg.drawImage(f, 0, 0, 1920, 120, 0, 0, 1920, 120);
    const px = cg.getImageData(0, 0, 1920, 120).data;
    let frame = 0;
    for (let k = 0; k < 8; k++) if (px[(60 * 1920 + 240 * k + 120) * 4] > 128) frame |= 1 << k;
    P.dispose();
    return { inStore: g.assets().includes(id), meta: g.video.videoMeta(id), assetId: layer?.assetId, video: layer?.video, frame };
  }, [vid, before.layerId]);
  check('reload: video asset restored (poster + meta) and the layer still references it', after.inStore && JSON.stringify(after.meta) === JSON.stringify(before.meta) && after.assetId === vid && after.video?.out === 5, JSON.stringify(after.meta));
  check('reload: frames decode from the restored file', after.frame === 75, `frame ${after.frame}`);

  // .glyphix round-trip keeps the video bytes identical.
  const rt = await page.evaluate(async (id) => {
    const pf = await import('/src/persistence/projectFile.ts');
    const hex = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const original = await (await fetch('/scripts/fixtures/clip-1080p30.mp4')).blob();
    const t0 = performance.now();
    const file = await pf.writeProjectFile(window.__glyphix.state().doc);
    const writeMs = performance.now() - t0;
    const { doc, assets } = await pf.readProjectFile(file);
    const a = assets.find((x) => x.id === id);
    return {
      fileSize: file.size,
      videoSize: original.size,
      writeMs,
      same: !!a && (await hex(a.blob)) === (await hex(original)),
      type: a?.blob.type,
      layer: doc.comp.layers.some((l) => l.assetId === id && l.video),
    };
  }, vid);
  check('.glyphix round-trip: video bytes identical, typed video/mp4, layer kept', rt.same && rt.type === 'video/mp4' && rt.layer, `${rt.type}; project ${(rt.fileSize / 1e6).toFixed(2)} MB for a ${(rt.videoSize / 1e6).toFixed(2)} MB video (stored, not deflated); written in ${rt.writeMs.toFixed(0)} ms`);
  check('video stored without deflate', rt.fileSize >= rt.videoSize);
}

console.log(errors.length ? `page errors:\n${errors.slice(0, 10).join('\n')}` : 'no page errors');
if (errors.length) failures++;
await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
