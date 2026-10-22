// Easing editor end to end (Milestone I): presets equal the browser's own CSS timing functions, the editor sets the
// easing of the selected keyframes (one undo step per pick / drag / run of nudges), edits show on the canvas and in
// the exported frame, mixed selections, last keys skipped, springs land without a jump, enter-preset easing.
// Usage: node scripts/e2e-easing.mjs [baseUrl]
import { launch } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const keyOut = (prop, i = 0) =>
  page.evaluate(([prop, i]) => {
    const l = window.__glyphix.state().doc.comp.layers.find((x) => x.id === 'shot');
    const p = prop === 'opacity' ? l.opacity : l.transform[prop];
    return p.track.keys[i].out;
  }, [prop, i]);
const undo = async () => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+z');
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await page.goto(base);
await page.waitForFunction(() => window.__glyphix && window.__glyphix.view().zoom < 1, null, { timeout: 30000 });
await page.evaluate(async () => {
  const { createDemoDoc } = await import('/src/doc/index.ts');
  const s = window.__glyphix.editor.getState();
  s.loadDoc(createDemoDoc());
  s.setPlaying(false);
  s.setTime(0.5);
});

// --- Presets = the browser's CSS timing functions (Web Animations API), 101 points each, overshoot included.
const css = await page.evaluate(async () => {
  const { EASING_PRESETS, cssEasing, ease } = await import('/src/doc/index.ts');
  const el = document.body.appendChild(document.createElement('div'));
  const out = [];
  for (const p of EASING_PRESETS) {
    const timing = cssEasing(p.easing);
    if (!timing) continue;
    const a = el.animate([{ transform: 'translateX(0px)' }, { transform: 'translateX(1000px)' }], { duration: 1000, easing: timing, fill: 'both' });
    a.pause();
    let max = 0;
    for (let i = 0; i <= 100; i++) {
      // Off the exact step edges (where "jump" is a matter of < 1 ms).
      const ms = Math.min(1000, i * 10 + 0.5);
      a.currentTime = ms;
      const x = new DOMMatrix(getComputedStyle(el).transform).m41 / 1000;
      max = Math.max(max, Math.abs(x - ease(p.easing, ms / 1000)));
    }
    a.cancel();
    out.push({ id: p.id, timing, max });
  }
  el.remove();
  return out;
});
const cssBad = css.filter((c) => c.max > 0.001);
check(
  `presets match the browser's CSS timing functions (${css.length} presets × 101 points, ≤ 0.001)`,
  css.length >= 11 && !cssBad.length,
  cssBad.map((c) => `${c.id} Δ ${c.max.toFixed(4)}`).join(', ') || `worst Δ ${Math.max(...css.map((c) => c.max)).toFixed(5)}`,
);

// --- Select the screenshot's first Position Y key in the timeline.
await page.getByRole('button', { name: 'Show Screenshot properties', exact: true }).click();
const yKey = page.getByRole('button', { name: /^Position Y keyframe at 0\.00 s/ });
await yKey.click();
const trigger = page.locator('[data-key-easing]').first().getByRole('button');
check('easing button names the selected key’s easing', (await trigger.getAttribute('aria-label')) === 'Keyframe easing: Ease out', await trigger.getAttribute('aria-label'));
check('inspector shows a Keyframes section', (await page.getByRole('heading', { name: 'Keyframes' }).count()) === 1 || (await page.getByText('1 keyframe selected').count()) === 1);

// E opens the editor.
await page.keyboard.press('e');
const presets = page.getByRole('group', { name: 'Easing presets' });
await presets.waitFor({ timeout: 3000 }).catch(() => {});
check('E opens the easing editor', await presets.isVisible());

// Canvas before any edit (paused at 0.5 s, mid-way through the Position Y segment).
const stage = page.locator('canvas').first();
const shot0 = await stage.screenshot();
const before = await keyOut('y');

// --- Pick Bounce: one undo step, back to Ease out.
await presets.getByRole('button', { name: 'Bounce', exact: true }).click();
check('picking a preset sets the key’s easing', (await keyOut('y')).kind === 'bounce');
await page.keyboard.press('Escape');
await undo();
check('a preset pick is one undo step', same(await keyOut('y'), before), JSON.stringify(await keyOut('y')));
await page.keyboard.press('Control+Shift+z');
check('redo brings the pick back', (await keyOut('y')).kind === 'bounce');

