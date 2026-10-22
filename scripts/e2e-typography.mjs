// Milestone D end to end: add text, fonts (bundled + upload, persistence, .glyphix), weight and
// styling, every kinetic text preset rendered mid-animation (preview = export), hover preview,
// letter-timing overrides, undo.
// Usage: node scripts/e2e-typography.mjs [baseUrl] [outDir]
import { readFileSync } from 'node:fs';
import { launch } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.argv[3] ?? '.';
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

await page.goto(base);
await ready();
await page.keyboard.press('Space'); // pause
await page.evaluate(() => { window.__glyphix.select(null); document.activeElement?.blur(); });

// --- Add text with the T shortcut.
const before = (await state()).doc.comp.layers.length;
await page.keyboard.press('t');
let layer = await selected();
check('T adds a selected text layer', (await state()).doc.comp.layers.length === before + 1 && layer?.type === 'text', layer?.id);
const textId = layer.id;
await page.evaluate(() => window.__glyphix.setTime(3));

// --- Fonts: pick a bundled family from the searchable picker.
await page.getByRole('button', { name: /^Font:/ }).click();
await page.getByLabel('Search fonts').fill('anton');
await page.getByRole('button', { name: 'Anton', exact: false }).first().click();
layer = await selected();
check('font picker sets the font', layer.fontId === 'anton', layer.fontId);
await page.waitForFunction((id) => window.__glyphix.box(id)?.w > 0, textId);

// --- Weight changes the shaping (wider glyphs).
await page.getByRole('button', { name: /^Font:/ }).click();
await page.getByLabel('Search fonts').fill('geist');
await page.getByRole('group', { name: 'Fonts' }).getByRole('button', { name: /^Geist/ }).first().click();
await page.waitForTimeout(400);
const w400 = (await page.evaluate((id) => window.__glyphix.box(id), textId)).w;
await page.getByRole('combobox', { name: 'Weight' }).click();
await page.getByRole('option', { name: /Black · 900/ }).click();
await page.waitForTimeout(300);
layer = await selected();
const w900 = (await page.evaluate((id) => window.__glyphix.box(id), textId)).w;
check('weight is stored and changes the layout', layer.weight === 900 && w900 > w400 * 1.03, `width ${w400.toFixed(0)} → ${w900.toFixed(0)}`);

// --- Styling switches.
await page.getByRole('group', { name: 'Fill type' }).getByRole('button', { name: 'Gradient' }).click();
await page.getByRole('switch', { name: 'Outline' }).click();
await page.getByRole('switch', { name: 'Text shadow' }).click();
layer = await selected();
check('gradient, outline and shadow are stored', !!layer.gradient && layer.outline?.width?.static > 0 && layer.shadow?.blur?.static >= 0, JSON.stringify({ g: !!layer.gradient, o: layer.outline?.width, s: layer.shadow?.blur }));

// --- Render helper: two independent backends (preview path and export path) at 960×540.
await page.evaluate(async () => {
  // Use the app's module instances: a test-side import can be a separate copy after HMR.
  const { createBackend, renderFrameBitmap } = window.__glyphix.render;
  const fontLibrary = window.__glyphix.fonts;
  const mk = async () => {
    const b = await createBackend({ canvas: document.createElement('canvas'), fullResAssets: true });
    b.setSize(960, 540, 1);
    return b;
  };
  const A = await mk();
  const B = await mk();
  const pixels = async (b, doc, t) => {
    await renderFrameBitmap(b, doc, t);
    const bmp = await renderFrameBitmap(b, doc, t);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return g.getImageData(0, 0, bmp.width, bmp.height).data;
  };
  window.__typo = {
    async compare(doc, tMid, tRest) {
      const ids = doc.comp.layers.flatMap((l) => (l.type === 'text' ? [l.fontId] : []));
      await fontLibrary.loadAll(ids);
      const a = await pixels(A, doc, tMid);
      const b = await pixels(B, doc, tMid);
      const r = await pixels(A, doc, tRest);
      let maxSame = 0;
      let changed = 0;
      let opaque = 0;
      for (let i = 0; i < a.length; i++) {
        maxSame = Math.max(maxSame, Math.abs(a[i] - b[i]));
        if (Math.abs(a[i] - r[i]) > 24) changed++;
        if (i % 4 === 3 && a[i] > 200) opaque++;
      }
      return { maxSame, changedPct: (100 * changed) / a.length, opaquePct: (100 * opaque) / (a.length / 4), glyphs: A.stats().glyphs };
    },
  };
});

