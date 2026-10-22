// Milestone F+ (F+4): animated GIFs as video-like layers, and the one-click "Turn into ASCII" flow.
// Imports the GIF fixture through the toolbar, reads frame N back exactly from the provider, the renderer
// (WebGPU and WebGL2) and an exported still, trim/loop, reload persistence, the .glyphix round-trip, a
// one-frame GIF staying a plain image, and "Turn into ASCII" by keyboard being one undo step.
// Needs scripts/fixtures (run scripts/make-video-fixtures.sh). The fixture's top 30 px encode the frame
// number: 8 blocks of 40 px, bit k = block k, white = 1.
// Usage: node scripts/e2e-gif.mjs [baseUrl]   (BROWSER=firefox for Firefox; add ?webgl to the URL to force WebGL2)
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { browserName, launch } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const fixture = fileURLToPath(new URL('./fixtures/clip-12fps.gif', import.meta.url));
if (!existsSync(fixture)) {
  console.log('FAIL fixtures missing — run scripts/make-video-fixtures.sh');
  process.exit(1);
}
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.setDefaultNavigationTimeout(120000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const KNOWN = /conflicting property is set/; // Inspector's background swatch, not GIF code
page.on('console', (m) => ((m.type() === 'error' && !KNOWN.test(m.text())) || /garbage collected without being closed/i.test(m.text())) && errors.push(m.text()));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const ready = () => page.waitForFunction(() => window.__glyphix && window.__glyphix.saveState() === 'saved', null, { timeout: 90000 });
const state = () => page.evaluate(() => window.__glyphix.state());
const selected = () => page.evaluate(() => { const s = window.__glyphix.state(); return s.doc.comp.layers.find((l) => l.id === s.selectedId); });

await page.goto(base);
await ready();
await page.keyboard.press('Space'); // pause
await page.evaluate(() => window.__glyphix.select(null));
const webgl = await page.evaluate(() => window.__glyphix.editor.getState().forceWebGL);
console.log(`browser: ${browserName}${webgl ? ' (?webgl)' : ''}`);

// Frame number in the 320 px wide strip of anything drawable (w px wide for a 320 px source).
await page.evaluate(() => {
  window.__v = {
    strip(src, w) {
      const stripH = Math.round((30 * w) / 320);
      const c = new OffscreenCanvas(w, stripH);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(src, 0, 0, w, stripH, 0, 0, w, stripH);
      const data = g.getImageData(0, 0, w, stripH).data;
      const block = (40 * w) / 320;
      let n = 0;
      for (let k = 0; k < 8; k++) {
        const i = (Math.floor(stripH / 2) * w + Math.floor((k + 0.5) * block)) * 4;
        if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] > 128) n |= 1 << k;
      }
      return n;
    },
  };
});

// --- Import through the toolbar's file picker.
const chooser = page.waitForEvent('filechooser');
await page.getByRole('button', { name: 'Add image or video' }).click();
await (await chooser).setFiles(fixture);
await page.waitForFunction(() => { const s = window.__glyphix.state(); return s.doc.comp.layers.find((l) => l.id === s.selectedId)?.video; }, null, { timeout: 90000 });
let layer = await selected();
const id = layer.assetId;
check('animated GIF becomes a video layer (vid- asset, clip 0..2 s, looping)', layer.type === 'image' && /^vid-[0-9a-f]{20}$/.test(id) && Math.abs(layer.video.out - 2) < 0.01 && layer.video.loop === true && layer.video.in === 0, JSON.stringify(layer.video));
check('Video section describes the GIF', await page.getByText(/320×180 · 2\.0 s · GIF · no sound/).isVisible());
const meta = await page.evaluate((id) => window.__glyphix.video.videoMeta(id), id);
check('meta: 320×180, 2 s, 12 fps, no audio', meta.width === 320 && meta.height === 180 && Math.abs(meta.duration - 2) < 0.01 && meta.fps === 12 && meta.hasAudio === false && meta.codec === 'gif', JSON.stringify(meta));