// --- CSS ease, then keyboard-nudge handle 1 up 5 times: one undo step back to CSS ease.
await yKey.click();
await trigger.click();
await presets.getByRole('button', { name: 'CSS ease', exact: true }).click();
const cssEase = await keyOut('y');
const h1 = page.getByRole('button', { name: /^Handle 1:/ });
await h1.focus();
for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
const nudged = await keyOut('y');
check('arrow keys move a curve handle (0.01 per press)', nudged.kind === 'bezier' && Math.abs(nudged.y1 - (cssEase.y1 + 0.05)) < 1e-9, JSON.stringify(nudged));
check('the handle’s name reads its position', (await h1.getAttribute('aria-label')) === `Handle 1: x 0.25, y ${(cssEase.y1 + 0.05).toFixed(2)}`, await h1.getAttribute('aria-label'));
await page.keyboard.press('Shift+ArrowRight');
check('Shift+arrow moves by 0.1', Math.abs((await keyOut('y')).x1 - 0.35) < 1e-9);
check('nudging the handle did not move the keyframe', (await page.evaluate(() => window.__glyphix.state().doc.comp.layers.find((x) => x.id === 'shot').transform.y.track.keys[0].t)) === 0);
// Arrow keys on a preset button stay in the editor: they must not nudge the selected keyframe.
await presets.getByRole('button', { name: 'Linear', exact: true }).focus();
const docBefore = await page.evaluate(() => JSON.stringify(window.__glyphix.state().doc));
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Delete');
check('arrows / Delete inside the editor change nothing (keys or layer)', (await page.evaluate(() => JSON.stringify(window.__glyphix.state().doc))) === docBefore);
await page.keyboard.press('Escape');
await undo();
check('a run of handle nudges is one undo step', same(await keyOut('y'), cssEase), JSON.stringify(await keyOut('y')));

// --- Drag handle 2 with the mouse: lands where dropped, one undo step.
await yKey.click();
await trigger.click();
const h2 = page.getByRole('button', { name: /^Handle 2:/ });
await page.waitForTimeout(400); // the popover's open animation scales it
const hb = await h2.boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(hb.x + hb.width / 2 - i * 5, hb.y + hb.height / 2 - i * 4);
await page.mouse.up();
const dragged = await keyOut('y');
// 200 px for x 0..1 and for y -0.5..1.5: 50 px left = -0.25 in x, 40 px up = +0.4 in y.
check('dragging handle 2 moves it', Math.abs(dragged.x2 - 0) < 0.02 && Math.abs(dragged.y2 - 1.4) < 0.02, JSON.stringify(dragged));

// Live on the canvas: the paused frame changed with the curve.
await page.waitForTimeout(300);
const shot1 = await stage.screenshot();
check('curve edits show live on the canvas', !shot0.equals(shot1));

// Export: the frame rendered for export = the same doc built with the doc API.
const exp = await page.evaluate(async (easing) => {
  const { createDemoDoc, setKeyEasing } = await import('/src/doc/index.ts');
  const { createBackend, renderFrameBitmap } = window.__glyphix.render;
  const px = async (doc, t) => {
    const b = await createBackend({ canvas: document.createElement('canvas'), fullResAssets: true });
    b.setSize(640, 360, 1);
    await renderFrameBitmap(b, doc, t);
    const bmp = await renderFrameBitmap(b, doc, t);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    await b.idle();
    b.dispose();
    return c.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
  };
  const diff = (a, b) => a.reduce((m, v, k) => Math.max(m, Math.abs(v - b[k])), 0);
  const edited = window.__glyphix.state().doc;
  const built = createDemoDoc();
  const shot = built.comp.layers.find((l) => l.id === 'shot');
  shot.transform.y = setKeyEasing(shot.transform.y, [0], easing, built.comp.fps);
  const out = { same: 0, moved: 0 };
  for (const t of [0.2, 0.5, 0.8]) {
    out.same = Math.max(out.same, diff(await px(edited, t), await px(built, t)));
    out.moved = Math.max(out.moved, diff(await px(edited, t), await px(createDemoDoc(), t)));
  }
  return out;
}, dragged);
check('export renders the edited curve (= doc API, ≠ before)', exp.same <= 1 && exp.moved > 8, `Δ edited/built ${exp.same}, edited/original ${exp.moved}`);

