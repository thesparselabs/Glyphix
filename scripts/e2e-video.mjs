// Milestone F end to end in the editor: import a video through the toolbar, the paused preview shows the
// exact frame, playback stays in sync with the timeline, the Video section edits the clip, reload restores
// it, and an exported still shows the same frame.
// Needs scripts/fixtures (run scripts/make-video-fixtures.sh). Usage: node scripts/e2e-video.mjs [baseUrl] [outDir]
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { browserName, launch } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.argv[3] ?? '.';
const fixture = fileURLToPath(new URL('./fixtures/clip-1080p30.mp4', import.meta.url));
if (!existsSync(fixture)) {
  console.log('FAIL fixtures missing — run scripts/make-video-fixtures.sh');
  process.exit(1);
}
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const state = () => page.evaluate(() => window.__glyphix.state());
const selected = () => page.evaluate(() => { const s = window.__glyphix.state(); return s.doc.comp.layers.find((l) => l.id === s.selectedId); });
const ready = () => page.waitForFunction(() => window.__glyphix && window.__glyphix.saveState() === 'saved');
// Headless Firefox reads its WebGPU/WebGL canvas back blank (a harness limit); preview pixel checks skip there.
const canvasReadable = browserName !== 'firefox';

await page.goto(base);
await ready();
await page.keyboard.press('Space'); // pause
await page.evaluate(() => window.__glyphix.select(null));

// --- Import through the toolbar's file picker.
const chooser = page.waitForEvent('filechooser');
await page.getByRole('button', { name: 'Add image or video' }).click();
await (await chooser).setFiles(fixture);
await page.waitForFunction(() => { const s = window.__glyphix.state(); return s.doc.comp.layers.find((l) => l.id === s.selectedId)?.video; }, null, { timeout: 60000 });
let layer = await selected();
check('toolbar imports a video as a selected layer', layer.type === 'image' && layer.assetId.startsWith('vid-') && layer.video.out > 4.9, JSON.stringify(layer.video));
check('Video section shows the file', await page.getByText(/1920×1080 · 5\.0 s/).isVisible());
check('layer list shows it', await page.getByRole('button', { name: /clip-1080p30/ }).first().isVisible());
const id = layer.id;

// Make the layer fill the comp, flat, so the frame-number strip is easy to find on screen.
await page.evaluate((id) => {
  const ed = window.__glyphix.editor.getState();
  const i = ed.doc.comp.layers.findIndex((l) => l.id === id);
  const p = (k, value) => ({ path: ['comp', 'layers', i, k], value });
  ed.set('test layout', [
    p('width', 1920), p('height', 1080), p('radius', { static: 0 }), p('shadow', null), p('motion', { enter: null, exit: null, loop: null }),
    p('transform', { x: { static: 960 }, y: { static: 540 }, scale: { static: 1 }, rotation: { static: 0 } }),
  ]);
  // Hide the headline so it doesn't cover the strip.
  const h = ed.doc.comp.layers.findIndex((l) => l.id === 'headline');
  if (h >= 0) ed.set('hide', [{ path: ['comp', 'layers', h, 'visible'], value: false }]);
}, id);

/** Frame number shown in the preview: sample the 8 strip blocks on a screenshot of the canvas. */
async function previewFrame() {
  const [v, box] = await Promise.all([page.evaluate(() => window.__glyphix.view()), page.locator('canvas').first().boundingBox()]);
  const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  return page.evaluate(
    async ({ b64, v }) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const s = bmp.width / (await (async () => document.querySelector('canvas').clientWidth)());
      let n = 0;
      for (let k = 0; k < 8; k++) {
        const x = (v.offsetX + (k + 0.5) * 240 * v.zoom) * s;
        const y = (v.offsetY + 60 * v.zoom) * s;
        const [r, gg, b] = g.getImageData(Math.round(x), Math.round(y), 1, 1).data;
        if ((r + gg + b) / 3 > 128) n |= 1 << k;
      }
      return n;
    },
    { b64: png.toString('base64'), v },
  );
}