// --- Exact frames straight from the provider.
{
  const r = await page.evaluate(async (id) => {
    const P = window.__glyphix.video.createExactFrames();
    const list = (t) => ({ items: [{ kind: 'image', id: 'L', assetId: id, video: { time: t } }] });
    const read = () => window.__v.strip(P.frame('L', id, 0), 320);
    // GIF delays are whole centiseconds (8 or 9 cs for "12 fps"): frame starts come from the file itself.
    const { decodeGif } = await import('/src/video/gifDecoder.ts');
    const gif = decodeGif(new Uint8Array(await (await fetch('/scripts/fixtures/clip-12fps.gif')).arrayBuffer()));
    const T = gif.frames.map((f) => f.time);
    const D = gif.frames.map((f) => f.duration);
    const wrong = [];
    for (let i = 0; i < 24; i++) {
      await P.prepare(list(T[i] + 1e-4));
      if (read() !== i) wrong.push(`${i}→${read()}`);
    }
    const edge = [];
    for (const [t, want] of [[T[5], 5], [T[5] + D[5] / 2, 5], [0, 0], [-1, 0], [99, 23], [T[23], 23], [T[23] + D[23] - 0.001, 23]]) {
      await P.prepare(list(t));
      if (read() !== want) edge.push(`${t.toFixed(4)}→${read()} (want ${want})`);
    }
    for (const i of [20, 3, 11]) {
      await P.prepare(list(T[i] + 1e-4));
      if (read() !== i) edge.push(`back ${i}→${read()}`);
    }
    const v0 = P.version;
    await P.prepare(list(T[11] + 1e-4));
    const noRedecode = P.version === v0;
    const span = P.frameSpan('L');
    P.dispose();
    return { wrong, edge, noRedecode, span, after: P.frame('L', id, 0) };
  }, id);
  check('provider: frames 0..23 read back their own number', r.wrong.length === 0, r.wrong.join(', '));
  check('provider: frame boundaries, mid-frame, before start, past end, backward seeks', r.edge.length === 0, r.edge.join(', '));
  check('provider: same frame again → no new upload; frameSpan is the 8-9 cs frame', r.noRedecode && r.span.duration > 0.079 && r.span.duration < 0.091, JSON.stringify(r.span));
}