await page.keyboard.press('Escape');
await undo();
check('a handle drag is one undo step', same(await keyOut('y'), cssEase), JSON.stringify(await keyOut('y')));

// --- Several keys: Ctrl+A on the layer → "Mixed"; Linear applies to all but the last keys (skipped, said so).
await yKey.click();
await yKey.focus(); // Ctrl+A selects all keys when focus is in the timeline (a click on a key doesn't focus it)
await page.keyboard.press('Control+a');
check('different easings show as Mixed', (await trigger.getAttribute('aria-label')) === 'Keyframe easing: Mixed', await trigger.getAttribute('aria-label'));
await trigger.click();
check('the editor says last keys are skipped', (await page.getByText(/last keyframes have no next key/).count()) === 1);
await presets.getByRole('button', { name: 'Linear', exact: true }).click();
const all = await page.evaluate(() => {
  const l = window.__glyphix.state().doc.comp.layers.find((x) => x.id === 'shot');
  return [l.opacity, l.transform.y, l.transform.scale].map((p) => p.track.keys.map((k) => k.out.kind));
});
check('one pick sets every selected key (not the last ones)', same(all, [['linear', 'linear'], ['linear', 'linear'], ['linear', 'linear']]) , JSON.stringify(all));
await page.keyboard.press('Escape');
check('linear keys are drawn as circles', (await page.locator('[data-layer="shot"][data-ease="linear"]').count()) >= 3);
await undo();
const restored = await page.evaluate(() => window.__glyphix.state().doc.comp.layers.find((x) => x.id === 'shot').opacity.track.keys[0].out.kind);
check('multi-key pick is one undo step', restored === 'bezier');

// --- Spring with heavy damping lands on the next key without a jump.
await yKey.click();
await trigger.click();
await presets.getByRole('button', { name: 'Spring', exact: true }).click();
const damping = page.getByRole('slider', { name: 'Damping' });
await damping.focus();
await page.keyboard.press('End');
const spring = await keyOut('y');
const land = await page.evaluate(async () => {
  const { sampleProp } = await import('/src/doc/index.ts');
  const y = window.__glyphix.state().doc.comp.layers.find((x) => x.id === 'shot').transform.y;
  const vals = Array.from({ length: 1001 }, (_, i) => sampleProp(y, i / 1000));
  let step = 0;
  for (let i = 1; i < vals.length; i++) step = Math.max(step, Math.abs(vals[i] - vals[i - 1]));
  return { step, end: vals.at(-2) };
});
// The move is 60 px (700 → 640); a jump would be one big step.
check('a heavily damped spring lands without a jump', spring.kind === 'spring' && spring.damping === 100 && land.step < 1.5 && Math.abs(land.end - 640) < 0.5, `damping ${spring.damping}, biggest 1 ms step ${land.step.toFixed(3)} px, 1 ms before the key ${land.end.toFixed(2)}`);
await page.keyboard.press('Escape');

// --- Enter animation easing uses the same editor.
// The demo headline has no enter preset: open the blank project's headline (enter "rise").
const headline = await page.evaluate(async () => {
  const { createBlankDoc } = await import('/src/doc/index.ts');
  const s = window.__glyphix.editor.getState();
  const doc = createBlankDoc('easing');
  s.loadDoc(doc);
  s.setPlaying(false);
  s.select(doc.comp.layers[1].id);
  return doc.comp.layers[1].id;
});
const enterBtn = page.getByRole('button', { name: /^Easing: / }).first();
await enterBtn.click();
await presets.getByRole('button', { name: 'Bounce', exact: true }).click();
const enter = await page.evaluate((id) => window.__glyphix.state().doc.comp.layers.find((x) => x.id === id).motion.enter.easing.kind, headline);
check('enter animation easing uses the editor', enter === 'bounce', enter);
await page.keyboard.press('Escape');
await page.waitForTimeout(400); // close animation
check('Escape closes the editor', !(await presets.isVisible()));

console.log(errors.length ? `page errors:\n${errors.slice(0, 10).join('\n')}` : 'no page errors');
if (errors.length) failures++;
await browser.close();
process.exit(failures ? 1 : 0);
