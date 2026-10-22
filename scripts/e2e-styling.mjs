// Styling flows + the Milestone B gate: drop a 4K screenshot, style it, drag it at 60 fps, undo/redo.
// Usage: HEADED=1 node scripts/e2e-styling.mjs [baseUrl] [outDir]
import os from 'node:os';
import { launch } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.argv[3] ?? '.';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (m.text().includes('placed in')) console.log(`  ${m.text()}`);
});
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const state = () => page.evaluate(() => window.__glyphix.state());
const scr = async (x, y) =>
  page.evaluate(([x, y]) => {
    const v = window.__glyphix.view();
    const r = document.querySelector('main canvas').getBoundingClientRect();
    return { x: r.left + v.offsetX + x * v.zoom, y: r.top + v.offsetY + y * v.zoom };
  }, [x, y]);

await page.goto(base);
await page.waitForFunction(() => window.__glyphix);
// The canvas fits the comp once the renderer is up (slow on a busy machine); comp→page coordinates need it.
await page.waitForFunction(() => window.__glyphix.view().zoom < 1, null, { timeout: 30000 });
await page.waitForTimeout(1200);
await page.keyboard.press('Space');
await page.evaluate(() => window.__glyphix.setTime(4));
await page.evaluate(() => window.__glyphix.select(null));

// --- Gate step 1: drop a 4K PNG (generated in-page) onto the canvas, with nothing selected → new layer.
const t0 = Date.now();
await page.evaluate(async () => {
  const c = new OffscreenCanvas(3840, 2160);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 3840, 2160);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(1, '#1e3a8a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 3840, 2160);
  g.fillStyle = '#38bdf8';
  for (let i = 0; i < 40; i++) g.fillRect(200 + i * 85, 1900 - i * 35, 60, i * 35);
  g.fillStyle = '#fff';
  g.font = 'bold 160px sans-serif';
  g.fillText('4K dashboard', 200, 300);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const file = new File([blob], '4k-dashboard.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await page.waitForFunction(() => window.__glyphix.state().doc.comp.layers.length === 4, null, { timeout: 10000 });
const s1 = await state();
const added = s1.doc.comp.layers[3];
check('4K drop adds a selected image layer', added.type === 'image' && s1.selectedId === added.id, `${added.name} ${Math.round(added.width)}×${Math.round(added.height)} in ${Date.now() - t0} ms (incl. PNG encode)`);

// --- Style it via the inspector.
await page.getByRole('group', { name: 'Frame' }).getByRole('button', { name: 'Browser', exact: true }).click();
await page.getByLabel('Address').fill('acme.app/dashboard');
await page.getByRole('group', { name: 'Shadow preset' }).getByRole('button', { name: 'Float', exact: true }).click();
await page.getByRole('group', { name: 'Tilt preset' }).getByRole('button', { name: 'Hero', exact: true }).click();
const padding = page.getByLabel('Padding');
await padding.focus();
await padding.fill('160');
let l = (await state()).doc.comp.layers[3];
check('frame / shadow / tilt applied', l.frame.kind === 'browser-light' && l.frame.url === 'acme.app/dashboard' && l.shadow?.blur?.static === 140 && l.tilt.rotateX.static === 18);
const card = l.width + 0; // width at padding 160
check('padding fits the card', Math.abs((1920 - card) / 2 - 160) < 2 || Math.abs((1080 - (l.height + Math.round(Math.min(72, Math.max(22, l.width * 0.042))))) / 2 - 160) < 2, `width=${Math.round(l.width)}`);

// Background from screenshot palette (select nothing → canvas/background inspector).
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Mesh', exact: true }).click();
let bg = (await state()).doc.comp.layers[0];
check('mesh background', bg.fill.kind === 'mesh');
await page.getByRole('button', { name: /Apply .* background 1$/ }).first().click();
bg = (await state()).doc.comp.layers[0];
check('palette suggestion applied', bg.fill.kind === 'linear');
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/style-browser-hero.png` });

// Canvas preset.
await page.getByRole('group', { name: 'Canvas size' }).getByRole('button', { name: '1:1', exact: true }).click();
check('canvas preset 1:1', (await state()).doc.comp.width === 1080);
const sq = (await state()).doc.comp.layers[3];
check('layout scaled to fit 1:1', sq.transform.scale.static < 0.6, `scale=${sq.transform.scale.static.toFixed(3)}`);
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/style-square.png` });
await page.keyboard.press('Control+z');
check('undo canvas resize', (await state()).doc.comp.width === 1920);

// --- Gate step 2: drag the 4K layer for ~2 s and measure rAF intervals.
await page.evaluate((id) => window.__glyphix.select(id), added.id);
await page.waitForTimeout(300);
const box = await page.evaluate((id) => window.__glyphix.box(id), added.id);
const start = await scr(box.cx, box.cy);
await page.evaluate(() => {
  window.__frames = [];
  let last = 0;
  const tick = (t) => {
    if (last) window.__frames.push(t - last);
    last = t;
    if (window.__frames.length < 400) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.mouse.move(start.x, start.y);
await page.mouse.down();
for (let i = 0; i < 120; i++) {
  await page.mouse.move(start.x + Math.sin(i / 10) * 150, start.y + Math.cos(i / 13) * 60);
  await page.waitForTimeout(16);
}
await page.mouse.up();
const frames = await page.evaluate(() => window.__frames.slice(5));
const sorted = [...frames].sort((a, b) => a - b);
const p50 = sorted[Math.floor(sorted.length * 0.5)];
const p95 = sorted[Math.floor(sorted.length * 0.95)];
const detail = `rAF p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms over ${frames.length} frames`;
// Frame timing is meaningless on an overloaded machine; report instead of failing.
const load = os.loadavg()[0] / os.cpus().length;
if (load > 0.7) console.log(`SKIP drag 4K layer at ~60 fps — machine busy (load/cpu ${load.toFixed(2)}); ${detail}`);
else check('drag 4K layer at ~60 fps', p95 <= 20, detail);

// --- Gate step 3: the whole drag is one undo step.
const beforeUndo = (await state()).doc.comp.layers[3].transform.x;
await page.keyboard.press('Control+z');
const afterUndo = (await state()).doc.comp.layers[3].transform.x;
await page.keyboard.press('Control+Shift+z');
const afterRedo = (await state()).doc.comp.layers[3].transform.x;
check('drag undo/redo', JSON.stringify(afterUndo) !== JSON.stringify(beforeUndo) && JSON.stringify(afterRedo) === JSON.stringify(beforeUndo));
const undoMs = await page.evaluate(() => {
  const t = performance.now();
  for (let i = 0; i < 20; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  return (performance.now() - t) / 20;
});
check('undo step < 50 ms', undoMs < 50, `${undoMs.toFixed(2)} ms/step`);

// --- Export still matches: PNG export with frame + tilt shouldn't throw.
await page.keyboard.press('Control+Shift+z');
const png = await page.evaluate(async () => {
  const { exportPng } = await import('/src/export/exporter.ts');
  const blob = await exportPng(window.__glyphix.state().doc, 4, {});
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 200) opaque++;
  return { kb: blob.size / 1024, opaquePct: (100 * opaque) / (d.length / 4) };
});
// The background covers the whole comp, so a correct export is fully opaque (a blank one is 0%).
check('PNG export with styling', png.opaquePct > 99, `${png.kb.toFixed(0)} KB, ${png.opaquePct.toFixed(1)}% opaque`);

console.log(errors.length ? `page errors:\n${errors.slice(0, 10).join('\n')}` : 'no page errors');
if (errors.length) failures++;
await browser.close();
process.exit(failures ? 1 : 0);