// --- Through the renderer on WebGPU and WebGL2, and an exported still.
const kinds = webgl ? [true] : [false, true];
for (const forceWebGL of kinds) {
  const r = await page.evaluate(
    async ([id, forceWebGL]) => {
      const { createBackend, renderFrameBitmap } = window.__glyphix.render;
      const { createExactFrames } = window.__glyphix.video;
      const { defaultClip } = await import('/src/doc/index.ts');
      const doc = structuredClone(window.__glyphix.state().doc);
      const src = doc.comp.layers.find((l) => l.type === 'image');
      Object.assign(doc.comp, { width: 320, height: 180, duration: 2 });
      doc.comp.layers = [{
        ...src, id: 'V', assetId: id, video: defaultClip(2, doc.comp), crop: { x: 0, y: 0, w: 1, h: 1 },
        width: 320, height: 180, radius: { static: 0 }, shadow: null, border: null, effects: [],
        frame: { kind: 'none', url: '' },
        tilt: { rotateX: { static: 0 }, rotateY: { static: 0 }, perspective: src.tilt.perspective },
        motion: { enter: null, exit: null, loop: null }, opacity: { static: 1 },
        transform: { x: { static: 160 }, y: { static: 90 }, scale: { static: 1 }, rotation: { static: 0 } },
      }];
      const frames = createExactFrames();
      const b = await createBackend({ canvas: document.createElement('canvas'), fullResAssets: true, forceWebGL, frames });
      b.setSize(320, 180, 1);
      const out = [];
      const { decodeGif } = await import('/src/video/gifDecoder.ts');
      const T = decodeGif(new Uint8Array(await (await fetch('/scripts/fixtures/clip-12fps.gif')).arrayBuffer())).frames.map((f) => f.time);
      for (const i of [0, 1, 7, 23, 12, 3]) {
        const bmp = await renderFrameBitmap(b, doc, T[i] + 1e-4);
        out.push([i, window.__v.strip(bmp, 320)]);
      }
      const kind = b.kind;
      b.dispose();
      frames.dispose();
      return { kind, out };
    },
    [id, forceWebGL],
  );
  const wrong = r.out.filter(([a, b]) => a !== b).map(([a, b]) => `${a}→${b}`);
  check(`${r.kind}: renderer shows the exact GIF frame`, wrong.length === 0, wrong.join(', ') || r.out.map(([a]) => a).join(','));
}
{
  const r = await page.evaluate(async (id) => {
    const { exportStill } = await import('/src/export/exporter.ts');
    const { defaultClip } = await import('/src/doc/index.ts');
    const doc = structuredClone(window.__glyphix.state().doc);
    const src = doc.comp.layers.find((l) => l.type === 'image');
    Object.assign(doc.comp, { width: 320, height: 180, duration: 4 });
    // Clip trimmed to 0.5..2 s (frames 6..23), looping: comp 1.55 s is 0.05 s into the second pass.
    doc.comp.layers = [{
      ...src, id: 'V', assetId: id, video: { ...defaultClip(2, doc.comp), in: 0.5, out: 2, loop: true }, crop: { x: 0, y: 0, w: 1, h: 1 },
      width: 320, height: 180, radius: { static: 0 }, shadow: null, border: null, effects: [], frame: { kind: 'none', url: '' },
      tilt: { rotateX: { static: 0 }, rotateY: { static: 0 }, perspective: src.tilt.perspective },
      motion: { enter: null, exit: null, loop: null }, opacity: { static: 1 },
      transform: { x: { static: 160 }, y: { static: 90 }, scale: { static: 1 }, rotation: { static: 0 } },
    }];
    const got = [];
    // Frames 6..23 start at 0.50 s into the file; 0.34 s into the clip is 0.84 s in the file (frame 10).
    for (const [t, want] of [[0.01, 6], [1.45, 23], [1.55, 6], [2.99, 23], [0.34, 10]]) {
      const s = await exportStill(doc, { format: 'png', scale: 1, quality: 1, transparent: false, time: t });
      const bmp = await createImageBitmap(s.blob);
      got.push([t, want, window.__v.strip(bmp, 320)]);
    }
    return got;
  }, id);
  const wrong = r.filter(([, a, b]) => a !== b).map(([t, a, b]) => `t=${t}: ${b} (want ${a})`);
  check('exported stills: trim (in 0.5 s) and loop pick the right frames', wrong.length === 0, wrong.join(', ') || r.map((x) => `${x[0]}→${x[2]}`).join(' '));
}

// --- Persistence: reload keeps the layer and its frames.
{
  await page.evaluate(() => window.__glyphix.setTime(0));
  await page.waitForFunction(() => window.__glyphix.saveState() !== 'saved', null, { timeout: 5000 }).catch(() => {});
  await ready();
  await page.reload();
  await ready();
  const after = await page.evaluate(async (id) => {
    const g = window.__glyphix;
    const l = g.state().doc.comp.layers.find((x) => x.assetId === id);
    const P = g.video.createExactFrames();
    const { decodeGif } = await import('/src/video/gifDecoder.ts');
    const gif = decodeGif(new Uint8Array(await (await fetch('/scripts/fixtures/clip-12fps.gif')).arrayBuffer()));
    await P.prepare({ items: [{ kind: 'image', id: 'L', assetId: id, video: { time: gif.frames[17].time + 1e-4 } }] });
    const f = P.frame('L', id, 0);
    const c = new OffscreenCanvas(320, 30);
    const cg = c.getContext('2d', { willReadFrequently: true });
    cg.drawImage(f, 0, 0);
    const px = cg.getImageData(0, 0, 320, 30).data;
    let n = 0;
    for (let k = 0; k < 8; k++) if (px[(15 * 320 + 40 * k + 20) * 4] > 128) n |= 1 << k;
    P.dispose();
    return { has: !!l, video: l?.video, meta: g.video.videoMeta(id), n };
  }, id);
  check('reload: GIF layer, meta and frames restored', after.has && after.meta?.codec === 'gif' && after.video?.loop === true && after.n === 17, `frame ${after.n}`);
}

