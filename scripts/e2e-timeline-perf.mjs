// Timeline stress check (Milestone H gate): 50 layers × 10 keyed properties (2,000 keys), every layer expanded.
// Playback with the timeline open must stay within 5 % of collapsed; dragging a key and scrubbing stay smooth.
// 47 of the layers are hidden so the numbers measure the timeline, not the renderer.
// Usage: [EXPAND=n] node scripts/e2e-timeline-perf.mjs [baseUrl]   (EXPAND: how many layers to open, default 50;
// small timelines render every row, large ones only the rows near the viewport)
import { browserName, launch } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const EXPAND = Number(process.env.EXPAND ?? 50);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
// Speed gates apply to Chrome, like the export speed check. Headless Firefox is limited by its own rendering: it takes
// ~33 ms to draw a new time even with the timeline collapsed, and with the track area merely invisible playback is
// already ~93 % of collapsed (software compositing of the larger page), so its numbers are logged, not gated.
const speed = (name, ok, detail) => (browserName === 'firefox' ? console.log(`INFO ${name} — ${detail} (gate applies to Chrome)`) : check(name, ok, detail));

await page.goto(base);
await page.waitForFunction(() => window.__glyphix && window.__glyphix.view().zoom < 1, null, { timeout: 30000 });

await page.evaluate(async () => {
  const { createDemoDoc, createEffect, Easings } = await import('/src/doc/index.ts');
  const doc = createDemoDoc();
  const shot = doc.comp.layers.find((l) => l.id === 'shot');
  const track = (a, b) => ({ track: { keys: [0, 1.2, 2.6, 4].map((t, i) => ({ t: t + Math.random() * 0.3, v: i % 2 ? b : a, out: Easings.easeInOutCubic })) } });
  const layers = [];
  for (let n = 0; n < 50; n++) {
    const fx = createEffect('vignette');
    for (const k of Object.keys(fx.params).slice(0, 3)) fx.params[k] = track(0, 0.5);
    layers.push({
      ...structuredClone(shot),
      id: `stress-${n}`,
      name: `Layer ${n}`,
      visible: n < 3,
      opacity: track(0.5, 1),
      transform: { ...shot.transform, x: track(900, 1000), y: track(600, 680), scale: track(0.5, 0.6), rotation: track(-4, 4) },
      tilt: { ...shot.tilt, rotateX: track(0, 10), rotateY: track(0, -10) },
      effects: [fx],
    });
  }
  doc.comp.layers = [doc.comp.layers[0], ...layers];
  const s = window.__glyphix.editor.getState();
  s.loadDoc(doc);
  s.setPlaying(false);
});
const props = await page.evaluate(async () => {
  const { animatableProps } = await import('/src/doc/index.ts');
  const l = window.__glyphix.state().doc.comp.layers[1];
  return { props: animatableProps(l).length, keyed: animatableProps(l).filter((p) => 'track' in p.path.reduce((o, k) => o[k], l)).length };
});
// The list is virtualized: scroll each layer into view (bottom up, so nothing above has moved yet) and expand it.
for (let n = 0; n < EXPAND; n++) {
  await page.evaluate((y) => (document.querySelector('[data-timeline-scroller]').scrollTop = y), (49 - n) * 28);
  await page.getByRole('button', { name: `Show Layer ${n} properties`, exact: true }).click();
}
await page.evaluate(() => (document.querySelector('[data-timeline-scroller]').scrollTop = 0));
await page.waitForTimeout(300);
const keyCount = await page.locator('[data-key]').count();
check(
  `stress doc: ${EXPAND} of 50 layers expanded, 10 keyed properties each; only rows near the view rendered`,
  props.keyed >= 10 && keyCount < 600,
  `${props.keyed} keyed of ${props.props} properties; ${keyCount} of ${EXPAND * 40} key diamonds in the DOM`,
);

// Selecting a layer elsewhere (Layers panel, canvas) scrolls its timeline row into view and into the DOM.
await page.evaluate(() => (document.querySelector('[data-timeline-scroller]').scrollTop = 0));
await page.evaluate(() => window.__glyphix.select('stress-0'));
await page.waitForTimeout(300);
const bar0 = page.getByRole('button', { name: /^Layer 0: on screen/ });
const inView = (await bar0.count()) === 1 && (await bar0.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const s = document.querySelector('[data-timeline-scroller]').getBoundingClientRect();
  return r.top >= s.top && r.bottom <= s.bottom;
}));
check('selecting an off-screen layer scrolls its row into view', inView);
await page.evaluate(() => window.__glyphix.select(null));

