// Milestone J end to end ("keyframe everything"): colours blend in OKLab, text switches at its keys, every newly
// keyframable property changes the rendered frame between its keys, preview = export and WebGPU ≈ WebGL2 there,
// v8 projects render byte-identically after migration, and the inspector / timeline edit the new keys.
// Usage: node scripts/e2e-animate.mjs [baseUrl]
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

await page.goto(base);
await page.waitForFunction(() => window.__glyphix && window.__glyphix.view().zoom < 1, null, { timeout: 30000 });
await page.evaluate(() => window.__glyphix.editor.getState().setPlaying(false));

// --- Rendering: for each property, keys at 0 s and 1 s; the frame at 0.5 s must differ from 0 s (it animates),
// two WebGPU renders must match (preview = export), and WebGL2 must be close.
const r = await page.evaluate(async () => {
  const { createDemoDoc, createBlankDoc, createEffect, applyPatches, migrate, Easings } = await import('/src/doc/index.ts');
  const { toV8 } = await import('/src/doc/__fixtures__/v8.ts');
  const { createBackend, renderFrameBitmap } = window.__glyphix.render;
  const mk = async (forceWebGL) => {
    const b = await createBackend({ canvas: document.createElement('canvas'), fullResAssets: true, forceWebGL });
    b.setSize(640, 360, 1);
    return b;
  };
  const [A, B, G] = [await mk(false), await mk(false), await mk(true)];
  const px = async (b, doc, t) => {
    await renderFrameBitmap(b, doc, t);
    const bmp = await renderFrameBitmap(b, doc, t);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    return c.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
  };
  const diff = (a, b) => {
    let max = 0;
    let sum = 0;
    let n = 0;
    for (let k = 0; k < a.length; k++) {
      const d = Math.abs(a[k] - b[k]);
      max = Math.max(max, d);
      sum += d;
      if (d > 8) n++;
    }
    return { max, mean: sum / a.length, changed: n };
  };
  const live = (a, b) => ({ track: { keys: [{ t: 0, v: a, out: Easings.linear }, { t: 1, v: b, out: Easings.linear }] } });
  const frozen = (a) => ({ static: a });
  const at = (doc, id, ...p) => {
    const i = doc.comp.layers.findIndex((l) => l.id === id);
    return applyPatches(doc, p.map(([path, value]) => ({ path: ['comp', 'layers', i, ...path], value })));
  };
  const demo = createDemoDoc();
  const st = (v) => ({ static: v });
  const red = [1, 0, 0, 1];
  const blue = [0, 0, 1, 1];
  const shadowOn = { offsetX: st(0), offsetY: st(8), blur: st(10), color: st([0, 0, 0, 0.8]) };
  const textKeys = (T) => (T === frozen ? st('Before') : { track: { keys: [{ t: 0, v: 'Before', out: Easings.linear }, { t: 0.5, v: 'After!', out: Easings.linear }] } });
  const withFx = (T) => {
    const fx = createEffect('glow');
    fx.id = 'fx-e2e';
    fx.colors.color = T(red, blue);
    return [fx];
  };
  // Each case built twice: animated (T = live) and with that property frozen at its first key (T = frozen).
  const cases = {
    'text colour': (T) => at(demo, 'headline', [['color'], T(red, blue)]),
    'glow colour': (T) => at(demo, 'headline', [['glow'], st(1)], [['glowColor'], T(red, blue)]),
    'text gradient': (T) => at(demo, 'headline', [['gradient'], { angle: T(0, 90), from: T(red, blue), to: T(blue, red) }]),
    'text outline': (T) => at(demo, 'headline', [['outline'], { width: T(1, 8), color: T(red, blue) }]),
    'text shadow': (T) => at(demo, 'headline', [['shadow'], { ...shadowOn, offsetY: T(0, 30), color: T(red, blue) }]),
    'text content': (T) => at(demo, 'headline', [['text'], textKeys(T)]),
    'image radius': (T) => at(demo, 'shot', [['radius'], T(0, 200)]),
    'image shadow': (T) => at(demo, 'shot', [['shadow'], { blur: T(0, 120), offsetX: T(0, 80), offsetY: st(30), color: T(red, blue) }]),
    'image border': (T) => at(demo, 'shot', [['border'], { width: T(2, 24), color: T(red, blue) }]),
    'background stops': (T) => at(demo, 'bg', [['fill'], { kind: 'linear', angle: T(0, 180), stops: [{ offset: T(0, 0.4), color: T(red, blue) }, { offset: st(1), color: st([1, 1, 1, 1]) }] }]),
    'background solid': (T) => at(demo, 'bg', [['fill'], { kind: 'solid', color: T(red, blue) }]),
    'background mesh': (T) => at(demo, 'bg', [['fill'], { kind: 'mesh', points: [{ x: T(0.1, 0.9), y: st(0.1), color: T(red, blue) }, { x: st(0.9), y: st(0.9), color: st([1, 1, 1, 1]) }] }]),
    'effect colour': (T) => at(demo, 'shot', [['effects'], withFx(T)]),
  };
  const out = {};
  for (const b of [A, B, G]) await px(b, demo, 0.5); // warm up: fonts and glyph atlas ready in every renderer
  for (const [name, make] of Object.entries(cases)) {
    const doc = make(live);
    const mid = await px(A, doc, 0.5);
    out[name] = {
      moves: diff(await px(A, make(frozen), 0.5), mid).changed,
      same: diff(mid, await px(B, doc, 0.5)).max,
      gl: diff(mid, await px(G, doc, 0.5)).mean,
    };
  }
  // OKLab: the middle of a red → blue solid background is a vivid purple, not dim grey-brown (sRGB average).
  const purple = await px(A, cases['background solid'](live), 0.5);
  const centre = 4 * (8 * 640 + 8); // top-left corner: background only
  const mid = [purple[centre], purple[centre + 1], purple[centre + 2]];
  // Reference: the browser's own CSS color-mix in OKLab.
  const ref = new OffscreenCanvas(1, 1).getContext('2d');
  ref.fillStyle = 'color-mix(in oklab, rgb(255 0 0) 50%, rgb(0 0 255))';
  ref.fillRect(0, 0, 1, 1);
  const want = [...ref.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  // Text hold: the shown text switches exactly at the key.
  const { evaluate } = await import('/src/doc/index.ts');
  const textAt = (t) => evaluate(cases['text content'](live), t).items.find((i) => i.kind === 'text').text;
  // v8 projects: migrate and render byte-identically (demo + blank project, several times).
  let migrated = 0;
  for (const doc of [createDemoDoc(), createBlankDoc('m')]) {
    const old = migrate(toV8(doc));
    for (const t of [0, 0.7, 2.5]) migrated = Math.max(migrated, diff(await px(A, doc, t), await px(A, old, t)).max);
  }
  for (const b of [A, B, G]) {
    await b.idle();
    b.dispose();
  }
  return { out, mid, want, hold: [textAt(0.49), textAt(0.5)], migrated };
});
const bad = Object.entries(r.out).filter(([, v]) => !(v.moves > 50 && v.same <= 1 && v.gl < 1.5));
for (const [name, v] of Object.entries(r.out)) console.log(`  ${name.padEnd(18)} changes ${v.moves} ch vs frozen · preview=export Δ ${v.same} · WebGL2 mean Δ ${v.gl.toFixed(3)}`);
check('every new property animates; preview = export; WebGPU ≈ WebGL2', !bad.length, bad.map(([n]) => n).join(', ') || `${Object.keys(r.out).length} properties`);
check(
  'colours blend in OKLab (red → blue mid-point = CSS color-mix(in oklab), not the sRGB average)',
  r.mid.every((v, i) => Math.abs(v - r.want[i]) <= 3),
  `rendered rgb(${r.mid.join(', ')}), CSS rgb(${r.want.join(', ')}); sRGB average would be rgb(128, 0, 128)`,
);
check('text switches exactly at its key (hold)', r.hold[0] === 'Before' && r.hold[1] === 'After!', JSON.stringify(r.hold));
check('v8 projects render byte-identically after migration', r.migrated === 0, `max Δ ${r.migrated}`);

// --- Inspector: the corner-radius key button, then editing the radius at another time writes a second key.
await page.evaluate(() => {
  window.__glyphix.select('shot');
  window.__glyphix.setTime(0);
});
await page.getByRole('button', { name: 'Add corner radius keyframe at playhead' }).click();
const radius = () => page.evaluate(() => window.__glyphix.state().doc.comp.layers.find((l) => l.id === 'shot').radius);
check('the key button animates the radius (one key at the playhead)', JSON.stringify(await radius()).includes('"track"') && (await radius()).track.keys.length === 1);
await page.evaluate(() => window.__glyphix.setTime(1));
const slider = page.getByRole('slider', { name: 'Corner radius' });
await slider.focus();
await page.keyboard.press('End');
const rad = await radius();
check('editing an animated value writes a key at the playhead', rad.track?.keys.length === 2 && rad.track.keys[1].t === 1 && rad.track.keys[1].v === 80, JSON.stringify(rad));
await page.evaluate(() => window.__glyphix.setTime(0.5));
await page.waitForTimeout(200);
const shown = Number(await slider.getAttribute('aria-valuenow'));
check('the inspector shows the value at the playhead (between the two keys)', shown > rad.track.keys[0].v && shown < 80, `${shown} px at 0.5 s (keys ${rad.track.keys[0].v} → 80)`);

// --- Text content keys: key button + typing at another time.
await page.evaluate(() => {
  window.__glyphix.select('headline');
  window.__glyphix.setTime(0);
});
await page.getByRole('button', { name: 'Add text keyframe at playhead' }).click();
await page.evaluate(() => window.__glyphix.setTime(2));
const content = page.getByRole('textbox', { name: 'Content' });
await content.fill('Second line');
const text = await page.evaluate(() => window.__glyphix.state().doc.comp.layers.find((l) => l.id === 'headline').text);
check('typing animated text writes a key at the playhead', text.track?.keys.length === 2 && text.track.keys[1].v === 'Second line', JSON.stringify(text).slice(0, 160));

// --- Timeline: the headline's rows include the new properties, with the text keys.
await page.getByRole('button', { name: 'Show Headline properties', exact: true }).click();
const rows = page.getByRole('list', { name: 'Headline properties' });
const names = await rows.getByRole('listitem').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
check('timeline rows list colour, glow colour and text', ['Text', 'Colour', 'Glow colour'].every((n) => names.includes(`Text · ${n}`) || names.includes(n)), names.join(', '));
check('timeline shows the text keys', (await rows.getByRole('button', { name: /^Text · Text keyframe at|^Text keyframe at/ }).count()) === 2);

console.log(errors.length ? `page errors:\n${errors.slice(0, 10).join('\n')}` : 'no page errors');
if (errors.length) failures++;
await browser.close();
process.exit(failures ? 1 : 0);