// --- .glyphix round-trip keeps the GIF bytes.
{
  const rt = await page.evaluate(async (id) => {
    const pf = await import('/src/persistence/projectFile.ts');
    const hex = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const original = await (await fetch('/scripts/fixtures/clip-12fps.gif')).blob();
    const file = await pf.writeProjectFile(window.__glyphix.state().doc);
    const { doc, assets } = await pf.readProjectFile(file);
    const a = assets.find((x) => x.id === id);
    // Loading the stored bytes back registers the GIF again (as opening a project does).
    return { same: !!a && (await hex(a.blob)) === (await hex(original)), type: a?.blob.type, layer: doc.comp.layers.some((l) => l.assetId === id && l.video) };
  }, id);
  check('.glyphix round-trip: GIF bytes identical, typed image/gif, layer kept', rt.same && rt.type === 'image/gif' && rt.layer, rt.type);
}

// --- A one-frame GIF stays a plain image.
{
  const dot = Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex');
  await page.evaluate(() => window.__glyphix.select(null));
  const ch = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add image or video' }).click();
  await (await ch).setFiles({ name: 'dot.gif', mimeType: 'image/gif', buffer: dot });
  await page.waitForFunction(() => { const s = window.__glyphix.state(); return s.doc.comp.layers.find((l) => l.id === s.selectedId)?.assetId?.startsWith('img-'); }, null, { timeout: 15000 }).catch(() => {});
  const l = await selected();
  check('one-frame GIF stays a plain image layer', l?.type === 'image' && l.assetId.startsWith('img-') && l.video === null, l && `${l.assetId} video=${JSON.stringify(l.video)}`);
}

// --- "Turn into ASCII" by keyboard: one undo step.
{
  await page.evaluate((id) => {
    const s = window.__glyphix.state();
    window.__glyphix.select(s.doc.comp.layers.find((l) => l.assetId === id).id);
  }, id);
  const before = await state();
  const histBefore = await page.evaluate(() => JSON.stringify(window.__glyphix.state().doc));
  const button = page.getByRole('button', { name: 'Turn into ASCII' });
  await button.focus();
  await page.keyboard.press('Enter');
  const after = await state();
  const gl = after.doc.comp.layers.find((l) => l.assetId === id);
  const ascii = gl.effects.filter((e) => e.kind === 'ascii');
  check('Turn into ASCII: canvas = clip size and length, layer fills it, ASCII effect added', after.doc.comp.width === 320 && after.doc.comp.height === 180 && Math.abs(after.doc.comp.duration - 2) < 0.05 && gl.width === 320 && ascii.length === 1 && gl.video.start === 0,
    `${after.doc.comp.width}×${after.doc.comp.height} ${after.doc.comp.duration}s, ${ascii.length} ascii; clip ${JSON.stringify(gl.video)}`);
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() => JSON.stringify(window.__glyphix.state().doc));
  check('one Ctrl+Z restores the document exactly', undone === histBefore);
  void before;
  await page.keyboard.press('Control+Shift+z');
  const redone = await state();
  check('redo re-applies it', redone.doc.comp.layers.find((l) => l.assetId === id).effects.some((e) => e.kind === 'ascii'));
}

console.log(errors.length ? `page errors:\n${errors.slice(0, 10).join('\n')}` : 'no page errors');
if (errors.length) failures++;
await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
