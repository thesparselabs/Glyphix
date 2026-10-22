// Milestone F (F3) end to end: the ASCII effect. Renders on a layer and on an adjustment layer, preview =
// export, WebGPU ≈ WebGL2, every charset × colour mode, the cell grid, brightness calibration, keyframed
// cell size, the GPU cost of the two passes, and the Effects panel (add, change charset/mode by keyboard).
// Usage: node scripts/e2e-ascii.mjs [baseUrl] [outDir]
import fs from 'node:fs';
import { launch } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.argv[3] ?? '.';
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => (m.type() === 'error' || /leaked render targets/.test(m.text())) && errors.push(m.text()));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const selected = () => page.evaluate(() => { const s = window.__glyphix.state(); return s.doc.comp.layers.find((l) => l.id === s.selectedId); });
const ready = () => page.waitForFunction(() => window.__glyphix && window.__glyphix.saveState() === 'saved');
const savePng = (name, dataUrl) => fs.writeFileSync(`${out}/${name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));

await page.goto(base);
await ready();
await page.keyboard.press('Space'); // pause
await page.evaluate(() => window.__glyphix.setTime(2.5));

// --- Renderers: two WebGPU backends (preview/export paths) and one forced WebGL2 at 960×540, plus a
// 1920×1080 WebGPU backend for the full-size checks and the saved renders.
const backends = await page.evaluate(async () => {
  const { createBackend, renderFrameBitmap } = window.__glyphix.render;
  const mk = async (forceWebGL, w = 960, h = 540) => {
    const b = await createBackend({ canvas: document.createElement('canvas'), fullResAssets: true, forceWebGL });
    b.setSize(w, h, 1);
    return b;
  };
  const A = await mk(false);
  const B = await mk(false);
  const G = await mk(true);
  const H = await mk(false, 1920, 1080);
  const grab = async (b, doc, t) => {
    await renderFrameBitmap(b, doc, t);
    const bmp = await renderFrameBitmap(b, doc, t);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return { c, data: g.getImageData(0, 0, bmp.width, bmp.height).data };
  };
  const pixels = async (b, doc, t) => (await grab(b, doc, t)).data;
  const diff = (a, b) => {
    let max = 0;
    let sum = 0;
    let changed = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > max) max = d;
      sum += d;
      if (d > 8) changed++;
    }
    return { max, mean: sum / a.length, changedPct: (100 * changed) / a.length };
  };
  const toDataUrl = async (c) => {
    const blob = await c.convertToBlob({ type: 'image/png' });
    return await new Promise((r) => {
      const fr = new FileReader();
      fr.onload = () => r(fr.result);
      fr.readAsDataURL(blob);
    });
  };
  await window.__glyphix.fonts.loadAll(window.__glyphix.state().doc.comp.layers.flatMap((l) => (l.type === 'text' ? [l.fontId] : [])));
  window.__ascii = {
    A,
    B,
    G,
    H,
    grab,
    pixels,
    diff,
    toDataUrl,
    async compare(doc, ref, t) {
      const a = await pixels(A, doc, t);
      const b = await pixels(B, doc, t);
      const g = await pixels(G, doc, t);
      const r = ref ? await pixels(A, ref, t) : null;
      return { same: diff(a, b), gl: diff(a, g), vsRef: r ? diff(a, r) : null };
    },
    /** Full-size render: pixels (as a plain array for stats) and a PNG data URL. */
    async full(doc, t, png = true) {
      const { c, data } = await grab(H, doc, t);
      return { data, png: png ? await toDataUrl(c) : null };
    },
    /** Demo doc with an ASCII effect (params / colours overridden) on a layer id or on a new adjustment layer. */
    async doc(where, params = {}, colors = {}, base = window.__glyphix.state().doc) {
      const d = await import('/src/doc/index.ts');
      const doc = structuredClone(base);
      const e = d.createEffect('ascii');
      for (const [k, v] of Object.entries(params)) e.params[k] = typeof v === 'number' ? { static: v } : v;
      for (const [k, v] of Object.entries(colors)) e.colors[k] = { static: v };
      if (where === 'adjust') {
        const layer = d.createAdjustmentLayer('ascii');
        layer.effects = [e];
        doc.comp.layers.push(layer);
      } else doc.comp.layers.find((l) => l.id === where).effects.push(e);
      return doc;
    },
  };
  return [A.kind, B.kind, G.kind, H.kind];
});
check('test renderers', backends[2] === 'webgl2' && backends[0] === backends[1], backends.join(', '));

// --- On the screenshot layer and on an adjustment layer.
for (const where of ['shot', 'adjust']) {
  const r = await page.evaluate(async (where) => {
    const ref = structuredClone(window.__glyphix.state().doc);
    return window.__ascii.compare(await window.__ascii.doc(where), ref, 2.5);
  }, where);
  check(
    `ASCII on ${where === 'shot' ? 'the screenshot layer' : 'an adjustment layer'}: changes the image, preview = export, WebGPU ≈ WebGL2`,
    r.vsRef.changedPct > 3 && r.same.max <= 2 && r.gl.mean < 1,
    `changed ${r.vsRef.changedPct.toFixed(1)}%, preview=export max Δ ${r.same.max}, WebGPU↔WebGL2 mean Δ ${r.gl.mean.toFixed(3)} (max ${r.gl.max})`,
  );
}

// --- Transparent areas stay transparent: ASCII on the screenshot with the background hidden.
const alpha = await page.evaluate(async () => {
  const doc = await window.__ascii.doc('shot');
  doc.comp.layers.find((l) => l.id === 'bg').visible = false;
  doc.comp.layers = doc.comp.layers.filter((l) => l.id === 'bg' || l.id === 'shot');
  const { data } = await window.__ascii.full(doc, 2.5, false);
  const a = (x, y) => data[(y * 1920 + x) * 4 + 3];
  return { corner: a(4, 4), centre: a(960, 600) };
});
check('cells outside the layer stay transparent; inside get the background', alpha.corner === 0 && alpha.centre === 255, JSON.stringify(alpha));

// --- Every charset × colour mode: non-blank, distinct, WebGPU ≈ WebGL2. Saved for a look.
const variants = await page.evaluate(async () => {
  const fx = await import('/src/doc/effects.ts');
  const out = [];
  const lum = [];
  for (let cs = 0; cs < fx.ASCII_CHARSETS.length; cs++)
    for (let mode = 0; mode < fx.ASCII_COLOR_MODES.length; mode++) {
      const doc = await window.__ascii.doc('adjust', { charset: cs, colorMode: mode });
      // "Custom" defaults to the standard characters: give it its own.
      if (cs === fx.ASCII_CUSTOM_CHARSET) doc.comp.layers.at(-1).effects[0].text.charset = ' ox#';
      const { data, png } = await window.__ascii.full(doc, 2.5);
      let sum = 0;
      let sum2 = 0;
      for (let i = 0; i < data.length; i += 4) {
        const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
        sum += l;
        sum2 += l * l;
      }
      const n = data.length / 4;
      const mean = sum / n;
      const gl = window.__ascii.diff(await window.__ascii.pixels(window.__ascii.A, doc, 2.5), await window.__ascii.pixels(window.__ascii.G, doc, 2.5));
      out.push({ name: `${fx.ASCII_CHARSETS[cs]} / ${fx.ASCII_COLOR_MODES[mode]}`, file: `ascii-${cs}-${mode}`, mean, sd: Math.sqrt(sum2 / n - mean * mean), gl: gl.mean, png });
      lum.push(data);
    }
  // Smallest pairwise difference between any two variants.
  let minPair = Infinity;
  for (let i = 0; i < lum.length; i++) for (let j = i + 1; j < lum.length; j++) minPair = Math.min(minPair, window.__ascii.diff(lum[i], lum[j]).mean);
  return { out, minPair };
});
for (const v of variants.out) {
  savePng(v.file, v.png);
  console.log(`  ${v.name.padEnd(28)} mean ${v.mean.toFixed(1)}  sd ${v.sd.toFixed(1)}  WebGPU↔WebGL2 mean Δ ${v.gl.toFixed(3)}`);
}
check('every charset × colour mode renders (non-blank)', variants.out.every((v) => v.sd > 10), `${variants.out.length} variants`);
check('every charset × colour mode differs from the others', variants.minPair > 1, `min pairwise mean Δ ${variants.minPair.toFixed(2)}`);
check('every variant: WebGPU ≈ WebGL2', variants.out.every((v) => v.gl < 1), `max mean Δ ${Math.max(...variants.out.map((v) => v.gl)).toFixed(3)}`);

// --- Edges.
const edges = await page.evaluate(async () => {
  const doc = await window.__ascii.doc('adjust', { edges: 1 });
  const ref = await window.__ascii.doc('adjust');
  const r = await window.__ascii.compare(doc, ref, 2.5);
  const { png } = await window.__ascii.full(doc, 2.5);
  return { ...r, png };
});
savePng('ascii-edges', edges.png);
check('edges: changes the glyphs, preview = export, WebGPU ≈ WebGL2', edges.vsRef.changedPct > 0.5 && edges.same.max <= 2 && edges.gl.mean < 1, `changed ${edges.vsRef.changedPct.toFixed(1)}%, WebGL2 mean Δ ${edges.gl.mean.toFixed(3)}`);

// --- Flat grey backgrounds (nothing else): the cell grid, and brightness calibration.
await page.evaluate(() => {
  window.__ascii.flat = (v) => {
    const doc = structuredClone(window.__glyphix.state().doc);
    const bg = doc.comp.layers.find((l) => l.id === 'bg');
    bg.fill = { kind: 'solid', color: { static: [v, v, v, 1] } };
    doc.comp.layers = [bg];
    return doc;
  };
  /** Mean of each column's luminance, folded by `period` (or unfolded when period = 0). */
  window.__ascii.columns = (data, w, h) => {
    const cols = new Float64Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cols[x] += data[(y * w + x) * 4 + 1];
    return cols;
  };
});
const grid = await page.evaluate(async () => {
  const out = [];
  // Square cells (schema ≤ 5 projects): `size` wide. Font-shaped cells: JetBrains Mono at line height 1.2 is
  // 0.6 / 1.2 = half as wide as tall.
  for (const [size, square] of [[12, 1], [16, 1], [20, 1], [12, 0], [16, 0], [20, 0]]) {
    const doc = await window.__ascii.doc('adjust', { size, square, colorMode: 0, gamma: 1 }, { ink: [1, 1, 1, 1], bg: [0, 0, 0, 1] }, window.__ascii.flat(0.55));
    const { data, png } = await window.__ascii.full(doc, 0, size === 20 && square === 1);
    const cell = square ? size : size / 2;
    const cols = window.__ascii.columns(data, 1920, 1080);
    const mean = cols.reduce((a, b) => a + b, 0) / cols.length;
    // Relative mean difference between column profiles p px apart: ~0 at the cell size only.
    const err = (p) => {
      let s = 0;
      for (let x = 0; x + p < 1920; x++) s += Math.abs(cols[x] - cols[x + p]);
      return s / (1920 - p) / mean;
    };
    // Within a cell, the emptiest column is at the cell border (the glyph sits inside its cell).
    const folded = new Float64Array(cell);
    cols.forEach((v, x) => (folded[x % cell] += v));
    const emptiest = folded.indexOf(Math.min(...folded));
    out.push({ size: cell, square, at: err(cell), off: Math.min(err(cell - 1), err(cell + 1), err(Math.round(cell / 2))), emptiest, png });
  }
  return out;
});
for (const g of grid) if (g.png) savePng('ascii-grid', g.png);
check(
  'cell grid: glyphs repeat every cell width (square 12/16/20 px; font-shaped 6/8/10 px), aligned to the comp origin',
  grid.every((g) => g.at < 0.01 && g.off > 0.1 && (g.emptiest === 0 || g.emptiest === g.size - 1)),
  grid.map((g) => `${g.square ? 'square ' : ''}${g.size}px: err ${g.at.toFixed(4)} vs ${g.off.toFixed(2)} off-period, emptiest column ${g.emptiest}`).join('; '),
);

const calib = await page.evaluate(async () => {
  const out = [];
  for (const cs of [0, 2])
    for (let i = 0; i <= 10; i++) {
      const v = i / 10;
      const doc = await window.__ascii.doc('adjust', { charset: cs, colorMode: 0, gamma: 1 }, { ink: [1, 1, 1, 1], bg: [0, 0, 0, 1] }, window.__ascii.flat(v));
      const { data } = await window.__ascii.full(doc, 0, false);
      // Ink coverage = mean linear light (ink white on black).
      let s = 0;
      for (let p = 1; p < data.length; p += 4) {
        const c = data[p] / 255;
        s += c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }
      out.push({ cs, v, cov: s / (data.length / 4) });
    }
  return out;
});
for (const cs of [0, 2]) {
  const c = calib.filter((r) => r.cs === cs);
  const monotonic = c.every((r, i) => i === 0 || r.cov >= c[i - 1].cov - 1e-4) && c[0].cov < 0.005 && c.at(-1).cov > 0.15;
  // Calibrated: coverage tracks brightness linearly (here γ = 1 → perceptual grey level).
  const max = c.at(-1).cov;
  const dev = Math.max(...c.map((r) => Math.abs(r.cov / max - r.v)));
  check(`calibration (${cs ? 'detailed' : 'standard'}): grey patches → monotonic, near-linear ink coverage`, monotonic && dev < (cs ? 0.08 : 0.2), `${c.map((r) => r.cov.toFixed(3)).join(' ')}; max deviation from linear ${dev.toFixed(3)}`);
}

// --- Keyframed cell size animates (8 → 40 px over 2 s); t = 1 matches a static 24 px.
const keyed = await page.evaluate(async () => {
  const track = { track: { keys: [{ t: 0, v: 8, out: { kind: 'linear' } }, { t: 2, v: 40, out: { kind: 'linear' } }] } };
  const base = structuredClone(window.__glyphix.state().doc);
  base.comp.layers.forEach((l) => l.type === 'text' && ((l.motion = { enter: null, exit: null, loop: null }), (l.animator = null)));
  const doc = await window.__ascii.doc('adjust', { size: track }, {}, base);
  const still = await window.__ascii.doc('adjust', { size: 24 }, {}, base);
  const P = window.__ascii.pixels;
  const A = window.__ascii.A;
  const f = [await P(A, doc, 0), await P(A, doc, 1), await P(A, doc, 2)];
  const d = window.__ascii.diff;
  return { d01: d(f[0], f[1]).mean, d12: d(f[1], f[2]).mean, vsStill: d(f[1], await P(A, still, 1)).max };
});
check('keyframed cell size animates', keyed.d01 > 1 && keyed.d12 > 1 && keyed.vsStill <= 2, `mean Δ 0→1 s ${keyed.d01.toFixed(1)}, 1→2 s ${keyed.d12.toFixed(1)}; t=1 vs static 24 px max Δ ${keyed.vsStill}`);

// --- GPU cost of the two passes at 1080p, 160×90 cells: time N renders (after warm-up, synced) of an
// adjustment layer with 1 and with 3 ASCII effects; (3 − 1) / 2 is the cost of one ASCII effect alone.
// A one-pass effect (colour adjust) is measured the same way for scale.
const cost = await page.evaluate(async () => {
  const d = await import('/src/doc/index.ts');
  const { createBackend } = window.__glyphix.render;
  const base = structuredClone(window.__glyphix.state().doc);
  const withAdj = (kind, n) => {
    const doc = structuredClone(base);
    const layer = d.createAdjustmentLayer(kind);
    layer.effects = Array.from({ length: n }, () => {
      const e = d.createEffect(kind);
      if (kind === 'colorAdjust') e.params.brightness = { static: 0.01 };
      return e;
    });
    doc.comp.layers.push(layer);
    return doc;
  };
  const docs = { none: base, onePass1: withAdj('colorAdjust', 1), onePass3: withAdj('colorAdjust', 3), ascii1: withAdj('ascii', 1), ascii3: withAdj('ascii', 3) };
  const sync = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const out = {};
  for (const forceWebGL of [false, true]) {
    const b = await createBackend({ canvas: document.createElement('canvas'), fullResAssets: true, forceWebGL });
    b.setSize(1920, 1080, 1);
    const lists = Object.fromEntries(Object.entries(docs).map(([k, doc]) => [k, d.evaluate(doc, 2.5)]));
    const run = async (list, n) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) b.render(list);
      await b.idle();
      sync.drawImage(b.canvas, 0, 0, 1, 1); // forces WebGL2 to finish too
      sync.getImageData(0, 0, 1, 1);
      return (performance.now() - t0) / n;
    };
    const times = Object.fromEntries(Object.keys(lists).map((k) => [k, []]));
    for (const list of Object.values(lists)) await run(list, 20); // warm-up: shaders, uploads
    // Interleaved rounds, so load from other processes hits every variant alike.
    for (let round = 0; round < 9; round++) for (const [k, list] of Object.entries(lists)) times[k].push(await run(list, 30));
    const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
    // Per-round differences, then their median: robust to a slow round.
    const per = (a, b) => med(times[a].map((v, i) => (v - times[b][i]) / 2));
    out[b.kind] = {
      frame: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, med(v)])),
      ascii: per('ascii3', 'ascii1'),
      onePass: per('onePass3', 'onePass1'),
      best: Math.min(...times.ascii3.map((v, i) => (v - times.ascii1[i]) / 2)),
    };
    await b.idle();
    b.dispose();
  }
  return out;
});
for (const [kind, t] of Object.entries(cost)) {
  console.log(`  ${kind}: frame ms (median) — ${Object.entries(t.frame).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}`);
  check(
    `ASCII 160×90 at 1080p (${kind}): one ASCII effect (both passes) costs < 2 ms`,
    t.ascii < 2,
    `${t.ascii.toFixed(2)} ms median (best round ${t.best.toFixed(2)}); a one-pass colour adjust costs ${t.onePass.toFixed(2)} ms`,
  );
}

// --- UI: add ASCII from the menu, change charset / colour mode by keyboard.
await page.evaluate(() => window.__glyphix.select('shot'));
await page.getByRole('button', { name: 'Add effect' }).click();
await page.getByRole('menuitem', { name: /^ASCII/ }).click();
await page.waitForTimeout(300);
let layer = await selected();
check('Add effect menu adds ASCII', layer.effects.at(-1)?.kind === 'ascii', layer.effects.map((e) => e.kind).join());
const pick = async (name) => {
  const box = page.getByRole('combobox', { name });
  await box.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  return (await selected()).effects.at(-1).params;
};
let params = await pick('ASCII characters');
check('charset select works by keyboard', params.charset.static === 1, JSON.stringify(params.charset));
params = await pick('ASCII colour mode');
check('colour mode select works by keyboard', params.colorMode.static === 2, JSON.stringify(params.colorMode));
await page.screenshot({ path: `${out}/e2e-ascii.png` });

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