/** rAF intervals (ms) while `during` runs. */
const frames = async (during) => {
  await page.evaluate(() => {
    window.__ft = [];
    let last = 0;
    const tick = (now) => {
      if (last) window.__ft.push(now - last);
      last = now;
      if (window.__ft) window.__rafId = requestAnimationFrame(tick);
    };
    window.__rafId = requestAnimationFrame(tick);
  });
  await during();
  return page.evaluate(() => {
    cancelAnimationFrame(window.__rafId);
    const ft = window.__ft.slice(5).sort((a, b) => a - b);
    window.__ft = null;
    const q = (p) => ft[Math.min(ft.length - 1, Math.floor(p * ft.length))];
    return { n: ft.length, p50: q(0.5), p95: q(0.95), fps: 1000 / (ft.reduce((a, b) => a + b, 0) / ft.length) };
  });
};
const play = (ms) => async () => {
  await page.evaluate(() => window.__glyphix.editor.getState().setPlaying(true));
  await page.waitForTimeout(ms);
  await page.evaluate(() => window.__glyphix.editor.getState().setPlaying(false));
};

// Playback, open vs collapsed (alternating, best of two each, to dampen machine noise).
const open1 = await frames(play(3000));
await page.getByRole('button', { name: 'Collapse timeline' }).click();
const closed1 = await frames(play(3000));
await page.getByRole('button', { name: 'Expand timeline' }).click();
const open2 = await frames(play(3000));
await page.getByRole('button', { name: 'Collapse timeline' }).click();
const closed2 = await frames(play(3000));
await page.getByRole('button', { name: 'Expand timeline' }).click();
const open = Math.max(open1.fps, open2.fps);
const closed = Math.max(closed1.fps, closed2.fps);
speed('playback with the timeline open is within 5 % of collapsed', open >= closed * 0.95, `${open.toFixed(1)} fps open vs ${closed.toFixed(1)} collapsed`);

// Drag a key of an expanded layer for ~1 s.
await page.evaluate(() => window.__glyphix.setTime(4.9));
const key = page.locator(`[data-key^="opacity|"][data-layer="stress-${EXPAND - 1}"]`).nth(1);
await key.scrollIntoViewIfNeeded();
const kb = await key.boundingBox();
const drag = await frames(async () => {
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 60; i++) await page.mouse.move(kb.x + kb.width / 2 + i * 3, kb.y + kb.height / 2);
  await page.mouse.up();
});
speed('dragging a key stays smooth (p50 ≤ 17.5 ms)', drag.p50 <= 17.5, `p50 ${drag.p50.toFixed(1)} ms, p95 ${drag.p95.toFixed(1)} ms over ${drag.n} frames`);
check('the key drag is one undo step', await page.evaluate((id) => {
  const opacity = () => window.__glyphix.state().doc.comp.layers.find((l) => l.id === id).opacity;
  const before = JSON.stringify(opacity());
  window.__glyphix.editor.getState().undo();
  const after = JSON.stringify(opacity());
  window.__glyphix.editor.getState().redo();
  return before !== after && opacity().track.keys.length === 4;
}, `stress-${EXPAND - 1}`));

// Scrub the ruler for ~1 s.
const ruler = page.getByRole('slider', { name: 'Playhead' });
const rb = await ruler.boundingBox();
const scrub = await frames(async () => {
  await page.mouse.move(rb.x + 10, rb.y + rb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 60; i++) await page.mouse.move(rb.x + 10 + i * 12, rb.y + rb.height / 2);
  await page.mouse.up();
});
speed('scrubbing stays smooth (p50 ≤ 17.5 ms)', scrub.p50 <= 17.5, `p50 ${scrub.p50.toFixed(1)} ms, p95 ${scrub.p95.toFixed(1)} ms over ${scrub.n} frames`);

console.log(errors.length ? `page errors:\n${errors.slice(0, 10).join('\n')}` : 'no page errors');
if (errors.length) failures++;
await browser.close();
process.exit(failures ? 1 : 0);