/** Poll the preview until it shows `want` (a seek decodes from the key frame: allow a few seconds under load). */
async function waitFrame(want, timeout = 6000) {
  const end = Date.now() + timeout;
  let got = -1;
  while (Date.now() < end) {
    got = await previewFrame();
    if (got === want) break;
    await page.waitForTimeout(100);
  }
  return got;
}

// --- Paused / scrubbed: the exact frame (via the decoder), including backwards jumps.
if (canvasReadable) {
  const shown = [];
  for (const f of [0, 45, 46, 120, 30, 149]) {
    await page.evaluate((t) => window.__glyphix.setTime(t), (f + 0.25) / 30);
    shown.push([f, await waitFrame(f)]);
  }
  check('paused preview shows the exact frame (incl. backwards seeks)', shown.every(([a, b]) => a === b), shown.map(([a, b]) => `${a}→${b}`).join(' '));
} else console.log('SKIP paused preview frame check — headless Firefox canvas reads back blank');

// --- Playing, the way a user starts it: paused on a frame that is shown, then Play.
await page.evaluate(() => window.__glyphix.setTime(0));
if (canvasReadable) await waitFrame(0);
else await page.waitForTimeout(1500);
await page.evaluate(() => window.__glyphix.editor.getState().setPlaying(true));
await page.waitForTimeout(500);
await page.evaluate(() => { window.__glyphixFrames.takeStats(); window.__glyphixAudio.drift.length = 0; });
const t0 = (await state()).time;
await page.waitForTimeout(2500);
const sync = await page.evaluate(() => {
  const s = { ...window.__glyphixFrames.takeStats(), sound: window.__glyphixAudio.drift.splice(0) };
  const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor((b.length - 1) * p)] ?? Infinity; };
  return { frames: s.frames, pic95: q(s.picture, 0.95), picMax: q(s.picture, 1), snd50: q(s.sound, 0.5), snd95: q(s.sound, 0.95), sndN: s.sound.length };
});
const t1 = (await state()).time;
const playedFrame = canvasReadable ? await previewFrame() : null;
await page.evaluate(() => window.__glyphix.editor.getState().setPlaying(false));
const ms = (v) => `${(v * 1000).toFixed(0)} ms`;
const expected = (t1 - t0) * 30;
// Headless Firefox renders the editor at ≤ 30 fps even without video (software paths), so playback
// smoothness is reported there, not gated. Frame exactness (paused, scrubbed, exported) is gated everywhere.
const smooth = browserName === 'firefox' ? (name, ok, detail) => console.log(`INFO ${name} — ${ok ? 'ok' : 'NOT MET'}: ${detail}`) : check;
smooth('playback draws ≥ 80% of video frames (headless editor renders ~45 fps)', sync.frames >= expected * 0.8, `${sync.frames} frames for ${expected.toFixed(0)} expected, timeline ${t0.toFixed(2)}→${t1.toFixed(2)} s`);
smooth('picture in sync with the timeline (p95 late by < 1 frame)', sync.pic95 < 1 / 30 + 0.002, `p95 ${ms(sync.pic95)}, max ${ms(sync.picMax)}`);

// Cold start (informational): play right after a far jump, so the decoder starts a new session.
await page.evaluate(() => { window.__glyphix.setTime(4); window.__glyphixFrames.takeStats(); window.__glyphix.setTime(0.5); window.__glyphix.editor.getState().setPlaying(true); });
const coldStart = Date.now();
let caughtUp = null;
while (Date.now() - coldStart < 4000) {
  await page.waitForTimeout(100);
  const late = await page.evaluate(() => window.__glyphixFrames.takeStats().picture);
  if (late.length && Math.max(...late) < 1 / 30) { caughtUp = Date.now() - coldStart; break; }
}
await page.evaluate(() => window.__glyphix.editor.getState().setPlaying(false));
console.log(`INFO cold start after a far jump: in sync after ${caughtUp ?? '> 4000'} ms`);
check('sound follows the timeline (p95 < 80 ms)', sync.sndN > 10 && sync.snd95 < 0.08, `p50 ${ms(sync.snd50)}, p95 ${ms(sync.snd95)} over ${sync.sndN} samples`);
if (canvasReadable) check('playing preview shows a moving frame', playedFrame > 30, `frame ${playedFrame}`);

