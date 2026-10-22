// Drives the editor like a user: select, move (with snapping), scale, rotate, crop, text edit,
// zoom, layer ops, undo/redo. Asserts on the document via window.__glyphix (dev only).
// Usage: HEADED=1 node scripts/e2e-editor.mjs [baseUrl] [outDir]
import { launch } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.argv[3] ?? '.';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  // TRACE=1 interleaves errors (and any [dbg] logs) with the checks below.
  if (process.env.TRACE && (m.type() === 'error' || m.text().includes('[dbg]'))) console.log(`  · ${m.type()} ${m.text().slice(0, 100)}`);
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const state = () => page.evaluate(() => window.__glyphix.state());
const layer = async (id) => (await state()).doc.comp.layers.find((l) => l.id === id);
const val = (p) => ('static' in p ? p.static : p.track.keys.map((k) => k.v));
/** comp → page coordinates */
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
await page.waitForTimeout(1500);
await page.keyboard.press('Space'); // pause
await page.evaluate(() => window.__glyphix.setTime(2));
await page.waitForTimeout(200);

// Select screenshot by clicking it.
let p = await scr(960, 640);
await page.mouse.click(p.x, p.y);
check('click selects screenshot', (await state()).selectedId === 'shot');

// Move it right by ~200 comp px.
const before = await layer('shot');
const zoom = (await page.evaluate(() => window.__glyphix.view())).zoom;
await page.mouse.move(p.x, p.y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(p.x + (200 * zoom * i) / 10, p.y, { steps: 1 });
await page.mouse.up();
const moved = await layer('shot');
check('drag moves layer', Math.abs(val(moved.transform.x) - val(before.transform.x) - 200) < 8, `x ${val(before.transform.x)} → ${val(moved.transform.x)}`);
check('animated y track preserved', Array.isArray(val(moved.transform.y)));

// Undo the whole drag in one step.
await page.keyboard.press('Control+z');
check('one undo reverts the drag', val((await layer('shot')).transform.x) === val(before.transform.x));
await page.keyboard.press('Control+Shift+z');
check('redo reapplies', val((await layer('shot')).transform.x) === val(moved.transform.x));
await page.keyboard.press('Control+z');

// Snapping: drag the shot's centre close to the comp centre line (x=960) from 20px away.
p = await scr(960, 640);
await page.mouse.move(p.x, p.y);
await page.mouse.down();
const near = await scr(960 + 3, 640);
await page.mouse.move(p.x + 40 * zoom, p.y, { steps: 3 });
await page.mouse.move(near.x, near.y, { steps: 3 });
await page.mouse.up();
check('snaps to comp centre', val((await layer('shot')).transform.x) === 960, `x=${val((await layer('shot')).transform.x)}`);

// Scale from the SE corner handle.
const box = await page.evaluate(() => window.__glyphix.box('shot'));
const se = await scr(box.cx + box.w / 2, box.cy + box.h / 2);
await page.mouse.move(se.x, se.y);
await page.mouse.down();
await page.mouse.move(se.x + 100, se.y + 60, { steps: 5 });
await page.mouse.up();
const scaled = await layer('shot');
const s0 = val(before.transform.scale);
const s1 = val(scaled.transform.scale);
check('corner handle scales', s1.at(-1) > s0.at(-1) * 1.05, `${s0} → ${s1}`);

// Rotate with shift (15° snapping).
const b2 = await page.evaluate(() => window.__glyphix.box('shot'));
const v2 = await page.evaluate(() => window.__glyphix.view());
const top = await scr(b2.cx, b2.cy - b2.h / 2);
const rot = { x: top.x, y: top.y - 28 };
await page.mouse.move(rot.x, rot.y);
await page.mouse.down();
const target = await scr(b2.cx + 400, b2.cy - 1500);
await page.keyboard.down('Shift');
await page.mouse.move(target.x, target.y, { steps: 5 });
await page.keyboard.up('Shift');
await page.mouse.up();
const r = val((await layer('shot')).transform.rotation);
check('rotate handle snaps to 15°', r % 15 === 0 && r !== 0, `rotation=${r}`);
void v2;

// Crop: double-click → crop mode, drag the east edge inward.
await page.keyboard.press('Control+z'); // undo rotation for simpler geometry
const b3 = await page.evaluate(() => window.__glyphix.box('shot'));
p = await scr(b3.cx, b3.cy);
await page.mouse.dblclick(p.x, p.y);
check('double-click enters crop mode', (await state()).cropId === 'shot');
await page.waitForSelector('[data-handle="crop-e"]'); // handles render a frame later
const east = await scr(b3.cx + b3.w / 2, b3.cy);
await page.mouse.move(east.x, east.y);
await page.mouse.down();
await page.mouse.move(east.x - 150, east.y, { steps: 5 });
await page.mouse.up();
const cropped = await layer('shot');
check('crop shrinks crop.w and width', cropped.crop.w < 0.95 && cropped.width < before.width, `crop.w=${cropped.crop.w.toFixed(3)} width=${cropped.width.toFixed(0)}`);
await page.screenshot({ path: `${out}/e2e-crop.png` });
await page.keyboard.press('Escape');

// Inline text edit.
const hb = await page.evaluate(() => window.__glyphix.box('headline'));
p = await scr(hb.cx, hb.cy);
await page.mouse.dblclick(p.x, p.y);
await page.waitForSelector('textarea[aria-label="Edit text"]');
await page.keyboard.type('Hello Glyphix');
await page.keyboard.press('Escape');
check('inline text edit', (await layer('headline')).text?.static === 'Hello Glyphix');
await page.keyboard.press('Control+z');
check('text edit undoes in one step', (await layer('headline')).text?.static === 'Ship visuals that move');

// Layer ops: duplicate, reorder, delete, undo.
await page.evaluate(() => window.__glyphix.select('shot'));
await page.keyboard.press('Control+d');
let ids = (await state()).doc.comp.layers.map((l) => l.id);
check('duplicate adds layer above', ids.length === 4 && ids[2] !== 'shot' && ids[1] === 'shot', ids.join(','));
await page.keyboard.press('Delete');
check('delete removes it', (await state()).doc.comp.layers.length === 3);
await page.evaluate(() => window.__glyphix.select('headline'));
await page.keyboard.press('Control+Shift+[');
ids = (await state()).doc.comp.layers.map((l) => l.id);
check('send to back stops above background', ids.join(',') === 'bg,headline,shot', ids.join(','));

// Zoom with ctrl+wheel at cursor, then fit.
const z0 = (await page.evaluate(() => window.__glyphix.view())).zoom;
await page.mouse.move(700, 400);
await page.keyboard.down('Control');
await page.mouse.wheel(0, -200);
await page.keyboard.up('Control');
await page.waitForTimeout(100);
const z1 = (await page.evaluate(() => window.__glyphix.view())).zoom;
check('ctrl+wheel zooms in', z1 > z0 * 1.5, `${z0.toFixed(3)} → ${z1.toFixed(3)}`);
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/e2e-zoomed.png` });
await page.keyboard.press('Control+0');

console.log(errors.length ? `page errors:\n${errors.slice(0, 10).join('\n')}` : 'no page errors');
if (errors.length) failures++;
await browser.close();
process.exit(failures ? 1 : 0);