// --- Every per-glyph preset, mid-animation: identical in both renderers and visibly animated.
const presets = await page.evaluate(async () => {
  const m = await import('/src/doc/motion.ts');
  const pick = (list) => list.filter((p) => p.glyph).map((p) => p.id);
  return { enter: pick(m.ENTER_PRESETS), exit: pick(m.EXIT_PRESETS), loop: pick(m.LOOP_PRESETS) };
});
check('20+ kinetic text presets', presets.enter.length + presets.exit.length + presets.loop.length >= 20, `${presets.enter.length} enter, ${presets.exit.length} exit, ${presets.loop.length} emphasis`);
const bad = [];
for (const kind of ['enter', 'exit', 'loop']) {
  for (const id of presets[kind]) {
    const r = await page.evaluate(
      async ([kind, id, textId]) => {
        const m = await import('/src/doc/motion.ts');
        const doc = structuredClone(window.__glyphix.state().doc);
        doc.comp.layers = doc.comp.layers.filter((l) => l.type !== 'image'); // text over the background only
        const l = doc.comp.layers.find((x) => x.id === textId);
        l.text = { static: 'Kinetic type\nmoves well' };
        l.motion = { enter: null, exit: null, loop: null };
        let tMid = 2;
        let tRest = 2;
        if (kind === 'enter') {
          l.motion.enter = { ...m.defaultEnter(id, 0.5), duration: 2 };
          tMid = 1.3;
          tRest = 4;
        } else if (kind === 'exit') {
          l.motion.exit = { ...m.defaultExit(id), duration: 2 };
          tMid = doc.comp.duration - 1.2;
          tRest = 1;
        } else {
          l.motion.loop = { ...m.defaultLoop(id, doc.comp), amount: 1 };
          tMid = 0.37 + l.motion.loop.period * 0.31;
          tRest = 0.37;
        }
        return window.__typo.compare(doc, tMid, tRest);
      },
      [kind, id, textId],
    );
    const ok = r.maxSame <= 1 && r.changedPct > 0.02 && r.opaquePct > 99;
    if (!ok) bad.push(`${kind}:${id} (Δ${r.maxSame}, changed ${r.changedPct.toFixed(3)}%)`);
  }
}
check('every text preset: preview = export mid-animation, and it visibly animates', bad.length === 0, bad.length ? bad.join(', ') : `${presets.enter.length + presets.exit.length + presets.loop.length} presets`);

// --- Atlas growth and rebuild: many fonts × weights × full ASCII. The first scene grows the atlas by
// pages; a second scene with other weights overflows all pages and forces one rebuild. Both frames
// must be complete and identical in two independent renderers.
const atlas = await page.evaluate(async (textId) => {
  const { BUNDLED_FONTS } = await import('/src/text/fonts.ts');
  const fonts = window.__glyphix.fonts;
  const proto = window.__glyphix.state().doc.comp.layers.find((x) => x.id === textId);
  const ascii = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join('');
  const scene = (weights) => {
    const doc = structuredClone(window.__glyphix.state().doc);
    doc.comp.layers = doc.comp.layers.filter((l) => l.type === 'background');
    BUNDLED_FONTS.forEach((f, i) =>
      weights.forEach((weight, j) =>
        doc.comp.layers.push({ ...structuredClone(proto), id: `atlas-${i}-${j}`, fontId: f.id, weight, fontSize: 14, text: { static: ascii }, motion: { enter: null, exit: null, loop: null }, transform: { ...proto.transform, y: { static: 40 + (i * weights.length + j) * 22 } } }),
      ),
    );
    return doc;
  };
  // Glyphs with an outline (a few ASCII characters are empty in some fonts).
  const expected = (doc) => doc.comp.layers.reduce((n, l) => n + (l.type === 'text' ? fonts.layout({ ...l, text: l.text.static }).glyphs.filter((g) => g.glyph).length : 0), 0);
  const gen0 = fonts.generation;
  const s1 = scene([300, 500, 800]);
  const a = await window.__typo.compare(s1, 2, 2);
  a.expected = expected(s1);
  const pages = fonts.pages;
  const gen1 = fonts.generation;
  const s2 = scene([200, 400, 700]);
  const b = await window.__typo.compare(s2, 2, 2);
  b.expected = expected(s2);
  return { a, b, pages, grewWithoutReset: gen1 === gen0, resets: fonts.generation - gen1 };
}, textId);
check('glyph atlas grows by pages', atlas.pages > 1 && atlas.grewWithoutReset && atlas.a.maxSame <= 1 && atlas.a.glyphs === atlas.a.expected, `${atlas.a.glyphs}/${atlas.a.expected} glyphs drawn, ${atlas.pages} pages, max Δ ${atlas.a.maxSame}`);
check('glyph atlas overflow rebuilds cleanly', atlas.resets === 1 && atlas.b.maxSame <= 1 && atlas.b.glyphs === atlas.b.expected, `${atlas.b.glyphs}/${atlas.b.expected} glyphs drawn, ${atlas.resets} rebuild, max Δ ${atlas.b.maxSame}`);