// --- Video section edits.
await page.evaluate((id) => window.__glyphix.select(id), id);
await page.getByRole('slider', { name: 'Trim start' }).focus();
for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
layer = await selected();
check('trim start by keyboard', Math.abs(layer.video.in - 1) < 0.02, `in ${layer.video.in.toFixed(3)}`);
if (canvasReadable) {
  await page.evaluate(() => window.__glyphix.setTime(0.01));
  check('trimmed clip starts at the new in point', (await waitFrame(30)) === 30);
}
await page.getByRole('switch', { name: 'Loop' }).click();
await page.getByRole('switch', { name: 'Mute' }).click();
layer = await selected();
check('loop and mute switches', layer.video.loop === true && layer.video.muted === true, JSON.stringify(layer.video));
await page.getByRole('button', { name: /Make the canvas 4\.0 s long/ }).click();
check('match canvas length to the clip', Math.abs((await state()).doc.comp.duration - 4) < 0.02, `${(await state()).doc.comp.duration}`);

// --- Exported still = the frame the timeline shows.
const exported = await page.evaluate(async () => {
  const { exportStill } = await import('/src/export/exporter.ts');
  const doc = window.__glyphix.state().doc;
  const r = await exportStill(doc, { format: 'png', scale: 1, quality: 1, transparent: false, time: 2 + 0.25 / 30 });
  const bmp = await createImageBitmap(r.blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  let n = 0;
  for (let k = 0; k < 8; k++) if (g.getImageData(k * 240 + 120, 60, 1, 1).data[0] > 128) n |= 1 << k;
  return n;
});
check('exported still shows the exact frame', exported === 90, `frame ${exported} (want 30 + 60)`);

// --- Exported video (MP4 and WebM) is frame-exact: decode it and read the frame code of several frames.
for (const container of ['mp4', 'webm']) {
  const r = await page.evaluate(async (container) => {
    const { exportVideo, mediabunny: mb } = window.__glyphix.export;
    const doc = window.__glyphix.state().doc; // trimmed clip: in 1 s, comp 4 s
    const out = await exportVideo(doc, { scale: 0.5, container, transparent: false });
    const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(out.blob) });
    const track = await input.getPrimaryVideoTrack();
    const sink = new mb.CanvasSink(track);
    const got = [];
    for (const i of [0, 1, 37, 59, 89, 119]) {
      const w = await sink.getCanvas((i + 0.5) / 30);
      const g = w.canvas.getContext('2d');
      let n = 0;
      // Half scale: blocks are 120 px wide, the strip 60 px high.
      for (let k = 0; k < 8; k++) if (g.getImageData(k * 120 + 60, 30, 1, 1).data[0] > 128) n |= 1 << k;
      got.push([i, n]);
    }
    return { got, frames: (await track.computePacketStats()).packetCount, hasAudio: !!(await input.getPrimaryAudioTrack()) };
  }, container);
  // Comp frame i shows source frame 30 + i (trim in = 1 s); the clip is muted, so no audio track.
  const bad = r.got.filter(([i, n]) => n !== 30 + i);
  check(`exported ${container.toUpperCase()} is frame-exact`, bad.length === 0 && r.frames === 120 && !r.hasAudio, `${r.frames} frames; ${r.got.map(([i, n]) => `${i}→${n}`).join(' ')}`);
}

// --- Persistence.
await page.waitForTimeout(1000);
await ready();
const before = JSON.stringify((await state()).doc.comp.layers.find((l) => l.id === id));
await page.reload();
await ready();
const after = (await state()).doc.comp.layers.find((l) => l.id === id);
check('video layer survives reload', JSON.stringify(after) === before);
check('video file is back in memory', (await page.evaluate((a) => window.__glyphix.assets().includes(a), after.assetId)));
if (canvasReadable) {
  await page.evaluate(() => { window.__glyphix.editor.getState().setPlaying(false); window.__glyphix.setTime(1 + 0.25 / 30); });
  check('after reload the preview shows the exact frame', (await waitFrame(60, 10000)) === 60);
}
await page.screenshot({ path: `${out}/e2e-video.png` });

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