// --- Hover preview: shows on the canvas, never touches the document.
const docBefore = JSON.stringify((await state()).doc);
await page.getByRole('group', { name: 'Enter animation' }).getByRole('button', { name: 'Drop', exact: true }).hover();
const pv = await page.evaluate(() => window.__glyphix.editor.getState().preview);
check('hovering a preset previews it', pv?.motion.enter?.preset === 'drop' && JSON.stringify((await state()).doc) === docBefore);
await page.mouse.move(5, 5);
await page.waitForTimeout(100);
check('leaving ends the preview', (await page.evaluate(() => window.__glyphix.editor.getState().preview)) === null);

// --- Apply a preset, then override its letter timing.
await page.getByRole('group', { name: 'Enter animation' }).getByRole('button', { name: 'Rise', exact: true }).click();
await page.getByText('Letter timing').click();
await page.getByRole('group', { name: 'Animate by' }).getByRole('button', { name: 'Word' }).click();
layer = await selected();
check('letter timing: animate by word', layer.motion.enter?.preset === 'rise' && layer.motion.enter.stagger?.unit === 'word', JSON.stringify(layer.motion.enter?.stagger));
await page.getByRole('tab', { name: /Exit/ }).click();
await page.getByRole('group', { name: 'Exit animation' }).getByRole('button', { name: 'Blur out', exact: true }).click();
await page.getByRole('tab', { name: /Loop/ }).click();
await page.getByRole('group', { name: 'Loop animation' }).getByRole('button', { name: 'Swing', exact: true }).click();
layer = await selected();
check('enter + exit + emphasis on one layer', layer.motion.exit?.preset === 'blur-out' && layer.motion.loop?.preset === 'swing');
await page.evaluate(() => window.__glyphix.setTime(1.0));
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/typography-mid.png` });

// --- Undo walks back through the edits.
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Control+z');
layer = await selected();
check('undo removes the last edit', layer.motion.loop === null, JSON.stringify(layer.motion.loop));

// --- Upload a font, then reload: autosave + IndexedDB restore it.
await page.getByRole('button', { name: /^Font:/ }).click();
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Upload font/ }).click()]);
await chooser.setFiles({ name: 'MyBrandFont.ttf', mimeType: 'font/ttf', buffer: readFileSync('public/fonts/Syne.ttf') });
await page.waitForFunction(() => { const s = window.__glyphix.state(); return s.doc.comp.layers.find((l) => l.id === s.selectedId)?.fontId.startsWith('font-'); });
layer = await selected();
const uploadedId = layer.fontId;
check('uploaded font is applied as a project asset', /^font-[0-9a-f]{20}$/.test(uploadedId) && (await page.getByRole('button', { name: /^Font: Syne/ }).count()) === 1, uploadedId);
// Wait for autosave (debounced) to store the project with the new font.
for (let i = 0; i < 50; i++) {
  const saved = await page.evaluate(async (id) => {
    const { get } = await import('/src/persistence/db.ts');
    const rec = await get('projects', window.__glyphix.state().doc.id);
    return JSON.stringify(rec?.doc ?? '').includes(id);
  }, uploadedId);
  if (saved) break;
  await page.waitForTimeout(200);
}
// .glyphix round trip carries the font file.
const rt = await page.evaluate(async () => {
  const { writeProjectFile, readProjectFile } = await import('/src/persistence/projectFile.ts');
  const doc = window.__glyphix.state().doc;
  const { doc: back, assets } = await readProjectFile(await writeProjectFile(doc));
  return { same: JSON.stringify(back) === JSON.stringify(doc), fonts: assets.filter((a) => a.id.startsWith('font-')).map((a) => [a.id, a.blob.type, a.blob.size]) };
});
check('.glyphix round trip includes the uploaded font', rt.same && rt.fonts.length === 1 && rt.fonts[0][0] === uploadedId && rt.fonts[0][1] === 'font/ttf', JSON.stringify(rt.fonts));
await page.reload();
await ready();
// The editor only appears once the project (and its assets) are restored.
await page.getByRole('button', { name: 'Export' }).waitFor();
const restored = await page.evaluate(async (id) => {
  const fontLibrary = window.__glyphix.fonts;
  const l = window.__glyphix.state().doc.comp.layers.find((x) => x.fontId === id);
  const alert = document.querySelector('[role=alert]')?.textContent ?? null;
  if (!fontLibrary.info(id)) return { found: !!l, registered: false, alert };
  await fontLibrary.load(id);
  return { found: !!l, family: fontLibrary.info(id)?.family, layout: !!(l && fontLibrary.layout({ ...l, text: l.text.static })), alert };
}, uploadedId);
check('uploaded font survives a reload', restored.found && restored.family === 'Syne' && restored.layout, JSON.stringify(restored));

console.log(errors.length ? `page errors:\n${errors.slice(0, 10).join('\n')}` : 'no page errors');
if (errors.length) failures++;
await browser.close();
process.exit(failures ? 1 : 0);
